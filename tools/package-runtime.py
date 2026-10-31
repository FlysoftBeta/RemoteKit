#!/usr/bin/env python3
"""Package a Windows demo from GN runtime dependencies, without symbols or profiles."""
import argparse
from datetime import datetime, timezone, timedelta
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TARGET = '//remotekit/browser:remotekit_browser'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium-root', type=Path, default=Path(r'C:\src\chromium\src'))
    parser.add_argument('--out', choices=['dev', 'rel'], default='dev')
    parser.add_argument('--presentation', choices=['fence', 'native'], default='fence')
    parser.add_argument('--destination', type=Path, default=ROOT / 'develop/tmp')
    parser.add_argument('--endpoint', type=Path, default=ROOT / 'build/endpoint-package/endpoint/endpoint_client.exe')
    args = parser.parse_args()
    chromium = args.chromium_root.resolve()
    output = chromium / 'out' / args.out
    endpoint = args.endpoint.resolve()
    if not endpoint.is_file():
        parser.error('Build the release CRT client first: tools\\build-endpoint.cmd package')
    runtime = []
    targets = [TARGET]
    if args.presentation == 'fence': targets.append('//remotekit/browser/sdk:remotekit_sdk')
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
        include |= source.name == 'remotekit_browser.exe'
        include |= source.name == 'vk_swiftshader_icd.json'
        if not include:
            excluded.append(str(relative))
            continue
        if not source.is_file():
            raise FileNotFoundError(source)
        selected[relative] = source
    for name in ['remotekit_browser.exe', 'remotekit.pak', 'icudtl.dat', 'v8_context_snapshot.bin']:
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
    backend = 'fence-atlas' if args.presentation == 'fence' else 'native-host'
    name = 'RemoteKit-win-x64-' + backend + '-' + datetime.now(timezone(timedelta(hours=8))).strftime('%Y%m%d-%H%M%S')
    destination = args.destination.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    package = destination / name
    package.mkdir()
    binary = package / 'bin'
    binary.mkdir()
    print(f'Copying {len(selected)} runtime files ({sum(p.stat().st_size for p in selected.values()) / 1048576:.1f} MiB)', flush=True)
    for relative, source in selected.items():
        target = binary / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    shutil.copy2(endpoint, binary / endpoint.name)
    shutil.copytree(ROOT / 'browser/testdata', package / 'fixtures')
    launch_presentation = '--presentation=' + args.presentation
    (package / 'run.cmd').write_text(
        '@echo off\nsetlocal\nset "RK_ROOT=%~dp0"\n'
        'set "RK_URL=file:///%RK_ROOT:\\=/%fixtures/input.html"\n'
        '"%RK_ROOT%bin\\endpoint_client.exe" "--browser=%RK_ROOT%bin\\remotekit_browser.exe" '
        '"--data-path=%RK_ROOT%data" --sessions=2 ' + launch_presentation + ' "--urls=%RK_URL%|%RK_URL%"\n', encoding='utf-8')
    (package / 'run-web.cmd').write_text(
        '@echo off\nsetlocal\nset "RK_ROOT=%~dp0"\n'
        'set "RK_URLS=https://example.com|https://example.org"\n'
        'if not "%~1"=="" set "RK_URLS=%~1"\n'
        '"%RK_ROOT%bin\\endpoint_client.exe" "--browser=%RK_ROOT%bin\\remotekit_browser.exe" '
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
    files = []
    for file in sorted(package.rglob('*')):
        if file.is_file():
            files.append({'path': file.relative_to(package).as_posix(),
                          'bytes': file.stat().st_size, 'sha256': digest(file)})
    manifest = {
        'name': name, 'chromium_revision': subprocess.check_output(
            ['git', 'rev-parse', 'HEAD'], cwd=chromium, text=True).strip(),
        'args_gn_sha256': digest(output / 'args.gn'), 'architecture': 'x64',
        'presentation_backend': backend, 'shared_fence_output_implemented': args.presentation == 'fence',
        'custom_per_frame_control_messages': False, 'chromium_internal_frame_ipc': True,
        'endpoint_configuration': 'Release', 'browser_configuration': args.out,
        'runtime_launched': False, 'files': files,
        'excluded_runtime_graph_entries': sorted(set(excluded)),
    }
    (package / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    archive = destination / (name + '.zip')
    sevenzip = Path(r'C:\Program Files\7-Zip\7z.exe')
    print('Creating ZIP...', flush=True)
    if sevenzip.is_file():
        subprocess.run([str(sevenzip), 'a', '-tzip', '-mx=1', '-mmt=on',
                        str(archive), name], cwd=destination, check=True,
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
