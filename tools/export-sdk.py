"""Export the GN-built Windows C ABI SDK, including its runtime dependency tree."""

import argparse
import hashlib
import json
import re
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile


def build_metadata(out, dll):
    chromium = Path(subprocess.check_output(
        ["git", "-C", str(out), "rev-parse", "--show-toplevel"],
        text=True).strip())
    revision = subprocess.check_output(
        ["git", "-C", str(chromium), "rev-parse", "HEAD"], text=True).strip()
    args_file = out / "args.gn"
    args_bytes = args_file.read_bytes()
    compiler = chromium / "third_party/llvm-build/Release+Asserts/bin/clang-cl.exe"
    compiler_version = subprocess.check_output(
        [str(compiler), "--version"], text=True).strip()
    with dll.open("rb") as image:
        if image.read(2) != b"MZ":
            raise ValueError("SDK output is not a Windows PE image")
        image.seek(0x3c)
        pe_offset = struct.unpack("<I", image.read(4))[0]
        image.seek(pe_offset)
        if image.read(4) != b"PE\0\0":
            raise ValueError("SDK output has an invalid PE signature")
        machine = struct.unpack("<H", image.read(2))[0]
    return {
        "chromium_revision": revision,
        "args_gn_sha256": hashlib.sha256(args_bytes).hexdigest(),
        "architecture": {0x8664: "x64", 0xaa64: "arm64", 0x14c: "x86"}.get(
            machine, "unknown-0x%04x" % machine),
        "compiler": {"name": "Chromium clang-cl", "version": compiler_version},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path,
                        help="Chromium GN output directory")
    parser.add_argument("--destination", required=True, type=Path)
    args = parser.parse_args()
    out = args.out.resolve()
    destination = args.destination.resolve()
    if destination == out or out in destination.parents or destination in out.parents:
        parser.error("destination must be separate from the GN output tree")
    deps_file = out / "remotekit_sdk.runtime_deps"
    dll = out / "remotekit_sdk.dll"
    import_lib = out / "remotekit_sdk.dll.lib"
    if not import_lib.is_file():
        import_lib = out / "remotekit_sdk.lib"
    required = [deps_file, dll, import_lib, out / "args.gn"]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        parser.error("build //remotekit/browser/sdk:remotekit_sdk first; missing: " +
                     ", ".join(missing))
    entries = []
    for line in deps_file.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        source = (out / line.strip()).resolve()
        try:
            relative = source.relative_to(out)
        except ValueError:
            parser.error("runtime dependency outside output directory: " + str(source))
        if not source.is_file():
            parser.error("missing runtime dependency: " + str(source))
        entries.append((source, relative))
    metadata = build_metadata(out, dll)
    component_build = any(relative.name.lower() == "base.dll"
                          for _, relative in entries)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=destination.name + ".stage-", dir=destination.parent) as temporary:
        staging = Path(temporary) / "sdk"
        # Copy only after validating the entire manifest; never silently omit a DLL.
        for source, relative in entries:
            target = staging / "bin" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        for folder in ("bin", "lib", "include"):
            (staging / folder).mkdir(parents=True, exist_ok=True)
        shutil.copy2(dll, staging / "bin" / dll.name)
        shutil.copy2(import_lib, staging / "lib" / "remotekit_sdk.lib")
        header = Path(__file__).resolve().parents[1] / "sdk/include/remotekit_sdk.h"
        shutil.copy2(header, staging / "include" / header.name)
        rtc_header = header.with_name("remotekit_rtc.h")
        shutil.copy2(rtc_header, staging / "include" / rtc_header.name)
        shared_header = header.parents[2] / "protocol/shared_render_slots.h"
        (staging / "include/protocol").mkdir(exist_ok=True)
        shutil.copy2(shared_header, staging / "include/protocol/shared_render_slots.h")
        protocol_header = header.parents[2] / "protocol/render_slots.h"
        shutil.copy2(protocol_header, staging / "include/protocol/render_slots.h")
        (staging / "manifest.json").write_text(json.dumps({
            **metadata,
            "abi_version": 2,
            "rtc_abi_version": int(re.search(r"^#define REMOTEKIT_RTC_ABI_VERSION (\d+)u?$", rtc_header.read_text(encoding="utf-8"), re.MULTILINE).group(1)),
            "public_headers": ["remotekit_sdk.h", "remotekit_rtc.h",
                               "protocol/shared_render_slots.h", "protocol/render_slots.h"],
            "gn_target": "//remotekit/browser/sdk:remotekit_sdk",
            "component_build": component_build,
            "runtime": {
                "dependency_source": "GN remotekit_sdk.runtime_deps",
                "layout": "copy the complete bin tree beside the consumer EXE",
                "pdb_policy": "include all PDBs listed by GN",
                "c_abi_only": True,
            },
            "runtime_dependencies": [str(relative) for _, relative in entries],
            "scope": "local Mojo pipe, isolated named-channel JSON control, "
                     "WebRTC PeerConnection SDP/ICE/DTLS-SRTP, DataChannel, "
                     "and external asynchronous H264 encoder over D3D11 textures",
        }, indent=2) + "\n", encoding="utf-8")
        backup = Path(temporary) / "previous"
        if destination.exists():
            destination.rename(backup)
        try:
            staging.rename(destination)
        except BaseException:
            if backup.exists():
                backup.rename(destination)
            raise
    print(destination)


if __name__ == "__main__":
    main()
