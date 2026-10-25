#!/usr/bin/env python3
"""GitHub Pages 首次部署助手（仅发布此项目的 5 个示例词）。

python scripts/deploy_github.py --repo vocab
    只显示计划；不联网、不创建文件、不提交。

在当前 PowerShell 会话设置 $env:GITHUB_TOKEN（或 GH_TOKEN），然后：
python scripts/deploy_github.py --repo vocab --deploy
    校验示例项目 → 创建本人公开仓库 → 启用 Pages Actions → 提交 → 推送。
    Token 只在内存/子进程环境中使用，不写进文件、远程地址或 Git 配置。

python scripts/deploy_github.py --repo vocab --status
    只读查询 Pages 和最近工作流状态；仍需环境变量 Token。

Token 需要本人目标仓库的 Contents / Workflows / Pages 管理权限，并能创建
公开仓库；经典 Token 通常需 public_repo 和 workflow。不要把 Token 提交到仓库。
本助手拒绝非空的无关仓库，不执行 force push、不删除文件、不改全局 Git 配置。
真实截图接入后请使用 update_words.py，本助手会拒绝非示例词库。
"""
from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MARKER = '.vocab-project.json'
PROJECT = {'application': 'screenshot-vocabulary-pwa', 'schema': 1}
DEMO_WORDS = {'serendipity', 'resilient', 'gradually', 'curiosity', 'make sense'}
ROOT_FILES = {
    '.gitignore', MARKER, 'index.html', 'styles.css', 'app.js', 'core.js', 'db.js',
    'sw.js', 'manifest.webmanifest', 'package.json', 'requirements.txt', 'README.md',
}


class DeployError(RuntimeError):
    pass


class GitHub:
    def __init__(self, token):
        self.token = token

    def call(self, path, method='GET', body=None, missing=False):
        request = urllib.request.Request('https://api.github.com' + path, method=method,
            data=json.dumps(body).encode('utf-8') if body is not None else None,
            headers={'Authorization': 'Bearer ' + self.token,
                     'Accept': 'application/vnd.github+json',
                     'X-GitHub-Api-Version': '2022-11-28',
                     'Content-Type': 'application/json', 'User-Agent': 'ScreenshotVocabSetup/1.0'})
        try:
            with urllib.request.urlopen(request, timeout=40) as response:
                content = response.read()
                return json.loads(content) if content else {}
        except urllib.error.HTTPError as exc:
            if missing and exc.code == 404:
                return None
            if exc.code == 401:
                raise DeployError('GitHub HTTP 401：Token 无效或已过期；未输出凭据。') from None
            if exc.code == 403:
                raise DeployError('GitHub HTTP 403：检查 Token 的仓库创建、Contents、Workflows、Pages 权限或限流。') from None
            if exc.code == 422:
                raise DeployError('GitHub HTTP 422：仓库名已占用、配置无效或 Pages 已存在；请检查 GitHub 页面。') from None
            raise DeployError(f'GitHub HTTP {exc.code}：操作未完成；请检查网络、仓库权限和 GitHub 状态。') from None
        except (urllib.error.URLError, TimeoutError):
            raise DeployError('GitHub 网络请求失败。可安全重试；本助手不会修改本机网络配置。') from None


def token_environment(token):
    """Pass ephemeral Git authentication without argv, credential files, or config writes."""
    env = dict(os.environ)
    authorization = base64.b64encode(('x-access-token:' + token).encode()).decode('ascii')
    # Preserve unrelated caller-provided configuration, append more-specific values.
    try:
        count = int(env.get('GIT_CONFIG_COUNT', '0'))
    except ValueError:
        raise DeployError('当前 GIT_CONFIG_COUNT 环境变量无效，请先检查 Git 配置。') from None
    for key, value in [
        ('credential.helper', ''),
        ('http.https://github.com/.extraheader', ''),
        ('http.https://github.com/.extraheader', 'Authorization: Basic ' + authorization),
    ]:
        env[f'GIT_CONFIG_KEY_{count}'] = key
        env[f'GIT_CONFIG_VALUE_{count}'] = value
        count += 1
    env['GIT_CONFIG_COUNT'] = str(count)
    env['GIT_TERMINAL_PROMPT'] = '0'
    env['GCM_INTERACTIVE'] = 'Never'
    return env


def git(*args, env=None, check=True):
    try:
        result = subprocess.run(['git', '-C', str(ROOT), *args], env=env,
                                capture_output=True, text=True, encoding='utf-8', errors='replace')
    except OSError:
        raise DeployError('找不到可用的 Git；请先安装 Git 并重新打开终端。') from None
    if check and result.returncode:
        # Do not emit stderr: remote URLs and helper output can contain credentials.
        action = args[0] if args else 'operation'
        detail = ('远程可能有新提交或 Token 缺少 workflow 权限；本地提交保留。请检查 '
                  'GitHub Actions / git status，再重试；不会强推。' if action == 'push'
                  else '请在项目目录执行 git status 检查。')
        raise DeployError(f'Git {action} 失败；{detail}')
    return result


