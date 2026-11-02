// Explicit root READY + exclusive GPU grant required. Never launches during preparation.
import {createServer} from 'node:http';
import {mkdir,readFile,stat,writeFile,appendFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {Store} from '../control/server/store.ts';
import {Control} from '../control/server/control.ts';
import {EndpointProcess} from '../control/server/endpoint.ts';
import {createHttp} from '../control/server/http.ts';
const root=resolve('.'),run=resolve(process.argv[2]??`develop/tmp/client-gesture-qa-${Date.now()}`);
if(process.env.CLIENT_GESTURE_QA_READY!=='1'||process.env.CLIENT_GESTURE_QA_GPU_GRANTED!=='1')throw Error('Root READY and exclusive GPU grant required');
function required(key:string){const value=process.env[key];if(!value)throw Error(`Explicit current-batch artifact required: ${key}`);return resolve(value)}
const executable=required('CLIENT_GESTURE_QA_ENDPOINT'),browser=required('CLIENT_GESTURE_QA_BROWSER'),clientDir=required('CLIENT_GESTURE_QA_CLIENT_DIR');
const artifacts=await Promise.all([executable,browser,join(clientDir,'index.html')].map(async path=>{const s=await stat(path);return{path,mtime:s.mtime.toISOString(),bytes:s.size}}));
const port=Number(process.env.CLIENT_GESTURE_QA_PORT??33581),fixturePort=port+1;await mkdir(run,{recursive:true});
const browserDisableFeatures=process.env.CLIENT_GESTURE_QA_BROWSER_DISABLE_FEATURES??'';
const store=new Store(join(run,'control.db')),endpoint=new EndpointProcess(executable,[`--browser=${browser}`,`--data-path=${join(run,'endpoint')}`,...(browserDisableFeatures?[`--browser-disable-features=${browserDisableFeatures}`]:[])]),control=new Control(store,endpoint);
const latest=new Map<string,unknown>(),commands=new Map<string,unknown[]>(),fixtureHtml=await readFile(join(root,'tools/client-gesture-qa-page.html'));
const server=createHttp(control,{origins:[`http://127.0.0.1:${port}`],clientDir,metricsDir:join(run,'metrics'),diagnostics:false});
endpoint.on('ready',()=>void control.reconcileAll());
const fixture=createServer(async(req,res)=>{try{
 res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','content-type');res.setHeader('Cache-Control','no-store');
 if(req.method==='OPTIONS'){res.end();return}const url=new URL(req.url??'/',`http://127.0.0.1:${fixturePort}`);
 if(url.pathname==='/shutdown'){res.end('stopping');setTimeout(()=>void close(),100);return}
 if(url.pathname==='/command'){const id=url.searchParams.get('id')??'';if(req.method==='POST'){let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)throw Error('command too large')}const value=JSON.parse(body);if(value.type!=='remove-child')throw Error('unknown fixture command');commands.set(id,[...(commands.get(id)??[]),value]);res.end('queued');return}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(commands.get(id)??[]));commands.delete(id);return}
 if(url.pathname==='/telemetry'&&req.method==='POST'){let body='';for await(const chunk of req){body+=chunk;if(body.length>2*1024*1024){res.writeHead(413).end();return}}const value=JSON.parse(body);latest.set(`${value.id}:${value.child?'child':'root'}`,value);await appendFile(join(run,'telemetry.jsonl'),body+'\n');res.end('ok');return}
 if(url.pathname==='/inspect'){const users=store.db.prepare('SELECT username,tenant FROM users').all() as {username:string;tenant:string}[];res.setHeader('Content-Type','application/json');res.end(JSON.stringify({run,artifacts,telemetry:Object.fromEntries(latest),users:await Promise.all(users.map(async user=>({username:user.username,state:control.productState(user.tenant),snapshot:await endpoint.request('session.snapshot',user.tenant,{outputDiagnostics:true}).catch(error=>({error:String(error)}))})))}));return}
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fixtureHtml);
 }catch(error){res.writeHead(500).end(String(error))}});
let closing=false;const timer=setInterval(()=>void control.tick(),1500);
async function close(){if(closing)return;closing=true;clearInterval(timer);await server.shutdown();await control.close();await endpoint.stop();await new Promise<void>(r=>fixture.close(()=>r()));store.db.close();process.exitCode=0}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
await new Promise<void>(r=>fixture.listen(fixturePort,'0.0.0.0',r));await new Promise<void>(r=>server.listen(port,'127.0.0.1',r));endpoint.start();
await writeFile(join(run,'service.json'),JSON.stringify({pid:process.pid,run,port,fixturePort,artifacts,browserDisableFeatures,started:new Date().toISOString()},null,2));console.log(`CLIENT GESTURE QA READY ${run}`);
