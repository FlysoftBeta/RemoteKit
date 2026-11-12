import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

export const MAX_TRANSPORT = 4 * 1024 * 1024;
export const MAX_CIPHERTEXT = MAX_TRANSPORT + 16;
const EMPTY = Buffer.alloc(0);
const PROTOCOL = 'Noise_IK_25519_AESGCM_SHA256';
const PRIVATE_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const PUBLIC_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

function hash(data: Uint8Array) {
  return createHash('sha256').update(data).digest();
}
function hmac(key: Uint8Array, data: Uint8Array) {
  return createHmac('sha256', key).update(data).digest();
}
function hkdf(key: Uint8Array, input: Uint8Array) {
  const secret = hmac(key, input);
  const result: Buffer[] = [];
  let previous: Buffer = EMPTY;
  for (let index = 1; index <= 2; index++) {
    previous = hmac(secret, Buffer.concat([previous, Buffer.from([index])]));
    result.push(previous);
  }
  return result;
}

export class CipherState {
  private nonce = 0n;
  private failed = false;
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('Invalid Noise key');
  }
  get closed() {
    return this.failed || this.nonce >= 0xffffffffffffffffn;
  }
  private nextNonce() {
    if (this.failed || this.nonce >= 0xffffffffffffffffn) {
      this.failed = true;
      throw new Error('Noise cipher exhausted or closed');
    }
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64BE(this.nonce++, 4);
    return nonce;
  }
  encrypt(plaintext: Buffer, aad: Buffer = EMPTY): Buffer {
    if (plaintext.length > MAX_TRANSPORT) throw new Error('Noise message exceeds 4 MiB');
    const cipher = createCipheriv('aes-256-gcm', this.key, this.nextNonce());
    cipher.setAAD(aad);
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  }
  decrypt(ciphertext: Buffer, aad: Buffer = EMPTY): Buffer {
    try {
      if (ciphertext.length < 16 || ciphertext.length > MAX_CIPHERTEXT)
        throw new Error('Invalid Noise ciphertext size');
      const decipher = createDecipheriv('aes-256-gcm', this.key, this.nextNonce());
      decipher.setAAD(aad);
      decipher.setAuthTag(ciphertext.subarray(-16));
      return Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
}

export interface Transport {
  send: CipherState;
  receive: CipherState;
}

function privateKeyObject(key: Buffer): KeyObject {
  if (key.length !== 32) throw new Error('Invalid X25519 private key');
  return createPrivateKey({ key: Buffer.concat([PRIVATE_PREFIX, key]), format: 'der', type: 'pkcs8' });
}
export function publicKey(key: Buffer): Buffer {
  return Buffer.from(
    createPublicKey(privateKeyObject(key)).export({ format: 'der', type: 'spki' }).subarray(-32),
  );
}
function dh(key: KeyObject, remote: Buffer): Buffer {
  if (remote.length !== 32) throw new Error('Invalid X25519 public key');
  return diffieHellman({
    privateKey: key,
    publicKey: createPublicKey({ key: Buffer.concat([PUBLIC_PREFIX, remote]), format: 'der', type: 'spki' }),
  });
}

export class NoiseHandshake {
  private h: Buffer;
  private ck: Buffer;
  private cipher?: CipherState;
  private readonly staticKey: KeyObject;
  private readonly ephemeralKey: KeyObject;
  private readonly ephemeralPublic: Buffer;
  private remoteEphemeral?: Buffer;
  private remoteStatic?: Buffer;
  private step = 0;
  private failed = false;
  private didSplit = false;
  constructor(
    readonly role: 'initiator' | 'responder',
    privateKey: Buffer,
    responderPublicKey?: Buffer,
    prologue = Buffer.from('remotekit-cluster-2'),
    ephemeral = randomBytes(32),
  ) {
    this.staticKey = privateKeyObject(privateKey);
    this.ephemeralKey = privateKeyObject(ephemeral);
    this.ephemeralPublic = publicKey(ephemeral);
    if (role === 'initiator') {
      if (responderPublicKey?.length !== 32) throw new Error('IK requires responder public key');
      this.remoteStatic = Buffer.from(responderPublicKey);
    } else if (responderPublicKey !== undefined) throw new Error('Responder public key must be local');
    const name = Buffer.from(PROTOCOL);
    this.h = name.length <= 32 ? Buffer.concat([name, Buffer.alloc(32 - name.length)]) : hash(name);
    this.ck = this.h;
    this.mixHash(prologue);
    this.mixHash(role === 'initiator' ? this.remoteStatic! : publicKey(privateKey));
  }
  private mixHash(data: Buffer) {
    this.h = hash(Buffer.concat([this.h, data]));
  }
  private mixKey(data: Buffer) {
    const [ck, key] = hkdf(this.ck, data);
    this.ck = ck;
    this.cipher = new CipherState(key);
  }
  private encrypt(data: Buffer): Buffer {
    const encrypted = this.cipher!.encrypt(data, this.h);
    this.mixHash(encrypted);
    return encrypted;
  }
  private decrypt(data: Buffer): Buffer {
    const plain = this.cipher!.decrypt(data, this.h);
    this.mixHash(data);
    return plain;
  }
  private check(writing: boolean) {
    if (this.failed || this.step > 1 || writing !== ((this.role === 'initiator') === (this.step === 0)))
      throw new Error('Invalid Noise handshake state');
  }
  writeMessage(payload: Buffer): Buffer {
    this.check(true);
    try {
      const overhead = this.step === 0 ? 96 : 48;
      if (payload.length + overhead > 65535) throw new Error('Noise handshake too large');
      this.mixHash(this.ephemeralPublic);
      const parts = [this.ephemeralPublic];
      if (this.step === 0) {
        this.mixKey(dh(this.ephemeralKey, this.remoteStatic!));
        const ownPublic = Buffer.from(
          createPublicKey(this.staticKey).export({ format: 'der', type: 'spki' }).subarray(-32),
        );
        parts.push(this.encrypt(ownPublic));
        this.mixKey(dh(this.staticKey, this.remoteStatic!));
      } else {
        this.mixKey(dh(this.ephemeralKey, this.remoteEphemeral!));
        this.mixKey(dh(this.ephemeralKey, this.remoteStatic!));
      }
      parts.push(this.encrypt(payload));
      this.step++;
      return Buffer.concat(parts);
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
  readMessage(message: Buffer): Buffer {
    this.check(false);
    try {
      if (message.length < (this.step === 0 ? 96 : 48) || message.length > 65535)
        throw new Error('Invalid Noise handshake size');
      this.remoteEphemeral = Buffer.from(message.subarray(0, 32));
      this.mixHash(this.remoteEphemeral);
      let offset = 32;
      if (this.step === 0) {
        this.mixKey(dh(this.staticKey, this.remoteEphemeral));
        this.remoteStatic = this.decrypt(message.subarray(32, 80));
        this.mixKey(dh(this.staticKey, this.remoteStatic));
        offset = 80;
      } else {
        this.mixKey(dh(this.ephemeralKey, this.remoteEphemeral));
        this.mixKey(dh(this.staticKey, this.remoteEphemeral));
      }
      const payload = this.decrypt(message.subarray(offset));
      this.step++;
      return payload;
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
  get remotePublicKey() {
    if (this.failed || this.step < 1 || !this.remoteStatic) throw new Error('Unauthenticated Noise identity');
    return Buffer.from(this.remoteStatic);
  }
  get handshakeHash() {
    return Buffer.from(this.h);
  }
  split(): Transport {
    if (this.failed || this.step !== 2 || this.didSplit)
      throw new Error('Noise handshake incomplete or already split');
    this.didSplit = true;
    const [first, second] = hkdf(this.ck, EMPTY).map((key) => new CipherState(key));
    return this.role === 'initiator' ? { send: first, receive: second } : { send: second, receive: first };
  }
}
