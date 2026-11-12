#!/usr/bin/env python3
"""Check real Endpoint trickle JSONL identity without a media connection."""
import argparse
import json
import queue
import subprocess
import threading
import time
import uuid
from cluster_bridge import endpoint_command, SessionDriver
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


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
        child = subprocess.Popen(endpoint_command(args.endpoint, args.browser, run / 'state'), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))

        driver=SessionDriver(child,run/'state',tenant)
        try:
            driver.publish(run='running')
            observed=driver.wait(lambda value:value['browser']=='running')
            internal_id=observed['sessionId']
            assert tenant!=internal_id
            accepted=driver.rpc('rtc.offer',connectionId=connection,leaseId='probe',sdp=sdp,trickle=True,avSync=False)
            assert accepted['pending'] is True,accepted
            # Observations continue while candidate gathering is in progress.
            assert driver.observe()['browser']=='running'
            with driver.condition:
                assert driver.condition.wait_for(lambda:any(value['signal']['type']=='complete' for value in driver.signals),15),driver.signals
            signals=list(driver.signals)
            assert any(value['signal']['type']=='answer' and value['signal']['sdp'].startswith('v=0') for value in signals),signals
            for message in signals:
                assert message['tenantId']==tenant and message['connectionId']==connection,message
                assert message['signal']['type']!='error',message
                evidence.append(dict(event=message['event'],tenantId=tenant,connectionId=connection,signalType=message['signal']['type']))
            driver.rpc('rtc.close',connectionId=connection)
            driver.rpc('shutdown')
            child.wait(timeout=20)
            assert child.returncode==0
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=10)
    result = {'passed': True, 'tenantUuid': tenant, 'internalSessionId': internal_id, 'events': evidence, 'mediaConnected': False}
    (run / 'evidence.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps({'passed': True, 'evidence': str(run)}))


if __name__ == '__main__':
    main()
