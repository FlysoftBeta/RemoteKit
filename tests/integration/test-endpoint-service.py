#!/usr/bin/env python3
"""Exercise the real JSONL Endpoint service and isolated browser processes."""
import argparse,json,os,queue,subprocess,threading,time
from cluster_bridge import endpoint_command
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
ROOT=Path(__file__).resolve().parents[2]
def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--endpoint',type=Path,default=ROOT/'build/endpoint/endpoint/endpoint_service.exe')
 p.add_argument('--browser',type=Path,default=Path('C:/src/chromium/src/out/dev/remotekit_browser.exe'))
 p.add_argument('--recovery',action='store_true')
 p.add_argument('--snapshot-lifecycle',action='store_true',help='Check observation never launches or restarts a Browser')
 p.add_argument('--device-info',action='store_true')
 p.add_argument('--tenants',type=int,default=1)
 p.add_argument('--work-dir',type=Path,default=ROOT/'develop/tmp/service-smoke')
 a=p.parse_args();a.work_dir.mkdir(parents=True,exist_ok=True)
 run=a.work_dir/str(time.time_ns());run.mkdir()
 fixture=run/'fixture.html'
 fixture.write_text('<meta name="viewport" content="width=device-width,initial-scale=1"><script>'
  'if(location.hash==="#device"){const report=()=>document.title=JSON.stringify({ua:navigator.userAgent,platform:navigator.platform,'
  'chPlatform:navigator.userAgentData?.platform,mobile:navigator.userAgentData?.mobile,dpr:devicePixelRatio,'
  'coarse:matchMedia("(pointer:coarse)").matches,hover:matchMedia("(hover:hover)").matches,'
  'touchPoints:navigator.maxTouchPoints,width:innerWidth,height:innerHeight,screenWidth:screen.width,screenHeight:screen.height});report();setInterval(report,100);}'
  'else{localStorage.visits=String(Number(localStorage.visits||0)+1);document.title="visits:"+localStorage.visits;}</script>',encoding='utf-8')
 class FixtureHandler(BaseHTTPRequestHandler):
  def do_GET(self):
   self.send_response(200)
   self.send_header('Content-Type','text/html; charset=utf-8')
   self.end_headers()
   self.wfile.write(fixture.read_bytes())
  def log_message(self,*args):pass
 fixture_server=ThreadingHTTPServer(('127.0.0.1',0),FixtureHandler)
 threading.Thread(target=fixture_server.serve_forever,daemon=True).start()
 fixture_origin='http://127.0.0.1:'+str(fixture_server.server_port)
 fixture_url=fixture_origin+'/fixture'
 with (run/'stderr.log').open('wb') as log:
  child=subprocess.Popen(endpoint_command(a.endpoint, a.browser, run/'state', maxSessions=max(3, a.tenants)),
    stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
  replies=queue.Queue()
  def read():
   for line in child.stdout:
    try:replies.put(json.loads(line))
    except ValueError:replies.put({'ok':False,'error':'invalid stdout: '+repr(line)})
  threading.Thread(target=read,daemon=True).start();serial=0;evidence=[]
  def call(method,tenant='test-tenant-1',**args):
   nonlocal serial
   serial+=1;request={'id':str(serial),'method':method,'tenantId':tenant,**args}
   child.stdin.write((json.dumps(request)+'\n').encode());child.stdin.flush()
   reply=replies.get(timeout=30)
   evidence.append({'request':request,'response':reply})
   if reply.get('id')!=str(serial) or not reply.get('ok'):raise RuntimeError(reply)
   return reply['result']
  try:
   if a.snapshot_lifecycle:
    def rejected_maintenance():
     for method,args in [('view.configure',{'visible':False}),('view.lifecycle',{'action':'discard'})]:
      try:call(method,viewId='1',requireRunning=True,**args)
      except RuntimeError as error:assert 'browser not running' in str(error),error
      else:raise AssertionError('guarded maintenance started an offline Browser')
    rejected_maintenance()
    for _ in range(3):
     state=call('session.snapshot')
     assert state['running'] is False and state['browserPid']==0 and state['views']==[] and state['events']==[],state
    launched=call('session.ensure');pid=launched['browserPid']
    assert pid>0 and call('session.ensure')['browserPid']==pid
    call('view.ensure',viewId='1',url='about:blank',width=640,height=480,visible=False,
      device={'deviceScaleFactor':1})
    call('view.configure',viewId='1',requireRunning=True,visible=False)
    live=call('session.snapshot');assert live['running'] and len(live['views'])==1,live
    # Kill only this test's Browser root. Endpoint must observe the exact exit,
    # terminate its retained job and preserve desired/recovery state itself.
    import ctypes
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.OpenProcess.restype=ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes=[ctypes.c_void_p,ctypes.c_uint32]
    kernel.CloseHandle.argtypes=[ctypes.c_void_p]
    handle=kernel.OpenProcess(0x00100000,False,pid)
    assert handle,ctypes.get_last_error()
    try:
     subprocess.run(['taskkill','/PID',str(pid),'/F'],check=True,capture_output=True)
     assert kernel.WaitForSingleObject(handle,10000)==0
    finally:kernel.CloseHandle(handle)
    rejected_maintenance()
    for _ in range(3):
     state=call('session.snapshot')
     assert state['running'] is False and state['browserPid']==0 and state['views']==[] and state['pendingPopups']==[],state
     assert state['events']==live['events'],state
    restarted=call('session.ensure');assert restarted['browserPid']!=pid,restarted
    state=call('session.snapshot');assert state['running'] and len(state['views'])==1,state
    call('shutdown');child.wait(timeout=15);assert child.returncode==0
    log.flush();launches=(run/'stderr.log').read_text(encoding='utf-8',errors='replace').count(' browser command ')
    assert launches==2,launches
    (run/'evidence.json').write_text(json.dumps(evidence,indent=2),encoding='utf-8')
    print(json.dumps({'passed':True,'browserLaunches':launches,'evidence':str(run)}));return
   ids=[]
   for index in range(a.tenants):
    tenant='test-tenant-'+str(index+1);session=call('session.ensure',tenant);ids.append(session['sessionId'])
    view=str(index*100+1)
    args={'viewId':view,'url':fixture_url if a.recovery else 'about:blank','width':1280,'height':720,'visible':True,
      'device':{'width':1280,'height':720,'deviceScaleFactor':1}}
    call('view.ensure',tenant,**args);call('view.ensure',tenant,**args)
    state=call('session.snapshot',tenant)
    assert [v['viewId'] for v in state['views']]==[view],state
    if a.recovery:
     deadline=time.monotonic()+15
     while time.monotonic()<deadline:
      state=call('session.snapshot',tenant)
      if state['views'][0].get('title')=='visits:1' and not state['views'][0].get('loading'):break
      time.sleep(.05)
     assert state['views'][0].get('title')=='visits:1',state
     time.sleep(6)
     os.kill(state['browserPid'],9)
     time.sleep(.1)
     call('session.ensure',tenant)
     deadline=time.monotonic()+20
     while time.monotonic()<deadline:
      state=call('session.snapshot',tenant)
      if state['views'] and state['views'][0].get('title')=='visits:2' and not state['views'][0].get('loading'):break
      time.sleep(.05)
     assert state['sessionId']==session['sessionId'],state
     assert state['views'][0].get('title')=='visits:2',state

    # Background tabs retain independent viewport dimensions without consuming
    # the active plane's atlas extent.
    args.update(viewId=str(index*100+2),width=820,height=1180,visible=False,
      device={'width':820,'height':1180,'deviceScaleFactor':2})
    call('view.ensure',tenant,**args)
    state=call('session.snapshot',tenant);assert len(state['views'])==2,state
    if a.device_info:
     # Independent page DPR must survive a common 2x capture atlas and hidden
     # tabs. Use live renderer values rather than the requested configuration.
     device_url=fixture_url+'?device=1#device'
     call('view.navigate',tenant,viewId=view,url=device_url)
     call('view.configure',tenant,viewId=args['viewId'],visible=True,width=820,height=1180,device=args['device'])
     call('view.navigate',tenant,viewId=args['viewId'],url=device_url)
     deadline=time.monotonic()+15
     while time.monotonic()<deadline:
      state=call('session.snapshot',tenant);observed={}
      for item in state['views']:
       try:observed[item['viewId']]=json.loads(item.get('title',''))
       except ValueError:pass
      if abs(observed.get(view,{}).get('dpr',0)-1)<1e-5 and abs(observed.get(args['viewId'],{}).get('dpr',0)-2)<1e-5:break
      time.sleep(.1)
     assert abs(observed.get(view,{}).get('dpr',0)-1)<1e-5,observed
     assert abs(observed.get(args['viewId'],{}).get('dpr',0)-2)<1e-5,observed
     native=observed[view]
     assert native['chPlatform']=='Windows',native
     # The origin UA preference changes identity without changing input capabilities.
     call('view.configure',tenant,viewId=view,visible=True,width=1280,height=720,
       device={'width':1280,'height':720,'deviceScaleFactor':2})
     call('session.sitePreferences',tenant,sites={fixture_origin:{'tabletUa':True}})
     call('view.command',tenant,viewId=view,command='reload')
     deadline=time.monotonic()+15
     while time.monotonic()<deadline:
      state=call('session.snapshot',tenant);changed={};changed_loading=True
      for item in state['views']:
       if item['viewId']==view:
        changed_loading=item.get('loading',True)
        try:changed=json.loads(item.get('title',''))
        except ValueError:pass
      if changed.get('chPlatform')=='Android' and not changed_loading:break
      time.sleep(.1)
     assert changed.get('chPlatform')=='Android' and 'Android' in changed.get('ua',''),changed
     assert all(changed[key]==native[key] for key in ['coarse','hover','touchPoints']),changed
    call('view.close',tenant,viewId=view,force=True)
    call('view.configure',tenant,viewId=args['viewId'],visible=True,width=820,height=1180,device=args['device'])
    state=call('session.snapshot',tenant);assert len(state['views'])==1,state
    if a.device_info:
     call('view.navigate',tenant,viewId=args['viewId'],url=device_url)
     info={};deadline=time.monotonic()+15
     while time.monotonic()<deadline:
      state=call('session.snapshot',tenant)
      try:info=json.loads(state['views'][0].get('title',''))
      except ValueError:pass
      if abs(info.get('dpr',0)-2)<1e-5 and info.get('chPlatform')=='Android' and not state['views'][0].get('loading'):break
      time.sleep(.05)
     assert info.get('platform')=='Linux armv81' and info.get('chPlatform')=='Android',info
     assert 'Android' in info['ua'] and 'Mobile' not in info['ua'],info
     assert info['mobile'] is False and not info['coarse'] and info['hover'] and info['touchPoints']==0,info
     assert abs(info['dpr']-2)<1e-5 and info['width']==820 and info['height']==1180,info
    call('view.close',tenant,viewId=args['viewId'],force=True)
    state=call('session.snapshot',tenant);assert state['views']==[],state
   assert len(set(ids))==len(ids)
   call('shutdown')
   child.wait(timeout=15);assert child.returncode==0
   (run/'evidence.json').write_text(json.dumps(evidence,indent=2),encoding='utf-8')
   print(json.dumps({'passed':True,'tenants':a.tenants,'evidence':str(run)}))
  finally:
   (run/'evidence.json').write_text(json.dumps(evidence,indent=2),encoding='utf-8')
   if child.poll() is None:
    child.terminate();child.wait(timeout=15)
   fixture_server.shutdown();fixture_server.server_close()
if __name__=='__main__':main()
