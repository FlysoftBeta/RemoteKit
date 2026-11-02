import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { Store } from '../control/server/store.ts';
import { Control } from '../control/server/control.ts';
import { EndpointProcess } from '../control/server/endpoint.ts';
import { createHttp } from '../control/server/http.ts';
const root='C:/Users/Flysoft/Desktop/remotekit2',run=process.env.REMOTEKIT_TOUCH_QA_RUN??`${root}/develop/tmp/touch-source-qa-${Date.now()}`;
await mkdir(run,{recursive:true});
const store=new Store(`${run}/control.db`),endpoint=new EndpointProcess(`${root}/build/endpoint-package/endpoint/endpoint_service.exe`,['--browser=C:/src/chromium/src/out/dev/remotekit_browser.exe',`--data-path=${run}/endpoint-data`,...(process.env.REMOTEKIT_TOUCH_BROWSER_DISABLE_FEATURES?[`--browser-disable-features=${process.env.REMOTEKIT_TOUCH_BROWSER_DISABLE_FEATURES}`]:[])]);
const control=new Control(store,endpoint),latest=new Map<string,any>();
endpoint.on('ready',()=>void control.reconcileAll());
const server=createHttp(control,{origins:['http://127.0.0.1:33281'],clientDir:`${root}/control/dist/client`,metricsDir:`${run}/metrics`,diagnostics:false});
const fixture=createServer(async(req,res)=>{try{
res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','content-type');res.setHeader('Cache-Control','no-store');
if(req.method==='OPTIONS'){res.end();return;}
const url=new URL(req.url!,'http://127.0.0.1:33282');
if(url.pathname==='/telemetry'){let body='';for await(const chunk of req){body+=chunk;if(body.length>1000000)throw Error('telemetry too large');}const value=JSON.parse(body);latest.set(`${value.id}:${value.child?'child':'root'}`,value);await appendFile(`${run}/telemetry.jsonl`,body+'\n');res.end('ok');return;}
if(url.pathname==='/inspect'){const user=store.db.prepare('SELECT tenant FROM users LIMIT 1').get() as any;const snapshot=user?await endpoint.request('session.snapshot',user.tenant):null;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({run,browserDisableFeatures:process.env.REMOTEKIT_TOUCH_BROWSER_DISABLE_FEATURES??'',telemetry:Object.fromEntries(latest),state:user?control.productState(user.tenant):null,snapshot}));return;}
if(url.pathname==='/record'){let body='';for await(const chunk of req)body+=chunk;await writeFile(`${run}/result.json`,body);res.end('saved');return;}
if(url.pathname==='/shutdown'){res.end('stopping');setTimeout(()=>void close(),100);return;}
res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await readFile(`${root}/tools/testdata/touch-scroll.html`));
}catch(error){res.statusCode=500;res.end(String(error));}});
await new Promise<void>(r=>fixture.listen(33282,'0.0.0.0',r));await new Promise<void>(r=>server.listen(33281,'127.0.0.1',r));endpoint.start();const timer=setInterval(()=>void control.tick(),1500);
await writeFile(`${root}/develop/tmp/touch-source-qa-active.json`,JSON.stringify({run,pid:process.pid}));console.log('TOUCH QA READY '+run);
async function close(){clearInterval(timer);server.close();fixture.close();control.closeRelays();await endpoint.stop();store.db.close();process.exit(0)}process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
