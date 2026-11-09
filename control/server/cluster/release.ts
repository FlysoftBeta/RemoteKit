import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { RemoteKitError } from '../../shared/errors';

export interface ReleaseDescriptor {
  buildId: string;
  sha256: string;
  size: number;
}
export interface NodeRelease {
  descriptor: Readonly<ReleaseDescriptor>;
  archive: string;
}
export function loadRelease(controlRoot: string, buildId: string): NodeRelease | undefined {
  const descriptorFile = resolve(controlRoot, '../release/node.json');
  const archive = resolve(controlRoot, '../release/node.tar.zst');
  if (!existsSync(descriptorFile) && !existsSync(archive)) return;
  try {
    const descriptor = JSON.parse(readFileSync(descriptorFile, 'utf8')) as ReleaseDescriptor;
    if (
      Object.keys(descriptor).sort().join() !== 'buildId,sha256,size' ||
      descriptor.buildId !== buildId ||
      !/^[a-f0-9]{64}$/.test(descriptor.buildId) ||
      !/^[a-f0-9]{64}$/.test(descriptor.sha256) ||
      !Number.isSafeInteger(descriptor.size) ||
      descriptor.size <= 0 ||
      statSync(archive).size !== descriptor.size
    )
      throw new Error('Invalid descriptor');
    const hash = createHash('sha256');
    const file = openSync(archive, 'r');
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      let size: number;
      while ((size = readSync(file, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, size));
    } finally {
      closeSync(file);
    }
    if (hash.digest('hex') !== descriptor.sha256) throw new Error('Archive checksum mismatch');
    return Object.freeze({ descriptor: Object.freeze(descriptor), archive });
  } catch {
    throw new RemoteKitError('invalid_request', '节点发布包信息无效', { detail: 'Invalid node release' });
  }
}
