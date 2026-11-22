#!/usr/bin/env python3
"""Real Browser checks for the built-in pdf.js document view: binding, isolation, no egress."""
import argparse
import ctypes as c
import http.server
import json
import subprocess
import threading
import time
from pathlib import Path

from browser_key import spawn_browser

ROOT = Path(__file__).resolve().parents[2]
VIEWER = 'remotekit-pdf://viewer/'
PAGES = 3
VIEWER_TITLES = ('PDF.js viewer', 'document.pdf')


def make_pdf(path, port):
    """A PDF with one text line per page and a link to the local egress canary on page one."""
    objects = []

    def add(body):
        objects.append(body)
        return len(objects)

    catalog, pages = add(None), add(None)
    font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    kids = []
    for number in range(1, PAGES + 1):
        text = f'BT /F1 40 Tf 72 700 Td (RemoteKit page {number} marker) Tj ET'
        stream = add(f'<< /Length {len(text)} >>\nstream\n{text}\nendstream')
        annots = ''
        if number == 1:
            link = add('<< /Type /Annot /Subtype /Link /Rect [72 400 540 480] /Border [0 0 0] '
                       f'/A << /S /URI /URI (http://127.0.0.1:{port}/egress) >> >>')
            annots = f'/Annots [{link} 0 R]'
        kids.append(add(f'<< /Type /Page /Parent {pages} 0 R /MediaBox [0 0 612 792] '
                        f'/Resources << /Font << /F1 {font} 0 R >> >> /Contents {stream} 0 R {annots} >>'))
    objects[catalog - 1] = f'<< /Type /Catalog /Pages {pages} 0 R >>'
    objects[pages - 1] = ('<< /Type /Pages /Count %d /Kids [%s] >>' %
                          (PAGES, ' '.join(f'{kid} 0 R' for kid in kids)))
    out = bytearray(b'%PDF-1.4\n')
    offsets = []
    for index, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += f'{index} 0 obj\n{body}\nendobj\n'.encode()
    start = len(out)
    out += f'xref\n0 {len(objects) + 1}\n0000000000 65535 f \n'.encode()
    for offset in offsets:
        out += f'{offset:010d} 00000 n \n'.encode()
    out += f'trailer\n<< /Size {len(objects) + 1} /Root {catalog} 0 R >>\nstartxref\n{start}\n%%EOF\n'.encode()
    path.write_bytes(bytes(out))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', type=Path,
                        default=Path('C:/src/chromium/src/out/dev/remotekit_browser.exe'))
    parser.add_argument('--work-dir', type=Path, default=ROOT / 'develop/tmp/browser-pdf-view')
    args = parser.parse_args()
    run = args.work_dir / str(time.time_ns())
    run.mkdir(parents=True)
    egress = []

    class Canary(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            egress.append(self.path)
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', '2')
            self.end_headers()
            self.wfile.write(b'ok')

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Canary)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    pdf = run / 'staged.file'
    make_pdf(pdf, server.server_port)
    size = str(pdf.stat().st_size)

    import os
    os.add_dll_directory(str(args.browser.parent))
    sdk = c.CDLL(str(args.browser.parent / 'remotekit_sdk.dll'))
    sdk.remotekit_sdk_control_connect.argtypes = [c.c_char_p, c.POINTER(c.c_uint64)]
    sdk.remotekit_sdk_control_request.argtypes = [
        c.c_uint64, c.c_void_p, c.c_size_t, c.c_void_p, c.c_size_t, c.POINTER(c.c_size_t), c.c_uint32]
    sdk.remotekit_sdk_control_close.argtypes = [c.c_uint64]
    sdk.remotekit_sdk_windows_dom_code.argtypes = [c.c_uint32]
    sdk.remotekit_sdk_windows_dom_code.restype = c.c_uint32
    sdk.remotekit_sdk_windows_dom_key.argtypes = [c.c_uint32, c.c_uint32, c.c_uint64]
    sdk.remotekit_sdk_windows_dom_key.restype = c.c_uint64
    assert sdk.remotekit_sdk_initialize() == 0
    channel = 'RemoteKit.pdf.' + str(time.time_ns())
    handle = c.c_uint64()
    serial = 0
    sequence = 0

    def rpc(method, ok=True, **fields):
        nonlocal serial
        serial += 1
        if method not in ('snapshot', 'browser.shutdown'):
            fields.setdefault('session', '1')
        data = json.dumps(dict(version=1, id=serial, method=method, **fields)).encode()
        out = c.create_string_buffer(1024 * 1024)
        count = c.c_size_t()
        status = sdk.remotekit_sdk_control_request(handle, data, len(data), out, len(out),
                                                   c.byref(count), 10000)
        assert status == 0, (method, status)
        reply = json.loads(out.raw[:count.value])
        assert ok is None or reply['ok'] is ok, (method, reply)
        return reply

    def state(view):
        return next(v for v in rpc('snapshot')['sessions'][0]['views'] if v['view'] == view)

    def wait_for(read, accepted, seconds=30):
        deadline = time.monotonic() + seconds
        value = None
        while time.monotonic() < deadline:
            value = read()
            if accepted(value):
                return value
            time.sleep(0.1)
        raise AssertionError('did not settle: ' + repr({k: value.get(k) for k in ('url', 'title', 'loading')} if isinstance(value, dict) else value))

    def key(view, scan, virtual_key, modifiers=0, text=None):
        nonlocal sequence
        current = state(view)
        for action in ('down', 'up'):
            sequence += 1
            event = dict(type='key', action=action, physical_code=scan, windows_key_code=virtual_key,
                         dom_code=sdk.remotekit_sdk_windows_dom_code(scan),
                         dom_key=str(sdk.remotekit_sdk_windows_dom_key(virtual_key, modifiers, 0)),
                         modifiers=modifiers)
            rpc('input', view=view, instance=current['instance'], document=current['document'],
                focus=current['focus'], sequence=str(sequence), event=event)

    def copy_all(view):
        """Select all text of the current page layers and read the clipboard."""
        current = state(view)
        rpc('focus', view=view, instance=current['instance'], document=current['document'],
            focus=current['focus'], focused=True)
        key(view, 0x1e, 65, modifiers=2)  # Ctrl+A
        key(view, 0x2e, 67, modifiers=2)  # Ctrl+C
        time.sleep(0.5)
        return rpc('clipboard.read').get('text', '')

    evidence = {}
    with (run / 'browser.log').open('wb') as log:
        browser = spawn_browser(
            [str(args.browser), '--control-channel=' + channel, '--browser-incarnation=' + channel,
             '--session-id=1', '--tenant-id=1', '--remotekit-render-host=offscreen',
             '--data-path=' + str(run / 'state')],
            stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            wait_for(lambda: sdk.remotekit_sdk_control_connect(channel.encode(), c.byref(handle)),
                     lambda status: status == 0)
            # The Endpoint names staged files with extended-length paths.
            binding = dict(path='\\\\?\\' + str(pdf), size=size)
            # Contract of view.create: a document needs the marker URL, and only it takes one.
            for fields in (dict(url='about:blank', document=binding),
                           dict(url=VIEWER),
                           dict(url=VIEWER, document=dict(path='relative.pdf', size=size)),
                           dict(url=VIEWER, document=dict(path=str(pdf), size=size, extra='1')),
                           dict(url=VIEWER, document=binding, signIn='changyan')):
                reply = rpc('view.create', view='9', width=800, height=600, visible=False,
                            device='desktop', ok=False, **fields)
                assert reply['error']['code'] == 'invalid_request', (fields, reply)
            rpc('view.create', view='1', url=VIEWER, document=binding, width=800, height=600,
                visible=True, device='desktop')
            # An idempotent repeat is accepted; a different binding is a conflict.
            rpc('view.create', view='1', url=VIEWER, document=binding, width=800, height=600,
                visible=True, device='desktop')
            moved = rpc('view.create', view='1', url=VIEWER, document=dict(path=str(pdf), size='1'),
                        width=800, height=600, visible=True, device='desktop', ok=False)
            assert moved['error']['code'] == 'conflict', moved
            loaded = wait_for(lambda: state('1'), lambda v: not v.get('loading', True) and v.get('title'))
            evidence['viewer'] = dict(url=loaded['url'], title=loaded['title'])
            assert loaded['url'].startswith('remotekit-pdf://viewer/web/viewer.html'), loaded

            # Rendering needs Endpoint begin frames, which this probe does not drive; the viewer
            # page itself must be the pdf.js page.
            assert loaded['title'] in VIEWER_TITLES, loaded['title']
            # pdf.js replaces its static title with the document's once its scripts have loaded the
            # file, so this fails when the viewer's own subresources or the document are refused.
            wait_for(lambda: state('1'), lambda v: v.get('title') == 'document.pdf')

            # The viewer cannot leave its page or open windows.
            for target in ('http://127.0.0.1:%d/navigate' % server.server_port, 'about:blank',
                           'data:text/html,hi', VIEWER + 'web/viewer.html?file=%2Fother.pdf'):
                rpc('navigate', view='1', url=target, ok=None)
            time.sleep(1)
            after = state('1')
            assert after['url'].startswith('remotekit-pdf://viewer/web/viewer.html?file=%2Fdocument.pdf'), after['url']
            assert '/navigate' not in egress, egress

            # Any other view cannot load the scheme or read the document.
            rpc('view.create', view='2', url='about:blank', width=800, height=600, visible=False,
                device='desktop')
            for target in (VIEWER + 'web/viewer.html?file=%2Fdocument.pdf', VIEWER + 'document.pdf'):
                rpc('navigate', view='2', url=target, ok=None)
                time.sleep(1)
                other = state('2')
                assert not other['url'].startswith('remotekit-pdf:'), other
                assert other.get('title') not in VIEWER_TITLES, other.get('title')
            evidence['otherViewUrl'] = state('2')['url']

            # Recreating a document view keeps its binding; the viewer URL is the only target.
            bad = rpc('view.recreate', view='1', url='https://example.test/', ok=False)
            assert bad['error']['code'] == 'invalid_request', bad
            rpc('view.recreate', view='1', url=VIEWER)
            wait_for(lambda: state('1'), lambda v: not v.get('loading', True) and v.get('title'))
            evidence['afterRecreate'] = wait_for(
                lambda: state('1'), lambda v: v.get('title') == 'document.pdf')['url']

            rpc('view.close', view='1', force=True)
        finally:
            if handle.value:
                sdk.remotekit_sdk_control_close(handle)
            try:
                browser.wait(timeout=10)
            except subprocess.TimeoutExpired:
                browser.kill()
                browser.wait()
            sdk.remotekit_sdk_shutdown()
            server.shutdown()
            (run / 'evidence.json').write_text(json.dumps(evidence, indent=2), encoding='utf-8')
    print(json.dumps(dict(passed=True, evidence=str(run))))


if __name__ == '__main__':
    main()
