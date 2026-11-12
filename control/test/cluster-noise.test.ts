import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CipherState, MAX_TRANSPORT, NoiseHandshake, publicKey } from '../server/cluster/noise';
import { decodeFrame, encodeBinary, encodeJson, encodeStdio, StdioDecoder } from '../server/cluster/frames';
import limits from '../../protocol/limits.json';

test('Noise handshake accepts its encoded boundary and rejects one byte past', () => {
  const key = Buffer.alloc(32, 1);
  const initiator = new NoiseHandshake('initiator', key, publicKey(key));
  const responder = new NoiseHandshake('responder', key);
  const payload = Buffer.alloc(limits.handshakeBytes - 96, 42);
  const wire = initiator.writeMessage(payload);
  assert.equal(wire.length, limits.handshakeBytes);
  assert.deepEqual(responder.readMessage(wire), payload);
  const reply = Buffer.alloc(limits.handshakeBytes - 48, 7);
  assert.deepEqual(initiator.readMessage(responder.writeMessage(reply)), reply);
  assert.throws(() =>
    new NoiseHandshake('initiator', key, publicKey(key)).writeMessage(Buffer.alloc(payload.length + 1)),
  );
  assert.throws(() =>
    new NoiseHandshake('responder', key).readMessage(Buffer.alloc(limits.handshakeBytes + 1)),
  );
});

test('Noise matches cacophony handshake hash and every handshake/transport ciphertext', () => {
  const vector = JSON.parse(
    readFileSync(new URL('../../protocol/cluster-noise-vectors.json', import.meta.url), 'utf8'),
  ).vectors[0];
  const bytes = (value: string) => Buffer.from(value, 'hex');
  const initiator = new NoiseHandshake(
    'initiator',
    bytes(vector.init_static),
    bytes(vector.init_remote_static),
    bytes(vector.init_prologue),
    bytes(vector.init_ephemeral),
  );
  const responder = new NoiseHandshake(
    'responder',
    bytes(vector.resp_static),
    undefined,
    bytes(vector.resp_prologue),
    bytes(vector.resp_ephemeral),
  );
  for (let index = 0; index < 2; index++) {
    const sender = index === 0 ? initiator : responder;
    const receiver = index === 0 ? responder : initiator;
    const { payload, ciphertext } = vector.messages[index];
    assert.equal(sender.writeMessage(bytes(payload)).toString('hex'), ciphertext);
    assert.deepEqual(receiver.readMessage(bytes(ciphertext)), bytes(payload));
  }
  assert.equal(initiator.handshakeHash.toString('hex'), vector.handshake_hash);
  assert.equal(responder.handshakeHash.toString('hex'), vector.handshake_hash);
  const peers = [initiator.split(), responder.split()];
  for (let index = 2; index < vector.messages.length; index++) {
    const { payload, ciphertext } = vector.messages[index];
    assert.equal(peers[index % 2].send.encrypt(bytes(payload)).toString('hex'), ciphertext);
    assert.deepEqual(peers[1 - (index % 2)].receive.decrypt(bytes(ciphertext)), bytes(payload));
  }
});

test('Noise enforces transport bound, terminal authentication failure and nonce exhaustion', () => {
  const key = Buffer.alloc(32, 1);
  const sender = new CipherState(key);
  const receiver = new CipherState(key);
  const plaintext = Buffer.alloc(MAX_TRANSPORT, 42);
  assert.deepEqual(receiver.decrypt(sender.encrypt(plaintext)), plaintext);
  assert.throws(() => sender.encrypt(Buffer.alloc(MAX_TRANSPORT + 1)));
  const valid = sender.encrypt(Buffer.from('second'));
  const tampered = Buffer.from(valid);
  tampered[0] ^= 1;
  assert.throws(() => receiver.decrypt(tampered));
  assert.throws(() => receiver.decrypt(valid));
  assert.throws(() => new CipherState(key).decrypt(Buffer.alloc(MAX_TRANSPORT + 17)));
  assert.throws(() => new CipherState(key).decrypt(Buffer.alloc(15)));
  const exhausted = new CipherState(key);
  (exhausted as any).nonce = 0xfffffffffffffffen;
  exhausted.encrypt(Buffer.alloc(0));
  assert.throws(() => exhausted.encrypt(Buffer.alloc(0)));
  const first = new NoiseHandshake('initiator', key, publicKey(key));
  const wrong = new NoiseHandshake('responder', Buffer.alloc(32, 2));
  const message = first.writeMessage(Buffer.from('{}'));
  assert.throws(() => wrong.readMessage(message));
  assert.throws(() => wrong.readMessage(message));
});

test('JSON, binary and fragmented stdio frames round trip and reject malformed lengths/kinds', () => {
  const json = encodeJson({ type: 'test', text: '世界' });
  assert.deepEqual(decodeFrame(json), { kind: 'json', message: { type: 'test', text: '世界' } });
  const bytes = Buffer.from([0, 1, 255]);
  const binary = encodeBinary({ offset: 42 }, bytes);
  assert.deepEqual(decodeFrame(binary), { kind: 'binary', header: { offset: 42 }, bytes });
  const decoder = new StdioDecoder();
  const stream = Buffer.concat([encodeStdio(json), encodeStdio(binary)]);
  const frames: Buffer[] = [];
  for (const byte of stream) frames.push(...decoder.push(Buffer.from([byte])));
  decoder.end();
  assert.deepEqual(frames, [json, binary]);
  assert.throws(() => decodeFrame(Buffer.from([3])));
  assert.throws(() => decodeFrame(Buffer.from([1, 0xff])));
  assert.throws(() => decodeFrame(Buffer.from([1, ...Buffer.from('[]')])));
  assert.throws(() => decodeFrame(Buffer.from([2, 255, 255, 255, 255])));
  assert.throws(() => encodeJson({ text: 'a'.repeat(1024 * 1024) }));
  assert.throws(() => new StdioDecoder().push(Buffer.from([255, 255, 255, 255])));
  const truncated = new StdioDecoder();
  truncated.push(Buffer.from([1]));
  assert.throws(() => truncated.end());
});
