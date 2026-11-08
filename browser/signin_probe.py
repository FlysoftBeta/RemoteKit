"""Exercise purpose-scoped Browser sign-in through the production C ABI."""

import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid
from urllib.parse import urlencode

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
    assert sdk.remotekit_sdk_initialize() == 0
    channel = 'RemoteKit.signin.' + uuid.uuid4().hex
    handle = ctypes.c_uint64()
    serial = 0

    def rpc(method, *, ok=True, **fields):
        nonlocal serial
        serial += 1
        data = json.dumps(dict(version=1, id=serial, method=method, session='1', **fields)).encode()
        output = ctypes.create_string_buffer(1024 * 1024)
        size = ctypes.c_size_t()
        status = sdk.remotekit_sdk_control_request(
            handle, data, len(data), output, len(output), ctypes.byref(size), 10000)
        assert status == 0, (method, status)
        reply = json.loads(output.raw[:size.value])
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
        raise AssertionError('Browser state did not settle')

    def view():
        return next(v for v in rpc('snapshot')['sessions'][0]['views'] if v['view'] == '1')

    def create(view_id, **fields):
        return rpc('view.create', view=view_id, url='about:blank', width=320, height=240,
                   visible=False, device='desktop', **fields)

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
            assert rejected['error'] == 'invalid_request' and rejected['detail'] == 'View id closed'
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
    dll_directory.close()
    print('Browser sign-in creation, scope, reset, recreation and restore verified:', run)


if __name__ == '__main__':
    main()
