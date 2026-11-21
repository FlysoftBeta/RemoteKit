#!/usr/bin/env python3
"""Fetch the pinned pdf.js modern viewer the Browser serves for PDF document views.

pdf.js 6.5.438 (mozilla/pdf.js release v6.5.438, `pdfjs-6.5.438-dist.zip`, the modern
build; its SHA-256 matches the digest GitHub publishes for the release asset). The tree is
pruned to what the embedded viewer uses (no source maps, debugger, sample PDF, no-wasm
fallbacks, or locales other than the product's zh-CN and en-US), and the viewer page gets
`remotekit.css`, which hides the controls that would leave the isolated view (open file,
download, print, annotation editors, presentation mode, bookmark link).

The verified tree is copied next to the Browser executable as `pdfjs/` by
`tools/chromium.py build`, and into the runtime package by `tools/package-runtime.py`.
Run with C:\\src\\depot_tools\\python3.bat.
"""

import argparse
import json
from pathlib import Path
import shutil
import tempfile
import zipfile

from fetch_common import digest, download

ROOT = Path(__file__).resolve().parents[1]
DEPS = ROOT / "build/dependencies/pdfjs"
CACHE = DEPS / "cache"
VERSION = "6.5.438"
ARCHIVE = f"pdfjs-{VERSION}-dist.zip"
URL = f"https://github.com/mozilla/pdf.js/releases/download/v{VERSION}/{ARCHIVE}"
SHA256 = "fcbe9ba21d9911843e3502adc178a7f549a524a4055f887bedc942e5490c6ba1"
# Bump when the pruning or patching below changes so an installed tree is rebuilt.
REVISION = 1
KEEP_LOCALES = ("en-US", "zh-CN")
REMOVE = (
    "build/*.map",
    "web/*.map",
    "web/debugger.*",
    "web/compressed.tracemonkey-pldi-09.pdf",
    "web/wasm/*_nowasm_fallback.js",
)
VIEWER_STYLE = ROOT / "tools/pdfjs-viewer.css"
MARKER = ".remotekit-pdfjs-dependency.json"
REQUIRED = (
    "LICENSE",
    "build/pdf.mjs",
    "build/pdf.worker.mjs",
    "web/viewer.html",
    "web/viewer.mjs",
    "web/viewer.css",
    "web/remotekit.css",
    "web/locale/locale.json",
)
STYLE_ANCHOR = '<link rel="stylesheet" href="viewer.css" />'


def extract_zip(path, destination):
    root = destination.resolve()
    with zipfile.ZipFile(path) as archive:
        for member in archive.infolist():
            target = (destination / member.filename).resolve()
            if not target.is_relative_to(root) or "\\" in member.filename:
                raise RuntimeError("Unsafe pdf.js archive entry")
            if (member.external_attr >> 16) & 0o170000 == 0o120000:
                raise RuntimeError("pdf.js archive contains a symlink")
        archive.extractall(destination)


def prune(source):
    for pattern in REMOVE:
        for path in sorted(source.glob(pattern)):
            path.unlink()
    locales = source / "web/locale"
    for path in sorted(locales.iterdir()):
        if path.is_dir() and path.name not in KEEP_LOCALES:
            shutil.rmtree(path)
    # locale.json maps every shipped language; list only the ones kept.
    (locales / "locale.json").write_text(
        json.dumps({name: f"{name}/viewer.ftl" for name in KEEP_LOCALES}, separators=(",", ":")),
        encoding="utf-8")


def patch_viewer(source):
    page = source / "web/viewer.html"
    text = page.read_text(encoding="utf-8")
    if text.count(STYLE_ANCHOR) != 1:
        raise RuntimeError("pdf.js viewer.html no longer has the expected stylesheet anchor")
    page.write_text(
        text.replace(STYLE_ANCHOR, STYLE_ANCHOR + '\n    <link rel="stylesheet" href="remotekit.css" />'),
        encoding="utf-8")
    shutil.copy2(VIEWER_STYLE, source / "web/remotekit.css")


def tree_files(path):
    return {file.relative_to(path).as_posix() for file in path.rglob("*") if file.is_file()}


def valid_tree(path):
    marker = path / MARKER
    if not marker.is_file():
        return False
    metadata = json.loads(marker.read_text(encoding="utf-8"))
    if (metadata.get("archiveSha256") != SHA256 or metadata.get("revision") != REVISION
            or metadata.get("styleSha256") != digest(VIEWER_STYLE)):
        return False
    if tree_files(path) != set(metadata["files"]) | {MARKER}:
        return False
    return all((path / file).is_file() and digest(path / file) == expected
               for file, expected in metadata["files"].items())


def publish(source):
    source = source.resolve()
    target = (DEPS / "pdfjs").resolve()
    backup = (DEPS / "pdfjs.previous").resolve()
    if not all(path != DEPS.resolve() and path.is_relative_to(DEPS.resolve())
               for path in (source, target, backup)):
        raise RuntimeError("pdf.js replacement escapes its dependency directory")
    missing = [name for name in REQUIRED if not (source / name).is_file()]
    if missing:
        raise RuntimeError("Incomplete pdf.js tree: " + ", ".join(missing))
    metadata = {
        "version": VERSION,
        "revision": REVISION,
        "archiveSha256": SHA256,
        "styleSha256": digest(VIEWER_STYLE),
        "files": {file.relative_to(source).as_posix(): digest(file)
                  for file in sorted(source.rglob("*")) if file.is_file()},
    }
    (source / MARKER).write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    if backup.exists():
        shutil.rmtree(backup)
    if target.exists():
        target.replace(backup)
    try:
        source.replace(target)
    except BaseException:
        if backup.exists():
            backup.replace(target)
        raise
    if backup.exists():
        shutil.rmtree(backup)


def install():
    if valid_tree(DEPS / "pdfjs"):
        return
    archive = CACHE / ARCHIVE
    download(URL, archive, SHA256)
    with tempfile.TemporaryDirectory(prefix="pdfjs-", dir=DEPS) as temporary:
        source = Path(temporary) / "pdfjs"
        extract_zip(archive, source)
        prune(source)
        patch_viewer(source)
        publish(source)


def runtime_tree():
    """Return the fully verified pdf.js tree and its runtime-relative location."""
    tree = DEPS / "pdfjs"
    if not valid_tree(tree):
        raise RuntimeError("Run tools/fetch-pdfjs.py: missing or changed pdf.js")
    return tree, Path("pdfjs")


def install_runtime(output):
    """Copy the verified tree to `<output>/pdfjs` unless it is already identical."""
    source, relative = runtime_tree()
    target = Path(output) / relative
    if target.is_dir() and valid_tree(target):
        return target
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="verify the installed tree offline")
    parser.add_argument("--install", type=Path, metavar="DIR",
                        help="also copy the tree to DIR/pdfjs (a Browser output directory)")
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    if not args.verify:
        install()
    source, _ = runtime_tree()
    size = sum(file.stat().st_size for file in source.rglob("*") if file.is_file())
    print(f"Verified pdf.js {VERSION}: {size} bytes ({size / 1048576:.1f} MiB)")
    if args.install:
        print("Installed", install_runtime(args.install))


if __name__ == "__main__":
    main()
