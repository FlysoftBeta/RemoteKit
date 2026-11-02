import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { FileUploads, type InternalFileRequest } from '../server/file-uploads';
import { FILE_LIMITS } from '../shared/product';
import { Store } from '../server/store';
import { Control } from '../server/control';
import { createHttp } from '../server/http';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rk-file-control-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls: { method: string; args: any }[] = [], paths = new Map<string,string>();
  let lease = 'lease', authentication = 'authentication', browserState = 'validating';
  const request: InternalFileRequest = { id:'opaque-request',tabId:'tab',windowId:'window',origin:'https://example.com',multiple:true,accept:['.txt'],state:'pending',limits:FILE_LIMITS,binding:{browserIncarnation:'browser-A',view:'1',instance:'2',document:'3',request:'7'} };
  const endpoint = { async request(method: string, _tenant: string, args: any = {}) {
    calls.push({method,args});
    if(method==='session.files.begin') { const uploadId=randomUUID();const files=[];for(const spec of args.files){const ticket=randomUUID(),path=join(directory,ticket);await writeFile(path,'');paths.set(ticket,path);files.push({ticket,path});}return{uploadId,files}; }
    if(method==='session.files.commit'||method==='session.files.status')return{state:browserState};
    return{state:'cancelled'};
  }};
  const manager=new FileUploads(endpoint,(tenant,expectedLease,expectedAuth)=>{if(tenant!=='tenant'||expectedLease!==lease||expectedAuth!==authentication)throw Error('lease revoked');},(_tenant,id)=>id===request.id?request:undefined,{maxFileBytes:4,maxBatchBytes:6,maxFiles:2,sessionBytes:8});
  return {manager,request,paths,calls,setLease:(value:string)=>{lease=value;},setAuth:(value:string)=>{authentication=value;},setState:(value:string)=>{browserState=value;}};
}
const spec=(name='original.txt',size=3)=>({name,size,type:'text/plain'});
test('accept is a picker hint and MIME metadata does not filter legitimate file choices', async t => {
  const f = await fixture(t);
  const begin = await f.manager.begin('tenant', 'lease', 'authentication', { requestId: f.request.id, files: [{ name: 'photo.jpg', size: 3, type: 'image/jpeg; profile=example' }] });
  assert.ok(begin.uploadId); assert.deepEqual(f.request.accept, ['.txt']);
});
test('bounded octet streaming is single-use and async commit is idempotent without exposing paths',async t=>{
  const f=await fixture(t),begin=await f.manager.begin('tenant','lease','authentication',{requestId:f.request.id,files:[spec()]});
  assert.equal(JSON.stringify(begin).includes('path'),false);
  const ticket=begin.files[0].ticket;
  await f.manager.stream('tenant','authentication',ticket,Readable.from([Buffer.from('a'),Buffer.from('bc')]),'3');
  assert.equal((await readFile(f.paths.get(ticket)!)).toString(),'abc');
  await assert.rejects(f.manager.stream('tenant','authentication',ticket,Readable.from(['abc']),'3'),/已使用/);
  assert.deepEqual(await f.manager.commit('tenant','lease','authentication',{uploadId:begin.uploadId}),{state:'validating'});
  f.setState('selected');assert.deepEqual(await f.manager.commit('tenant','lease','authentication',{uploadId:begin.uploadId}),{state:'selected'});
  assert.deepEqual(await f.manager.cancel('tenant','lease','authentication',{requestId:f.request.id,uploadId:begin.uploadId}),{state:'selected'});
  assert.equal(f.calls.filter(c=>c.method==='session.files.begin').length,1);
  assert.equal(f.calls.filter(c=>c.method==='session.files.commit').length,2);
});
test('metadata, single selection, quotas and client paths are rejected before Endpoint allocation',async t=>{
  const f=await fixture(t);
  for(const files of [[spec('../escape')],[{...spec(),path:'C:/sensitive'}],[spec('large',5)],[spec('a',4),spec('b',3)]])await assert.rejects(f.manager.begin('tenant','lease','authentication',{requestId:f.request.id,files}));
  f.request.multiple=false;await assert.rejects(f.manager.begin('tenant','lease','authentication',{requestId:f.request.id,files:[spec('a',1),spec('b',1)]}),/数量/);
  assert.equal(f.calls.length,0);
});
test('failed/truncated streams clean drafts without cancelling the pending chooser and retry gets fresh tickets',async t=>{
  const f=await fixture(t),a=await f.manager.begin('tenant','lease','authentication',{requestId:f.request.id,files:[spec()]});
  await assert.rejects(f.manager.stream('tenant','authentication',a.files[0].ticket,Readable.from(['ab'])) ,/不完整/);
  assert.equal(f.calls.find(c=>c.method==='session.files.cancel')!.args.cancelRequest,undefined);
  const b=await f.manager.begin('tenant','lease','authentication',{requestId:f.request.id,files:[spec()]});
  assert.notEqual(a.files[0].ticket,b.files[0].ticket);
  await assert.rejects(f.manager.stream('tenant','authentication',a.files[0].ticket,Readable.from(['abc'])),/不存在/);
  await assert.rejects(f.manager.commit('tenant','lease','authentication',{uploadId:b.uploadId}),/尚未/);
});
test('lease and token replacement abort streaming, stale tickets cannot cross users or peer leases',async t=>{
  const f=await fixture(t),a=await f.manager.begin('tenant','lease','authentication',{requestId:f.request.id,files:[spec()]});
  await assert.rejects(f.manager.stream('other','authentication',a.files[0].ticket,Readable.from(['abc'])),/不存在/);
  await assert.rejects(f.manager.stream('tenant','other-token',a.files[0].ticket,Readable.from(['abc'])),/不存在/);
  const source=Readable.from((async function*(){yield Buffer.from('a');f.setLease('replacement');yield Buffer.from('bc');})());
  await assert.rejects(f.manager.stream('tenant','authentication',a.files[0].ticket,source),/lease revoked/);
  assert.ok(f.calls.some(c=>c.method==='session.files.cancel'));
});
test('explicit cancellation carries the Browser binding and submitted cancellation cannot pretend success',async t=>{
  const f=await fixture(t),a=await f.manager.begin('tenant','lease','authentication',{requestId:f.request.id,files:[spec()]});
  await f.manager.stream('tenant','authentication',a.files[0].ticket,Readable.from(['abc']));
  await f.manager.commit('tenant','lease','authentication',{uploadId:a.uploadId});
  // A pending async Browser result must stay validating until its explicit ACK.
  const original=(f.manager as any).endpoint.request.bind((f.manager as any).endpoint);
  (f.manager as any).endpoint.request=async(method:string,tenant:string,args:any)=>method==='session.files.cancel'?{state:'validating'}:original(method,tenant,args);
  assert.deepEqual(await f.manager.cancel('tenant','lease','authentication',{requestId:f.request.id,uploadId:a.uploadId}),{state:'validating'});
});
test('unknown cancellation results never claim the native chooser was cancelled', async t => {
  const f = await fixture(t), original = (f.manager as any).endpoint.request.bind((f.manager as any).endpoint);
  (f.manager as any).endpoint.request = async (method: string, tenant: string, args: any) => method === 'session.files.cancel' ? {} : original(method, tenant, args);
  assert.deepEqual(await f.manager.cancel('tenant', 'lease', 'authentication', { requestId: f.request.id }), { state: 'validating' });
  const begin = await f.manager.begin('tenant', 'lease', 'authentication', { requestId: f.request.id, files: [spec()] });
  assert.deepEqual(await f.manager.cancel('tenant', 'lease', 'authentication', { requestId: f.request.id, uploadId: begin.uploadId }), { state: 'validating' });
});
test('octet HTTP route requires cookie and Origin and writes a bound ticket without JSON buffering',async t=>{
  const f=await fixture(t),store=new Store(':memory:');t.after(()=>store.db.close());
  const account=await store.register('file-http','password123'),authentication=createHash('sha256').update(account.token).digest('hex');
  f.setAuth(authentication);
  // FileUploads uses a fixed test Tenant; HTTP identity comes from actual Store.
  const receive=async(_tenant:string,auth:string,ticket:string,source:Readable,length?:string)=>Control.prototype.receiveFileUpload.call({uploads:f.manager} as any,'tenant',auth,ticket,source,length);
  const control=Object.assign(new EventEmitter(),{store,receiveFileUpload:receive}) as unknown as Control;
  const server=createHttp(control,{origins:['http://127.0.0.1'],clientDir:'.',metricsDir:'.'});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address() as {port:number},base=`http://127.0.0.1:${address.port}`;
  const a=await f.manager.begin('tenant','lease',authentication,{requestId:f.request.id,files:[spec()]});
  const url=base+a.files[0].url,headers={Origin:'http://127.0.0.1',Cookie:`rk_session=${account.token}`,'Content-Type':'application/octet-stream'};
  assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:'abc'})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers:{Origin:headers.Origin,'Content-Type':'application/octet-stream'},body:'abc'})).status,401);
  assert.equal((await fetch(url,{method:'POST',headers,body:'abc'})).status,204);
  assert.equal((await fetch(url,{method:'POST',headers,body:'abc'})).status,409);
});

