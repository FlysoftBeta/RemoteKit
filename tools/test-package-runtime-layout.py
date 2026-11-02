#!/usr/bin/env python3
"""CPU-only package layout checks; no Browser/Endpoint runtime required."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

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

if __name__ == '__main__':
    unittest.main()
