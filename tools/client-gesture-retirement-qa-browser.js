// Load only through host-managed browser_run_code_unsafe after both QA helpers.
// No service/browser is launched by preparation. Each method is one bounded group.
async(host)=>{
 const qa=host._clientGestureQA,base=qa.base;
 const assert=(value,message)=>{if(!value)throw Error(message)};
 const unwrap=r=>r.message.event??r.message.input??r.message;
 const root=e=>e.common.fixture.telemetry[e.case+':root'];
 const quickTap=()=>qa.trajectory([{at:0,type:'touchStart',points:[{x:120,y:110}]},{at:70,type:'touchEnd',points:[]}],{settleMs:100});
 const retired=host._retirementQA={};
 retired.targetloss=async({lateOld=false}={})=>{
  const id=`v${base.version}-retired-target-${Date.now()}`;
  await qa.navigate({id,live:true});await base.page.waitForTimeout(250);
  await qa.trajectory([{at:0,type:'touchStart',points:[{x:400,y:500}]},{at:40,type:'touchMove',points:[{x:400,y:485}]},{at:80,type:'touchMove',points:[{x:400,y:470}]},{at:120,type:'touchMove',points:[{x:400,y:455}]}],{settleMs:100});
  let owned=false;
  for(let i=0;i<12;i++){const c=(await base.inspect()).telemetry[id+':child'];if(c?.counts.touchstart&&c.counts.touchmove&&c.positions.rootY>=25){owned=true;break}await base.page.waitForTimeout(50)}
  const before=await qa.sample(id+'-owned');assert(owned,'Child raw touch + actual scroll not observed before deletion');
  const sequence=before.data.sent.map(unwrap).find(e=>e.type==='touch'&&e.action==='start')?.sequenceId;assert(sequence,'Owned sequence missing');
  assert(root(before).positions.rootY===0&&!root(before).counts.touchstart,'Root received child sequence');
  const r=await base.page.request.post(`http://127.0.0.1:${base.fixturePort}/command?id=${id}`,{data:{type:'remove-child'}});assert(r.ok(),'Fixture deletion command rejected');
  let removed=false;for(let i=0;i<20;i++){if((await base.inspect()).telemetry[id+':root']?.events.some(e=>e.type==='fixture-remove-child')){removed=true;break}await base.page.waitForTimeout(50)}assert(removed,'Child deletion not observed');
  await qa.touch('touchMove',[{x:400,y:430}]);await qa.touch('touchEnd',[]);await base.page.waitForTimeout(350);
  const after=await qa.sample(id+'-invalidated');
  // A precise invalidation on MOVE may retire the owner before physical UP.
  // In that case Client must not invent an END packet for an already retired owner.
  assert(after.summary.allClientV1&&after.summary.trustedPointerCount>0&&after.summary.mediaStable,'Invalidation lost real Client path or media identity');
  assert(after.summary.rejections.some(r=>r.message.touchState==='terminal-invalidated'&&r.message.touchSequenceId===sequence),'No exact terminal invalidation proof');
  assert(root(after).positions.rootY===0&&!root(after).counts.touchstart&&!root(after).counts.touchmove,'Old child input reached root');
  await qa.tap();const recovery=await qa.sample(id+'-recovery');qa.assertClientPath(recovery);
  assert(root(recovery).clicks===1,'Same-document new tap failed after invalidation');
  const starts=recovery.data.sent.map(unwrap).filter(e=>e.type==='touch'&&e.action==='start');assert(starts.length===2&&starts[1].sequenceId!==sequence,'New owner not established');
  const fresh=recovery.summary.terminalReceipts.filter(t=>t.touchSequence!==sequence);assert(fresh.length&&fresh.every(t=>t.result?.ok&&t.result.touchState==='processed'),'New owner terminal not processed');
  const banner=await base.page.evaluate(()=>document.body.innerText.includes('触控结束尚未确认'));assert(!banner,'Unconfirmed-touch recovery overlay remains');
  const samples=[before,after,recovery];
  if(lateOld){
   await qa.holdInputResults(true);await quickTap();
   const old=after.summary.rejections.find(r=>r.message.touchState==='terminal-invalidated').message;
   await base.page.evaluate(old=>{const q=clientGestureQA;q.holdResults=false;q.channel.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(old)}));q.holdResults=true},old);
   await quickTap();const blocked=await qa.sample(id+'-late-old-blocked');
   assert(blocked.data.sent.map(unwrap).filter(p=>p.type==='touch'&&p.action==='start').length===3&&root(blocked).clicks===2,'Late old invalidation cleared newer held owner');
   await qa.releaseInputResults();await base.page.waitForTimeout(100);await quickTap();const released=await qa.sample(id+'-late-old-released');
   assert(root(released).clicks===3,'New owner failed after own canonical ACK release');qa.assertClientPath(released);samples.push(blocked,released);
  }
  return samples.map(e=>({name:e.name,summary:e.summary,root:root(e).positions,clicks:root(e).clicks}));
 };
 retired.held=async()=>{
  const id=`v${base.version}-retired-held-${Date.now()}`;await qa.navigate({id});await qa.holdInputResults(true);
  await quickTap();let e=await qa.sample(id+'-before');const first=e.data.sent.map(unwrap).find(p=>p.type==='touch'&&p.action==='start')?.sequenceId;assert(first,'Held owner missing');assert(root(e).clicks===1,'First held tap missing');
  await quickTap();e=await qa.sample(id+'-blocked');assert(e.data.sent.map(unwrap).filter(p=>p.type==='touch'&&p.action==='start').length===1&&root(e).clicks===1,'New owner escaped canonical terminal gate');
  await qa.releaseInputResults();await base.page.waitForTimeout(100);await quickTap();e=await qa.sample(id+'-released');qa.assertClientPath(e);assert(root(e).clicks===2,'New tap failed after release');assert(e.summary.terminalReceipts.every(r=>r.result.ok&&r.result.touchState==='processed'),'Ordinary terminal not processed');return e.summary;
 };
 retired.cancel=async()=>{
  const id=`v${base.version}-retired-cancel-${Date.now()}`;await qa.navigate({id});await qa.holdInputResults(true);
  await qa.trajectory([{at:0,type:'touchStart',points:[{x:120,y:600}]},{at:40,type:'touchMove',points:[{x:120,y:560}]},{at:70,type:'touchCancel',points:[]}],{settleMs:200});
  let e=await qa.sample(id+'-held');assert(e.summary.terminalReceipts.some(t=>t.action==='cancel'&&t.result?.ok&&t.result.touchState==='processed'),'Canonical cancel result missing');
  await quickTap();e=await qa.sample(id+'-blocked');assert(e.data.sent.map(unwrap).filter(p=>p.type==='touch'&&p.action==='start').length===1,'Cancel released owner before canonical ACK');
  await qa.releaseInputResults();await base.page.waitForTimeout(100);await quickTap();e=await qa.sample(id+'-released');qa.assertClientPath(e);assert(root(e).clicks===1,'Cancel release did not recover same document');return e.summary;
 };
 retired.layout=async()=>{
  const id=`v${base.version}-retired-layout-${Date.now()}`;await qa.navigate({id});
  await qa.trajectory([{at:0,type:'touchStart',points:[{x:120,y:650}]},{at:40,type:'touchMove',points:[{x:120,y:610}]}],{settleMs:100});
  const size=base.page.viewportSize();await base.page.setViewportSize({width:size.width+37,height:size.height});await base.ready();await qa.touch('touchEnd',[]);await base.page.waitForTimeout(300);const e=await qa.sample(id);qa.assertClientPath(e);await base.page.setViewportSize(size);await base.ready();await base.page.waitForTimeout(600);await qa.tap();const recovery=await qa.sample(id+'-recovery');assert(root(recovery).clicks===1,'Layout invalidation did not recover tap');return[e.summary,recovery.summary];
 };
 retired.document=async()=>{
  const id=`v${base.version}-retired-doc-${Date.now()}`;await qa.navigate({id:id+'-before'});const mark=qa.markStart;
  await qa.trajectory([{at:0,type:'touchStart',points:[{x:120,y:650}]},{at:40,type:'touchMove',points:[{x:120,y:600}]}],{settleMs:100});
  await qa.navigate({id:id+'-after'});qa.markStart=mark;await qa.touch('touchEnd',[]);await base.page.waitForTimeout(300);const e=await qa.sample(id);assert(!root(e).counts.touchstart&&!root(e).counts.touchmove&&root(e).positions.rootY===0,'Old owner reached new document');assert(e.summary.mediaStable,'Navigation rebuilt media identity');await qa.tap();const recovery=await qa.sample(id+'-recovery');assert(root(recovery).clicks===1,'Document invalidation did not recover tap');return[e.summary,recovery.summary];
 };
 retired.everymove=async()=>{
  const id=`v${base.version}-retired-everymove-${Date.now()}`;await qa.navigate({id,block:'everymove'});await qa.swipe({x:820,y:240,dy:-140});const e=await qa.sample(id);qa.assertClientPath(e);const f=root(e),moves=f.events.filter(x=>x.type==='handler-preventDefault'&&x.source==='touchmove');assert(moves.length===(f.counts.touchmove??0)&&moves.length>=6&&moves.every(x=>x.defaultPrevented),'Every touchmove consumption not proved');assert(f.positions.customY===0&&f.positions.rootY===0,'Continuously consumed moves scrolled');assert(f.counts.touchend&&e.summary.terminalReceipts.every(t=>t.result.ok&&t.result.touchState==='processed'),'Consumed terminal incomplete');return{name:e.name,summary:e.summary,moves:moves.length,positions:f.positions};
 };
 return{prepared:true,started:false,methods:Object.keys(retired)};
}
