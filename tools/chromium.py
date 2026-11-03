#!/usr/bin/env python3
"""Stage RemoteKit-owned sources and build against an existing Chromium output."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
BASE = '1aa07b638799e59656559ae6c6649d4b197f555e'
OVERLAY_TREES = ('browser', 'endpoint/include', 'endpoint/src', 'protocol', 'sdk/include')
# Git HEAD content (normalized LF) for this migration's explicitly removed files.
# Retain these entries after the first manifest so a prior partial stage can
# still remove old files once their content is verified.
LEGACY_REMOVED = {
    'browser/capture_delivery_probe.cc': 'f428742730f057c136b5c7daa85837cf170f008c35bbf6dd9a58ab8978345d84',
    'browser/capture_render_rate_probe.cc': '9e5ba24a7506590b8a37f262815eb30b86590f61065c9b32e2df70ee4abc53fa',
    'browser/gpu_atlas.cc': '5b5d973fe90b2a0c0bea5b342ed81a35350b350139e105af29d8615fbaa96b12',
    'browser/gpu_atlas.h': 'e968f7b60223f5cb7fbeac8c71107918a5c11169ae49951f406fb1be2e14d7b4',
    'endpoint/include/remotekit/adaptive_fps.hpp': '6ad6a9d9fdf835c8e9fc701444f21ac73b5f15325b1a7e4c94d62eee0af5e525',
    'endpoint/include/remotekit/capture_geometry.hpp': '441a77ce92be196cc71c2948c4f5a6baa385c18860c9408b81a198085ca31ce7',
    'endpoint/include/remotekit/shared_atlas.h': '2d59ec9868e47016672e07257fcffb22c3dfdb20b49e10b849952b3268e765d6',
    'endpoint/include/remotekit/shared_lease_retirement.hpp': '230b14b3bdb356d392b81aa1f8a130d198d12973f7e1b5f19e1c91bb2a9160e1',
    'endpoint/src/media/atlas_pool.cpp': 'e1ee5bd2d1cbb4161202899676d0db2bf9b1de7d8b568669530d23a79f622f17',
    'endpoint/src/media/atlas_pool.hpp': 'dc57d1107e98d6173a94c9b98869796af19743347bf15ff81db987448c4b5172',
}

def digest(path):
    return hashlib.sha256(path.read_bytes().replace(b'\r\n', b'\n')).hexdigest()

def owned_path(destination, relative):
    path = Path(relative)
    if path.is_absolute() or '..' in path.parts or not any(
            path == Path(tree) or Path(tree) in path.parents for tree in OVERLAY_TREES):
        raise ValueError(f'invalid overlay manifest path: {relative}')
    target = destination / path
    if not target.resolve().is_relative_to(destination.resolve()):
        raise ValueError(f'overlay path escapes destination: {relative}')
    return target


def run(cmd, cwd):
    subprocess.run([str(x) for x in cmd], cwd=cwd, check=True)

def copy_if_changed(source, target):
    """Copy changed content without carrying an old source mtime into Ninja."""
    if target.exists() and target.read_bytes() == source.read_bytes():
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(source, target)
    return True

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--chromium-root', type=Path, default=Path(r'C:\src\chromium\src'))
    p.add_argument('--out', choices=['dev', 'rel'], default='dev')
    p.add_argument('command', choices=['stage', 'gen', 'build', 'check'])
    p.add_argument('--target', action='append',
                   help='GN target; repeat to build both browser and SDK in one Ninja invocation')
    p.add_argument('--jobs', type=int, default=os.cpu_count() or 1,
                   help='parallel jobs; defaults to all logical CPUs')
    args = p.parse_args()
    targets = args.target or ['remotekit_browser']
    source = args.chromium_root.resolve()
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip()
    if head != BASE:
        p.error(f'expected official Release base {BASE}, got {head}')
    destination = source / 'remotekit'
    marker = destination / '.remotekit-overlay'
    if destination.exists() and not marker.exists():
        p.error(f'refusing to overwrite unowned directory {destination}')
    if marker.exists() and Path(marker.read_text(encoding='utf-8').strip()).resolve() != ROOT:
        p.error(f'overlay marker does not name this checkout: {marker}')
    destination.mkdir(exist_ok=True)
    marker.write_text(str(ROOT), encoding='utf-8')
    manifest = destination / '.remotekit-stage-manifest.json'
    previous = json.loads(manifest.read_text(encoding='utf-8')) if manifest.exists() else {}
    if not isinstance(previous, dict):
        p.error('invalid overlay manifest')
    previous = {**LEGACY_REMOVED, **previous}
    current = {}
    gn_changed = False
    # Only these trees are owned by this overlay; never copy build or git output.
    for folder in OVERLAY_TREES:
        src = ROOT / folder
        if src.exists():
            for path in src.rglob('*'):
                if path.is_file() and path.suffix in ['.h', '.hpp', '.cc', '.cpp', '.gn', '.mojom']:
                    relative = path.relative_to(ROOT).as_posix()
                    target = owned_path(destination, relative)
                    current[relative] = digest(path)
                    if copy_if_changed(path, target):
                        if path.suffix == '.gn': gn_changed = True
    for relative, expected in previous.items():
        if relative in current or (ROOT / relative).exists():
            continue
        target = owned_path(destination, relative)
        if target.exists():
            if not target.is_file() or digest(target) != expected:
                p.error(f'refusing to delete modified overlay file {target}')
            target.unlink()
            if target.suffix == '.gn': gn_changed = True
    manifest.write_text(json.dumps(current, indent=2, sort_keys=True) + '\n', encoding='utf-8')
    if args.command == 'stage':
        return
    output = source / 'out' / args.out
    gn_args = output / 'args.gn'
    old = gn_args.read_text(encoding='utf-8')
    root_targets = ['//remotekit/browser:remotekit_browser',
                    '//remotekit/browser:remotekit_browser_demo',
                    '//remotekit/browser/sdk:remotekit_sdk']
    match = re.search(r'root_extra_deps\s*=\s*\[([^\]]*)\]', old, re.DOTALL)
    existing = match.group(1) if match else ''
    missing = [target for target in root_targets if '"' + target + '"' not in existing]
    if missing:
        backup = output / 'args.before-remotekit.gn'
        if not backup.exists(): backup.write_text(old, encoding='utf-8')
        body = existing.rstrip()
        if body and not body.endswith(','): body += ','
        body += '\n' + ''.join(f'  "{target}",\n' for target in missing)
        addition = 'root_extra_deps = [' + body + ']'
        updated = (old[:match.start()] + addition + old[match.end():] if match else
                   old + '\n# RemoteKit targets.\n' + addition + '\n')
        gn_args.write_text(updated, encoding='utf-8')
        gn_changed = True
    env = os.environ
    env.setdefault('DEPOT_TOOLS_WIN_TOOLCHAIN', '0')
    env.setdefault('vs2026_install', r'C:\Program Files\Microsoft Visual Studio\18\Community')
    if args.command == 'gen' or gn_changed or not (output / 'build.ninja').exists():
        run([source / 'buildtools/win/gn.exe', 'gen', output], source)
    if args.command == 'build':
        run([source.parent.parent / 'depot_tools/autoninja.bat', '-C', output,
             *targets, '-j', args.jobs], source)
    elif args.command == 'check':
        for target in targets:
            directory = 'browser/sdk' if target == 'remotekit_sdk' else 'browser'
            run([source / 'buildtools/win/gn.exe', 'check', output,
                 f'//remotekit/{directory}:{target}'], source)

if __name__ == '__main__':
    try: main()
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(f'error: {exc}', file=sys.stderr)
        sys.exit(1)
