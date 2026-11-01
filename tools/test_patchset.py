import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("patchset", Path(__file__).with_name("patchset.py"))
patchset = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patchset)


class PatchsetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "chromium"
        self.root.mkdir()
        self.patches = Path(self.temp.name) / "patches"
        self.patches.mkdir()
        self.original_manifest = patchset.MANIFEST
        patchset.MANIFEST = self.patches / "manifest.json"
        self.addCleanup(setattr, patchset, "MANIFEST", self.original_manifest)
        self.git("init", "-q")
        self.git("config", "user.email", "test@example.com")
        self.git("config", "user.name", "Test")
        (self.root / "file.txt").write_text("original\n", encoding="utf-8")
        self.git("add", "file.txt")
        self.git("commit", "-qm", "initial")
        (self.root / "file.txt").write_text("changed\n", encoding="utf-8")
        diff = subprocess.check_output(["git", "diff", "--binary"], cwd=self.root)
        (self.root / "file.txt").write_text("original\n", encoding="utf-8")
        (self.patches / "one.patch").write_bytes(diff)
        self.entry = {"id": "one", "path": "one.patch", "sha256": hashlib.sha256(diff).hexdigest()}
        self.manifest([self.entry])

    def git(self, *args):
        subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True)

    def manifest(self, entries):
        patchset.MANIFEST.write_text(json.dumps({"schema_version": 1, "patches": entries}), encoding="utf-8")

    def run_tool(self, command, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = patchset.main(["--chromium-root", str(self.root), command, *args])
        return code, out.getvalue(), err.getvalue()

    def test_apply_revert_and_idempotency(self):
        (self.root / "untracked.txt").write_text("keep", encoding="utf-8")
        self.assertIn("pending", self.run_tool("status")[1])
        self.assertEqual(self.run_tool("apply")[0], 0)
        self.assertEqual(self.run_tool("apply")[0], 0)
        self.assertIn("applied", self.run_tool("status")[1])
        self.assertEqual((self.root / "file.txt").read_text(), "changed\n")
        self.assertEqual(self.run_tool("revert")[0], 0)
        self.assertEqual(self.run_tool("revert")[0], 0)
        self.assertEqual((self.root / "file.txt").read_text(), "original\n")
        self.assertEqual((self.root / "untracked.txt").read_text(), "keep")

    def test_conflict_does_not_modify(self):
        (self.root / "file.txt").write_text("local\n", encoding="utf-8")
        self.assertEqual(self.run_tool("status")[0], 1)
        self.assertEqual(self.run_tool("apply")[0], 1)
        self.assertEqual((self.root / "file.txt").read_text(), "local\n")

    def test_hash_and_paths_and_duplicates(self):
        for entry in ({**self.entry, "sha256": "0" * 64},
                      {**self.entry, "path": "../outside.patch"},
                      {**self.entry, "path": str((self.patches / "one.patch").resolve())}):
            self.manifest([entry])
            self.assertEqual(self.run_tool("apply")[0], 1)
        self.manifest([self.entry, self.entry])
        self.assertEqual(self.run_tool("apply")[0], 1)

    def test_empty_series(self):
        self.manifest([])
        for command in ("status", "apply", "revert"):
            self.assertEqual(self.run_tool(command)[0], 0)

    def test_record_selected_paths_roundtrip(self):
        (self.root / "new.txt").write_text("before\n", encoding="utf-8")
        self.git("add", "new.txt")
        self.git("commit", "-qm", "second file")
        self.assertEqual(self.run_tool("apply")[0], 0)
        (self.root / "new.txt").write_text("after\n", encoding="utf-8")
        self.assertEqual(self.run_tool("record", "--id", "two", "--file", "new.txt")[0], 0)
        entries = json.loads(patchset.MANIFEST.read_text())["patches"]
        self.assertEqual(entries[0], self.entry)
        self.assertEqual([entry["id"] for entry in entries], ["one", "two"])
        self.assertEqual(self.run_tool("status")[0], 0)
        self.assertEqual(self.run_tool("revert")[0], 0)
        self.assertEqual((self.root / "new.txt").read_text(), "before\n")
        self.assertEqual(self.run_tool("apply")[0], 0)
        self.assertEqual((self.root / "new.txt").read_text(), "after\n")

    def test_record_rejects_overlap_and_untracked(self):
        self.assertEqual(self.run_tool("apply")[0], 0)
        (self.root / "file.txt").write_text("second change\n", encoding="utf-8")
        before = patchset.MANIFEST.read_bytes()
        code, _, err = self.run_tool("record", "--id", "two", "--file", "file.txt")
        self.assertEqual(code, 1)
        self.assertIn("already patched", err)
        (self.root / "untracked.txt").write_text("no\n", encoding="utf-8")
        self.assertEqual(self.run_tool("record", "--id", "two", "--file", "untracked.txt")[0], 1)
        self.assertEqual(patchset.MANIFEST.read_bytes(), before)
        self.assertEqual(sorted(path.name for path in self.patches.glob("*.patch")), ["one.patch"])


if __name__ == "__main__":
    unittest.main()
