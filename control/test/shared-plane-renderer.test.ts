import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {SharedPlaneRenderer,sharedPlaneGeometry,type SharedFrame,type SharedPlaneTarget} from '../client/shared-plane-renderer';

test('shared geometry retains exact marker ROI pixels and transparent gap, bounded before allocation',()=>{
  const planes=[{id:'a',source:{x:4,y:4,width:640,height:360},client:{left:10,top:88,width:320,height:180}},{id:'b',source:{x:648,y:4,width:640,height:360},client:{left:335,top:88,width:320,height:180}}];
  const geometry=sharedPlaneGeometry(planes)!;
  assert.equal(geometry.density,2);assert.equal(geometry.pixelWidth,1290);assert.equal(geometry.pixelHeight,360);
  assert.deepEqual(geometry.placements[1].output,{x:650,y:0,width:640,height:360});
  assert.equal(sharedPlaneGeometry(planes,1024),undefined);assert.equal(sharedPlaneGeometry(planes,8192,100),undefined);
  assert.equal(sharedPlaneGeometry([{...planes[0],client:{...planes[0].client,width:0}},planes[1]]),undefined);
});

function fixture(t:TestContext){
  const listeners=new Map<string,()=>void>(),rafs:(()=>void)[]=[],observers:(()=>void)[]=[],canvases:any[]=[];let error=0,uploads=0;
  const gl:any={NO_ERROR:0,VERTEX_SHADER:1,FRAGMENT_SHADER:2,COMPILE_STATUS:3,LINK_STATUS:4,ARRAY_BUFFER:5,FLOAT:6,TEXTURE_2D:7,TEXTURE_MIN_FILTER:8,TEXTURE_MAG_FILTER:9,LINEAR:10,TEXTURE_WRAP_S:11,TEXTURE_WRAP_T:12,CLAMP_TO_EDGE:13,MAX_TEXTURE_SIZE:14,MAX_RENDERBUFFER_SIZE:15,RGBA:16,UNSIGNED_BYTE:17,SCISSOR_TEST:18,COLOR_BUFFER_BIT:19,DYNAMIC_DRAW:20,TRIANGLES:21,
    createShader:()=>({}),getShaderParameter:()=>true,createProgram:()=>({}),getProgramParameter:()=>true,createBuffer:()=>({}),createTexture:()=>({}),getAttribLocation:()=>1,getParameter:()=>8192,getError:()=>{const value=error;error=0;return value},getExtension:()=>null,texImage2D:()=>uploads++};
  for(const name of ['shaderSource','compileShader','deleteShader','attachShader','linkProgram','useProgram','bindBuffer','enableVertexAttribArray','vertexAttribPointer','bindTexture','texParameteri','clearColor','disable','clear','enable','bufferData','viewport','scissor','drawArrays','deleteTexture','deleteBuffer','deleteProgram'])gl[name]=()=>{};
  const makeCanvas=()=>{const events=new Map<string,(e:any)=>void>(),rect={left:0,top:88,width:320,height:180};const canvas:any={style:{opacity:''},width:0,height:0,isConnected:true,setAttribute(){},getContext:()=>gl,addEventListener:(name:string,fn:(e:any)=>void)=>events.set(name,fn),remove(){this.isConnected=false},getBoundingClientRect:()=>rect,events,rect};canvases.push(canvas);return canvas};
  const environment:Record<string,unknown>={window:{addEventListener:(name:string,fn:()=>void)=>listeners.set(name,fn),removeEventListener(){}},document:{visibilityState:'visible',body:{append:(canvas:any)=>canvas.isConnected=true},createElement:makeCanvas,addEventListener(){},removeEventListener(){}},requestAnimationFrame:(fn:()=>void)=>{rafs.push(fn);return rafs.length},cancelAnimationFrame(){},ResizeObserver:class{constructor(callback:()=>void){observers.push(callback)}observe(){}unobserve(){}disconnect(){}}};
  for(const [name,value]of Object.entries(environment)){const old=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{configurable:true,value});t.after(()=>old?Object.defineProperty(globalThis,name,old):Reflect.deleteProperty(globalThis,name));}
  const targets=[0,1].map(i=>{const canvas=makeCanvas();canvas.rect.left=i*325;return {canvas,view:{id:String(i+1),session:'1',instance:'1',document:'1',focus:'1',x:4+i*324,y:4,width:320,height:180,deviceScaleFactor:1},layoutEpoch:'e',layoutGeneration:'g'};}) as SharedPlaneTarget[];
  const frame:SharedFrame={rtpTimestamp:10,layout:{type:'layout',epoch:'e',generation:'g',width:656,height:188,views:targets.map(x=>x.view)}};
  return {targets,frame,canvases,listeners,rafs,observers,get uploads(){return uploads},failUpload(){error=1282}};
}

