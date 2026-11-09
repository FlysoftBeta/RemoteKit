import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
from release_payload import write_payload

SCRATCH = TOOLS.parent / 'develop/tmp'
SCRATCH.mkdir(parents=True, exist_ok=True)


class PayloadTests(unittest.TestCase):
    def test_bytes_ignore_creation_order_mtimes_and_permissions(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temporary:
            root = Path(temporary)
            names = ['z.txt', 'node/bin/runtime.exe', 'empty', '\u6587\u4ef6/' + 'a' * 110]
            payloads = []
            for index, order in enumerate((names, list(reversed(names)))):
                tree = root / str(index)
                tree.mkdir()
                for name in order:
                    file = tree / name
                    if name == 'empty':
                        file.mkdir()
                    else:
                        file.parent.mkdir(parents=True, exist_ok=True)
                        file.write_bytes(name.encode('utf-8'))
                for file in tree.rglob('*'):
                    os.utime(file, (123456 + index, 123456 + index))
                    file.chmod(0o755 if index == 0 else 0o644)
                output = root / f'{index}.tar'
                metadata = write_payload(tree, output)
                self.assertEqual(metadata['size'], output.stat().st_size)
                payloads.append(output.read_bytes())
            self.assertEqual(payloads[0], payloads[1])
            with tarfile.open(root / '0.tar') as archive:
                entries = archive.getmembers()
                self.assertEqual([entry.name for entry in entries], sorted(entry.name for entry in entries))
                self.assertIn('empty', archive.getnames())
                for entry in entries:
                    self.assertTrue(entry.isdir() or entry.isfile())
                    self.assertEqual((entry.mtime, entry.uid, entry.gid, entry.uname, entry.gname),
                                     (0, 0, 0, '', ''))
                    self.assertEqual(entry.mode, 0o755 if entry.isdir() else 0o644)
            original_time = (root / '0.tar').stat().st_mtime_ns
            write_payload(root / '0', root / '0.tar')
            self.assertEqual((root / '0.tar').stat().st_mtime_ns, original_time)

    def test_reserved_paths_are_rejected(self):
        for name in ('release', 'payload.tar', 'payload.json'):
            with self.subTest(name=name), tempfile.TemporaryDirectory(dir=SCRATCH) as temporary:
                root = Path(temporary)
                tree = root / 'tree'
                tree.mkdir()
                (tree / name).write_bytes(b'reserved')
                with self.assertRaisesRegex(ValueError, 'Reserved payload path'):
                    write_payload(tree, root / 'payload.tar')

    def test_links_are_rejected(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temporary:
            root = Path(temporary)
            tree = root / 'tree'
            tree.mkdir()
            (tree / 'file').write_bytes(b'data')
            with patch.object(Path, 'is_symlink', return_value=True):
                with self.assertRaisesRegex(ValueError, 'non-regular'):
                    write_payload(tree, root / 'payload.tar')


if __name__ == '__main__':
    unittest.main()
