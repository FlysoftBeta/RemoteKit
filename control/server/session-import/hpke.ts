import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
} from 'node:crypto';
import { RemoteKitError } from '../../shared/errors';

const kemSuite = Buffer.from('4b454d0020', 'hex');
const hpkeSuite = Buffer.from('48504b45002000010002', 'hex');
const version = Buffer.from('HPKE-v1');
const empty = Buffer.alloc(0);
const invalid = () => new RemoteKitError('invalid_request', 'Invalid HPKE ciphertext or key');

function extract(salt: Buffer, ikm: Buffer) {
  return createHmac('sha256', salt).update(ikm).digest();
}
function labeledExtract(suite: Buffer, salt: Buffer, label: string, ikm: Buffer) {
  return extract(salt, Buffer.concat([version, suite, Buffer.from(label), ikm]));
}
function labeledExpand(suite: Buffer, prk: Buffer, label: string, info: Buffer, length: number) {
  const size = Buffer.alloc(2);
  size.writeUInt16BE(length);
  const context = Buffer.concat([size, version, suite, Buffer.from(label), info]);
  const blocks: Buffer[] = [];
  let previous: Buffer = empty;
  for (let i = 1; blocks.length * 32 < length; i++) {
    previous = createHmac('sha256', prk)
      .update(Buffer.concat([previous, context, Buffer.from([i])]))
      .digest();
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}
function x25519Private(raw: Buffer) {
  if (raw.length !== 32) throw invalid();
  // OpenSSL validates the JWK public coordinate against d. Derive x before importing the JWK.
  const seed = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]),
    format: 'der',
    type: 'pkcs8',
  });
  return createPrivateKey({
    key: seed.export({ format: 'jwk' }),
    format: 'jwk',
  });
}
function publicKey(raw: Buffer) {
  if (raw.length !== 32) throw invalid();
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') }, format: 'jwk' });
}
export function x25519Public(rawPrivate: Buffer): Buffer {
  return Buffer.from(createPublicKey(x25519Private(rawPrivate)).export({ format: 'jwk' }).x!, 'base64url');
}
function schedule(dh: Buffer, enc: Buffer, recipient: Buffer, info: Buffer) {
  const prk = labeledExtract(kemSuite, empty, 'eae_prk', dh);
  const shared = labeledExpand(kemSuite, prk, 'shared_secret', Buffer.concat([enc, recipient]), 32);
  const context = Buffer.concat([
    Buffer.from([0]),
    labeledExtract(hpkeSuite, empty, 'psk_id_hash', empty),
    labeledExtract(hpkeSuite, empty, 'info_hash', info),
  ]);
  const secret = labeledExtract(hpkeSuite, shared, 'secret', empty);
  return {
    key: labeledExpand(hpkeSuite, secret, 'key', context, 32),
    nonce: labeledExpand(hpkeSuite, secret, 'base_nonce', context, 12),
  };
}
// Fixed ephemeral keys are for the RFC known-answer test only.
export function hpkeSealWithEphemeral(
  recipientPublic: Buffer,
  info: Buffer,
  aad: Buffer,
  plaintext: Buffer,
  ephemeralPrivate: Buffer,
) {
  const ephemeral = x25519Private(ephemeralPrivate);
  const enc = x25519Public(ephemeralPrivate);
  const dh = diffieHellman({ privateKey: ephemeral, publicKey: publicKey(recipientPublic) });
  const { key, nonce } = schedule(dh, enc, recipientPublic, info);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  return { enc, ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]) };
}
export function hpkeSeal(recipientPublic: Buffer, info: Buffer, aad: Buffer, plaintext: Buffer) {
  try {
    const pair = generateKeyPairSync('x25519');
    const raw = Buffer.from(pair.privateKey.export({ format: 'jwk' }).d!, 'base64url');
    return hpkeSealWithEphemeral(recipientPublic, info, aad, plaintext, raw);
  } catch {
    throw invalid();
  }
}
export function hpkeOpen(
  recipientPrivate: Buffer,
  enc: Buffer,
  info: Buffer,
  aad: Buffer,
  ciphertext: Buffer,
): Buffer {
  try {
    if (ciphertext.length < 16) throw invalid();
    const dh = diffieHellman({ privateKey: x25519Private(recipientPrivate), publicKey: publicKey(enc) });
    const { key, nonce } = schedule(dh, enc, x25519Public(recipientPrivate), info);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(ciphertext.subarray(-16));
    return Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  } catch {
    throw invalid();
  }
}
