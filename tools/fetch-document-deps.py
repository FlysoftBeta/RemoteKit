#!/usr/bin/env python3
"""Fetch the pinned Windows x64 document conversion runtimes.

LibreOffice 26.8.2.2: SHA-256 checked against the official archive's .sha256
and MirrorBrain .mirrorlist on 2026-11-09. Administrative extraction never
registers or installs LibreOffice on the host. Retain Chinese/English resources
and all fonts in the headless PDF conversion runtime.

pdfrender: FlysoftBeta/pdf-render run 39002781402, commit
9b6f190656501c4f0f37e167c0a976cc6c53e3ad. The Actions artifact expires
2027-01-15: refresh its artifact ID and SHA-256 before that date. The zip pin
is checked against GitHub's published artifact digest and the downloaded zip.
Run with C:\\src\\depot_tools\\python3.bat.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DEPS = ROOT / "build/dependencies/documents"
CACHE = DEPS / "cache"
LO_VERSION = "26.8.2.2"
LO_URL = (
    "https://downloadarchive.documentfoundation.org/libreoffice/old/"
    f"{LO_VERSION}/win/x86_64/LibreOffice_{LO_VERSION}_Win_x86-64.msi"
)
LO_SHA256 = "ff4b911403b67ee9e6249f820f9782c44bb32c94fdaa45b0da53a8e419e5307a"
PDF_ARTIFACT = 12089514051
PDF_SHA256 = "0e713786c3281bfe3f6e8f3d72ac4b895dbfe03dbe628cdd5b8338fa64db7164"
PDF_URL = f"https://api.github.com/repos/FlysoftBeta/pdf-render/actions/artifacts/{PDF_ARTIFACT}/zip"
PINS = {"libreoffice": LO_SHA256, "pdfrender": PDF_SHA256}
LO_PRUNE_REVISION = 6
LO_REMOVE = (
    "help",
    "readmes",
    "CREDITS.fodt",
    "System",
    "System64",
    "share/extensions",
    "share/gallery",
    "share/template",
    "share/autotext",
    "share/wizards",
    "share/Scripts",
    "share/xpdfimport",
    "share/config/images_*.zip",
    "share/config/wizard",
    "share/firebird",
    "share/basic",
    "program/wizards",
    "program/python*",
    "program/pyuno.pyd",
    "program/*.py",
    "program/*.pyi",
    "program/classes",
    "program/shlxthdl",
    "program/xpdfimport.exe",
    "program/pdfimportlo.dll",
    "share/registry/pdfimport.xcd",
    "program/Engine12.dll",
    "program/intl",
    "program/hsqldb.dll",
    "program/jdbclo.dll",
    "program/postgresql-sdbc-impllo.dll",
    "program/libpq.dll",
    "program/cli_*",
    "program/policy.*",
    "program/gengal.exe",
    "program/odbcconfig.exe",
    "program/quickstart.exe",
    "program/regview.exe",
    "program/sbase.exe",
    "program/scalc.exe",
    "program/sdraw.exe",
    "program/senddoc.exe",
    "program/simpress.exe",
    "program/smath.exe",
    "program/soffice_safe.exe",
    "program/sweb.exe",
    "program/swriter.exe",
    "program/unoinfo.exe",
    "program/updater.exe",
    "program/update_service.exe",
)
# OpenSymbol lives in resource/common rather than Fonts and affects bullets/math.
LO_RESOURCE_KEEP = {"common", "en_US", "zh_CN"}
LO_CONFIG_KEEP = {"vcl", "svx", "svt", "simpress", "modules"}
LO_REGISTRY_KEEP = {
    "main.xcd",
    "base.xcd",
    "calc.xcd",
    "draw.xcd",
    "impress.xcd",
    "writer.xcd",
    "math.xcd",
    "graphicfilter.xcd",
    "lingucomponent.xcd",
    "xsltfilter.xcd",
    "cjk_zh-CN.xcd",
    "Langpack-en-US.xcd",
    "Langpack-zh-CN.xcd",
    "oo-ad-ldap.xcd.sample",
    "oo-ldap.xcd.sample",
    "oo-winuser.xcd.sample",
    "res",
}


def prune_libreoffice(source):
    """Keep native import/export filters, fonts and Chinese/English resources."""
    # Keep ifbclient.dll: mergedlo.dll imports it without the Firebird engine.
    for pattern in LO_REMOVE:
        for path in sorted(source.glob(pattern)):
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
    # Headless document loading still constructs shared and Impress UI objects.
    config = source / "share/config/soffice.cfg"
    for path in sorted(config.iterdir()):
        if path.name not in LO_CONFIG_KEEP:
            shutil.rmtree(path)
    for path in sorted((config / "modules").iterdir()):
        if path.name != "simpress":
            shutil.rmtree(path)
    resources = source / "program/resource"
    for path in sorted(resources.iterdir()):
        if path.name not in LO_RESOURCE_KEEP:
            shutil.rmtree(path)
    registry = source / "share/registry"
    for path in sorted(registry.iterdir()):
        if path.name not in LO_REGISTRY_KEEP:
            path.unlink()
    for path in sorted((registry / "res").iterdir()):
        if not any(locale in path.name for locale in ("en-US", "zh-CN")):
            path.unlink()


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(url, destination, expected, headers=None):
    if destination.is_file() and digest(destination) == expected:
        return
    request = urllib.request.Request(url)
    for name, value in (headers or {}).items():
        # The API redirects to a signed blob URL. GitHub credentials belong
        # only on the API request, not on the storage host.
        request.add_unredirected_header(name, value)
    partial = destination.with_name(destination.name + ".partial")
    try:
        with urllib.request.urlopen(request, timeout=120) as source, partial.open("wb") as output:
            shutil.copyfileobj(source, output)
        if digest(partial) != expected:
            raise RuntimeError(f"Dependency SHA-256 mismatch: {destination.name}")
        partial.replace(destination)
    finally:
        partial.unlink(missing_ok=True)


def extract_zip(path, destination):
    with zipfile.ZipFile(path) as archive:
        for member in archive.infolist():
            target = (destination / member.filename).resolve()
            if not target.is_relative_to(destination.resolve()) or "\\" in member.filename:
                raise RuntimeError("Unsafe dependency archive entry")
            if (member.external_attr >> 16) & 0o170000 == 0o120000:
                raise RuntimeError("Dependency archive contains a symlink")
        archive.extractall(destination)


def valid_tree(name):
    path = DEPS / name
    if name == "libreoffice" and not all(
            (path / "program" / file).is_file()
            for file in ("msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll")):
        return False
    marker = path / ".remotekit-document-dependency.json"
    if not marker.is_file():
        return False
    metadata = json.loads(marker.read_text(encoding="utf-8"))
    if name == "libreoffice" and metadata.get("pruneRevision") != LO_PRUNE_REVISION:
        return False
    if metadata["archiveSha256"] != PINS[name]:
        return False
    files = {file.relative_to(path).as_posix() for file in path.rglob("*") if file.is_file()}
    if files != set(metadata["files"]) | {marker.name}:
        return False
    return all((path / file).is_file() and digest(path / file) == expected
               for file, expected in metadata["files"].items())


def publish(name, source):
    source = source.resolve()
    target = (DEPS / name).resolve()
    backup = (DEPS / (name + ".previous")).resolve()
    if not all(path != DEPS.resolve() and path.is_relative_to(DEPS.resolve())
               for path in (source, target, backup)):
        raise RuntimeError("Dependency replacement escapes document dependency directory")
    executable = source / ("program/soffice.com" if name == "libreoffice" else "pdfrender.exe")
    licenses = list(source.glob("LICENSE*")) if name == "libreoffice" else list(source.rglob("COPYING*"))
    if not executable.is_file() or not licenses:
        raise RuntimeError(f"Incomplete {name} runtime or missing licenses")
    metadata = {"archiveSha256": PINS[name], "files": {
        file.relative_to(source).as_posix(): digest(file)
        for file in sorted(source.rglob("*")) if file.is_file()
    }}
    if name == "libreoffice":
        metadata["pruneRevision"] = LO_PRUNE_REVISION
    (source / ".remotekit-document-dependency.json").write_text(
        json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
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


def install_libreoffice():
    if valid_tree("libreoffice"):
        return
    msi = CACHE / LO_URL.rsplit("/", 1)[1]
    download(LO_URL, msi, LO_SHA256)
    with tempfile.TemporaryDirectory(prefix="lo-", dir=DEPS) as temporary:
        extraction = Path(temporary) / "admin"
        subprocess.run(["msiexec.exe", "/a", str(msi), "/qn", "/norestart",
                        f"TARGETDIR={extraction}"], check=True, timeout=600)
        matches = list(extraction.rglob("soffice.com"))
        if len(matches) != 1:
            raise RuntimeError("Administrative MSI extraction did not produce soffice.com")
        source = matches[0].parent.parent
        # The administrative image includes the MSI itself; it is not runtime data.
        for image in source.glob("*.msi"):
            image.unlink()
        # An administrative image puts the x64 CRT in System64 instead of
        # installing it. Use app-local DLLs for a portable headless runtime.
        for library in (source / "System64").glob("*.dll"):
            shutil.copy2(library, source / "program" / library.name)
        prune_libreoffice(source)
        publish("libreoffice", source)


def install_pdfrender():
    if valid_tree("pdfrender"):
        return
    archive = CACHE / f"pdfrender-{PDF_ARTIFACT}.zip"
    if not archive.is_file() or digest(archive) != PDF_SHA256:
        token = os.environ.get("GITHUB_TOKEN") or subprocess.check_output(
            ["gh", "auth", "token"], text=True).strip()
        download(PDF_URL, archive, PDF_SHA256,
                 {"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json"})
    with tempfile.TemporaryDirectory(prefix="pdf-", dir=DEPS) as temporary:
        extraction = Path(temporary)
        extract_zip(archive, extraction)
        packages = list(extraction.rglob("pdfrender-windows-x86_64.zip"))
        if packages:
            extract_zip(packages[0], extraction / "runtime")
        matches = list(extraction.rglob("pdfrender.exe"))
        if len(matches) != 1:
            raise RuntimeError("pdfrender artifact did not contain one Windows runtime")
        publish("pdfrender", matches[0].parent)


def runtime_trees():
    """Return the fully verified runtime trees for offline packaging."""
    for name in PINS:
        if not valid_tree(name):
            raise RuntimeError(f"Run tools/fetch-document-deps.py: missing or changed {name}")
    return [(DEPS / name, Path("documents") / name) for name in PINS]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="verify installed runtimes offline")
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    if not args.verify:
        install_libreoffice()
        install_pdfrender()
    for source, _ in runtime_trees():
        size = sum(file.stat().st_size for file in source.rglob("*") if file.is_file())
        print(f"Verified {source.name}: {size} bytes ({size / 1048576:.1f} MiB)")


if __name__ == "__main__":
    main()
