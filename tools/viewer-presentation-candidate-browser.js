// Host-managed Playwright entry, after viewer-presentation-baseline-browser.js bootstraps a 157 page.
// Call run.prepareCandidate(2,1), then run.candidateSample(name,'2d'|'webgl'); repeat with (4,1.5).
async(hostPage)=>{
 const run=hostPage._presentationBaseline;if(!run?.page)throw Error('Bootstrap isolated production Viewer first');
 const root=hostPage._baselineRoot??'C:/Users/Flysoft/Desktop/remotekit2/develop/tmp/viewer-presentation-candidate';
 run.candidateReports=[];
 run.prepareCandidate=async(planes,scale)=>{
   await run.page.setViewportSize({width:1920,height:1168});
   await run.page.evaluate(async({planes,scale})=>{
     window.candidate?.dispose();await baseline.rpc('action',{type:'settings.update',settings:{qualityPreference:'quality',clientScaleOverride:scale}});
     if(baseline.state.workspace.windows.length>planes)throw Error('Use fresh isolated workspace or increase plane count');
     while(baseline.state.workspace.windows.length<planes)await baseline.rpc('action',{type:'window.create',url:'http://127.0.0.1:33272/animation'});
   },{planes,scale});
   await run.page.waitForTimeout(2000);
   await run.page.addScriptTag({path:'C:/Users/Flysoft/Desktop/remotekit2/tools/viewer-presentation-candidate.js'});
   return run.page.evaluate(()=>{window.candidate=installPresentationCandidate(baseline.transport());return {layout:baseline.transport().layout,quality:baseline.state.quality}});
 };
 run.candidateSample=async(name,mode)=>{
   await run.page.evaluate(mode=>{candidate.setMode(mode);candidate.reset()},mode);await run.page.waitForTimeout(1000);
   const sample=()=>run.page.evaluate(async()=>{const t=baseline.transport();return {at:performance.now(),candidate:candidate.snapshot(),stats:Array.from((await t.peer.getStats()).values()),presentation:t.getPresentationDiagnostics(),layout:t.layout,quality:baseline.state.quality}});
   await run.page.evaluate(()=>candidate.reset());const before=await sample();await run.page.waitForTimeout(12000);const after=await sample();
   await run.page.screenshot({path:root+'/'+name+'.png'});const report={name,before,after};run.candidateReports.push(report);
   await run.page.evaluate(async report=>{const data=JSON.stringify(report),size=200000,total=Math.ceil(data.length/size);for(let index=0;index<total;index++){const response=await fetch('/api/metrics',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'viewer-candidate-chunk',name:report.name,index,total,data:data.slice(index*size,(index+1)*size)})});if(!response.ok)throw Error('metrics '+response.status)}},report);
   const seconds=(after.at-before.at)/1000,costs=after.candidate.costs,pct=(k,p)=>costs.map(c=>c[k]).sort((a,b)=>a-b)[Math.ceil(costs.length*p)-1];
   return {name,seconds,paintFps:after.candidate.frames/seconds,byView:after.candidate.byView,layout:after.layout,submitP95:pct('total',.95),uploadP95:pct('upload',.95),readToSubmitP95:pct('readToSubmit',.95),drops:after.candidate.drops};
 };
 return {ready:true,next:'prepareCandidate(2,1), paired 2d/webgl samples; prepareCandidate(4,1.5), paired samples; close contexts and shutdown service'};
}
