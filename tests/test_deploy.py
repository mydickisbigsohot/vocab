import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[1] / 'scripts' / 'deploy_github.py'
spec = importlib.util.spec_from_file_location('deploy', SOURCE)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeployTests(unittest.TestCase):
    def test_default_plan_does_not_call_api_git_or_write(self):
        with patch.object(deploy, 'GitHub') as api, patch.object(deploy, 'git') as git, \
                patch.object(deploy, 'validate_demo') as validate, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(deploy.main(['--repo', 'vocab']), 0)
            api.assert_not_called()
            git.assert_not_called()
            validate.assert_not_called()

    def test_token_only_in_child_environment_not_persistent(self):
        original = dict(os.environ)
        with patch.dict(os.environ, {'GIT_CONFIG_COUNT': '0'}):
            env = deploy.token_environment('test-secret')
        self.assertEqual(os.environ, original)
        self.assertEqual(env['GIT_CONFIG_VALUE_0'], '')
        self.assertEqual(env['GIT_CONFIG_VALUE_1'], '')
        self.assertEqual(env['GIT_CONFIG_KEY_2'], 'http.https://github.com/.extraheader')
        self.assertTrue(env['GIT_CONFIG_VALUE_2'].startswith('Authorization: Basic '))
        self.assertNotIn('test-secret', env['GIT_CONFIG_VALUE_2'])

    def test_source_allowlist_excludes_private_and_unexpected_images(self):
        for name in ('.env', '.local/state.json', 'images/real.webp', 'secret.key',
                     'scripts/__pycache__/module.pyc', '.git/config', 'data/progress.json'):
            self.assertFalse(deploy.allowed_source(name), name)
        for name in ('index.html', 'images/demo-serendipity.svg', '.github/workflows/pages.yml',
                     'scripts/deploy_github.py', 'tests/test_deploy.py'):
            self.assertTrue(deploy.allowed_source(name), name)

    def test_nonempty_unrelated_repo_is_refused(self):
        client = Mock()
        client.call.side_effect = [
            {'owner': {'login': 'learner'}, 'private': False},
            [{'name': 'main'}], None,
        ]
        with self.assertRaises(deploy.DeployError):
            deploy.inspect_remote(client, 'learner', 'vocab')

    def test_private_repo_is_not_made_public(self):
        client = Mock()
        client.call.return_value = {'owner': {'login': 'learner'}, 'private': True}
        with self.assertRaises(deploy.DeployError):
            deploy.inspect_remote(client, 'learner', 'vocab')
        self.assertEqual(client.call.call_count, 1)

    def test_empty_owned_repo_accepted(self):
        client = Mock()
        client.call.side_effect = [{'owner': {'login': 'learner'}, 'private': False}, []]
        prefix, repo, empty = deploy.inspect_remote(client, 'learner', 'vocab')
        self.assertTrue(empty)
        self.assertEqual(prefix, '/repos/learner/vocab')

    def test_pages_configuration_uses_workflow_and_proper_method(self):
        for existing, method in [(None, 'POST'), ({'build_type': 'legacy'}, 'PUT')]:
            client = Mock()
            client.call.side_effect = [existing, {}]
            deploy.configure_pages(client, '/repos/me/vocab')
            self.assertEqual(client.call.call_args.args,
                             ('/repos/me/vocab/pages', method, {'build_type': 'workflow'}))

    def test_invalid_repo_name_is_rejected(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            deploy.main(['--repo', '../other'])

    @unittest.skipUnless(shutil.which('git'), 'Git required')
    def test_deploy_commit_is_anonymous_despite_inherited_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'index.html').write_text('<title>Demo</title>')
            inherited = {'GIT_AUTHOR_NAME': 'Private Person', 'GIT_AUTHOR_EMAIL': 'private@example.invalid',
                         'GIT_COMMITTER_NAME': 'Other Person', 'GIT_COMMITTER_EMAIL': 'other@example.invalid'}
            actual_git = deploy.git
            def offline_git(*args, **kwargs):
                if args[0] == 'push':
                    return subprocess.CompletedProcess(args, 0, '', '')
                return actual_git(*args, **kwargs)
            with patch.object(deploy, 'ROOT', root), patch.dict(os.environ, inherited), \
                    patch.object(deploy, 'inspect_remote', return_value=('/repos/learner/vocab', None, False)), \
                    patch.object(deploy, 'configure_pages'), patch.object(deploy, 'status'), \
                    patch.object(deploy, 'git', side_effect=offline_git), \
                    contextlib.redirect_stdout(io.StringIO()):
                deploy.deploy(Mock(), {'login': 'learner', 'id': 1}, 'vocab', ['index.html'], 'not-a-real-token')
                metadata = actual_git('show', '-s', '--format=%an%n%ae%n%cn%n%ce', 'HEAD').stdout.strip()
                self.assertEqual(metadata.splitlines(), [
                    'Vocabulary Builder', 'builder@users.noreply.github.com',
                    'Vocabulary Builder', 'builder@users.noreply.github.com'])
                self.assertEqual(actual_git('config', '--local', '--get', 'user.email').stdout.strip(),
                                 'builder@users.noreply.github.com')


if __name__ == '__main__':
    unittest.main()
