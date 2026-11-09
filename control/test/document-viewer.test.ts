import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { DocumentInfo, DocumentResource, DocumentSource } from '../client/documents/document-source';
import { MemoryDocumentSource } from '../client/documents/memory-source';
import { ResourceCache } from '../client/documents/resource-cache';
import {
  cleanCss,
  cleanStyle,
  rewriteAttributes,
  stripCssUrls,
  wordFit,
} from '../client/documents/page-content';
import { SizeIndex, virtualRange } from '../client/ui/virtual-scroll';
import {
  PAGE_GAP,
  PAGE_TOP,
  normalizeProgress,
  progressAt,
  progressTop,
} from '../client/documents/virtual-scroll';

const info: DocumentInfo = {
  documentId: 'document',
  shared: ['css'],
  pages: [
    { id: 'page', ordinal: 0, width: 600, height: 800, document: 'html', dependencies: ['css', 'image'] },
  ],
};
const signal = () => new AbortController().signal;
const image = (size = 4): DocumentResource => ({
  mime: 'image/webp',
  data: new Blob([new Uint8Array(size)], { type: 'image/webp' }),
});

test('virtual range follows variable page sizes, exact boundaries and overscan', () => {
  const sizes = new SizeIndex([100, 250, 80, 1000]);
  assert.equal(sizes.total, 1430);
  assert.equal(sizes.find(-10), 0);
  assert.equal(sizes.find(100), 1);
  assert.equal(sizes.find(349), 1);
  assert.equal(sizes.find(350), 2);
  assert.equal(sizes.find(2000), 3);
  assert.deepEqual(virtualRange(sizes, 360, 30, 0), { start: 2, end: 3, offset: 350 });
  assert.deepEqual(virtualRange(sizes, 360, 30, 80), { start: 1, end: 4, offset: 100 });
  assert.deepEqual(virtualRange(sizes, 0, 0), { start: 0, end: 0, offset: 0 });
  assert.deepEqual(virtualRange(new SizeIndex([]), 500, 900), { start: 0, end: 0, offset: 0 });
});

test('size index and virtual range agree with a linear model across a long document', () => {
  const heights = Array.from({ length: 10000 }, (_, index) => 200 + ((index * 71) % 1300));
  const sizes = new SizeIndex(heights);
  let prefix = 0;
  heights.forEach((height, index) => {
    assert.equal(sizes.prefix(index), prefix);
    assert.equal(sizes.find(prefix + height / 2), index);
    prefix += height;
  });
  for (let top = 0; top < sizes.total; top += 65537) {
    const range = virtualRange(sizes, top, 800);
    assert.ok(range.end - range.start < 13);
    assert.ok(range.offset <= Math.max(0, top - 600));
    assert.ok(sizes.prefix(range.end) >= Math.min(sizes.total, top + 1400));
  }
});

test('memory source provides decoded blobs and reports missing resources or cancellation', async () => {
  const resource = image();
  const source = new MemoryDocumentSource(info, new Map([['image', resource]]));
  const statuses: string[] = [];
  assert.equal(await source.open(signal(), { onStatus: (status) => statuses.push(status) }), info);
  assert.deepEqual(statuses, ['ready']);
  assert.equal(await source.resource('image', signal()), resource);
  await assert.rejects(source.resource('missing', signal()), { code: 'not_found' });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(source.open(aborted.signal), { code: 'canceled' });
  await assert.rejects(source.resource('image', aborted.signal), { code: 'canceled' });
});

function cacheFixture(maxEntries = 2, maxBytes = 100) {
  const requests: string[] = [];
  const revoked: string[] = [];
  const created: string[] = [];
  const source: DocumentSource = {
    open: async () => info,
    resource: async (id) => {
      requests.push(id);
      return image(id === 'large' ? 200 : 4);
    },
  };
  const cache = new ResourceCache(source, maxEntries, maxBytes, {
    create: () => {
      const url = `blob:resource-${created.length}`;
      created.push(url);
      return url;
    },
    revoke: (url) => revoked.push(url),
  });
  return { cache, requests, revoked, created };
}

test('LRU reuses shared blob URLs, refreshes recency and revokes the least recently used idle entry', async () => {
  const { cache, requests, revoked } = cacheFixture();
  const first = await cache.acquire('first', signal());
  first.release();
  const second = await cache.acquire('second', signal());
  second.release();
  const reused = await cache.acquire('first', signal());
  assert.equal(reused.url, first.url);
  reused.release();
  const third = await cache.acquire('third', signal());
  third.release();
  assert.deepEqual(requests, ['first', 'second', 'third']);
  assert.deepEqual(revoked, [second.url]);
  cache.dispose();
  cache.dispose();
  assert.deepEqual(new Set(revoked), new Set([first.url, second.url, third.url]));
  assert.equal(revoked.length, 3);
});

