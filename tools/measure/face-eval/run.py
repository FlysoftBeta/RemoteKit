"""Build only face-eval; keep every measured result below the private input root.

Usage: python tools/measure/face-eval/run.py --private-root <faces-private>
All private WebP metadata and public JPEG metadata is discarded by the native executable before decoding.
No images or face vectors are persisted. LFW tar entries travel through a pipe.
"""
import argparse
import hashlib
import json
import runpy
import struct
import subprocess
import sys
import tarfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--private-root", type=Path, required=True)
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--private-only", action="store_true")
    parser.add_argument("--label", default="fa3",
                        help="Numeric output snapshot name; does not change inference")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[3]
    private = args.private_root.resolve(strict=True)
    if not (private / "img").is_dir():
        raise ValueError("private img directory required")
    output = private / "fa3-numeric" / args.label
    output.mkdir(parents=True, exist_ok=True)
    build = repo / "build/endpoint-fa3" / f"face-eval-{args.label}"
    deps = repo / "build/dependencies/face-auth"
    manifest = json.loads((repo / "tools/face-auth-deps.json").read_text())
    expected = {k: v[1] for k, v in manifest["zoo"].items() if k.endswith(".onnx")}
    expected.update(manifest["converted"])
    for name, digest in expected.items():
        with (deps / "models" / name).open("rb") as f:
            if hashlib.file_digest(f, "sha256").hexdigest() != digest:
                raise ValueError("model digest mismatch")
    if not args.skip_build:
        sys.path.insert(0, str(repo / "tools"))
        setup = runpy.run_path(str(repo / "tools/setup-face-auth.py"))
        cmake, ninja, env = setup["msvc_tools"]()
        subprocess.run([str(cmake), *setup["native_cmake_args"](build),
                        "-S", str(Path(__file__).parent), "-B", str(build),
                        "-G", "Ninja", f"-DCMAKE_MAKE_PROGRAM={ninja}",
                        "-DCMAKE_BUILD_TYPE=Release"], env=env, check=True)
        subprocess.run([str(cmake), "--build", str(build), "--parallel", "2"], env=env, check=True)
    exe = build / "face-eval.exe"
    models = deps / "models"
    lfw = repo / "develop/tmp/face-public-benchmark"
    if not (lfw / "pairs.txt").is_file() or not (lfw / "lfw.tgz").is_file():
        raise ValueError("local LFW inputs required")
    # Verify the locally available standard benchmark without downloading anything.
    for name, digest in [
        ("pairs.txt", "ea42330c62c92989f9d7c03237ed5d591365e89b3e649747777b70e692dc1592"),
        ("lfw.tgz", "055f7d9c632d7370e6fb4afc7468d40f970c34a80d4c6f50ffec63f5a8d536c0"),
    ]:
        with (lfw / name).open("rb") as f:
            if hashlib.file_digest(f, "sha256").hexdigest() != digest:
                raise ValueError("LFW digest mismatch")
    def image(identity, number):
        return f"lfw/{identity}/{identity}_{int(number):04d}.jpg"
    pairs = []
    for line in (lfw / "pairs.txt").read_text().splitlines()[1:]:
        parts = line.split()
        if len(parts) == 3:
            pairs.append((1, image(parts[0], parts[1]), image(parts[0], parts[2])))
        elif len(parts) == 4:
            pairs.append((0, image(parts[0], parts[1]), image(parts[2], parts[3])))
        else:
            raise ValueError("LFW pair format")
    names = sorted({name for _, a, b in pairs for name in (a, b)})
    ids = {name: i for i, name in enumerate(names)}
    pairfile = output / "lfw_pair_ids.txt"
    pairfile.write_text("".join(f"{same} {ids[a]} {ids[b]}\n" for same, a, b in pairs))
    command = [str(exe), str(models), str(private / "img"), str(pairfile), str(output)]
    if args.private_only:
        subprocess.run([*command, "--private-only"], check=True)
        return
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    seen = set()
    try:
        with tarfile.open(lfw / "lfw.tgz", "r|gz") as archive:
            for member in archive:
                name = member.name.removeprefix("./")
                if name not in ids:
                    continue
                if not member.isfile() or name in seen:
                    raise ValueError("LFW archive entry")
                with archive.extractfile(member) as f:
                    jpeg = f.read()
                process.stdin.write(struct.pack("<II", ids[name], len(jpeg)))
                process.stdin.write(jpeg)
                seen.add(name)
        process.stdin.close()
        if process.wait() or seen != set(names):
            raise ValueError("LFW incomplete")
    except BaseException:
        process.kill()
        process.wait()
        raise


if __name__ == "__main__":
    main()
