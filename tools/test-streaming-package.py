#!/usr/bin/env python3
"""Test a streaming package's normal login, WebSocket, SQLite and browser startup."""
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
   'scope':'bundled Node + production UI assets + user registration + WebSocket + SQLite + Endpoint/browser management; no RTC media',
   'rtcMediaTested':False};child=None
 try:
  for relative in ['bin/node.exe','bin/endpoint_service.exe','bin/remotekit_browser.exe','control/dist/server.mjs','control/dist/client/index.html']:
   if not (package/relative).is_file():raise FileNotFoundError(relative)
  result['endpointSha256']=hashlib.sha256((package/'bin/endpoint_service.exe').read_bytes()).hexdigest()
  with socket.socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
  origin='http://127.0.0.1:'+str(port);env=os.environ.copy()
  opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
  for name in ['NODE_PATH','NODE_OPTIONS','REMOTEKIT_HTTPS_KEY','REMOTEKIT_HTTPS_CERT','REMOTEKIT_NETWORK_SIM','REMOTEKIT_DIAGNOSTICS','REMOTEKIT_RTC_LOOPBACK_TEST']:env.pop(name,None)
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
     with opener.open(origin+'/',timeout=2) as response:response.read()
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
   check=subprocess.run([str(package/'bin/node.exe'),str(ROOT/'tools/smoke-streaming-product.mjs'),
     str(package),origin],cwd=run,env=env,capture_output=True,text=True,encoding='utf-8',timeout=55)
   (run/'product-smoke.stderr.log').write_text(check.stderr,encoding='utf-8')
   if check.returncode:raise AssertionError('Product WebSocket smoke failed: '+check.stderr)
   result.update(passed=True,assets=assets,**json.loads(check.stdout))
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
