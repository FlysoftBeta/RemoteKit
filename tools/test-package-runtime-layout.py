#!/usr/bin/env python3
"""CPU-only package layout checks; no Browser/Endpoint runtime required."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('package_runtime', Path(__file__).with_name('package-runtime.py'))
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)

class EndpointLayout(unittest.TestCase):
    def test_override_paths_are_copied_to_launchable_standard_names(self):
        for streaming, standard in [(True, 'endpoint_service.exe'), (False, 'endpoint_client.exe')]:
            for name in [standard, 'custom service.exe']:
                with self.subTest(streaming=streaming, source=name), tempfile.TemporaryDirectory(prefix='rk package ') as root:
                    root = Path(root)
                    source = root / 'input with spaces' / name
                    source.parent.mkdir()
                    source.write_bytes(b'endpoint fixture bytes')
                    binary = root / 'package' / 'bin'
                    binary.mkdir(parents=True)
                    result = packager.copy_endpoint(source, binary, streaming)
                    # Check the real layout consumed by run.cmd/run-control.cjs,
                    # including copied bytes and absence of the override basename.
                    expected = binary / standard
                    self.assertEqual(result, expected)
                    self.assertEqual(expected.read_bytes(), source.read_bytes())
                    self.assertEqual(list(binary.iterdir()), [expected])

    def test_startup_failure_preserves_structured_unicode_evidence(self):
        # Exercise the production parent/child path without starting services.
        # The inherited legacy encoding used to hide the real smoke failure.
        with tempfile.TemporaryDirectory(prefix='rk package ') as temporary:
            root = Path(temporary)
            missing = root / '缺少运行包'
            with patch.dict(os.environ, {'PYTHONIOENCODING': 'cp936', 'PYTHONUTF8': '0'}):
                with self.assertRaises(RuntimeError) as caught:
                    packager.run_startup_smoke(missing, work_dir=root / 'evidence')
            message = str(caught.exception)
            self.assertIn('"passed": false', message)
            self.assertIn('缺少运行包', message)
            self.assertIn('bin/node.exe', message)
            result = next((root / 'evidence').glob('*/result.json'))
            self.assertIn('缺少运行包', result.read_text(encoding='utf-8'))

    def test_face_runtime_copies_only_catalogued_package_paths(self):
        with tempfile.TemporaryDirectory(prefix='rk package ') as temporary:
            root = Path(temporary)
            cache = root / 'asset-cache'
            package = root / 'package'
            cache.mkdir()
            destinations = [
                Path('bin/face-models/recognition.onnx'),
                Path('bin/face-models/provenance.json'),
                Path('licenses/OpenCV-LICENSE.txt'),
            ]
            files = []
            for relative in destinations:
                source = cache / relative.name
                source.write_bytes(relative.as_posix().encode('ascii'))
                files.append((source, relative))
            (cache / 'unrelated.sqlite').touch()
            packager.copy_face_runtime(files, package)
            self.assertEqual({path.relative_to(package) for path in package.rglob('*') if path.is_file()},
                             set(destinations))
            for source, relative in files:
                self.assertEqual((package / relative).read_bytes(), source.read_bytes())
            with self.assertRaisesRegex(RuntimeError, 'collides with a runtime file'):
                packager.copy_face_runtime(files, package)

if __name__ == '__main__':
    unittest.main()
