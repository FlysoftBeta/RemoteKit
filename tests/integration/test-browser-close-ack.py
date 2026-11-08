#!/usr/bin/env python3
"""Verify close-payload ACK is idempotent, process-bound and keeps ID retirement."""
import argparse, ctypes as c, json, os, subprocess, time
from browser_key import spawn_browser
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser',type=Path,default=Path('C:/src/chromium/src/out/dev/remotekit_browser.exe'))
    parser.add_argument('--work-dir',type=Path,default=ROOT/'develop/tmp/browser-close-ack')
    args=parser.parse_args();run=args.work_dir/str(time.time_ns());run.mkdir(parents=True)
    os.add_dll_directory(str(args.browser.parent));sdk=c.CDLL(str(args.browser.parent/'remotekit_sdk.dll'))
    sdk.remotekit_sdk_control_connect.argtypes=[c.c_char_p,c.POINTER(c.c_uint64)]
    sdk.remotekit_sdk_control_request.argtypes=[c.c_uint64,c.c_void_p,c.c_size_t,c.c_void_p,c.c_size_t,c.POINTER(c.c_size_t),c.c_uint32]
    sdk.remotekit_sdk_control_close.argtypes=[c.c_uint64]
    assert sdk.remotekit_sdk_initialize()==0
    channel='RemoteKit.closeAck.'+str(time.time_ns());incarnation=channel;handle=c.c_uint64();evidence=[]
    with (run/'browser.log').open('wb') as log:
        browser=spawn_browser([str(args.browser),'--control-channel='+channel,'--browser-incarnation='+incarnation,
            '--session-id=1','--tenant-id=1','--remotekit-render-host=offscreen','--data-path='+str(run/'state')],
            stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            for _ in range(100):
                if sdk.remotekit_sdk_control_connect(channel.encode(),c.byref(handle))==0:break
                time.sleep(.05)
            assert handle.value
            def rpc(method,ok=True,**kwargs):
                request=dict(version=1,id=len(evidence)+1,method=method,session='1',**kwargs)
                data=json.dumps(request).encode();out=c.create_string_buffer(1024*1024);size=c.c_size_t()
                status=sdk.remotekit_sdk_control_request(handle,data,len(data),out,len(out),c.byref(size),10000)
                assert status==0,status
                reply=json.loads(out.raw[:size.value]);evidence.append(dict(request=request,response=reply));assert reply['ok'] is ok,reply
                return reply
            rpc('view.create',view='1',url='about:blank',width=320,height=240,visible=False,device='desktop')
            rpc('view.close',view='1',force=True)
            before=rpc('snapshot');assert before['sessions'][0]['views'][0]['close_state']=='closed'
            rpc('view.closed.ack',views=['1'],browserIncarnation='wrong-process',ok=False)
            still_pending=rpc('snapshot');assert len(still_pending['sessions'][0]['views'])==1
            rpc('view.closed.ack',views=['1'],browserIncarnation=incarnation)
            rpc('view.closed.ack',views=['1'],browserIncarnation=incarnation)
            after=rpc('snapshot');assert after['sessions'][0]['views']==[]
            rejected=rpc('view.create',view='1',url='about:blank',width=320,height=240,visible=False,device='desktop',ok=False)
            assert rejected['error']=='invalid_request' and rejected['detail']=='View id closed',rejected
            assert rpc('view.close',view='1',force=True)['completed']
        finally:
            if handle.value:sdk.remotekit_sdk_control_close(handle)
            try:browser.wait(timeout=10)
            except subprocess.TimeoutExpired:browser.kill();browser.wait()
            assert sdk.remotekit_sdk_shutdown()==0
            (run/'evidence.json').write_text(json.dumps(evidence,indent=2),encoding='utf-8')
    print(json.dumps(dict(passed=True,evidence=str(run))))
if __name__=='__main__':main()
