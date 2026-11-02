// Page-only experiment. Requires viewer-presentation-candidate.js and a fixed,
// isolated production Viewer. It deliberately does NOT authorize direct-video
// frames for product input, latency feedback, or layout security.
window.installVideoClipCandidate = function(transport) {
  const t = transport;
  if (!window.installPresentationCandidate) throw Error('Load viewer-presentation-candidate.js first');
  const track = t.processorTrack || t.video?.srcObject?.getVideoTracks?.()[0];
  if (!track || track.readyState !== 'live') throw Error('No live inbound video track');
  if (!t.layout || !t.displayReady) throw Error('Wait for an authorized baseline frame');
  const originalDispatch = t.dispatchPaint;
  const originalRpc=t.controlRpc, channel=t.channel, originalSend=channel?.send;
  const feedbackSuppressed={control:0,dataChannel:0};
  const originalVisibility = new Map([...t.renderers].map(r => [r.canvas, r.canvas.style.visibility]));
  const identity = () => JSON.stringify({epoch:t.layout?.epoch,generation:t.layout?.generation,width:t.layout?.width,height:t.layout?.height,views:t.layout?.views});
  const initialIdentity = identity();
  const layout = JSON.parse(JSON.stringify(t.layout));
  const renderers = [...t.renderers].filter(r => t.rendererCurrent(r) && !r.view.stale);
  if (renderers.length !== 1) throw Error('Initial bounded group requires exactly one product plane');
  const renderer = renderers[0], rect = renderer.canvas.getBoundingClientRect(), view = {...renderer.view};
  if (!rect.width || !rect.height) throw Error('Empty destination rectangle');
  const canvasCandidate = installPresentationCandidate(t);
  const candidateDispatch = t.dispatchPaint;
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;inset:0;z-index:20000;pointer-events:auto;background:transparent;touch-action:none';
  document.body.append(holder);
  const blockInput = event => { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation(); };
  const inputEvents = ['pointerdown','pointermove','pointerup','pointercancel','mousedown','mouseup','mousemove','wheel','touchstart','touchmove','touchend','keydown','keyup','beforeinput'];
  inputEvents.forEach(name => document.addEventListener(name, blockInput, {capture:true,passive:false}));
  let mode = '2d', videos = [], stale = false, disposed = false, watch, state, processorStopped=false;
  const stream = new MediaStream([track]); // Same exact track object: never clone/stop receiver-owned track.
  const reset = () => {
    state = {startedAt:performance.now(),mode,frameEndpoint:mode.startsWith('video')?'rVFC-compositor-submission':'canvas-JS-submit',layoutChanges:0,observations:[],byVideo:{},errors:[],trackId:track.id,clipSupported:CSS.supports('clip-path','inset(0px)')};
    canvasCandidate.reset();
  };
  const clearVideos = () => {
    for (const item of videos) { item.alive=false; if(item.callback!==undefined)item.video.cancelVideoFrameCallback?.(item.callback); item.video.pause(); item.video.srcObject=null; item.video.remove(); }
    videos=[]; holder.replaceChildren();
  };
  // VideoPlaybackQuality fields are prototype getters and serialize to {} if
  // handed directly to Playwright. Copy explicitly for future fixture runs.
  const playbackQuality = video => {const q=video.getVideoPlaybackQuality?.();return q?{creationTime:q.creationTime,totalVideoFrames:q.totalVideoFrames,droppedVideoFrames:q.droppedVideoFrames,corruptedVideoFrames:q.corruptedVideoFrames}:null;};
  const addVideo = (roi, target, index) => {
    const sx=target.width/roi.width, sy=target.height/roi.height;
    const video=document.createElement('video');video.muted=true;video.autoplay=true;video.playsInline=true;
    const inset=[roi.y*sy,(layout.width-roi.x-roi.width)*sx,(layout.height-roi.y-roi.height)*sy,roi.x*sx];
    video.style.cssText=`position:fixed;left:${target.left-roi.x*sx}px;top:${target.top-roi.y*sy}px;width:${layout.width*sx}px;height:${layout.height*sy}px;max-width:none;object-fit:fill;pointer-events:none;clip-path:inset(${inset.map(n=>n+'px').join(' ')})`;
    holder.append(video);video.srcObject=stream;
    const item={video,alive:true,callback:undefined,roi,target};videos.push(item);
    const receive=(now,metadata)=>{
      if(!item.alive||disposed)return;
      const rtp=Number.isFinite(metadata.rtpTimestamp)?metadata.rtpTimestamp:undefined;
      const gateEpoch=rtp===undefined?undefined:t.frameGate.epochFor(rtp);
      const counters=state.byVideo[index]??(state.byVideo[index]={callbacks:0,missingRtp:0,gateUnmatchedAtCallback:0,firstPresentedFrames:null,lastPresentedFrames:null});
      counters.callbacks++;if(rtp===undefined)counters.missingRtp++;else if(gateEpoch!==layout.epoch)counters.gateUnmatchedAtCallback++;
      counters.firstPresentedFrames??=metadata.presentedFrames;counters.lastPresentedFrames=metadata.presentedFrames;
      if(state.observations.length<2048)state.observations.push({index,callbackAt:now,wall:Date.now(),rtp:rtp??null,gateEpoch:gateEpoch??null,expectedDisplayTime:metadata.expectedDisplayTime,presentationTime:metadata.presentationTime,mediaTime:metadata.mediaTime,presentedFrames:metadata.presentedFrames,width:metadata.width,height:metadata.height,processingDuration:metadata.processingDuration});
      item.callback=video.requestVideoFrameCallback(receive);
    };
    if(typeof video.requestVideoFrameCallback==='function')item.callback=video.requestVideoFrameCallback(receive);else state.errors.push('rVFC unavailable');
    void video.play().catch(error=>state.errors.push(String(error)));
  };
  const api = {
    setMode(next) {
      if(stale||identity()!==initialIdentity)throw Error('Layout changed: dispose and restart, never reuse old video crop');
      if(!['2d','webgl','video','video-two-elements'].includes(next))throw Error('Unknown mode');
      clearVideos();mode=next;
      if(next==='2d'||next==='webgl') {
        if(processorStopped){t.startProcessorPump(t.peer,track);processorStopped=false;}
        t.dispatchPaint=candidateDispatch;canvasCandidate.setMode(next);holder.style.background='transparent';
      } else {
        if(!CSS.supports('clip-path','inset(0px)'))throw Error('clip-path inset unavailable');
        // Same receiver and DC metadata; remove the competing MSTP consumer and
        // all canvas draw callbacks. Direct video has independent composition.
        // This is experiment isolation, never a product frame authorization.
        t.stopProcessorPump();processorStopped=true;
        canvasCandidate.setMode('2d');
        t.dispatchPaint=function(){return originalDispatch.call(this,()=>{});};
        holder.style.background='#111';
        if(next==='video')addVideo(view,rect,0);
        else {
          // Same atlas, same track, two adjacent ROIs. This tests element fanout
          // without changing encoded resolution or claiming real 2-window QA.
          const half=Math.floor(view.width/2), leftWidth=rect.width*half/view.width;
          addVideo({...view,width:half},{left:rect.left,top:rect.top,width:leftWidth,height:rect.height},0);
          addVideo({...view,x:view.x+half,width:view.width-half},{left:rect.left+leftWidth,top:rect.top,width:rect.width-leftWidth,height:rect.height},1);
        }
      }
      reset();state.frameEndpoint=next.startsWith('video')?'rVFC-compositor-submission':'canvas-JS-submit';
    },
    reset,
    snapshot() { return { ...state, stale, layout, feedbackSuppressed:{...feedbackSuppressed}, isolation:{processorStopped,processorActive:!!t.processorSource,productionVideoAttached:!!t.video.srcObject}, source:{trackId:track.id,trackSettings:track.getSettings()}, destination:{left:rect.left,top:rect.top,width:rect.width,height:rect.height}, videos:videos.map(item=>({roi:item.roi,target:item.target,sameTrack:item.video.srcObject?.getVideoTracks()[0]===track,decoded:item.video.webkitDecodedFrameCount,quality:playbackQuality(item.video),width:item.video.videoWidth,height:item.video.videoHeight,readyState:item.video.readyState,paused:item.video.paused})),canvas:canvasCandidate.snapshot() }; },
    dispose() { if(disposed)return;disposed=true;cancelAnimationFrame(watch);clearVideos();canvasCandidate.dispose();t.dispatchPaint=originalDispatch;if(originalRpc)t.controlRpc=originalRpc;if(originalSend)channel.send=originalSend;holder.remove();inputEvents.forEach(name=>document.removeEventListener(name,blockInput,true));for(const[canvas,visibility]of originalVisibility)canvas.style.visibility=visibility;if(processorStopped&&track.readyState==='live'&&t.peer)t.startProcessorPump(t.peer,track); }
  };
  const check=()=>{if(disposed)return;if((identity()!==initialIdentity||track.readyState!=='live'||(t.processorTrack||t.video?.srcObject?.getVideoTracks?.()[0])!==track)&&!stale){stale=true;state.layoutChanges++;holder.style.visibility='hidden';clearVideos();state.errors.push('layout-or-source-changed: hidden and stopped; no automatic reauthorization');}watch=requestAnimationFrame(check);};
  if(originalRpc)t.controlRpc=function(method,...args){if(method==='feedback'){feedbackSuppressed.control++;return Promise.resolve({accepted:false});}return originalRpc.call(this,method,...args);};
  if(originalSend)channel.send=function(data){try{if(typeof data==='string'&&JSON.parse(data).type==='media.feedback'){feedbackSuppressed.dataChannel++;return;}}catch{}return originalSend.call(this,data);};
  reset();watch=requestAnimationFrame(check);api.setMode('2d');return api;
};
