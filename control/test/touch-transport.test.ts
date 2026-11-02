import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteTransport } from '../client/transport';
import { TouchInput } from '../client/touch-input';
import type { Surface } from '../client/types';
import { touchTerminalResult, type TouchOwner } from '../client/touch-terminal';
import type { InputResult } from '../client/transport';

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
test('destroyed target receipts retire exact old touch through production transport and allow next tap',t=>{
  const {transport,surface,sent,channel}=setup(t);
  const touch=new TouchInput('destroyed'), identity=transport.inputIdentity(surface);
  let owner: TouchOwner | undefined;
  const results: InputResult[]=[];
  transport.subscribeInputResults(result=>{
    results.push(result);
    if(owner && touchTerminalResult(owner,result,transport.inputIdentity(surface),touch.contactIds.length)) { touch.reset(); owner=undefined; }
  });
  const start=touch.sample(identity,'start',point(0),0,undefined,true)!;
  owner={surface:{...surface},identity,packet:start}; transport.sendInput(surface,start);
  const move=touch.sample(identity,'move',point(30),30)!;
  owner.packet=move; transport.sendInput(surface,move);
  const end=touch.sample(identity,'end',point(30),40)!;
  owner.packet=end; transport.sendInput(surface,end); touch.accepted(end);
  const oldOwner=owner;
  const reply=(index:number,extra:object)=>channel.onmessage({data:JSON.stringify({type:'input.result',clientSequence:sent[index].sequence,ok:false,...extra})});
  reply(1,{error:'touch owner destroyed',touchState:'terminal-invalidated',touchSequenceId:move.sequenceId});
  assert.equal(owner,undefined); assert.equal(results[0].ok,false); // retirement is not delivery success
  const next=touch.sample(identity,'start',point(10),100,undefined,true)!;
  assert.notEqual(next.sequenceId,start.sequenceId);
  owner={surface:{...surface},identity,packet:next}; transport.sendInput(surface,next);
  reply(2,{touchState:'terminal-invalidated',touchSequenceId:end.sequenceId});
  assert.equal(owner.packet,next); // late end for retired owner cannot clear new contact
  assert.equal(touchTerminalResult(oldOwner,results[0],`new-attempt:${identity}`,0),undefined);
  const nextEnd=touch.sample(identity,'end',point(10),110)!;
  owner.packet=nextEnd; transport.sendInput(surface,nextEnd); touch.accepted(nextEnd);
  const heldOwner=owner;
  assert.ok(heldOwner); // local queue admission and no ACK keep the owner unresolved
  reply(4,{error:'touch_terminal_timeout',state:'terminal-unconfirmed'});
  assert.equal(owner,heldOwner); // timeout must not pretend completion
  // The original end was rejected; a cancellation remains a separately correlated request.
  const cancel={...nextEnd,action:'cancel' as const,points:[],gestures:[]};
  owner.packet=cancel; transport.sendInput(surface,cancel);
  reply(5,{error:'No touch sequence to cancel'});
  assert.equal(owner,heldOwner); // unknown sequence cannot acquire terminal semantics
  reply(0,{touchState:'terminal-invalidated',touchSequenceId:start.sequenceId});
  assert.equal(owner,heldOwner);
  channel.onmessage({data:JSON.stringify({type:'input.result',clientSequence:sent[5].sequence,ok:true,touchState:'processed'})});
  // The rejection already consumed that receipt slot; a duplicate cannot complete it.
  assert.equal(owner,heldOwner);
  const retry={...cancel}; owner.packet=retry; transport.sendInput(surface,retry);
  channel.onmessage({data:JSON.stringify({type:'input.result',clientSequence:sent[6].sequence,ok:true,touchState:'processed'})});
  assert.equal(owner,undefined);
});