test('LRU pins active resources and enforces the byte budget when the last lease is released', async () => {
  const { cache, revoked } = cacheFixture(0, 0);
  const first = await cache.acquire('shared', signal());
  const otherPage = await cache.acquire('shared', signal());
  first.release();
  first.release();
  assert.deepEqual(revoked, []);
  otherPage.release();
  assert.deepEqual(revoked, [first.url]);
  cache.dispose();
  const budget = cacheFixture(64, 8);
  const large = await budget.cache.acquire('large', signal());
  assert.deepEqual(budget.revoked, []);
  large.release();
  assert.deepEqual(budget.revoked, [large.url]);
  budget.cache.dispose();
});

test('concurrent shared reads retain one URL and late reads cannot recreate URLs after disposal', async () => {
  const fixture = cacheFixture();
  const [a, b] = await Promise.all([
    fixture.cache.acquire('shared', signal()),
    fixture.cache.acquire('shared', signal()),
  ]);
  assert.equal(a.url, b.url);
  assert.equal(fixture.created.length, 1);
  fixture.cache.dispose();
  a.release();
  b.release();
  assert.deepEqual(fixture.revoked, [a.url]);
  let resolve!: (resource: DocumentResource) => void;
  const delayed = new ResourceCache({
    open: async () => info,
    resource: () => new Promise((done) => (resolve = done)),
  });
  const pending = delayed.acquire('image', signal());
  delayed.dispose();
  resolve(image());
  await assert.rejects(pending, { code: 'canceled' });
});

test('aborted reads are not admitted to the cache', async () => {
  const controller = new AbortController();
  let resolve!: (resource: DocumentResource) => void;
  let created = false;
  const cache = new ResourceCache(
    { open: async () => info, resource: () => new Promise((done) => (resolve = done)) },
    2,
    100,
    { create: () => ((created = true), 'blob:unexpected'), revoke: () => {} },
  );
  const pending = cache.acquire('image', controller.signal);
  controller.abort();
  resolve(image());
  await assert.rejects(pending, { code: 'canceled' });
  assert.equal(created, false);
  cache.dispose();
});

test('word fitting divides the target width by unscaled natural text width and clamps to 0.5–2', () => {
  assert.equal(wordFit(60, 40), 1.5);
  assert.equal(wordFit(60, 80, 2), 1.5);
  assert.equal(wordFit(60, 20, 0.5), 1.5);
  assert.equal(wordFit(1, 20), 0.5);
  assert.equal(wordFit(100, 20), 2);
  assert.equal(wordFit(0, 20), undefined);
  assert.equal(wordFit(20, 0), undefined);
  assert.equal(wordFit(20, 20, 0), undefined);
});

test('the decoded v2 smoke fixture retains its stylesheet, SVG resource slots and selectable words', async () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/pdfrender-smoke.json', import.meta.url), 'utf8'),
  ) as {
    info: DocumentInfo;
    resources: { contentId: string; mime: string; base64: string }[];
  };
  const resources = new Map<string, DocumentResource>();
  for (const resource of fixture.resources) {
    const bytes = Buffer.from(resource.base64, 'base64');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), resource.contentId);
    resources.set(resource.contentId, { mime: resource.mime, data: new Blob([bytes]) });
  }
  const source = new MemoryDocumentSource(fixture.info, resources);
  const document = await source.open(signal());
  const page = document.pages[0];
  assert.equal(page.width, 816);
  assert.equal(page.height, 1056);
  const stylesheet = await (await source.resource(document.shared[0], signal())).data.text();
  const css = cleanCss(stylesheet);
  assert.ok(css.includes('transform:rotate(var(--rotation,0deg)) scaleX(var(--fit-x,1))'));
  assert.ok(css.includes('.pdf-glyph{color:transparent!important}'));
  assert.equal(cleanStyle('--rotation:90deg;width:30px'), '--rotation:90deg;width:30px');
  const html = await (await source.resource(page.document, signal())).data.text();
  assert.ok(html.startsWith('<main class="page"'));
  assert.ok(html.includes('pdfrender</span>'));
  const imageId = page.dependencies[1];
  assert.ok(html.includes(`data-bundle-ref="${imageId}"`));
  assert.equal((await source.resource(imageId, signal())).mime, 'image/webp');
});

