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
    args = parser.parse_args()
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
    # Check what ships: extract the Control archive and verify its manifest provenance against
    # the runtime it installs.
    run(
        [sys.executable, 'tests/e2e/test-streaming-package.py', '--archive', result['archives'][0]['path']],
        env,
    )
    print(json.dumps(result, indent=2), flush=True)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='backslashreplace')
    sys.stderr.reconfigure(encoding='utf-8', errors='backslashreplace')
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f'error: {error}', file=sys.stderr)
        sys.exit(1)
