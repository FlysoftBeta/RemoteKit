import os
import hashlib
import importlib.util
import io
import zipfile
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
from release_payload import write_payload
from fetch_common import digest, download

SCRATCH = TOOLS.parent / 'develop/tmp'
SCRATCH.mkdir(parents=True, exist_ok=True)


class FetchTests(unittest.TestCase):
    def test_streamed_download_cache_and_failure_rollback(self):
        data = b"download" * 20000
        expected = hashlib.sha256(data).hexdigest()
        class Stream(io.BytesIO):
            def read(self, size=-1):
                if size < 0:
                    raise AssertionError("unbounded read")
                return super().read(size)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temporary:
            target = Path(temporary) / "archive"
            target.write_bytes(b"old")
            with patch('fetch_common.urllib.request.urlopen', return_value=Stream(data)):
                download('https://example.test/archive', target, expected)
            self.assertEqual(digest(target), expected)
            with patch('fetch_common.urllib.request.urlopen', side_effect=AssertionError("cache miss")):
                download('https://example.test/archive', target, expected)
            for source in (Stream(b"corrupt"), Stream(data)):
                with patch('fetch_common.urllib.request.urlopen', return_value=source), \
                     self.assertRaises(RuntimeError):
                    download('https://example.test/archive', target, "0" * 64)
                self.assertEqual(target.read_bytes(), data)
                self.assertEqual([p.name for p in target.parent.iterdir()], ['archive'])
            with patch('fetch_common.shutil.copyfileobj', side_effect=OSError("interrupted")), \
                 patch('fetch_common.urllib.request.urlopen', return_value=Stream(data)), \
                 self.assertRaisesRegex(OSError, "interrupted"):
                download('https://example.test/archive', target, "0" * 64)
            self.assertEqual([p.name for p in target.parent.iterdir()], ['archive'])

    def test_media_extraction_publishes_complete_trees(self):
        spec = importlib.util.spec_from_file_location('fetch_media', TOOLS / 'fetch-media-deps.py')
        media = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(media)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temporary:
            root = Path(temporary)
            name = 'sqlite-amalgamation-3540100'
            target = root / name
            target.mkdir()
            (target / 'stale').write_bytes(b'stale')
            archive = root / 'sqlite.zip'
            with zipfile.ZipFile(archive, 'w') as output:
                output.writestr(name + '/sqlite3.c', b'c')
            with self.assertRaisesRegex(RuntimeError, 'Incomplete'):
                media.extract_dependency(archive, root, name, digest(archive))
            self.assertEqual((target / 'stale').read_bytes(), b'stale')
            with zipfile.ZipFile(archive, 'a') as output:
                output.writestr(name + '/sqlite3.h', b'h')
            media.extract_dependency(archive, root, name, digest(archive))
            self.assertFalse((target / 'stale').exists())
            (target / 'sqlite3.h').unlink()
            media.extract_dependency(archive, root, name, digest(archive))
            self.assertEqual((target / 'sqlite3.h').read_bytes(), b'h')
            with patch.object(media.zipfile.ZipFile, 'extractall', side_effect=OSError('interrupted')):
                (target / '.remotekit-media-dependency.json').unlink()
                with self.assertRaisesRegex(OSError, 'interrupted'):
                    media.extract_dependency(archive, root, name, digest(archive))
            self.assertEqual((target / 'sqlite3.h').read_bytes(), b'h')


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
