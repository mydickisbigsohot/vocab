import contextlib
import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from PIL import Image

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location('watcher_under_test', SCRIPTS / 'watch_folder.py')
watcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watcher)


class NativeTransportTests(unittest.TestCase):
    def invoke(self, status=200, body=None, response='{"private":true}', returncode=0):
        result=SimpleNamespace(returncode=returncode,stdout=response+'\n'+str(status),stderr='private-diagnostic-must-not-escape')
        with patch.object(watcher.urllib.request,'urlopen',side_effect=watcher.urllib.error.URLError('transport')), \
             patch.object(watcher.urllib.request,'getproxies',return_value={'https':'http://127.0.0.1:1234'}), \
             patch.object(watcher.shutil,'which',return_value='curl.exe'), \
             patch.object(watcher.time,'sleep'), \
             patch.object(watcher.subprocess,'run',return_value=result) as native:
            value=watcher.GitHub('test-secret-not-real').call('/repos/example/private','POST' if body else 'GET',body,missing=True)
            return value,native.call_args

    def test_fallback_keeps_credentials_off_arguments_and_disables_redirects(self):
        value,call=self.invoke()
        self.assertTrue(value['private'])
        self.assertNotIn('test-secret-not-real',' '.join(call.args[0]))
        config=call.kwargs['input']
        self.assertIn('test-secret-not-real',config)
        self.assertIn('https://api.github.com/repos/example/private',config)
        self.assertIn('proto = "=https"',config)
        self.assertNotIn('insecure',config)
        self.assertNotIn('location',config)

    def test_post_body_preserved_in_stdin_without_creating_a_file(self):
        payload={'content':'base64-value','message':'同步截图'}
        _,call=self.invoke(body=payload)
        line=next(line for line in call.kwargs['input'].splitlines() if line.startswith('data-binary = '))
        self.assertEqual(json.loads(json.loads(line.split(' = ',1)[1])),payload)

    def test_missing_private_file_remains_missing(self):
        value,_=self.invoke(status=404,response='{}')
        self.assertIsNone(value)

    def test_ref_conflict_is_not_misreported_as_success(self):
        with self.assertRaises(watcher.RefConflict):self.invoke(status=409,response='{}')

    def test_native_error_does_not_relay_diagnostics_or_credentials(self):
        with self.assertRaises(watcher.WatcherError) as caught:self.invoke(returncode=35)
        self.assertEqual(str(caught.exception),'network_unavailable')
        self.assertNotIn('test-secret',str(caught.exception))


class FakeGitHub:
    def __init__(self, private=True, conflict=False, existing=None, fail_patch=False, words=None):
        self.private = private
        self.conflict = conflict
        self.fail_patch = fail_patch
        self.existing = list(existing or [])
        self.calls = []
        self.head = 'head1'
        self.commits = 0
        self.words = list(words or [])
        self.blobs = 0

    def call(self, path, method='GET', body=None, missing=False):
        self.calls.append((path, method, body))
        if path == '/repos/example/private-data':
            return {'private': self.private, 'permissions': {'push': True}}
        if path.endswith('/git/blobs'):
            self.blobs += 1
            return {'sha': f'blob-content-{self.blobs}'}
        if '/git/blobs/word-index-' in path:
            return {'encoding': 'base64', 'content': base64.b64encode(json.dumps(self.words).encode()).decode()}
        if path.endswith('/git/ref/heads/main'):
            return {'object': {'sha': self.head}}
        if '/git/commits/head' in path:
            return {'tree': {'sha': 'tree-' + self.head}}
        if '/git/trees/tree-' in path:
            return {'tree': [{'path': path, 'sha': 'existing-blob'} for path in self.existing]
                    + [{'path': 'data/words.json', 'sha': 'word-index-' + self.head}]}
        if path.endswith('/git/trees') and method == 'POST':
            return {'sha': 'new-tree'}
        if path.endswith('/git/commits') and method == 'POST':
            self.commits += 1
            return {'sha': f'commit{self.commits}'}
        if path.endswith('/git/refs/heads/main'):
            if self.fail_patch:
                raise watcher.WatcherError('network_unavailable')
            if self.conflict:
                self.conflict = False
                self.head = 'head2'
                self.existing.append('data/progress.json')
                self.words.append(card('f' * 64, title='A concurrently added phone card'))
                self.existing.append('images/' + 'f' * 64 + '.webp')
                raise watcher.RefConflict('repository_changed')
            self.head = body['sha']
            return {'object': {'sha': self.head}}
        raise AssertionError(f'Unexpected fake call {method} {path}')


