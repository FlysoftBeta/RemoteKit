import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteTransport } from '../client/transport';
import { TouchInput } from '../client/touch-input';
import type { Surface } from '../client/types';

function setup(t: TestContext) {
  const old = Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>({})}});
  const transport = new RemoteTransport();
  if(old) Object.defineProperty(globalThis,'document',old); else Reflect.deleteProperty(globalThis,'document');
  const surface: Surface = {id:'1',session:'s',instance:'i',document:'d',focus:'7',x:0,y:0,width:640,height:480,deviceScaleFactor:1};
  transport.layout={type:'layout',generation:'1',epoch:'2',width:640,height:480,views:[surface]};
  let ready=true; (transport as any).canInput=()=>ready;
  const sent:any[]=[];
  const channel:any={readyState:'open',bufferedAmount:0,send:(data:string)=>sent.push(JSON.parse(data))};
  (transport as any).bindChannel(channel);
  t.after(()=>clearTimeout((transport as any).inputDrainTimer));
  return {transport,surface,sent,channel,setReady:(value:boolean)=>{ready=value;}};
}
const point=(y:number)=>({id:1,x:10,y,pressure:.5});
test('DC backpressure batches recent sampling history and reliably drains start/move/end in order',t=>{
  const {transport,surface,sent,channel}=setup(t); channel.bufferedAmount=300000;
  const touch=new TouchInput('dc'), identity=transport.inputIdentity(surface);
  assert.equal(transport.sendInput(surface,touch.sample(identity,'start',point(0),0,1700000000000000)!),true);
  for(let i=1;i<=100;i++) assert.equal(transport.sendInput(surface,touch.sample(identity,'move',point(i),i)!),true);
  assert.equal(transport.sendInput(surface,touch.sample(identity,'end',point(100),101)!),true);
  assert.equal(sent.length,0); channel.bufferedAmount=0; channel.onbufferedamountlow();
  assert.deepEqual(sent.map(p=>p.event.action),['start','move','end']);
  assert.equal(sent[1].event.samples.length,32); assert.equal(sent[1].event.sampleElapsedUs,100000); assert.equal(sent[2].event.sampleElapsedUs,101000);
  assert.equal(transport.touchInputStats.merged,99);
});
test('terminal touch waits for matching paint and stale layout invalidates queued tokens',t=>{
  const {transport,surface,sent,setReady}=setup(t);
  const touch=new TouchInput('gate'), identity=transport.inputIdentity(surface);
  transport.sendInput(surface,touch.sample(identity,'start',point(0),0)!);
  setReady(false); assert.equal(transport.sendInput(surface,touch.cancel()!),true); assert.equal(sent.length,1);
  setReady(true); (transport as any).drainInput(); assert.equal(sent[1].event.action,'cancel');
  const next=touch.sample(identity,'start',point(0),100)!; setReady(false);
  assert.equal(transport.sendInput(surface,next),false);
  assert.equal(transport.sendInput(surface,touch.cancel()!),true);
  transport.layout!.epoch='3'; setReady(true); (transport as any).drainInput(); assert.equal(sent.length,2);
  assert.ok(transport.touchInputStats.dropped>=1);
});
test('focus ACK preserves gesture identity and second contact does not renew focus',t=>{
  const {transport,surface,sent,channel}=setup(t);
  transport.ensureInputFocus(surface); const request=sent[0], identity=transport.inputIdentity(surface);
  const touch=new TouchInput('focus'); transport.sendInput(surface,touch.sample(identity,'start',point(0),0)!);
  channel.onmessage({data:JSON.stringify({type:'focus',ok:true,focusRequestId:request.focusRequestId,layoutEpoch:'2',token:{view:'1',session:'s',instance:'i',document:'d',focus:'8'}})});
  assert.equal(transport.inputIdentity(surface),identity); assert.equal(sent[1].event.action,'start'); assert.equal(sent[1].focus,'8');
  transport.ensureInputFocus(surface); assert.equal(sent.length,2);
  surface.focus='9'; assert.notEqual(transport.inputIdentity(surface),identity);
  assert.equal(transport.sendInput(surface,touch.cancel()!),false);
});
test('focus backlog reserves capacity for cancellation after ordinary input budget fills',t=>{
  const {transport,surface,sent,channel}=setup(t); transport.ensureInputFocus(surface); const request=sent[0];
  const touch=new TouchInput('reserve'); transport.sendInput(surface,touch.sample(transport.inputIdentity(surface),'start',point(0),0)!);
  for(let i=0;i<111;i++) assert.equal(transport.sendInput(surface,{type:'ime_commit',text:'x'}),true);
  assert.equal(transport.sendInput(surface,{type:'ime_commit',text:'overflow'}),false);
  assert.equal(transport.sendInput(surface,touch.cancel()!),true);
  channel.onmessage({data:JSON.stringify({type:'focus',ok:true,focusRequestId:request.focusRequestId,layoutEpoch:'2',token:{view:'1',session:'s',instance:'i',document:'d',focus:'7'}})});
  assert.equal(sent[sent.length-1].event.action,'cancel');
});
