#!/usr/bin/env python3
"""Verify fixed-extent layout and keyboard pixels with the real OSR consumer."""
import argparse
import json
from pathlib import Path
import subprocess
import uuid
from browser_key import spawn_browser

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', type=Path, default=Path('C:/src/chromium/src/out/dev/remotekit_browser.exe'))
    parser.add_argument('--consumer', type=Path, default=ROOT / 'build/endpoint/endpoint/endpoint_browser_layout_consumer.exe')
    parser.add_argument('--work-dir', type=Path, default=ROOT / 'develop/tmp/browser-layout-resources')
    args = parser.parse_args()
    run = args.work_dir / uuid.uuid4().hex[:12]
    run.mkdir(parents=True)
    channel = 'RemoteKit.layout.' + uuid.uuid4().hex
    with (run / 'browser.log').open('wb') as log:
        browser = spawn_browser([str(args.browser), '--control-channel=' + channel,
            '--browser-incarnation=' + channel, '--session-id=1', '--tenant-id=1',
            '--remotekit-render-host=offscreen', '--data-path=' + str(run / 'state')],
            stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            subprocess.run([str(args.consumer), str(args.browser.parent / 'remotekit_sdk.dll'),
                channel, str(browser.pid), str(run / 'evidence.json')], check=True, timeout=90)
        finally:
            try:
                browser.wait(timeout=15)
            except subprocess.TimeoutExpired:
                browser.kill()
                browser.wait()
    print(json.dumps(dict(evidence=str(run))))


if __name__ == '__main__':
    main()
