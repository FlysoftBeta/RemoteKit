#!/usr/bin/env python3
"""Package Windows streaming runtimes from GN runtime dependencies, without symbols or profiles."""

import argparse
from datetime import datetime, timezone, timedelta
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE_TREES = ('browser', 'endpoint', 'control', 'protocol', 'sdk', 'tools', 'patches')


def source_provenance():
    return {
        'commit': subprocess.check_output(
            ['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True
        ).strip(),
        'dirty': bool(
            subprocess.check_output(
                ['git', 'status', '--porcelain', '--untracked-files=no', '--', *SOURCE_TREES],
                cwd=ROOT,
                text=True,
            ).strip()
        ),
    }


def require_no_pending_work(component, command, cwd):
    result = subprocess.run(
        [str(part) for part in command],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
    )
    output = result.stdout + result.stderr
    if result.returncode or 'ninja: no work to do.' not in output:
        details = '\n'.join(output.splitlines()[:25])
        raise RuntimeError(
            f'Stale {component}: build has pending work or freshness check failed.\n{details}'
        )


def check_control_freshness():
    control = ROOT / 'control'
    sources = [
        file
        for tree in ('server', 'client', 'shared')
        for file in (control / tree).rglob('*')
        if file.is_file()
    ]
    newest = max(sources, key=lambda file: file.stat().st_mtime_ns)
    for relative in (
        'server.mjs',
        'recover-credentials.mjs',
        'client/index.html',
        'runtime/manifest.json',
    ):
        artifact = control / 'dist' / relative
        if not artifact.is_file() or artifact.stat().st_mtime_ns < newest.stat().st_mtime_ns:
            raise RuntimeError(
                f'Stale Control: {artifact} is missing or older than {newest}; '
                'run npm --prefix control run build'
            )


def check_endpoint_freshness(build):
    if not (build / 'CMakeCache.txt').is_file() or not (build / 'build.ninja').is_file():
        raise RuntimeError(f'Stale Endpoint: package build is missing from {build}')
    cache = {}
    for line in (build / 'CMakeCache.txt').read_text(encoding='utf-8').splitlines():
        if '=' in line and ':' in line.split('=', 1)[0]:
            key, value = line.split('=', 1)
            cache[key.split(':', 1)[0]] = value
    with tempfile.TemporaryDirectory(prefix='remotekit-freshness-') as temporary:
        temporary = Path(temporary)
        verification = build / 'CMakeFiles/VerifyGlobs.cmake'
        if verification.is_file():
            # CMake's forced glob edge makes every Ninja dry run schedule a
            # regeneration. Check those globs without touching the build tree.
            script = re.sub(
                r'file\(TOUCH_NOCREATE\s+"[^"]+"\)',
                'message(FATAL_ERROR "Stale Endpoint: CMake glob inputs changed")',
                verification.read_text(encoding='utf-8'),
            )
            probe = temporary / 'VerifyGlobs.cmake'
            probe.write_text(script, encoding='utf-8')
            result = subprocess.run(
                [cache['CMAKE_COMMAND'], '-P', str(probe)],
                cwd=build,
                capture_output=True,
                text=True,
                encoding='utf-8',
                errors='replace',
            )
            if result.returncode:
                raise RuntimeError(
                    'Stale Endpoint: CMake glob check failed.\n' + result.stdout + result.stderr
                )
        manifest = (build / 'build.ninja').read_text(encoding='utf-8')
        manifest = re.sub(
            r'^build (.+): VERIFY_GLOBS[^\n]*$', r'build \1: phony', manifest, flags=re.MULTILINE
        )
        probe = temporary / 'build.ninja'
        probe.write_text(manifest, encoding='utf-8')
        require_no_pending_work(
            'Endpoint',
            [
                cache['CMAKE_MAKE_PROGRAM'],
                '-C',
                build,
                '-f',
                probe,
                '-n',
                '-d',
                'explain',
                'build.ninja',
                'endpoint_service',
                'remotekit_node',
            ],
            ROOT,
        )


def check_freshness(chromium, output):
    staged = subprocess.run(
        [
            sys.executable,
            str(ROOT / 'tools/chromium.py'),
            '--chromium-root',
            str(chromium),
            'stage',
            '--check',
        ],
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
    )
    if staged.returncode:
        raise RuntimeError('Stale Chromium staged sources: ' + staged.stdout + staged.stderr)
    if (output / '.siso_deps').exists():
        command = [chromium / 'third_party/siso/cipd/siso.exe', 'ninja', '--offline']
    else:
        command = [chromium / 'third_party/ninja/ninja.exe']
    require_no_pending_work(
        'Chromium Browser/SDK',
        [*command, '-C', output, '-n', '-d', 'explain', 'remotekit_browser', 'remotekit_sdk'],
        chromium,
    )
    check_endpoint_freshness(ROOT / 'build/endpoint-package')
    check_control_freshness()


def pinned_node():
    spec = importlib.util.spec_from_file_location('node_runtime', ROOT / 'tools/node_runtime.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.resolve_node()


def create_archive(package, node, *, archive=None):
    """Stream tar into bounded, concatenated zstd frames; no intermediate tar."""
    publish = archive is None
    archive = archive or package.with_name(package.name + '.tar.zst')
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
                with subprocess.Popen(
                    [str(node), '-e', script, str(os.cpu_count() or 1)],
                    stdin=subprocess.PIPE,
                    stdout=output,
                    stderr=errors,
                ) as compressor:
                    writing_error = None
                    try:
                        with tarfile.open(
                            fileobj=compressor.stdin, mode='w|', format=tarfile.PAX_FORMAT
                        ) as tar:
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
                        raise RuntimeError(
                            'zstd compression failed: '
                            + errors.read().decode('utf-8', errors='replace')
                        )
                    if writing_error:
                        raise writing_error
        except Exception:
            output.close()
            archive.unlink(missing_ok=True)
            raise
    checksum = digest(archive)
    if publish:
        archive.with_name(archive.name + '.sha256').write_text(
            checksum + '  ' + archive.name + '\n', encoding='ascii'
        )
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
    spec = importlib.util.spec_from_file_location(
        'setup_face_auth', ROOT / 'tools/setup-face-auth.py'
    )
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
    command = [
        sys.executable,
        '-X',
        'utf8',
        str(ROOT / 'tests/e2e/test-streaming-package.py'),
        '--package',
        str(package),
    ]
    if work_dir is not None:
        command.extend(['--work-dir', str(work_dir)])
    env = os.environ.copy()
    env.update(PYTHONUTF8='1', PYTHONIOENCODING='utf-8')
    smoke = subprocess.run(
        command, capture_output=True, text=True, encoding='utf-8', errors='replace', env=env
    )
    try:
        validation = json.loads(smoke.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f'Bundled startup smoke returned invalid JSON (exit {smoke.returncode}): '
            f'stdout={smoke.stdout!r}; stderr={smoke.stderr!r}'
        ) from error
    if smoke.returncode or not validation.get('passed'):
        raise RuntimeError(
            'Bundled startup smoke failed: '
            + json.dumps(validation, ensure_ascii=False)
            + ('; stderr=' + smoke.stderr if smoke.stderr else '')
        )
    return validation


def validate_runtime_tree(root):
    # Use only explicit runtime inputs above; refuse accidental state, secrets or
    # compiler artifacts before either hashing or archiving the package.
    for file in root.rglob('*'):
        relative = file.relative_to(root)
        if any(
            part.lower() in {'data', 'profiles', 'profile', 'metrics', '.git'}
            for part in relative.parts
        ):
            raise RuntimeError('Non-runtime directory in package: ' + str(relative))
        if file.is_file() and (
            file.name.lower() in {'cred.json', '.env'}
            or file.name.lower().endswith('.key')
            or file.suffix.lower()
            in {
                '.pdb',
                '.obj',
                '.lib',
                '.exp',
                '.ilk',
                '.sqlite',
                '.db',
                '.ts',
                '.tsx',
                '.cpp',
                '.cc',
                '.h',
            }
        ):
            raise RuntimeError('Non-runtime file in package: ' + str(relative))


def write_launcher(file, command, setup='', forward_arguments=False):
    file.write_text(
        '@echo off\nsetlocal DisableDelayedExpansion\n'
        + ('' if forward_arguments else 'if not "%~1"=="" exit /b 1\n')
        + setup
        + command
        + (' %*' if forward_arguments else '')
        + '\nexit /b %errorlevel%\n',
        encoding='ascii',
    )


def main(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium-root', type=Path, default=Path(r'C:\src\chromium\src'))
    parser.add_argument('--out', choices=['dev', 'rel'], default='rel')
    parser.add_argument(
        '--destination', type=Path, default=ROOT / 'develop/tmp'
    )
    parser.add_argument('--endpoint', type=Path)
    parser.add_argument(
        '--smoke',
        action='store_true',
        help='Validate streaming startup/auth/Endpoint management before archiving; real Viewer RTC product/media checks remain required',
    )
    args = parser.parse_args(arguments)
    with tempfile.TemporaryDirectory(prefix="remotekit-runtime-") as staging:
        return package_runtime(args, Path(staging) / "node")


def package_runtime(args, node_runtime):
    chromium = args.chromium_root.resolve()
    output = chromium / 'out' / args.out
    check_freshness(chromium, output)
    source_metadata = source_provenance()
    node = pinned_node()
    browser_name = 'remotekit_browser.exe'
    browser_target = '//remotekit/browser:' + browser_name.removesuffix('.exe')
    endpoint = (
        args.endpoint or ROOT / 'build/endpoint-package/endpoint' / 'endpoint_service.exe'
    ).resolve()
    if not endpoint.is_file():
        raise FileNotFoundError(
            'Build the Release endpoint first: tools\\build-endpoint.cmd package'
        )
    face_files = face_runtime_files()
    runtime = []
    targets = [browser_target]
    targets.append('//remotekit/browser/sdk:remotekit_sdk')
    for target in targets:
        graph = json.loads(
            subprocess.check_output(
                [
                    str(chromium / 'buildtools/win/gn.exe'),
                    'desc',
                    str(output),
                    target,
                    'runtime_deps',
                    '--format=json',
                ],
                cwd=chromium,
                text=True,
            )
        )
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
        if relative.parent == Path('locales') and relative.name not in {'zh-CN.pak', 'en-US.pak'}:
            include = False
        include |= source.name == browser_name
        include |= source.name == 'vk_swiftshader_icd.json'
        if not include:
            excluded.append(str(relative))
            continue
        if not source.is_file():
            raise FileNotFoundError(source)
        selected[relative] = source
    for name in [
        browser_name,
        'remotekit.pak',
        'locales/zh-CN.pak',
        'locales/en-US.pak',
        'icudtl.dat',
        'v8_context_snapshot.bin',
    ]:
        source = output / name
        if not source.is_file():
            raise FileNotFoundError(source)
        selected[Path(name)] = source
    selected[Path("hyphen-data/LICENSE")] = chromium / "third_party/hyphenation-patterns/LICENSE"
    for source in (chromium / "third_party/hyphenation-patterns/hyb").glob("hyph-*.hyb"):
        selected[Path("hyphen-data") / source.name] = source
    # ANGLE and its runtime compiler can be loaded dynamically rather than
    # appear as imports of a particular component DLL.
    for name in [
        'libEGL.dll',
        'libGLESv2.dll',
        'd3dcompiler_47.dll',
        'vk_swiftshader.dll',
        'vk_swiftshader_icd.json',
        'vulkan-1.dll',
    ]:
        if (output / name).is_file():
            selected[Path(name)] = output / name
    # The endpoint uses MSVC's STL, while Chromium uses libc++. Include the
    # release CRT set as well as GN's dependencies so the portable client does
    # not rely on Visual Studio or a separately installed redistributable.
    vs = Path(
        os.environ.get('REMOTEKIT_VS', r'C:\Program Files\Microsoft Visual Studio\18\Community')
    )
    redist = vs / 'VC/Redist/MSVC'
    crt_files = {}
    if redist.is_dir():
        versions = sorted(
            (p for p in redist.iterdir() if p.is_dir() and p.name[0].isdigit()),
            key=lambda p: tuple(int(n) for n in p.name.split('.')),
            reverse=True,
        )
        if versions:
            for crt in (versions[0] / 'x64').glob('Microsoft.VC*.CRT'):
                for dependency in crt.glob('*.dll'):
                    crt_files[dependency.name] = dependency
                    selected.setdefault(Path(dependency.name), dependency)
    backend = 'streaming-qsv-nvenc'
    timestamp = datetime.now(timezone(timedelta(hours=8))).strftime('%Y%m%d-%H%M%S')
    destination = args.destination.resolve() / timestamp
    destination.mkdir(parents=True)
    package = destination / 'RemoteKit-control-win-x64'
    package_name = package.name
    bootstrap = destination / 'RemoteKit-endpoint-win-x64'
    package.mkdir()
    bootstrap.mkdir()
    binary = node_runtime / 'bin'
    binary.mkdir(parents=True)
    print(
        f'Copying {len(selected)} runtime files ({sum(p.stat().st_size for p in selected.values()) / 1048576:.1f} MiB)',
        flush=True,
    )
    for relative, source in selected.items():
        target = binary / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    copy_endpoint(endpoint, binary)
    document_spec = importlib.util.spec_from_file_location(
        'fetch_document_deps', ROOT / 'tools/fetch-document-deps.py'
    )
    document_deps = importlib.util.module_from_spec(document_spec)
    document_spec.loader.exec_module(document_deps)
    for source, relative in document_deps.runtime_trees():
        shutil.copytree(source, binary / relative)
    shutil.copy2(endpoint.parent / 'remotekit_node.exe', binary / 'remotekit_node.exe')
    vpl = endpoint.parent / 'libvpl.dll'
    if not vpl.is_file():
        raise FileNotFoundError('Build endpoint Release dispatcher: ' + str(vpl))
    shutil.copy2(vpl, binary / vpl.name)
    runtime_manifest = json.loads(
        (ROOT / 'control/dist/runtime/manifest.json').read_text(encoding='utf-8')
    )
    node_info = json.loads(
        subprocess.check_output(
            [
                str(node),
                '-p',
                'JSON.stringify({version:process.version,abi:process.versions.modules})',
            ],
            text=True,
        )
    )
    if (
        str(node_info['abi']) != str(runtime_manifest['nodeModuleAbi'])
        or node_info['version'] != runtime_manifest['node']
    ):
        raise RuntimeError(
            'Pinned Node version/ABI does not match Control runtime; rebuild Control'
        )
    control_bin = package / 'bin'
    control_bin.mkdir()
    shutil.copy2(node, control_bin / 'node.exe')
    for folder in (control_bin, bootstrap):
        shutil.copy2(binary / 'remotekit_node.exe', folder / 'remotekit_node.exe')
        for name, source in crt_files.items():
            shutil.copy2(source, folder / name)
    control = package / 'control'
    control.mkdir()
    dist = ROOT / 'control/dist'
    for source in [
        dist / 'server.mjs',
        dist / 'recover-credentials.mjs',
        dist / 'client',
        dist / 'runtime/node_modules',
    ]:
        if not source.exists():
            raise FileNotFoundError('Run npm run build in control first: ' + str(source))
    (control / 'dist').mkdir()
    shutil.copy2(dist / 'server.mjs', control / 'dist/server.mjs')
    shutil.copy2(dist / 'recover-credentials.mjs', control / 'dist/recover-credentials.mjs')
    shutil.copytree(
        dist / 'client', control / 'dist/client', ignore=shutil.ignore_patterns('*.ts', '*.tsx')
    )
    shutil.copytree(dist / 'runtime/node_modules', control / 'node_modules')
    shutil.copy2(dist / 'runtime/manifest.json', control / 'runtime-manifest.json')
    artifacts = {
        'browser_sha256': digest(binary / browser_name),
        'endpoint_sha256': digest(binary / 'endpoint_service.exe'),
        'node_sha256': digest(control_bin / 'node.exe'),
        'control_server_sha256': digest(control / 'dist/server.mjs'),
    }
    licenses = package / 'licenses'
    licenses.mkdir()
    shutil.copy2(ROOT / 'build/dependencies/zstd-1.5.7/LICENSE', licenses / 'zstd-LICENSE')
    for name in ['LICENSE', 'third-party-programs.txt']:
        shutil.copy2(
            ROOT / 'build/dependencies/libvpl-2.17.0' / name, licenses / ('libvpl-' + name)
        )
    if not (node.parent / 'LICENSE').is_file():
        raise FileNotFoundError('Node runtime LICENSE missing')
    shutil.copy2(node.parent / 'LICENSE', licenses / 'Node-LICENSE')
    shutil.copy2(
        ROOT / 'build/dependencies/json-LICENSE.MIT', licenses / 'nlohmann-json-LICENSE.MIT'
    )
    header = (ROOT / 'build/dependencies/nvEncodeAPI.h').read_text(encoding='utf-8')
    (licenses / 'NVENC-header-notice.txt').write_text(
        header[: header.index('*/') + 2], encoding='utf-8'
    )
    copy_face_runtime(face_files, node_runtime)
    (node_runtime / 'licenses').mkdir(exist_ok=True)
    for name in ('zstd-LICENSE', 'nlohmann-json-LICENSE.MIT'):
        shutil.copy2(licenses / name, bootstrap / name)
    for file in licenses.iterdir():
        if file.name != 'Node-LICENSE':
            shutil.copy2(file, node_runtime / 'licenses' / file.name)
    validate_runtime_tree(node_runtime)
    build_lines = []
    for root, tree in [(node_runtime, 'bin'), (package, 'bin'), (package, 'control')]:
        for file in (root / tree).rglob('*'):
            if file.is_file():
                prefix = 'node/' if root == node_runtime else ''
                build_lines.append(f'{prefix}{file.relative_to(root).as_posix()}\t{digest(file)}\n')
    build_id = hashlib.sha256(''.join(sorted(build_lines)).encode('utf-8')).hexdigest()
    for root in (package, node_runtime):
        # build.json and release/node.json are exact runtime contracts; provenance lives in
        # manifest.json.
        (root / 'build.json').write_text(json.dumps({'buildId': build_id}) + '\n', encoding='utf-8')
    (package / 'release').mkdir()
    node_archive, node_checksum = create_archive(
        node_runtime, node, archive=package / 'release/node.tar.zst'
    )
    (package / 'release/node.json').write_text(
        json.dumps(
            {
                'buildId': build_id,
                'sha256': node_checksum,
                'size': node_archive.stat().st_size,
            }
        )
        + '\n',
        encoding='utf-8',
    )
    shutil.copy2(ROOT / 'tools/streaming-launcher.cjs', package / 'run-control.cjs')
    for name, mode in [('run.cmd', 'combined'), ('run-control.cmd', 'control')]:
        write_launcher(package / name, f'"%~dp0bin\\node.exe" "%~dp0run-control.cjs" {mode}')
    # Without a config the command would create a default one and rebuild the wrong database.
    write_launcher(
        package / 'recover-credentials.cmd',
        '"%~dp0bin\\node.exe" "%~dp0control\\dist\\recover-credentials.mjs"',
        'if exist "%~dp0config\\control.json" goto start\n'
        'echo config\\control.json not found; run this in the deployed package directory. 1>&2\n'
        'exit /b 1\n:start\n'
        'set "REMOTEKIT_CONTROL_CONFIG=%~dp0config\\control.json"\n',
        forward_arguments=True,
    )
    write_launcher(
        bootstrap / 'run-endpoint.cmd',
        '"%~dp0remotekit_node.exe" run "--root=%~dp0."',
        'if exist "%~dp0node.json" goto start\n'
        'echo Copy the Control-generated node.json into this directory. 1>&2\n'
        'exit /b 1\n:start\n',
    )
    (package / 'README.txt').write_text(
        'Run run.cmd for Control plus a local Endpoint, or run-control.cmd for Control only.\n'
        'The launchers create config/control.json on first start. Edit it to configure HTTP, storage and nodes.\n'
        'Open http://127.0.0.1:3001 and press Up Up Down Down Left Right Left Right to reveal sign-in.\n'
        'The first account becomes administrator.\n'
        'For a remote node, set cluster.controlUrl and add the node under nodes without a local entry.\n'
        'Control writes config/nodes/<node ID>/node.json; copy it unchanged next to run-endpoint.cmd on that node.\n'
        'Keep release/node.json and release/node.tar.zst together for node installation and updates.\n'
        'If data/control.db is damaged, stop Control and run recover-credentials.cmd: it moves the old\n'
        'database aside and rebuilds it with only accounts, passwords, PINs, faces and sign-ins\n'
        '(--dry-run to preview, --help for options).\n',
        encoding='utf-8',
    )
    (bootstrap / 'README.txt').write_text(
        'Copy config/nodes/<node ID>/node.json from Control here unchanged and run run-endpoint.cmd.\n'
        'The supervisor downloads and starts the matching Endpoint runtime from Control.\n',
        encoding='utf-8',
    )
    validation = None
    if args.smoke:
        validation = run_startup_smoke(package)
        print(
            'Bundled startup/auth/Endpoint management smoke passed (RTC product/media checks separate): '
            + validation['evidence'],
            flush=True,
        )
    validate_runtime_tree(package)
    validate_runtime_tree(bootstrap)
    files = []
    for file in sorted(package.rglob('*')):
        if file.is_file():
            files.append(
                {
                    'path': file.relative_to(package).as_posix(),
                    'bytes': file.stat().st_size,
                    'sha256': digest(file),
                }
            )
    manifest = {
        'name': package_name,
        'buildId': build_id,
        'source': source_metadata,
        'artifacts': artifacts,
        'chromium_revision': subprocess.check_output(
            ['git', 'rev-parse', 'HEAD'], cwd=chromium, text=True
        ).strip(),
        'args_gn_sha256': digest(output / 'args.gn'),
        'architecture': 'x64',
        'presentation_backend': backend,
        'shared_fence_output_implemented': True,
        'browser_endpoint_render_protocol': 'slot-begin-reject-fence-v1',
        'browser_endpoint_per_frame_begin_ipc': True,
        'browser_endpoint_per_frame_reject_ipc': True,
        'browser_endpoint_per_frame_success_ipc': False,
        'endpoint_client_frame_metadata': True,
        'chromium_internal_frame_ipc': True,
        'endpoint_configuration': 'Release',
        'browser_configuration': args.out,
        'archive': package_name + '.tar.zst',
        'archive_format': 'tar.zst',
        'archive_compression': {
            'implementation': 'Node zstd',
            'level': 12,
            'workers': os.cpu_count() or 1,
            'frame_bytes': 32 * 1024 * 1024,
        },
        'runtime_launched': bool(validation and validation.get('passed')),
        'runtime_validation': (
            {
                key: validation[key]
                for key in [
                    'passed',
                    'validationKind',
                    'scope',
                    'browserProductOperationsTested',
                    'rtcMediaTested',
                    'endpointManagementReachable',
                    'webSocketProductActionRejected',
                    'workspaceUnchanged',
                    'endpointSha256',
                    'faceModelsAvailable',
                ]
            }
            if validation
            else None
        ),
        'files': files,
        'excluded_runtime_graph_entries': sorted(set(excluded)),
    }
    (package / 'manifest.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8'
    )
    (bootstrap / 'manifest.json').write_text(
        json.dumps(
            {
                'name': bootstrap.name,
                'buildId': build_id,
                'source': source_metadata,
                'artifacts': artifacts,
                'archive': bootstrap.name + '.tar.zst',
            },
            indent=2,
        )
        + '\n',
        encoding='utf-8',
    )
    print('Creating tar.zst (level 12, all logical CPUs)...', flush=True)
    archives = []
    for folder in (package, bootstrap):
        archive, checksum = create_archive(folder, node)
        archives.append({'path': str(archive), 'bytes': archive.stat().st_size, 'sha256': checksum})
        print(
            json.dumps(
                {
                    'directory': str(folder),
                    'archive': str(archive),
                    'archive_mib': round(archive.stat().st_size / 1048576, 1),
                    'sha256': checksum,
                },
                indent=2,
            ),
            flush=True,
        )
    return {'archives': archives, 'source': source_metadata, 'artifacts': artifacts}


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='backslashreplace')
    sys.stderr.reconfigure(encoding='utf-8', errors='backslashreplace')
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f'error: {error}', file=sys.stderr)
        sys.exit(1)
