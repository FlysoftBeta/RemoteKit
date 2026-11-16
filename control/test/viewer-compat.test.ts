import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.tsx?$/.test(path) ? [path] : [];
  });
}

// The build target only lowers syntax; these runtime APIs arrived after Chrome 89.
const newerThanChrome89: [name: string, pattern: RegExp][] = [
  ['crypto.randomUUID (92)', /\brandomUUID\b/],
  ['AbortSignal.any/timeout (116/103)', /AbortSignal\.(any|timeout)\b/],
  ['AbortSignal.throwIfAborted (100)', /\.throwIfAborted\(/],
  ['structuredClone (98)', /\bstructuredClone\(/],
  ['Object.hasOwn (93)', /Object\.hasOwn\(/],
  ['Array at/findLast/toSorted… (92–110)', /\.(at|findLast|findLastIndex|toSorted|toReversed|toSpliced)\(/],
  ['Promise.withResolvers (119)', /Promise\.withResolvers\(/],
  ['Object.groupBy (117)', /Object\.groupBy\(/],
];

test('Viewer and shared code call no runtime API newer than Chrome 89', () => {
  const violations: string[] = [];
  for (const directory of ['client', 'shared'])
    for (const path of sources(join(root, directory))) {
      const name = relative(root, path).replace(/\\/g, '/');
      // Development-only hooks are stripped from the product and run in current browsers.
      if (name.startsWith('client/test-hooks')) continue;
      const lines = readFileSync(path, 'utf8').split('\n');
      lines.forEach((line, index) => {
        for (const [api, pattern] of newerThanChrome89)
          if (pattern.test(line)) violations.push(`${name}:${index + 1} ${api}`);
      });
    }
  assert.deepEqual(violations, []);
});
