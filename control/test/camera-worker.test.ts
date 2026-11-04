import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

test('bitmap worker scores and encodes one immutable snapshot and releases backing stores', async () => {
  const canvases: any[] = [], draws: any[] = [], replies: any[] = [];
  const bitmap = { width:16,height:9,closed:0,close(){this.closed++;} };
  class Canvas {
    width:number; height:number;
    constructor(w:number,h:number){this.width=w;this.height=h;canvases.push(this);}
    getContext(){return {drawImage:(source:any)=>draws.push(source),getImageData:()=>({data:new Uint8Array(this.width*this.height*4).fill(100)})};}
    async convertToBlob(){assert.ok(bitmap.closed>0,'bitmap released before encoding');return new Blob(['same-snapshot']);}
  }
  const scope:any={Uint8Array,performance,OffscreenCanvas:Canvas,importScripts(){},postMessage:(message:any)=>replies.push(message)};
  vm.runInNewContext(readFileSync(new URL('../../tools/camera-score-worker.js',import.meta.url),'utf8'),scope);
  await scope.onmessage({data:{id:1,generation:2,bitmap,width:16,height:9,format:'image/jpeg'}});
  assert.equal(draws[0],bitmap);assert.equal(draws[1],canvases[0]);
  assert.equal(await replies[0].blob.text(),'same-snapshot');assert.ok(Number.isFinite(replies[0].result.score));
  assert.ok(canvases.every(c=>c.width===1&&c.height===1));assert.ok(bitmap.closed>0);
});
