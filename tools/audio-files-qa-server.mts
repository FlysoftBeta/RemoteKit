// Isolated ordinary Viewer + synthetic AV/file fixture. No user's camera/audio/files.
import {createServer} from 'node:http';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Store} from '../control/server/store.ts';
import {Control} from '../control/server/control.ts';
import {EndpointProcess} from '../control/server/endpoint.ts';
import {createHttp} from '../control/server/http.ts';
const root=resolve('.'),run=resolve(process.argv[2]??'develop/tmp/audio-files-qa');await mkdir(run,{recursive:true});
const store=new Store(`${run}/control.db`),endpoint=new EndpointProcess(`${root}/build/endpoint-package/endpoint/endpoint_service.exe`,['--browser=C:/src/chromium/src/out/dev/remotekit_browser.exe',`--data-path=${run}/endpoint`]);
const control=new Control(store,endpoint),events:any[]=[];endpoint.on('ready',()=>void control.reconcileAll());
const server=createHttp(control,{origins:['http://127.0.0.1:33271'],clientDir:`${root}/control/dist/client`,metricsDir:`${run}/metrics`,diagnostics:false});
const fixture=createServer(async(req,res)=>{
 const url=new URL(req.url!,'http://127.0.0.1:33272');
 if(url.pathname==='/shutdown'){res.end('stopping');setTimeout(()=>void close(),100);return;}
 if(url.pathname==='/inspect'){const user=store.db.prepare('SELECT tenant FROM users WHERE username=?').get('baseline') as any;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({state:user?control.productState(user.tenant):null,events,snapshot:user?await endpoint.request('session.snapshot',user.tenant):null}));return;}
 if(url.pathname==='/event'&&req.method==='POST'){let text='';for await(const chunk of req){text+=chunk;if(text.length>65536){res.writeHead(413).end();return;}}events.push(JSON.parse(text));if(events.length>128)events.shift();await writeFile(`${run}/fixture-events.json`,JSON.stringify(events,null,2));res.end('ok');return;}
 if(url.pathname==='/prototype'){res.setHeader('Content-Type','text/html');res.end(await readFile(`${root}/tools/camera-score-browser-fixture.html`));return;}
 if(url.pathname==='/audio-device-probe'){res.setHeader('Content-Type','text/html');res.end(await readFile(`${root}/tools/audio-device-qa-fixture.html`));return;}
 res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta name="viewport" content="width=device-width"><style>body{margin:0;font:16px sans-serif}button{height:50px;width:130px}#flash{width:160px;height:160px;background:#111}canvas{width:100%;height:360px}</style>
 <button id="sound">Start sound</button><button id="single">Single file</button><button id="multiple">Multiple files</button><button id="gap">400ms gap</button><button id="pulse">AV pulse</button><button id="later">Delayed read</button><div id="flash"></div><canvas></canvas><input hidden id="one" type="file" accept=".txt"><input hidden id="many" type="file" multiple><script>
 const report=(type,data={})=>fetch('/event',{method:'POST',body:JSON.stringify({type,at:performance.now(),...data})});let ctx,held=[],pulseUntil=0,pulseStart=0;const c=document.querySelector('canvas'),g=c.getContext('2d');c.width=1000;c.height=360;let n=0;function frame(){n++;g.fillStyle='#ddd';g.fillRect(0,0,1000,360);g.fillStyle='#3570a0';g.fillRect(n*8%1000,20,100,300);document.querySelector('#flash').style.background=ctx&&ctx.currentTime>=pulseStart&&ctx.currentTime<pulseUntil?'white':'#111';requestAnimationFrame(frame)}frame();
 sound.onclick=async()=>{ctx??=new AudioContext({sampleRate:48000});await ctx.resume();if(!window.started){window.started=true;const merge=ctx.createChannelMerger(2);[440,880].forEach((freq,i)=>{const o=ctx.createOscillator(),gain=ctx.createGain();o.frequency.value=freq;gain.gain.value=.08;o.connect(gain);gain.connect(merge,0,i);o.start()});merge.connect(ctx.destination);}report('sound',{state:ctx.state,sampleRate:ctx.sampleRate})};
 single.onclick=()=>one.click();multiple.onclick=()=>many.click();gap.onclick=async()=>{await ctx.suspend();report('gap-start');setTimeout(async()=>{await ctx.resume();report('gap-end')},400)};
 pulse.onclick=()=>{const o=ctx.createOscillator(),gain=ctx.createGain();o.frequency.value=1000;gain.gain.value=.6;o.connect(gain).connect(ctx.destination);const at=ctx.currentTime+.2;pulseStart=at;pulseUntil=at+.1;gain.gain.setValueAtTime(0,ctx.currentTime);gain.gain.setValueAtTime(.6,at);gain.gain.setValueAtTime(0,at+.1);o.start();o.stop(at+.11);report('pulse',{scheduled:at})};
 for(const input of [one,many])input.onchange=async()=>{held=[...input.files];report('selected',{names:held.map(f=>f.name),sizes:held.map(f=>f.size),texts:await Promise.all(held.map(f=>f.text()))});input.value=''};
 later.onclick=async()=>{history.pushState({},'','/after-selection');report('delayed',{names:held.map(f=>f.name),texts:await Promise.all(held.map(f=>f.text()))})};report('ready');</script>`);
});
await new Promise<void>(r=>fixture.listen(33272,'127.0.0.1',r));await new Promise<void>(r=>server.listen(33271,'127.0.0.1',r));endpoint.start();const timer=setInterval(()=>void control.tick(),1500);console.log(`READY ${run}`);
async function close(){clearInterval(timer);server.close();fixture.close();control.closeRelays();await endpoint.stop();store.db.close();process.exit(0)}process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