def allowed_source(path):
    parts = Path(path).parts
    if len(parts) == 1:
        return path in ROOT_FILES
    if path == '.github/workflows/pages.yml' or path == 'data/words.json':
        return True
    if len(parts) != 2:
        return False
    parent, name = parts
    if parent == 'images':
        return re.fullmatch(r'demo-[a-z-]+\.svg', name) is not None
    if parent == 'icons':
        return name in {'icon.svg', 'icon-192.png', 'icon-512.png', 'maskable-512.png', 'apple-touch-icon.png'}
    if parent == 'scripts':
        return name in {'build.mjs', 'update_words.py', 'deploy_github.py', 'README_PIPELINE.md'}
    if parent == 'tests':
        return name in {'core.test.mjs', 'sw.test.mjs', 'app.test.mjs',
                        'test_pipeline.py', 'test_deploy.py'}
    return False


def validate_demo():
    required = ['index.html', 'app.js', 'sw.js', 'manifest.webmanifest',
                '.github/workflows/pages.yml', 'data/words.json']
    if any(not (ROOT / name).is_file() for name in required):
        raise DeployError('项目文件不完整；请保留完整源代码后再部署。')
    try:
        words = json.loads((ROOT / 'data' / 'words.json').read_text(encoding='utf-8-sig'))
    except (OSError, ValueError):
        raise DeployError('data/words.json 无法读取。') from None
    if (not isinstance(words, list) or len(words) != 5 or
            any(not isinstance(w, dict) for w in words) or
            {w.get('word') for w in words} != DEMO_WORDS or
            any(not isinstance(w.get('image'), str) or not allowed_source(w['image']) or
                not w['image'].startswith('images/demo-') for w in words)):
        raise DeployError('首次部署助手只允许原始 5 个示例词和示例 SVG；真实词库请用 update_words.py。')
    for word in words:
        if not (ROOT / word['image']).is_file():
            raise DeployError('示例图片缺失，已停止部署。')
    # Stage only a fixed public source allowlist, never .local, environments, or raw screenshots.
    paths = sorted(path.relative_to(ROOT).as_posix() for path in ROOT.rglob('*')
                   if path.is_file() and not path.is_symlink() and
                   allowed_source(path.relative_to(ROOT).as_posix()))
    for relative in paths:
        if any(secret and secret.encode() in (ROOT / relative).read_bytes() for secret in
               (os.environ.get('GITHUB_TOKEN'), os.environ.get('GH_TOKEN'), os.environ.get('OPENAI_API_KEY'))):
            raise DeployError('公开源文件中检测到当前环境变量中的密钥；停止提交，请先移除。')
    return paths


def anonymous_git_environment():
    return dict(os.environ, GIT_AUTHOR_NAME='Vocabulary Builder',
                GIT_AUTHOR_EMAIL='builder@users.noreply.github.com',
                GIT_COMMITTER_NAME='Vocabulary Builder',
                GIT_COMMITTER_EMAIL='builder@users.noreply.github.com')


def inspect_remote(client, login, name):
    prefix = '/repos/' + urllib.parse.quote(login) + '/' + urllib.parse.quote(name)
    repo = client.call(prefix, missing=True)
    if repo is None:
        return prefix, None, False
    if repo.get('owner', {}).get('login', '').casefold() != login.casefold() or repo.get('private'):
        raise DeployError('已有仓库不属于当前用户或不是公开仓库；不会修改其可见性。')
    branches = client.call(prefix + '/branches?per_page=1')
    empty = not branches
    if not empty:
        marker = client.call(prefix + '/contents/' + MARKER, missing=True)
        try:
            value = json.loads(base64.b64decode(marker['content']).decode()) if marker else None
        except (ValueError, TypeError, KeyError):
            value = None
        if value != PROJECT:
            raise DeployError('同名仓库已包含其他内容且无本项目标识；不会覆盖。请换一个仓库名。')
    return prefix, repo, empty


def configure_pages(client, prefix):
    page = client.call(prefix + '/pages', missing=True)
    client.call(prefix + '/pages', 'PUT' if page is not None else 'POST', {'build_type': 'workflow'})


def status(client, login, name):
    prefix = f'/repos/{urllib.parse.quote(login)}/{urllib.parse.quote(name)}'
    page = client.call(prefix + '/pages', missing=True)
    runs = client.call(prefix + '/actions/workflows/pages.yml/runs?per_page=1', missing=True)
    if page:
        print('Pages 状态：' + str(page.get('status', 'unknown')))
        if page.get('html_url'):
            print('GitHub 返回的网址：' + page['html_url'])
    else:
        print('Pages 尚未配置。')
    items = runs.get('workflow_runs', []) if runs else []
    if items:
        latest = items[0]
        print('最近工作流：' + str(latest.get('status')) + ' / ' + str(latest.get('conclusion')))
        print('工作流详情：' + str(latest.get('html_url', '')))
        if latest.get('conclusion') != 'success':
            print('尚未确认部署成功；请等待完成，或打开上面的详情检查错误。')
    else:
        print('尚无 Pages 工作流记录。')


