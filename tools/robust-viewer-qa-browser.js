// Load with the existing host-managed Playwright browser_run_code_unsafe filename.
// Preparation creates no browser/service. Profiles and screenshots stay in develop/tmp.
async(host)=>{
 const qa=host._robustViewerQA={contexts:[],page:null,run:null};
 // Chrome89 cannot use recent Playwright utility-world checkVisibility calls.
 // Select attached DOM in the page world, then send real host mouse/keyboard input.
 // No app click handlers or product action APIs are invoked by these helpers.
 qa.uiCount=async(spec)=>qa.page.evaluate(spec=>Array.from(document.querySelectorAll(spec.css)).filter(element=>spec.text===undefined||element.textContent.trim()===spec.text).length,spec);
 qa.uiPoint=async(spec)=>{
  await qa.page.waitForFunction(spec=>Array.from(document.querySelectorAll(spec.css)).some(element=>spec.text===undefined||element.textContent.trim()===spec.text),spec,{timeout:5000});
  await qa.page.evaluate(spec=>{const matches=Array.from(document.querySelectorAll(spec.css)).filter(element=>spec.text===undefined||element.textContent.trim()===spec.text);const element=matches[spec.index==='last'?matches.length-1:(spec.index??0)];if(!element)throw Error('UI target missing');element.scrollIntoView({block:'center',inline:'nearest'})},spec);
  await qa.page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await qa.page.waitForFunction(spec=>{
   const matches=Array.from(document.querySelectorAll(spec.css)).filter(element=>spec.text===undefined||element.textContent.trim()===spec.text),element=matches[spec.index==='last'?matches.length-1:(spec.index??0)];if(!element)return false;
   const style=getComputedStyle(element),box=element.getBoundingClientRect();if(style.display==='none'||style.visibility!=='visible'||Number(style.opacity)===0||element.disabled)return false;
   const left=Math.max(0,box.left),right=Math.min(innerWidth,box.right),top=Math.max(0,box.top),bottom=Math.min(innerHeight,box.bottom);if(right<=left||bottom<=top)return false;
   const hit=document.elementFromPoint((left+right)/2,(top+bottom)/2);return !!hit&&(hit===element||element.contains(hit));
  },spec,{timeout:5000});
  return qa.page.evaluate(spec=>{
   const matches=Array.from(document.querySelectorAll(spec.css)).filter(element=>spec.text===undefined||element.textContent.trim()===spec.text),element=matches[spec.index==='last'?matches.length-1:(spec.index??0)];if(!element)throw Error('UI target disappeared');
   const style=getComputedStyle(element),box=element.getBoundingClientRect();if(style.display==='none'||style.visibility!=='visible'||Number(style.opacity)===0||box.width<=0||box.height<=0||element.disabled)throw Error('UI target is not visible and enabled');
   const left=Math.max(0,box.left),right=Math.min(innerWidth,box.right),top=Math.max(0,box.top),bottom=Math.min(innerHeight,box.bottom);if(right<=left||bottom<=top)throw Error('UI target is outside viewport');
   const x=(left+right)/2,y=(top+bottom)/2,hit=document.elementFromPoint(x,y);if(!hit||!(hit===element||element.contains(hit)))throw Error('UI target is obscured');
   return{x,y,width:box.width,height:box.height,text:element.textContent.trim(),tag:element.tagName};
  },spec);
 };
 qa.uiClick=async(spec)=>{const point=await qa.uiPoint(spec);await qa.page.mouse.click(point.x,point.y);return point};
 qa.uiFill=async(spec,text)=>{
  const focused=()=>qa.page.evaluate(spec=>{const matches=Array.from(document.querySelectorAll(spec.css)).filter(element=>spec.text===undefined||element.textContent.trim()===spec.text);return document.activeElement===matches[spec.index==='last'?matches.length-1:(spec.index??0)]},spec);
  await qa.uiClick(spec);await qa.page.waitForTimeout(80);
  if(!await focused()){await qa.uiClick(spec);await qa.page.waitForTimeout(80)}
  if(!await focused())throw Error('UI textbox did not retain actual keyboard focus');
  await qa.page.keyboard.press('Control+A');await qa.page.keyboard.insertText(text);
 };
 qa.launch=async({version=157,run,port=33471,viewport={width:1440,height:900},dpr=1,username='robust-'+version,password,serverCredential,camera=false}={})=>{
  if(!run||!password)throw Error('Explicit isolated run path and disposable password required');qa.run=run;qa.port=port;qa.fixturePort=port+1;
  const context=await host.context().browser().browserType().launchPersistentContext(run+'/client-'+version+'-'+Date.now(),{executablePath:version===89?'C:/src/tmp/chrome89-google/app/chrome.exe':'C:/src/chromium/src/out/rel/chrome.exe',headless:true,viewport,deviceScaleFactor:dpr,permissions:camera?['camera']:[],args:['--fake-vsync-rate=60','--no-first-run','--no-default-browser-check','--autoplay-policy=no-user-gesture-required',...(camera?['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']:[])]});qa.contexts.push(context);qa.context=context;qa.version=version;
  await context.addInitScript(()=>{
   const q=window.robustQA={events:[],wsSent:[],dcSent:[],peers:[],channels:[],snapshots:[],state:null,dropProductReplies:0,holdSnapshots:false,heldSnapshots:[],holdAck:false,heldAcks:[],draws:0,mstp:0,ids:new WeakMap(),nextId:0};
   const record=(type,data={})=>{q.events.push({type,at:performance.now(),...data});if(q.events.length>2000)q.events.shift()};q.record=record;
   const push=(array,value)=>{array.push(value);if(array.length>2000)array.shift()};q.id=value=>{if(!value)return null;if(!q.ids.has(value))q.ids.set(value,++q.nextId);return q.ids.get(value)};
   const WS=window.WebSocket;window.WebSocket=class extends WS{constructor(...args){super(...args);q.socket=this;const send=this.send.bind(this);this.send=data=>{try{push(q.wsSent,JSON.parse(data))}catch{}return send(data)};this.addEventListener('message',event=>{let message;try{message=JSON.parse(event.data)}catch{return}if(message.type==='state'){push(q.snapshots,message);if(q.holdSnapshots){q.heldSnapshots.push(message);event.stopImmediatePropagation();return}if(!q.state||q.state.serverIncarnation!==message.state.serverIncarnation||q.state.snapshotSequence<message.state.snapshotSequence)q.state=message.state}})}};
   const PC=window.RTCPeerConnection;window.RTCPeerConnection=class extends PC{constructor(...args){super(...args);q.peers.push(this);record('peer.created',{index:q.peers.length})}createDataChannel(...args){const channel=super.createDataChannel(...args),send=channel.send.bind(channel);q.channels.push(channel);channel.qaRawSend=send;channel.send=data=>{try{const message=JSON.parse(data);push(q.dcSent,message);if(message.type==='presentation.ready'&&q.holdAck){q.heldAcks.push(data);return}}catch{}return send(data)};channel.addEventListener('message',event=>{if(typeof event.data!=='string')return;let message;try{message=JSON.parse(event.data)}catch{return}if(message.type==='product.result'&&q.dropProductReplies){q.dropProductReplies--;event.stopImmediatePropagation();record('product.reply.dropped',{operationId:message.operationId});return}if(['product.result','input.result','layout','presentation.prepare','clock.pong'].includes(message.type))record('dc.receive',{message})});return channel}};
   const draw=CanvasRenderingContext2D.prototype.drawImage;CanvasRenderingContext2D.prototype.drawImage=function(...args){if(this.canvas.closest?.('.remote-viewport')){q.draws++;record('viewport.draw',{canvas:q.id(this.canvas)})}return draw.apply(this,args)};
   if(window.MediaStreamTrackProcessor){const Processor=window.MediaStreamTrackProcessor;window.MediaStreamTrackProcessor=class extends Processor{constructor(...args){super(...args);q.mstp++}}}
   q.transport=()=>{for(const element of document.querySelectorAll('*')){const key=Object.keys(element).find(k=>k.startsWith('__reactFiber$'));for(let fiber=key&&element[key];fiber;fiber=fiber.return)for(let hook=fiber.memoizedState;hook;hook=hook.next){const current=hook.memoizedState?.current;if(current&&typeof current.getPresentationDiagnostics==='function')return current}}throw Error('Production transport not mounted')};
   q.rpc=(method,params)=>new Promise((resolve,reject)=>{const id='qa-'+Math.random(),socket=q.socket,timer=setTimeout(()=>{socket.removeEventListener('message',on);reject(Error('QA RPC timeout'))},25000);function on(event){const message=JSON.parse(event.data);if(message.id===id){clearTimeout(timer);socket.removeEventListener('message',on);message.type==='error'?reject(Error(JSON.stringify(message.error))):resolve(message.result)}}socket.addEventListener('message',on);socket.send(JSON.stringify({id,method,params}))});
   q.operation=action=>({operationId:crypto.randomUUID?.()??'qa-'+Date.now()+'-'+Math.random().toString(36).slice(2),operationGeneration:q.state.operationGeneration,action});
   q.action=action=>q.transport().productAction(q.operation(action));
   const connect=AudioNode.prototype.connect;AudioNode.prototype.connect=function(...args){if(args[0] instanceof AudioDestinationNode){const mute=this.context.createGain();mute.gain.value=0;connect.call(this,mute);connect.call(mute,args[0]);return args[0]}return connect.apply(this,args)};
  });
  const page=context.pages()[0]??await context.newPage();qa.page=page;
  await page.goto('http://127.0.0.1:'+port);await page.evaluate(async({username,password,serverCredential})=>{const options={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password,serverCredential})};let response=await fetch('/api/auth/register',options);if(!response.ok)response=await fetch('/api/auth/login',options);if(!response.ok)throw Error('Disposable QA account failed')},{username,password,serverCredential});await page.reload();
  await page.waitForFunction(()=>window.robustQA.state&&robustQA.socket?.readyState===1);return{version:await context.browser().version(),username,run};
 };
 qa.ready=async()=>qa.page.waitForFunction(()=>{try{const t=robustQA.transport();return t.channel?.readyState==='open'&&t.peer?.connectionState==='connected'&&[...t.videoPlanes.values()].every(plane=>plane.ready)}catch{return false}},null,{timeout:30000});
 qa.inspect=async()=>await(await qa.page.request.get('http://127.0.0.1:'+qa.fixturePort+'/inspect')).json();
 qa.sample=async(name)=>{
  if(!/^[a-zA-Z0-9_-]+$/.test(name))throw Error('Simple evidence name required');
  const sample=await qa.page.evaluate(async()=>{const q=robustQA,t=q.transport(),rect=element=>{const box=element.getBoundingClientRect();return{x:box.x,y:box.y,width:box.width,height:box.height}};return{at:performance.now(),state:q.state,peerCount:q.peers.length,connectionId:t.connectionId,peerStates:q.peers.map(peer=>peer.connectionState),presentation:t.getPresentationDiagnostics(true),layout:t.layout,barrier:t.presentationBarrier,draws:q.draws,mstp:q.mstp,inputTrace:t.inputTrace,planes:[...t.videoPlanes].map(([renderer,plane])=>({viewId:renderer.view.id,videoId:q.id(plane.video),streamId:q.id(plane.video.srcObject),tracks:plane.video.srcObject?.getTracks().map(track=>track.id),ready:plane.ready,source:renderer.view,canvas:rect(renderer.canvas),clip:rect(plane.clip),video:rect(plane.video),controls:plane.video.controls,videoWidth:plane.video.videoWidth,videoHeight:plane.video.videoHeight})),editors:Array.from(document.querySelectorAll('.remote-viewport textarea')).map(editor=>({active:document.activeElement===editor,readOnly:editor.readOnly,disabled:editor.disabled,box:rect(editor)})),storage:{local:Object.keys(localStorage),session:Object.keys(sessionStorage)},viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scrollWidth:document.documentElement.scrollWidth,visual:visualViewport?{width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale}:null},wsSent:q.wsSent,dcSent:q.dcSent,events:q.events}});
  const evidence={name,version:qa.version,...sample,fixture:await qa.inspect()};await qa.page.screenshot({path:qa.run+'/'+name+'.png'});
  // Bounded rolling evidence avoids overflowing the production metrics body limit.
  // Keep cumulative counters and mark retained/total counts explicitly.
  const saved=JSON.parse(JSON.stringify(evidence));saved.retention={};
  for(const key of ['events','dcSent','wsSent']){saved.retention[key]={total:saved[key].length,retained:Math.min(saved[key].length,200)};saved[key]=saved[key].slice(-200)}
  saved.retention.fixtureEvents={total:saved.fixture.events.length,retained:Math.min(saved.fixture.events.length,100)};saved.fixture.events=saved.fixture.events.slice(-100);
  if(saved.presentation?.raw){saved.retention.presentationRaw='omitted; cumulative diagnostics retained';delete saved.presentation.raw}
  const response=await qa.page.request.post('http://127.0.0.1:'+qa.port+'/api/metrics',{headers:{Origin:'http://127.0.0.1:'+qa.port},data:{kind:'robust-viewer-qa',...saved}});if(!response.ok())throw Error('Evidence save failed '+response.status());return evidence;
 };
 qa.point=async(viewId,x,y)=>qa.page.evaluate(({viewId,x,y})=>{const entry=[...robustQA.transport().videoPlanes].find(([renderer])=>renderer.view.id===viewId);if(!entry)throw Error('Missing plane');const renderer=entry[0],box=renderer.canvas.getBoundingClientRect(),source=renderer.view,scale=source.deviceScaleFactor*(source.mediaScale??1);return{x:box.x+x/(source.width/scale)*box.width,y:box.y+y/(source.height/scale)*box.height}},{viewId,x,y});
 qa.click=async(viewId,x,y)=>{const point=await qa.point(viewId,x,y);await qa.page.mouse.click(point.x,point.y);return point};
 qa.assertNoWsActions=async()=>{const actions=await qa.page.evaluate(()=>robustQA.wsSent.filter(message=>message.method==='action'||String(message.method).startsWith('files.')));if(actions.length)throw Error('Unexpected WS browser/file action: '+JSON.stringify(actions));return true};
 qa.releaseAcks=async()=>qa.page.evaluate(()=>{const q=robustQA;q.holdAck=false;const channel=q.channels[q.channels.length-1];for(const message of q.heldAcks)channel.qaRawSend(message);q.heldAcks=[]});
 qa.close=async()=>{for(const context of qa.contexts)await context.close();qa.contexts=[]};
 return{prepared:true,started:false,invoke:'host._robustViewerQA.launch({version:157|89,run:absoluteRunPath,password:disposablePassword})'};
}
