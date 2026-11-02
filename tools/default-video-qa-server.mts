// Isolated production Viewer functional fixture; no policy/backend override.
import {createServer} from 'node:http';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Store} from '../control/server/store.ts';
import {Control} from '../control/server/control.ts';
import {EndpointProcess} from '../control/server/endpoint.ts';
import {createHttp} from '../control/server/http.ts';
const root=resolve('.'),run=resolve(process.argv[2]??'develop/tmp/default-video-qa');
await mkdir(run,{recursive:true});
const store=new Store(`${run}/control.db`),endpoint=new EndpointProcess(`${root}/build/endpoint-package/endpoint/endpoint_service.exe`,['--browser=C:/src/chromium/src/out/dev/remotekit_browser.exe',`--data-path=${run}/endpoint`]);
const control=new Control(store,endpoint),events:any[]=await readFile(`${run}/fixture-events.json`,'utf8').then(JSON.parse).catch(()=>[]);
endpoint.on('ready',()=>void control.reconcileAll());
const server=createHttp(control,{origins:['http://127.0.0.1:33271'],clientDir:`${root}/control/dist/client`,metricsDir:`${run}/metrics`,diagnostics:false});
const fixture=createServer(async(req,res)=>{
 const url=new URL(req.url!,'http://127.0.0.1:33272');
 if(url.pathname==='/shutdown'){res.end('stopping');setTimeout(()=>void close(),100);return;}
 if(url.pathname==='/inspect'){const user=store.db.prepare('SELECT tenant FROM users WHERE username=?').get('default-video') as any;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({state:user?control.productState(user.tenant):null,events,snapshot:user?await endpoint.request('session.snapshot',user.tenant,{outputDiagnostics:true}):null}));return;}
 if(url.pathname==='/event'&&req.method==='POST'){let text='';for await(const chunk of req){text+=chunk;if(text.length>65536){res.writeHead(413).end();return;}}events.push(JSON.parse(text));if(events.length>1024)events.shift();await writeFile(`${run}/fixture-events.json`,JSON.stringify(events,null,2));res.end('ok');return;}
 const label=url.searchParams.get('label')==='B'?'B':'A', isStatic=url.searchParams.has('static');
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><meta name="viewport" content="width=device-width"><style>*{box-sizing:border-box}html,body{margin:0;background:${label==='A'?'#ecf4ff':'#fff3e7'};font:16px system-ui;color:#17334f}header{padding:20px 24px;background:${label==='A'?'#195ca4':'#b15e13'};color:white}h1{margin:0;font-size:25px}main{padding:20px 24px}button{height:48px;margin-right:10px;padding:0 16px}#geometry{font:15px monospace;margin:18px 0}canvas{width:100%;height:150px;background:white;border:1px solid #b7c7d6}#result{font:16px monospace;white-space:pre-wrap;margin-top:16px}#target{width:100%;height:100px;border:2px dashed #52728b;display:grid;place-items:center;margin-top:16px;touch-action:none}</style>
 <header><h1>RemoteKit · Window ${label}</h1><div>Live video / input / audio / file fixture</div></header><main><button id="sound">Start sound</button><button id="file">Choose file</button><div id="geometry"></div><canvas></canvas><div id="target">Click / touch coordinate target</div><div id="result">Waiting for input</div><input hidden id="upload" type="file"></main><script>
 const label='${label}',report=(type,data={})=>fetch('/event',{method:'POST',body:JSON.stringify({type,label,at:performance.now(),...data})});
 const c=document.querySelector('canvas'),g=c.getContext('2d');let n=0;function size(){c.width=Math.max(1,innerWidth-48);c.height=150;geometry.textContent=innerWidth+' × '+innerHeight+' DIP · DPR '+devicePixelRatio;document.title='Window '+label+' '+innerWidth+'x'+innerHeight+' @'+devicePixelRatio;report('geometry',{width:innerWidth,height:innerHeight,dpr:devicePixelRatio})}onresize=size;size();
 function frame(){n++;g.fillStyle='white';g.fillRect(0,0,c.width,150);g.fillStyle='${label==='A'?'#2681ce':'#e68b28'}';g.fillRect((n*4)%(c.width+80)-80,0,80,150);g.fillStyle='#17334f';g.font='22px system-ui';g.fillText('Live frame '+n,16,85);if(!${isStatic})requestAnimationFrame(frame)}frame();
 let ctx;sound.onclick=async()=>{ctx??=new AudioContext({sampleRate:48000});await ctx.resume();if(!window.started){window.started=true;const merge=ctx.createChannelMerger(2);[440,880].forEach((freq,i)=>{const o=ctx.createOscillator(),gain=ctx.createGain();o.frequency.value=freq;gain.gain.value=.08;o.connect(gain);gain.connect(merge,0,i);o.start()});merge.connect(ctx.destination)}report('sound',{state:ctx.state})};
 file.onclick=()=>upload.click();upload.onchange=async()=>{const files=await Promise.all([...upload.files].map(async f=>({name:f.name,size:f.size,text:await f.text()})));result.textContent=JSON.stringify(files);report('files',{files});upload.value=''};
 for(const kind of ['pointerdown','pointerup'])target.addEventListener(kind,e=>{const data={kind,x:e.clientX,y:e.clientY,pointerType:e.pointerType,width:innerWidth,height:innerHeight,dpr:devicePixelRatio};result.textContent=JSON.stringify(data);report('input',data)});report('ready');</script>`);
});
await new Promise<void>(r=>fixture.listen(33272,'127.0.0.1',r));await new Promise<void>(r=>server.listen(33271,'127.0.0.1',r));endpoint.start();const timer=setInterval(()=>void control.tick(),1500);
await writeFile(`${run}/service.json`,JSON.stringify({pid:process.pid,run,started:new Date().toISOString()}));console.log(`READY ${run}`);
async function close(){clearInterval(timer);server.close();fixture.close();control.closeRelays();await endpoint.stop();store.db.close();process.exit(0)}process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
