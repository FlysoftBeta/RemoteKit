// Requires REMOTEKIT_DIAGNOSTICS=1 and isolated temporary browser context.
// Configuration-driven /automation media/input correctness; does not validate product UI.
async hostPage => {
  const config = /* CONFIG */ { origin: 'http://127.0.0.1:3001' };
  const directory='C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/control-close-final';
  const browser=await hostPage.context().browser().browserType().launch({executablePath:'C:/src/tmp/chrome89-google/app/chrome.exe',headless:false,args:['--no-first-run','--no-default-browser-check','--disable-features=WebRtcHideLocalIpsWithMdns','--autoplay-policy=no-user-gesture-required']});
  const context=await browser.newContext({viewport:{width:1024,height:1000},hasTouch:true}),page=await context.newPage(),stages=[];
  const action=body=>page.evaluate(body=>window.remotekitDiagnostics.action(body),body);
  const capture=async(stage,extra={})=>{
    const report=await page.evaluate(async({stage,extra})=>{const t=window.remotekitDiagnostics.transport;return {kind:'automation-close-functional',stage,...extra,state:await window.remotekitDiagnostics.refresh(),diagnostics:t.diagnostics,presentation:t.presentationDiagnostics,inputTrace:t.inputTrace,inputResults:t.inputResults,layout:t.layout,sourceJpeg:t.displayFrame?t.displayFrame.toDataURL('image/jpeg',.5):undefined};},{stage,extra});
    if(JSON.stringify(report).length>900000){delete report.sourceJpeg;report.imageOmittedForSize=true;}
    await page.evaluate(async report=>{const r=await fetch('/api/metrics',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)});if(!r.ok)throw Error(`metrics ${r.status}`);},report);
    await page.screenshot({path:`${directory}/${stage}.png`,fullPage:true});stages.push({stage,tabs:report.state.tabs.length,pendingClose:report.state.pendingClose});return report;
  };
  try{
    const gate=await page.request.get(config.origin+'/api/state');
    if(gate.status()!==200)throw Error('Explicit diagnostics server required (REMOTEKIT_DIAGNOSTICS=1), with fresh isolated session: '+gate.status()+' '+await gate.text());
    await page.goto(config.origin+'/automation');
    await page.waitForFunction(()=>window.remotekitDiagnostics?.state);
    await page.evaluate(()=>{if(window.remotekitDiagnostics.automaticQualityPolicy!==false)throw Error('Controlled automation requires adaptive quality disabled');});
    await action({type:'device.set',device:{mode:'tablet',width:820,height:1180,deviceScaleFactor:2}});
    const state=await action({type:'tab.create',url:config.origin+'/test-pattern.html?mode=static&beforeunload=1&activationMarker=1&title=Close-Confirmation'}),id=state.activeTabId;
    await page.evaluate(async()=>{const api=window.remotekitDiagnostics;api.configure({receiveProfile:'chrome89-h264-51',frameSource:'video'});await api.refresh();await api.transport.connect();});
    await page.waitForFunction(()=>document.querySelector('.remote-viewport canvas:not(.no-frame)')&&window.remotekitDiagnostics.transport.displayReady,null,{timeout:20000});
    const point=await page.evaluate(()=>{const r=document.querySelector('.remote-viewport canvas').getBoundingClientRect(),v=window.remotekitDiagnostics.transport.layout.views[0],scale=v.deviceScaleFactor*(v.mediaScale??1);return{x:r.left+r.width*350*scale/v.width,y:r.top+r.height*30*scale/v.height};});await page.touchscreen.tap(point.x,point.y);
    const activation=await page.evaluate(async()=>{const{decodeMarker}=await import('/marker-codec.js'),t=window.remotekitDiagnostics.transport,c=document.createElement('canvas');c.width=256;c.height=112;const ctx=c.getContext('2d'),end=performance.now()+5000;let last;while(performance.now()<end){const s=t.layout?.views[0],f=s&&t.getLastPresentation(s.id),atlas=f&&!t.getPresentedPlane&&t.getPaintedFrame(s.id,f.rtpTimestamp),source=f&&(t.getPresentedPlane?t.getPresentedPlane(s.id,f.rtpTimestamp):atlas&&{image:atlas,sourceRect:s});if(source){const scale=s.deviceScaleFactor*(s.mediaScale??1);ctx.drawImage(source.image,source.sourceRect.x,source.sourceRect.y,256*scale,112*scale,0,0,256,112);last=decodeMarker(ctx.getImageData(0,0,256,112));if(last?.stimulus===60001)return last;}await new Promise(r=>setTimeout(r,20));}return last;});
    await capture('activated-small-tablet',{activation});if(activation?.stimulus!==60001)throw Error('Remote userActivation.hasBeenActive was not confirmed by received pixels');
    const pending=async()=>{await page.waitForFunction(()=>window.remotekitDiagnostics.state?.pendingClose?.requestId&&!window.remotekitDiagnostics.state.pendingClose.awaiting,null,{timeout:10000});return page.evaluate(()=>window.remotekitDiagnostics.state.pendingClose);};
    await action({type:'tab.close',id});const first=await pending();await capture('confirmation');
    await action({type:'tab.close',id,requestId:first.requestId,cancel:true});
    const canceled=await capture('canceled');if(!canceled.state.tabs.some(tab=>tab.id===id)||canceled.state.pendingClose)throw Error('Cancel did not preserve tab and clear pending state');
    await action({type:'tab.close',id});const second=await pending();await action({type:'tab.close',id,requestId:second.requestId,confirm:true});
    await page.waitForFunction(()=>window.remotekitDiagnostics.state?.tabs.length===0,null,{timeout:15000});const closed=await capture('accepted');if(closed.state.tabs.length)throw Error('Accepted close retained tab');
    const result={passed:true,activation,stages};return result;
  }catch(error){await capture('failure',{error:String(error)}).catch(()=>{});throw error;}
  finally{await page.evaluate(()=>window.remotekitDiagnostics?.transport.disconnect()).catch(()=>{});await browser.close();}
}
