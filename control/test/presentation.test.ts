import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteTransport } from '../client/transport';
import type { CanvasPresentation, Layout, Surface } from '../client/types';

class Canvas {
  width = 0; height = 0; isConnected = true;
  draws: unknown[][] = [];
  getContext() { return { drawImage: (...args: unknown[]) => this.draws.push(args) }; }
}
function setup(mode: 'snapshot' | 'single-plane-direct' = 'snapshot') {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let callback: (at: number, metadata: object) => void = () => {};
  const video = { videoWidth: 648, videoHeight: 488, requestVideoFrameCallback: (cb: typeof callback) => { callback = cb; return 1; }, pause() {}, cancelVideoFrameCallback() {} };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => tag === 'video' ? video : new Canvas() } });
  let t: RemoteTransport;
  try { t = new RemoteTransport(); } finally { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); }
  t.presentationMode = mode;
  const peer = { close() {} }, sent: unknown[] = [], channel: any = { readyState: 'open', bufferedAmount: 0, send: (value: string) => sent.push(JSON.parse(value)) };
  (t as any).peer = peer; (t as any).bindChannel(channel); (t as any).startFramePump(peer);
  const view: Surface = { id: '1', session: 's', instance: 'i', document: 'd', focus: '0', x: 4, y: 4, width: 640, height: 480, deviceScaleFactor: 2, mediaScale: 1 };
  const layout: Layout = { type: 'layout', generation: '1', epoch: '1', width: 648, height: 488, views: [view] };
  const message = (value: object) => channel.onmessage({ data: JSON.stringify(value) });
  message(layout);
  const paints: CanvasPresentation[] = []; t.subscribePresentedFrames(frame => paints.push(frame));
  const register = (node = new Canvas(), v = view, epoch = t.layout!.epoch) => ({ node, remove: t.registerPlane({ view: v, layoutEpoch: epoch, layoutGeneration: t.layout!.generation }, node as any, () => {}) });
  const metadata = (rtp: number, epoch = t.layout!.epoch) => message({ type: 'frame', rtpTimestamp: rtp, layoutEpoch: epoch });
  const frame = (rtp: number) => callback(performance.now(), { rtpTimestamp: rtp, presentedFrames: rtp });
  return { t, video, view, layout, message, register, metadata, frame, paints, sent };
}

test('snapshot source keeps atlas crop and encoded dimensions without applying DPR twice', () => {
  const { t, view, register, metadata, frame, paints } = setup(); const { node } = register(); metadata(10); frame(10);
  const source = t.getPresentedPlane(view.id, 10)!;
  assert.equal(source.kind, 'atlas'); assert.deepEqual(source.sourceRect, { x: 4, y: 4, width: 640, height: 480 });
  assert.equal(source.encodedWidth, 640); assert.equal(source.pixelsPerDip, 2); assert.equal(node.width, 640);
  assert.equal(node.draws.length, 1); assert.equal(paints.length, 1); assert.equal(t.presentationDiagnostics.presentationRouting.directFrames, 0);
});

test('direct path follows an initial snapshot and exposes a plane rather than a stale atlas', () => {
  const { t, video, view, register, metadata, frame } = setup('single-plane-direct'); const { node } = register();
  metadata(10); frame(10); metadata(11); frame(11);
  assert.equal(node.draws[node.draws.length - 1][0], video); assert.equal(t.displayFrame, undefined); assert.equal(t.getPaintedFrame(view.id, 11), undefined);
  const source = t.getPresentedPlane(view.id, 11)!;
  assert.equal(source.image, node); assert.equal(source.kind, 'plane'); assert.deepEqual(source.sourceRect, { x: 0, y: 0, width: 640, height: 480 });
  assert.equal(t.getPresentedPlane(view.id, 10), undefined);
  assert.equal(t.presentationDiagnostics.presentationRouting.directFrames, 1); assert.equal(t.presentationDiagnostics.presentationRouting.snapshotFrames, 1);
});

test('late metadata uses the captured snapshot and never reads a newer video frame', () => {
  const { t, video, view, register, metadata, frame } = setup('single-plane-direct'); const { node } = register(); metadata(10); frame(10);
  const before = t.presentationDiagnostics.presentationRouting;
  frame(11); const draws = node.draws.length; assert.equal(t.getPresentedPlane(view.id, 10), undefined);
  metadata(11); assert.equal(node.draws.length, draws + 1); assert.notEqual(node.draws[node.draws.length - 1][0], video);
  assert.equal(t.getPresentedPlane(view.id, 11)!.kind, 'atlas');
  assert.equal(t.presentationDiagnostics.presentationRouting.fallback['metadata-unmatched'], 1);
  assert.equal(before.fallback['metadata-unmatched'], undefined, 'saved diagnostics are a value snapshot');
});

