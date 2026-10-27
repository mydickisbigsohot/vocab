#!/usr/bin/env python3
"""Watch a local screenshot folder and batch-upload only to a verified private repo.

Settings belong in ignored .local/config.json, never public source. New images
become private screenshot flashcards without changing the public Pages data.
"""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

from update_words import atomic_json, compress_image, digest, EXTENSIONS

ROOT = Path(__file__).resolve().parents[1]
IDENTITY = {'name': 'Vocabulary Builder', 'email': 'builder@users.noreply.github.com'}
REPO_PATTERN = re.compile(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9_.-]{1,100}\Z')


class WatcherError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class RefConflict(WatcherError):
    pass


def now_text():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def load_json(path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding='utf-8-sig'))
    except (OSError, ValueError):
        raise WatcherError('invalid_local_configuration') from None


def load_config(root=ROOT, require_upload=True):
    config = load_json(root / '.local' / 'config.json', {})
    if not isinstance(config, dict):
        raise WatcherError('invalid_local_configuration')
    directory = config.get('screenshotFolder') or os.environ.get('VOCAB_SCREENSHOT_DIR')
    if not isinstance(directory, str) or not directory.strip():
        raise WatcherError('screenshot_folder_not_configured')
    folder = Path(directory).expanduser()
    if not folder.is_absolute():
        folder = root / folder
    if not folder.is_dir():
        raise WatcherError('screenshot_folder_unavailable')
    repo = config.get('privateRepo', '')
    if require_upload:
        if config.get('allowPrivateSync') is not True:
            raise WatcherError('private_sync_disabled')
        if not isinstance(repo, str) or not REPO_PATTERN.fullmatch(repo):
            raise WatcherError('private_repository_not_configured')
    try:
        interval = max(2.0, min(300.0, float(config.get('watchIntervalSeconds', 5))))
    except (ValueError, TypeError):
        raise WatcherError('invalid_watch_interval') from None
    batch_size = config.get('watchBatchSize', 12)
    if not isinstance(batch_size, int) or isinstance(batch_size, bool) or batch_size < 1 or batch_size > 30:
        raise WatcherError('invalid_batch_size')
    return {'folder': folder.resolve(), 'repo': repo, 'interval': interval, 'batchSize': batch_size}


def load_state(root, repo):
    state = load_json(root / '.local' / 'watcher-state.json', {})
    if not isinstance(state, dict):
        raise WatcherError('invalid_watcher_state')
    if state.get('repository') != repo:
        return {'version': 1, 'repository': repo, 'uploaded': {}}
    uploaded = state.get('uploaded')
    if state.get('version') != 1 or not isinstance(uploaded, dict) or any(
            not isinstance(key, str) or not re.fullmatch('[a-f0-9]{64}', key)
            for key in uploaded):
        raise WatcherError('invalid_watcher_state')
    return state


def write_status(root, status, uploaded=0, pending=0, error=None):
    value = {'status': status, 'updatedAt': now_text(), 'uploadedCount': uploaded,
             'pendingCount': pending}
    if error:
        value['error'] = error
    atomic_json(root / '.local' / 'watcher-status.json', value)


def snapshots(folder):
    result = {}
    for source in folder.rglob('*'):
        try:
            if source.is_symlink() or source.suffix.lower() not in EXTENSIONS or not source.is_file():
                continue
            if not source.resolve().is_relative_to(folder.resolve()):
                continue
            stat = source.stat()
            if stat.st_size:
                result[source] = (stat.st_size, stat.st_mtime_ns)
        except OSError:
            continue
    return result


class StableFiles:
    """Two equal snapshots prevent reading screenshots still being copied."""
    def __init__(self):
        self.previous = {}
        self.hashes = {}

    def ready(self, folder):
        current = snapshots(folder)
        stable = [(path, fingerprint) for path, fingerprint in current.items()
                  if self.previous.get(path) == fingerprint]
        self.previous = current
        self.hashes = {key: value for key, value in self.hashes.items()
                       if current.get(key[0]) == key[1]}
        return stable

    def original_hash(self, path, fingerprint):
        key = (path, fingerprint)
        if key not in self.hashes:
            self.hashes[key] = digest(path)
        return self.hashes[key]