test('move end and cancel require explicit matching retirement proof and full owner identity',t=>{
  const {transport,surface,sent,channel}=setup(t), identity=transport.inputIdentity(surface);
  const touch=new TouchInput('terminal'); const start=touch.sample(identity,'start',point(0),0,undefined,true)!;
  const owner:TouchOwner={surface:{...surface},identity,packet:start};
  const results:InputResult[]=[]; transport.subscribeInputResults(result=>results.push(result));
  for(const action of ['move','end','cancel'] as const) {
    const packet={...start,action}; transport.sendInput(surface,packet);
    channel.onmessage({data:JSON.stringify({type:'input.result',clientSequence:sent[sent.length-1].sequence,ok:false,touchState:'terminal-invalidated',touchSequenceId:start.sequenceId})});
    const result=results[results.length-1];
    assert.equal(touchTerminalResult(owner,result,identity,1),'invalidated');
    assert.equal(touchTerminalResult(owner,{...result,touchSequenceId:'unknown'},identity,1),undefined);
    assert.equal(touchTerminalResult(owner,{...result,touchState:undefined},identity,1),undefined);
    for(const field of ['session','id','instance','document'] as const) assert.equal(touchTerminalResult(owner,{...result,surface:{...result.surface,[field]:'other'}},identity,1),undefined);
    assert.equal(touchTerminalResult(owner,{...result,identity:'other'},identity,1),undefined);
  }
});
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
  setReady(false); const cancel=touch.cancel()!; assert.equal(transport.sendInput(surface,cancel),true); touch.accepted(cancel); assert.equal(sent.length,1);
  setReady(true); (transport as any).drainInput(); assert.equal(sent[1].event.action,'cancel');
  const next=touch.sample(identity,'start',point(0),100)!; setReady(false);
  assert.equal(transport.sendInput(surface,next),false);
  assert.equal(transport.sendInput(surface,touch.cancel()!),true);
  transport.layout!.epoch='3'; setReady(true); (transport as any).drainInput(); assert.equal(sent.length,2);
  assert.ok(transport.touchInputStats.dropped>=1);
});
test('editing identity survives layout changes but changes on document and reconnect',t=>{
  const {transport,surface}=setup(t); const owner=transport.editingIdentity(surface);
  transport.layout!.epoch='3'; transport.layout!.generation='4'; surface.width=800; surface.focus='8';
  assert.equal(transport.editingIdentity(surface),owner);
  surface.document='next'; assert.notEqual(transport.editingIdentity(surface),owner);
  surface.document='d'; (transport as any).attempt++; assert.notEqual(transport.editingIdentity(surface),owner);
});
test('input results associate rejection with original event and immutable target snapshot',t=>{
  const {transport,surface,channel,sent}=setup(t); const results:any[]=[];
  const unsubscribe=transport.subscribeInputResults(result=>results.push(result));
  const event={type:'touch',action:'end',sequenceId:'gesture'};
  transport.sendInput(surface,event); const request=sent[0]; surface.document='next';
  channel.onmessage({data:JSON.stringify({type:'input.result',clientSequence:request.sequence,ok:false,error:'busy'})});
  assert.equal(results.length,1); assert.equal(results[0].surface.document,'d'); assert.equal(results[0].event,event); assert.equal(results[0].ok,false);
  unsubscribe(); assert.equal(transport.diagnostics.error,'busy');
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

test('client gesture capability is explicit and cumulative progress remains ordered before cancellation/new raw',t=>{
  const {transport,surface,sent,channel}=setup(t);
  assert.equal(transport.clientGestures,false);
  channel.onmessage({data:JSON.stringify({type:'input.capabilities',clientGestures:1})});
  assert.equal(transport.clientGestures,true);
  channel.bufferedAmount=300000;
  const inputIdentity=transport.inputIdentity(surface);
  const progress={type:'gesture',gestureMode:'client-v1',sequenceId:'old',inputIdentity,action:'momentum',sampleElapsedUs:100,cumulativeX:10,cumulativeY:0};
  assert.equal(transport.sendInput(surface,progress),true);
  assert.equal(transport.sendInput(surface,{...progress,sampleElapsedUs:200,cumulativeX:20}),true);
  assert.equal(transport.sendInput(surface,{...progress,action:'cancel',sampleElapsedUs:200,cumulativeX:20}),true);
  assert.equal(transport.sendInput(surface,{type:'touch',gestureMode:'client-v1',sequenceId:'new',inputIdentity,action:'start',gestures:[],points:[]}),true);
  channel.bufferedAmount=0;channel.onbufferedamountlow();
  assert.deepEqual(sent.map(p=>p.event.action),['momentum','cancel','start']);
  assert.equal(sent[0].event.cumulativeX,20);
  surface.document='new';
  assert.equal(transport.sendInput(surface,progress),false);
});

test('client candidate backlog refuses overflow without silently discarding raw moves or transitions',t=>{
  const {transport,surface,sent,channel}=setup(t); channel.bufferedAmount=300000;
  const inputIdentity=transport.inputIdentity(surface);
  for(let n=0;n<112;n++) assert.equal(transport.sendInput(surface,{type:'touch',gestureMode:'client-v1',sequenceId:'q',inputIdentity,action:'move',sampleElapsedUs:n,points:[],gestures:Array(8).fill({type:'scrollUpdate',x:0,y:0,deltaX:1,deltaY:0})}),true);
  assert.equal(transport.sendInput(surface,{type:'ime_commit',text:'overflow'}),false);
  assert.equal(transport.sendInput(surface,{type:'touch',gestureMode:'client-v1',sequenceId:'q',inputIdentity,action:'cancel',points:[],gestures:[]}),true);
  channel.bufferedAmount=0;channel.onbufferedamountlow();
  assert.equal(sent.length,113); assert.equal(sent[112].event.action,'cancel');
  assert.equal(sent.slice(0,112).reduce((sum,p)=>sum+p.event.gestures.length,0),896);
});
