import { hkdfSync, randomBytes } from 'node:crypto';
import { RemoteKitError } from '../../shared/errors';

export function tenantKeys(dek: Buffer) {
  if (dek.length !== 32)
    throw new RemoteKitError('internal', '租户密钥无效', { detail: 'Invalid tenant key' });
  const derive = (info: string) =>
    Buffer.from(hkdfSync('sha256', dek, Buffer.alloc(0), info, 32)).toString('base64');
  try {
    return {
      profileKey: derive('remotekit profile cookie key 1'),
    };
  } finally {
    dek.fill(0);
  }
}

export function clusterObjectKeys(store: import('../persistence/database').ControlDatabase) {
  const secret = store.transaction(() => {
    const aad = 'cluster-object-secret';
    const row = store.db.prepare('SELECT ciphertext FROM cluster_object_secret WHERE id=1').get() as
      { ciphertext: string } | undefined;
    if (row) return store.atRestKey.open(aad, row.ciphertext);
    const secret = randomBytes(32);
    try {
      store.db
        .prepare('INSERT INTO cluster_object_secret VALUES (1,?)')
        .run(store.atRestKey.seal(aad, secret));
      return Buffer.from(secret);
    } finally {
      secret.fill(0);
    }
  });
  const derive = (info: string) =>
    Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, 32)).toString('base64');
  try {
    return { objectKey: derive('remotekit object key 2'), objectIdKey: derive('remotekit object id key 2') };
  } finally {
    secret.fill(0);
  }
}