def saved_token(owner):
    environment = dict(os.environ, GCM_INTERACTIVE='Never', GIT_TERMINAL_PROMPT='0')
    try:
        result = subprocess.run(['git', 'credential', 'fill'],
            input=f'protocol=https\nhost=github.com\nusername={owner}\n\n',
            text=True, capture_output=True, env=environment, timeout=25,
            cwd=tempfile.gettempdir())
    except (OSError, subprocess.SubprocessError):
        raise WatcherError('github_authentication_required') from None
    fields = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    if result.returncode or not fields.get('password'):
        raise WatcherError('github_authentication_required')
    return fields['password']


class GitHub:
    def __init__(self, token):
        self.token = token

    def call(self, path, method='GET', body=None, missing=False):
        request = urllib.request.Request('https://api.github.com' + path, method=method,
            data=json.dumps(body).encode('utf-8') if body is not None else None,
            headers={'Authorization': 'Bearer ' + self.token,
                     'Accept': 'application/vnd.github+json',
                     'Content-Type': 'application/json', 'User-Agent': 'VocabularyPrivateSync/1.0',
                     'X-GitHub-Api-Version': '2022-11-28'})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(request, timeout=20) as response:
                    content = response.read()
                    return json.loads(content) if content else {}
            except urllib.error.HTTPError as exc:
                if missing and exc.code == 404:
                    return None
                if exc.code in (409, 422):
                    raise RefConflict('repository_changed') from None
                if exc.code in (401, 403):
                    raise WatcherError('github_permission_required') from None
                if exc.code not in (429, 500, 502, 503, 504) or attempt == 2:
                    raise WatcherError('github_request_failed') from None
            except (urllib.error.URLError, ssl.SSLError, socket.timeout, TimeoutError, ConnectionError):
                if attempt == 2:
                    # The installed native HTTP client may use a different TLS
                    # implementation. Keep the credential and body on stdin,
                    # never argv, disk, or diagnostics. No system settings change.
                    return self._native_call(path, method, body, missing)
            except (ValueError, UnicodeError):
                raise WatcherError('invalid_github_response') from None
            time.sleep(0.5 * (attempt + 1))

    def _native_call(self, path, method, body, missing):
        executable = shutil.which('curl.exe') or shutil.which('curl')
        if not executable:
            raise WatcherError('network_unavailable')
        if (not isinstance(path, str) or not path.startswith('/') or
                any(character in path for character in ('\r', '\n', '#'))):
            raise WatcherError('invalid_github_request')
        # json.dumps provides the quoting required by curl's stdin config format.
        # Do not enable redirects: the bearer must stay on api.github.com.
        quoted = lambda value: json.dumps(value, ensure_ascii=False)
        lines = [
            'url = ' + quoted('https://api.github.com' + path),
            'request = ' + quoted(method),
            'silent', 'show-error', 'connect-timeout = 10', 'max-time = 20',
            'proto = "=https"',
            'header = ' + quoted('Authorization: Bearer ' + self.token),
            'header = "Accept: application/vnd.github+json"',
            'header = "Content-Type: application/json"',
            'header = "User-Agent: VocabularyPrivateSync/1.0"',
            'header = "X-GitHub-Api-Version: 2022-11-28"',
            'write-out = "\\n%{http_code}"',
        ]
        proxy = urllib.request.getproxies().get('https', '')
        try:
            parsed = urllib.parse.urlparse(proxy)
            if (parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost', '::1')
                    and not parsed.username and not parsed.password):
                # Accessing port validates malformed port strings before invoking curl.
                parsed.port
                lines.append('proxy = ' + quoted(proxy))
        except (ValueError, TypeError):
            pass
        if body is not None:
            lines.append('data-binary = ' + quoted(json.dumps(body, ensure_ascii=False)))
        try:
            result = subprocess.run([executable, '-q', '--config', '-'],
                input='\n'.join(lines) + '\n', text=True, encoding='utf-8', errors='replace',
                capture_output=True, timeout=25)
        except (OSError, subprocess.SubprocessError):
            raise WatcherError('network_unavailable') from None
        # stderr may contain network details. It is intentionally never relayed.
        if result.returncode:
            raise WatcherError('network_unavailable')
        content, separator, code = result.stdout.rpartition('\n')
        if not separator or not re.fullmatch(r'\d{3}', code.strip()):
            raise WatcherError('invalid_github_response')
        code = int(code.strip())
        if code == 404 and missing:
            return None
        if code in (409, 422):
            raise RefConflict('repository_changed')
        if code in (401, 403):
            raise WatcherError('github_permission_required')
        if code == 0:
            raise WatcherError('network_unavailable')
        if not 200 <= code < 300:
            raise WatcherError('github_request_failed')
        try:
            return json.loads(content) if content.strip() else {}
        except (ValueError, UnicodeError):
            raise WatcherError('invalid_github_response') from None


