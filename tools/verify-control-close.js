async hostPage => {
  const directory='C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/control-close-final';
  const browser=await hostPage.context().browser().browserType().launch({executablePath:'C:/src/tmp/chrome89-google/app/chrome.exe',headless:false,args:['--no-first-run','--no-default-browser-check','--disable-features=WebRtcHideLocalIpsWithMdns','--autoplay-policy=no-user-gesture-required']});
  const context=await browser.newContext({viewport:{width:1024,height:1000},hasTouch:true}),page=await context.newPage(),stages=[];
  const action=body=>page.evaluate(async body=>{const r=await fetch('/api/actions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error(await r.text());return r.json();},body);
  const capture=async(stage,extra={})=>{
    const report=await page.evaluate(async({stage,extra})=>{const t=window.remotekitDiagnostics.transport;return {kind:'ui-close-final',stage,...extra,state:await(await fetch('/api/state')).json(),diagnostics:t.diagnostics,presentation:t.presentationDiagnostics,inputTrace:t.inputTrace,inputResults:t.inputResults,layout:t.layout,sourceJpeg:t.displayReady?t.displayFrame.toDataURL('image/jpeg',.5):undefined};},{stage,extra});
    if(JSON.stringify(report).length>900000){delete report.sourceJpeg;report.imageOmittedForSize=true;}
    await page.evaluate(async report=>{const r=await fetch('/api/metrics',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)});if(!r.ok)throw Error(`metrics ${r.status}`);},report);
    await page.screenshot({path:`${directory}/${stage}.png`,fullPage:true});stages.push({stage,tabs:report.state.tabs.length,pendingClose:report.state.pendingClose});return report;
  };
  try{
    await page.goto('http://127.0.0.1:3001');await page.waitForFunction(()=>document.querySelector('button[aria-label="新建标签页"]')?.disabled===false);
    await action({type:'device.set',device:{mode:'tablet',width:820,height:1180,deviceScaleFactor:2}});
    const state=await action({type:'tab.create',url:'http://127.0.0.1:3001/test-pattern.html?mode=static&beforeunload=1&activationMarker=1&title=Close-Confirmation'}),id=state.activeTabId;
    await page.evaluate(async()=>{const t=window.remotekitDiagnostics.transport;t.receiveProfile='chrome89-h264-51';await t.connect();});
    await page.waitForFunction(()=>document.querySelector('.view-pane canvas:not(.no-frame)')&&window.remotekitDiagnostics.transport.displayReady,null,{timeout:20000});
    const point=await page.evaluate(()=>{const r=document.querySelector('.view-pane canvas').getBoundingClientRect();return{x:r.left+r.width*350/820,y:r.top+r.height*30/1180};});await page.touchscreen.tap(point.x,point.y);
    const activation=await page.evaluate(async()=>{const{decodeMarker}=await import('/marker-codec.js'),t=window.remotekitDiagnostics.transport,c=document.createElement('canvas');c.width=256;c.height=112;const ctx=c.getContext('2d'),end=performance.now()+5000;let last;while(performance.now()<end){const s=t.layout?.views[0],f=s&&t.getLastPresentation(s.id),source=f&&t.getPaintedFrame(s.id,f.rtpTimestamp);if(source){const scale=s.deviceScaleFactor*(s.mediaScale??1);ctx.drawImage(source,s.x,s.y,256*scale,112*scale,0,0,256,112);last=decodeMarker(ctx.getImageData(0,0,256,112));if(last?.stimulus===60001)return last;}await new Promise(r=>setTimeout(r,20));}return last;});
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='诊断').click());await page.waitForFunction(()=>document.querySelector('.overlay-toggle input'));await page.evaluate(()=>document.querySelector('.overlay-toggle input').click());await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='设备配置').click());await page.waitForFunction(()=>document.querySelector('.device-preview'));
    await capture('activated-small-tablet',{activation});if(activation?.stimulus!==60001)throw Error('Remote userActivation.hasBeenActive was not confirmed by received pixels');
    await action({type:'tab.close',id});await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='保留页面'),null,{timeout:10000});await capture('confirmation');
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='保留页面').click());await page.waitForFunction(()=>![...document.querySelectorAll('button')].some(b=>b.textContent==='保留页面'));
    const canceled=await capture('canceled');if(!canceled.state.tabs.some(tab=>tab.id===id)||canceled.state.pendingClose)throw Error('Cancel did not preserve the tab and clear pending state');
    await action({type:'tab.close',id});await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='关闭页面'),null,{timeout:10000});await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='关闭页面').click());
    await page.waitForFunction(()=>document.querySelectorAll('[role="tab"]').length===0,null,{timeout:15000});const closed=await capture('accepted');if(closed.state.tabs.length)throw Error('Accepted close retained the product tab');
    const result={activation,stages};return result;
  }catch(error){await capture('failure',{error:String(error)}).catch(()=>{});const result={error:String(error),stages};return result;}
  finally{await page.evaluate(()=>window.remotekitDiagnostics?.transport.disconnect()).catch(()=>{});await browser.close();}
}
