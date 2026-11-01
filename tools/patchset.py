#!/usr/bin/env python3
"""Manage the repository's ordered Chromium patch series."""
import argparse
import hashlib
import json
import re
import shutil
import tempfile
from pathlib import Path
import subprocess
import sys

REPO_ROOT = Path(__file__).resolve().parents[1]
MANIFEST = REPO_ROOT / "patches" / "manifest.json"


class PatchError(Exception):
    pass


def load_manifest():
    try:
        data = json.loads(MANIFEST.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or data.get("schema_version") != 1:
            raise PatchError("manifest schema_version must be 1")
        if "base_revision" in data and not isinstance(data["base_revision"], str):
            raise PatchError("base_revision must be a string")
        entries = data.get("patches")
        if not isinstance(entries, list):
            raise PatchError("manifest patches must be an array")
        ids = set()
        result = []
        for entry in entries:
            if not isinstance(entry, dict):
                raise PatchError("each patch must be an object")
            ident, name, digest = (entry.get(k) for k in ("id", "path", "sha256"))
            if not isinstance(ident, str) or not ident or ident in ids:
                raise PatchError(f"invalid or duplicate patch id: {ident!r}")
            ids.add(ident)
            if not isinstance(name, str) or not name or Path(name).is_absolute():
                raise PatchError(f"invalid patch path for {ident}")
            # Reject Windows absolute paths even on non-Windows hosts.
            from pathlib import PureWindowsPath
            if PureWindowsPath(name).is_absolute() or PureWindowsPath(name).root or PureWindowsPath(name).drive or ".." in PureWindowsPath(name).parts:
                raise PatchError(f"invalid patch path for {ident}")
            path = (MANIFEST.parent / name).resolve()
            if not path.is_relative_to(MANIFEST.parent.resolve()):
                raise PatchError(f"patch path escapes patches directory: {name}")
            if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
                raise PatchError(f"invalid sha256 for {ident}")
            if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                raise PatchError(f"sha256 mismatch for {ident}")
            result.append((ident, path))
        return result
    except (OSError, ValueError) as exc:
        raise PatchError(f"cannot read manifest or patch: {exc}") from exc


def git_apply(root, path, reverse=False, check=False):
    cmd = ["git", "apply"]
    if reverse:
        cmd.append("--reverse")
    if check:
        cmd.append("--check")
    cmd.extend(["--", str(path)])
    return subprocess.run(cmd, cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def classify(root, path):
    forward = git_apply(root, path, check=True).returncode == 0
    reverse = git_apply(root, path, reverse=True, check=True).returncode == 0
    if forward and not reverse:
        return "pending"
    if reverse and not forward:
        return "applied"
    return "conflict"


def series_states(root, patches):
    """Validate overlapping patches in order without touching the real tree.

    Later deltas may depend on earlier patches and prevent their standalone
    reverse check. Peel applied deltas in reverse, then replay the entire series
    in order. Only patch-owned files are copied; unrelated local files stay put.
    """
    names = set()
    for ident, patch in patches:
        result = subprocess.run(["git", "apply", "--numstat", "-z", "--", str(patch)],
                                cwd=root, capture_output=True, check=True)
        for record in result.stdout.decode("utf-8").split("\0"):
            if not record:
                continue
            name = record.split("\t", 2)[2]
            from pathlib import PureWindowsPath
            path = PureWindowsPath(name)
            if not name or path.is_absolute() or path.root or path.drive or ".." in path.parts or ".git" in path.parts:
                raise PatchError("unsafe patch file path: " + name)
            names.add(name)
    # Preserve repository text/EOL rules when copying Windows working files.
    attributes = {".gitattributes"}
    for name in names:
        attributes.update(str(parent / ".gitattributes")
                          for parent in Path(name).parents if str(parent) != ".")
    names.update(attributes)
    with tempfile.TemporaryDirectory(prefix="remotekit-patchset-") as directory:
        snapshot = Path(directory)
        subprocess.run(["git", "init", "-q", str(snapshot)], check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for name in names:
            source = root / name
            if source.is_file():
                target = snapshot / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
        applied = set()
        for ident, patch in reversed(patches):
            if git_apply(snapshot, patch, reverse=True, check=True).returncode == 0:
                result = git_apply(snapshot, patch, reverse=True)
                if result.returncode:
                    raise PatchError("snapshot reverse failed for " + ident)
                applied.add(ident)
        for ident, patch in patches:
            result = git_apply(snapshot, patch)
            if result.returncode:
                raise PatchError("conflicting patch " + ident + ": " + result.stderr.strip())
        return [(ident, patch, "applied" if ident in applied else "pending")
                for ident, patch in patches]


def record_patch(root, patches, ident, files):
    """Record HEAD-relative edits only for paths absent from earlier patches."""
    if not ident or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", ident):
        raise PatchError("record requires a lowercase --id (letters, digits, hyphens)")
    if any(old_id == ident for old_id, _ in patches):
        raise PatchError("duplicate patch id: " + ident)
    if not files:
        raise PatchError("record requires explicit --file paths")
    owned = set()
    for _, patch in patches:
        result = subprocess.run(["git", "apply", "--numstat", "-z", "--", str(patch)],
                                cwd=root, text=True, capture_output=True, check=True)
        owned.update(line.split("\t", 2)[2] for line in result.stdout.split("\0") if line)
    selected = []
    for name in files:
        from pathlib import PureWindowsPath
        if Path(name).is_absolute() or PureWindowsPath(name).root or PureWindowsPath(name).drive or ".." in PureWindowsPath(name).parts:
            raise PatchError("record file must be relative to Chromium: " + name)
        resolved = (root / name).resolve(strict=True)
        if not resolved.is_relative_to(root) or not resolved.is_file():
            raise PatchError("record file escapes Chromium or is not a file: " + name)
        relative = resolved.relative_to(root).as_posix()
        if relative in owned:
            raise PatchError("record cannot append a HEAD diff for an already patched file: " + relative)
        tracked = subprocess.run(["git", "--literal-pathspecs", "ls-files", "--error-unmatch", "--", relative],
                                 cwd=root, capture_output=True)
        if tracked.returncode:
            raise PatchError("record requires a tracked file: " + relative)
        selected.append(relative)
    result = subprocess.run(["git", "--literal-pathspecs", "diff", "HEAD", "--binary", "--", *selected],
                            cwd=root, capture_output=True, check=True)
    if not result.stdout:
        raise PatchError("selected files have no changes")
    name = f"{len(patches) + 1:04d}-{ident}.patch"
    path = MANIFEST.parent / name
    if path.exists():
        raise PatchError("refusing to overwrite patch: " + name)
    path.write_bytes(result.stdout)
    try:
        if classify(root, path) != "applied":
            raise PatchError("recorded patch cannot be reversed from current files")
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        manifest["patches"].append({"id": ident, "path": name,
                                    "sha256": hashlib.sha256(result.stdout).hexdigest()})
        temporary = MANIFEST.with_suffix(".json.tmp")
        try:
            temporary.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
            temporary.replace(MANIFEST)
        finally:
            temporary.unlink(missing_ok=True)
    except Exception:
        path.unlink()
        raise
    print(f"{ident}: recorded {name}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chromium-root", required=True, type=Path, help="path to Chromium git worktree")
    parser.add_argument("command", choices=("status", "apply", "revert", "record"))
    parser.add_argument("--id", help="new patch id for record")
    parser.add_argument("--file", action="append", help="tracked Chromium path for record; repeat")
    args = parser.parse_args(argv)
    try:
        root = args.chromium_root.resolve(strict=True)
        probe = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=root,
                               text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if probe.returncode or Path(probe.stdout.strip()).resolve() != root:
            raise PatchError("chromium root must be the root of a Git worktree")
        patches = load_manifest()
        if args.command == "record":
            record_patch(root, patches, args.id, args.file)
            return 0
        states = series_states(root, patches)
        if args.command == "status":
            for ident, _, state in states:
                print(f"{ident}: {state}")
            return int(any(state == "conflict" for _, _, state in states))
        conflicts = [ident for ident, _, state in states if state == "conflict"]
        if conflicts:
            raise PatchError("conflicting patches: " + ", ".join(conflicts))
        reverse = args.command == "revert"
        selected = [(ident, path) for ident, path, state in states
                    if state == ("applied" if reverse else "pending")]
        if reverse:
            selected.reverse()
        # series_states already validated the ordered operation in isolation.
        done = []
        for ident, path in selected:
            result = git_apply(root, path, reverse=reverse)
            if result.returncode:
                failures = []
                for old_id, old_path in reversed(done):
                    rollback = git_apply(root, old_path, reverse=not reverse)
                    if rollback.returncode:
                        failures.append(f"{old_id}: {rollback.stderr.strip()}")
                detail = f"; rollback failed: {'; '.join(failures)}" if failures else ""
                raise PatchError(f"{args.command} failed for {ident}: {result.stderr.strip()}{detail}")
            done.append((ident, path))
            print(f"{ident}: {'reverted' if reverse else 'applied'}")
        return 0
    except (PatchError, OSError, subprocess.CalledProcessError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
