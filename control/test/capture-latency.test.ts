import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureLatency } from '../client/capture-latency';
import { ClockDomain } from '../client/clock-domain';
const controlClock = () => { const c = new ClockDomain(); c.calibrate(0,900,10,910,1005); return c; };
const frame = (id: string) => ({ captureWallTimeMs: 1000, captureMonotonicMs: 500, captureClockUncertaintyMs: 1, sourceCaptureId: id });
const setup = () => { const v = new CaptureLatency(); v.calibrate(0,900,10,910,1005); return v; };
test('exact epoch pairing, bounded clock and idle dedup', () => { const v=setup(); v.record(1,'a',frame('1')); v.paint(1,'b',100,1000); v.paint(1,'a',100,1000); v.record(2,'a',frame('1')); v.paint(2,'a',200,1100); const r=v.report(2100,3000, true, controlClock())!; assert.equal(r.sampleCount,1); assert.equal(r.presentationLatencyMs,100); assert.equal(r.clockUncertaintyMs,7); });
test('hidden, expired, reset, uncertain and wall jump observations never trigger policy', () => { for(const mode of ['hidden','expired','reset','uncertain','jump']) { const v=setup(); v.record(1,'a',{...frame('1'),captureClockUncertaintyMs: mode==='uncertain'?26:1}); v.paint(1,'a',100,mode==='jump'?1200:1000); if(mode==='reset')v.reset(); assert.equal(v.report(mode==='expired'?16000:2100,mode==='expired'?16900:3000, mode!=='hidden', controlClock()),undefined); }});
test('source clock discontinuity discards prior window', () => { const v=setup();v.record(1,'a',frame('1'));v.paint(1,'a',100,1000);v.record(2,'a',{...frame('2'),captureMonotonicMs:900});v.paint(2,'a',200,1100);assert.equal(v.report(2200,3100, true, controlClock()),undefined); });

import { QualityController } from '../server/quality';
test('clock resets preserve channel sequence and the next healthy window is immediately accepted', () => {
  for (const mode of ['explicit', 'client-wall', 'offset', 'source-clock']) {
    const v = setup(), quality = new QualityController();
    v.record(1, 'a', frame('1')); v.paint(1, 'a', 100, 1000);
    const first = v.report(2100, 3000, true, controlClock())!;
    assert.equal(quality.observe(first, first.sampledAtServerMs, true, 2100), true);
    if (mode === 'explicit') v.reset();
    if (mode === 'client-wall') { v.record(2, 'a', frame('2')); v.paint(2, 'a', 3000, 4900); }
    if (mode === 'offset') v.calibrate(3000, 3900, 3010, 3910, 5005);
    if (mode === 'source-clock') { v.record(2, 'a', { ...frame('2'), captureWallTimeMs: 3900, captureMonotonicMs: 600 }); v.paint(2, 'a', 3000, 3900); }
    assert.equal(v.report(5000, 5900, true, controlClock()), undefined);
    v.calibrate(5000, 5900, 5010, 5910, 6005);
    v.record(3, 'a', { ...frame('3'), captureWallTimeMs: 6100, captureMonotonicMs: 5600 });
    v.paint(3, 'a', 5200, 6100);
    const next = v.report(7200, 8100, true, controlClock())!;
    assert.equal(next.sequence, first.sequence + 1, mode);
    assert.equal(quality.observe(next, next.sampledAtServerMs, true, 7200), true, mode);
  }
});
test('measurement reset retains source deduplication across clock recalibration', () => {
  const v = setup(); v.record(1, 'a', frame('1')); v.paint(1, 'a', 100, 1000); v.report(2100, 3000, true, controlClock());
  v.reset(); v.calibrate(3000,3900,3010,3910,4005);
  v.record(2, 'a', frame('1')); v.paint(2, 'a', 3200,4100);
  assert.equal(v.report(5200,6100, true, controlClock()), undefined);
});
