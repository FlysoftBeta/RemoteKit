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

export const MAX_TRANSPORT = 20 * 1024 * 1024;
export const MAX_CIPHERTEXT = MAX_TRANSPORT + 16;
const EMPTY = Buffer.alloc(0);
const PROTOCOL = 'Noise_NNpsk0_25519_AESGCM_SHA256';
const PRIVATE_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const PUBLIC_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

function hash(data: Uint8Array) {
  return createHash('sha256').update(data).digest();
}
function hmac(key: Uint8Array, data: Uint8Array) {
  return createHmac('sha256', key).update(data).digest();
}
function hkdf(key: Uint8Array, input: Uint8Array, count: number) {
  const secret = hmac(key, input);
  const result: Buffer[] = [];
  let previous: Buffer = EMPTY;
  for (let index = 1; index <= count; index++) {
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
    if (plaintext.length > MAX_TRANSPORT) throw new Error('Noise message exceeds 20 MiB');
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

export class NoiseHandshake {
  private h: Buffer;
  private ck: Buffer;
  private cipher?: CipherState;
  private readonly privateKey: KeyObject;
  private readonly publicKey: Buffer;
  private remoteKey?: Buffer;
  private step = 0;
  private failed = false;
  private didSplit = false;
  constructor(
    readonly role: 'initiator' | 'responder',
    private readonly psk: Buffer,
    prologue = Buffer.from('remotekit-cluster-1'),
    ephemeral = randomBytes(32),
  ) {
    if (psk.length !== 32 || ephemeral.length !== 32) throw new Error('Invalid Noise key');
    const name = Buffer.from(PROTOCOL);
    this.h = name.length <= 32 ? Buffer.concat([name, Buffer.alloc(32 - name.length)]) : hash(name);
    this.ck = this.h;
    this.mixHash(prologue);
    this.privateKey = createPrivateKey({
      key: Buffer.concat([PRIVATE_PREFIX, ephemeral]),
      format: 'der',
      type: 'pkcs8',
    });
    this.publicKey = createPublicKey(this.privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  }
  private mixHash(data: Buffer) {
    this.h = hash(Buffer.concat([this.h, data]));
  }
  private mixKey(data: Buffer) {
    const [ck, key] = hkdf(this.ck, data, 2);
    this.ck = ck;
    this.cipher = new CipherState(key);
  }
  private tokens(ephemeral: Buffer) {
    if (this.step === 0) {
      const [ck, tempHash, key] = hkdf(this.ck, this.psk, 3);
      this.ck = ck;
      this.mixHash(tempHash);
      this.cipher = new CipherState(key);
    }
    this.mixHash(ephemeral);
    this.mixKey(ephemeral);
    if (this.step === 1) {
      const publicKey = createPublicKey({
        key: Buffer.concat([PUBLIC_PREFIX, this.remoteKey!]),
        format: 'der',
        type: 'spki',
      });
      this.mixKey(diffieHellman({ privateKey: this.privateKey, publicKey }));
    }
  }
  private check(writing: boolean) {
    if (this.failed || this.step > 1 || writing !== ((this.role === 'initiator') === (this.step === 0)))
      throw new Error('Invalid Noise handshake state');
  }
  writeMessage(payload: Buffer): Buffer {
    this.check(true);
    try {
      if (payload.length + 48 > 65535) throw new Error('Noise handshake too large');
      this.tokens(this.publicKey);
      const ciphertext = this.cipher!.encrypt(payload, this.h);
      this.mixHash(ciphertext);
      this.step++;
      return Buffer.concat([this.publicKey, ciphertext]);
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
  readMessage(message: Buffer): Buffer {
    this.check(false);
    try {
      if (message.length < 48 || message.length > 65535) throw new Error('Invalid Noise handshake size');
      this.remoteKey = message.subarray(0, 32);
      this.tokens(this.remoteKey);
      const ciphertext = message.subarray(32);
      const payload = this.cipher!.decrypt(ciphertext, this.h);
      this.mixHash(ciphertext);
      this.step++;
      return payload;
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
  get handshakeHash() {
    return Buffer.from(this.h);
  }
  split(): Transport {
    if (this.failed || this.step !== 2 || this.didSplit)
      throw new Error('Noise handshake incomplete or already split');
    this.didSplit = true;
    const [first, second] = hkdf(this.ck, EMPTY, 2).map((key) => new CipherState(key));
    return this.role === 'initiator' ? { send: first, receive: second } : { send: second, receive: first };
  }
}