def deploy(client, account, name, paths, token):
    login = account['login']
    remote = f'https://github.com/{login}/{name}.git'
    # Verify local state before any remote mutation.
    own_git = (ROOT / '.git').exists()
    if own_git:
        top = git('rev-parse', '--show-toplevel').stdout.strip()
        if Path(top).resolve() != ROOT.resolve():
            raise DeployError('此目录不是独立项目仓库，已停止。')
        branch = git('branch', '--show-current').stdout.strip()
        if branch != 'main':
            raise DeployError('请先确认本地分支为 main；助手不会替你切换或重置分支。')
        tracked = git('ls-files').stdout.splitlines()
        if any(not allowed_source(path) for path in tracked):
            raise DeployError('现有 Git 历史跟踪了部署白名单以外的文件；请人工检查，助手不会推送。')
        if git('diff', '--cached', '--name-only').stdout.strip():
            raise DeployError('已有暂存修改，请先处理后重试，避免误提交。')
        current = git('remote', 'get-url', 'origin', check=False)
        if current.returncode == 0 and current.stdout.strip().removesuffix('.git') != remote.removesuffix('.git'):
            raise DeployError('origin 与目标仓库不一致；不会覆盖你的远程配置。')
    prefix, existing, empty = inspect_remote(client, login, name)
    if existing and not empty and (not own_git or git('rev-parse', '--verify', 'HEAD', check=False).returncode):
        raise DeployError('远程已有本项目历史而本地没有；请先克隆现有仓库后再继续，避免历史冲突。')
    if existing is None:
        client.call('/user/repos', 'POST', {'name': name, 'description': 'Screenshot English vocabulary PWA',
                                          'private': False, 'auto_init': False})
        print(f'已创建公开仓库：{login}/{name}')
    if not own_git:
        git('init', '-b', 'main')
    if git('remote', 'get-url', 'origin', check=False).returncode:
        git('remote', 'add', 'origin', remote)
    # Use an anonymous project-local identity; never publish inherited personal details.
    git('config', '--local', 'user.name', 'Vocabulary Builder')
    git('config', '--local', 'user.email', 'builder@users.noreply.github.com')
    (ROOT / MARKER).write_text(json.dumps(PROJECT, indent=2) + '\n', encoding='utf-8')
    git('add', '--', *sorted(set(paths + [MARKER])))
    if git('diff', '--cached', '--name-only').stdout.strip():
        git('commit', '--no-gpg-sign', '-m', 'Deploy screenshot vocabulary demo PWA',
            env=anonymous_git_environment())
    configure_pages(client, prefix)
    git('push', '-u', 'origin', 'main', env=token_environment(token))
    print(f'代码已推送：https://github.com/{login}/{name}')
    print('GitHub Actions 正在部署，请稍后运行 --status。推送成功不代表网页已部署成功。')
    status(client, login, name)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--repo', default='vocab', help='在本人账号下创建的仓库名称')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--deploy', action='store_true', help='执行创建公开仓库和部署')
    mode.add_argument('--status', action='store_true', help='只读查询部署状态')
    args = parser.parse_args(argv)
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', args.repo) or args.repo in {'.', '..'}:
        parser.error('--repo 只能含字母、数字、下划线、点和短横线，最长 100 字符。')
    if not args.deploy and not args.status:
        print(f'计划：将此项目的 5 个示例词部署到 GitHub 本人公开仓库 {args.repo}。')
        print('将配置 GitHub Pages / GitHub Actions；不会上传真实截图或 .local。')
        print('当前仅显示计划，未联网、未写文件。设置 GITHUB_TOKEN 后加 --deploy 执行。')
        return 0
    token = (os.environ.get('GITHUB_TOKEN') or os.environ.get('GH_TOKEN') or '').strip()
    if not token:
        print('缺少 GITHUB_TOKEN 或 GH_TOKEN 环境变量。请在本机终端设置，不要发到聊天或写进代码。', file=sys.stderr)
        return 1
    try:
        paths = validate_demo() if args.deploy else None
        client = GitHub(token)
        account = client.call('/user')
        if not isinstance(account.get('login'), str) or not isinstance(account.get('id'), int):
            raise DeployError('GitHub 未返回有效用户信息。')
        if args.status:
            status(client, account['login'], args.repo)
        else:
            deploy(client, account, args.repo, paths, token)
        return 0
    except (DeployError, OSError, ValueError, subprocess.SubprocessError) as exc:
        print('部署未完成：' + str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
