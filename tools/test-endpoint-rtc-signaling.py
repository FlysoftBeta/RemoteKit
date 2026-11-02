#!/usr/bin/env python3
"""Check real Endpoint trickle JSONL identity without a media connection."""
import argparse
import json
import queue
import subprocess
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--endpoint', type=Path, default=ROOT / 'build/endpoint-package/endpoint/endpoint_service.exe')
    parser.add_argument('--browser', type=Path, default=Path('C:/src/chromium/src/out/dev/remotekit_browser.exe'))
    parser.add_argument('--work-dir', type=Path, default=ROOT / 'develop/tmp/rtc-signaling-regression')
    args = parser.parse_args()
    run = args.work_dir / str(time.time_ns())
    run.mkdir(parents=True)
    tenant, connection = str(uuid.uuid4()), str(uuid.uuid4())
    # Syntax-valid receiving offer. No remote candidate or matching private key
    # is needed to check answer/candidate routing; no media connection is made.
    sdp = '\r\n'.join([
        'v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0',
        'm=video 9 UDP/TLS/RTP/SAVPF 96', 'c=IN IP4 0.0.0.0', 'a=mid:0',
        'a=ice-ufrag:signalingtest', 'a=ice-pwd:signalingtestpassword123456',
        'a=ice-options:trickle', 'a=fingerprint:sha-256 ' + ':'.join(['AA'] * 32),
        'a=setup:actpass', 'a=recvonly', 'a=rtcp-mux', 'a=rtpmap:96 H264/90000',
        'a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e02a', '',
    ])
    messages = queue.Queue()
    evidence = []
    with (run / 'stderr.log').open('wb') as log:
        child = subprocess.Popen([str(args.endpoint), '--browser=' + str(args.browser), '--data-path=' + str(run / 'state')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))

        def read():
            for line in child.stdout:
                try:
                    messages.put(json.loads(line))
                except ValueError:
                    messages.put({'invalidJson': True})

        threading.Thread(target=read, daemon=True).start()

        def send(request_id, method, **params):
            child.stdin.write((json.dumps({'id': request_id, 'method': method, 'tenantId': tenant, **params}) + '\n').encode())
            child.stdin.flush()

        try:
            send('ensure', 'session.ensure')
            ensured = messages.get(timeout=20)
            assert ensured.get('id') == 'ensure' and ensured.get('ok'), ensured
            internal_id = ensured['result']['sessionId']
            assert tenant != internal_id, 'test must distinguish Tenant UUID from internal Session ID'
            send('offer', 'rtc.offer', connectionId=connection, sdp=sdp, trickle=True)
            accepted = messages.get(timeout=5)
            assert accepted.get('id') == 'offer' and accepted.get('result', {}).get('pending') is True, accepted
            send('parallel', 'session.snapshot')
            answer_seen = complete_seen = parallel_seen = False
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and not (answer_seen and complete_seen and parallel_seen):
                message = messages.get(timeout=max(.01, deadline - time.monotonic()))
                if message.get('event') == 'rtc.signal':
                    assert message.get('tenantId') == tenant, {'tenantUuid': tenant, 'internalSessionId': internal_id, 'actual': message.get('tenantId')}
                    assert message.get('connectionId') == connection, message
                    signal = message['signal']
                    assert signal['type'] != 'error', signal
                    if signal['type'] == 'answer':
                        assert signal.get('sdp', '').startswith('v=0')
                        answer_seen = True
                    complete_seen |= signal['type'] == 'complete'
                    evidence.append({'event': message['event'], 'tenantId': message['tenantId'], 'connectionId': connection, 'signalType': signal['type']})
                elif message.get('id') == 'parallel':
                    assert message.get('ok'), message
                    parallel_seen = True
                else:
                    raise AssertionError(message)
            assert answer_seen and complete_seen and parallel_seen
            send('close', 'rtc.close', connectionId=connection)
            send('shutdown', 'shutdown')
            child.wait(timeout=15)
            assert child.returncode == 0
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=10)
    result = {'passed': True, 'tenantUuid': tenant, 'internalSessionId': internal_id, 'events': evidence, 'mediaConnected': False}
    (run / 'evidence.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps({'passed': True, 'evidence': str(run)}))


if __name__ == '__main__':
    main()
