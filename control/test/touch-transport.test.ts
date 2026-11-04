import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteTransport } from '../client/transport';
import { TouchInput } from '../client/touch-input';
import type { Surface } from '../client/types';
import { touchTerminalResult, type TouchOwner } from '../client/touch-terminal';
import type { InputDelivery, InputResult } from '../client/transport';

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
  t.after(()=>{
    clearTimeout((transport as any).inputDrainTimer);
    clearTimeout((transport as any).focusTimer);
    (transport as any).clearTerminalInput();
  });
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
  owner.packet=nextEnd; transport.sendInput(surface,nextEnd,{touchTerminal:true}); touch.accepted(nextEnd);
  const heldOwner=owner;
  assert.ok(heldOwner); // local queue admission and no ACK keep the owner unresolved
  reply(4,{error:'touch_terminal_timeout',touchState:'terminal-unconfirmed',touchSequenceId:nextEnd.sequenceId});
  assert.equal(owner,heldOwner); // timeout must not pretend completion
  reply(0,{touchState:'terminal-invalidated',touchSequenceId:start.sequenceId});
  assert.equal(owner,heldOwner);
  channel.onmessage({data:JSON.stringify({type:'input.result',clientSequence:sent[4].sequence,ok:true})});
  assert.equal(owner,heldOwner);
  channel.onmessage({data:JSON.stringify({type:'input.result',clientSequence:sent[4].sequence,ok:true,touchState:'processed',touchSequenceId:nextEnd.sequenceId})});
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

test('terminal timeout starts on submission, survives ordinary receipt churn, and queries the original request',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {transport,surface,sent,channel}=setup(t);
  const deliveries: InputDelivery[]=[];
  const results: InputResult[]=[];
  transport.subscribeInputDelivery(delivery=>deliveries.push(delivery));
  transport.subscribeInputResults(result=>results.push(result));
  const end={type:'touch',gestureMode:'client-v1',action:'end',sequenceId:'terminal'};
  channel.bufferedAmount=300000;
  assert.equal(transport.sendInput(surface,end,{touchTerminal:true}),true);
  t.mock.timers.tick(5000);
  await Promise.resolve();
  assert.deepEqual(deliveries.map(item=>item.phase),['queued']);
  assert.equal(sent.length,0);
  channel.bufferedAmount=0; channel.onbufferedamountlow();
  const original=sent[0].sequence;
  const reply=(touchState:string,touchSequenceId:string,ok=true)=>channel.onmessage({data:JSON.stringify({type:'input.result',clientSequence:original,ok,touchState,touchSequenceId})});
  reply('accepted-pending','terminal');
  reply('accepted-pending','terminal');
  for(let i=0;i<260;i++) assert.equal(transport.sendInput(surface,{type:'ime_commit',text:'x'}),true);
  reply('processed','old');
  assert.deepEqual(results.map(item=>item.touchState),['accepted-pending']);
  t.mock.timers.tick(250);
  assert.deepEqual(sent[sent.length-1],{type:'input.touchStatus',clientSequence:original,sequenceId:'terminal'});
  reply('terminal-unconfirmed','terminal',false);
  for(const delay of [500,1000,2000,1000]) t.mock.timers.tick(delay);
  await Promise.resolve();
  assert.deepEqual(deliveries.map(item=>item.phase),['queued','submitted','unconfirmed']);
  assert.equal(transport.retryTouchTerminal(transport.inputIdentity(surface),'terminal'),true);
  t.mock.timers.tick(250);
  assert.deepEqual(sent[sent.length-1],{type:'input.touchStatus',clientSequence:original,sequenceId:'terminal'});
  assert.equal(sent.filter(item=>item.type==='input' && item.event?.sequenceId==='terminal').length,1);
  reply('processed','terminal');
  assert.deepEqual(results.map(item=>item.touchState),['accepted-pending','terminal-unconfirmed','processed']);
  assert.equal(results[results.length-1]?.event,end);
  assert.equal(transport.retryTouchTerminal(transport.inputIdentity(surface),'terminal'),false);
});

