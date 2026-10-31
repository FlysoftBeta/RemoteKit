import test from 'node:test';
import assert from 'node:assert/strict';
import { PresentationDiagnostics } from '../client/presentation-diagnostics';
test('presentation counters distinguish late metadata, overwritten frames and duplicate observations', () => {
  const metrics = new PresentationDiagnostics();
  metrics.video(10, 100, '1', undefined, { presentedFrames: 1, decoded: 1 }); metrics.frameMetadata(15, 100, '1'); metrics.authorize(16, 100, '1');
  metrics.video(17, 100, '1', '1', { presentedFrames: 1, decoded: 1 }); assert.equal(metrics.snapshot().epoch.pending, null);
  metrics.video(20, 101, '1', undefined, { presentedFrames: 2, decoded: 2 }); metrics.video(30, 102, '1', undefined, { presentedFrames: 3, decoded: 3 }); metrics.frameMetadata(35, 101, '1');
  const report = metrics.snapshot(true); assert.equal(report.rawRvfcCount, 4); assert.equal(report.epoch.matched, 1); assert.equal(report.epoch.missed, 1); assert.equal(report.epoch.lateMetadataForMissed, 1); assert.equal(report.epoch.pending?.rtp, 102); assert.equal(report.authorizeWaitMs.p50, 6); assert.equal(report.metadataRelativeToVideoMs.p50, 5);
});
test('client RAF is deduplicated across split panes and cost observations remain separate', () => {
  const metrics = new PresentationDiagnostics(); metrics.clientRaf(16); metrics.clientRaf(16); metrics.clientRaf(32); metrics.cost('videoSnapshot', 16, 1); metrics.cost('videoCallbackTotal', 16, 9);
  const report = metrics.snapshot(); assert.equal(report.clientRafCount, 2); assert.equal(report.viewportRafCallbacks, 3); assert.equal(report.costsMs.videoSnapshot.p50, 1); assert.equal(report.costsMs.videoCallbackTotal.p50, 9);
});
test('per-plane paint counts exclude resize redraws and retain authorization-to-paint latency', () => {
  const metrics = new PresentationDiagnostics(); metrics.paint(20, 'a', 100, '1', 15, true); metrics.paint(21, 'b', 100, '1', 15, true); metrics.paint(30, 'a', 100, '1', 15, false); metrics.paint(40, 'a', 101, '1', 36, true);
  const report = metrics.snapshot(); assert.equal(report.canvasPaintByView.a.frames, 2); assert.equal(report.canvasPaintByView.a.redraws, 1); assert.equal(report.canvasPaintByView.b.frames, 1); assert.equal(report.authorizeToPaintMs.max, 15);
});
