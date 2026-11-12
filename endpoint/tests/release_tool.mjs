import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { zstdDecompressSync } from 'node:zlib';

const execute = promisify(execFile);
const [tool, manager] = process.argv.slice(2);
const repository = fileURLToPath(new URL('../../', import.meta.url));
const scratch = path.join(repository, 'develop/tmp');
await mkdir(scratch, { recursive: true });
const temporary = await mkdtemp(path.join(scratch, 'release-tool-'));
const served = new Map();
const ranges = [];
let dropped = false;
let corruptPatch = false;
let ignoreRange = false;
const server = createServer((request, response) => {
  const filename = new URL(request.url, 'http://localhost').pathname;
  let bytes = served.get(filename);
  if (!bytes) {
    response.writeHead(404).end();
    return;
  }
  if (corruptPatch && filename.includes('control-patch.')) {
    bytes = Buffer.from(bytes);
    bytes[0] ^= 1;
  }
  let start = 0;
  if (request.headers.range) {
    start = Number(/^bytes=(\d+)-$/.exec(request.headers.range)?.[1]);
    assert(Number.isSafeInteger(start) && start > 0 && start < bytes.length);
    ranges.push(start);
  }
  if (ignoreRange) start = 0;
  response.writeHead(start ? 206 : 200, {
    'Content-Length': bytes.length - start,
    ...(start ? { 'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}),
  });
  if (!dropped && filename.includes('control-full.')) {
    dropped = true;
    response.write(bytes.subarray(start, start + 65536));
    setTimeout(() => response.destroy(), 100);
    return;
  }
  response.end(bytes.subarray(start));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const prefix = `http://127.0.0.1:${server.address().port}/`;
const key = path.join(temporary, 'release.key');
const common = randomBytes(3 * 1024 * 1024);
const ids = ['a', 'b', 'c'].map((char) => char.repeat(64));
function decrypt(key, nonce, aad, cipher) {
  const decoder = createDecipheriv('aes-256-gcm', key, nonce);
  decoder.setAAD(aad);
  decoder.setAuthTag(cipher.subarray(-16));
  return Buffer.concat([decoder.update(cipher.subarray(0, -16)), decoder.final()]);
}
function payload(id) {
  const files = new Map([
    ['build.json', Buffer.from(JSON.stringify({ buildId: id }))],
    ['bin/node.exe', Buffer.from('node')],
    ['bin/remotekit_control.exe', Buffer.from('manager')],
    ['bin/remotekit_node.exe', Buffer.from('updater')],
    ['control/dist/server.mjs', Buffer.from('server')],
    ['node/build.json', Buffer.from(JSON.stringify({ buildId: id }))],
    ['node/bin/endpoint_service.exe', Buffer.from('endpoint')],
    ['node/bin/remotekit_node.exe', Buffer.from('updater')],
    ['node/bin/remotekit_snapshot.exe', Buffer.from('snapshot')],
    ['control/dist/client/data.bin', common],
  ]);
  const records = [];
  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const header = Buffer.alloc(512);
    header.write(name);
    const octal = (offset, length, value) =>
      header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset);
    octal(100, 8, 0o644);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, bytes.length);
    octal(136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257);
    header.write('00', 263);
    octal(
      148,
      7,
      header.reduce((sum, byte) => sum + byte, 0),
    );
    header[155] = 32;
    records.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  records.push(Buffer.alloc(1024));
  return Buffer.concat(records);
}
async function run(executable, args) {
  return execute(executable, args, { timeout: 60000, windowsHide: true });
}
async function pack(index, base, full = false) {
  const directory = path.join(temporary, String(index));
  await run(tool, [
    'pack',
    '--key=' + key,
    '--payload=' + path.join(temporary, `${index}.tar`),
    '--build=' + ids[index],
    '--url-prefix=' + prefix + index + '/',
    '--out=' + directory,
    '--level=1',
    '--patch-level=1',
    ...(base === undefined
      ? []
      : [
          '--base=' + path.join(temporary, `${base}.tar`),
          '--base-build=' + ids[base],
          '--base-manifest=' + prefix + base + '/control.manifest',
        ]),
    ...(full ? ['--full'] : []),
  ]);
  const upload = JSON.parse(await readFile(path.join(directory, 'upload.json'), 'utf8'));
  assert.equal(upload.at(-1).name, 'control.manifest');
  for (const asset of upload) {
    const bytes = await readFile(path.join(directory, asset.name));
    assert.equal(bytes.length, asset.size);
    served.set(`/${index}/${asset.name}`, bytes);
  }
  return directory;
}
async function fetch(index, name, base) {
  const output = path.join(temporary, name + '.tar');
  const result = await run(tool, [
    'fetch',
    '--key=' + key,
    '--manifest=' + prefix + index + '/control.manifest',
    '--out=' + output,
    ...(base === undefined
      ? []
      : ['--base=' + path.join(temporary, `${base}.tar`), '--base-build=' + ids[base]]),
  ]);
  const summary = JSON.parse(result.stdout);
  const bytes = await readFile(output);
  assert.equal(summary.buildId, ids[index]);
  assert.equal(summary.size, bytes.length);
  assert.equal(summary.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(bytes, await readFile(path.join(temporary, `${index}.tar`)));
}
try {
  await run(tool, ['keygen', '--out=' + key]);
  await assert.rejects(run(tool, ['keygen', '--out=' + key]));
  for (let index = 0; index < ids.length; ++index)
    await writeFile(path.join(temporary, `${index}.tar`), payload(ids[index]));
  const first = await pack(0);
  await pack(1, 0, true);
  await pack(2, 1);
  const inspected = await run(tool, [
    'inspect',
    '--key=' + key,
    '--manifest=' + path.join(first, 'control.manifest'),
  ]);
  assert.equal(JSON.parse(inspected.stdout).buildId, ids[0]);
  const releaseKey = Buffer.from((await readFile(key, 'utf8')).trim(), 'base64');
  const envelope = served.get('/0/control.manifest');
  const manifestKey = hkdfSync(
    'sha256',
    releaseKey,
    envelope.subarray(5, 37),
    'remotekit release manifest v1',
    32,
  );
  const manifest = JSON.parse(
    decrypt(manifestKey, Buffer.alloc(12), envelope.subarray(0, 37), envelope.subarray(37)),
  );
  const asset = manifest.full;
  const assetKey = hkdfSync(
    'sha256',
    releaseKey,
    Buffer.from(asset.salt, 'hex'),
    'remotekit release asset v1',
    32,
  );
  const compressed = asset.slices.map((slice, index) => {
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64BE(BigInt(index), 4);
    const aad = Buffer.alloc(13);
    aad.write('RKRS');
    aad[4] = 1;
    aad.writeUInt32BE(index, 5);
    aad.writeUInt32BE(asset.slices.length, 9);
    return decrypt(assetKey, nonce, aad, served.get(new URL(slice.url).pathname));
  });
  assert.deepEqual(
    zstdDecompressSync(Buffer.concat(compressed)),
    await readFile(path.join(temporary, '0.tar')),
  );
  await fetch(0, 'full');
  assert(dropped && ranges.some((offset) => offset >= 65536), 'dropped slice resumed with Range');
  await fetch(2, 'chain', 0);
  await fetch(2, 'bootstrap');
  const baseBytes = await readFile(path.join(temporary, '0.tar'));
  const damagedBase = Buffer.from(baseBytes);
  const content = damagedBase.indexOf(common);
  assert(content >= 0);
  damagedBase[content + 1000] ^= 1;
  await writeFile(path.join(temporary, '0.tar'), damagedBase);
  await fetch(1, 'base-unusable', 0);
  await writeFile(path.join(temporary, '0.tar'), baseBytes);
  const missing = '/1/control-patch.000';
  const savedPatch = served.get(missing);
  served.delete(missing);
  await fetch(1, 'missing-asset', 0);
  served.set(missing, savedPatch);
  corruptPatch = true;
  await fetch(1, 'replan', 0);
  corruptPatch = false;
  dropped = false;
  ignoreRange = true;
  await fetch(0, 'restart');
  ignoreRange = false;
  const root = path.join(temporary, 'manager-root');
  await run(manager, [
    'init',
    '--root=' + root,
    '--manifest=' + prefix + '0/control.manifest',
    '--key-file=' + key,
  ]);
  await run(manager, ['install', '--root=' + root, '--payload=' + path.join(temporary, '0.tar')]);
  assert.equal(await readFile(path.join(root, 'current'), 'utf8'), ids[0]);
  assert.deepEqual(await readdir(path.join(root, 'versions')), [ids[0]]);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'config/manager.json'), 'utf8')), {
    version: 1,
    checkIntervalMinutes: 60,
    manifest: prefix + '0/control.manifest',
  });
  await run(manager, ['install', '--root=' + root, '--payload=' + path.join(temporary, '1.tar')]);
  assert.deepEqual(await readdir(path.join(root, 'versions')), [ids[1]]);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
