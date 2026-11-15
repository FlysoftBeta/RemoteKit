"""Hash-verified streaming dependency downloads."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
import urllib.request

LLVM_VERSION = "23.1.5"
LLVM_ARCHIVE = f"clang+llvm-{LLVM_VERSION}-x86_64-pc-windows-msvc.tar.xz"
LLVM_URL = (f"https://github.com/llvm/llvm-project/releases/download/llvmorg-{LLVM_VERSION}/"
            + LLVM_ARCHIVE.replace("+", "%2B"))
LLVM_SHA256 = "62fdada7f6fa2b73856486dfbbdba3d2c1882991621615bcb55c60207611c6d4"
LLVM_LICENSE_URL = (f"https://raw.githubusercontent.com/llvm/llvm-project/"
                    f"llvmorg-{LLVM_VERSION}/llvm/LICENSE.TXT")
LLVM_LICENSE_SHA256 = "8d85c1057d742e597985c7d4e6320b015a9139385cff4cbae06ffc0ebe89afee"
DEPENDENCIES = Path(__file__).resolve().parents[1] / "build/dependencies"
LLVM_ROOT = DEPENDENCIES / f"llvm-{LLVM_VERSION}"
LLVM_IDENTITY = {"version": LLVM_VERSION, "archiveSha256": LLVM_SHA256}


def file_hashes(root, marker):
    return {path.relative_to(root).as_posix(): digest(path)
            for path in root.rglob("*") if path.is_file() and path != marker}


def ensure_llvm():
    """Extract only the native CMake toolchain, repairing modified/missing files."""
    archive_path = DEPENDENCIES / LLVM_ARCHIVE
    download(LLVM_URL, archive_path, LLVM_SHA256)
    license_path = DEPENDENCIES / f"llvm-{LLVM_VERSION}-LICENSE.TXT"
    download(LLVM_LICENSE_URL, license_path, LLVM_LICENSE_SHA256)
    marker = LLVM_ROOT / ".remotekit-media-dependency.json"
    if marker.is_file():
        metadata = json.loads(marker.read_text(encoding="utf-8"))
        if metadata == {**LLVM_IDENTITY, "files": file_hashes(LLVM_ROOT, marker)}:
            return LLVM_ROOT
    with tempfile.TemporaryDirectory(prefix="llvm.stage-", dir=DEPENDENCIES) as temporary:
        staging = Path(temporary)
        source = staging / LLVM_ROOT.name
        source.mkdir()
        executables = {"bin/clang-cl.exe", "bin/clang.exe", "bin/lld-link.exe",
                       "bin/llvm-lib.exe"}
        resource = f"lib/clang/{LLVM_VERSION.split('.')[0]}/"
        with tarfile.open(archive_path, mode="r|xz") as archive:
            for member in archive:
                relative = Path(*Path(member.name).parts[1:]).as_posix()
                if not (relative in executables
                        or relative.startswith(resource + "include/")
                        or relative.startswith(resource + "lib/windows/")):
                    continue
                target = source / relative
                if not target.resolve().is_relative_to(source.resolve()):
                    raise RuntimeError("Unsafe LLVM archive entry")
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(member) as input_stream, target.open("wb") as output:
                        shutil.copyfileobj(input_stream, output)
        # The Windows archive omits the full project license; use the pinned release source.
        shutil.copyfile(license_path, source / "LICENSE.TXT")
        files = file_hashes(source, source / marker.name)
        required = executables | {resource + "include/stddef.h", "LICENSE.TXT"}
        if not required.issubset(files) or not any(name.startswith(resource + "lib/windows/")
                                                for name in files):
            raise RuntimeError("Incomplete LLVM archive")
        (source / marker.name).write_text(
            json.dumps({**LLVM_IDENTITY, "files": files}), encoding="utf-8")
        backup = staging / "previous"
        if LLVM_ROOT.exists():
            LLVM_ROOT.rename(backup)
        try:
            source.rename(LLVM_ROOT)
        except BaseException:
            if backup.exists():
                backup.rename(LLVM_ROOT)
            raise
    return LLVM_ROOT


def native_cmake_args(build):
    """Use one compiler-cache migration path for every native CMake entry point."""
    compiler = (LLVM_ROOT / "bin/clang-cl.exe").resolve().as_posix()
    cache = Path(build) / "CMakeCache.txt"
    args = []
    if cache.is_file():
        values = dict(line.split("=", 1) for line in cache.read_text(encoding="utf-8").splitlines()
                      if line.startswith(("CMAKE_CXX_COMPILER:", "CMAKE_C_COMPILER:")))
        if any(os.path.normcase(str(Path(value).resolve())) != os.path.normcase(compiler)
               for value in values.values()) or not values:
            args.append("--fresh")
    args.extend([f"-DCMAKE_C_COMPILER={compiler}", f"-DCMAKE_CXX_COMPILER={compiler}",
                 f"-DCMAKE_LINKER={LLVM_ROOT.as_posix()}/bin/lld-link.exe",
                 "-DCMAKE_LINKER_TYPE=LLD",
                 f"-DCMAKE_C_USING_LINKER_LLD={LLVM_ROOT.as_posix()}/bin/lld-link.exe",
                 f"-DCMAKE_CXX_USING_LINKER_LLD={LLVM_ROOT.as_posix()}/bin/lld-link.exe",
                 f"-DCMAKE_AR={LLVM_ROOT.as_posix()}/bin/llvm-lib.exe"])
    return args


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify(path, expected):
    if not Path(path).is_file() or digest(path) != expected:
        raise RuntimeError(f"Missing file or SHA-256 mismatch: {path}")


def download(url, destination, expected, headers=None):
    destination = Path(destination)
    if destination.is_file() and digest(destination) == expected:
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url)
    for name, value in (headers or {}).items():
        # Credentials must not follow redirects to the storage host.
        request.add_unredirected_header(name, value)
    with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as output:
        partial = Path(output.name)
    try:
        with urllib.request.urlopen(request, timeout=120) as source, partial.open("wb") as output:
            shutil.copyfileobj(source, output)
        verify(partial, expected)
        partial.replace(destination)
    finally:
        partial.unlink(missing_ok=True)
