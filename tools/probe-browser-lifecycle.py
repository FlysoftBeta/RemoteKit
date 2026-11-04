#!/usr/bin/env python3
"""Isolated production Browser freeze race and guarded recovery, without media."""

import argparse
import ctypes
import http.server
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]


def wait_for(read, accepted, label, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = read()
        if accepted(value):
            return value
        time.sleep(0.04)
    raise AssertionError((label, value))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', type=Path, default=Path('C:/src/chromium/src/out/dev/remotekit_browser.exe'))
    parser.add_argument('--work-dir', type=Path, default=ROOT / 'develop/tmp/browser-lifecycle')
    parser.add_argument('--case', choices=('default', 'races', 'timeout', 'frozen-crash'), default='default')
    parser.add_argument('--frozen-crash', action='store_true', help='Also run the isolated frozen-renderer exit case')
    args = parser.parse_args()
    browser_path = args.browser.resolve()
    if not browser_path.is_file() or not (browser_path.parent / 'remotekit_sdk.dll').is_file():
        parser.error('Use a built production Browser and its matching SDK DLL')
    run = args.work_dir.resolve() / uuid.uuid4().hex[:12]
    run.mkdir(parents=True)
    slow_requested = threading.Event()
    slow_release = threading.Event()
    hits = {}

    class Fixture(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            hits[self.path] = hits.get(self.path, 0) + 1
            body = '<title>ready</title>'
            if self.path == '/race':
                body += '''<script>
                window.heapProof = Math.random();
                const original = window.heapProof;
                document.addEventListener('freeze', () => {
                  history.pushState(null, '', '#raced');
                  document.title = 'freeze event';
                }, {once:true});
                document.addEventListener('resume', () => {
                  document.title = window.heapProof === original ? 'same heap resumed' : 'heap replaced';
                }, {once:true});
                </script>'''
            elif self.path == '/cross-race':
                cross_origin = f'http://localhost:{self.server.server_port}'
                body += f'''<iframe src="/fast-frame"></iframe><script>
                const crossOrigin = {json.dumps(cross_origin)};
                document.addEventListener('freeze', () => {{
                  document.querySelector('iframe').src = crossOrigin + '/slow-frame';
                }}, {{once:true}});
                window.addEventListener('message', event => {{
                  if (event.origin === crossOrigin) document.title = event.data;
                }});
                </script>'''
            elif self.path == '/slow-frame':
                slow_requested.set()
                slow_release.wait(20)
                body += '''<script>
                document.addEventListener('freeze', () => parent.postMessage('new child frozen', '*'));
                setTimeout(() => parent.postMessage('new child running', '*'), 100);
                </script>'''
            elif self.path == '/timeout':
                body += '''<script>
                document.addEventListener('freeze', () => {
                  document.title = 'freeze hook blocking';
                  const deadline = performance.now() + 12000;
                  while (performance.now() < deadline) {}
                  document.title = 'late freeze acknowledgement';
                }, {once:true});
                </script>'''
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body.encode())

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    channel = 'RemoteKit.lifecycleProbe.' + uuid.uuid4().hex
    dll_dir = os.add_dll_directory(str(browser_path.parent))
    sdk = ctypes.CDLL(str(browser_path.parent / 'remotekit_sdk.dll'))
    sdk.remotekit_sdk_control_connect.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint64)]
    sdk.remotekit_sdk_control_request.argtypes = [ctypes.c_uint64, ctypes.c_void_p, ctypes.c_size_t,
        ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t), ctypes.c_uint32]
    sdk.remotekit_sdk_control_close.argtypes = [ctypes.c_uint64]
    assert sdk.remotekit_sdk_initialize() == 0
    handle = ctypes.c_uint64()
    transcript = []

    def rpc(method, *, ok=True, **fields):
        request = dict(version=1, id=len(transcript) + 1, method=method, session='1', **fields)
        data = json.dumps(request).encode()
        out = ctypes.create_string_buffer(1024 * 1024)
        length = ctypes.c_size_t()
        status = sdk.remotekit_sdk_control_request(handle, data, len(data), out, len(out), ctypes.byref(length), 5000)
        assert status == 0, (method, status)
        response = json.loads(out.raw[:length.value])
        transcript.append((request, response))
        assert response['ok'] == ok, response
        return response

    def view(id):
        return next(item for item in rpc('snapshot')['sessions'][0]['views'] if item['view'] == id)

    def create(id, fixture, visible):
        rpc('view.create', view=id, url=origin + fixture, visible=visible,
            width=320, height=240, device='desktop')
        return wait_for(lambda: view(id), lambda v: v.get('title') == 'ready' and not v.get('loading'), fixture)

    def completed(id):
        return wait_for(lambda: view(id), lambda v: not v['pending'], 'lifecycle completion')

    def crash_frozen(browser, id):
        assert browser.poll() is None
        # The Browser was started by this probe. Record and recheck both
        # generations and terminate only its own matching renderer children.
        env = os.environ | {'RK_PROBE_BROWSER_PID': str(browser.pid), 'RK_PROBE_BROWSER_PATH': str(browser_path),
                            'RK_PROBE_RENDERER_EVIDENCE': str(run / 'terminated-renderers.json')}
        subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', r'''
            $ErrorActionPreference = 'Stop'
            $parentId = [int]$env:RK_PROBE_BROWSER_PID
            $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $parentId"
            if (!$parent -or $parent.ExecutablePath -ne $env:RK_PROBE_BROWSER_PATH) {
              throw 'Probe Browser identity mismatch'
            }
            $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $parentId" |
              Where-Object { $_.ExecutablePath -eq $parent.ExecutablePath -and $_.CommandLine -match '(?:^|\s)--type=renderer(?:\s|$)' })
            if (!$children) { throw 'No isolated renderer child found' }
            $records = @($parent; $children) | Select-Object ProcessId, ParentProcessId, CreationDate, ExecutablePath
            $records | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $env:RK_PROBE_RENDERER_EVIDENCE
            foreach ($child in $children) {
              $currentParent = Get-CimInstance Win32_Process -Filter "ProcessId = $parentId"
              $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($child.ProcessId)"
              if (!$currentParent -or $currentParent.CreationDate -ne $parent.CreationDate -or
                  $currentParent.ExecutablePath -ne $parent.ExecutablePath -or !$current -or
                  $current.CreationDate -ne $child.CreationDate -or $current.ParentProcessId -ne $parentId -or
                  $current.ExecutablePath -ne $child.ExecutablePath -or $current.CommandLine -ne $child.CommandLine) {
                throw 'Isolated renderer process changed before termination'
              }
              Stop-Process -Id $current.ProcessId
            }
        '''], env=env, check=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW)
        return wait_for(lambda: view(id), lambda v: v.get('crashed') and v['lifecycle_uncertain'], 'frozen renderer crash')

    with (run / 'browser.log').open('wb') as log:
        command = [str(browser_path), '--control-channel=' + channel,
            '--session-id=1', '--tenant-id=lifecycle-probe', '--remotekit-render-host=offscreen',
            '--data-path=' + str(run / 'data')]
        browser = subprocess.Popen(command, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            wait_for(lambda: sdk.remotekit_sdk_control_connect(channel.encode(), ctypes.byref(handle)),
                     lambda status: status == 0, 'control connection')
            if args.case != 'frozen-crash':
                foreground = create('1', '/foreground', True)
            if args.case in ('default', 'races'):
                race = create('2', '/race', False)
                rpc('lifecycle', view='2', action='freeze')
                cancelled = completed('2')
                assert cancelled['actual'] == 0 and not cancelled['lifecycle_uncertain'], cancelled
                assert cancelled['last_lifecycle']['succeeded'] is False, cancelled
                assert 'Freeze cancelled' in cancelled['last_lifecycle']['detail'], cancelled
                resumed = wait_for(lambda: view('2'), lambda v: v['title'] == 'same heap resumed', 'same heap after thaw')
                assert resumed['url'].endswith('/race#raced') and resumed['instance'] == race['instance'], resumed
                rpc('lifecycle', view='2', action='freeze')
                assert completed('2')['actual'] == 1
                rpc('lifecycle', view='2', action='restore')
                assert completed('2')['actual'] == 0

                cross = create('5', '/cross-race', False)
                rpc('lifecycle', view='5', action='freeze')
                assert slow_requested.wait(4), 'Cross-site frame navigation did not start during freeze'
                cancelled = completed('5')
                assert cancelled['actual'] == 0 and not cancelled['lifecycle_uncertain'], cancelled
                assert not cancelled['last_lifecycle']['succeeded'], cancelled
                assert cancelled['instance'] == cross['instance'] and cancelled['document'] == cross['document'], cancelled
                slow_release.set()
                wait_for(lambda: view('5'), lambda v: v['title'] == 'new child running', 'new cross-site renderer executes')

            if args.case in ('default', 'timeout'):
                timeout = create('3', '/timeout', False)
                rpc('lifecycle', view='3', action='freeze')
                wait_for(lambda: view('3'), lambda v: v['title'] == 'freeze hook blocking', 'bounded blocking renderer hook', 4)
                uncertain = completed('3')
                assert uncertain['lifecycle_uncertain'] and not uncertain['last_lifecycle']['succeeded'], uncertain
                assert 'timed out' in uncertain['last_lifecycle']['detail'], uncertain
                late = wait_for(lambda: view('3'), lambda v: v['title'] == 'late freeze acknowledgement', 'late renderer completion')
                assert late['lifecycle_uncertain'] and late['lifecycle_generation'] == uncertain['lifecycle_generation'], late
                rejected = rpc('lifecycle', ok=False, view='3', action='unload',
                               expected_lifecycle_generation=timeout['lifecycle_generation'])
                assert rejected['error'] == 'stale_lifecycle_recovery', rejected
                assert view('3')['instance'] == timeout['instance']
                unloaded = rpc('lifecycle', view='3', action='unload',
                               expected_lifecycle_generation=uncertain['lifecycle_generation'])
                assert unloaded['completed'] and not unloaded['pending'], unloaded
                restored = rpc('lifecycle', view='3', action='restore',
                               expected_lifecycle_generation=unloaded['lifecycleGeneration'])
                ready = completed('3')
                assert ready['actual'] == 0 and not ready['lifecycle_uncertain'], ready
                assert ready['last_lifecycle']['generation'] == restored['lifecycleGeneration'] and ready['last_lifecycle']['succeeded'], ready
                assert ready['url'] == timeout['url'] and ready['instance'] != timeout['instance'], ready
                assert hits['/timeout'] == 2, hits
            if args.case != 'frozen-crash':
                kept = view('1')
                assert kept['visible'] and kept['instance'] == foreground['instance'], kept
            if args.case == 'frozen-crash' or args.frozen_crash:
                for item in rpc('snapshot')['sessions'][0]['views']:
                    rpc('view.close', view=item['view'], force=True)
                target = create('4', '/crash-target', False)
                rpc('lifecycle', view='4', action='freeze')
                frozen = completed('4')
                assert frozen['actual'] == 1 and not frozen['lifecycle_uncertain'], frozen
                crashed = crash_frozen(browser, '4')
                assert crashed['actual'] == 1 and not crashed['pending'] and crashed['instance'] != frozen['instance'], crashed
                unloaded = rpc('lifecycle', view='4', action='unload', expected_lifecycle_generation=crashed['lifecycle_generation'])
                rpc('lifecycle', view='4', action='restore', expected_lifecycle_generation=unloaded['lifecycleGeneration'])
                recovered = completed('4')
                assert recovered['actual'] == 0 and not recovered['lifecycle_uncertain'] and recovered['url'] == target['url'], recovered
            print(json.dumps(dict(passed=True, evidence=str(run), hits=hits)))
        finally:
            slow_release.set()
            if handle.value:
                try:
                    if browser.poll() is None:
                        try:
                            rpc('shutdown')
                        except Exception as cleanup_error:
                            (run / 'shutdown-error.txt').write_text(repr(cleanup_error), encoding='utf-8')
                finally:
                    sdk.remotekit_sdk_control_close(handle)
            try:
                browser.wait(timeout=5)
            except subprocess.TimeoutExpired:
                browser.kill()
                browser.wait()
            sdk.remotekit_sdk_shutdown()
            dll_dir.close()
            server.shutdown()
            server.server_close()
            (run / 'transcript.json').write_text(json.dumps(transcript, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
