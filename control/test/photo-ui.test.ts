import { FilePreview } from '../client/files/file-preview';
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import type { LibraryFileEntry } from '../shared/file-library';
import { FileLibraryContext, type FileLibrary } from '../client/files/file-library-state';
import { BasketItems, photoStatus } from '../client/files/basket-items';
import { FileImagePreview, canPreviewFile } from '../client/files/file-image-preview';
import { PhotoOptions } from '../client/files/photo-options';
import type { PhotoJob } from '../client/files/photo-job-store';

const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
for (const name of [
  'window',
  'document',
  'HTMLElement',
  'Element',
  'Node',
  'ShadowRoot',
  'DocumentFragment',
  'MutationObserver',
  'Event',
  'MouseEvent',
  'getComputedStyle',
] as const)
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
});
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { get: () => 120 });
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { get: () => 80 });
dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
  x: 0,
  y: 0,
  left: 0,
  top: 0,
  right: 120,
  bottom: 80,
  width: 120,
  height: 80,
  toJSON() {},
});
const { createRoot } = await import('react-dom/client');
const entry: LibraryFileEntry = {
  kind: 'file',
  available: true,
  id: 'camera',
  assetId: 'webp',
  originalAssetId: 'original',
  name: 'photo.webp',
  type: 'image/webp',
  size: 12,
  createdAt: 1,
  source: null,
  partitionId: null,
  collected: false,
  photo: { mode: 'scan', quarterTurns: 1 },
};

