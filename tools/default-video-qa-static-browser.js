// One bounded static-resize attempt on the already launched host-managed QA page.
// Requires default-video-qa-browser.js and host._defaultVideoQA.launch().
async(host)=>{
 const run=host._defaultVideoQA,p=run.page,index=host._defaultStaticAttempt??1;
 await p.setViewportSize({width:1440,height:900});
 await p.evaluate(async()=>{
  const q=defaultVideoQA;
  await q.rpc('action',{type:'window.layout',mode:'side-by-side',weights:q.state.workspace.windows.map(w=>({windowId:w.id,weight:1}))});
  for(let i=0;i<q.state.workspace.tabs.length;i++)await q.rpc('action',{type:'tab.navigate',tabId:q.state.workspace.tabs[i].id,url:'http://127.0.0.1:33272/?label='+(i?'B':'A')+'&prelude=1'});
 });
 await p.waitForTimeout(700);await run.ready();
 await p.evaluate(async()=>{
  const q=defaultVideoQA;
  await q.rpc('action',{type:'window.layout',mode:'focused'});
  await q.rpc('action',{type:'window.activate',windowId:q.state.workspace.windows[0].id});
 });
 await run.ready();
 await p.evaluate(()=>{
  const q=defaultVideoQA;q.delayFrameMs=180;q.delayFrameCount=1;
  return q.rpc('action',{type:'tab.navigate',tabId:q.state.workspace.tabs[0].id,url:'http://127.0.0.1:33272/?label=A&static=1&test=late-first'});
 });
 await p.waitForTimeout(1800);await run.ready();
 await p.setViewportSize({width:1100,height:760});await p.waitForTimeout(700);await run.ready();
 await run.click('1',200,450);
 await p.setViewportSize({width:390,height:844});await p.waitForTimeout(2000);
 const result=await run.sample('static-full-'+index+'-2s');
 return {index,epoch:result.layout.epoch,generation:result.layout.generation,views:result.layout.views.length,ready:result.planes.map(v=>v.ready)};
}
