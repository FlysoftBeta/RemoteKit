import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hpkeOpen, hpkeSealWithEphemeral, x25519Public } from '../server/session-import/hpke';

// Official RFC 9180 vectors: cfrg/draft-irtf-cfrg-hpke/test-vectors.json.
const vector = JSON.parse(
  readFileSync(new URL('../../protocol/session-import/hpke-vector.json', import.meta.url), 'utf8'),
);
const b = (name: string) => Buffer.from(vector[name], 'hex');
test('RFC 9180 base X25519/HKDF-SHA256/AES-256-GCM opens and reproduces the first encryption', () => {
  assert.deepEqual(x25519Public(b('skRm')), b('pkRm'));
  assert.deepEqual(x25519Public(b('skEm')), b('pkEm'));
  assert.deepEqual(hpkeOpen(b('skRm'), b('enc'), b('info'), b('aad'), b('ct')), b('pt'));
  const sealed = hpkeSealWithEphemeral(b('pkRm'), b('info'), b('aad'), b('pt'), b('skEm'));
  assert.deepEqual(sealed.enc, b('enc'));
  assert.deepEqual(sealed.ciphertext, b('ct'));
  assert.throws(() => hpkeOpen(Buffer.alloc(32, 1), b('enc'), b('info'), b('aad'), b('ct')), {
    code: 'invalid_request',
  });
  const changed = b('ct');
  changed[0] ^= 1;
  assert.throws(() => hpkeOpen(b('skRm'), b('enc'), b('info'), b('aad'), changed), {
    code: 'invalid_request',
  });
});
