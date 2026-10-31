#!/usr/bin/env python3
"""Launch a self-contained streaming package and test HTTP, SQLite and browser startup."""
import argparse,hashlib,json,os,re,socket,subprocess,time,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--package',type=Path,required=True)
 p.add_argument('--work-dir',type=Path,default=ROOT/'develop/tmp/package-smoke')
 a=p.parse_args();package=a.package.resolve()
 run=a.work_dir.resolve()/str(time.time_ns());run.mkdir(parents=True)
 result={'passed':False,'package':str(package),'evidence':str(run),
   'scope':'bundled Node + production UI assets + SQLite + Endpoint/browser management; no RTC media',
   'rtcMediaTested':False};child=None
 try:
  for relative in ['bin/node.exe','bin/endpoint_service.exe','bin/remotekit_browser.exe','control/dist/server.mjs','control/dist/client/index.html']:
   if not (package/relative).is_file():raise FileNotFoundError(relative)
  result['endpointSha256']=hashlib.sha256((package/'bin/endpoint_service.exe').read_bytes()).hexdigest()
  with socket.socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
  origin='http://127.0.0.1:'+str(port);env=os.environ.copy()
  opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
  for name in ['NODE_PATH','NODE_OPTIONS','REMOTEKIT_HTTPS_KEY','REMOTEKIT_HTTPS_CERT','REMOTEKIT_NETWORK_SIM']:env.pop(name,None)
  env.update(PORT=str(port),REMOTEKIT_CONTROL_HOST='127.0.0.1',REMOTEKIT_CONTROL_ORIGINS=origin,
    REMOTEKIT_CONTROL_DB=str(run/'control.db'),REMOTEKIT_METRICS_DIR=str(run/'metrics'),
    REMOTEKIT_ENDPOINT=str(package/'bin/endpoint_service.exe'),
    REMOTEKIT_ENDPOINT_ARGS=json.dumps(['--browser='+str(package/'bin/remotekit_browser.exe'),'--data-path='+str(run/'endpoint')]))
  with (run/'stderr.log').open('wb') as errors,(run/'stdout.log').open('wb') as output:
   child=subprocess.Popen([str(package/'bin/node.exe'),str(package/'control/dist/server.mjs')],cwd=package,
     env=env,stdout=output,stderr=errors,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
   deadline=time.monotonic()+20
   while True:
    try:
     with opener.open(origin+'/api/state',timeout=2) as response:
      cookie=response.headers['Set-Cookie'].split(';',1)[0];initial=json.load(response)
     break
    except (OSError,TypeError):
     if child.poll() is not None or time.monotonic()>deadline:raise
     time.sleep(.1)
   with opener.open(origin+'/',timeout=5) as response:html=response.read().decode('utf-8')
   assets=re.findall(r'(?:src|href)="(/assets/[^"<>]+)"',html)
   if not assets:raise AssertionError('No production UI assets')
   for asset in assets:
    with opener.open(origin+asset,timeout=5) as response:
     if not response.read():raise AssertionError('Empty UI asset '+asset)
   request=urllib.request.Request(origin+'/api/actions',data=json.dumps({'type':'tab.create','url':'about:blank'}).encode(),
     headers={'Content-Type':'application/json','Origin':origin,'Cookie':cookie},method='POST')
   with opener.open(request,timeout=25) as response:state=json.load(response)
   deadline=time.monotonic()+20
   while True:
    if state.get('endpointError'):raise AssertionError(state['endpointError'])
    if len(state.get('tabs',[]))==1 and state['tabs'][0].get('loading') is False:break
    if time.monotonic()>deadline:raise AssertionError('Browser snapshot did not finish loading: '+str(state))
    time.sleep(.1)
    with opener.open(urllib.request.Request(origin+'/api/state',headers={'Cookie':cookie}),timeout=5) as response:state=json.load(response)
   view=state['tabs'][0]['webviewId']
   if state['tenantId']!=initial['tenantId'] or not str(view).isdigit() or int(view)==0:raise AssertionError(state)
   result.update(passed=True,tenantId=state['tenantId'],viewId=view,assets=assets,state=state)
 except Exception as error:result['error']=str(error)
 finally:
  if child is not None and child.poll() is None:
   # This PID is the owned test Node process; terminate its service/browser tree.
   try:
    subprocess.run(['taskkill.exe','/PID',str(child.pid),'/T','/F'],capture_output=True,timeout=15)
    child.wait(timeout=15)
   except Exception as error:result.update(passed=False,cleanupError=str(error))
  (run/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
 print(json.dumps(result,ensure_ascii=False))
 return 0 if result['passed'] else 1
if __name__=='__main__':raise SystemExit(main())
