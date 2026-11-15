#!/usr/bin/env python3
"""Build and package a clean RemoteKit checkout with the pinned Node runtime."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

from node_runtime import resolve_node

ROOT = Path(__file__).resolve().parents[1]
CHROMIUM = Path(r'C:\src\chromium\src')


def run(command, env):
    command = [str(part) for part in command]
    print('> ' + subprocess.list2cmdline(command), flush=True)
    subprocess.run(command, cwd=ROOT, env=env, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', choices=['dev', 'rel'], default='rel')
    parser.add_argument('--publish', action='store_true')
    parser.add_argument('--full', action='store_true', help='publish a full asset as well as the patch')
    parser.add_argument('--transition', action='store_true')
    parser.add_argument('--prerelease', action='store_true')
    args = parser.parse_args()
    if (args.transition or args.prerelease) and not args.publish:
        parser.error('--transition and --prerelease require --publish')
    if args.transition and (args.full or args.prerelease):
        parser.error('--transition is incompatible with --full and --prerelease')
    if args.full and not args.publish:
        raise ValueError('--full requires --publish')
    status = subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True)
    if status.strip():
        raise RuntimeError('Release requires a clean working tree:\n' + status.rstrip())
    node = resolve_node()
    env = os.environ.copy()
    env['PATH'] = str(node.parent) + os.pathsep + env.get('PATH', '')
    env.update(PYTHONUTF8='1', PYTHONIOENCODING='utf-8')
    output = CHROMIUM / 'out' / args.out
    commands = [
        [sys.executable, 'tools/chromium.py', 'stage'],
        [
            sys.executable,
            'tools/chromium.py',
            'build',
            '--out',
            args.out,
            '--target',
            'remotekit_browser',
            '--target',
            'remotekit_sdk',
        ],
        [
            sys.executable,
            'tools/export-sdk.py',
            '--out',
            output,
            '--destination',
            ROOT / 'sdk/dist' / args.out,
        ],
        [ROOT / 'tools/build-endpoint.cmd', 'package'],
        [node.parent / 'npm.cmd', '--prefix', 'control', 'run', 'build'],
    ]
    for command in commands:
        run(command, env)
    spec = importlib.util.spec_from_file_location(
        'package_runtime', ROOT / 'tools/package-runtime.py'
    )
    packager = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(packager)
    print('> package-runtime.py --out ' + args.out + ' --smoke', flush=True)
    result = packager.main(['--out', args.out, '--smoke'])
    if args.publish:
        publish = [sys.executable, 'tools/publish-release.py', '--package', result['directory']]
        publish.extend('--' + flag for flag in ('full', 'transition', 'prerelease')
                       if getattr(args, flag))
        run(publish, env)
    print(json.dumps(result, indent=2), flush=True)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='backslashreplace')
    sys.stderr.reconfigure(encoding='utf-8', errors='backslashreplace')
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f'error: {error}', file=sys.stderr)
        sys.exit(1)
