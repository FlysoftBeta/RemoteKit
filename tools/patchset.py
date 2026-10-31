#!/usr/bin/env python3
"""Manage the repository's ordered Chromium patch series."""
import argparse
import hashlib
import json
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
            if PureWindowsPath(name).is_absolute() or PureWindowsPath(name).drive or ".." in PureWindowsPath(name).parts:
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


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chromium-root", required=True, type=Path, help="path to Chromium git worktree")
    parser.add_argument("command", choices=("status", "apply", "revert"))
    args = parser.parse_args(argv)
    try:
        root = args.chromium_root.resolve(strict=True)
        probe = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=root,
                               text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if probe.returncode or Path(probe.stdout.strip()).resolve() != root:
            raise PatchError("chromium root must be the root of a Git worktree")
        patches = load_manifest()
        states = [(ident, path, classify(root, path)) for ident, path in patches]
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
        # Recheck the whole requested operation before making any changes.
        for ident, path in selected:
            check = git_apply(root, path, reverse=reverse, check=True)
            if check.returncode:
                raise PatchError(f"check failed for {ident}: {check.stderr.strip()}")
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
    except (PatchError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