function fixture() {
  const rotations: { entry: LibraryFileEntry; destination: string }[] = [];
  const resolutions: unknown[][] = [];
  const thumbnailRequests: string[] = [];
  const library = {
    online: true,
    snapshot: { entries: [entry], basket: [entry.id], partitions: [], revision: 1 },
    photos: {
      jobs: [],
      rotate: (entry: LibraryFileEntry, destination: string) => rotations.push({ entry, destination }),
      resolve: (...args: unknown[]) => resolutions.push(args),
    },
    thumbnails: {
      get: () => undefined,
      subscribe: (id: string, show: (preview: { blob?: Blob }) => void) => {
        thumbnailRequests.push(id);
        show({ blob: new Blob(['thumbnail'], { type: 'image/jpeg' }) });
        return () => {};
      },
    },
    rpc: { readPhoto: async () => new Blob(['webp'], { type: 'image/webp' }) },
  } as unknown as FileLibrary;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  return {
    library,
    container,
    rotations,
    resolutions,
    thumbnailRequests,
    render: async (content: React.ReactNode) =>
      act(async () => {
        root.render(createElement(FileLibraryContext.Provider, { value: library }, content));
      }),
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function basket(panel?: { id: string; view: 'image' | 'photo' }) {
  return createElement(BasketItems, {
    entries: [entry],
    pending: [],
    revision: 1,
    mode: 'cards',
    ordered: true,
    disabled: false,
    dragging: false,
    onDragging() {},
    panel,
    setPanel() {},
    onChange: async () => {},
    onInsert() {},
    onRetake() {},
  });
}

test('basket photo menu places clockwise rotation after large preview and closes after a tap', async () => {
  const f = fixture();
  try {
    await f.render(basket());
    await act(async () =>
      f.container.querySelector<HTMLButtonElement>(`button[aria-label="${entry.name}"]`)!.click(),
    );
    const menuItems = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const view = menuItems.findIndex((item) => item.textContent === '查看大图');
    assert.equal(menuItems[view + 1].textContent, '向右旋转');
    await act(async () => menuItems[view + 1].click());
    assert.deepEqual(f.rotations, [{ entry, destination: 'basket' }]);
    assert.equal(
      f.container.querySelector(`button[aria-label="${entry.name}"]`)!.getAttribute('aria-expanded'),
      null,
    );
  } finally {
    await f.close();
  }
});

test('basket preview and thumbnail show pending turns and its header accepts repeated taps', async () => {
  const f = fixture();
  try {
    f.library.photos.jobs = [
      {
        id: 'rotation',
        replace: entry,
        state: 'processing',
        mode: 'scan',
        rotationTurns: 1,
        destination: 'basket',
        origin: { kind: 'files', channel: 'camera', partitionId: null },
      },
    ];
    await f.render(basket({ id: entry.id, view: 'image' }));
    assert.ok(f.thumbnailRequests.includes(entry.assetId));
    const button = f.container.querySelector<HTMLButtonElement>('button[aria-label="向右旋转"]')!;
    const close = f.container.querySelector('button[aria-label="收起项目"]')!;
    assert.ok(button.compareDocumentPosition(close) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    await act(async () => {
      button.click();
      button.click();
    });
    assert.equal(f.rotations.length, 2);
    const images = [...f.container.querySelectorAll('img')];
    assert.equal(images.length, 2);
    for (const image of images) {
      const style = getComputedStyle(image);
      assert.ok(style.transform.includes('rotate(90deg)'));
      assert.equal(style.width, '80px');
      assert.equal(style.height, '120px');
      assert.equal(style.objectFit, 'contain');
    }
    const image = images.find((image) => image.alt === entry.name)!;
    Object.defineProperty(image, 'naturalWidth', { value: 400 });
    Object.defineProperty(image, 'naturalHeight', { value: 300 });
    await act(async () => image.dispatchEvent(new dom.window.Event('load')));
    assert.equal(getComputedStyle(image.parentElement!.parentElement!).aspectRatio, '300 / 400');
    f.library.photos.jobs = [];
    await f.render(basket({ id: entry.id, view: 'image' }));
    assert.ok(
      [...f.container.querySelectorAll('img')].every((image) =>
        getComputedStyle(image).transform.includes('rotate(0deg)'),
      ),
    );
  } finally {
    await f.close();
  }
});

test('shared image preview rotates library camera photos and photo details rederive use original', async () => {
  const f = fixture();
  try {
    assert.equal(canPreviewFile(entry), true);
    await f.render(createElement(FileImagePreview, { entry, inline: true, onClose() {} }));
    await act(async () =>
      f.container.querySelector<HTMLButtonElement>('button[aria-label="向右旋转"]')!.click(),
    );
    assert.deepEqual(f.rotations, [{ entry, destination: 'library' }]);
    await f.render(createElement(PhotoOptions, { entry, destination: 'library', disabled: false }));
    assert.equal(f.container.querySelector('img'), null);
    assert.ok(
      [...f.container.querySelectorAll('button')].some((button) => button.textContent === '查看原图'),
    );
    const original = [...f.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '使用原图',
    )!;
    await act(async () => original.click());
    assert.deepEqual(f.resolutions, [[entry, 'library', entry.originalAssetId, true]]);
    f.library.photos.jobs = [
      { id: 'rotation', replace: entry, mode: 'scan', state: 'processing', rotationTurns: 1 } as PhotoJob,
    ];
    await f.render(
      createElement(PhotoOptions, {
        entry,
        job: f.library.photos.jobs[0],
        destination: 'library',
        disabled: false,
      }),
    );
    assert.equal(f.container.querySelector('img'), null);
    assert.equal(f.container.querySelector('[role="status"]')?.lastChild?.textContent?.trim(), '处理中');
    await f.render(
      createElement(PhotoOptions, {
        entry: { ...entry, photo: { mode: 'photo' } },
        destination: 'library',
        disabled: false,
      }),
    );
    assert.equal(
      [...f.container.querySelectorAll('button')].some((button) => button.textContent === '使用原图'),
      false,
    );
    assert.ok(
      [...f.container.querySelectorAll('button')].some((button) => button.textContent === '查看原图'),
    );
  } finally {
    await f.close();
  }
});

test('retake processing keeps its label while rotation uses the normal processing label', () => {
  const job: PhotoJob = {
    id: 'job',
    replace: entry,
    mode: 'scan',
    state: 'processing',
    destination: 'basket',
    origin: { kind: 'files', channel: 'camera', partitionId: null },
  };
  assert.equal(photoStatus(entry, job)?.label, '重拍处理中');
  assert.equal(photoStatus(entry, { ...job, rotationTurns: 1 })?.label, '处理中');
});

test('an open file becomes unavailable without fetching a preview or exposing a retry', async () => {
  const f = fixture();
  const unavailable = { ...entry, available: false };
  await f.render(createElement(FilePreview, { entry: unavailable }));
  assert.match(f.container.textContent ?? '', /文件暂不可用，恢复后自动继续/);
  assert.equal(f.container.querySelectorAll('button').length, 0);
  assert.deepEqual(f.thumbnailRequests, []);
  await f.close();
});
