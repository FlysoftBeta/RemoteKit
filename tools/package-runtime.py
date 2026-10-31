#!/usr/bin/env python3
"""Package Windows streaming or demo runtimes from GN runtime dependencies, without symbols or profiles."""
import argparse
from datetime import datetime, timezone, timedelta
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium-root', type=Path, default=Path(r'C:\src\chromium\src'))
    parser.add_argument('--out', choices=['dev', 'rel'], default='dev')
    parser.add_argument('--kind', choices=['streaming', 'demo'], default='streaming')
    parser.add_argument('--presentation', choices=['fence', 'native'], default='fence')
    parser.add_argument('--destination', type=Path, default=ROOT / 'develop/tmp')
    parser.add_argument('--endpoint', type=Path)
    parser.add_argument('--node', type=Path)
    parser.add_argument('--smoke', action='store_true', help='Launch the streaming bundle before archiving (uses GPU/browser)')
    args = parser.parse_args()
    chromium = args.chromium_root.resolve()
    output = chromium / 'out' / args.out
    streaming = args.kind == 'streaming'
    browser_name = 'remotekit_browser.exe' if streaming else 'remotekit_browser_demo.exe'
    browser_target = '//remotekit/browser:' + browser_name.removesuffix('.exe')
    endpoint = (args.endpoint or ROOT / 'build/endpoint-package/endpoint' /
                ('endpoint_service.exe' if streaming else 'endpoint_client.exe')).resolve()
    if not endpoint.is_file():
        parser.error('Build the Release endpoint first: tools\\build-endpoint.cmd package')
    runtime = []
    targets = [browser_target]
    if streaming or args.presentation == 'fence': targets.append('//remotekit/browser/sdk:remotekit_sdk')
    for target in targets:
        graph = json.loads(subprocess.check_output([str(chromium / 'buildtools/win/gn.exe'),
            'desc', str(output), target, 'runtime_deps', '--format=json'], cwd=chromium, text=True))
        runtime.extend(graph[target]['runtime_deps'])
    # GN's component graph also lists DevTools build inputs and debug symbols.
    # The native demo uses its packed resources, not an on-disk DevTools frontend.
    selected = {}
    excluded = []
    for entry in runtime:
        source = (output / entry).resolve()
        if not source.is_relative_to(output):
            raise RuntimeError(f'Runtime dependency escapes output tree: {entry}')
        relative = source.relative_to(output)
        include = source.suffix.lower() in {'.dll', '.pak', '.dat', '.bin'}
        include |= source.name == browser_name
        include |= source.name == 'vk_swiftshader_icd.json'
        if not include:
            excluded.append(str(relative))
            continue
        if not source.is_file():
            raise FileNotFoundError(source)
        selected[relative] = source
    for name in [browser_name, 'remotekit.pak', 'icudtl.dat', 'v8_context_snapshot.bin']:
        source = output / name
        if not source.is_file():
            raise FileNotFoundError(source)
        selected[Path(name)] = source
    # ANGLE and its runtime compiler can be loaded dynamically rather than
    # appear as imports of a particular component DLL.
    for name in ['libEGL.dll', 'libGLESv2.dll', 'd3dcompiler_47.dll',
                 'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll']:
        if (output / name).is_file():
            selected[Path(name)] = output / name
    # The endpoint uses MSVC's STL, while Chromium uses libc++. Include the
    # release CRT set as well as GN's dependencies so the portable client does
    # not rely on Visual Studio or a separately installed redistributable.
    vs = Path(os.environ.get('REMOTEKIT_VS', r'C:\Program Files\Microsoft Visual Studio\18\Community'))
    redist = vs / 'VC/Redist/MSVC'
    if redist.is_dir():
        versions = sorted((p for p in redist.iterdir() if p.is_dir() and p.name[0].isdigit()),
                          key=lambda p: tuple(int(n) for n in p.name.split('.')), reverse=True)
        if versions:
            for crt in (versions[0] / 'x64').glob('Microsoft.VC*.CRT'):
                for dependency in crt.glob('*.dll'):
                    selected.setdefault(Path(dependency.name), dependency)
    backend = 'streaming-qsv-nvenc' if streaming else ('fence-atlas' if args.presentation == 'fence' else 'native-host')
    package_name = 'RemoteKit-win-x64-' + backend + '-' + datetime.now(timezone(timedelta(hours=8))).strftime('%Y%m%d-%H%M%S')
    destination = args.destination.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    package = destination / package_name
    package.mkdir()
    binary = package / 'bin'
    binary.mkdir()
    print(f'Copying {len(selected)} runtime files ({sum(p.stat().st_size for p in selected.values()) / 1048576:.1f} MiB)', flush=True)
    for relative, source in selected.items():
        target = binary / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    shutil.copy2(endpoint, binary / endpoint.name)
    if streaming:
        vpl = endpoint.parent / 'libvpl.dll'
        if not vpl.is_file(): raise FileNotFoundError('Build endpoint Release dispatcher: ' + str(vpl))
        shutil.copy2(vpl, binary / vpl.name)
        node = args.node or (Path(shutil.which('node')) if shutil.which('node') else None)
        if not node or not node.is_file(): raise RuntimeError('Node runtime not found; pass --node')
        runtime_manifest = json.loads((ROOT / 'control/dist/runtime/manifest.json').read_text(encoding='utf-8'))
        node_info = json.loads(subprocess.check_output([str(node), '-p',
            'JSON.stringify({executable:process.execPath,abi:process.versions.modules})'], text=True))
        # PATH can resolve to a version-manager shim, which is not a portable
        # Node runtime. Copy the executable that actually ran the probe.
        node = Path(node_info['executable']).resolve()
        if str(node_info['abi']) != str(runtime_manifest['nodeModuleAbi']):
            raise RuntimeError('Node ABI does not match packaged SQLite native addon')
        shutil.copy2(node, binary / 'node.exe')
        control = package / 'control'
        control.mkdir()
        dist = ROOT / 'control/dist'
        for source in [dist / 'server.mjs', dist / 'client', dist / 'runtime/node_modules']:
            if not source.exists(): raise FileNotFoundError('Run npm run build in control first: ' + str(source))
        (control / 'dist').mkdir()
        shutil.copy2(dist / 'server.mjs', control / 'dist/server.mjs')
        shutil.copytree(dist / 'client', control / 'dist/client')
        shutil.copytree(dist / 'runtime/node_modules', control / 'node_modules')
        shutil.copy2(dist / 'runtime/manifest.json', control / 'runtime-manifest.json')
        licenses = package / 'licenses'
        licenses.mkdir()
        for name in ['LICENSE', 'third-party-programs.txt']:
            shutil.copy2(ROOT / 'build/dependencies/libvpl-2.17.0' / name, licenses / ('libvpl-' + name))
        if not (node.parent / 'LICENSE').is_file(): raise FileNotFoundError('Node runtime LICENSE missing')
        shutil.copy2(node.parent / 'LICENSE', licenses / 'Node-LICENSE')
        shutil.copy2(ROOT / 'build/dependencies/json-LICENSE.MIT', licenses / 'nlohmann-json-LICENSE.MIT')
        header = (ROOT / 'build/dependencies/nvEncodeAPI.h').read_text(encoding='utf-8')
        (licenses / 'NVENC-header-notice.txt').write_text(header[:header.index('*/') + 2], encoding='utf-8')
    shutil.copytree(ROOT / 'browser/testdata', package / 'fixtures')
    launch_presentation = '--presentation=' + args.presentation
    (package / 'run.cmd').write_text(
        '@echo off\nsetlocal\nset "RK_ROOT=%~dp0"\n'
        'set "RK_URL=file:///%RK_ROOT:\\=/%fixtures/input.html"\n'
        '"%RK_ROOT%bin\\endpoint_client.exe" "--browser=%RK_ROOT%bin\\remotekit_browser_demo.exe" '
        '"--data-path=%RK_ROOT%data" --sessions=2 ' + launch_presentation + ' "--urls=%RK_URL%|%RK_URL%"\n', encoding='utf-8')
    (package / 'run-web.cmd').write_text(
        '@echo off\nsetlocal\nset "RK_ROOT=%~dp0"\n'
        'set "RK_URLS=https://example.com|https://example.org"\n'
        'if not "%~1"=="" set "RK_URLS=%~1"\n'
        '"%RK_ROOT%bin\\endpoint_client.exe" "--browser=%RK_ROOT%bin\\remotekit_browser_demo.exe" '
        '"--data-path=%RK_ROOT%data" --sessions=2 ' + launch_presentation + ' "--urls=%RK_URLS%"\n', encoding='utf-8')
    if args.presentation == 'fence':
        (package / 'run-native.cmd').write_text((package / 'run.cmd').read_text(encoding='utf-8')
            .replace('--presentation=fence', '--presentation=native'), encoding='utf-8')
    scope = (
        'This build captures Views/Aura content into a browser-owned three-slot shared GPU atlas.\n'
        'D3D11 shared ready/consumed fences protect writes and reads. Shared memory publishes frame metadata.\n'
        'Browser-to-endpoint Mojo is used for setup/configuration, not steady-state frame ready/present/release.\n'
        'The endpoint copies each consumed atlas into its own GPU cache before releasing the source slot.\n'
        'No encoder, audio pipeline or WebRTC transport is connected. Chromium internal frame IPC remains.\n'
        'A nonzero native Aura capture host remains inside the browser; this is not an Aura-free embedder.\n'
        'There is no automatic native fallback. run-native.cmd explicitly selects the HWND comparison path.\n'
        'Hardware capture and cross-process rendering have not been runtime-tested for this package.\n'
        if args.presentation == 'fence' else
        'This build displays native Views/Aura HWND content; its launchers select --presentation=native.\n'
        'It does not exercise the shared GPU atlas/fence backend. Chromium internal frame IPC remains.\n')
    (package / 'README.txt').write_text(
        'RemoteKit Windows x64 ' + backend + ' demo\n\n'
        'Extract the entire ZIP to a writable folder, then double-click run.cmd.\n'
        'It opens two offline input fixtures. Python, Node, Visual Studio and the source tree are not required.\n'
        'run-web.cmd opens example.com/example.org; pass one quoted URL1|URL2 argument to change them.\n'
        'Close the Endpoint window to stop the browser. Profiles are created in data/ beside this file.\n\n'
        'IMPORTANT PRESENTATION SCOPE\n'
        + scope + '\n'
        'Build: Chromium component build from out/' + args.out + '; standalone endpoint Release CRT.\n'
        'PDBs, import libraries, build-only/frontend source files, and development profiles are excluded.\n'
        'The latest DPI changes are included; this package was not launched or runtime-tested.\n', encoding='utf-8')
    if streaming:
        (package / 'run.cmd').write_text(
            '@echo off\nsetlocal\nset "RK_ROOT=%~dp0"\nset "RK_PATH=%RK_ROOT:\\=/%"\n'
            'set "REMOTEKIT_ENDPOINT=%RK_ROOT%bin\\endpoint_service.exe"\n'
            'set REMOTEKIT_ENDPOINT_ARGS=["--browser=%RK_PATH%bin/remotekit_browser.exe","--data-path=%RK_PATH%data/endpoint"]\n'
            'set "REMOTEKIT_CONTROL_DB=%RK_ROOT%data\\control.db"\n'
            'set "REMOTEKIT_METRICS_DIR=%RK_ROOT%metrics"\n'
            'echo Open http://127.0.0.1:3001 in Chrome. Close this console to stop.\n'
            '"%RK_ROOT%bin\\node.exe" "%RK_ROOT%control\\dist\\server.mjs"\n', encoding='utf-8')
        shutil.copy2(package / 'run.cmd', package / 'run-control.cmd')
        (package / 'README.txt').write_text(
            'RemoteKit Windows hardware streaming test package\n\n'
            'Extract everything to a writable folder and run run.cmd. Open http://127.0.0.1:3001 in Chrome.\n'
            'Each browser context/cookie gets an isolated Tenant/Session and browser process.\n'
            'The service selects Intel QSV or NVIDIA NVENC through the installed GPU driver.\n'
            'This package includes Node and the Control demo dependencies; no build tools are required.\n'
            'Data is created in data/ and diagnostic metrics in metrics/.\n'
            'For encoder experiments append --encoder=qsv/--encoder=nvenc, --fps, --bitrate, --max-bitrate,\n'
            '--async-depth, --gop, --target-usage, --rate-control=cbr/vbr, --buffer-ms and --idle-idr-ms\n'
            'to REMOTEKIT_ENDPOINT_ARGS in run.cmd. Arguments use --name=value.\n'
            'Hardware smoke and stream measurements are reported separately from this package creation.\n', encoding='utf-8')
        for name in ['run-web.cmd', 'run-native.cmd']:
            (package / name).unlink(missing_ok=True)
    validation = None
    if args.smoke:
        if not streaming: parser.error('--smoke requires --kind streaming')
        smoke = subprocess.run([sys.executable, str(ROOT / 'tools/test-streaming-package.py'),
            '--package', str(package)], capture_output=True, text=True, encoding='utf-8')
        validation = json.loads(smoke.stdout)
        if smoke.returncode: raise RuntimeError('Bundled runtime smoke failed: ' + str(validation))
        print('Bundled HTTP/browser smoke passed: ' + validation['evidence'], flush=True)
    files = []
    for file in sorted(package.rglob('*')):
        if file.is_file():
            files.append({'path': file.relative_to(package).as_posix(),
                          'bytes': file.stat().st_size, 'sha256': digest(file)})
    manifest = {
        'name': package_name,
        'remotekit_revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'remotekit_source_dirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip()),
        'chromium_revision': subprocess.check_output(
            ['git', 'rev-parse', 'HEAD'], cwd=chromium, text=True).strip(),
        'args_gn_sha256': digest(output / 'args.gn'), 'architecture': 'x64',
        'presentation_backend': backend, 'shared_fence_output_implemented': streaming or args.presentation == 'fence',
        'browser_endpoint_per_frame_control_messages': False,
        'endpoint_client_frame_metadata': streaming, 'chromium_internal_frame_ipc': True,
        'endpoint_configuration': 'Release', 'browser_configuration': args.out,
        'runtime_launched': bool(validation and validation.get('passed')),
        'runtime_validation': ({key: validation[key] for key in ['passed', 'scope', 'rtcMediaTested', 'endpointSha256']} if validation else None), 'files': files,
        'excluded_runtime_graph_entries': sorted(set(excluded)),
    }
    (package / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    archive = destination / (package_name + '.zip')
    sevenzip = Path(r'C:\Program Files\7-Zip\7z.exe')
    print('Creating ZIP...', flush=True)
    if sevenzip.is_file():
        subprocess.run([str(sevenzip), 'a', '-tzip', '-mx=1', '-mmt=on',
                        str(archive), package_name], cwd=destination, check=True,
                       stdout=subprocess.DEVNULL)
    else:
        with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1) as zipped:
            for file in sorted(package.rglob('*')):
                if file.is_file(): zipped.write(file, file.relative_to(destination))
    checksum = digest(archive)
    archive.with_suffix('.zip.sha256').write_text(checksum + '  ' + archive.name + '\n', encoding='ascii')
    print(json.dumps({'directory': str(package), 'archive': str(archive),
                      'archive_mib': round(archive.stat().st_size / 1048576, 1),
                      'sha256': checksum}, indent=2), flush=True)


if __name__ == '__main__':
    main()
