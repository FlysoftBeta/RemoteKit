#!/usr/bin/env python3
"""Exercise atomic atlas transactions and persistence retry in a real Browser."""
import argparse, importlib.util, json, time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('recovery_test',ROOT/'tools/test-endpoint-recovery.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--endpoint',type=Path,default=ROOT/'build/endpoint/endpoint/endpoint_service.exe')
    parser.add_argument('--browser',type=Path,default=Path('C:/src/chromium/src/out/dev/remotekit_browser.exe'))
    parser.add_argument('--work-dir',type=Path,default=ROOT/'develop/tmp/geometry-regression')
    args=parser.parse_args();run=args.work_dir/str(time.time_ns());run.mkdir(parents=True)
    service=module.Service(args,run,run/'state')
    try:
        initial,_=service.call('session.ensure');sid=initial['sessionId']
        device=dict(mode='desktop',deviceScaleFactor=1)
        service.call('view.ensure',viewId='1',url='about:blank',width=7000,height=800,visible=True,device=device)
        service.call('view.configure',viewId='1',width=800,height=7000,visible=True,device=device)
        snapshot,_=service.call('session.snapshot');view=snapshot['views'][0]
        assert (view['width'],view['height'])==(800,7000),view
        token=(view['instance'],view['document'])
        # Both endpoints fit; max(old,new) would require >49 million pixels.
        service.call('view.configure',viewId='1',width=7000,height=800,visible=True,device=device)
        snapshot,_=service.call('session.snapshot');view=snapshot['views'][0]
        assert (view['width'],view['height'])==(7000,800) and token==(view['instance'],view['document'])
        failed,_=service.call('view.configure',viewId='1',width=8192,height=8192,visible=True,device=device,ok=False)
        assert 'resource budget' in failed['error'],failed
        unchanged,_=service.call('session.snapshot');view=unchanged['views'][0]
        assert (view['width'],view['height'])==(7000,800) and token==(view['instance'],view['document'])
        # Commit succeeds but persistence fails. Keep new desired/source specs;
        # retrying the identical request must repair disk and output state.
        block=run/'state/sessions'/sid/'views.json.new';block.mkdir()
        service.call('view.configure',viewId='1',width=1600,height=1200,visible=True,device=device,ok=False)
        snapshot,_=service.call('session.snapshot');view=snapshot['views'][0]
        assert (view['width'],view['height'])==(1600,1200) and snapshot['stats']['reconciliationPending']
        block.rmdir()
        service.call('view.configure',viewId='1',width=1600,height=1200,visible=True,device=device)
        snapshot,_=service.call('session.snapshot');assert not snapshot['stats']['reconciliationPending']
        saved=json.loads((run/'state/sessions'/sid/'views.json').read_text())
        assert saved[0]['width']==1600 and saved[0]['height']==1200,saved
        # Logical width may exceed physical 8192 at DPR .5, while each viewport
        # retains its requested dimensions and the Browser identity stays stable.
        half=dict(mode='desktop',deviceScaleFactor=.5)
        service.call('view.configure',viewId='1',width=8192,height=2000,visible=True,device=half)
        snapshot,_=service.call('session.snapshot');view=snapshot['views'][0]
        assert view['width']==8192 and view['deviceScaleFactor']==.5,view
        for index in range(1,5):
            method='view.configure' if index==1 else 'view.ensure'
            extra={} if index==1 else {'url':'about:blank'}
            service.call(method,viewId=str(index),width=2100,height=1000,visible=True,device=device,**extra)
        snapshot,_=service.call('session.snapshot')
        assert len(snapshot['views'])==4 and all(v['width']==2100 and v['height']==1000 for v in snapshot['views'])
        assert not snapshot['stats']['reconciliationPending']
        service.close()
        print(json.dumps(dict(passed=True,evidence=str(run),checks=['landscape-portrait','invalid-budget-unchanged','persistence-noop-retry','dpr-half','four-plane-packing'])))
    finally:
        if service.process.poll() is None:service.close()
        (run/'evidence.json').write_text(json.dumps(service.evidence,indent=2),encoding='utf-8')
if __name__=='__main__':main()
