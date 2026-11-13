"""Deterministic version-tree payloads shared by packaging and publishing."""

import hashlib
from fetch_common import digest
from pathlib import Path
import stat
import tarfile
import tempfile


def build_id(package, node_runtime):
    package, node_runtime = Path(package), Path(node_runtime)
    build_lines = []
    for root, tree in [(node_runtime, 'bin'), (package, 'bin'), (package, 'control')]:
        for file in (root / tree).rglob('*'):
            if file.is_file():
                prefix = 'node/' if root == node_runtime else ''
                build_lines.append(f'{prefix}{file.relative_to(root).as_posix()}\t{digest(file)}\n')
    return hashlib.sha256(''.join(sorted(build_lines)).encode('utf-8')).hexdigest()


def write_payload(tree, destination):
    tree, destination = Path(tree), Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    entries = sorted(tree.rglob('*'), key=lambda path: path.relative_to(tree).as_posix())
    with tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
        output = Path(temporary) / 'payload.tar'
        with tarfile.open(output, 'w', format=tarfile.PAX_FORMAT) as archive:
            for path in entries:
                mode = path.lstat().st_mode
                if path.is_symlink() or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                    raise ValueError(f'Payload contains a non-regular entry: {path}')
                name = path.relative_to(tree).as_posix()
                if name.split('/')[0] in {'release', 'payload.tar', 'payload.json'}:
                    raise ValueError(f'Reserved payload path: {name}')
                info = tarfile.TarInfo(name)
                info.mode = 0o755 if stat.S_ISDIR(mode) else 0o644
                if stat.S_ISDIR(mode):
                    info.type = tarfile.DIRTYPE
                    archive.addfile(info)
                else:
                    info.size = path.stat().st_size
                    with path.open('rb') as source:
                        archive.addfile(info, source)
        metadata = {'size': output.stat().st_size, 'sha256': digest(output)}
        if not destination.is_file() or digest(destination) != metadata['sha256']:
            output.replace(destination)
    return metadata
