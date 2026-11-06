import { hkdfSync } from 'node:crypto';
import { RemoteKitError } from '../../shared/errors';

export function tenantKeys(dek: Buffer) {
  if (dek.length !== 32) throw new RemoteKitError('internal', 'Invalid tenant key');
  const derive = (info: string) =>
    Buffer.from(hkdfSync('sha256', dek, Buffer.alloc(0), info, 32)).toString('base64');
  try {
    return {
      profileKey: derive('remotekit profile cookie key 1'),
      objectKey: derive('remotekit object key 1'),
      objectIdKey: derive('remotekit object id key 1'),
    };
  } finally {
    dek.fill(0);
  }
}
