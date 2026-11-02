async(host) => {
  const p=host._presentationBaseline.page;
  host._qaAttach=async()=>p.evaluate(()=>{
    const t=baseline.transport(),a=t.audio,c=a.context;
    const qa=window.qa={blocks:[],pulseAt:[],visualAt:[],longTasks:[]};
    const merge=a.nodes.find(node=>node instanceof ChannelMergerNode),split=c.createChannelSplitter(2);
    merge.connect(split);qa.analysers=[c.createAnalyser(),c.createAnalyser()];
    qa.analysers.forEach((node,i)=>{node.fftSize=2048;split.connect(node,i)});
    qa.sp=c.createScriptProcessor(1024,2,2);
    qa.sp.onaudioprocess=event=>{const rms=[0,1].map(i=>{const data=event.inputBuffer.getChannelData(i);return Math.sqrt(data.reduce((s,v)=>s+v*v,0)/data.length)});qa.blocks.push({at:performance.now(),rms});if(qa.blocks.length>100)qa.blocks.shift();if(rms[0]>.2)qa.pulseAt.push(performance.now());event.outputBuffer.getChannelData(0).fill(0);event.outputBuffer.getChannelData(1).fill(0);};
    merge.connect(qa.sp);qa.sp.connect(c.destination);
    qa.sample=()=>({state:a.state,channels:baseline.state.workspace.settings.audioChannels,rms:qa.blocks.slice(-5).map(v=>v.rms),tones:qa.analysers.map(node=>{const bins=new Float32Array(node.frequencyBinCount);node.getFloatFrequencyData(bins);let peak=0;for(let i=1;i<bins.length;i++)if(bins[i]>bins[peak])peak=i;return peak*c.sampleRate/node.fftSize;})});
    qa.save=async(kind,extra={})=>{const stats=Array.from((await t.peer.getStats()).values()).filter(s=>s.type==='inbound-rtp'&&s.kind==='audio').map(s=>({packets:s.packetsReceived,energy:s.totalAudioEnergy,samples:s.totalSamplesReceived,codec:s.codecId}));const result={kind,sample:qa.sample(),stats,endpointAudio:t.diagnostics.endpoint?.audio,audioTimeline:t.diagnostics.endpoint?.senderRtcStats?.audioTimeline,...extra};await fetch('/api/metrics',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});return result;};
    try{qa.longObserver=new PerformanceObserver(list=>qa.longTasks.push(...list.getEntries().map(e=>({at:e.startTime,duration:e.duration}))));qa.longObserver.observe({entryTypes:['longtask']});}catch{}
    return qa.sample();
  });
  host._qaClick=async(x,y)=>{const point=await p.evaluate(({x,y})=>{const t=baseline.transport(),s=t.layout.views[0],r=document.querySelector('.remote-viewport canvas').getBoundingClientRect(),scale=s.deviceScaleFactor*(s.mediaScale??1);return{x:r.left+x/(s.width/scale)*r.width,y:r.top+y/(s.height/scale)*r.height}},{x,y});await p.mouse.click(point.x,point.y);};
  return await host._qaAttach();
}
