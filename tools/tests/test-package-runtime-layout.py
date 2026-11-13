#!/usr/bin/env python3
"""Package layout and installed-layout smoke contract checks without native runtimes."""
import argparse
import ast
import ctypes
from contextlib import ExitStack
import msvcrt
import subprocess
from types import SimpleNamespace
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch, Mock

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
spec = importlib.util.spec_from_file_location('package_runtime', TOOLS / 'package-runtime.py')
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)
SCRATCH = TOOLS.parent / 'develop/tmp'
SCRATCH.mkdir(parents=True, exist_ok=True)


class EndpointLayout(unittest.TestCase):
    def test_process_identity_cleanup_and_etw_allowlist(self):
        script = r"""param([string]$ResourceScript, [string]$EtwScript, [string]$CpuSource, [string]$CaseRoot)
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$resource=[Management.Automation.Language.Parser]::ParseFile($ResourceScript,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors | Out-String)}
$caseRoot=$CaseRoot
$serviceRead=@($resource.EndBlock.Statements | Where-Object {$_.Extent.Text.StartsWith('$service=')})[0]
Invoke-Expression $serviceRead.Extent.Text
$serviceRoots=@{}
function Get-CreationTime([int]$ProcessId) {return [long]($ProcessId*100)}
$rootsLoop=@($resource.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.ForEachStatementAst] -and $_.Variable.Extent.Text -eq '$pair'})[0]
Invoke-Expression $rootsLoop.Extent.Text
if($serviceRoots[101].role -ne 'control-node' -or $serviceRoots[202].role -ne 'source-probe' -or $serviceRoots[101].created -ne 10100){throw 'Current service process contract was not read'}
$remove=$resource.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Remove-Identity'},$true)[0]
Invoke-Expression $remove.Extent.Text
$known=@{11=@{createdFileTime=1};12=@{createdFileTime=2}}
$previousCpu=@{11=9;12=10}
$previousGpu=@{'pid_11_engine'=1;'pid_12_engine'=2;'pid_111_engine'=3}
Remove-Identity 11
if($known.ContainsKey(11) -or $previousCpu.ContainsKey(11) -or $previousGpu.ContainsKey('pid_11_engine')){throw 'Exited identity retained'}
if(!$known.ContainsKey(12) -or !$previousCpu.ContainsKey(12) -or !$previousGpu.ContainsKey('pid_111_engine')){throw 'Other identity removed'}
$etw=[Management.Automation.Language.Parser]::ParseFile($EtwScript,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors | Out-String)}
$pipeline=$etw.FindAll({param($node) $node -is [Management.Automation.Language.PipelineAst] -and $node.Extent.Text.StartsWith('Get-CimInstance Win32_Process|Select-Object')},$true)[0]
function Get-CimInstance { [pscustomobject]@{ProcessId=1;ParentProcessId=2;Name='test.exe';CreationDate='created';CommandLine='secret';ExecutablePath='private'} }
$selected=Invoke-Expression ($pipeline.Extent.Text.Split('|')[0..1] -join '|')
$names=@($selected.PSObject.Properties.Name | Sort-Object)
if(($names -join ',') -ne 'CreationDate,Name,ParentProcessId,ProcessId'){throw 'ETW contains private process fields'}
Add-Type -Path $CpuSource
$cpu=[RemoteKitGpuCounters]::ReadCpu([int[]]@($PID))
$self=Get-Process -Id $PID
try {
 if($cpu.Length -ne 1 -or $cpu[0].CreatedFileTime -ne $self.StartTime.ToUniversalTime().ToFileTimeUtc()){throw 'CPU sample lost process creation identity'}
} finally {$self.Dispose()}

"""
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temporary:
            path = Path(temporary) / 'process-contract.ps1'
            path.write_text(script, encoding='utf-8')
            (Path(temporary) / 'service.json').write_text(json.dumps({'controlPid': 101, 'supervisorPid': 202}), encoding='utf-8')
            subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-File', str(path),
                            str(TOOLS / 'measure/watch-streaming-resources.ps1'),
                            str(TOOLS / 'measure/streaming-etw.ps1'),
                            str(TOOLS / 'measure/windows-gpu-counters.cs'), temporary], check=True, capture_output=True)

    def test_browser_constructor_failure_releases_process_log_and_control(self):
        source = TOOLS.parent / 'tests/integration/test-browser-shutdown-session-storage.py'
        tree = ast.parse(source.read_text(encoding='utf-8'))
        browser_class = next(node for node in ast.walk(tree) if isinstance(node, ast.ClassDef) and node.name == 'Browser')
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temporary:
            closed = []
            process = Mock()
            process.poll.return_value = None
            def fail_connect(read, label):
                instance.handle.value = 23
                raise TimeoutError('injected connection timeout')
            namespace = dict(ExitStack=ExitStack, c=ctypes, run=Path(temporary),
                             browser_path=Path('browser.exe'), os=os, msvcrt=msvcrt, key=b'key',
                             uuid=__import__('uuid'), subprocess=subprocess, wait_for=fail_connect,
                             sdk=SimpleNamespace(remotekit_sdk_control_close=lambda handle: closed.append(handle.value)))
            exec(compile(ast.Module(body=[browser_class], type_ignores=[]), str(source), 'exec'), namespace)
            instance = namespace['Browser'].__new__(namespace['Browser'])
            with patch.object(subprocess, 'Popen', return_value=process):
                with self.assertRaisesRegex(TimeoutError, 'injected connection timeout'):
                    instance.__init__('failed')
            self.assertEqual(closed, [23])
            process.kill.assert_called_once()
            process.wait.assert_called_once()
            self.assertTrue(instance.log.closed)

    def test_control_freshness_includes_build_entry_inputs(self):
        inputs = ['control/index.html', 'control/vite.config.ts', 'control/package.json',
                  'control/package-lock.json', 'tools/build-control-server.mjs']
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temporary:
            root = Path(temporary)
            for name in inputs + ['control/client/main.ts', 'control/server/main.ts', 'control/shared/main.ts']:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('source')
                os.utime(path, ns=(1000000000, 1000000000))
            for name in ['server.mjs', 'recover-credentials.mjs', 'client/index.html', 'runtime/manifest.json']:
                path = root / 'control/dist' / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('artifact')
                os.utime(path, ns=(2000000000, 2000000000))
            with patch.object(packager, 'ROOT', root):
                packager.check_control_freshness()
                for name in inputs:
                    path = root / name
                    os.utime(path, ns=(3000000000, 3000000000))
                    with self.assertRaisesRegex(RuntimeError, 'Stale Control'):
                        packager.check_control_freshness()
                    os.utime(path, ns=(1000000000, 1000000000))

    def test_sdk_export_replaces_destination_after_complete_staging(self):
        spec = importlib.util.spec_from_file_location('export_sdk', TOOLS / 'export-sdk.py')
        exporter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(exporter)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temporary:
            root = Path(temporary)
            output = root / 'out'
            output.mkdir()
            for name in ['remotekit_sdk.dll', 'remotekit_sdk.lib', 'args.gn', 'current.dll']:
                (output / name).write_bytes(b'fixture')
            (output / 'remotekit_sdk.runtime_deps').write_text('current.dll\n')
            destination = root / 'sdk'
            (destination / 'bin').mkdir(parents=True)
            (destination / 'bin/stale.dll').write_bytes(b'previous')
            argv = ['export-sdk.py', '--out', str(output), '--destination', str(destination)]
            with patch.object(sys, 'argv', argv), patch.object(exporter, 'build_metadata', return_value={}):
                with patch.object(exporter.shutil, 'copy2', side_effect=OSError('copy failed')):
                    with self.assertRaisesRegex(OSError, 'copy failed'):
                        exporter.main()
                self.assertEqual((destination / 'bin/stale.dll').read_bytes(), b'previous')
                exporter.main()
                self.assertFalse((destination / 'bin/stale.dll').exists())
                self.assertTrue((destination / 'bin/current.dll').is_file())
                self.assertTrue((destination / 'manifest.json').is_file())
                self.assertEqual({path.name for path in root.iterdir()}, {'out', 'sdk'})

    def test_version_tree_and_payload(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temporary:
            root = Path(temporary)
            repo = root / 'repo'
            chromium = root / 'chromium'
            output = chromium / 'out/rel'
            endpoint = repo / 'build/endpoint-package/endpoint/endpoint_service.exe'
            node = root / 'pinned/node.exe'

            def put(file, data=b'fixture'):
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(data)

            for file in ('remotekit_browser.exe', 'remotekit.pak', 'locales/zh-CN.pak',
                         'locales/en-US.pak', 'icudtl.dat', 'v8_context_snapshot.bin', 'args.gn'):
                put(output / file)
            put(chromium / 'third_party/hyphenation-patterns/LICENSE')
            put(endpoint)
            for name in ('remotekit_node.exe', 'remotekit_control.exe', 'remotekit_snapshot.exe', 'libvpl.dll'):
                put(endpoint.parent / name)
            put(node)
            put(node.parent / 'LICENSE')
            for name in ('zstd-1.5.7/LICENSE', 'libvpl-2.17.0/LICENSE',
                         'libvpl-2.17.0/third-party-programs.txt', 'json-LICENSE.MIT'):
                put(repo / 'build/dependencies' / name)
            put(repo / 'build/dependencies/nvEncodeAPI.h', b'/* notice */')
            for name in ('server.mjs', 'recover-credentials.mjs', 'client/index.html',
                         'runtime/node_modules/native/binding.node'):
                put(repo / 'control/dist' / name)
            put(repo / 'control/dist/runtime/manifest.json',
                json.dumps({'nodeModuleAbi': '137', 'node': 'v24.20.0'}).encode())
            crt = root / 'vs/VC/Redist/MSVC/14.0/x64/Microsoft.VC143.CRT/msvcp140.dll'
            put(crt)

            def check_output(command, **kwargs):
                if command[0] == 'git':
                    return 'a' * 40
                if command[0] == str(node):
                    return json.dumps({'version': 'v24.20.0', 'abi': '137'})
                return json.dumps({command[3]: {'runtime_deps': []}})

            args = argparse.Namespace(chromium_root=chromium, out='rel', endpoint=None,
                                      destination=root / 'packages', smoke=True)
            validation = {
                key: True for key in (
                    'passed', 'endpointManagementReachable', 'webSocketOperationCommitted',
                )
            }
            validation.update(validationKind='startup', scope='fixture',
                              browserProductOperationsTested=False, rtcMediaTested=False,
                              endpointSha256='f' * 64)
            with patch.object(packager, 'ROOT', repo), \
                 patch.object(packager, 'check_freshness'), \
                 patch.object(packager, 'source_provenance', return_value={'commit': 'a' * 40, 'dirty': False}), \
                 patch.object(packager, 'pinned_node', return_value=node), \
                 patch.object(packager, 'imaging_runtime_files', return_value=[]), \
                 patch.object(packager, 'document_runtime_trees', return_value=[]), \
                 patch.object(packager, 'run_startup_smoke', return_value=validation) as smoke, \
                 patch.object(packager.subprocess, 'run') as install, \
                 patch.object(packager.subprocess, 'check_output', side_effect=check_output), \
                 patch.dict(os.environ, {'REMOTEKIT_VS': str(root / 'vs')}):
                result = packager.package_runtime(args, root / 'staging/node')
            tree = Path(result['directory'])
            self.assertEqual(tree.name, 'RemoteKit-control-' + result['buildId'][:12])
            self.assertEqual({file.name for file in (tree / 'bin').iterdir()},
                             {'node.exe', 'remotekit_control.exe', 'remotekit_node.exe'})
            self.assertTrue((tree / 'node/bin/msvcp140.dll').is_file())
            self.assertFalse((tree / 'release').exists())
            self.assertEqual(json.loads((tree / 'node/build.json').read_text())['buildId'], result['buildId'])
            recovery = (tree / 'recover-credentials.cmd').read_text()
            self.assertIn('%~dp0..\\..\\config\\control.json', recovery)
            manifest = json.loads((tree / 'manifest.json').read_text())
            self.assertNotIn('archive', manifest)
            self.assertEqual(manifest['buildId'], result['buildId'])
            self.assertTrue(manifest['runtime_launched'])
            self.assertEqual(manifest['runtime_validation'], validation)
            deployment = tree.parent / 'smoke-root'
            smoke.assert_called_once_with(deployment)
            self.assertEqual(install.call_args.args[0], [
                str(deployment / 'remotekit_control.exe'), 'install',
                '--root=' + str(deployment), '--payload=' + result['payload'],
            ])
            with tarfile.open(result['payload']) as payload:
                self.assertIn('node/bin/endpoint_service.exe', payload.getnames())
                self.assertEqual(payload.extractfile('manifest.json').read(), (tree / 'manifest.json').read_bytes())
            self.assertEqual(json.loads((tree.parent / 'payload.json').read_text())['sha256'], result['sha256'])
            self.assertEqual(list(tree.parent.glob('*.zst')), [])

    def test_override_endpoint_name(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temporary:
            root = Path(temporary)
            source = root / 'custom service.exe'
            source.write_bytes(b'endpoint fixture')
            binary = root / 'bin'
            binary.mkdir()
            result = packager.copy_endpoint(source, binary)
            self.assertEqual(result, binary / 'endpoint_service.exe')
            self.assertEqual(result.read_bytes(), source.read_bytes())

    def test_startup_failure_preserves_structured_unicode_evidence(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temporary:
            root = Path(temporary)
            missing = root / '\u7f3a\u5c11\u8fd0\u884c\u5305'
            with patch.dict(os.environ, {'PYTHONIOENCODING': 'cp936', 'PYTHONUTF8': '0'}):
                with self.assertRaises(RuntimeError) as caught:
                    packager.run_startup_smoke(missing, work_dir=root / 'evidence')
            self.assertIn('"passed": false', str(caught.exception))
            self.assertIn(missing.name, str(caught.exception))
            result = next((root / 'evidence').glob('*/result.json'))
            self.assertIn('current', result.read_text(encoding='utf-8'))

    def test_imaging_runtime_copies_only_catalogued_paths(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temporary:
            root = Path(temporary)
            source = root / 'model.onnx'
            source.write_bytes(b'model')
            package = root / 'package'
            files = [(source, Path('bin/models/recognition.onnx'))]
            packager.copy_imaging_runtime(files, package)
            self.assertEqual((package / files[0][1]).read_bytes(), b'model')
            with self.assertRaisesRegex(RuntimeError, 'collides with a runtime file'):
                packager.copy_imaging_runtime(files, package)


if __name__ == '__main__':
    unittest.main()
