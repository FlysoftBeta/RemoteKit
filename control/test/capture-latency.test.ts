import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureLatency } from '../client/capture-latency';
const frame = (id: string) => ({ captureWallTimeMs: 1000, captureMonotonicMs: 500, captureClockUncertaintyMs: 1, sourceCaptureId: id });
const setup = () => { const v = new CaptureLatency(); v.calibrate(0,900,10,910,1005); return v; };
test('exact epoch pairing, bounded clock and idle dedup', () => { const v=setup(); v.record(1,'a',frame('1')); v.paint(1,'b',100,1000); v.paint(1,'a',100,1000); v.record(2,'a',frame('1')); v.paint(2,'a',200,1100); const r=v.report(2100,3000,true)!; assert.equal(r.sampleCount,1); assert.equal(r.presentationLatencyMs,100); assert.equal(r.clockUncertaintyMs,7); });
test('hidden, expired, reset, uncertain and wall jump observations never trigger policy', () => { for(const mode of ['hidden','expired','reset','uncertain','jump']) { const v=setup(); v.record(1,'a',{...frame('1'),captureClockUncertaintyMs: mode==='uncertain'?26:1}); v.paint(1,'a',100,mode==='jump'?1200:1000); if(mode==='reset')v.reset(); assert.equal(v.report(mode==='expired'?16000:2100,mode==='expired'?16900:3000,mode!=='hidden'),undefined); }});
test('source clock discontinuity discards prior window', () => { const v=setup();v.record(1,'a',frame('1'));v.paint(1,'a',100,1000);v.record(2,'a',{...frame('2'),captureMonotonicMs:900});v.paint(2,'a',200,1100);assert.equal(v.report(2200,3100,true),undefined); });
