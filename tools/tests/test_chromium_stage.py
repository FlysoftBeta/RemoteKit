#!/usr/bin/env python3
"""CPU-only regression tests for the production overlay copy helper."""
import os
from pathlib import Path
import stat
import tempfile
import time
import unittest

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import chromium


class StageCopyTest(unittest.TestCase):
    def test_changed_old_source_rebuilds_and_unchanged_is_untouched(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'source' / 'helper.h'
            target = root / 'overlay' / 'nested' / 'helper.h'
            obj = root / 'helper.obj'
            source.parent.mkdir()
            source.write_bytes(b'old')
            self.assertTrue(chromium.copy_if_changed(source, target))
            obj.write_bytes(b'object')

            now = time.time()
            old_time = now - 30
            object_time = now - 10
            os.utime(target, (old_time, old_time))
            os.utime(obj, (object_time, object_time))
            source.write_bytes(b'new')
            os.chmod(source, 0o600)
            os.utime(source, (old_time, old_time))

            self.assertTrue(chromium.copy_if_changed(source, target))
            self.assertEqual(target.read_bytes(), b'new')
            self.assertGreater(target.stat().st_mtime_ns, obj.stat().st_mtime_ns)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode),
                             stat.S_IMODE(source.stat().st_mode))
            copied_time = target.stat().st_mtime_ns
            self.assertFalse(chromium.copy_if_changed(source, target))
            self.assertEqual(target.stat().st_mtime_ns, copied_time)


if __name__ == '__main__':
    unittest.main()
