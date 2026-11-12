#!/usr/bin/env python3
"""Bounded real Browser checks for recovery scheduling, dirty state and close ACK."""
import base64
import sqlite3
import argparse, http.server, json, queue, subprocess, threading, time
from cluster_bridge import endpoint_command, SessionDriver
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class Service:
    def __init__(self, args, run, state):
        self.log = (run / (str(time.time_ns()) + '-service.log')).open('wb')
        self.process = subprocess.Popen(endpoint_command(args.endpoint, args.browser, state),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, creationflags=subprocess.CREATE_NO_WINDOW)
        self.driver = SessionDriver(self.process,state,"recover")
        self.evidence = self.driver.evidence

    def call(self, method, tenant='recover', ok=True, **kwargs):
        start=time.monotonic()
        response=self.driver.rpc(method,tenant,ok=ok,**kwargs)
        return response,time.monotonic()-start

    def snapshot(self, tenant='recover'):
        return self.driver.observe(tenant)

    def start(self, tenant='recover', **fields):
        started=time.monotonic()
        desired=self.driver.publish(tenant,run='running',commit=None,**fields)
        observed=self.driver.wait(lambda value:value['browser']=='running' and value['converged'] and value['observedRevision']==desired['revision'],tenant)
        return observed,time.monotonic()-started

    def view(self, tenant='recover', **fields):
        return self.driver.view(tenant,**fields)

    def wait(self, predicate, tenant='recover', timeout=60):
        return self.driver.wait(predicate,tenant,timeout)

    def close(self, eof=False):
        if self.process.poll() is None:
            if eof: self.process.stdin.close()
            else: self.call('shutdown')
            self.process.wait(timeout=15)
            assert self.process.returncode == 0
        self.log.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--endpoint', type=Path, default=ROOT/'build/endpoint/endpoint/endpoint_service.exe')
    parser.add_argument('--browser', type=Path, default=Path('C:/src/chromium/src/out/rel/remotekit_browser.exe'))
    parser.add_argument('--work-dir', type=Path, default=ROOT/'develop/tmp/recovery-regression')
    args = parser.parse_args(); run = args.work_dir/str(time.time_ns()); run.mkdir(parents=True)
    requests = []; visits = {}; block = threading.Event()
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            requests.append(dict(method='GET', path=self.path, at=time.time()))
            if block.is_set() and self.path.startswith('/state'): time.sleep(20)
            if self.path.startswith('/state'):
                visits[self.path]=visits.get(self.path,0)+1
                body = r'''<style>body{height:5000px;margin:0}</style><form><input id="field" name="field"></form><script>
                const visits=VISITS;
                const report=()=>document.title=JSON.stringify({visits,history:history.length,state:history.state,hash:location.hash,input:field.value,scroll:scrollY});
                if(visits===1){
                  setTimeout(()=>{history.pushState({phase:1},'',location.pathname+location.search+'#one');report()},100);
                  setTimeout(()=>{history.replaceState({phase:2},'',location.pathname+location.search+'#two');report()},600);
                  setTimeout(()=>{location.hash='three';history.replaceState({phase:3},'',location.href);report()},1100);
                  setTimeout(()=>{field.value='saved-form';field.dispatchEvent(new Event('input',{bubbles:true}));scrollTo(0,650);report()},1600);
                }
                setTimeout(report,2300);
                </script>'''.replace('VISITS',str(visits[self.path]))
            elif self.path.startswith('/post'):
                body = '''<form method="POST" action="/post"><input name="value" value="once"></form><script>
                if(FIRST){document.forms[0].submit()}else document.title='fresh-get';</script>'''.replace('FIRST','false' if any(r['method']=='POST' for r in requests) else 'true')
            else: body = '<title>fresh-target</title>'
            self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers()
            try: self.wfile.write(body.encode())
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError): pass
        def do_POST(self):
            self.rfile.read(int(self.headers.get('Content-Length','0')))
            requests.append(dict(method='POST',path=self.path,at=time.time()))
            self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers()
            self.wfile.write(b'<title>post-committed</title>')
    server = http.server.ThreadingHTTPServer(('127.0.0.1',0), Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    origin = 'http://127.0.0.1:'+str(server.server_port)
    state = run/'state'; service = Service(args,run,state); evidence=[]
    try:
        initial,_ = service.start(); session=initial['sessionId']
        session_db=state/'data/sessions'/session/'session.db'
        for index in range(1,5):
            url=origin+('/post' if index==4 else '/state?view='+str(index))
            service.view(viewId=str(index),url=url,width=320,height=240,visible=True,
                device=dict(mode='desktop',deviceScaleFactor=1))
        first=service.wait(lambda s:len(s['views'])==4 and all(not v.get('loading') for v in s['views']))
        document=first['views'][0]['document']; revisions=[]
        def captured(s):
            for view in s['views']:
                if view['viewId']=='1':
                    revisions.append(view.get('navigationRevision'))
                    try: report=json.loads(view.get('title',''))
                    except ValueError: return False
                    return report.get('hash')=='#three' and report.get('input')=='saved-form' and report.get('scroll')==650
            return False
        ready=service.wait(captured)
        assert not (state/'data/sessions'/session/'browser.log').exists()
        assert not (state/'data/sessions'/session/'crashes').exists()
        assert (state/'logs/browser'/(session+'.log')).exists()
        browser_log,_=service.call('session.logs.read',log='browser',maxBytes=131072)
        assert browser_log['exists'] and base64.b64decode(browser_log['data'])
        assert ready['views'][0]['document']==document,ready
        assert len(set(revisions))>=2,revisions
        database=sqlite3.connect(session_db, timeout=0)
        service.wait(lambda snapshot:database.execute('SELECT count(*) FROM navigation_recovery').fetchone()[0]==4)
        time.sleep(1)
        service.wait(lambda snapshot: all(database.execute('SELECT navigation_revision FROM navigation_recovery WHERE view_id=?',(view['viewId'],)).fetchone()==(int(view['navigationRevision']),) for view in snapshot['views']))
        saved=database.execute("SELECT navigation_revision,state FROM navigation_recovery WHERE view_id='1'").fetchone()
        for _ in range(3): service.snapshot();time.sleep(.15)
        assert database.execute("SELECT navigation_revision,state FROM navigation_recovery WHERE view_id='1'").fetchone()==saved,'unchanged recovery state changed'
        pid=ready['browserPid']; subprocess.run(['taskkill','/PID',str(pid),'/F'],check=True,capture_output=True)
        time.sleep(.15)
        # Observation and stale replies must not resurrect the old process.
        dead=service.snapshot(); assert dead['browserIncarnation'] != initial['browserIncarnation'] or dead['browser']=='stopped'
        crash_file=state/'logs/crashes'/session/'events.jsonl'
        crash=json.loads(crash_file.read_text().splitlines()[-1])
        assert crash['ev']=='browser.crashed' and crash['exitCode']!=0
        crash_log,_=service.call('session.logs.read',log='crashes',maxBytes=131072)
        assert crash_log['exists'] and b'browser.crashed' in base64.b64decode(crash_log['data'])
        stale,_=service.call('view.close.reply',ok=False,viewId='1',requestId='1',accept=True,
            instance='1',document='1',browserIncarnation=initial['browserIncarnation'])
        assert stale['error']['code']=='conflict'
        restarted,elapsed=service.start();assert elapsed<5,elapsed
        assert restarted['recovery']['pending'] and restarted['browserIncarnation']!=initial['browserIncarnation']
        other,other_elapsed=service.start('unrelated');assert other_elapsed<5,other_elapsed
        evidence.append(dict(coldEnsureSeconds=elapsed,otherTenantEnsureSeconds=other_elapsed))
        def restored_state(s):
            for view in s['views']:
                if view['viewId']=='1':
                    try: report=json.loads(view.get('title',''))
                    except ValueError:return False
                    return report.get('visits')==2 and report.get('input')=='saved-form' and report.get('scroll')==650
            return False
        restored=service.wait(restored_state)
        report=json.loads(next(v for v in restored['views'] if v['viewId']=='1')['title'])
        assert report['hash']=='#three' and report['state']=={'phase':3} and report['history']>=3,report
        assert all(v.get('recovery',{}).get('phase') in ('complete','fallback_started') for v in restored['views'])
        assert len([r for r in requests if r['method']=='POST'])==1,requests
        subprocess.run(['taskkill','/PID',str(restored['browserPid']),'/F'],check=True,capture_output=True)
        time.sleep(.15);service.snapshot();block.set()
        restarted,elapsed=service.start();assert elapsed<5,elapsed
        started=time.monotonic();service.snapshot('unrelated');other_elapsed=time.monotonic()-started;assert other_elapsed<1,other_elapsed
        evidence.append(dict(blockedRestoreEnsureSeconds=elapsed,otherTenantSnapshotSeconds=other_elapsed))
        waiting=service.wait(lambda s:any(v['viewId']=='1' and v.get('recovery',{}).get('phase')=='waiting' for v in s['views']))
        service.call('view.navigate',viewId='1',url=origin+'/fresh')
        service.wait(lambda s:any(v['viewId']=='1' and v.get('title')=='fresh-target' and not v.get('loading') for v in s['views']))
        # No API calls: maintenance must independently advance all four tasks.
        time.sleep(15)
        completed=service.snapshot()
        assert not completed['recovery']['pending'],completed['recovery']
        assert all(v.get('recovery',{}).get('phase','cancelled') in ('complete','fallback_started','cancelled') for v in completed['views'])
        assert next(v for v in completed['views'] if v['viewId']=='1')['title']=='fresh-target'
        assert len([r for r in requests if r['method']=='POST'])==1,requests
        block.clear()
        # A new explicit navigation cancels an old restoration, including its
        # transfer/lifecycle callback, and must stay authoritative afterwards.
        service.call('view.navigate',viewId='1',url=origin+'/fresh')
        live=service.wait(lambda s:any(v['viewId']=='1' and v.get('title')=='fresh-target' and not v.get('loading') for v in s['views']))
        assert live['views'][0].get('recovery',{}).get('pending') is not True
        database.close()
        service.wait(lambda snapshot: all(not view.get('loading') and not view.get('pending') for view in snapshot['views']),timeout=45)
        checkpoint=service.driver.commit('recovery-one')
        service.close(eof=True);evidence.extend(service.evidence)
        # A blocked write preserves the view and emits no closed event.
        # Reconciliation commits the close before Browser acknowledgement.
        service=Service(args,run,state)
        service.start(sessionId=session,placementEpoch=2,checkpoint=checkpoint['data']['base'])
        service.start()
        database=sqlite3.connect(session_db,timeout=0)
        service.view(viewId='8',url='about:blank',width=320,height=240,visible=False,
            device=dict(mode='desktop',deviceScaleFactor=1))
        database.execute('BEGIN IMMEDIATE')
        service.call('view.close',viewId='8',force=True,ok=False)
        database.rollback()
        replay=service.snapshot()
        service.wait(lambda snapshot:any(e['type']=='view.closed' and e['body']['viewId']=='8' for e in service.driver.events))
        service.view(viewId='9',url='about:blank',width=320,height=240,visible=False,
            device=dict(mode='desktop',deviceScaleFactor=1))
        database.execute('BEGIN IMMEDIATE')
        service.call('view.close',viewId='9',force=True,ok=False)
        assert database.execute("SELECT count(*) FROM views WHERE view_id='9'").fetchone()[0]==1
        assert database.execute("SELECT count(*) FROM retired_views WHERE view_id='9'").fetchone()[0]==0
        database.rollback()
        service.wait(lambda snapshot:any(event['type']=='view.closed' and event['body']['viewId']=='9' for event in service.driver.events))
        closed=service.snapshot()
        database.close()
        for event in list(service.driver.events):
            service.driver.acknowledge(event)
        service.wait(lambda snapshot: all(not view.get('loading') and not view.get('pending') for view in snapshot['views']))
        checkpoint=service.driver.commit('recovery-two')
        service.close();evidence.extend(service.evidence)
        service=Service(args,run,state)
        service.start(sessionId=session,placementEpoch=3,checkpoint=checkpoint['data']['base'])
        service.start()
        snapshot=service.snapshot();assert all(v['viewId']!='9' for v in snapshot['views'])
        # Idempotent repeated close is retained inside a single Browser even
        # after its full snapshot tombstone has been acknowledged.
        service.view(viewId='10',url='about:blank',width=320,height=240,visible=False,
            device=dict(mode='desktop',deviceScaleFactor=1))
        service.call('view.close',viewId='10',force=True)
        service.call('view.close',viewId='10',force=True)
        document=service.driver.document()
        service.driver.publish(views=document['views'])
        service.wait(lambda snapshot:all(view['viewId']!='10' for view in snapshot['views']))
        for event in list(service.driver.events):
            service.driver.acknowledge(event)
        service.wait(lambda snapshot: not snapshot['recovery']['pending'] and all(not view.get('loading') and not view.get('pending') for view in snapshot['views']),timeout=45)
        service.close()
        print(json.dumps(dict(passed=True,evidence=str(run),coldEnsureSeconds=elapsed,otherTenantEnsureSeconds=other_elapsed)))
    finally:
        if service.process.poll() is None: service.close()
        server.shutdown()
        (run/'evidence.json').write_text(json.dumps(dict(calls=evidence+service.evidence,http=requests),indent=2),encoding='utf-8')

if __name__=='__main__': main()
