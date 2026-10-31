#!/usr/bin/env python3
"""Stage RemoteKit-owned sources and build against an existing Chromium output."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
BASE = '1aa07b638799e59656559ae6c6649d4b197f555e'

def run(cmd, cwd):
    subprocess.run([str(x) for x in cmd], cwd=cwd, check=True)

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
    destination.mkdir(exist_ok=True)
    marker.write_text(str(ROOT), encoding='utf-8')
    gn_changed = False
    # Only these trees are owned by this overlay; never copy build or git output.
    for folder in ['browser', 'endpoint/include', 'endpoint/src', 'protocol', 'sdk/include']:
        src = ROOT / folder
        if src.exists():
            for path in src.rglob('*'):
                if path.is_file() and path.suffix in ['.h', '.hpp', '.cc', '.cpp', '.gn', '.mojom']:
                    target = destination / path.relative_to(ROOT)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if not target.exists() or target.read_bytes() != path.read_bytes():
                        shutil.copy2(path, target)
                        if path.suffix == '.gn': gn_changed = True
    if args.command == 'stage':
        return
    output = source / 'out' / args.out
    gn_args = output / 'args.gn'
    old = gn_args.read_text(encoding='utf-8')
    addition = '\n# RemoteKit targets, retaining existing build configuration.\nroot_extra_deps = [ "//remotekit/browser:remotekit_browser", "//remotekit/browser/sdk:remotekit_sdk" ]\n'
    if '//remotekit/browser:remotekit_browser' not in old:
        backup = output / 'args.before-remotekit.gn'
        if not backup.exists(): backup.write_text(old, encoding='utf-8')
        gn_args.write_text(old + addition, encoding='utf-8')
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
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f'error: {exc}', file=sys.stderr)
        sys.exit(1)
