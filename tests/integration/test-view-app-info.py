#!/usr/bin/env python3
"""Exercise view.appInfo through Endpoint, the SDK and a real Browser."""

import argparse
import base64
import http.server
import json
import os
from pathlib import Path
import queue
import random
import struct
import subprocess
import threading
import time
import uuid
import zlib

from cluster_bridge import endpoint_command, SessionDriver

ROOT = Path(__file__).resolve().parents[2]


def png(width, height, noise=False):
    def chunk(kind, data):
        return (struct.pack('!I', len(data)) + kind + data
                + struct.pack('!I', zlib.crc32(kind + data)))

    pixels = (random.Random(7).randbytes(width * height * 4) if noise
              else bytes([24, 80, 160, 255]) * width * height)
    rows = b''.join(b'\0' + pixels[y * width * 4:(y + 1) * width * 4] for y in range(height))
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def wait_for(read, accepted, label, timeout=20):
    deadline = time.monotonic() + timeout
    value = None
    while time.monotonic() < deadline:
        value = read()
        if accepted(value):
            return value
        time.sleep(0.05)
    raise AssertionError((label, value))


def check_icon(info, width, height):
    icon = info['icon']
    data = base64.b64decode(icon['png'], validate=True)
    assert len(data) <= 64 * 1024 and data.startswith(b'\x89PNG\r\n\x1a\n'), icon
    assert struct.unpack('!2I', data[16:24]) == (width, height)
    assert (icon['width'], icon['height']) == (width, height)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--endpoint', type=Path,
                        default=ROOT / 'build/endpoint/endpoint/endpoint_service.exe')
    parser.add_argument('--browser', type=Path,
                        default=Path('C:/src/chromium/src/out/dev/remotekit_browser.exe'))
    parser.add_argument('--work-dir', type=Path, default=ROOT / 'develop/tmp/view-app-info')
    args = parser.parse_args()
    run = args.work_dir.resolve() / uuid.uuid4().hex[:12]
    run.mkdir(parents=True)
    hits = {}
    navigation_requested = threading.Event()
    slow_release = threading.Event()
    images = {
        '/large.png': png(512, 256),
        '/square.png': png(192, 192),
        '/favicon.png': png(32, 16),
        '/oversized.png': png(1025, 1025),
        '/noise.png': png(192, 192, True),
    }
    manifests = {
        'manifest': {
            'name': 'Application 名称', 'short_name': 'Short 名',
            'start_url': '../launch?installed=1', 'scope': '../',
            'theme_color': '#12abef', 'display': 'standalone',
            'icons': [{'src': '/square.png', 'sizes': '512x512'},
                      {'src': '/large.png', 'sizes': '256x256'}],
        },
        'small': {'icons': [{'src': '/square.png', 'sizes': '64x64'}]},
        'oversized': {'icons': [{'src': '/oversized.png', 'sizes': '1025x1025'}]},
        'noise': {'icons': [{'src': '/noise.png', 'sizes': '192x192'}]},
        'timeout': {'name': 'Slow icon', 'icons': [{'src': '/slow.png', 'sizes': '192x192'}]},
        'navigation': {'icons': [{'src': '/navigation.png', 'sizes': '192x192'}]},
    }

    class Fixture(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            hits[self.path] = hits.get(self.path, 0) + 1
            content_type = 'text/html; charset=utf-8'
            if self.path in images:
                body = images[self.path]
                content_type = 'image/png'
            elif self.path in ('/slow.png', '/navigation.png'):
                if self.path == '/navigation.png':
                    navigation_requested.set()
                slow_release.wait(8)
                body = images['/square.png']
                content_type = 'image/png'
            elif self.path == '/trigger':
                body = json.dumps(navigation_requested.is_set()).encode()
                content_type = 'application/json'
            elif self.path.startswith('/manifests/'):
                key = self.path.rsplit('/', 1)[1].removesuffix('.json')
                body = json.dumps(manifests[key]).encode()
                content_type = 'application/manifest+json'
            elif self.path == '/favicon.ico' or self.path == '/missing.png':
                self.send_error(404)
                return
            else:
                key = self.path.strip('/')
                body = '<title>App info ' + key + '</title>'
                favicon = ('/favicon.png' if key in ('manifest', 'small', 'favicon', 'noise')
                           else '/missing.png')
                body += '<link rel="icon" href="' + favicon + '">'
                if key in manifests:
                    body += '<link rel="manifest" href="/manifests/' + key + '.json">'
                if key == 'navigation':
                    body += '''<script>
                    const timer = setInterval(async () => {
                      if (await (await fetch('/trigger')).json()) {
                        clearInterval(timer);
                        location.href = '/after-navigation';
                      }
                    }, 50);
                    </script>'''
                if key == 'freeze-timeout':
                    body += '''<script>
                    document.addEventListener('freeze', () => {
                      const deadline = performance.now() + 12000;
                      while (performance.now() < deadline) {}
                    }, {once: true});
                    </script>'''
                body = body.encode()
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    transcript = []
    with (run / 'endpoint.log').open('wb') as log:
        child = subprocess.Popen(
            endpoint_command(args.endpoint, args.browser, run / 'state'),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log,
            creationflags=subprocess.CREATE_NO_WINDOW)
        driver = SessionDriver(child,run / 'state','app-info')

        def call(method,error=None,**fields):
            if method == 'session.snapshot':
                value=driver.observe()
                return dict(value,running=value['browser'] == 'running')
            result=driver.rpc(method,ok=error is None,**fields)
            if error:
                assert result['error']['code']==error,result
                return result
            return result

        def view(view_id):
            return next(item for item in call('session.snapshot')['views'] if item['viewId'] == view_id)

        def ready(view_id):
            return wait_for(lambda: view(view_id),
                            lambda item: not item.get('pending') and not item.get('loading'),
                            'view ready')

        next_view = 0

        def create(key):
            nonlocal next_view
            next_view += 1
            view_id = str(next_view)
            driver.view(viewId=view_id,url=origin+'/'+key,width=320,height=240)
            wait_for(lambda: view(view_id),
                     lambda item: item.get('title') == 'App info ' + key and not item.get('loading'),
                     key)
            return view_id

        try:
            driver.publish(run='running')
            driver.wait(lambda value:value['browser']=='running')
            call('view.appInfo',viewId='999',error='not_found')
            main_view = create('manifest')
            info = call('view.appInfo', viewId=main_view)
            assert set(info) == {'title', 'url', 'manifest', 'icon'}, info
            assert info['title'] == 'App info manifest' and info['url'] == origin + '/manifest', info
            assert info['manifest'] == {
                'name': 'Application 名称', 'shortName': 'Short 名',
                'startUrl': origin + '/launch?installed=1', 'scope': origin + '/',
                'themeColor': '#12abef', 'display': 'standalone',
            }, info
            check_icon(info, 192, 96)
            assert hits.get('/large.png') and not hits.get('/square.png'), hits
            for key in ('small', 'favicon'):
                info = call('view.appInfo', viewId=create(key))
                check_icon(info, 32, 16)
                assert ('manifest' in info) == (key == 'small'), info
            for key in ('oversized', 'noise', 'none'):
                info = call('view.appInfo', viewId=create(key))
                assert 'icon' not in info, info
            timeout_view = create('timeout')
            started = time.monotonic()
            info = call('view.appInfo', viewId=timeout_view)
            elapsed = time.monotonic() - started
            assert 4.5 <= elapsed < 7 and 'icon' not in info, (elapsed, info)
            assert info['manifest']['name'] == 'Slow icon', info
            navigation_view = create('navigation')
            call('view.appInfo', viewId=navigation_view, error='unavailable')
            assert navigation_requested.is_set()
            wait_for(lambda: view(navigation_view),
                     lambda item: item.get('url') == origin + '/after-navigation', 'navigation')
            slow_release.set()
            for action, expected in (('freeze', 1), ('discard', 2)):
                call('view.lifecycle', viewId=main_view, action=action)
                frozen = wait_for(lambda:view(main_view),lambda item:item['actual']==expected and not item.get('pending'),'lifecycle state')
                assert frozen['actual'] == expected, frozen
                call('view.appInfo', viewId=main_view, error='unavailable')
                call('view.lifecycle', viewId=main_view, action='restore')
                assert wait_for(lambda:view(main_view),lambda item:item['actual']==0 and not item.get('pending'),'restored')['actual']==0
                assert call('view.appInfo', viewId=main_view)['title'] == 'App info manifest'
            recovery_view = create('freeze-timeout')
            call('view.lifecycle', viewId=recovery_view, action='freeze')
            uncertain = wait_for(lambda:view(recovery_view),lambda item:item.get('lifecycle_uncertain'),'uncertain freeze',timeout=25)
            assert uncertain['lifecycle_uncertain'], uncertain
            call('view.appInfo', viewId=recovery_view, error='unavailable')
            snapshot = call('session.snapshot')
            call('view.lifecycle', viewId=recovery_view, action='unload', requireRunning=True,
                 browserIncarnation=snapshot['browserIncarnation'],
                 lifecycleGeneration=uncertain['lifecycle_generation'])
            assert wait_for(lambda:view(recovery_view),lambda item:item['actual']==3 and not item.get('pending'),'unloaded')['actual']==3
            call('view.appInfo', viewId=recovery_view, error='unavailable')
            call('view.lifecycle', viewId=recovery_view, action='restore')
            assert wait_for(lambda:view(recovery_view),lambda item:item['actual']==0 and not item.get('pending'),'restored')['actual']==0
            snapshot=driver.observe()
            old_browser=snapshot['browserIncarnation']
            os.kill(snapshot['browserPid'],9)
            driver.wait(lambda value:value['browser']=='running' and value['browserIncarnation']!=old_browser)
            driver.wait(lambda value:any(view['viewId']==main_view and view['actual']==0 and not view.get('pending') and not view.get('loading') and view.get('title')=='App info manifest' for view in value['views']))
            assert call('view.appInfo',viewId=main_view)['title']=='App info manifest'
            call('shutdown')
            child.wait(timeout=15)
            assert child.returncode == 0, child.returncode
            print(json.dumps(dict(verified='view.appInfo', evidence=str(run))))
        finally:
            slow_release.set()
            if child.poll() is None:
                try:
                    call('shutdown')
                    child.wait(timeout=15)
                except Exception:
                    child.terminate()
                    child.wait(timeout=15)
            server.shutdown()
            server.server_close()
            (run / 'transcript.json').write_text(json.dumps(driver.evidence, indent=2), encoding='utf-8')
            (run / 'hits.json').write_text(json.dumps(hits, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
