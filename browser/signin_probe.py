"""Exercise purpose-scoped Browser sign-in through the production C ABI."""

import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlencode, quote

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests/integration'))
from browser_key import spawn_browser


def main():
    browser_path = Path('C:/src/chromium/src/out/dev/remotekit_browser.exe')
    run = ROOT / 'develop/tmp/signin' / ('browser-' + uuid.uuid4().hex[:12])
    run.mkdir(parents=True)
    dll_directory = os.add_dll_directory(str(browser_path.parent))
    sdk = ctypes.CDLL(str(browser_path.parent / 'remotekit_sdk.dll'))
    sdk.remotekit_sdk_control_connect.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint64)]
    sdk.remotekit_sdk_control_request.argtypes = [
        ctypes.c_uint64, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p,
        ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t), ctypes.c_uint32,
    ]
    sdk.remotekit_sdk_control_close.argtypes = [ctypes.c_uint64]
    sdk.remotekit_sdk_windows_dom_code.argtypes = [ctypes.c_uint32]
    sdk.remotekit_sdk_windows_dom_code.restype = ctypes.c_uint32
    sdk.remotekit_sdk_windows_dom_key.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint64]
    sdk.remotekit_sdk_windows_dom_key.restype = ctypes.c_uint64
    assert sdk.remotekit_sdk_initialize() == 0
    channel = 'RemoteKit.signin.' + uuid.uuid4().hex
    handle = ctypes.c_uint64()
    serial = 0

    def rpc(method, *, ok=True, **fields):
        nonlocal serial
        serial += 1
        if method not in ('browser.shutdown', 'snapshot', 'view.signIn.events', 'output.configure'):
            fields['session'] = '1'
        data = json.dumps(dict(version=1, id=serial, method=method, **fields)).encode()
        output = ctypes.create_string_buffer(1024 * 1024)
        size = ctypes.c_size_t()
        status = sdk.remotekit_sdk_control_request(
            handle, data, len(data), output, len(output), ctypes.byref(size), 10000)
        assert status == 0, (method, status)
        reply = json.loads(output.raw[:size.value])
        if ok is not None:
            assert reply['ok'] == ok, (method, reply)
        return reply

    def events(ids=None):
        return rpc('view.signIn.events', eventIds=ids or [])['events']

    def wait_for(read, accepted):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            value = read()
            if accepted(value):
                return value
            time.sleep(0.05)
        raise AssertionError('Browser state did not settle: ' + repr(value))

    def view():
        return next(v for v in rpc('snapshot')['sessions'][0]['views'] if v['view'] == '1')

    def create(view_id, **fields):
        config = dict(url='about:blank', width=320, height=240, visible=False, device='desktop')
        config.update(fields)
        return rpc('view.create', view=view_id, **config)

    def view_state(view_id):
        return next(v for v in rpc('snapshot')['sessions'][0]['views'] if v['view'] == view_id)

    def focus(view_id, *, ok=True):
        state = view_state(view_id)
        return rpc('focus', view=view_id, instance=state['instance'], document=state['document'],
                   focus=state['focus'], focused=True, ok=ok)

    input_sequence = 0

    def activate(view_id):
        nonlocal input_sequence
        state = view_state(view_id)
        for scan, virtual_key in ((0x0f, 9), (0x39, 32)):
            for action in ('down', 'up'):
                input_sequence += 1
                rpc('input', view=view_id, instance=state['instance'], document=state['document'],
                    focus=state['focus'], sequence=str(input_sequence),
                    event=dict(type='key', action=action, physical_code=scan,
                               windows_key_code=virtual_key,
                               dom_code=sdk.remotekit_sdk_windows_dom_code(scan),
                               dom_key=str(sdk.remotekit_sdk_windows_dom_key(virtual_key, 0, 0))))

    def pending(view_id):
        return rpc('page.requests', view=view_id)['pending']

    def navigate_page(view_id, page):
        previous = view_state(view_id)['document']
        rpc('navigate', view=view_id, url='data:text/html,' + quote(page))
        return wait_for(lambda: view_state(view_id),
                        lambda state: state['document'] != previous and not state.get('loading', True))

    def browser_regressions():
        bad = rpc('snapshot', misspelled=True, ok=False)
        assert bad['error']['code'] == 'invalid_request'
        bad = rpc('navigation.ack', view='1', operationId='x', operationGeneration='x',
                  operationSequence=False, ok=False)
        assert bad['error']['code'] == 'invalid_request'
        config = dict(session='1', view='1', width=320, height=240, device='desktop',
                      device_scale_factor=1, visible=False)
        for field in ('occludedBottom', 'occlusionRevision'):
            bad_config = dict(config, **{field: False})
            bad = rpc('output.configure', viewConfigs=[bad_config], ok=False)
            assert bad['error']['code'] == 'invalid_request'
        create('7', visible=True)
        wait_for(lambda: view_state('7'), lambda state: not state.get('loading', True))
        focus('7')
        focused = view_state('7')
        focus('2', ok=False)
        assert view_state('7')['focus'] == focused['focus'] and view_state('7')['focused']
        page = '<button style="width:300px;height:200px" onclick="alert(123)">dialog</button>'
        navigate_page('7', page)
        focus('7')
        activate('7')
        dialog = wait_for(lambda: pending('7'), bool)[0]
        rejected = rpc('lifecycle', view='7', action='restore', ok=False)
        assert rejected['error']['code'] == 'conflict'
        assert pending('7')[0]['request'] == dialog['request']
        rpc('page.reply', view='7', request=dialog['request'], accept=False)
        rpc('view.close', view='7', force=True)

    class HintPage(BaseHTTPRequestHandler):
        requests = []

        def do_GET(self):
            self.requests.append({key.lower(): value for key, value in self.headers.items()})
            body = b'<title>client hints persistence</title>'
            self.send_response(200)
            self.send_header('Accept-CH', 'Sec-CH-UA-Arch')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), HintPage)
    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()
    profile = run / 'state/session-1/profile-1'
    profile.mkdir(parents=True)
    corrupt_hints = b'{"https://example.test":[-1]}'
    corrupt_salt = b'CORRUPT_SALT'
    (profile / 'ClientHints.json').write_bytes(corrupt_hints)
    (profile / 'MediaDeviceSalt').write_bytes(corrupt_salt)

    marker = 'SIGNIN-PROBE-' + uuid.uuid4().hex
    done = 'remotekit-signin://changyan/done?' + urlencode(dict(
        lot_number=marker, captcha_output='output+', pass_token='token', gen_time='1'))
    with (run / 'browser.log').open('wb') as log:
        browser = spawn_browser([
            str(browser_path), '--control-channel=' + channel, '--session-id=1', '--tenant-id=1',
            '--data-path=' + str(run / 'state'), '--browser-incarnation=' + channel,
        ], stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            wait_for(lambda: sdk.remotekit_sdk_control_connect(channel.encode(), ctypes.byref(handle)),
                     lambda status: status == 0)
            assert handle.value
            create('1', signIn='invalid', ok=False)
            create('1', signIn='changyan')
            create('1', signIn='xinjiaoyu', ok=False)
            create('2')
            for number in (1, 2):
                url = f'http://127.0.0.1:{server.server_port}/?hints={number}'
                rpc('navigate', view='2', url=url)
                wait_for(lambda: view_state('2'),
                         lambda state: state.get('url') == url and not state.get('loading', True))
            assert any('sec-ch-ua-arch' in headers for headers in HintPage.requests), HintPage.requests
            assert (profile / 'ClientHints.json').read_bytes() == corrupt_hints
            assert (profile / 'MediaDeviceSalt').read_bytes() == corrupt_salt
            create('3', signIn='xinjiaoyu')
            rpc('view.adopt', view='4', signIn='changyan', provisionalId='missing',
                url='about:blank', width=320, height=240, ok=False)
            for view_id in ['2', '3']:
                rpc('navigate', view=view_id, url=done)
            assert not events()
            rpc('navigate', view='2', url='remotekit-signin://changyan/verify')
            time.sleep(0.3)
            normal = next(v for v in rpc('snapshot')['sessions'][0]['views'] if v['view'] == '2')
            assert not normal.get('url', '').startswith('remotekit-signin:')
            rpc('navigate', view='1', url=done, operationId='signin-probe',
                operationGeneration='probe', operationSequence='1')
            first = wait_for(events, lambda value: len(value) == 1)[0]
            assert first['version'] == 1 and first['type'] == 'view.signIn'
            assert first['webviewId'] == '1' and first['provider'] == 'changyan'
            assert first['result'] == dict(lot_number=marker, captcha_output='output+',
                                           pass_token='token', gen_time='1')
            assert marker not in json.dumps(rpc('snapshot'))
            rpc('navigate', view='1', url=done)
            assert events() == [first]
            assert not events([first['eventId']])
            rpc('navigate', view='1', url=done)
            assert not events()
            rpc('view.recreate', view='1', url='about:blank')
            rpc('navigate', view='1', url=done)
            second = wait_for(events, lambda value: len(value) == 1)[0]
            assert second['eventId'] != first['eventId']
            events([second['eventId']])
            rpc('navigate', view='1', url='about:blank')
            wait_for(view, lambda value: not value.get('loading'))
            rpc('lifecycle', view='1', action='unload')
            wait_for(view, lambda value: not value['pending'])
            rpc('lifecycle', view='1', action='restore')
            wait_for(view, lambda value: not value['pending'])
            rpc('navigate', view='1', url=done)
            restored = wait_for(events, lambda value: len(value) == 1)[0]
            assert restored['provider'] == 'changyan'
            assert marker not in json.dumps(rpc('snapshot'))
            assert marker not in (run / 'browser.log').read_text(encoding='utf-8', errors='replace')
            create('6')
            rpc('view.close', view='6', force=True)
            rpc('view.closed.ack', views=['6'], browserIncarnation=channel)
            rejected = create('6', ok=False)
            assert rejected['error'] == {'code': 'conflict', 'message': 'view_id_closed'}
            browser_regressions()
            rpc('browser.shutdown')
        finally:
            if handle.value:
                sdk.remotekit_sdk_control_close(handle)
            try:
                browser.wait(timeout=15)
            except subprocess.TimeoutExpired:
                browser.kill()
                browser.wait()
            assert sdk.remotekit_sdk_shutdown() == 0
            server.shutdown()
            serving.join()
            server.server_close()
            assert (profile / 'ClientHints.json').read_bytes() == corrupt_hints
            assert (profile / 'MediaDeviceSalt').read_bytes() == corrupt_salt
    dll_directory.close()
    print('Browser sign-in creation, scope, reset, recreation and restore verified:', run)


if __name__ == '__main__':
    main()