def card(sha, title=None):
    return {'word': title or '截图 ' + sha, 'phonetic': '', 'meaning': '', 'example': '',
            'image': f'images/{sha}.webp', 'addedAt': '2026-01-01T00:00:00Z',
            'cardType': 'image', 'sourceHash': sha}


class WatcherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.folder = self.root / 'screenshots'
        self.folder.mkdir()
        (self.root / '.local').mkdir()
        self.settings = {'screenshotFolder': str(self.folder),
                         'privateRepo': 'example/private-data', 'allowPrivateSync': True}
        self.configure()
        self.state = {'version': 1, 'repository': 'example/private-data', 'uploaded': {}}

    def tearDown(self):
        self.tmp.cleanup()

    def configure(self):
        (self.root / '.local' / 'config.json').write_text(json.dumps(self.settings), encoding='utf-8')

    def image(self, name='private-source-name.png', colour='white'):
        path = self.folder / name
        Image.new('RGB', (1000, 500), colour).save(path)
        return path

    def test_requires_explicit_private_sync_opt_in_before_authentication(self):
        self.settings['allowPrivateSync'] = False
        self.configure()
        with patch.object(watcher, 'ROOT', self.root), patch.object(watcher, 'saved_token') as auth:
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(watcher.main(['--once']), 1)
            auth.assert_not_called()

    def test_folder_configuration_is_private_and_relative_paths_resolve_under_project(self):
        self.settings['screenshotFolder'] = 'screenshots'
        self.configure()
        config = watcher.load_config(self.root)
        self.assertEqual(config['folder'], self.folder.resolve())
        self.assertEqual(config['interval'], 5)

    def test_stability_requires_two_identical_scans_and_restarts_when_file_changes(self):
        source = self.image()
        tracker = watcher.StableFiles()
        self.assertEqual(tracker.ready(self.folder), [])
        self.assertEqual(len(tracker.ready(self.folder)), 1)
        source.write_bytes(source.read_bytes() + b'change')
        self.assertEqual(tracker.ready(self.folder), [])
        self.assertEqual(len(tracker.ready(self.folder)), 1)

    def test_collect_deduplicates_content_and_only_compresses_unuploaded_files(self):
        source = self.image()
        shutil.copy2(source, self.folder / 'renamed.png')
        tracker = watcher.StableFiles()
        config = watcher.load_config(self.root)
        tracker.ready(self.folder)
        pictures = watcher.collect_ready(config, self.state, tracker)
        self.assertEqual(len(pictures), 1)
        for content in pictures.values():
            with Image.open(io.BytesIO(content)) as image:
                self.assertEqual(image.format, 'WEBP')
                self.assertLessEqual(image.width, 800)
                self.assertFalse(image.getexif())
        self.state['uploaded'].update({sha: {} for sha in pictures})
        with patch.object(watcher, 'compress_image') as compress:
            self.assertEqual(watcher.collect_ready(config, self.state, tracker), {})
            compress.assert_not_called()

    def test_image_changed_during_compression_is_not_uploaded_until_stable_again(self):
        source = self.image()
        tracker = watcher.StableFiles()
        config = watcher.load_config(self.root)
        tracker.ready(self.folder)
        original_compress = watcher.compress_image
        def compress_while_copying(path):
            content = original_compress(path)
            source.write_bytes(source.read_bytes() + b'copy-not-finished')
            return content
        with patch.object(watcher, 'compress_image', side_effect=compress_while_copying):
            self.assertEqual(watcher.collect_ready(config, self.state, tracker), {})
        self.assertEqual(watcher.collect_ready(config, self.state, tracker), {})
        self.assertEqual(len(watcher.collect_ready(config, self.state, tracker)), 1)

    def test_oversized_pixel_images_do_not_crash_watcher_or_get_checkpointed(self):
        self.image()
        tracker = watcher.StableFiles()
        config = watcher.load_config(self.root)
        tracker.ready(self.folder)
        with patch.object(watcher, 'compress_image', side_effect=Image.DecompressionBombError('rejected')):
            self.assertEqual(watcher.collect_ready(config, self.state, tracker), {})
        self.assertEqual(self.state['uploaded'], {})

    def test_dry_run_never_authenticates_networks_or_writes(self):
        source = self.image()
        shutil.copy2(source, self.folder / 'copy.png')
        before = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        with patch.object(watcher, 'ROOT', self.root), patch.object(watcher, 'saved_token') as auth, \
                patch.object(watcher.GitHub, 'call') as api, contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(watcher.main(['--dry-run']), 0)
        auth.assert_not_called()
        api.assert_not_called()
        self.assertEqual(json.loads(output.getvalue())['images'], 1)
        self.assertEqual(before, {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

    def test_public_repository_blocks_every_blob_or_commit_upload(self):
        client = FakeGitHub(private=False)
        with self.assertRaisesRegex(watcher.WatcherError, 'public_repository_blocked'):
            watcher.upload_batch(client, 'example/private-data', {'a' * 64: b'image'})
        self.assertEqual(len(client.calls), 1)

    def test_batch_commit_is_anonymous_and_contains_no_original_filename(self):
        source = self.image()
        tracker = watcher.StableFiles()
        config = watcher.load_config(self.root)
        tracker.ready(self.folder)
        client = FakeGitHub()
        self.assertEqual(watcher.cycle(self.root, config, self.state, tracker, lambda: client), 1)
        calls = json.dumps(client.calls)
        self.assertNotIn(source.name, calls)
        self.assertNotIn(str(self.folder), calls)
        commits = [body for path, method, body in client.calls
                   if path.endswith('/git/commits') and method == 'POST']
        self.assertEqual(len(commits), 1)
        self.assertEqual(commits[0]['author']['name'], 'Vocabulary Builder')
        self.assertEqual(commits[0]['committer']['email'], 'builder@users.noreply.github.com')
        self.assertEqual(len(self.state['uploaded']), 1)
        state = json.loads((self.root / '.local' / 'watcher-state.json').read_text())
        self.assertEqual(set(state['uploaded']), set(self.state['uploaded']))

    def test_ref_race_rebuilds_tree_on_new_head_and_preserves_other_files(self):
        client = FakeGitHub(conflict=True)
        result = watcher.upload_batch(client, 'example/private-data', {'b' * 64: b'picture'})
        self.assertEqual(result, ['b' * 64])
        commits = [body for path, method, body in client.calls
                   if path.endswith('/git/commits') and method == 'POST']
        self.assertEqual(commits[0]['parents'], ['head1'])
        self.assertEqual(commits[1]['parents'], ['head2'])
        trees = [body for path, method, body in client.calls
                 if path.endswith('/git/trees') and method == 'POST']
        self.assertEqual(trees[1]['base_tree'], 'tree-head2')
        self.assertEqual([row['path'] for row in trees[1]['tree']], ['images/' + 'b' * 64 + '.webp', 'data/words.json'])
        indices = [json.loads(body['content']) for path, method, body in client.calls
                   if path.endswith('/git/blobs') and method == 'POST' and body['encoding'] == 'utf-8']
        self.assertEqual({word['sourceHash'] for word in indices[0]}, {'b' * 64})
        self.assertEqual({word['sourceHash'] for word in indices[1]}, {'b' * 64, 'f' * 64})
        patches = [body for path, method, body in client.calls if method == 'PATCH']
        self.assertTrue(all(body['force'] is False for body in patches))

    def test_failed_upload_is_not_checkpointed_and_leaves_original_unchanged(self):
        source = self.image()
        original = source.read_bytes()
        tracker = watcher.StableFiles()
        config = watcher.load_config(self.root)
        tracker.ready(self.folder)
        with self.assertRaises(watcher.WatcherError):
            watcher.cycle(self.root, config, self.state, tracker, lambda: FakeGitHub(fail_patch=True))
        self.assertEqual(self.state['uploaded'], {})
        self.assertFalse((self.root / '.local' / 'watcher-state.json').exists())
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(watcher.cycle(self.root, config, self.state, tracker, FakeGitHub), 1)

    def test_remote_image_and_index_together_prevent_duplicate_new_commit(self):
        client = FakeGitHub(existing=['images/' + 'c' * 64 + '.webp'], words=[card('c' * 64)])
        result = watcher.upload_batch(client, 'example/private-data', {'c' * 64: b'image'})
        self.assertEqual(result, ['c' * 64])
        self.assertEqual(client.commits, 0)

    def test_image_and_index_are_published_in_one_commit_preserving_older_cards(self):
        old = card('d' * 64, 'An existing card with a custom title')
        client = FakeGitHub(existing=[old['image'], 'data/progress.json'], words=[old])
        watcher.upload_batch(client, 'example/private-data', {'a' * 64: b'image'})
        indices = [json.loads(body['content']) for path, method, body in client.calls
                   if path.endswith('/git/blobs') and method == 'POST' and body['encoding'] == 'utf-8']
        self.assertEqual(len(indices), 1)
        self.assertEqual(indices[0][0], old)
        added = indices[0][1]
        self.assertEqual(added['word'], '截图 ' + 'a' * 64)
        self.assertEqual(added['cardType'], 'image')
        self.assertEqual(added['sourceHash'], 'a' * 64)
        self.assertTrue(all(added[field] == '' for field in ['meaning', 'phonetic', 'example']))
        tree = [body for path, method, body in client.calls if path.endswith('/git/trees') and method == 'POST'][0]
        self.assertEqual({row['path'] for row in tree['tree']}, {'images/' + 'a' * 64 + '.webp', 'data/words.json'})
        self.assertEqual(client.commits, 1)

    def test_index_missing_image_is_repaired_without_duplicate_card(self):
        old = card('e' * 64)
        client = FakeGitHub(words=[old])
        watcher.upload_batch(client, 'example/private-data', {'e' * 64: b'image'})
        indices = [json.loads(body['content']) for path, method, body in client.calls
                   if path.endswith('/git/blobs') and method == 'POST' and body['encoding'] == 'utf-8']
        self.assertEqual(indices, [[old]])

    def test_credential_failure_never_echoes_sensitive_helper_output(self):
        failed = type('Result', (), {'returncode': 1, 'stdout': '', 'stderr': 'secret-not-real'})()
        with patch.object(watcher.subprocess, 'run', return_value=failed) as command:
            with self.assertRaisesRegex(watcher.WatcherError, 'github_authentication_required') as error:
                watcher.saved_token('example')
        self.assertNotIn('secret-not-real', str(error.exception))
        self.assertEqual(command.call_args.kwargs['env']['GCM_INTERACTIVE'], 'Never')
        self.assertEqual(command.call_args.kwargs['cwd'], tempfile.gettempdir())

    def test_state_switching_repository_does_not_skip_images_for_new_private_repo(self):
        old = {**self.state, 'uploaded': {'a' * 64: {'uploadedAt': 'test'}}}
        watcher.atomic_json(self.root / '.local' / 'watcher-state.json', old)
        self.assertEqual(watcher.load_state(self.root, 'example/another')['uploaded'], {})

    def test_configured_batch_limit_bounds_each_upload(self):
        self.settings['watchBatchSize'] = 1
        self.configure()
        self.image('one.png', 'white')
        self.image('two.png', 'black')
        config = watcher.load_config(self.root)
        tracker = watcher.StableFiles()
        tracker.ready(self.folder)
        self.assertEqual(watcher.cycle(self.root, config, self.state, tracker, FakeGitHub), 1)
        self.assertEqual(len(self.state['uploaded']), 1)

    def test_invalid_batch_size_is_rejected_before_network(self):
        for size in (0, 31, True, '12'):
            self.settings['watchBatchSize'] = size
            self.configure()
            with self.assertRaisesRegex(watcher.WatcherError, 'invalid_batch_size'):
                watcher.load_config(self.root)


if __name__ == '__main__':
    unittest.main()
