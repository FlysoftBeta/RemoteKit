import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNavigation } from '../server/navigation';

test('navigation uses fixed providers and encodes search text as one query value', () => {
  const text = '中文 & a+b #x? / 100%';
  for (const [engine, base] of [
    ['google', 'https://www.google.com/search?q='],
    ['bing', 'https://www.bing.com/search?q='],
    ['duckduckgo', 'https://duckduckgo.com/?q='],
    ['baidu', 'https://www.baidu.com/s?wd='],
  ] as const)
    assert.equal(resolveNavigation(text, engine), base + encodeURIComponent(text));
});
test('navigation recognizes web addresses while keeping unsupported schemes inert', () => {
  for (const [text, expected] of [
    ['example.com/path?q=1#x', 'https://example.com/path?q=1#x'],
    ['localhost:8080/a', 'https://localhost:8080/a'],
    ['127.0.0.1:9000', 'https://127.0.0.1:9000/'],
    ['[::1]:8080', 'https://[::1]:8080/'],
    ['HTTPS://example.com', 'https://example.com/'],
    [' about:blank ', 'about:blank'],
  ])
    assert.equal(resolveNavigation(text, 'google'), expected);
  for (const text of [
    'javascript:alert(1)',
    'file:///c:/x',
    'data:text/html,hello',
    'htps://example.com',
    'about:config',
    'hello world',
    '//evil.test/path',
    'user:password@example.com',
  ])
    assert.equal(
      resolveNavigation(text, 'bing'),
      'https://www.bing.com/search?q=' + encodeURIComponent(text),
    );
  for (const text of ['', '  ', 'http://', 'https://user:password@example.com'])
    assert.throws(() => resolveNavigation(text, 'google'));
});

test('navigation checks final normalized URL bytes after URL and search expansion', () => {
  const prefix = 'https://example.com/';
  const exact = prefix + 'a'.repeat(8192 - prefix.length);
  assert.equal(resolveNavigation(exact, 'google'), exact);
  // Input remains under the input character cap; URL normalization expands it.
  const normalized = prefix + '中'.repeat(907) + 'a'.repeat(9);
  assert.equal(Buffer.byteLength(new URL(normalized).href), 8192);
  assert.equal(resolveNavigation(normalized, 'google'), new URL(normalized).href);
  assert.throws(() => resolveNavigation(normalized + 'a', 'google'), /8192 字节/);
  assert.throws(() => resolveNavigation('example.com/' + '中'.repeat(1000), 'google'), /8192 字节/);
  for (const engine of ['google', 'bing', 'duckduckgo', 'baidu'] as const) {
    const base = resolveNavigation('x', engine).slice(0, -1);
    const search = '中'.repeat(Math.floor((8192 - base.length) / 9));
    assert.ok(Buffer.byteLength(resolveNavigation(search, engine)) <= 8192);
    assert.throws(() => resolveNavigation(search + '中', engine), /8192 字节/);
  }
  assert.throws(() => resolveNavigation('a'.repeat(8193), 'google'), /无效/);
});
