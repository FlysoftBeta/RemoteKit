// Host-managed browser entry only. First bootstrap the formal baseline browser
// in a fresh isolated profile against viewer-video-clip-server.mts. No launch,
// desktop control, or media work happens merely by loading this file.
async(hostPage)=>{
  const run=hostPage._presentationBaseline;
  if(!run?.page)throw Error('Bootstrap the isolated baseline Viewer first');
  const root=hostPage._baselineRoot;
  if(!root)throw Error('Set a dedicated develop/tmp run directory');
  await run.page.addScriptTag({path:'C:/Users/Flysoft/Desktop/remotekit2/tools/viewer-presentation-candidate.js'});
  await run.page.addScriptTag({path:'C:/Users/Flysoft/Desktop/remotekit2/tools/viewer-video-clip-candidate.js'});
  await run.page.evaluate(()=>{window.videoClip?.dispose();window.videoClip=installVideoClipCandidate(baseline.transport());});
  const mediaEvents=[];let cdp;
  try {cdp=await run.page.context().newCDPSession(run.page);await cdp.send('Media.enable');for(const kind of ['playerCreated','playerEventsAdded','playerPropertiesChanged','playerErrorsRaised'])cdp.on('Media.'+kind,value=>{if(mediaEvents.length<2048)mediaEvents.push({kind,value});});}catch(error){mediaEvents.push({unsupported:String(error)});}
  run.videoClipReports=[];
  run.videoClipSample=async(name,mode,ms=12000)=>{
    if(ms<10000||ms>12000)throw Error('Bounded cases are 10–12 seconds');
    if(run.videoClipReports.length>=4)throw Error('Initial budget is four cases; no automatic retries');
    await run.page.evaluate(mode=>videoClip.setMode(mode),mode);
    await run.page.waitForTimeout(700);
    const take=()=>run.page.evaluate(async()=>{const t=baseline.transport();return{at:performance.now(),wall:Date.now(),candidate:videoClip.snapshot(),quality:baseline.state.quality,receiveProfile:t.receiveProfile,productReceiveSelection:t.productReceiveSelection,endpoint:t.diagnostics.endpoint,encodedFrameSamples:[...t.encodedFrameSamples],presentation:t.getPresentationDiagnostics(),stats:Array.from((await t.peer.getStats()).values())};});
    await run.page.evaluate(()=>videoClip.reset());const before=await take();
    if(before.candidate.layout.width!==1936||before.candidate.layout.height!==816)throw Error('Actual coded layout is not the preregistered 1936x816; adjust fixture BEFORE timing');
    if(before.quality.applied?.maxFps!==50)throw Error('Fixture media policy must actually have maxFps=50');
    if(mode.startsWith('video')&&before.candidate.videos.some(v=>v.paused||v.readyState<2||v.width!==1936||v.height!==816))throw Error('Direct video is not playing the same actual coded size');
    if(mode.startsWith('video')&&(!before.candidate.isolation.processorStopped||before.candidate.isolation.processorActive||before.candidate.isolation.productionVideoAttached))throw Error('Direct video still has a competing production consumer');
    await run.page.waitForTimeout(ms);const after=await take();
    await run.page.screenshot({path:root+'/'+name+'.png'});
    const fixed=q=>JSON.stringify({preference:q.preference,dpr:q.effectiveDpr,requested:q.requested,applied:q.applied&&{degradationPreference:q.applied.degradationPreference,maxFps:q.applied.maxFps}});
    const invalid=[];
    if(after.candidate.stale)invalid.push('layout-or-source-changed');
    if(fixed(before.quality)!==fixed(after.quality))invalid.push('quality-policy-changed');
    if(JSON.stringify(before.receiveProfile)!==JSON.stringify(after.receiveProfile))invalid.push('receive-profile-changed');
    const inbound=s=>s.filter(x=>x.type==='inbound-rtp'&&(x.kind==='video'||x.mediaType==='video'));
    const seconds=(after.at-before.at)/1000;
    const rates=inbound(after.stats).map(item=>{const previous=inbound(before.stats).find(x=>x.id===item.id);if(!previous)return{id:item.id,invalid:'receiver-changed'};return{id:item.id,decodeFps:(item.framesDecoded-previous.framesDecoded)/seconds,receivedFps:Number.isFinite(item.framesReceived)&&Number.isFinite(previous.framesReceived)?(item.framesReceived-previous.framesReceived)/seconds:null,decodeSecondsPerSecond:(item.totalDecodeTime-previous.totalDecodeTime)/seconds,frameWidth:item.frameWidth,frameHeight:item.frameHeight,framesDroppedDelta:item.framesDropped-previous.framesDropped,codec:after.stats.find(x=>x.id===item.codecId)};});
    if(rates.length!==1||rates.some(x=>x.invalid))invalid.push('receiver-stream-changed');
    const codec=s=>inbound(s.stats).map(x=>s.stats.find(c=>c.id===x.codecId)).map(c=>c&&({id:c.id,mimeType:c.mimeType,sdpFmtpLine:c.sdpFmtpLine,payloadType:c.payloadType}));
    if(JSON.stringify(codec(before))!==JSON.stringify(codec(after)))invalid.push('codec-changed');
    if(rates.some(x=>x.frameWidth!==1936||x.frameHeight!==816))invalid.push('decoded-size-changed');
    if(mode.startsWith('video')&&(after.candidate.canvas.frames!==0||after.candidate.canvas.reads!==0||after.candidate.videos.some(v=>!v.sameTrack)))invalid.push('direct-video-isolation-failed');
    const sourceFrames=after.encodedFrameSamples.filter(x=>x.at>before.at&&x.at<=after.at);
    const sourceCadence={metadataFrames:sourceFrames.length,metadataFps:sourceFrames.length/seconds,first:sourceFrames[0]??null,last:sourceFrames.at(-1)??null};
    const report={name,mode,browser:run.version,seconds,invalid,rates,sourceCadence,before,after,mediaEvents:[...mediaEvents],endpointNote:'canvas JS submission and rVFC compositor submission are distinct endpoints; neither proves physical display'};
    run.videoClipReports.push(report);
    await run.page.evaluate(async report=>{const text=JSON.stringify(report),size=200000,total=Math.ceil(text.length/size);for(let index=0;index<total;index++){const response=await fetch('/api/metrics',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'video-clip-chunk',name:report.name,index,total,data:text.slice(index*size,(index+1)*size)})});if(!response.ok)throw Error('metrics '+response.status);}},report);
    return{name,mode,seconds,invalid,rates,sourceCadence,canvasFrames:after.candidate.canvas.frames,videoCadence:after.candidate.byVideo,errors:after.candidate.errors};
  };
  run.disposeVideoClip=async()=>{await run.page.evaluate(()=>videoClip.dispose());await cdp?.detach();};
  return{ready:true,budget:['2d','webgl','video','video-two-elements'],seconds:12,runDirectory:root,resourceSampler:'tools/viewer-presentation-baseline-resources.ps1',warning:'Fixed-layout/no-input cost experiment only; root must grant an idle GPU/build window before running'};
}
