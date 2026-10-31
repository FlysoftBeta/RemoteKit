#!/usr/bin/env python3
"""Hidden-window acceptance run against this repository's browser and CMake SDK client."""
import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import queue
import secrets
import subprocess
import threading
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]

def until(callback, timeout=20):
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        try:
            result = callback()
            if result: return result
        except (OSError, ValueError) as error:
            last = error
        time.sleep(.05)
    raise RuntimeError(f'condition timed out: {last}')

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_): pass

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', type=Path, default=Path(r'C:\src\chromium\src\out\dev\remotekit_browser_demo.exe'))
    parser.add_argument('--client', type=Path, default=ROOT / 'build/sdk-smoke/remotekit_control_client.exe')
    args = parser.parse_args()
    if not args.browser.is_file():
        parser.error("Build explicit GN target remotekit_browser_demo before harness verification")
    run = ROOT / 'develop/tmp' / ('acceptance-' + secrets.token_hex(4))
    run.mkdir(parents=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT / 'browser/testdata')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{server.server_port}/input.html'
    channel = 'remotekit-' + secrets.token_hex(16)
    output = open(run / 'browser.log', 'w', encoding='utf-8')
    browser = subprocess.Popen([str(args.browser), '--no-window-show', '--remote-debugging-port=0',
        '--sessions=2', '--data-path=' + str(run / 'data'), '--urls=' + url + '|' + url,
        '--control-channel=' + channel], stdout=output, stderr=output, creationflags=subprocess.CREATE_NO_WINDOW)
    client = None
    transcript = []
    try:
        def ready():
            if browser.poll() is not None: raise RuntimeError(f'browser exited {browser.returncode}; {run}')
            port = int((run / 'data/DevToolsActivePort').read_text().splitlines()[0])
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list', timeout=2) as result:
                pages = json.load(result)
            return len([p for p in pages if p.get('type') == 'page' and p.get('url') == url]) == 2
        until(ready)
        identity = subprocess.run(['node', str(ROOT / 'tools/verify-browser.mjs'), str(run / 'data'), url],
            capture_output=True, text=True, encoding='utf-8', timeout=45)
        (run / 'browser-verification.json').write_text(identity.stdout + identity.stderr, encoding='utf-8')
        if identity.returncode: raise RuntimeError(identity.stdout + identity.stderr)
        diagnostics = open(run / 'client.log', 'w', encoding='utf-8')
        client = subprocess.Popen([str(args.client), channel], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=diagnostics, text=True, encoding='utf-8', bufsize=1, creationflags=subprocess.CREATE_NO_WINDOW)
        responses = queue.Queue()
        def read_replies():
            for line in client.stdout: responses.put(line)
            responses.put(None)
        threading.Thread(target=read_replies, daemon=True).start()
        next_id = 0
        def request(method, **params):
            nonlocal next_id
            next_id += 1
            message = dict(version=1, id=next_id, method=method, **params)
            client.stdin.write(json.dumps(message, ensure_ascii=False) + '\n'); client.stdin.flush()
            line = responses.get(timeout=10)
            if line is None: raise RuntimeError(f'control client exited; see {run}')
            reply = json.loads(line)
            assert reply['id'] == next_id, reply
            transcript.append(dict(request=message, reply=reply))
            return reply
        snapshot = request('snapshot')
        assert snapshot['ok'] and len(snapshot['sessions']) == 2, snapshot
        first, second = snapshot['sessions']
        token = first['views'][0]
        target = dict(session=first['session'], view=token['view'])
        wrong = request('focus', session=second['session'], view=token['view'], focused=True)
        assert not wrong['ok'] and wrong['error'] == 'view_not_in_session', wrong
        focus = request('focus', **target, focused=True)
        assert focus['ok'], focus
        current = focus['token']
        # DOM focus is set by the CDP validation. Route composition through the
        # independent CMake client and the real WebView execution adapter here.
        event = request('input', **current, sequence='1', event=dict(type='ime_set', text='预编辑', selection_start=0, selection_end=3))
        assert event['ok'], event
        event = request('input', **current, sequence='2', event=dict(type='ime_commit', text='远程输入😀'))
        assert event['ok'], event
        stale = request('input', **current, sequence='2', event=dict(type='ime_commit', text='duplicate'))
        assert not stale['ok'] and stale['code'] == 7, stale
        proof = subprocess.run(['node', str(ROOT / 'tools/verify-browser.mjs'), str(run / 'data'), url, 'control-proof'],
            capture_output=True, text=True, encoding='utf-8', timeout=20)
        (run / 'control-proof.json').write_text(proof.stdout + proof.stderr, encoding='utf-8')
        if proof.returncode: raise RuntimeError(proof.stdout + proof.stderr)
        key = dict(type='key', action='down', physical_code=37, windows_key_code=75,
            dom_code=0x07000e, dom_key=str((1 << 22) | ord('k')), text='k', unmodified_text='k')
        assert request('input', **current, sequence='3', event=key)['ok']
        key.update(action='up', text='', unmodified_text='')
        assert request('input', **current, sequence='4', event=key)['ok']
        center = json.loads(proof.stdout)['touchCenter']
        for sequence, action, button, modifiers in [(5,'move',0,0),(6,'down',1,64),(7,'up',1,0)]:
            assert request('input', **current, sequence=str(sequence),
                event=dict(type='mouse', action=action, button=button, modifiers=modifiers, **center))['ok']
        for sequence, action, pressure in [(8,'start',.7),(9,'end',0)]:
            assert request('input', **current, sequence=str(sequence),
                event=dict(type='touch', action=action, points=[dict(id=1,pressure=pressure,**center)]))['ok']
        pointers = subprocess.run(['node', str(ROOT / 'tools/verify-browser.mjs'), str(run / 'data'), url, 'pointer-proof'],
            capture_output=True, text=True, encoding='utf-8', timeout=20)
        (run / 'pointer-proof.json').write_text(pointers.stdout + pointers.stderr, encoding='utf-8')
        if pointers.returncode: raise RuntimeError(pointers.stdout + pointers.stderr)
        hidden = request('visible', **target, visible=False)
        assert hidden['ok'], hidden
        freeze = request('lifecycle', **target, action='freeze')
        assert freeze['ok'] and freeze['accepted'], freeze
        frozen = until(lambda: (v if not (v := request('snapshot')['sessions'][0]['views'][0])['pending'] else None))
        assert frozen['actual'] == 1, frozen
        thaw = request('lifecycle', **target, action='restore')
        assert thaw['ok'], thaw
        thawed = until(lambda: (v if not (v := request('snapshot')['sessions'][0]['views'][0])['pending'] else None))
        assert thawed['actual'] == 0, thawed
        discard = request('lifecycle', **target, action='discard')
        assert discard['ok'] and discard['accepted'], discard
        discarded = until(lambda: (v if not (v := request('snapshot')['sessions'][0]['views'][0])['pending'] else None))
        assert discarded['actual'] == 2, discarded
        restore_discard = request('lifecycle', **target, action='restore')
        assert restore_discard['ok'], restore_discard
        discard_reloaded = until(lambda: (v if not (v := request('snapshot')['sessions'][0]['views'][0])['pending'] else None))
        assert discard_reloaded['actual'] == 0, discard_reloaded
        unload = request('lifecycle', **target, action='unload')
        assert unload['ok'] and unload['accepted'], unload
        unloaded = request('snapshot')['sessions'][0]['views'][0]
        assert unloaded['actual'] == 3 and unloaded['view'] == token['view'], unloaded
        restore = request('lifecycle', **target, action='restore')
        assert restore['ok'] and restore['accepted'], restore
        restored = until(lambda: (v if (v := request('snapshot')['sessions'][0]['views'][0])['actual'] == 0 and not v['pending'] else None))
        assert restored['view'] == token['view'] and restored['instance'] != current['instance'], restored
        old = request('input', **current, sequence='3', event=dict(type='ime_commit', text='old instance'))
        assert not old['ok'], old
        shutdown = request('shutdown')
        assert shutdown['ok'], shutdown
        client.stdin.close()
        assert client.wait(timeout=10) == 0
        assert browser.wait(timeout=10) == 0
        report = dict(passed=True, logs=str(run), checks=['Chrome identity', 'session localStorage isolation',
            'CDP Unicode/composition', 'independent CMake client to content Mojo IPC', 'cross-session rejection',
            'remote composition/keyboard/mouse/touch', 'duplicate input rejection', 'freeze/thaw renderer acknowledgement',
            'in-place discard/reload', 'unload/URL restore stable WebView', 'shutdown'])
        (run / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(report, indent=2))
    finally:
        (run / 'control-transcript.json').write_text(json.dumps(transcript, ensure_ascii=False, indent=2), encoding='utf-8')
        if client and client.poll() is None: client.terminate(); client.wait(timeout=10)
        if browser.poll() is None: browser.terminate(); browser.wait(timeout=10)
        server.shutdown(); server.server_close(); output.close()

if __name__ == '__main__': main()