test('URL rewriting admits only image bundle slots and same-page fragments, including root attributes', () => {
  const refs = new Map([['image-id', 'blob:local-image']]);
  const rewritten = rewriteAttributes(
    'image',
    new Map([
      ['data-bundle-ref', 'image-id'],
      ['xlink:href', 'https://external.invalid/image.webp'],
      ['srcset', 'https://external.invalid/image.webp 2x'],
      ['onload', 'fetch("https://external.invalid")'],
      ['style', 'width:20px;background:url(https://external.invalid)'],
    ]),
    refs,
  );
  assert.equal(rewritten.get('href'), 'blob:local-image');
  assert.equal(rewritten.get('xlink:href'), 'blob:local-image');
  assert.equal(rewritten.get('style'), 'width:20px;background:none');
  assert.equal(rewritten.has('srcset'), false);
  assert.equal(rewritten.has('onload'), false);
  assert.equal(rewritten.has('data-bundle-ref'), false);
  const use = rewriteAttributes('use', new Map([['xlink:href', '#pdfrender-p1-2']]), refs);
  assert.equal(use.get('xlink:href'), '#pdfrender-p1-2');
  for (const value of [
    'https://external.invalid',
    '//external.invalid',
    'data:image/svg+xml,...',
    'blob:other',
  ]) {
    assert.equal(rewriteAttributes('use', new Map([['href', value]]), refs).has('href'), false);
  }
  assert.equal(
    rewriteAttributes(
      'main',
      new Map([
        ['onclick', 'bad()'],
        ['background', '//external'],
      ]),
      refs,
    ).size,
    0,
  );
  assert.throws(() => rewriteAttributes('image', new Map([['data-bundle-ref', 'missing']]), refs), {
    code: 'internal',
  });
});

test('CSS strips imports, external URLs and image-set while preserving SVG fragments and word transforms', () => {
  assert.equal(stripCssUrls('url("#clip")'), 'url(#clip)');
  assert.equal(stripCssUrls('url(data:image/png;base64,AA)'), 'none');
  assert.equal(stripCssUrls(String.raw`u\72l(https://external.invalid)`), 'none');
  assert.equal(
    cleanStyle('fill:url(#paint);clip-path:url(#clip);stroke-width:1'),
    'fill:url(#paint);clip-path:url(#clip);stroke-width:1',
  );
  const css = cleanCss(String.raw`
    @import "https://external.invalid/css";
    @\69mport url(https://external.invalid/escaped);
    @font-face {font-family:x;src:url(https://external.invalid/font)}
    @supports (display:grid) { .nested {background:url(https://external.invalid)} }
    .word {width:20px;transform:scaleX(var(--fit-x,1));font-family:serif}
    .page {background:image-set("https://external.invalid" 1x);color:rgb(0,0,0)}
  `);
  assert.equal(css.includes('external.invalid'), false);
  assert.equal(css.includes('@'), false);
  assert.ok(css.includes('transform:scaleX(var(--fit-x,1))'));
  assert.ok(css.includes('color:rgb(0,0,0)'));
  assert.equal(cleanStyle('cursor:url(https://external.invalid);src:url(https://external.invalid)'), '');
});

test('progress maps page-relative fractions to scroll offsets and survives zoom and width changes', () => {
  const sizes = new SizeIndex([800 + PAGE_GAP, 400 + PAGE_GAP, 1200 + PAGE_GAP]);
  for (const page of [0, 1, 2]) {
    for (const offset of [0, 0.01, 0.5, 0.99, 1]) {
      const progress = { page, offset };
      assert.deepEqual(progressAt(sizes, progressTop(sizes, progress)), progress);
      const zoomed = new SizeIndex([1600 + PAGE_GAP, 800 + PAGE_GAP, 2400 + PAGE_GAP]);
      assert.deepEqual(progressAt(zoomed, progressTop(zoomed, progress)), progress);
    }
  }
  assert.deepEqual(progressAt(sizes, 0), { page: 0, offset: 0 });
  assert.deepEqual(progressAt(sizes, sizes.prefix(1) - 1), { page: 0, offset: 1 });
  assert.equal(progressTop(sizes, { page: 1, offset: 0.5 }), 800 + PAGE_GAP + PAGE_TOP + 200);
  assert.deepEqual(normalizeProgress({ page: -10, offset: 5 }, 3), { page: 0, offset: 1 });
  assert.deepEqual(normalizeProgress({ page: 50, offset: -1 }, 3), { page: 2, offset: 0 });
  assert.deepEqual(normalizeProgress({ page: NaN, offset: NaN }, 3), { page: 0, offset: 0 });
  assert.equal(progressTop(new SizeIndex([]), { page: 0, offset: 0 }), 0);
});
