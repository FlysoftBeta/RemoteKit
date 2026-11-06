import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

/** Minimal real Endpoint release; Control supplies the shared dev Browser path. */
export async function makeNodeRelease(runtime, endpoint, generation) {
  const binary = join(runtime, 'bin');
  await mkdir(binary, { recursive: true });
  const files = new Map();
  for (const source of [
    endpoint,
    ...['remotekit_node.exe', 'libvpl.dll', 'libvpld.dll'].map((name) => join(dirname(endpoint), name)),
  ]) {
    const name = basename(source);
    await copyFile(source, join(binary, name));
    files.set('bin/' + name, await readFile(source));
  }
  files.set('bin/release-generation', Buffer.from(generation));
  await writeFile(join(binary, 'release-generation'), generation);
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const buildId = hash(
    [...files]
      .sort()
      .map(([name, bytes]) => `${name}\t${hash(bytes)}\n`)
      .join(''),
  );
  const build = Buffer.from(JSON.stringify({ buildId }) + '\n');
  await writeFile(join(runtime, 'build.json'), build);
  files.set('build.json', build);
  const parts = [];
  for (const [name, bytes] of files) {
    const header = Buffer.alloc(512);
    header.write('node/' + name, 0, 100, 'ascii');
    const octal = (value, offset, length) =>
      header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
    octal(0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(bytes.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    parts.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  const tar = Buffer.concat(parts),
    frames = [];
  for (let offset = 0; offset < tar.length; offset += 4 * 1024 * 1024)
    frames.push(zstdCompressSync(tar.subarray(offset, offset + 4 * 1024 * 1024)));
  const archive = Buffer.concat(frames);
  const release = { buildId, sha256: hash(archive), size: archive.length };
  await mkdir(join(runtime, 'release'));
  await writeFile(join(runtime, 'release/node.tar.zst'), archive);
  await writeFile(join(runtime, 'release/node.json'), JSON.stringify(release));
  return release;
}
