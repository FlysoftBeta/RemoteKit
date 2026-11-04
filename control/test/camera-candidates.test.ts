import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { CameraCandidatePool, cameraBudget } from './fixtures/camera-candidates';

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../../tools/camera-score-worker.js', import.meta.url), 'utf8'), context);
const score = (pixels: Uint8Array, width=160, height=90) => context.RemoteKitCameraScore(pixels,width,height);
test('fixed scene scorer penalizes blur, isolated noise and low light', () => {
  const w=160,h=90, sharp = Uint8Array.from({length:w*h}, (_,i) => ((Math.floor(i/w)/9|0)+(i%w/9|0))%2 ? 190 : 65);
  const blurred = sharp.map((_,i) => { const x=i%w,y=i/w|0; let total=0,count=0; for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++){total+=sharp[Math.max(0,Math.min(h-1,y+dy))*w+Math.max(0,Math.min(w-1,x+dx))];count++;}return total/count; });
  let seed=1234; const noisy=sharp.map(value => { seed=(seed*1664525+1013904223)>>>0;return Math.max(0,Math.min(255,value+(seed%101)-50)); });
  const dark=sharp.map(value=>value*.12);
  const results={ sharp:score(sharp), blur:score(blurred), noise:score(noisy), lowlight:score(dark) };
  assert.ok(results.sharp.score>results.blur.score); assert.ok(results.sharp.score>results.noise.score); assert.ok(results.sharp.score>results.lowlight.score);
});
test('candidate ownership is bounded, temporally deduplicated, and cancellable', () => {
  const pool=new CameraCandidatePool();
  for(let i=0;i<20;i++)pool.offer({id:i,at:i*100,score:i,width:1280,height:720,blob:new Blob(['photo'])});
  assert.equal(pool.candidates.length,3); assert.equal(pool.candidates[0].id,19);
  pool.offer({id:21,at:1905,score:100,width:1280,height:720,blob:new Blob()});
  assert.equal(pool.candidates.length,3); assert.ok(!pool.candidates.some(c=>c.id===19));
  pool.offer({id:30,at:2200,score:1000,width:cameraBudget.maxFramePixels+1,height:1,blob:new Blob()});
  assert.ok(!pool.candidates.some(c=>c.id===30)); pool.clear(); assert.equal(pool.candidates.length,0);
});
