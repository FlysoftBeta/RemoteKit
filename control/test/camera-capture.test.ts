import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraCapture } from '../client/camera-capture';

test('cancelled snapshot cannot terminate a newer Worker or retain full canvases', async()=>{
  const oldDocument=globalThis.document,oldWorker=globalThis.Worker;
  const workers:any[]=[],canvases:any[]=[];
  class Worker {
    terminated=false;onmessage:any;onerror:any;
    constructor(){workers.push(this);}terminate(){this.terminated=true;}postMessage(){}
  }
  class Canvas {
    width=0;height=0;
    constructor(){canvases.push(this);}
    getContext(){return {drawImage(){},getImageData:()=>({data:new Uint8Array(this.width*this.height*4).fill(128)})};}
    toBlob(callback:(blob:Blob)=>void,type:string){callback(new Blob(['immutable-snapshot'],{type}));}
  }
  Object.assign(globalThis,{document:{createElement:()=>new Canvas()},Worker});
  try{
    const capture=new CameraCapture(),video={videoWidth:16,videoHeight:9} as HTMLVideoElement;
    const first=assert.rejects(capture.capture(video,'image/jpeg'),/取消/);
    assert.equal(workers.length,1);capture.cancel();assert.ok(canvases.every(canvas=>canvas.width===1&&canvas.height===1));
    const second=assert.rejects(capture.capture(video,'image/jpeg'),/取消/);
    assert.equal(workers.length,2);assert.ok(workers[0].terminated);assert.ok(!workers[1].terminated);
    await first;assert.ok(!workers[1].terminated,'retired capture finalizer must not touch new worker');
    capture.cancel();await second;assert.ok(workers[1].terminated);
    assert.ok(canvases.every(canvas=>canvas.width===1&&canvas.height===1));assert.equal(capture.pool.candidates.length,0);
  }finally{Object.assign(globalThis,{document:oldDocument,Worker:oldWorker});}
});

test('late immutable bitmap is closed after cancellation without posting it', async () => {
  const originals = { document: globalThis.document, Worker: globalThis.Worker, createImageBitmap: globalThis.createImageBitmap, OffscreenCanvas: globalThis.OffscreenCanvas };
  let finish!: (bitmap: ImageBitmap) => void, closed = 0, posted = 0;
  class Worker {
    onmessage: any; onerror: any;
    terminate() {}
    postMessage(message: any) { posted++; queueMicrotask(() => this.onmessage({data:{generation:message.generation,supported:true}})); }
  }
  const canvas = () => ({width:0,height:0,getContext(){throw new Error('bitmap path must not access main-thread canvas');}});
  Object.assign(globalThis, { document: {createElement:canvas}, Worker, OffscreenCanvas: class {}, createImageBitmap: () => new Promise(resolve => {finish=resolve;}) });
  try {
    const capture = new CameraCapture();
    const result = assert.rejects(capture.capture({videoWidth:1280,videoHeight:720} as HTMLVideoElement,'image/jpeg'), /取消/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(posted,1,'only capability probe before bitmap resolves');
    capture.cancel(); finish({close(){closed++;}} as ImageBitmap); await result;
    assert.equal(closed,1); assert.equal(posted,1); assert.equal(capture.pool.candidates.length,0);
  } finally { Object.assign(globalThis,originals); }
});

test('bitmap burst transfers one snapshot per candidate and retains bounded top three', async () => {
  const originals = { document: globalThis.document, Worker: globalThis.Worker, createImageBitmap: globalThis.createImageBitmap, OffscreenCanvas: globalThis.OffscreenCanvas };
  let serial=0,terminated=0;
  const transferred:any[]=[];
  class Worker {
    onmessage:any;onerror:any;
    terminate(){terminated++;}
    postMessage(message:any,transfers:any[]) {
      if(message.probe) return queueMicrotask(()=>this.onmessage({data:{generation:message.generation,supported:true}}));
      assert.equal(transfers[0],message.bitmap);transferred.push(message.bitmap);
      queueMicrotask(()=>this.onmessage({data:{generation:message.generation,result:{score:message.bitmap.serial},blob:new Blob([String(message.bitmap.serial)]),elapsedMs:1,drawMs:2,blobWallMs:3}}));
    }
  }
  Object.assign(globalThis,{document:{createElement:()=>({width:0,height:0,getContext(){throw new Error('main canvas accessed');}})},Worker,OffscreenCanvas:class {},createImageBitmap:async (_video:any,options:any)=>({serial:++serial,width:options.resizeWidth,height:options.resizeHeight,close(){}})});
  try {
    const capture=new CameraCapture();
    const candidates=await capture.capture({videoWidth:1280,videoHeight:720} as HTMLVideoElement,'image/jpeg');
    assert.equal(capture.metrics.path,'bitmap-worker');assert.ok(serial>2&&serial<=6);assert.equal(transferred.length,serial);
    assert.equal(candidates.length,3);
    for(const candidate of candidates) assert.equal(await candidate.blob.text(),String(candidate.score));
    assert.ok(capture.metrics.peakPixels<=20*1024*1024);assert.equal(terminated,1);
  } finally {Object.assign(globalThis,originals);}
});
