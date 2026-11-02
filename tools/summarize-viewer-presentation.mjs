// Reassemble bounded metrics chunks and summarize actual frame deltas/costs/resource windows.
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(process.argv[2]??'develop/tmp/viewer-presentation-candidate');
const rows=(await readFile(resolve(root,'metrics/client-metrics.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
const cases=new Map();
for(const {metrics:m} of rows){if(m.kind==='viewer-presentation-baseline'){if(cases.has(m.name))throw Error('Duplicate case '+m.name);cases.set(m.name,{total:1,parts:new Map([[0,JSON.stringify(m)]])});continue;}if(!['viewer-candidate-chunk','viewer-presentation-baseline-chunk'].includes(m.kind))continue;let c=cases.get(m.name);if(!c){c={total:m.total,parts:new Map()};cases.set(m.name,c)}if(c.total!==m.total||c.parts.has(m.index))throw Error('Inconsistent/duplicate chunks '+m.name);c.parts.set(m.index,m.data);}
const pct=(values,p=.95)=>{const a=values.filter(Number.isFinite).sort((a,b)=>a-b);return a.length?a[Math.ceil(a.length*p)-1]:null};
const mean=a=>{const values=a.filter(Number.isFinite);return values.length?values.reduce((x,y)=>x+y,0)/values.length:null};
const result=[];
for(const [name,c] of cases){if(c.parts.size!==c.total)throw Error('Missing chunks '+name);const report=JSON.parse(Array.from({length:c.total},(_,i)=>{if(!c.parts.has(i))throw Error('Missing index');return c.parts.get(i)}).join(''));await writeFile(resolve(root,name+'.json'),JSON.stringify(report));
 const {before:b,after:a}=report,p=a.candidate,dt=(a.at-b.at)/1000,inbound=x=>x.stats.find(s=>s.type==='inbound-rtp'&&(s.kind==='video'||s.mediaType==='video')),ia=inbound(a),ib=inbound(b);
 if(!p){result.push({name,seconds:dt,decodeFps:(ia.framesDecoded-ib.framesDecoded)/dt,paintFpsByView:Object.fromEntries(Object.entries(a.presentation.canvasPaintByView).map(([view,count])=>[view,(count.frames-(b.presentation.canvasPaintByView[view]?.frames??0))/dt])),frameSource:a.presentation.frameSource,layout:a.layout,quality:a.state.quality,processor:a.presentation.processor,epoch:a.presentation.epoch});continue;}
 let resources=[];const resourceName=name.startsWith('two-')?'two-':'four-';try{resources=(await readFile(resolve(root,resourceName+(p.mode==='2d'?'2d':'webgl')+'-resources.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).filter(s=>s.wall>=ib.timestamp&&s.wall<=ia.timestamp)}catch{}
 const resource={samples:resources.length};for(const role of ['receiver','source','control']){resource[role]={cpuCores:mean(resources.map(s=>{const cpu=s.cpu.filter(x=>x.role===role&&Number.isFinite(x.cores));return cpu.length?cpu.reduce((sum,x)=>sum+x.cores,0):null})),gpu:Object.fromEntries(['3D','VideoDecode','VideoProcessing','Copy'].map(engine=>[engine,mean(resources.map(s=>s.gpu.filter(x=>x.role===role&&x.engine===engine).reduce((sum,x)=>sum+x.percent,0)))]))};}
 const delta={};for(const k of ['read','authorized','discarded','replaced','invalid','rafCallbacks','rafAdmitted'])delta[k]=(a.presentation.processor[k]??0)-(b.presentation.processor[k]??0);
 result.push({name,seconds:dt,decodeFps:(ia.framesDecoded-ib.framesDecoded)/dt,paintFps:p.frames/dt,byView:p.byView,processorDelta:delta,metadataMissingAtRead:p.metadataMissingAtRead,metadataWaitP95:pct(p.metadataWait),readToSubmitP95:pct(p.costs.map(x=>x.readToSubmit)),submitP50:pct(p.costs.map(x=>x.total),.5),submitP95:pct(p.costs.map(x=>x.total)),uploadP95:pct(p.costs.map(x=>x.upload)),draws:p.draws,uploads:p.uploads,drops:p.drops,layout:a.layout,geometry:p.geometry,resources:resource});
}
await writeFile(resolve(root,'summary.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
