"""Generate PAX archives with Python's package writer, including rejection cases."""
import io
import json
from pathlib import Path
import sys
import tarfile


def file_entry(archive, path, data):
    entry = tarfile.TarInfo(path)
    entry.size = len(data)
    archive.addfile(entry, io.BytesIO(data))


def fixtures(destination):
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(destination / "valid.tar", "w", format=tarfile.PAX_FORMAT) as archive:
        directory = tarfile.TarInfo("node/")
        directory.type = tarfile.DIRTYPE
        archive.addfile(directory)
        file_entry(archive, "node/build.json", b'{"buildId":"' + b"a" * 64 + b'"}')
        file_entry(archive, "node/" + "long/" * 45 + "\u4f60\u597d.txt", b"PAX UTF-8 path")
        file_entry(archive, "node/data.bin", bytes(range(256)) * 1024)
        sized = tarfile.TarInfo("node/sized.txt")
        sized.size = 3
        sized.pax_headers = {"size": "3"}
        archive.addfile(sized, io.BytesIO(b"pax"))
    cases = {
        "symlink": ("node/link", tarfile.SYMTYPE),
        "hardlink": ("node/link", tarfile.LNKTYPE),
        "character": ("node/device", tarfile.CHRTYPE),
        "block": ("node/device", tarfile.BLKTYPE),
        "fifo": ("node/fifo", tarfile.FIFOTYPE),
        "contiguous": ("node/file", tarfile.CONTTYPE),
        "unknown-type": ("node/unknown", b"Z"),
        "global-pax": ("global", tarfile.XGLTYPE),
        "absolute": ("/node/escape", tarfile.REGTYPE),
        "drive": ("C:/node/escape", tarfile.REGTYPE),
        "traversal": ("node/../escape", tarfile.REGTYPE),
        "pax-traversal": ("node/" + "long/" * 25 + "../../escape", tarfile.REGTYPE),
        "outside": ("other/file", tarfile.REGTYPE),
        "prefix": ("node-other/file", tarfile.REGTYPE),
        "backslash": ("node/..\\escape", tarfile.REGTYPE),
        "stream": ("node/file:stream", tarfile.REGTYPE),
        "reserved": ("node/NUL.txt", tarfile.REGTYPE),
        "trailing-dot": ("node/directory./file", tarfile.REGTYPE),
    }
    for name, (path, kind) in cases.items():
        with tarfile.open(destination / (name + ".tar"), "w", format=tarfile.PAX_FORMAT) as archive:
            entry = tarfile.TarInfo(path)
            entry.type = kind
            entry.linkname = "node/target" if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else ""
            archive.addfile(entry)
    corrupt = bytearray((destination / "valid.tar").read_bytes())
    corrupt[0] ^= 1
    (destination / "checksum.tar").write_bytes(corrupt)
    (destination / "truncated.tar").write_bytes((destination / "valid.tar").read_bytes()[:600])
    (destination / "rejects.json").write_text(json.dumps(list(cases) + ["checksum", "truncated"]))


def node_archive(destination, build_id, dummy, updater):
    with tarfile.open(destination, "w", format=tarfile.PAX_FORMAT) as archive:
        file_entry(archive, "node/build.json", json.dumps({"buildId": build_id}).encode())
        archive.add(dummy, arcname="node/bin/endpoint_service.exe", recursive=False)
        archive.add(updater, arcname="node/bin/remotekit_node.exe", recursive=False)
        file_entry(archive, "node/bin/" + "long/" * 30 + "asset.txt", b"node archive PAX fixture")


if __name__ == "__main__":
    if sys.argv[1] == "node":
        node_archive(Path(sys.argv[2]), *sys.argv[3:])
    else:
        fixtures(Path(sys.argv[1]))
