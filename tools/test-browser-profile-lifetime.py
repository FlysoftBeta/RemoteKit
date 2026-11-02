#!/usr/bin/env python3
"""Functional Browser regression without media peers or host clipboard access.

Checks encrypted persistent-cookie restart/isolation, whole-batch visibility
rejection, restore, and normal shutdown while a real popup is pending.
"""
import argparse
import ctypes as c
from contextlib import closing
import http.server
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def wait_for(predicate, label, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(.05)
    raise AssertionError('Timed out: ' + label)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', type=Path, default=Path('C:/src/chromium/src/out/dev/remotekit_browser.exe'))
    parser.add_argument('--work-dir', type=Path, default=ROOT / 'develop/tmp/browser-profile-lifetime')
    args = parser.parse_args()
    run = args.work_dir.resolve() / str(time.time_ns())
    run.mkdir(parents=True)
    dll_directory = os.add_dll_directory(str(args.browser.parent))
    sdk = c.CDLL(str(args.browser.parent / 'remotekit_sdk.dll'))
    sdk.remotekit_sdk_control_connect.argtypes = [c.c_char_p, c.POINTER(c.c_uint64)]
    sdk.remotekit_sdk_control_request.argtypes = [c.c_uint64, c.c_void_p, c.c_size_t, c.c_void_p, c.c_size_t, c.POINTER(c.c_size_t), c.c_uint32]
    sdk.remotekit_sdk_control_close.argtypes = [c.c_uint64]
    assert sdk.remotekit_sdk_initialize() == 0
    evidence = []
    observed = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            path = urlsplit(self.path).path
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            if path == '/set':
                self.send_header('Set-Cookie', 'rk_persistent=keep; Max-Age=3600; Path=/; SameSite=Lax')
                self.send_header('Set-Cookie', 'rk_session=ephemeral; Path=/; SameSite=Lax')
            self.end_headers()
            observed[self.path] = self.headers.get('Cookie', '')
            if path == '/popup':
                body = '<title>pending popup</title><script>alert("pending-popup-dialog")</script>'
            elif path.startswith('/clipboard-'):
                seed = path.removeprefix('/clipboard-')
                body = '''<title>ready</title><textarea autofocus style="position:absolute;left:0;top:0;width:250px;height:100px"></textarea><script>
                  const seed=SEED;
                  document.addEventListener('copy', e=>{e.clipboardData.setData('text/plain',seed);e.clipboardData.setData('text/html','<b>'+seed+'</b>');e.preventDefault();document.title='copied:'+seed;});
                  document.addEventListener('paste', e=>{document.title='pasted:'+JSON.stringify({text:e.clipboardData.getData('text/plain'),html:e.clipboardData.getData('text/html')});e.preventDefault();});
                </script>'''.replace('SEED', json.dumps(seed))
            else:
                body = '<title>ready</title><button style="position:absolute;left:0;top:0;width:200px;height:80px" onclick="window.open(\'/popup\')">popup</button>'
            self.wfile.write(body.encode())

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = 'http://127.0.0.1:' + str(server.server_port)

    class Browser:
        def __init__(self, data, tag):
            self.tag = tag
            self.sequence = 0
            self.handle = c.c_uint64()
            self.log = (run / (tag + '.log')).open('wb')
            channel = 'RemoteKit.profileLifetime.' + str(time.time_ns())
            self.process = subprocess.Popen([
                str(args.browser), '--control-channel=' + channel,
                '--session-id=1', '--tenant-id=' + tag,
                '--remotekit-render-host=offscreen', '--data-path=' + str(data),
                '--log-net-log=' + str(run / (tag + '.netlog.json')),
            ], stdout=self.log, stderr=self.log, creationflags=subprocess.CREATE_NO_WINDOW)
            try:
                wait_for(lambda: sdk.remotekit_sdk_control_connect(channel.encode(), c.byref(self.handle)) == 0,
                         tag + ' control connection')
            except BaseException:
                self.close(force=True)
                raise

        def rpc(self, method, ok=True, **kwargs):
            request = dict(version=1, id=len(evidence) + 1, method=method, session='1', **kwargs)
            data = json.dumps(request).encode()
            output = c.create_string_buffer(1024 * 1024)
            size = c.c_size_t()
            status = sdk.remotekit_sdk_control_request(self.handle, data, len(data), output, len(output), c.byref(size), 10000)
            assert status == 0, (self.tag, method, status)
            reply = json.loads(output.raw[:size.value])
            evidence.append(dict(browser=self.tag, request=request, response=reply))
            assert reply['ok'] is ok, reply
            return reply

        def snapshot(self):
            return self.rpc('snapshot')['sessions'][0]

        def views(self):
            return self.snapshot()['views']

        def create(self, view, path, visible=True):
            self.rpc('view.create', view=str(view), url=origin + path, width=320, height=240,
                     visible=visible, device='desktop')
            wait_for(lambda: any(v.get('view') == str(view) and v.get('title') == 'ready' and not v.get('loading')
                                 for v in self.views()), 'page ready')

        def ready(self, view):
            return wait_for(lambda: next((v for v in self.views() if v['view'] == str(view) and v.get('title') == 'ready' and not v.get('loading')), None), 'page ready')

        def focus(self, view):
            token = next(v for v in self.views() if v['view'] == str(view))
            return self.rpc('focus', view=str(view), focused=True,
                            **{key: token[key] for key in ('instance', 'document', 'focus')})

        def click(self, view):
            self.focus(view)
            for action in ('down', 'up'):
                token = next(v for v in self.views() if v['view'] == str(view))
                self.sequence += 1
                self.rpc('input', view=str(view), sequence=str(self.sequence),
                         **{key: token[key] for key in ('instance', 'document', 'focus')},
                         event=dict(type='mouse', action=action, x=50, y=40, button=1, click_count=1))

        def clipboard_shortcut(self, view, key):
            # Chromium DomKey::FromCharacter uses TF_CODEPOINT (1 << 22).
            windows, physical, dom_code = (67, 0x2e, 0x70006) if key == 'c' else (86, 0x2f, 0x70019)
            for action in ('down', 'up'):
                token = next(v for v in self.views() if v['view'] == str(view))
                self.sequence += 1
                self.rpc('input', view=str(view), sequence=str(self.sequence),
                         **{name: token[name] for name in ('instance', 'document', 'focus')},
                         event=dict(type='key', action=action, physical_code=physical,
                                    windows_key_code=windows, dom_code=dom_code,
                                    dom_key=str((1 << 22) | windows), modifiers=2))

        def close(self, force=False):
            try:
                if self.process.poll() is None and self.handle.value:
                    try:
                        self.rpc('shutdown')
                    except BaseException:
                        if not force:
                            raise
                if self.handle.value:
                    sdk.remotekit_sdk_control_close(self.handle)
                    self.handle.value = 0
                try:
                    self.process.wait(timeout=3 if force else 15)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
                    if not force:
                        raise AssertionError('Browser shutdown timeout: ' + self.tag)
                if not force:
                    assert self.process.returncode == 0, (self.tag, self.process.returncode)
            finally:
                self.log.close()

    active = []
    try:
        a = Browser(run / 'tenant-a', 'a-first')
        active.append(a)
        a.create(1, '/set')
        a.rpc('navigate', view='1', url=origin + '/observe-live')
        wait_for(lambda: '/observe-live' in observed, 'live cookies')
        assert 'rk_persistent=keep' in observed['/observe-live']
        assert 'rk_session=ephemeral' in observed['/observe-live']
        a.close()
        active.remove(a)
        database = run / 'tenant-a/session-1/profile-1/Network/Cookies'
        # sqlite3.Connection's context manager commits/rolls back a transaction;
        # it does not close the database handle. Close before Chromium reopens
        # the cookie DB with Windows exclusive database-file locking.
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as connection:
            rows = connection.execute('SELECT name, value, encrypted_value FROM cookies WHERE name = ?', ('rk_persistent',)).fetchall()
        assert len(rows) == 1 and rows[0][1] == '' and rows[0][2], rows

        a = Browser(run / 'tenant-a', 'a-restart')
        active.append(a)
        a.create(1, '/observe-restart')
        assert 'rk_persistent=keep' in observed['/observe-restart']
        assert 'rk_session=' not in observed['/observe-restart']
        b = Browser(run / 'tenant-b', 'b')
        active.append(b)
        b.create(1, '/observe-other')
        assert 'rk_persistent=' not in observed['/observe-other']

        a.create(2, '/second', visible=False)
        a.rpc('lifecycle', view='2', action='unload')
        wait_for(lambda: any(v['view'] == '2' and v['actual'] == 3 and not v['pending'] for v in a.views()), 'unload')
        before = a.views()
        configs = [dict(session='1', view=str(view), width=360, height=260,
                        device='desktop', device_scale_factor=1, visible=True) for view in (1, 2)]
        rejected = a.rpc('output.configure', ok=False, viewConfigs=configs)
        assert rejected['error'] == 'restore_required_before_show', rejected
        after = a.views()
        fields = ('view', 'width', 'height', 'visible', 'device_scale_factor', 'instance', 'document', 'focus', 'actual', 'pending')
        assert [{k: v.get(k) for k in fields} for v in before] == [{k: v.get(k) for k in fields} for v in after]
        a.rpc('lifecycle', view='2', action='restore')
        wait_for(lambda: any(v['view'] == '2' and v['actual'] == 0 and not v['pending'] for v in a.views()), 'restore')
        a.rpc('output.configure', viewConfigs=configs)
        assert all(v['visible'] and v['width'] == 360 for v in a.views())

        # Real hit-testing/input routing is bound when source rendering is
        # demanded. No Endpoint/Viewer media peer or timing experiment is used.
        a.rpc('output.open', consumer_pid=str(os.getpid()), fps=10)
        wait_for(lambda: int(a.rpc('output.status')['output'].get('capture_callbacks', '0')) > 0, 'source capture')
        b.rpc('output.open', consumer_pid=str(os.getpid()), fps=10)
        wait_for(lambda: int(b.rpc('output.status')['output'].get('capture_callbacks', '0')) > 0, 'other source capture')
        for browser, view, seed in ((a, 1, 'tenant-a-only'), (b, 1, 'tenant-b-only'), (a, 2, 'empty')):
            browser.rpc('navigate', view=str(view), url=origin + '/clipboard-' + seed)
            browser.ready(view)
            browser.click(view)
            if seed != 'empty':
                if browser is b:
                    browser.clipboard_shortcut(view, 'c')
                else:
                    browser.rpc('page.command', view=str(view), action='copy')
                wait_for(lambda: any(v['view'] == str(view) and v.get('title') == 'copied:' + seed for v in browser.views()), 'clipboard copy')
        for browser, view, seed in ((a, 1, 'tenant-a-only'), (b, 1, 'tenant-b-only'), (a, 2, 'tenant-a-only')):
            browser.click(view)
            if view == 2:
                browser.clipboard_shortcut(view, 'v')
            else:
                browser.rpc('page.command', view=str(view), action='paste')
            pasted = wait_for(lambda: next((v.get('title')[7:] for v in browser.views() if v['view'] == str(view) and v.get('title', '').startswith('pasted:')), None), 'clipboard paste')
            payload = json.loads(pasted)
            assert payload['text'] == seed and '<b>' + seed + '</b>' in payload['html'], payload

        a.rpc('navigate', view='1', url=origin + '/popup-opener')
        a.ready(1)
        a.click(1)
        wait_for(lambda: any(p['status'] == 'pending' for p in a.snapshot()['pendingPopups']), 'real pending popup')
        a.close()
        active.remove(a)
        b.close()
        active.remove(b)
    finally:
        failed = sys.exc_info()[0] is not None
        cleanup_errors = []
        for browser in active:
            try:
                browser.close(force=True)
            except BaseException as error:
                cleanup_errors.append(repr(error))
        try:
            server.shutdown()
            server.server_close()
            status = sdk.remotekit_sdk_shutdown()
            if status != 0:
                cleanup_errors.append('SDK shutdown status: ' + str(status))
            dll_directory.close()
        except BaseException as error:
            cleanup_errors.append(repr(error))
        (run / 'evidence.json').write_text(json.dumps(evidence, indent=2), encoding='utf-8')
        (run / 'observations.json').write_text(json.dumps(observed, indent=2), encoding='utf-8')
        (run / 'cleanup-errors.json').write_text(json.dumps(cleanup_errors, indent=2), encoding='utf-8')
        if cleanup_errors and not failed:
            raise AssertionError(cleanup_errors)
    print(json.dumps(dict(passed=True, evidence=str(run))))


if __name__ == '__main__':
    main()
