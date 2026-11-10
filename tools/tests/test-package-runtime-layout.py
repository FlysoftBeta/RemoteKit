#!/usr/bin/env python3
"""Package layout and installed-layout smoke contract checks without native runtimes."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
spec = importlib.util.spec_from_file_location('package_runtime', TOOLS / 'package-runtime.py')
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)
SCRATCH = TOOLS.parent / 'develop/tmp'
SCRATCH.mkdir(parents=True, exist_ok=True)


class EndpointLayout(unittest.TestCase):
    def test_version_tree_and_payload(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temporary:
            root = Path(temporary)
            repo = root / 'repo'
            chromium = root / 'chromium'
            output = chromium / 'out/rel'
            endpoint = repo / 'build/endpoint-package/endpoint/endpoint_service.exe'
            node = root / 'pinned/node.exe'

            def put(file, data=b'fixture'):
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(data)

            for file in ('remotekit_browser.exe', 'remotekit.pak', 'locales/zh-CN.pak',
                         'locales/en-US.pak', 'icudtl.dat', 'v8_context_snapshot.bin', 'args.gn'):
                put(output / file)
            put(chromium / 'third_party/hyphenation-patterns/LICENSE')
            put(endpoint)
            for name in ('remotekit_node.exe', 'remotekit_control.exe', 'libvpl.dll'):
                put(endpoint.parent / name)
            put(node)
            put(node.parent / 'LICENSE')
            for name in ('zstd-1.5.7/LICENSE', 'libvpl-2.17.0/LICENSE',
                         'libvpl-2.17.0/third-party-programs.txt', 'json-LICENSE.MIT'):
                put(repo / 'build/dependencies' / name)
            put(repo / 'build/dependencies/nvEncodeAPI.h', b'/* notice */')
            for name in ('server.mjs', 'recover-credentials.mjs', 'client/index.html',
                         'runtime/node_modules/native/binding.node'):
                put(repo / 'control/dist' / name)
            put(repo / 'control/dist/runtime/manifest.json',
                json.dumps({'nodeModuleAbi': '137', 'node': 'v24.20.0'}).encode())
            crt = root / 'vs/VC/Redist/MSVC/14.0/x64/Microsoft.VC143.CRT/msvcp140.dll'
            put(crt)

            def check_output(command, **kwargs):
                if command[0] == 'git':
                    return 'a' * 40
                if command[0] == str(node):
                    return json.dumps({'version': 'v24.20.0', 'abi': '137'})
                return json.dumps({command[3]: {'runtime_deps': []}})

            args = argparse.Namespace(chromium_root=chromium, out='rel', endpoint=None,
                                      destination=root / 'packages', smoke=True)
            validation = {
                key: True for key in (
                    'passed', 'endpointManagementReachable', 'webSocketProductActionRejected',
                    'workspaceUnchanged', 'faceModelsAvailable',
                )
            }
            validation.update(validationKind='startup', scope='fixture',
                              browserProductOperationsTested=False, rtcMediaTested=False,
                              endpointSha256='f' * 64)
            with patch.object(packager, 'ROOT', repo), \
                 patch.object(packager, 'check_freshness'), \
                 patch.object(packager, 'source_provenance', return_value={'commit': 'a' * 40, 'dirty': False}), \
                 patch.object(packager, 'pinned_node', return_value=node), \
                 patch.object(packager, 'imaging_runtime_files', return_value=[]), \
                 patch.object(packager, 'document_runtime_trees', return_value=[]), \
                 patch.object(packager, 'run_startup_smoke', return_value=validation) as smoke, \
                 patch.object(packager.subprocess, 'run') as install, \
                 patch.object(packager.subprocess, 'check_output', side_effect=check_output), \
                 patch.dict(os.environ, {'REMOTEKIT_VS': str(root / 'vs')}):
                result = packager.package_runtime(args, root / 'staging/node')
            tree = Path(result['directory'])
            self.assertEqual(tree.name, 'RemoteKit-control-' + result['buildId'][:12])
            self.assertEqual({file.name for file in (tree / 'bin').iterdir()},
                             {'node.exe', 'remotekit_control.exe', 'remotekit_node.exe'})
            self.assertTrue((tree / 'node/bin/msvcp140.dll').is_file())
            self.assertFalse((tree / 'release').exists())
            self.assertEqual(json.loads((tree / 'node/build.json').read_text())['buildId'], result['buildId'])
            recovery = (tree / 'recover-credentials.cmd').read_text()
            self.assertIn('%~dp0..\\..\\config\\control.json', recovery)
            manifest = json.loads((tree / 'manifest.json').read_text())
            self.assertNotIn('archive', manifest)
            self.assertEqual(manifest['buildId'], result['buildId'])
            self.assertTrue(manifest['runtime_launched'])
            self.assertEqual(manifest['runtime_validation'], validation)
            deployment = tree.parent / 'smoke-root'
            smoke.assert_called_once_with(deployment)
            self.assertEqual(install.call_args.args[0], [
                str(deployment / 'remotekit_control.exe'), 'install',
                '--root=' + str(deployment), '--payload=' + result['payload'],
            ])
            with tarfile.open(result['payload']) as payload:
                self.assertIn('node/bin/endpoint_service.exe', payload.getnames())
                self.assertEqual(payload.extractfile('manifest.json').read(), (tree / 'manifest.json').read_bytes())
            self.assertEqual(json.loads((tree.parent / 'payload.json').read_text())['sha256'], result['sha256'])
            self.assertEqual(list(tree.parent.glob('*.zst')), [])

    def test_override_endpoint_name(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temporary:
            root = Path(temporary)
            source = root / 'custom service.exe'
            source.write_bytes(b'endpoint fixture')
            binary = root / 'bin'
            binary.mkdir()
            result = packager.copy_endpoint(source, binary)
            self.assertEqual(result, binary / 'endpoint_service.exe')
            self.assertEqual(result.read_bytes(), source.read_bytes())

    def test_startup_failure_preserves_structured_unicode_evidence(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temporary:
            root = Path(temporary)
            missing = root / '\u7f3a\u5c11\u8fd0\u884c\u5305'
            with patch.dict(os.environ, {'PYTHONIOENCODING': 'cp936', 'PYTHONUTF8': '0'}):
                with self.assertRaises(RuntimeError) as caught:
                    packager.run_startup_smoke(missing, work_dir=root / 'evidence')
            self.assertIn('"passed": false', str(caught.exception))
            self.assertIn(missing.name, str(caught.exception))
            result = next((root / 'evidence').glob('*/result.json'))
            self.assertIn('current', result.read_text(encoding='utf-8'))

    def test_imaging_runtime_copies_only_catalogued_paths(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temporary:
            root = Path(temporary)
            source = root / 'model.onnx'
            source.write_bytes(b'model')
            package = root / 'package'
            files = [(source, Path('bin/models/recognition.onnx'))]
            packager.copy_imaging_runtime(files, package)
            self.assertEqual((package / files[0][1]).read_bytes(), b'model')
            with self.assertRaisesRegex(RuntimeError, 'collides with a runtime file'):
                packager.copy_imaging_runtime(files, package)


if __name__ == '__main__':
    unittest.main()
