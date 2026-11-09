import argparse
from contextlib import redirect_stdout
import importlib.util
import io
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
spec = importlib.util.spec_from_file_location('publish_release', TOOLS / 'publish-release.py')
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
SCRATCH = TOOLS.parent / 'develop/tmp'
SCRATCH.mkdir(parents=True, exist_ok=True)


def failure():
    return subprocess.CalledProcessError(1, ['gh'], stderr='connection reset')


class PublishingTests(unittest.TestCase):
    def test_full_inclusion_threshold(self):
        full = {'full': {'size': 100}}
        history = [{'patch': {'asset': {'size': 30}}}, full]
        self.assertFalse(publisher.should_include_full(history, 70))
        self.assertTrue(publisher.should_include_full(history, 71))
        self.assertFalse(publisher.should_include_full([full], 99))
        self.assertTrue(publisher.should_include_full([full], 101))
        self.assertTrue(publisher.should_include_full([full], 0, force=True))
        self.assertTrue(publisher.should_include_full([], 0))
        self.assertTrue(publisher.should_include_full([{'patch': {'asset': {'size': 1}}}], 1))
        # The newest full terminates the walk, even if it also has a patch.
        self.assertFalse(publisher.should_include_full([
            {'full': {'size': 100}, 'patch': {'asset': {'size': 1000}}},
            {'full': {'size': 1}},
        ], 99))

    def test_upload_resume_skips_only_equal_sizes_and_keeps_order(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temporary:
            root = Path(temporary)
            files = [root / name for name in ('control-patch.000', 'control-patch.001', 'control.manifest')]
            for file in files:
                file.write_bytes(b'123')
            existing = [{'name': files[0].name, 'size': 3, 'state': 'uploaded'},
                        {'name': files[1].name, 'size': 2, 'state': 'uploaded'}]
            with patch.object(publisher, 'gh') as gh, redirect_stdout(io.StringIO()):
                publisher.upload_assets('owner/repo', 'tag', files, existing)
            self.assertEqual([call.args[3] for call in gh.call_args_list], list(map(str, files[1:])))
            for call in gh.call_args_list:
                self.assertEqual(call.args[-1], '--clobber')

    def test_retry_backoff_and_success(self):
        with patch.object(publisher, 'gh', side_effect=[failure(), failure(), 'ok']) as gh, \
             patch.object(publisher.time, 'sleep') as sleep:
            self.assertEqual(publisher.retry_upload(['release', 'upload', 'tag']), 'ok')
        self.assertEqual(gh.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [5, 10])

    def test_retry_exhaustion_is_eight_attempts(self):
        with patch.object(publisher, 'gh', side_effect=failure()) as gh, \
             patch.object(publisher.time, 'sleep') as sleep:
            with self.assertRaises(subprocess.CalledProcessError):
                publisher.retry_upload(['release', 'upload', 'tag'])
        self.assertEqual(gh.call_count, 8)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [5, 10, 20, 40, 60, 60, 60])

    def test_only_latest_404_means_first_release(self):
        for status in (403, 404, 429, 500):
            with self.subTest(status=status), patch.object(publisher, 'gh', side_effect=
                    subprocess.CalledProcessError(1, ['gh'], stderr=f'gh: error (HTTP {status})')):
                if status == 404:
                    self.assertIsNone(publisher.latest_release('owner/repo'))
                else:
                    with self.assertRaises(subprocess.CalledProcessError):
                        publisher.latest_release('owner/repo')

    def test_dry_run_packs_then_resume_reuses_salts_and_uploads_bootstraps(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temporary:
            root = Path(temporary)
            tree = root / 'package'
            (tree / 'bin').mkdir(parents=True)
            build_id = 'a' * 64
            (tree / 'build.json').write_text(json.dumps({'buildId': build_id}))
            (tree / 'manifest.json').write_text(json.dumps({
                'buildId': build_id, 'source': {'commit': 'b' * 40, 'dirty': False},
            }))
            for name in ('remotekit_control.exe', 'remotekit_node.exe'):
                (tree / 'bin' / name).write_bytes(b'bootstrap')
            args = argparse.Namespace(package=tree, cache=root / 'cache', key=root / 'release.key',
                                      tool=root / 'tool.exe', repo='owner/repo', full=False, dry_run=True)
            draft = None
            writes = []

            def gh(*arguments):
                if arguments[0] == 'api' and arguments[1].startswith('repos/owner/repo/commits/'):
                    return '{}'
                if arguments[:2] == ('api', 'repos/owner/repo/releases/latest'):
                    raise subprocess.CalledProcessError(1, ['gh'], stderr='HTTP 404')
                if arguments[:3] == ('api', '--paginate', '--slurp'):
                    return json.dumps([[draft] if draft else []])
                writes.append(arguments)
                return ''

            def invoke(command, **options):
                self.assertEqual(command, 'pack')
                self.assertTrue(options['full'])
                out = options['out']
                out.mkdir()
                uploads = []
                for name, data in [('control-full.000', b'encrypted bytes'), ('control.manifest', b'manifest')]:
                    (out / name).write_bytes(data)
                    uploads.append({'name': name, 'size': len(data)})
                (out / 'upload.json').write_text(json.dumps(uploads))
                return {'full': 15}

            with patch.object(publisher, 'gh', side_effect=gh), \
                 patch.object(publisher.Publisher, 'invoke', side_effect=invoke) as native, \
                 redirect_stdout(io.StringIO()) as output:
                publisher.Publisher(args).run()
                self.assertEqual(writes, [])
                self.assertIn('Upload control-full.000', output.getvalue())
                self.assertIn('Upload remotekit_control.exe', output.getvalue())
                state = json.loads((root / 'cache/out' / (build_id + '.json')).read_text())
                draft = {'draft': True, 'tag_name': state['tag'], 'body': 'buildId: ' + build_id,
                         'assets': [{'name': 'control-full.000', 'size': len(b'encrypted bytes'),
                                     'state': 'uploaded'}]}
                args.dry_run = False
                publisher.Publisher(args).run()
                self.assertEqual(native.call_count, 1)
            uploads = [Path(call[3]).name for call in writes if call[:2] == ('release', 'upload')]
            self.assertEqual(uploads, ['control.manifest', 'remotekit_control.exe', 'remotekit_node.exe'])
            self.assertEqual(writes[-1][:3], ('release', 'edit', state['tag']))
            self.assertEqual(writes[-1][-2:], ('--draft=false', '--latest'))

    def test_patch_is_packed_before_full_decision_and_cipher_tags_are_excluded(self):
        for full_size, expect_full in ((200, False), (160, True)):
            with self.subTest(full_size=full_size), tempfile.TemporaryDirectory(dir=SCRATCH) as temporary:
                root = Path(temporary)
                tree = root / 'package'
                (tree / 'bin').mkdir(parents=True)
                build_id = 'b' * 64
                (tree / 'build.json').write_text(json.dumps({'buildId': build_id}))
                (tree / 'manifest.json').write_text(json.dumps({
                    'buildId': build_id, 'source': {'commit': 'e' * 40},
                }))
                for name in ('remotekit_control.exe', 'remotekit_node.exe'):
                    (tree / 'bin' / name).write_bytes(b'bootstrap')
                older_url = 'https://github.com/owner/repo/releases/download/older/control.manifest'
                previous = {'buildId': 'c' * 64, 'payload': {
                    'size': 4, 'sha256': hashlib.sha256(b'base').hexdigest(),
                }, 'patch': {'from': 'd' * 64, 'manifest': older_url, 'asset': {'size': 30}}}
                older = {'buildId': 'd' * 64, 'full': {'size': full_size}}
                args = argparse.Namespace(package=tree, cache=root / 'cache', key=root / 'key',
                                          tool=root / 'tool', repo='owner/repo', full=False, dry_run=True)
                packed_full_flags = []

                def gh(*arguments):
                    if arguments[0] == 'api' and arguments[1].startswith('repos/owner/repo/commits/'):
                        return '{}'
                    if arguments[:2] == ('api', 'repos/owner/repo/releases/latest'):
                        return json.dumps({'tag_name': 'previous'})
                    if arguments[:3] == ('api', '--paginate', '--slurp'):
                        return '[[]]'
                    self.fail('Unexpected GitHub write: ' + str(arguments))

                def invoke(command, **options):
                    if command == 'fetch':
                        options['out'].write_bytes(b'base')
                        return {}
                    self.assertEqual(command, 'pack')
                    self.assertEqual(options['base_build'], previous['buildId'])
                    packed_full_flags.append(bool(options.get('full')))
                    options['out'].mkdir()
                    uploads = []
                    for name, size in [('control-patch.000', 76), ('control-patch.001', 96),
                                       ('control.manifest', 10)]:
                        (options['out'] / name).write_bytes(b'x' * size)
                        uploads.append({'name': name, 'size': size})
                    (options['out'] / 'upload.json').write_text(json.dumps(uploads))
                    return {}

                with patch.object(publisher, 'gh', side_effect=gh), \
                     patch.object(publisher.Publisher, 'inspect', side_effect=
                                  lambda url: older if url == older_url else previous), \
                     patch.object(publisher.Publisher, 'invoke', side_effect=invoke), \
                     redirect_stdout(io.StringIO()):
                    publisher.Publisher(args).run()
                self.assertEqual(packed_full_flags, [False, True] if expect_full else [False])


if __name__ == '__main__':
    unittest.main()
