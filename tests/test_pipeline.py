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
from unittest.mock import patch

from PIL import Image

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'update_words.py'
spec = importlib.util.spec_from_file_location('pipeline', SCRIPT)
pipeline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pipeline)


def entry(word='Resilient'):
    return {'word': word, 'phonetic': '/rɪˈzɪliənt/', 'meaning': '有韧性的',
            'example': 'She remained resilient through difficult times.'}


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.folder = self.root / 'screenshots'
        self.folder.mkdir()
        self.local = self.root / '.local' / 'pipeline'
        self.state = {'version': 1, 'files': {}}
        self.env = patch.dict(os.environ, {'OPENAI_API_KEY': 'test-key-not-real'})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def image(self, name='word.png', size=(1600, 1000)):
        target = self.folder / name
        Image.new('RGB', size, 'white').save(target)
        return target

    def prepare(self, words=None):
        with patch.object(pipeline, 'recognize', return_value=words or [entry()]) as api:
            errors = pipeline.prepare(self.root, self.folder, self.state)
        self.assertEqual(errors, 0)
        return api

    def test_compression_width_format_and_stripped_metadata(self):
        source = self.image()
        with Image.open(io.BytesIO(pipeline.compress_image(source))) as output:
            self.assertEqual(output.size, (800, 500))
            self.assertEqual(output.format, 'WEBP')
            self.assertFalse(output.getexif())

    def test_small_image_not_upscaled(self):
        source = self.image(size=(300, 200))
        with Image.open(io.BytesIO(pipeline.compress_image(source))) as output:
            self.assertEqual(output.size, (300, 200))

    def test_dry_run_no_network_no_write_and_content_dedupe(self):
        self.image()
        shutil.copy2(self.folder / 'word.png', self.folder / 'renamed.png')
        before = set(self.root.rglob('*'))
        with patch.object(pipeline, 'ROOT', self.root), patch.object(pipeline, 'recognize') as api:
            self.assertEqual(pipeline.main(['--folder', str(self.folder), '--dry-run']), 0)
            api.assert_not_called()
        self.assertEqual(set(self.root.rglob('*')), before)

    def test_prepare_ignores_renamed_duplicate_across_runs(self):
        source = self.image()
        api = self.prepare()
        self.assertEqual(api.call_count, 1)
        source.rename(self.folder / 'moved.png')
        api = self.prepare()
        self.assertEqual(api.call_count, 0)
        self.assertEqual(len(self.state['files']), 1)
        self.assertFalse((self.root / 'data').exists())
        self.assertFalse((self.root / 'images').exists())
        self.assertTrue((self.local / 'preview.html').exists())

    def test_recognition_failure_not_checkpointed_and_can_retry(self):
        self.image()
        with patch.object(pipeline, 'recognize', side_effect=RuntimeError('test failed')):
            self.assertEqual(pipeline.prepare(self.root, self.folder, self.state), 1)
        self.assertEqual(self.state['files'], {})
        self.prepare()
        self.assertEqual(len(self.state['files']), 1)

    def test_model_validation_rejects_missing_fields_empty_and_non_english(self):
        for value in ({'words': []}, {'words': [{'word': 'test'}]},
                      {'words': [{**entry(), 'word': '你好'}]}):
            with self.assertRaises(ValueError):
                pipeline.validate_recognition(value)
        words = pipeline.validate_recognition({'words': [entry(), entry(' resilient  ')]})
        self.assertEqual(len(words), 1)

    def test_merge_stable_key_and_preserves_existing_metadata(self):
        existing = [{**entry('  keep   going '), 'addedAt': '2020-01-01', 'image': 'images/old.webp'}]
        duplicate = {**entry('KEEP GOING'), 'addedAt': '2026-01-01', 'image': 'images/new.webp'}
        merged = pipeline.merge_words(existing, [duplicate, entry('new')])
        self.assertEqual(len(merged), 2)
        self.assertEqual(merged[0], existing[0])
        self.assertEqual(pipeline.word_key('cafe\u0301'), pipeline.word_key('café'))

    def test_prepare_report_escapes_markup(self):
        self.image('word&test.png')
        self.prepare(words=[{**entry(), 'meaning': '<script>alert(1)</script>'}])
        report = (self.local / 'preview.html').read_text(encoding='utf-8')
        self.assertIn('&lt;script&gt;', report)
        self.assertNotIn('<script>', report)

    def test_publish_requires_explicit_image_approval_before_network(self):
        with patch.object(pipeline, 'ROOT', self.root), patch.object(pipeline, 'prepare') as prepare:
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                pipeline.main(['--publish'])
            prepare.assert_not_called()
        self.assertFalse(self.local.exists())

    def test_private_config_hard_disables_both_publish_modes_before_mutation(self):
        pipeline.atomic_json(self.root / '.local' / 'config.json',
                             {'screenshotFolder': 'screenshots', 'allowPublicScreenshots': False})
        before = {str(path.relative_to(self.root)): path.read_bytes()
                  for path in self.root.rglob('*') if path.is_file()}
        for mode in ('--publish', '--publish-prepared'):
            with self.subTest(mode=mode), patch.object(pipeline, 'ROOT', self.root), \
                    patch.object(pipeline, 'prepare') as prepare, \
                    patch.object(pipeline, 'publish') as publish, \
                    contextlib.redirect_stderr(io.StringIO()) as error:
                self.assertEqual(pipeline.main([mode, '--approve-images']), 1)
                self.assertIn('用户已禁用公开截图发布', error.getvalue())
                prepare.assert_not_called()
                publish.assert_not_called()
        after = {str(path.relative_to(self.root)): path.read_bytes()
                 for path in self.root.rglob('*') if path.is_file()}
        self.assertEqual(before, after)
        self.assertFalse(self.local.exists())

    def test_atomic_write_preserves_original_if_replace_fails(self):
        target = self.root / 'data.json'
        target.write_text('[1]')
        with patch.object(pipeline.os, 'replace', side_effect=OSError('locked')):
            with self.assertRaises(OSError):
                pipeline.atomic_json(target, [2])
        self.assertEqual(target.read_text(), '[1]')
        self.assertEqual(list(self.root.glob('*.tmp')), [])

    def test_lock_prevents_concurrent_update_and_cleans_up(self):
        with pipeline.pipeline_lock(self.local):
            with self.assertRaises(RuntimeError):
                with pipeline.pipeline_lock(self.local):
                    self.fail('second lock should be denied')
        self.assertFalse((self.local / 'update.lock').exists())

    def test_folder_config_is_private_and_relative_to_project(self):
        pipeline.atomic_json(self.root / '.local' / 'config.json',
                             {'screenshotFolder': 'screenshots'})
        with patch.object(pipeline, 'ROOT', self.root), \
                patch.dict(os.environ, {'VOCAB_SCREENSHOT_DIR': ''}):
            self.assertEqual(pipeline.default_folder(), self.root / 'screenshots')

    def test_folder_environment_precedes_private_config(self):
        pipeline.atomic_json(self.root / '.local' / 'config.json',
                             {'screenshotFolder': 'configured'})
        with patch.object(pipeline, 'ROOT', self.root), \
                patch.dict(os.environ, {'VOCAB_SCREENSHOT_DIR': 'environment-folder'}):
            self.assertEqual(pipeline.default_folder(), Path('environment-folder'))

    def test_responses_request_does_not_persist_key_and_has_structured_image(self):
        payload = {'status': 'completed', 'output': [{'type': 'message', 'content': [
            {'type': 'output_text', 'text': json.dumps({'words': [entry()]})}]}]}
        response = io.BytesIO(json.dumps(payload).encode())
        with patch.object(pipeline.urllib.request, 'urlopen', return_value=response) as call:
            result = pipeline.recognize(b'webp', 'mock-secret', 'gpt-4.1-mini')
        request = call.call_args.args[0]
        body = json.loads(request.data)
        self.assertFalse(body['store'])
        self.assertEqual(body['input'][0]['content'][1]['type'], 'input_image')
        self.assertEqual(body['text']['format']['type'], 'json_schema')
        self.assertNotIn('mock-secret', request.data.decode())
        self.assertEqual(result[0]['word'], 'Resilient')


