#!/usr/bin/env python3
"""Package Windows streaming runtimes from GN runtime dependencies, without symbols or profiles."""
import argparse
from datetime import datetime, timezone, timedelta
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def create_archive(package, node, *, node_runtime=False):
    """Stream tar into bounded, concatenated zstd frames; no intermediate tar."""
    archive = package / 'release/node.tar.zst' if node_runtime else package.with_name(package.name + '.tar.zst')
    script = r'''
const { pipeline } = require('node:stream/promises');
const { zstdCompressSync, constants: c } = require('node:zlib');
const options = {params: {
  [c.ZSTD_c_compressionLevel]: 12,
  [c.ZSTD_c_nbWorkers]: Number(process.argv[1]),
  [c.ZSTD_c_checksumFlag]: 1,
}};
// Node 24's async zstd stream can signal EOF with unconsumed input when
// nbWorkers > 0. Complete bounded frames use the blocking end directive,
// retaining native zstd worker threads. Concatenated frames are standard zstd.
async function* compressFrames(source) {
  const frame = Buffer.allocUnsafe(32 * 1024 * 1024);
  let used = 0;
  for await (const chunk of source) {
    let offset = 0;
    while (offset < chunk.length) {
      const count = Math.min(frame.length - used, chunk.length - offset);
      chunk.copy(frame, used, offset, offset + count);
      used += count;
      offset += count;
      if (used === frame.length) {
        yield zstdCompressSync(frame, options);
        used = 0;
      }
    }
  }
  if (used) yield zstdCompressSync(frame.subarray(0, used), options);
}
pipeline(process.stdin, compressFrames, process.stdout)
  .catch(error => { console.error(error); process.exitCode = 1; });
'''
    with archive.open('xb') as output:
        try:
            with tempfile.TemporaryFile() as errors:
                with subprocess.Popen([str(node), '-e', script, str(os.cpu_count() or 1)],
                                      stdin=subprocess.PIPE, stdout=output,
                                      stderr=errors) as compressor:
                    writing_error = None
                    try:
                        with tarfile.open(fileobj=compressor.stdin, mode='w|', format=tarfile.PAX_FORMAT) as tar:
                            if node_runtime:
                                root_entry = tarfile.TarInfo('node')
                                root_entry.type = tarfile.DIRTYPE
                                root_entry.mode = 0o755
                                tar.addfile(root_entry)
                                tar.add(package / 'build.json', arcname='node/build.json')
                                tar.add(package / 'bin', arcname='node/bin',
                                        filter=lambda entry: None if entry.name == 'node/bin/node.exe' else entry)
                            else:
                                tar.add(package, arcname=package.name)
                    except OSError as error:
                        writing_error = error
                    finally:
                        try:
                            compressor.stdin.close()
                        except OSError as error:
                            writing_error = writing_error or error
                    code = compressor.wait()
                    errors.seek(0)
                    if code:
                        raise RuntimeError('zstd compression failed: ' + errors.read().decode('utf-8', errors='replace'))
                    if writing_error:
                        raise writing_error
        except Exception:
            output.close()
            archive.unlink(missing_ok=True)
            raise
    checksum = digest(archive)
    if not node_runtime:
        archive.with_name(archive.name + '.sha256').write_text(
            checksum + '  ' + archive.name + '\n', encoding='ascii')
    return archive, checksum


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def copy_endpoint(source, binary):
    """Normalize CLI overrides to the executable path used by package launchers."""
    target = binary / 'endpoint_service.exe'
    shutil.copy2(source, target)
    return target


def face_runtime_files():
    spec = importlib.util.spec_from_file_location('setup_face_auth', ROOT / 'tools/setup-face-auth.py')
    setup = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(setup)
    return setup.runtime_files()


def copy_face_runtime(files, package):
    """Copy only the verified, enumerated release assets."""
    for source, relative in files:
        target = package / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            raise RuntimeError(f'Face authentication asset collides with a runtime file: {target}')
        shutil.copy2(source, target)


