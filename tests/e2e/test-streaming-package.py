#!/usr/bin/env python3
"""Test bundled streaming startup/auth/management; RTC product/media checks require a real Viewer."""

import argparse
import base64
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import time
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def verify_provenance(metadata, package, binary):
    source = metadata['source']
    if not re.fullmatch(r'[0-9a-f]{40}', source['commit']):
        raise ValueError('Invalid source commit in package metadata')
    if type(source['dirty']) is not bool:
        raise ValueError('Invalid source dirty flag in package metadata')
    files = {
        'browser_sha256': binary / 'remotekit_browser.exe',
        'endpoint_sha256': binary / 'endpoint_service.exe',
        'node_sha256': package / 'bin/node.exe',
        'control_server_sha256': package / 'control/dist/server.mjs',
    }
    for name, file in files.items():
        with file.open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        if actual != metadata['artifacts'][name]:
            raise ValueError(f'Package artifact SHA-256 mismatch: {file}')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    source = p.add_mutually_exclusive_group(required=True)
    source.add_argument('--root', type=Path, help='Installed deployment root (modified by smoke)')
    source.add_argument('--payload', type=Path, help='Install into a scratch deployment root')
    p.add_argument('--work-dir', type=Path, default=ROOT / 'develop/tmp/package-smoke')
    a = p.parse_args()
    deployment = a.root.resolve() if a.root else None
    package = None
    run = a.work_dir.resolve() / str(time.time_ns())
    run.mkdir(parents=True)
    result = {
        'passed': False,
        'package': str(package),
        'evidence': str(run),
        'scope': 'startup: bundled Node + production UI assets + SQLite first-admin registration + authenticated WebSocket state + clock/admin + Endpoint management reconciliation and face model availability + Viewer reattachment lock and password recovery + rejected WS browser action with unchanged workspace; no RTC product operations or media',
        'validationKind': 'startup',
        'browserProductOperationsTested': False,
        'rtcMediaTested': False,
    }
    child = None
    manifest = None
    try:
        if a.payload:
            deployment = run / 'deployment'
            deployment.mkdir()
            manager = deployment / 'remotekit_control.exe'
            with tarfile.open(a.payload.resolve(), 'r:') as archive:
                with archive.extractfile('bin/remotekit_control.exe') as source:
                    manager.write_bytes(source.read())
            subprocess.run([str(manager), 'install', '--root=' + str(deployment),
                            '--payload=' + str(a.payload.resolve())], check=True)
        build_id = (deployment / 'current').read_text(encoding='ascii').strip()
        if not re.fullmatch(r'[0-9a-f]{64}', build_id):
            raise ValueError('Invalid installed current buildId')
        package = deployment / 'versions' / build_id
        result.update(root=str(deployment), package=str(package))
        manifest = json.loads((package / 'manifest.json').read_text(encoding='utf-8'))
        if manifest['browser_configuration'] not in ['dev', 'rel']:
            raise ValueError('Unknown browser configuration')
        result['browserConfiguration'] = manifest['browser_configuration']
        for relative in [
            'bin/node.exe',
            'bin/remotekit_control.exe',
            'bin/remotekit_node.exe',
            'control/dist/server.mjs',
            'control/dist/client/index.html',
        ]:
            if not (package / relative).is_file():
                raise FileNotFoundError(relative)
        metadata = json.loads((package / 'build.json').read_text(encoding='utf-8'))
        if metadata['buildId'] != build_id or manifest['buildId'] != build_id:
            raise ValueError('Package manifest/build.json/current buildId mismatch')
        binary = deployment / 'data/node/runtime' / build_id / 'bin'
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            peer_port = probe.getsockname()[1]
        origin = 'http://127.0.0.1:' + str(port)
        env = os.environ.copy()
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for name in ['NODE_PATH', 'NODE_OPTIONS', 'REMOTEKIT_CONTROL_CONFIG']:
            env.pop(name, None)
        config = deployment / 'config/control.json'
        config.parent.mkdir(parents=True, exist_ok=True)
        (config.parent / 'manager.json').write_text(json.dumps({'manifest': origin + '/control.manifest'}), encoding='utf-8')
        (config.parent / 'release.key').write_text(base64.b64encode(os.urandom(32)).decode('ascii'), encoding='ascii')
        config.write_text(
            json.dumps(
                {
                    'http': {'listen': '127.0.0.1:' + str(port), 'origins': [origin]},
                    'storage': {
                        'database': str(run / 'control.db'),
                        'diagnostics': str(run / 'diagnostics'),
                    },
                    'nodes': {'local': {'local': {'root': str(deployment / 'data/node')},
                                        'peer': {'listen': '127.0.0.1:' + str(peer_port)}}},
                }
            ),
            encoding='utf-8',
        )
        with (run / 'stderr.log').open('wb') as errors, (run / 'stdout.log').open('wb') as output:
            child = subprocess.Popen(
                [str(deployment / 'remotekit_control.exe'), 'run', '--root=' + str(deployment)],
                cwd=deployment,
                stdin=subprocess.DEVNULL,
                env=env,
                stdout=output,
                stderr=errors,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
            deadline = time.monotonic() + 20
            while True:
                try:
                    with opener.open(origin + '/', timeout=2) as response:
                        response.read()
                    break
                except (OSError, TypeError):
                    if child.poll() is not None or time.monotonic() > deadline:
                        raise
                    time.sleep(0.1)
            with opener.open(origin + '/', timeout=5) as response:
                html = response.read().decode('utf-8')
            assets = re.findall(r'(?:src|href)="(/assets/[^"<>]+)"', html)
            if not assets:
                raise AssertionError('No production UI assets')
            for asset in assets:
                with opener.open(origin + asset, timeout=5) as response:
                    if not response.read():
                        raise AssertionError('Empty UI asset ' + asset)
            deadline = time.monotonic() + 180
            while not (binary / 'endpoint_service.exe').is_file():
                if child.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError('Control did not install its local node runtime')
                time.sleep(0.1)
            verify_provenance(manifest, package, binary)
            result.update(source=manifest['source'], artifacts=manifest['artifacts'])
            result['endpointSha256'] = hashlib.sha256((binary / 'endpoint_service.exe').read_bytes()).hexdigest()
            check = subprocess.run(
                [
                    str(package / 'bin/node.exe'),
                    str(ROOT / 'tests/e2e/smoke-streaming-product.mjs'),
                    str(package),
                    origin,
                ],
                cwd=run,
                env=env,
                capture_output=True,
                text=True,
                encoding='utf-8',
                timeout=55,
            )
            (run / 'product-smoke.stderr.log').write_text(check.stderr, encoding='utf-8')
            if check.returncode:
                raise AssertionError('Startup WebSocket smoke failed: ' + check.stderr)
            result.update(passed=True, assets=assets, **json.loads(check.stdout))
    except Exception as error:
        result['error'] = str(error)
    finally:
        if child is not None and child.poll() is None:
            # Terminate the owned manager and its service/browser tree.
            try:
                subprocess.run(
                    ['taskkill.exe', '/PID', str(child.pid), '/T', '/F'],
                    capture_output=True,
                    timeout=15,
                )
                child.wait(timeout=15)
            except Exception as error:
                result.update(passed=False, cleanupError=str(error))
        (run / 'result.json').write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8'
        )
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    # Structured subprocess output has an explicit encoding even under Windows'
    # legacy console code page, including errors containing non-ASCII paths/text.
    sys.stdout.reconfigure(encoding='utf-8', errors='backslashreplace')
    sys.stderr.reconfigure(encoding='utf-8', errors='backslashreplace')
    raise SystemExit(main())
