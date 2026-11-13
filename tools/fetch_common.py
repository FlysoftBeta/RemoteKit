"""Hash-verified streaming dependency downloads."""

import hashlib
from pathlib import Path
import shutil
import tempfile
import urllib.request


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