test('ordinary partial release succeeds without a status query or releasing the other contact',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {transport,surface,sent,channel}=setup(t);
  const identity=transport.inputIdentity(surface);
  const touch=new TouchInput('partial');
  touch.sample(identity,'start',point(0),0,undefined,true);
  touch.sample(identity,'start',{...point(0),id:2},1);
  const end=touch.sample(identity,'end',point(0),2)!;
  const results: InputResult[]=[];
  transport.subscribeInputResults(result=>results.push(result));
  transport.sendInput(surface,end,{touchTerminal:false});
  channel.onmessage({data:JSON.stringify({type:'input.result',clientSequence:sent[0].sequence,ok:true})});
  t.mock.timers.tick(5000);
  assert.equal(sent.length,1);
  assert.equal(results.length,1);
  assert.equal(touchTerminalResult({identity,surface,packet:end},results[0],identity,1),undefined);
});

test('focus timeout and rejected focus explicitly discard queued events with original identity',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {transport,surface,sent,channel}=setup(t);
  const deliveries: InputDelivery[]=[];
  transport.subscribeInputDelivery(delivery=>deliveries.push(delivery));
  for(const reject of [false,true]) {
    transport.ensureInputFocus(surface);
    const request=sent[sent.length-1], identity=transport.inputIdentity(surface);
    const end={type:'touch',gestureMode:'client-v1',action:'end',inputIdentity:identity,sequenceId:'focus'};
    assert.equal(transport.sendInput(surface,end,{touchTerminal:true}),true);
    if(reject) channel.onmessage({data:JSON.stringify({type:'focus',focusRequestId:request.focusRequestId,layoutEpoch:'2',ok:false})});
    else t.mock.timers.tick(2000);
    await Promise.resolve();
    assert.notEqual(transport.inputIdentity(surface),identity);
    assert.deepEqual(deliveries.splice(0).map(item=>[item.phase,item.identity,item.event,item.reason]),[
      ['queued',identity,end,undefined],['discarded',identity,end,reject?'focus-rejected':'focus-timeout']
    ]);
  }
  assert.deepEqual(sent.map(item=>item.type),['focus','focus']);
});

test('unresolved terminal storage reserves end and cancel capacity and leaves keyboard available',t=>{
  const {transport,surface,sent}=setup(t);
  const end=(index:number)=>({type:'touch',gestureMode:'client-v1',action:'end',sequenceId:String(index)});
  for(let i=0;i<48;i++) assert.equal(transport.sendInput(surface,end(i)),true);
  assert.equal(transport.sendInput(surface,{...end(100),action:'start'}),false);
  for(let i=48;i<56;i++) assert.equal(transport.sendInput(surface,end(i)),true);
  assert.equal(transport.sendInput(surface,end(56)),false);
  for(let i=56;i<64;i++) assert.equal(transport.sendInput(surface,{...end(i),action:'cancel'}),true);
  assert.equal(transport.sendInput(surface,{...end(64),action:'cancel'}),false);
  assert.equal(transport.sendInput(surface,{type:'ime_commit',text:'x'}),true);
  assert.equal(sent.length,65);
});

test('a local channel send failure reports discarded touch packets and drops dependent queued input',async t=>{
  const {transport,surface,sent,channel}=setup(t);
  const deliveries: InputDelivery[]=[];
  transport.subscribeInputDelivery(delivery=>deliveries.push(delivery));
  const start={type:'touch',gestureMode:'client-v1',action:'start',sequenceId:'failed'};
  const end={...start,action:'end'};
  channel.bufferedAmount=300000;
  assert.equal(transport.sendInput(surface,start),true);
  assert.equal(transport.sendInput(surface,end,{touchTerminal:true}),true);
  assert.equal(transport.sendInput(surface,{type:'ime_commit',text:'still queued'}),true);
  const send=channel.send;
  channel.send=()=>{throw new Error('send failed');};
  channel.bufferedAmount=0;
  channel.onbufferedamountlow();
  channel.send=send;
  channel.onbufferedamountlow();
  await Promise.resolve();
  assert.deepEqual(deliveries.map(item=>[item.phase,item.event,item.reason]),[
    ['queued',start,undefined],['queued',end,undefined],
    ['discarded',start,'channel-send-failed'],['discarded',end,'touch-send-failed'],
  ]);
  assert.deepEqual(sent.map(item=>item.event.type),['ime_commit']);
  assert.equal(transport.retryTouchTerminal(transport.inputIdentity(surface),'failed'),false);
});
