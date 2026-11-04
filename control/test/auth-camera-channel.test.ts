import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthCameraChannel, packAuthCameraChunk } from '../client/auth-camera-channel';

const binding = { authEpoch: 0x1_1234_5678, challengeId: '12345678-1234-4234-8234-123456789abc' };

test('RGB24 wire omits alpha and writes the grant header little endian', () => {
  const rgba = new Uint8ClampedArray([1, 2, 3, 0, 4, 5, 6, 255]);
  const packet = packAuthCameraChunk({ ...binding, captureId: 10, width: 2, height: 1 }, rgba, 3, 3);
  const header = new DataView(packet);
  assert.equal(header.getUint32(0, true), 0x46414b52);
  assert.equal(header.getUint16(4, true), 1);
  assert.equal(header.getUint16(6, true), 68);
  assert.equal(header.getBigUint64(8, true), BigInt(binding.authEpoch));
  assert.equal(header.getUint32(16, true), 10);
  assert.equal(header.getUint32(20, true), 3);
  assert.equal(header.getUint32(24, true), 6);
  assert.equal(header.getUint16(28, true), 2);
  assert.equal(header.getUint16(30, true), 1);
  assert.equal(new TextDecoder().decode(packet.slice(32, 68)), binding.challengeId);
  assert.deepEqual([...new Uint8Array(packet, 68)], [4, 5, 6]);
});

test('camera produces only server-granted RGB frames and cancels a backpressured grant', async t => {
  class Channel extends EventTarget {
    readyState = 'open';
    bufferedAmount = 0;
    bufferedAmountLowThreshold = 0;
    onmessage?: (event: { data: string }) => void;
    sent: (string | ArrayBuffer)[] = [];
    send(value: string | ArrayBuffer) { this.sent.push(value); }
    close() { this.readyState = 'closed'; }
    emit(value: object) { this.onmessage?.({ data: JSON.stringify({ version: 1, ...binding, ...value }) }); }
  }
  const video = { videoWidth: 160, videoHeight: 120, readyState: 2, currentTime: 1, play: async () => {}, pause() {} };
  let draws = 0;
  const document = {
    hidden: false,
    createElement: (kind: string) => kind === 'video' ? video : {
      width: 0, height: 0, getContext: () => ({
        drawImage: () => draws++,
        getImageData: () => ({ data: new Uint8ClampedArray(160 * 120 * 4) }),
      }),
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  t.after(() => previous ? Object.defineProperty(globalThis, 'document', previous) : Reflect.deleteProperty(globalThis, 'document'));
  const camera = new AuthCameraChannel(() => {});
  const channel = new Channel();
  camera.bind(channel as unknown as RTCDataChannel);
  camera.setSource({ getVideoTracks: () => [{ readyState: 'live', muted: false }] } as unknown as MediaStream, binding);
  const binary = () => channel.sent.filter((packet): packet is ArrayBuffer => packet instanceof ArrayBuffer);
  const config = { type: 'auth.camera.config', width: 160, height: 120, fps: 5, format: 'rgb24', chunkBytes: 16384 };
  const grant = (captureId: number) => channel.emit({ type: 'auth.camera.frame', captureId });
  assert.deepEqual(JSON.parse(channel.sent[0] as string), { version: 1, ...binding, type: 'auth.camera.ready', width: 160, height: 120, format: 'rgb24', maxFps: 5 });
  grant(1);
  channel.emit({ ...config, fps: 6 });
  grant(2);
  assert.equal(draws, 0);
  channel.emit(config);
  assert.equal(draws, 0);
  channel.emit({ type: 'auth.camera.frame', captureId: 3, authEpoch: binding.authEpoch - 1 });
  assert.equal(draws, 0);
  grant(3);
  assert.equal(draws, 1);
  let offset = 0;
  for (const packet of binary()) {
    assert.equal(new DataView(packet).getUint32(20, true), offset);
    assert.ok(packet.byteLength <= 68 + 16384);
    offset += packet.byteLength - 68;
  }
  assert.equal(offset, 160 * 120 * 3);
  assert.ok(camera.hasRecentFrame(binding.challengeId));
  grant(3);
  grant(4);
  assert.equal(draws, 1, 'duplicate grant or duplicate source frame does not draw');
  video.currentTime++;
  channel.bufferedAmount = 256 * 1024;
  grant(5);
  assert.equal(draws, 2);
  camera.setSource(undefined);
  channel.bufferedAmount = 0;
  channel.dispatchEvent(new Event('bufferedamountlow'));
  await Promise.resolve();
  assert.equal(binary().reduce((bytes, packet) => bytes + packet.byteLength - 68, 0), offset);
  assert.equal(camera.hasRecentFrame(binding.challengeId), false);
});
