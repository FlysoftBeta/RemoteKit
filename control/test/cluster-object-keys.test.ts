import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { ControlDatabase } from '../server/persistence/database';
import { clusterObjectKeys } from '../server/cluster/keys';

test('cluster object keys are sealed by the database key and survive reopening', () => {
  const path = join(
    mkdtempSync(fileURLToPath(new URL('../../develop/tmp/object-keys-', import.meta.url))),
    'control.db',
  );
  let store = new ControlDatabase(path, { buildId: 'test' });
  let keys;
  try {
    keys = clusterObjectKeys(store);
    const row = store.db.prepare('SELECT ciphertext FROM cluster_object_secret').get() as {
      ciphertext: string;
    };
    assert.equal(Buffer.from(row.ciphertext, 'base64').length, 60);
    assert.equal(store.atRestKey.open('cluster-object-secret', row.ciphertext).length, 32);
    assert.deepEqual(clusterObjectKeys(store), keys);
    assert.notEqual(keys.objectKey, keys.objectIdKey);
    assert.equal(readFileSync(path + '.key').length, 32);
  } finally {
    store.db.close();
  }
  store = new ControlDatabase(path, { buildId: 'test' });
  try {
    assert.deepEqual(clusterObjectKeys(store), keys);
  } finally {
    store.db.close();
  }
  writeFileSync(path + '.key', randomBytes(32));
  store = new ControlDatabase(path, { buildId: 'test' });
  try {
    assert.throws(() => clusterObjectKeys(store));
  } finally {
    store.db.close();
  }
});
