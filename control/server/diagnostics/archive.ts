import { decodeJson, encodeJson } from '../persistence/codec';
import { archiveMetadata, diagnosticManifest, type stopReason } from './formats';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress } from 'node:zlib';
import { RemoteKitError } from '../../shared/errors';

export type ArchiveEntry = string;
export interface ArchiveMember {
  name: string;
  size: number;
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}
const block = 512;

async function* tar(entries: AsyncIterable<ArchiveMember> | Iterable<ArchiveMember>, mtime: number) {
  for await (const { name, size, chunks } of entries) {
    const header = Buffer.alloc(block);
    const octal = (value: number, offset: number, width: number) =>
      header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width, 'ascii');
    if (
      name.startsWith('/') ||
      name.split('/').some((part) => !part || part === '..' || part === '.') ||
      name.includes('\\')
    )
      throw new Error('Invalid archive name');
    const encoded = Buffer.from(name);
    if (encoded.length <= 100) encoded.copy(header);
    else {
      const slash = name.lastIndexOf('/');
      const prefix = Buffer.from(name.slice(0, slash));
      const leaf = Buffer.from(name.slice(slash + 1));
      if (slash < 1 || prefix.length > 155 || leaf.length > 100)
        throw new Error('Archive name exceeds USTAR limit');
      leaf.copy(header);
      prefix.copy(header, 345);
    }
    octal(0o600, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(size, 124, 12);
    octal(mtime, 136, 12);
    header.fill(0x20, 148, 156);
    header.write('0', 156, 'ascii');
    header.write('ustar\0' + '00', 257, 'ascii');
    octal(
      header.reduce((sum, byte) => sum + byte, 0),
      148,
      7,
    );
    yield header;
    let written = 0;
    for await (const chunk of chunks) {
      written += chunk.byteLength;
      if (written > size) throw new Error('Archive member grew');
      yield chunk;
    }
    if (written !== size) throw new Error('Archive member is incomplete');
    if (size % block) yield Buffer.alloc(block - (size % block));
  }
  yield Buffer.alloc(2 * block);
}

export async function* archiveStream(
  entries: AsyncIterable<ArchiveMember> | Iterable<ArchiveMember>,
  mtime = Date.now(),
) {
  const source = Readable.from(tar(entries, Math.floor(mtime / 1000)));
  const output = source.pipe(createZstdCompress());
  // pipe() does not propagate source errors; the consumer sees them through the output.
  source.once('error', (error) => output.destroy(error));
  try {
    for await (const chunk of output) yield chunk as Buffer;
  } finally {
    // The tar source owns member iterators; wait until destroy has returned them.
    const released = source.closed ? undefined : new Promise((resolve) => source.once('close', resolve));
    source.destroy();
    output.destroy();
    await released;
  }
}

export async function writeDiagnosticArchive(
  directory: string,
  id: string,
  entries: ReadonlyMap<ArchiveEntry, readonly Buffer[]>,
  endedAt: number,
  reason: import('../persistence/codec').Decoded<typeof stopReason>,
) {
  const manifest = entries.get('manifest.json');
  decodeJson(
    Buffer.concat(manifest ? [...manifest] : []).toString(),
    diagnosticManifest,
    `diagnostics.manifest ${id}`,
  );
  const metadataBytes = encodeJson({ version: 1, reason }, archiveMetadata, `diagnostics.metadata ${id}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const final = join(directory, `${id}.tar.zst`);
  const partial = join(directory, `${id}.partial`);
  const metadata = join(directory, `${id}.reason`);
  let ownsMetadata = false;
  await rm(partial, { force: true });
  await rm(metadata, { force: true });
  try {
    const output = createWriteStream(partial, { flags: 'wx', mode: 0o600 });
    await pipeline(
      archiveStream(
        [...entries].map(([name, chunks]) => ({
          name,
          chunks,
          size: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
        })),
        endedAt,
      ),
      output,
    );
    const reasonFile = await open(metadata, 'wx', 0o600);
    ownsMetadata = true;
    try {
      await reasonFile.writeFile(metadataBytes);
    } finally {
      await reasonFile.close();
    }
    await rename(partial, final);
    return output.bytesWritten;
  } catch (error) {
    const cleanup = await Promise.allSettled([
      rm(partial, { force: true }),
      ...(ownsMetadata ? [rm(metadata, { force: true })] : []),
    ]);
    const failures = cleanup.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
    if (failures.length)
      throw new RemoteKitError('unavailable', '诊断文件暂时无法保存', {
        cause: { operation: error, cleanup: failures },
      });
    throw error;
  }
}
