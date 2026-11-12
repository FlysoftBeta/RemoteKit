import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlDatabase } from '../server/persistence/database';
import { decodeSealedRecord } from '../server/persistence/sealed-documents';

test('sealed records preserve writer bytes and reject noncanonical encodings at the store boundary', () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  try {
    const sealed = store.atRestKey.seal('test', Buffer.from('writer'));
    assert.equal(decodeSealedRecord(sealed).toString('base64'), sealed);
    store.db.prepare('INSERT INTO cluster_object_secret VALUES (1,?)').run(sealed);
    const read = () => store.db.prepare('SELECT ciphertext FROM cluster_object_secret').get();
    assert.deepEqual(read(), { ciphertext: sealed });
    for (const value of [sealed + '\n', sealed.replace(/=+$/, ''), 'invalid', 7]) {
      store.db.prepare('UPDATE cluster_object_secret SET ciphertext=?').run(value);
      assert.throws(
        read,
        (error: any) => error.reason === 'corrupt_record' && /^c-[0-9a-f]{10}$/.test(error.errorId),
      );
    }
  } finally {
    store.db.close();
  }
});
