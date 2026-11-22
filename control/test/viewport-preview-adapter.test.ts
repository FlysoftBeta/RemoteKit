import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import type { Layout, Surface } from '../client/presentation/types';

const dom = new JSDOM('<div class="window-content"><section></section><textarea></textarea></div>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
});
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, {
  window: dom.window,
  document: dom.window.document,
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
});
dom.window.matchMedia = (() => ({ matches: false })) as unknown as typeof dom.window.matchMedia;
const { ViewportPreviewAdapter } = await import('../client/presentation/viewport-preview-adapter');

const parent = dom.window.document.querySelector<HTMLElement>('.window-content')!;
Object.defineProperties(parent, {
  clientWidth: { value: 400 },
  clientHeight: { value: 300 },
  getBoundingClientRect: { value: () => ({ left: 0, top: 0, width: 400, height: 300 }) },
});

const surface = (document: string): Surface => ({
  id: 'v1',
  session: 's',
  instance: '1',
  document,
  focus: '1',
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  deviceScaleFactor: 1,
  mediaScale: 1,
});
const layout = (epoch: string): Layout => ({
  type: 'layout',
  generation: '1',
  epoch,
  width: 400,
  height: 300,
  views: [surface('1')],
});

test('a layout barrier keeps the viewport waiting until the new layout presents a frame', () => {
  let ready = true;
  const invalidations = new Set<(viewId: string) => void>();
  const frames = new Set<(viewId: string) => void>();
  const presentation = {
    layout: layout('1') as Layout | null,
    planeReady: () => ready,
    getLastPresentation: () => undefined,
    getPresentedPlane: () => undefined,
    recordResizeFreezeCopy() {},
    setTransitionBlocked() {},
    subscribePresentationInvalidation(listener: (viewId: string) => void) {
      invalidations.add(listener);
      return () => void invalidations.delete(listener);
    },
    subscribeFrames(listener: (viewId: string) => void) {
      frames.add(listener);
      return () => void frames.delete(listener);
    },
  };
  const adapter = new ViewportPreviewAdapter(
    presentation,
    'v1',
    dom.window.document.querySelector('section')!,
    dom.window.document.querySelector('textarea')!,
  );
  adapter.configure(surface('1'), 'owner');
  assert.equal(adapter.getSnapshot().waiting, false);

  // The Endpoint announces a new layout epoch: the video plane is hidden before React re-renders.
  presentation.layout = layout('2');
  ready = false;
  invalidations.forEach((listener) => listener('v1'));
  assert.equal(adapter.getSnapshot().waiting, true);
  adapter.configure({ ...surface('1') }, 'owner');
  assert.equal(adapter.getSnapshot().waiting, true, 'layout metadata alone exposes no pixels');
  assert.equal(adapter.blocksInput(), true);

  ready = true;
  frames.forEach((listener) => listener('v1'));
  assert.equal(adapter.getSnapshot().waiting, false);
  assert.equal(adapter.blocksInput(), false);
  adapter.detach();
});
