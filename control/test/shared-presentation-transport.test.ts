import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {RemoteTransport} from '../client/transport';

function environment(t:TestContext){
  const values:Record<string,unknown>={document:{visibilityState:'visible',createElement:()=>({pause(){},remove(){}}),addEventListener(){},removeEventListener(){}},navigator:{userAgent:'Chrome/157'},requestAnimationFrame:()=>1,cancelAnimationFrame(){}};
  for(const [name,value]of Object.entries(values)){const old=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{configurable:true,value});t.after(()=>old?Object.defineProperty(globalThis,name,old):Reflect.deleteProperty(globalThis,name));}
  const transport=new RemoteTransport(),internal=transport as any;
  internal.layout={type:'layout',epoch:'e',generation:'g',width:640,height:360,views:[]};internal.frameGate={ready:true,rtpTimestamp:7};internal.displayedRtp=7;internal.displayedEpoch='e';
  return {transport,internal};
}

test('static shared fallback redraws retained immutable source immediately, retires shared input/readback identity',t=>{
  const {internal:i}=environment(t),image={immutable:true},draws:unknown[]=[];
  i.activeFrameSource='track-processor';i.latestProcessorFrame={frame:image};i.paintedPlanes.set('a',{shared:true});
  i.paintAuthorizedPlanes=(source:unknown,kind:string)=>draws.push({source,kind});i.requestPresentationRefresh=()=>assert.fail('A retained valid source does not need a refresh');
  i.sharedFallback();assert.deepEqual(draws,[{source:image,kind:'plane-frame'}]);assert.equal(i.paintedPlanes.size,0);
});

test('fallback without a retained source requests current-peer media refresh once per bounded interval, never paints stale epoch',t=>{
  const {internal:i}=environment(t),sent:string[]=[];i.activeFrameSource='track-processor';i.peer={};i.channel={readyState:'open',send:(message:string)=>sent.push(message)};
  i.paintAuthorizedPlanes=()=>assert.fail('No immutable source can be painted');
  i.sharedFallback();i.sharedFallback();assert.deepEqual(sent,[JSON.stringify({type:'media.refresh'})]);
  i.mediaRefreshAt=-Infinity;i.peer=null;i.sharedFallback();assert.equal(sent.length,1,'A retired peer must not send to its old channel');
  i.peer={};i.latestProcessorFrame={frame:{}};i.displayedEpoch='stale';i.sharedFallback();assert.equal(sent.length,2,'A stale frame asks the current peer for a real new frame');
});
