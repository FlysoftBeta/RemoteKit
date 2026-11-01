async hostPage => {
  const browser = await hostPage.context().browser().browserType().launch({ executablePath: 'C:/src/tmp/chrome89-google/app/chrome.exe', headless: false, args: ['--no-first-run','--no-default-browser-check','--disable-features=WebRtcHideLocalIpsWithMdns','--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true }), page = await context.newPage();
  try {
    await page.goto('http://127.0.0.1:3001');
    await page.waitForFunction(()=>document.querySelector('button[aria-label="新建标签页"]')?.disabled===false);
    const result = await page.evaluate(async () => {
      const action = async body => { const r = await fetch('/api/actions', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); if(!r.ok)throw Error(await r.text());return r.json(); };
      await action({type:'device.set',device:{mode:'tablet',width:820,height:1180,deviceScaleFactor:2}});
      const state=await action({type:'tab.create',url:'http://127.0.0.1:3001/test-pattern.html?mode=static&title=Touch-IME'});
      const t=window.remotekitDiagnostics.transport;t.receiveProfile='chrome89-h264-51';await t.connect();return {tenantId:state.tenantId,tabId:state.activeTabId};
    });
    await page.waitForFunction(()=>document.querySelector('.view-pane canvas:not(.no-frame)')&&window.remotekitDiagnostics.transport.displayReady,null,{timeout:20000});
    const point=await page.evaluate(()=>{const r=document.querySelector('.view-pane canvas').getBoundingClientRect();return {x:r.left+r.width*350/820,y:r.top+r.height*30/1180};});
    await page.touchscreen.tap(point.x,point.y);
    const marker=async expected=>page.evaluate(async expected=>{const {decodeMarker}=await import('/marker-codec.js'),t=window.remotekitDiagnostics.transport,c=document.createElement('canvas');c.width=256;c.height=112;const ctx=c.getContext('2d'),end=performance.now()+3000;while(performance.now()<end){const s=t.layout?.views[0],f=s&&t.getLastPresentation(s.id),atlas=f&&!t.getPresentedPlane&&t.getPaintedFrame(s.id,f.rtpTimestamp),source=f&&(t.getPresentedPlane?t.getPresentedPlane(s.id,f.rtpTimestamp):atlas&&{image:atlas,sourceRect:s});if(source){const scale=s.deviceScaleFactor*(s.mediaScale??1);ctx.drawImage(source.image,source.sourceRect.x,source.sourceRect.y,256*scale,112*scale,0,0,256,112);const m=decodeMarker(ctx.getImageData(0,0,256,112));if(m?.stimulus===expected)return m;}await new Promise(r=>setTimeout(r,20));}return null;},expected);
    result.touch=await marker(32769);
    result.ime=[];
    for(const id of [81,82]){await page.evaluate(id=>{const t=window.remotekitDiagnostics.transport,s=t.layout.views[0];t.focus(s,true);t.sendInput(s,{type:'ime_commit',text:`RK:${id};`});},id);result.ime.push(await marker(id));}
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='诊断').click());await page.waitForFunction(()=>document.querySelector('.overlay-toggle input'));await page.evaluate(()=>document.querySelector('.overlay-toggle input').click());await page.evaluate(()=>document.querySelector('[aria-label="关闭侧栏"]').click());
    await page.screenshot({path:'C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/control-ui-final-input.png',fullPage:true});
    const report=await page.evaluate(async result=>{const t=window.remotekitDiagnostics.transport;return {...result,kind:'ui-input-final',at:Date.now(),state:await(await fetch('/api/state')).json(),diagnostics:t.diagnostics,presentation:t.presentationDiagnostics,inputTrace:t.inputTrace,inputResults:t.inputResults,layout:t.layout,sourceJpeg:t.displayFrame?.toDataURL('image/jpeg',.5),sourceAtlasUnavailable:t.displayReady&&!t.displayFrame};},result);
    if(JSON.stringify(report).length>900000){delete report.sourceJpeg;report.imageOmittedForSize=true;}
    await page.evaluate(async report=>{const response=await fetch('/api/metrics',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)});if(!response.ok)throw Error(`metrics ${response.status}`);},report);
    result.close=await page.evaluate(async()=>{const t=window.remotekitDiagnostics.transport,start=performance.now(),r=await fetch('/api/rtc/close',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({connectionId:t.diagnostics.connectionId})});t.disconnect();return {status:r.status,elapsedMs:performance.now()-start};});
    await page.waitForTimeout(2200);result.stopped=await page.evaluate(()=>({peer:!!window.remotekitDiagnostics.transport.peer,connection:window.remotekitDiagnostics.transport.diagnostics.connection}));return result;
  }finally{await page.evaluate(()=>window.remotekitDiagnostics?.transport.disconnect()).catch(()=>{});await browser.close();}
}
