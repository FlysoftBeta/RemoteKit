import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authEncap, authDecap, x25519Public, hpkeSeal, hpkeOpen } from '../server/session-import/hpke';
const vector = JSON.parse(
  readFileSync(new URL('../../protocol/session-import/hpke-auth-vector.json', import.meta.url), 'utf8'),
);
const b = (name: string) => Buffer.from(vector[name], 'hex');
test('RFC 9180 AuthEncap and AuthDecap match the Auth KEM vector', () => {
  assert.deepEqual(x25519Public(b('skSm')), b('pkSm'));
  assert.deepEqual(x25519Public(b('skRm')), b('pkRm'));
  const sealed = authEncap(b('skSm'), b('pkRm'), b('skEm'));
  assert.deepEqual(sealed.enc, b('enc'));
  assert.deepEqual(sealed.sharedSecret, b('sharedSecret'));
  assert.deepEqual(authDecap(b('skRm'), b('pkSm'), b('enc')), b('sharedSecret'));
});
test('Auth AES-256 encryption authenticates the sender, recipient and aad', () => {
  const sealed = hpkeSeal(b('skSm'), b('pkRm'), b('info'), b('aad'), b('pt'));
  assert.deepEqual(
    hpkeOpen(b('skRm'), b('pkSm'), sealed.enc, b('info'), b('aad'), sealed.ciphertext),
    b('pt'),
  );
  for (const [recipient, sender, aad, ct] of [
    [b('skEm'), b('pkSm'), b('aad'), sealed.ciphertext],
    [b('skRm'), b('pkEm'), b('aad'), sealed.ciphertext],
    [b('skRm'), b('pkSm'), Buffer.from('changed'), sealed.ciphertext],
    [b('skRm'), b('pkSm'), b('aad'), Buffer.alloc(16)],
  ])
    assert.throws(() => hpkeOpen(recipient, sender, sealed.enc, b('info'), aad, ct), {
      code: 'invalid_request',
    });
});