test('stream failure preserves owned binding so abort followed by cancel reaches the native chooser', async t => {
  const f = await fixture(t), begin = await f.manager.begin('tenant', 'lease', 'authentication', { requestId: f.request.id, files: [spec()] });
  await assert.rejects(f.manager.stream('tenant', 'authentication', begin.files[0].ticket, Readable.from(['a'])), /不完整/);
  await assert.rejects(f.manager.cancel('tenant', 'lease', 'authentication', { requestId: f.request.id, uploadId: 'unknown-id' }), /不存在/);
  assert.deepEqual(await f.manager.cancel('tenant', 'lease', 'authentication', { requestId: f.request.id, uploadId: begin.uploadId }), { state: 'cancelled' });
  const nativeCancel = f.calls.find(c => c.method === 'session.files.cancel' && c.args.cancelRequest);
  assert.deepEqual(nativeCancel?.args.binding, f.request.binding);
  assert.equal(nativeCancel?.args.uploadId, undefined);
  const count = f.calls.length;
  assert.deepEqual(await f.manager.cancel('tenant', 'lease', 'authentication', { requestId: f.request.id, uploadId: begin.uploadId }), { state: 'cancelled' });
  assert.equal(f.calls.length, count);
});

test('cancel retries unknown native result after draft retirement and rejects mismatched binding', async t => {
  const f = await fixture(t), begin = await f.manager.begin('tenant', 'lease', 'authentication', { requestId: f.request.id, files: [spec()] });
  const endpoint = (f.manager as any).endpoint, original = endpoint.request.bind(endpoint);
  let first = true;
  endpoint.request = async (method: string, tenant: string, args: any) => {
    if (method === 'session.files.cancel' && args.cancelRequest && first) { first = false; throw new Error('reply lost'); }
    return original(method, tenant, args);
  };
  await assert.rejects(f.manager.cancel('tenant', 'lease', 'authentication', { requestId: 'different', uploadId: begin.uploadId }), /不匹配/);
  await assert.rejects(f.manager.cancel('tenant', 'lease', 'authentication', { requestId: f.request.id, uploadId: begin.uploadId }), /reply lost/);
  assert.deepEqual(await f.manager.cancel('tenant', 'lease', 'authentication', { requestId: f.request.id, uploadId: begin.uploadId }), { state: 'cancelled' });
});