test('old geometry and epoch subscriptions cannot paint or enable input during a layout change', () => {
  const { t, view, layout, message, register, metadata, frame } = setup(); const old = register(); metadata(10); frame(10);
  const nextView = { ...view, x: 8, width: 636 }, next = { ...layout, epoch: '2', views: [nextView] };
  message(next); metadata(11, '2'); frame(11);
  assert.equal(old.node.draws.length, 1); assert.equal(t.getLastPresentation(view.id), undefined);
  assert.equal(t.sendInput(view, { type: 'ime_commit', text: 'stale' }), false);
  const current = register(new Canvas(), nextView, '2'); assert.equal(current.node.draws.length, 1); assert.ok(t.getPresentedPlane(view.id, 11));
  assert.equal(t.sendInput(view, { type: 'ime_commit', text: 'old geometry' }), false);
  assert.equal(t.presentationDiagnostics.presentationRouting.skippedRenderer['identity-epoch-geometry'], 1);
  message({ ...next, views: [{ ...nextView, x: 12, width: 630 }] }); metadata(12, '2'); frame(12);
  assert.equal(current.node.draws.length, 1, 'same-epoch geometry changes also invalidate the renderer');
  assert.equal(t.getPresentedPlane(view.id, 12), undefined);
  message({ ...next, generation: '2' }); metadata(13, '2'); frame(13);
  assert.equal(current.node.draws.length, 1, 'resource generation changes require a matching registration');
});

test('same-epoch static remount copies the retained plane without inventing a new frame or timestamp', () => {
  const { t, view, register, metadata, frame, paints } = setup('single-plane-direct'); const old = register(); metadata(10); frame(10); metadata(11); frame(11);
  const original = t.getLastPresentation(view.id); old.remove();
  const sameNode = register(old.node); assert.equal(t.presentationDiagnostics.presentationRouting.retainedPlaneRedraws, 0, 'same DOM node reuse needs no bitmap copy'); sameNode.remove(); old.node.isConnected = false;
  assert.equal(t.getPresentedPlane(view.id, 11), undefined);
  const remount = register(); assert.equal(remount.node.draws[0][0], old.node); assert.equal(t.getLastPresentation(view.id), original); assert.equal(paints.length, 2);
  assert.equal(t.presentationDiagnostics.presentationRouting.retainedPlaneRedraws, 1);
});

test('multiple planes and duplicate renderers retain the snapshot path; peer close drops cached planes', () => {
  const { t, view, layout, message, register, metadata, frame } = setup('single-plane-direct'); register(); metadata(10); frame(10);
  const duplicate = register(); metadata(11); frame(11); assert.equal(t.getPresentedPlane(view.id, 11)!.kind, 'atlas'); duplicate.remove();
  message({ ...layout, epoch: '2', views: [view, { ...view, id: '2' }] }); metadata(12, '2'); frame(12);
  assert.equal(t.presentationDiagnostics.presentationRouting.fallback['renderer-count'], 1); assert.equal(t.presentationDiagnostics.presentationRouting.fallback['plane-count'], 1);
  t.disconnect(); assert.equal(t.displayFrame, undefined); assert.equal(t.getPresentedPlane(view.id, 12), undefined); assert.equal((t as any).paintedPlanes.size, 0);
});

test('removing the renderer that actually painted does not grant input to an unpainted duplicate', () => {
  const { t, view, register, metadata, frame } = setup();
  const unpainted = new Canvas(); unpainted.getContext = () => null as any;
  register(unpainted); const painted = register(); metadata(10); frame(10);
  assert.ok(t.getPresentedPlane(view.id, 10)); painted.remove();
  assert.equal(t.getPresentedPlane(view.id, 10), undefined); assert.equal(t.sendInput(view, { type: 'ime_commit', text: 'wrong canvas' }), false);
});

test('stale planes wait for a ready epoch and its actual video before painting or sending coordinates', () => {
  const { t, view, layout, message, register, metadata, frame, paints, sent } = setup('single-plane-direct');
  const stale = { ...view, stale: true }; message({ ...layout, epoch: '2', views: [stale] });
  const waiting = register(new Canvas(), stale, '2'); metadata(10, '2'); frame(10);
  assert.equal(waiting.node.draws.length, 0); assert.equal(paints.length, 0);
  assert.equal(t.getPresentedPlane(view.id, 10), undefined); assert.equal(t.sendInput(stale, { type: 'mouse', action: 'move', x: 1, y: 1 }), false);
  const ready = { ...view, stale: false }; message({ ...layout, epoch: '3', views: [ready] });
  const current = register(new Canvas(), ready, '3');
  assert.equal(current.node.draws.length, 0, 'a ready layout alone cannot authorize the stale video');
  metadata(11, '2'); frame(11); assert.equal(current.node.draws.length, 0, 'late old-epoch video stays blocked');
  metadata(12, '3'); frame(12); assert.equal(current.node.draws.length, 1); assert.equal(paints.length, 1);
  assert.equal(t.getPresentedPlane(view.id, 10), undefined);
  assert.equal(t.sendInput(stale, { type: 'mouse', action: 'down', x: 1, y: 1 }), false);
  assert.equal(t.sendInput(ready, { type: 'mouse', action: 'move', x: 1, y: 1 }), true); assert.equal(sent.length, 1);
  waiting.remove(); metadata(13, '3'); frame(13);
  assert.equal(t.getPresentedPlane(view.id, 13)?.kind, 'plane', 'direct drawing resumes only after the ready snapshot transition');
});
