import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("patchset", Path(__file__).resolve().parents[1] / "patchset.py")
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
        patchset.MANIFEST.write_text(json.dumps({"schema_version": 1, "base_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.root, text=True).strip(), "patches": entries}), encoding="utf-8")

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

    def test_dependent_delta_roundtrip_and_partial_state(self):
        self.assertEqual(self.run_tool("apply")[0], 0)
        self.git("add", "file.txt")
        self.git("commit", "-qm", "first patch baseline")
        (self.root / "file.txt").write_text("second change\n", encoding="utf-8")
        delta = subprocess.check_output(["git", "diff", "--binary"], cwd=self.root)
        (self.patches / "two.patch").write_bytes(delta)
        self.manifest([self.entry, {"id": "two", "path": "two.patch",
                                   "sha256": hashlib.sha256(delta).hexdigest()}])
        # Full state cannot classify patch one by an independent reverse check.
        self.assertEqual(self.run_tool("status")[0], 0)
        self.assertEqual(self.run_tool("revert")[0], 0)
        self.assertEqual((self.root / "file.txt").read_text(), "original\n")
        self.assertIn("two: pending", self.run_tool("status")[1])
        self.assertEqual(self.run_tool("apply")[0], 0)
        self.assertEqual((self.root / "file.txt").read_text(), "second change\n")
        self.git("apply", "--reverse", str(self.patches / "two.patch"))
        status = self.run_tool("status")
        self.assertEqual(status[0], 0)
        self.assertIn("one: applied", status[1])
        self.assertIn("two: pending", status[1])
        self.assertEqual(self.run_tool("apply")[0], 0)
        (self.root / "file.txt").write_text("local conflict\n", encoding="utf-8")
        self.assertEqual(self.run_tool("apply")[0], 1)
        self.assertEqual((self.root / "file.txt").read_text(), "local conflict\n")

    def test_snapshot_preserves_git_text_attributes(self):
        (self.root / ".gitattributes").write_bytes(b"*.cc text eol=lf\n")
        source = self.root / "eol.cc"
        source.write_bytes(b"original\n")
        self.git("add", ".gitattributes", "eol.cc")
        self.git("commit", "-qm", "text attributes")
        source.write_bytes(b"changed\r\n")
        delta = subprocess.check_output(["git", "diff", "--binary"], cwd=self.root)
        (self.patches / "eol.patch").write_bytes(delta)
        self.manifest([{"id": "eol", "path": "eol.patch",
                        "sha256": hashlib.sha256(delta).hexdigest()}])
        self.assertIn("eol: applied", self.run_tool("status")[1])
        self.assertEqual(self.run_tool("revert")[0], 0)
        self.assertEqual(source.read_text(), "original\n")
        self.assertEqual(self.run_tool("apply")[0], 0)
        self.assertEqual(source.read_text(), "changed\n")

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

    def test_rejects_windows_rooted_paths_without_drive(self):
        from pathlib import PureWindowsPath
        for rooted in ("/foo.patch", "\\foo.patch"):
            self.manifest([{**self.entry, "path": rooted}])
            code, _, error = self.run_tool("apply")
            self.assertEqual(code, 1)
            self.assertIn("invalid patch path", error)
        self.manifest([self.entry])
        outside = Path(self.temp.name) / "outside.txt"
        outside.write_bytes(b"original\n")
        # Preserve the path root but remove its Windows drive. This used to
        # escape snapshot/name even though is_absolute() and drive were false.
        rooted = PureWindowsPath(str(outside)).as_posix()
        drive = PureWindowsPath(rooted).drive
        if drive:
            rooted = rooted[len(drive):]
        self.assertTrue(PureWindowsPath(rooted).root)
        self.assertFalse(PureWindowsPath(rooted).drive)
        diff = (self.patches / "one.patch").read_bytes()
        diff = diff.replace(b"a/file.txt", ("a/" + rooted).encode())
        diff = diff.replace(b"b/file.txt", ("b/" + rooted).encode())
        patch = self.patches / "rooted.patch"
        patch.write_bytes(diff)
        with self.assertRaisesRegex(patchset.PatchError, "unsafe patch file path"):
            patchset.series_states(self.root, [("rooted", patch)])
        self.assertEqual(outside.read_bytes(), b"original\n")
        # The same rooted form must not enter the record path resolver either.
        for rooted_record in ("/foo.cc", "\\foo.cc"):
            code, _, error = self.run_tool("record", "--id", "two", "--file", rooted_record)
            self.assertEqual(code, 1)
            self.assertIn("record file must be relative", error)

    def test_rejects_wrong_baseline_and_unknown_fields(self):
        original = json.loads(patchset.MANIFEST.read_text())
        for command in ("status", "apply", "revert"):
            patchset.MANIFEST.write_text(json.dumps({**original, "base_revision": "0" * 40}))
            code, _, error = self.run_tool(command)
            self.assertEqual(code, 1)
            self.assertIn("differs from base_revision", error)
            self.assertEqual((self.root / "file.txt").read_text(), "original\n")
        for invalid in ({**original, "schema_version": True},
                        {**original, "extra": 1},
                        {**original, "patches": [{**self.entry, "extra": 1}]}):
            patchset.MANIFEST.write_text(json.dumps(invalid))
            self.assertEqual(self.run_tool("apply")[0], 1)

    def test_empty_series(self):
        self.manifest([])
        for command in ("status", "apply", "revert"):
            self.assertEqual(self.run_tool(command)[0], 0)

    def test_record_selected_paths_roundtrip(self):
        (self.root / "new.txt").write_text("before\n", encoding="utf-8")
        self.git("add", "new.txt")
        self.git("commit", "-qm", "second file")
        self.manifest([self.entry])
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