def require_private(client, repo):
    metadata = client.call('/repos/' + repo)
    if not isinstance(metadata, dict) or metadata.get('private') is not True:
        raise WatcherError('public_repository_blocked')
    if metadata.get('archived') or metadata.get('disabled'):
        raise WatcherError('repository_unavailable')
    if metadata.get('permissions', {}).get('push') is False:
        raise WatcherError('github_permission_required')


def upload_batch(client, repo, pictures):
    """Publish image cards and their index atomically, preserving the latest remote tree."""
    if not pictures:
        return []
    require_private(client, repo)
    prefix = '/repos/' + repo
    added_at = now_text()
    blobs = {}
    for sha, content in pictures.items():
        if not re.fullmatch('[a-f0-9]{64}', sha) or not isinstance(content, bytes):
            raise WatcherError('invalid_upload')
        if len(content) > 5 * 1024 * 1024:
            raise WatcherError('compressed_image_too_large')
        created = client.call(prefix + '/git/blobs', 'POST',
            {'encoding': 'base64', 'content': base64.b64encode(content).decode('ascii')})
        blobs[sha] = created['sha']
    for _ in range(4):
        ref = client.call(prefix + '/git/ref/heads/main')
        head = ref['object']['sha']
        previous = client.call(prefix + '/git/commits/' + head)
        tree_sha = previous['tree']['sha']
        tree = client.call(prefix + '/git/trees/' + tree_sha + '?recursive=1')
        if tree.get('truncated'):
            raise WatcherError('repository_tree_too_large')
        entries = {item['path']: item for item in tree.get('tree', [])}
        existing = set(entries)
        words = []
        if 'data/words.json' in entries:
            index_blob = client.call(prefix + '/git/blobs/' + entries['data/words.json']['sha'])
            try:
                words = json.loads(base64.b64decode(index_blob['content']).decode('utf-8-sig'))
            except (ValueError, TypeError, KeyError, UnicodeError):
                raise WatcherError('invalid_private_word_index') from None
            if not isinstance(words, list) or any(not isinstance(word, dict) for word in words):
                raise WatcherError('invalid_private_word_index')
        indexed = {word.get('sourceHash') for word in words if isinstance(word.get('sourceHash'), str)}
        new = {sha: blob for sha, blob in blobs.items()
               if sha not in indexed or f'images/{sha}.webp' not in existing}
        if not new:
            return list(pictures)
        additions = [{'path': f'images/{sha}.webp', 'mode': '100644', 'type': 'blob', 'sha': blob}
                     for sha, blob in sorted(new.items()) if f'images/{sha}.webp' not in existing]
        for sha in sorted(new):
            if sha not in indexed:
                words.append({'word': '截图 ' + sha, 'phonetic': '', 'meaning': '', 'example': '',
                              'image': f'images/{sha}.webp', 'addedAt': added_at,
                              'cardType': 'image', 'sourceHash': sha})
                indexed.add(sha)
        index_blob = client.call(prefix + '/git/blobs', 'POST', {'encoding': 'utf-8',
            'content': json.dumps(words, ensure_ascii=False, indent=2) + '\n'})
        additions.append({'path': 'data/words.json', 'mode': '100644', 'type': 'blob', 'sha': index_blob['sha']})
        created = client.call(prefix + '/git/trees', 'POST', {'base_tree': tree_sha, 'tree': additions})
        date = now_text()
        identity = {**IDENTITY, 'date': date}
        commit = client.call(prefix + '/git/commits', 'POST', {
            'message': f'Synchronize {len(new)} private image cards', 'tree': created['sha'],
            'parents': [head], 'author': identity, 'committer': identity})
        require_private(client, repo)
        try:
            client.call(prefix + '/git/refs/heads/main', 'PATCH',
                        {'sha': commit['sha'], 'force': False})
            return list(pictures)
        except RefConflict:
            # Rebase only additions onto the newest tree; never overwrite browser progress.
            continue
        except WatcherError:
            # The update may have succeeded even if its response was lost.
            latest = client.call(prefix + '/git/ref/heads/main')
            if latest.get('object', {}).get('sha') == commit['sha']:
                return list(pictures)
            raise
    raise WatcherError('repository_busy_retry_later')


