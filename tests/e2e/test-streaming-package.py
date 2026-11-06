#!/usr/bin/env python3
"""Test bundled streaming startup/auth/management; RTC product/media checks require a real Viewer."""
import argparse,hashlib,json,os,re,socket,subprocess,sys,time,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def main():
 p=argparse.ArgumentParser(description=__doc__)
 source=p.add_mutually_exclusive_group(required=True)
 source.add_argument('--package',type=Path)
 source.add_argument('--archive',type=Path,help='Extract and validate a .tar.zst using zstd-capable tar')
 p.add_argument('--tar',default=str(Path(os.environ.get('SystemRoot','C:/Windows'))/'System32/tar.exe') if os.name=='nt' else 'tar')
 p.add_argument('--work-dir',type=Path,default=ROOT/'develop/tmp/package-smoke')
 a=p.parse_args();package=a.package.resolve() if a.package else None
 run=a.work_dir.resolve()/str(time.time_ns());run.mkdir(parents=True)
 result={'passed':False,'package':str(package),'evidence':str(run),
   'scope':'startup: bundled Node + production UI assets + SQLite first-admin registration + authenticated WebSocket state + clock/admin + Endpoint management reconciliation and face model availability + Viewer reattachment lock and password recovery + rejected WS browser action with unchanged workspace; no RTC product operations or media',
   'validationKind':'startup','browserProductOperationsTested':False,'rtcMediaTested':False};child=None
 try:
  if a.archive:
   archive=a.archive.resolve()
   if not archive.name.endswith('.tar.zst'):raise ValueError('Expected .tar.zst archive')
   expected=archive.with_name(archive.name+'.sha256').read_text(encoding='ascii').split()[0]
   with archive.open('rb') as stream:actual=hashlib.file_digest(stream,'sha256').hexdigest()
   if actual!=expected:raise ValueError('Archive SHA-256 mismatch')
   extracted=run/'extracted';extracted.mkdir()
   subprocess.run([a.tar,'-xf',str(archive),'-C',str(extracted)],check=True,capture_output=True)
   package=extracted/archive.name.removesuffix('.tar.zst')
   result.update(package=str(package),archive=str(archive),archiveSha256=actual)
  if (package/'manifest.json').is_file():
   manifest=json.loads((package/'manifest.json').read_text(encoding='utf-8'))
   if manifest['archive']!=package.name+'.tar.zst':raise ValueError('Manifest archive name mismatch')
   if manifest['browser_configuration'] not in ['dev','rel']:raise ValueError('Unknown browser configuration')
   result['browserConfiguration']=manifest['browser_configuration']
  for relative in ['bin/node.exe','bin/endpoint_service.exe','bin/remotekit_browser.exe','control/dist/server.mjs','control/dist/client/index.html']:
   if not (package/relative).is_file():raise FileNotFoundError(relative)
  result['endpointSha256']=hashlib.sha256((package/'bin/endpoint_service.exe').read_bytes()).hexdigest()
  with socket.socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
  origin='http://127.0.0.1:'+str(port);env=os.environ.copy()
  opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
  for name in ['NODE_PATH','NODE_OPTIONS']:env.pop(name,None)
  config=run/'control.json'
  config.write_text(json.dumps({
    'http':{'host':'127.0.0.1','port':port,'origins':[origin]},
    'database':str(run/'control.db'),'diagnostics':str(run/'diagnostics'),
    'nodeDefaults':{'browser':str(package/'bin/remotekit_browser.exe'),'dataPath':str(run/'endpoint')},
    'nodes':{'local':{'launch':{'executable':str(package/'bin/endpoint_service.exe'),'root':str(run/'node')}}}
  }),encoding='utf-8')
  env['REMOTEKIT_CONTROL_CONFIG']=str(config)
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
   check=subprocess.run([str(package/'bin/node.exe'),str(ROOT/'tests/e2e/smoke-streaming-product.mjs'),
     str(package),origin],cwd=run,env=env,capture_output=True,text=True,encoding='utf-8',timeout=55)
   (run/'product-smoke.stderr.log').write_text(check.stderr,encoding='utf-8')
   if check.returncode:raise AssertionError('Startup WebSocket smoke failed: '+check.stderr)
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
if __name__=='__main__':
 # Structured subprocess output has an explicit encoding even under Windows'
 # legacy console code page, including errors containing non-ASCII paths/text.
 sys.stdout.reconfigure(encoding='utf-8',errors='backslashreplace')
 sys.stderr.reconfigure(encoding='utf-8',errors='backslashreplace')
 raise SystemExit(main())
