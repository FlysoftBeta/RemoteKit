import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(path.join(root, 'develop/tmp'), { recursive: true });
const temporary = await mkdtemp(path.join(root, 'develop/tmp/cluster-archive-'));
try {
  const generated = spawnSync(
    'C:/src/depot_tools/python3.bat',
    [path.join(root, 'endpoint/tests/updater_fixtures.py'), temporary],
    { shell: true, encoding: 'utf8' },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const extract = async (name, mode, success) => {
    const destination = path.join(temporary, `out-${name}`);
    await mkdir(destination);
    const result = spawnSync(process.argv[2], [mode, path.join(temporary, name), destination], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, success ? 0 : 1, `${name}: ${result.stderr}`);
    return destination;
  };
  const valid = await extract('valid.tar', 'tar', true);
  assert.equal(await readFile(path.join(valid, 'node/sized.txt'), 'utf8'), 'pax');
  assert.equal((await readFile(path.join(valid, 'node/data.bin'))).length, 256 * 1024);
  const rejects = JSON.parse(await readFile(path.join(temporary, 'rejects.json')));
  for (const name of rejects) await extract(`${name}.tar`, 'tar', false);
  const tar = await readFile(path.join(temporary, 'valid.tar'));
  const frames = [];
  for (let start = 0; start < tar.length; start += 7999)
    frames.push(zstdCompressSync(tar.subarray(start, start + 7999)));
  const zstd = Buffer.concat(frames);
  await writeFile(path.join(temporary, 'multi.tar.zst'), zstd);
  const decoded = await extract('multi.tar.zst', 'zstd', true);
  assert.deepEqual(
    await readFile(path.join(decoded, 'node/data.bin')),
    await readFile(path.join(valid, 'node/data.bin')),
  );
  await writeFile(path.join(temporary, 'truncated.zst'), zstd.subarray(0, -1));
  await extract('truncated.zst', 'zstd', false);
  await writeFile(path.join(temporary, 'junk.zst'), Buffer.concat([zstd, Buffer.from('junk')]));
  await extract('junk.zst', 'zstd', false);
  assert.deepEqual((await readdir(valid)).sort(), ['node']);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
