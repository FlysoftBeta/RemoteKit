import assert from 'node:assert/strict';
import test from 'node:test';
import { MediaProxy } from '../server/learning/media-proxy';
import { richHtml } from '../server/learning/rich-html';
import { ControlDatabase } from '../server/persistence/database';
import { createApplication } from '../server/application';
import { createHttp } from '../server/http/server';
import { registerUser, testGateway } from './server-fixture';

test('media signatures bind tenant, URL, expiry and boot', () => {
  let now = 1000;
  const proxy = new MediaProxy(globalThis.fetch, () => now);
  const token = proxy.url('tenant', 'https://cdn.example/video.mp4?a=1', 'xinjiaoyu').split('/').pop()!;
  assert.equal(proxy.verify('tenant', token).url, 'https://cdn.example/video.mp4?a=1');
  assert.throws(() => proxy.verify('other', token));
  assert.throws(() => proxy.verify('tenant', token + 'x'));
  assert.throws(() => new MediaProxy().verify('tenant', token));
  now += 24 * 3600_000;
  assert.throws(() => proxy.verify('tenant', token));
  assert.throws(() => proxy.url('tenant', 'javascript:alert(1)', 'changyan'));
});

test('rich HTML rewrites attributes and CSS and drops executable or large data URLs', () => {
  const proxy = new MediaProxy();
  const result = richHtml(
    `<p style="background:url('https://cdn.example/bg.png')"><img src="https://cdn.example/a.png?a=1&amp;b=2"
    srcset="https://other.example/a 2x" onerror="alert(1)"><a href="javascript&#58;alert(1)">bad</a>
    <video poster="http://cdn.example/poster.jpg" src="//cdn.example/movie.mp4"></video>
    <img src="data:image/png;base64,YQ=="><img src="data:text/html;base64,YQ==">
    <script>alert(1)</script><iframe src="https://cdn.example/frame"></iframe></p>`,
    'tenant',
    'xinjiaoyu',
    proxy,
  );
  assert.ok(!result.includes('https://cdn.example'));
  assert.ok(!/javascript|onerror|srcset|iframe|<script|data:text/.test(result));
  assert.ok(result.includes('data:image/png;base64,YQ=='));
  const tokens = [...result.matchAll(/\/api\/learning\/media\/([a-z0-9_.-]+)/gi)].map((match) => match[1]);
  assert.equal(tokens.length, 4);
  assert.deepEqual(
    tokens.map((token) => proxy.verify('tenant', token).url).sort(),
    [
      'https://cdn.example/bg.png',
      'https://cdn.example/a.png?a=1&b=2',
      'http://cdn.example/poster.jpg',
      'https://cdn.example/movie.mp4',
    ].sort(),
  );
  assert.ok(
    !richHtml(`<img src="data:image/png;base64,${'a'.repeat(40000)}">`, 'tenant', 'changyan', proxy).includes(
      'data:',
    ),
  );
});

test('TeX delimiters, data-latex and MathML produce self-contained SVG with cached formulas', () => {
  const proxy = new MediaProxy();
  const source = String.raw`<p>\(x^2\) \[\frac{a}{b}\] $$\sqrt{2}$$ <span data-latex="a+b"></span>
    <math><mfrac><mi>a</mi><mi>b</mi></mfrac></math></p>`;
  const result = richHtml(source, 'tenant', 'changyan', proxy);
  assert.equal((result.match(/<svg\b/g) ?? []).length, 5);
  assert.ok(!/<math\b|<use\b|data-latex|\\\(|\$\$/.test(result));
  assert.ok(result.includes('<path'));
  assert.equal(richHtml(source, 'tenant', 'changyan', proxy), result);
});

test('HTTP media route uses Viewer cookies, tenant ownership, private caching and Range', async () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  const user = await registerUser(store, 'media-user', 'media-password123');
  const other = await registerUser(store, 'media-other', 'media-password123');
  const app = createApplication(store, testGateway({ request: async () => ({}) }));
  const server = createHttp(app, { origins: [], clientDir: '.' });
  let requests = 0;
  let upstreamRange: string | null = null;
  const proxy = new MediaProxy(async (_url, init) => {
    requests++;
    const headers = new Headers(init?.headers);
    assert.ok(headers.get('referer')?.startsWith('https://www.xinjiaoyu.com/'));
    assert.ok(headers.get('user-agent'));
    upstreamRange = headers.get('range');
    return new Response('0123456789', { headers: { 'content-type': 'audio/mpeg' } });
  });
  Object.assign(app.learning, { media: proxy });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const path = proxy.url(user.tenantId, 'https://cdn.example/audio.mp3', 'xinjiaoyu');
  const get = (cookie?: string, range?: string, url = path) =>
    fetch(origin + url, {
      headers: { ...(cookie ? { cookie: 'rk_session=' + cookie } : {}), ...(range ? { Range: range } : {}) },
    });
  try {
    assert.equal((await get()).status, 401);
    assert.equal((await get(other.token)).status, 403);
    const result = await get(user.token);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'private, max-age=3600');
    assert.equal(result.headers.get('content-type'), 'audio/mpeg');
    assert.equal(await result.text(), '0123456789');
    const range = await get(user.token, 'bytes=2-5');
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await range.text(), '2345');
    assert.equal(requests, 1);
    const suffix = await get(user.token, 'bytes=-3');
    assert.equal(await suffix.text(), '789');
    assert.equal((await get(user.token, 'bytes=20-30')).status, 416);
    const uncached = proxy.url(user.tenantId, 'https://cdn.example/second.mp3', 'xinjiaoyu');
    await (await get(user.token, 'bytes=1-2', uncached)).text();
    assert.equal(upstreamRange, 'bytes=1-2');
    app.accounts.logout(user.token);
    assert.equal((await get(user.token)).status, 401);
  } finally {
    await server.shutdown();
    await app.close();
    store.db.close();
  }
});

test('media route rejects upstream bodies larger than the cap', async () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  const user = await registerUser(store, 'cap-user', 'media-password123');
  const app = createApplication(store, testGateway({ request: async () => ({}) }));
  const proxy = new MediaProxy(
    async () => new Response('body', { headers: { 'content-length': String(33 * 1024 * 1024) } }),
  );
  Object.assign(app.learning, { media: proxy });
  const server = createHttp(app, { origins: [], clientDir: '.' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url =
      `http://127.0.0.1:${(server.address() as { port: number }).port}` +
      proxy.url(user.tenantId, 'https://cdn.example/large', 'changyan');
    const response = await fetch(url, { headers: { cookie: 'rk_session=' + user.token } });
    assert.equal(response.status, 413);
  } finally {
    await server.shutdown();
    await app.close();
    store.db.close();
  }
});