test('shared upload succeeds once, supplies actual visible ROI, and static resize redraw does not upload/new-frame count',t=>{
  const f=fixture(t),redraws:any[]=[];const renderer=new SharedPlaneRenderer({isCurrent:()=>true,onFailure:()=>assert.fail('unexpected failure'),onRedraw:r=>redraws.push(r)});
  const draw=renderer.render({} as CanvasImageSource,f.frame,f.targets)!;assert.equal(f.uploads,1);assert.equal(renderer.isVisible(draw.canvas),true);
  assert.deepEqual(draw.regions.get('2'),{x:325,y:0,width:320,height:180});assert.equal(f.targets[0].canvas.style.opacity,'0');
  (f.targets[1].canvas as any).rect.left=340;f.listeners.get('resize')!();f.rafs.shift()!();
  assert.equal(redraws.length,1);assert.equal(redraws[0].uploaded,false);assert.equal(redraws[0].frame.rtpTimestamp,10);assert.equal(f.uploads,1);assert.equal(renderer.counts.frames,1);assert.equal(renderer.counts.redraws,1);
  renderer.dispose();assert.equal(f.targets[0].canvas.style.opacity,'');assert.equal(renderer.isVisible(draw.canvas),false);
});

test('context loss restores input plane canvases before synchronous fallback callback, retires shared ROI',t=>{
  const f=fixture(t);let failures=0;const renderer=new SharedPlaneRenderer({isCurrent:()=>true,onRedraw(){},onFailure:reason=>{failures++;assert.equal(reason,'context-lost');assert.equal(f.targets[0].canvas.style.opacity,'');}});
  const draw=renderer.render({} as CanvasImageSource,f.frame,f.targets)!;(draw.canvas as any).events.get('webglcontextlost')({preventDefault(){}});
  assert.equal(failures,1);assert.equal(renderer.backend,'canvas-2d');assert.equal(renderer.isVisible(draw.canvas),false);assert.equal(renderer.render({} as CanvasImageSource,f.frame,f.targets),undefined);renderer.dispose();
});

test('static invalid geometry retires visible backing before fallback and later valid bounds can resume',t=>{
  for(const invalid of ['zero','budget','disconnected']) {
    const f=fixture(t);let fallback=0,resume=0;
    const renderer=new SharedPlaneRenderer({isCurrent:()=>true,onRedraw:()=>assert.fail('invalid geometry cannot redraw'),
      onFailure:reason=>{fallback++;assert.equal(reason,'geometry-budget-or-hidden');assert.equal(renderer.isVisible(draw.canvas),false);assert.equal(f.targets[0].canvas.style.opacity,'');},
      onResume:()=>{resume++;renderer.render({} as CanvasImageSource,f.frame,f.targets);}});
    const draw=renderer.render({} as CanvasImageSource,f.frame,f.targets)!;
    const target=f.targets[1].canvas as any;
    if(invalid==='zero')target.rect.width=0;else if(invalid==='budget')target.rect.left=9000;else target.isConnected=false;
    f.listeners.get('resize')!();f.rafs.shift()!();
    assert.equal(fallback,1);assert.equal(renderer.isVisible(draw.canvas),false);assert.equal(draw.canvas.isConnected,false);
    assert.equal(renderer.counts.frames,1);assert.equal(renderer.counts.redraws,0);
    target.rect.width=320;target.rect.left=325;target.isConnected=true;
    f.observers[f.observers.length-1]();f.rafs.shift()!();assert.equal(resume,1);assert.equal(renderer.backend,'shared-webgl');
    renderer.dispose();
  }
});

test('upload error never hides 2D plane or reports a shared paint, stale generation cannot redraw retained texture',t=>{
  const f=fixture(t);let current=true,redraws=0;const renderer=new SharedPlaneRenderer({isCurrent:()=>current,onRedraw:()=>redraws++,onFailure(){}});
  f.failUpload();assert.equal(renderer.render({} as CanvasImageSource,f.frame,f.targets),undefined);assert.equal(renderer.counts.frames,0);assert.equal(f.targets[0].canvas.style.opacity,'');assert.equal(renderer.counts.fallbackReason,'texture-upload');renderer.dispose();
  const other=new SharedPlaneRenderer({isCurrent:()=>current,onRedraw:()=>redraws++,onFailure(){}});other.render({} as CanvasImageSource,f.frame,f.targets);current=false;f.listeners.get('resize')!();f.rafs.shift()!();assert.equal(redraws,0);assert.equal(other.backend,'canvas-2d');assert.equal(f.targets[0].canvas.style.opacity,'');other.dispose();
});