def collect_ready(config, state, tracker, limit=12):
    from PIL import Image
    pictures = {}
    for path, fingerprint in tracker.ready(config['folder']):
        try:
            sha = tracker.original_hash(path, fingerprint)
            if sha in state['uploaded'] or sha in pictures:
                continue
            image = compress_image(path)
            stat = path.stat()
            if (stat.st_size, stat.st_mtime_ns) != fingerprint:
                continue
            pictures[sha] = image
            if len(pictures) >= limit:
                break
        except (OSError, ValueError, RuntimeError, Image.DecompressionBombError):
            # A later scan retries unfinished/invalid screenshots without exposing filenames.
            continue
    return pictures


def cycle(root, config, state, tracker, client_factory=None):
    pictures = collect_ready(config, state, tracker, config.get('batchSize', 12))
    if not pictures:
        write_status(root, 'watching', len(state['uploaded']))
        return 0
    write_status(root, 'uploading', len(state['uploaded']), len(pictures))
    client = client_factory() if client_factory else GitHub(saved_token(config['repo'].split('/')[0]))
    uploaded = upload_batch(client, config['repo'], pictures)
    for sha in uploaded:
        state['uploaded'][sha] = {'uploadedAt': now_text()}
    atomic_json(root / '.local' / 'watcher-state.json', state)
    write_status(root, 'watching', len(state['uploaded']))
    return len(uploaded)


@contextmanager
def single_instance(root):
    local = root / '.local'
    local.mkdir(parents=True, exist_ok=True)
    handle = (local / 'watcher.lock').open('a+b')
    handle.seek(0)
    if handle.read(1) == b'':
        handle.write(b'0')
        handle.flush()
    handle.seek(0)
    try:
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        raise WatcherError('watcher_already_running') from None
    try:
        yield
    finally:
        handle.seek(0)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


def dry_run(root):
    config = load_config(root, require_upload=False)
    state = load_state(root, config['repo'])
    hashes = {digest(path) for path in snapshots(config['folder'])}
    print(json.dumps({'images': len(hashes), 'notUploaded': len(hashes - set(state['uploaded'])),
                      'networkUsed': False, 'filesWritten': False}))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--watch', action='store_true', help='持续检查稳定的新截图并批量上传私有仓库')
    modes.add_argument('--once', action='store_true', help='检查两次稳定文件后上传一批，然后退出')
    modes.add_argument('--dry-run', action='store_true', help='仅统计新增图片，不读取凭据、不联网、不写文件')
    modes.add_argument('--status', action='store_true', help='查看本机通用状态，不显示截图路径')
    parser.add_argument('--max-batch', type=int, help='每批最多上传 1–30 张图片，优先于本机配置')
    args = parser.parse_args(argv)
    if args.max_batch is not None and not 1 <= args.max_batch <= 30:
        parser.error('--max-batch 必须为 1 到 30 的整数。')
    try:
        if args.status:
            print(json.dumps(load_json(ROOT / '.local' / 'watcher-status.json', {'status': 'not_started'})))
            return 0
        if args.dry_run:
            return dry_run(ROOT)
        if not args.watch and not args.once:
            parser.print_help()
            return 0
        with single_instance(ROOT):
            config = load_config(ROOT)
            state = load_state(ROOT, config['repo'])
            tracker = StableFiles()
            tracker.ready(config['folder'])
            time.sleep(config['interval'])
            while True:
                try:
                    # Reload opt-in every iteration; disabling local sync stops further uploads.
                    updated = load_config(ROOT)
                    if updated['repo'] != config['repo'] or updated['folder'] != config['folder']:
                        state = load_state(ROOT, updated['repo'])
                        tracker = StableFiles()
                    config = updated
                    if args.max_batch is not None:
                        config['batchSize'] = args.max_batch
                    cycle(ROOT, config, state, tracker)
                except WatcherError as exc:
                    write_status(ROOT, 'needs_attention', len(state['uploaded']), error=exc.code)
                    if args.once or exc.code in ('private_sync_disabled', 'public_repository_blocked'):
                        print(exc.code, file=sys.stderr)
                        return 1
                if args.once:
                    return 0
                time.sleep(config['interval'])
    except KeyboardInterrupt:
        return 0
    except WatcherError as exc:
        print(exc.code, file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
