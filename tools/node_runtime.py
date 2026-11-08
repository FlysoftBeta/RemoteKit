#!/usr/bin/env python3
"""Resolve the verified, pinned Windows x64 Node runtime from the build cache."""

import hashlib
import os
from pathlib import Path
import shutil
import tempfile
import urllib.request
import zipfile

VERSION = 'v24.20.0'
RUNTIME_NAME = f'node-{VERSION}-win-x64'
ARCHIVE_NAME = RUNTIME_NAME + '.zip'
URL = f'https://nodejs.org/dist/{VERSION}/{ARCHIVE_NAME}'
# https://nodejs.org/dist/v24.20.0/SHASUMS256.txt
SHA256 = '6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba'


def digest(stream):
    return hashlib.file_digest(stream, 'sha256').hexdigest()


def resolve_node():
    cache = Path(os.environ['LOCALAPPDATA']) / 'RemoteKit/build-cache'
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / ARCHIVE_NAME
    if not archive.is_file():
        print(f'Downloading {URL}', flush=True)
        with tempfile.TemporaryDirectory(prefix='node-download-', dir=cache) as temporary:
            download = Path(temporary) / ARCHIVE_NAME
            with urllib.request.urlopen(URL, timeout=120) as response, download.open(
                'wb'
            ) as output:
                shutil.copyfileobj(response, output)
            verify_archive(download)
            download.replace(archive)
    else:
        verify_archive(archive)
    runtime = cache / RUNTIME_NAME
    with zipfile.ZipFile(archive) as bundle:
        if not runtime.exists():
            with tempfile.TemporaryDirectory(prefix='node-extract-', dir=cache) as temporary:
                bundle.extractall(temporary)
                (Path(temporary) / RUNTIME_NAME).replace(runtime)
        for name in ('node.exe', 'LICENSE'):
            cached = runtime / name
            with bundle.open(f'{RUNTIME_NAME}/{name}') as original:
                expected = digest(original)
            if not cached.is_file():
                raise RuntimeError(f'Pinned Node cache file missing: {cached}')
            with cached.open('rb') as stream:
                if digest(stream) != expected:
                    raise RuntimeError(f'Pinned Node cache SHA-256 mismatch: {cached}')
    print(f'Using verified Node {VERSION}: {runtime / "node.exe"}', flush=True)
    return runtime / 'node.exe'


def verify_archive(archive):
    with archive.open('rb') as stream:
        if digest(stream) != SHA256:
            raise RuntimeError(f'Pinned Node ZIP SHA-256 mismatch: {archive}')


if __name__ == '__main__':
    print(resolve_node())