@unittest.skipUnless(shutil.which('git'), 'Git is required for publication integration tests')
class GitPublishTests(unittest.TestCase):
    setUp = PipelineTests.setUp
    tearDown = PipelineTests.tearDown
    image = PipelineTests.image
    prepare = PipelineTests.prepare

    def run_git(self, *args, cwd=None):
        result = subprocess.run(['git', '-C', str(cwd or self.root), *args], capture_output=True,
                                text=True, encoding='utf-8', errors='replace')
        if result.returncode:
            self.fail('Git test setup failed: ' + result.stderr)
        return result.stdout.strip()

    def init_git(self):
        self.run_git('init', '-b', 'main')
        self.run_git('config', 'user.name', 'Test')
        self.run_git('config', 'user.email', 'test@example.invalid')
        (self.root / '.gitignore').write_text('.local/\nscreenshots/\n')
        self.run_git('add', '.gitignore')
        self.run_git('commit', '-m', 'Initial')
        self.remote = self.root / 'remote.git'
        self.run_git('init', '--bare', str(self.remote))
        self.run_git('remote', 'add', 'origin', str(self.remote))

    def test_publish_stages_only_words_and_referenced_images(self):
        self.init_git()
        self.image()
        self.prepare()
        (self.root / 'private.txt').write_text('do not upload')
        pipeline.publish(self.root, self.state)
        tracked = self.run_git('ls-tree', '-r', '--name-only', 'HEAD').splitlines()
        self.assertIn('data/words.json', tracked)
        self.assertTrue(any(p.startswith('images/') for p in tracked))
        self.assertNotIn('private.txt', tracked)
        self.assertTrue(all(not p.startswith('.local') for p in tracked))
        self.assertEqual(next(iter(self.state['files'].values()))['status'], 'published')
        self.assertEqual(self.run_git('rev-parse', 'HEAD'), self.run_git('rev-parse', 'main', cwd=self.remote))

    def test_unrelated_staged_file_blocks_publish_before_data_mutation(self):
        self.init_git()
        self.image()
        self.prepare()
        (self.root / 'private.txt').write_text('do not upload')
        self.run_git('add', 'private.txt')
        with self.assertRaises(RuntimeError):
            pipeline.publish(self.root, self.state)
        self.assertFalse((self.root / 'data' / 'words.json').exists())
        self.assertEqual(next(iter(self.state['files'].values()))['status'], 'prepared')

    def test_failed_push_retries_without_new_commit_or_recognition(self):
        self.init_git()
        self.image()
        self.prepare()
        original = pipeline.git
        def fail_push(root, *args, **kwargs):
            if args[0] == 'push':
                raise RuntimeError('push unavailable')
            return original(root, *args, **kwargs)
        with patch.object(pipeline, 'git', side_effect=fail_push), self.assertRaises(RuntimeError):
            pipeline.publish(self.root, self.state)
        head = self.run_git('rev-parse', 'HEAD')
        self.assertEqual(next(iter(self.state['files'].values()))['status'], 'published')
        with patch.object(pipeline, 'recognize') as api:
            pipeline.publish(self.root, self.state)
            api.assert_not_called()
        self.assertEqual(self.run_git('rev-parse', 'HEAD'), head)

    def test_public_commit_overrides_inherited_personal_author_and_committer(self):
        self.init_git()
        self.run_git('config', 'commit.gpgsign', 'true')
        self.run_git('config', 'user.signingkey', 'private-signing-key')
        self.image()
        self.prepare()
        inherited = {'GIT_AUTHOR_NAME': 'Private Person', 'GIT_AUTHOR_EMAIL': 'private@example.invalid',
                     'GIT_COMMITTER_NAME': 'Another Person', 'GIT_COMMITTER_EMAIL': 'other@example.invalid'}
        with patch.dict(os.environ, inherited):
            pipeline.publish(self.root, self.state)
        metadata = self.run_git('show', '-s', '--format=%an%n%ae%n%cn%n%ce', 'HEAD')
        self.assertEqual(metadata.splitlines(), ['Vocabulary Builder', 'builder@users.noreply.github.com',
                                                'Vocabulary Builder', 'builder@users.noreply.github.com'])


if __name__ == '__main__':
    unittest.main()