def run_startup_smoke(package, *, work_dir=None):
    """Run startup validation with an isolated config file and UTF-8 output."""
    command = [sys.executable, '-X', 'utf8', str(ROOT / 'tests/e2e/test-streaming-package.py'),
               '--package', str(package)]
    if work_dir is not None:
        command.extend(['--work-dir', str(work_dir)])
    env = os.environ.copy()
    env.update(PYTHONUTF8='1', PYTHONIOENCODING='utf-8')
    smoke = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', errors='replace', env=env)
    try:
        validation = json.loads(smoke.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f'Bundled startup smoke returned invalid JSON (exit {smoke.returncode}): '
                           f'stdout={smoke.stdout!r}; stderr={smoke.stderr!r}') from error
    if smoke.returncode or not validation.get('passed'):
        raise RuntimeError('Bundled startup smoke failed: ' + json.dumps(validation, ensure_ascii=False)
                           + ('; stderr=' + smoke.stderr if smoke.stderr else ''))
    return validation


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium-root', type=Path, default=Path(r'C:\src\chromium\src'))
    parser.add_argument('--out', choices=['dev', 'rel'], default='rel')
    parser.add_argument('--destination', type=Path, default=ROOT / 'develop/tmp')
    parser.add_argument('--endpoint', type=Path)
    parser.add_argument('--node', type=Path)
    parser.add_argument('--smoke', action='store_true', help='Validate streaming startup/auth/Endpoint management before archiving; real Viewer RTC product/media checks remain required')
    args = parser.parse_args()
    chromium = args.chromium_root.resolve()
    output = chromium / 'out' / args.out
    browser_name = 'remotekit_browser.exe'
    browser_target = '//remotekit/browser:' + browser_name.removesuffix('.exe')
    endpoint = (args.endpoint or ROOT / 'build/endpoint-package/endpoint' /
                'endpoint_service.exe').resolve()
    if not endpoint.is_file():
        parser.error('Build the Release endpoint first: tools\\build-endpoint.cmd package')
    face_files = face_runtime_files()
    runtime = []
    targets = [browser_target]
    targets.append('//remotekit/browser/sdk:remotekit_sdk')
    for target in targets:
        graph = json.loads(subprocess.check_output([str(chromium / 'buildtools/win/gn.exe'),
            'desc', str(output), target, 'runtime_deps', '--format=json'], cwd=chromium, text=True))
        runtime.extend(graph[target]['runtime_deps'])
    # GN's component graph also lists DevTools build inputs and debug symbols.
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
    backend = 'streaming-qsv-nvenc'
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
    copy_endpoint(endpoint, binary)
    shutil.copy2(endpoint.parent / 'remotekit_node.exe', binary / 'remotekit_node.exe')
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
    shutil.copytree(dist / 'client', control / 'dist/client', ignore=shutil.ignore_patterns('*.ts', '*.tsx'))
    shutil.copytree(dist / 'runtime/node_modules', control / 'node_modules')
    shutil.copy2(dist / 'runtime/manifest.json', control / 'runtime-manifest.json')
    licenses = package / 'licenses'
    licenses.mkdir()
    shutil.copy2(ROOT / 'build/dependencies/zstd-1.5.7/LICENSE', licenses / 'zstd-LICENSE')
    for name in ['LICENSE', 'third-party-programs.txt']:
        shutil.copy2(ROOT / 'build/dependencies/libvpl-2.17.0' / name, licenses / ('libvpl-' + name))
    if not (node.parent / 'LICENSE').is_file(): raise FileNotFoundError('Node runtime LICENSE missing')
    shutil.copy2(node.parent / 'LICENSE', licenses / 'Node-LICENSE')
    shutil.copy2(ROOT / 'build/dependencies/json-LICENSE.MIT', licenses / 'nlohmann-json-LICENSE.MIT')
    header = (ROOT / 'build/dependencies/nvEncodeAPI.h').read_text(encoding='utf-8')
    (licenses / 'NVENC-header-notice.txt').write_text(header[:header.index('*/') + 2], encoding='utf-8')
    copy_face_runtime(face_files, package)
    (package / 'config').mkdir()
    build_lines = []
    for tree in ['bin', 'control']:
        for file in (package / tree).rglob('*'):
            if file.is_file():
                build_lines.append(f'{file.relative_to(package).as_posix()}\t{digest(file)}\n')
    build_id = hashlib.sha256(''.join(sorted(build_lines)).encode('utf-8')).hexdigest()
    (package / 'build.json').write_text(json.dumps({'buildId': build_id}) + '\n', encoding='utf-8')
    (package / 'release').mkdir()
    node_archive, node_checksum = create_archive(package, node, node_runtime=True)
    (package / 'release/node.json').write_text(json.dumps({
        'buildId': build_id, 'sha256': node_checksum, 'size': node_archive.stat().st_size}) + '\n', encoding='utf-8')
    shutil.copy2(ROOT / 'tools/streaming-launcher.cjs', package / 'run-control.cjs')
    (package / 'run.cmd').write_text(
        '@echo off\nsetlocal DisableDelayedExpansion\nset "RK_ROOT=%~dp0"\n'
        'echo Open http://127.0.0.1:3001 in Chrome. Close this console to stop.\n'
        '"%RK_ROOT%bin\\node.exe" "%RK_ROOT%run-control.cjs" %*\n', encoding='utf-8')
    shutil.copy2(package / 'run.cmd', package / 'run-control.cmd')
    (package / 'README.txt').write_text(
        'RemoteKit Windows hardware streaming package\n\n'
        'Extract everything to a writable folder and run run.cmd. Open http://127.0.0.1:3001 in Chrome.\n'
        'The initial screen is blank white. Press Up Up Down Down Left Right Left Right, or click the corresponding\n'
        'top, bottom, left, and right areas in that order, to reveal the account sign-in form.\n'
        'The first registered account becomes administrator without a server credential.\n'
        'Open More > Administrator panel and set the server registration credential before creating other accounts.\n'
        'Later registrations require that credential; account passwords are independent, and login needs no credential.\n'
        'After signing in, open More > Settings > Security to configure a PIN or face authentication.\n'
        'Face authentication sends uncompressed RGB24 over the dedicated WebRTC data channel at the server-negotiated\n'
        '5 FPS. The required public face models are included in bin/face-models.\n'
        'Each user has an isolated Tenant/Session and browser process.\n'
        'Viewer state and settings use an authenticated WebSocket; browser operations use the WebRTC DataChannel.\n'
        'The encoder defaults to auto. Configure encoder and node paths in config/control.json.\n'
        'This package includes Node and the Control production dependencies; no build tools are required.\n'
        'Data is created in data/. In Viewer Settings, start diagnostics and use the floating stop button to save a tar.zst archive and receive its ID.\n'
        'Diagnostic archives are stored in data/diagnostics; set diagnostics in config/control.json to change it.\n'
        'Control stores the Viewer degradation preference; WebRTC controls media adaptation and encoder rates.\n'
        'run.cmd accepts no arguments. Edit config/control.json to configure HTTP, storage, and nodes.\n'
        'For remote nodes, set cluster.advertiseUrl and copy config/node.json to the node root.\n'
        'Install bin/remotekit_node.exe on that node and run it with run --root=<node root>.\n'
        'Hardware smoke and stream measurements are reported separately from this package creation.\n', encoding='utf-8')
    validation = None
    if args.smoke:
        validation = run_startup_smoke(package)
        print('Bundled startup/auth/Endpoint management smoke passed (RTC product/media checks separate): ' + validation['evidence'], flush=True)
    # Use only explicit runtime inputs above; refuse accidental state, secrets or
    # compiler artifacts before either hashing or archiving the package.
    for file in package.rglob('*'):
        relative = file.relative_to(package)
        if any(part.lower() in {'data', 'profiles', 'profile', 'metrics', '.git'} for part in relative.parts):
            raise RuntimeError('Non-runtime directory in package: ' + str(relative))
        if file.is_file() and (file.name.lower() in {'cred.json', '.env'} or
                              file.name.lower().endswith('.key') or
                              file.suffix.lower() in {'.pdb', '.obj', '.lib', '.exp', '.ilk', '.sqlite', '.db', '.ts', '.tsx', '.cpp', '.cc', '.h'}):
            raise RuntimeError('Non-runtime file in package: ' + str(relative))
    files = []
    for file in sorted(package.rglob('*')):
        if file.is_file():
            files.append({'path': file.relative_to(package).as_posix(),
                          'bytes': file.stat().st_size, 'sha256': digest(file)})
    manifest = {
        'name': package_name, 'buildId': build_id,
        'remotekit_revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'remotekit_source_dirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip()),
        'chromium_revision': subprocess.check_output(
            ['git', 'rev-parse', 'HEAD'], cwd=chromium, text=True).strip(),
        'args_gn_sha256': digest(output / 'args.gn'), 'architecture': 'x64',
        'presentation_backend': backend, 'shared_fence_output_implemented': True,
        'browser_endpoint_render_protocol': 'slot-begin-reject-fence-v1',
        'browser_endpoint_per_frame_begin_ipc': True,
        'browser_endpoint_per_frame_reject_ipc': True,
        'browser_endpoint_per_frame_success_ipc': False,
        'endpoint_client_frame_metadata': True, 'chromium_internal_frame_ipc': True,
        'endpoint_configuration': 'Release', 'browser_configuration': args.out,
        'archive': package_name + '.tar.zst',
        'archive_format': 'tar.zst',
        'archive_compression': {'implementation': 'Node zstd', 'level': 12,
                                'workers': os.cpu_count() or 1, 'frame_bytes': 32 * 1024 * 1024},
        'runtime_launched': bool(validation and validation.get('passed')),
        'runtime_validation': ({key: validation[key] for key in ['passed', 'validationKind', 'scope',
            'browserProductOperationsTested', 'rtcMediaTested', 'endpointManagementReachable',
            'webSocketProductActionRejected', 'workspaceUnchanged', 'endpointSha256',
            'faceModelsAvailable']} if validation else None), 'files': files,
        'excluded_runtime_graph_entries': sorted(set(excluded)),
    }
    (package / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print('Creating tar.zst (level 12, all logical CPUs)...', flush=True)
    archive, checksum = create_archive(package, node)
    print(json.dumps({'directory': str(package), 'archive': str(archive),
                      'directory_mib': round(sum(p.stat().st_size for p in package.rglob('*') if p.is_file()) / 1048576, 1),
                      'archive_mib': round(archive.stat().st_size / 1048576, 1),
                      'sha256': checksum}, indent=2), flush=True)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='backslashreplace')
    sys.stderr.reconfigure(encoding='utf-8', errors='backslashreplace')
    main()
