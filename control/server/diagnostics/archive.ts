import { decodeJson, encodeJson } from '../persistence/codec';
import { archiveMetadata, diagnosticManifest, type stopReason } from './formats';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress } from 'node:zlib';
import { RemoteKitError } from '../../shared/errors';

export type ArchiveEntry =
  | 'manifest.json'
  | 'client.jsonl'
  | 'control.jsonl'
  | 'endpoint.jsonl'
  | 'events.jsonl'
  | 'logs/control.jsonl'
  | 'logs/browser.log'
  | 'logs/endpoint.log'
  | 'logs/endpoint.log.1'
  | 'crashes/events.jsonl'
  | `crashes/${string}.dmp`;
const block = 512;

function* tar(entries: ReadonlyMap<ArchiveEntry, readonly Buffer[]>, mtime: number) {
  for (const [name, chunks] of entries) {
    const header = Buffer.alloc(block);
    const size = chunks.reduce((bytes, chunk) => bytes + chunk.length, 0);
    const octal = (value: number, offset: number, width: number) =>
      header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width, 'ascii');
    header.write(name, 0, 'ascii');
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
    yield* chunks;
    if (size % block) yield Buffer.alloc(block - (size % block));
  }
  yield Buffer.alloc(2 * block);
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
    await pipeline(Readable.from(tar(entries, Math.floor(endedAt / 1000))), createZstdCompress(), output);
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
