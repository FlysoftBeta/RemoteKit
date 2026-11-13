#!/usr/bin/env python3
"""Fetch pinned, hash-verified endpoint hardware/media build dependencies."""
from pathlib import Path
import zipfile
import tarfile
import json
import tempfile
from fetch_common import digest, download
ROOT = Path(__file__).resolve().parents[1]
DEPENDENCIES = [
 ('sqlite-amalgamation-3540100.zip','https://sqlite.org/2026/sqlite-amalgamation-3540100.zip','0a9c8e34352dad46006aa82836d5383bff9dc6bc9ce5a60553c05aa30e6ad1f9'),
 ('zstd-1.5.7.tar.gz','https://github.com/facebook/zstd/releases/download/v1.5.7/zstd-1.5.7.tar.gz','eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3'),
 ('json-LICENSE.MIT','https://raw.githubusercontent.com/nlohmann/json/v3.12.0/LICENSE.MIT','46a65cffd1ea955132d95a8dd921640714a8d6b537d2e4e482d31145ae95b603'),
 ('json.hpp','https://raw.githubusercontent.com/nlohmann/json/v3.12.0/single_include/nlohmann/json.hpp','aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63'),
 ('libvpl-v2.17.0.zip','https://github.com/intel/libvpl/archive/refs/tags/v2.17.0.zip','980d9f3f1dbecc7cbc28b0ff0c0647f925cbaf72844c85515b69b89e9603c35d'),
 ('nvEncodeAPI.h','https://raw.githubusercontent.com/FFmpeg/nv-codec-headers/n13.0.19.0/include/ffnvcodec/nvEncodeAPI.h','4fe4094541ef0f8a13249d97a8692dc5f835a6e9dd42eeadb3e2f7321d54dc7e'),
]
def extract_dependency(archive_path, destination, name, expected):
    target = destination / name
    marker = target / ".remotekit-media-dependency.json"
    if marker.is_file():
        metadata = json.loads(marker.read_text(encoding="utf-8"))
        files = {path.relative_to(target).as_posix(): digest(path)
                 for path in target.rglob("*") if path.is_file() and path != marker}
        if metadata == {"archiveSha256": expected, "files": files}:
            return
    with tempfile.TemporaryDirectory(prefix=name + ".stage-", dir=destination) as temporary:
        staging = Path(temporary)
        if archive_path.suffix == ".zip":
            with zipfile.ZipFile(archive_path) as archive:
                for member in archive.infolist():
                    if (not (staging / member.filename).resolve().is_relative_to(staging.resolve())
                            or "\\" in member.filename
                            or (member.external_attr >> 16) & 0o170000 == 0o120000):
                        raise RuntimeError("Unsafe dependency archive entry")
                archive.extractall(staging)
        else:
            with tarfile.open(archive_path) as archive:
                archive.extractall(staging, filter="data")
        source = staging / name
        files = {path.relative_to(source).as_posix(): digest(path)
                 for path in source.rglob("*") if path.is_file()}
        required = {
            "sqlite-amalgamation-3540100": ("sqlite3.c", "sqlite3.h"),
            "libvpl-2.17.0": ("CMakeLists.txt", "api/vpl/mfxvideo.h", "LICENSE"),
            "zstd-1.5.7": ("lib/zstd.h", "build/cmake/CMakeLists.txt", "LICENSE"),
        }[name]
        if not all(file in files for file in required):
            raise RuntimeError("Incomplete dependency archive: " + name)
        (source / marker.name).write_text(json.dumps({"archiveSha256": expected, "files": files}), encoding="utf-8")
        backup = staging / "previous"
        if target.exists():
            target.rename(backup)
        try:
            source.rename(target)
        except BaseException:
            if backup.exists():
                backup.rename(target)
            raise


def main():
    destination = ROOT / "build/dependencies"
    destination.mkdir(parents=True, exist_ok=True)
    trees = {"sqlite-amalgamation-3540100.zip": "sqlite-amalgamation-3540100",
             "libvpl-v2.17.0.zip": "libvpl-2.17.0", "zstd-1.5.7.tar.gz": "zstd-1.5.7"}
    for name, url, expected in DEPENDENCIES:
        path = destination / name
        download(url, path, expected)
        if name in trees:
            extract_dependency(path, destination, trees[name], expected)
    print("Endpoint dependencies verified: SQLite 3.54.1, libvpl 2.17.0, JSON 3.12.0, NVENC API 13.0, zstd 1.5.7")


if __name__ == "__main__":
    main()
