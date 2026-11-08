import { MAX_CIPHERTEXT, MAX_TRANSPORT } from './noise';

export const MAX_JSON = 1024 * 1024;
// JSON escaping can expand the 3 MiB clipboard payload to 18 MiB.
const MAX_CLIPBOARD_JSON = 20 * 1024 * 1024 - 1;
function jsonLimit(value: Record<string, unknown>) {
  if (value.type === 'clipboard.changed') return 4 * 1024 * 1024 - 1;
  if (
    value.method === 'session.clipboard.set' ||
    ((value.method === 'session.open' || value.method === 'session.ensure') && value.clipboard)
  )
    return MAX_CLIPBOARD_JSON;
  return MAX_JSON;
}
const decoder = new TextDecoder('utf-8', { fatal: true });
export function jsonObject(bytes: Buffer): Record<string, any> {
  const value: unknown = JSON.parse(decoder.decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object');
  return value as Record<string, any>;
}
export function encodeJson(value: object): Buffer {
  const json = Buffer.from(JSON.stringify(value));
  if (json.length > jsonLimit(value as Record<string, unknown>)) throw new Error('JSON frame too large');
  return Buffer.concat([Buffer.from([1]), json]);
}
export function encodeBinary(header: object, bytes: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(header));
  if (json.length > MAX_JSON || json.length + bytes.length + 5 > MAX_TRANSPORT)
    throw new Error('Binary frame too large');
  const prefix = Buffer.alloc(5);
  prefix[0] = 2;
  prefix.writeUInt32LE(json.length, 1);
  return Buffer.concat([prefix, json, bytes]);
}
export function decodeFrame(
  bytes: Buffer,
):
  | { kind: 'json'; message: Record<string, any> }
  | { kind: 'binary'; header: Record<string, any>; bytes: Buffer } {
  if (bytes.length > MAX_TRANSPORT) throw new Error('Frame too large');
  if (bytes[0] === 1) {
    const message = jsonObject(bytes.subarray(1));
    if (bytes.length - 1 > jsonLimit(message)) throw new Error('JSON frame too large');
    return { kind: 'json', message };
  }
  if (bytes[0] === 2 && bytes.length >= 5) {
    const length = bytes.readUInt32LE(1);
    if (length > MAX_JSON || length > bytes.length - 5) throw new Error('Invalid binary header length');
    return {
      kind: 'binary',
      header: jsonObject(bytes.subarray(5, 5 + length)),
      bytes: bytes.subarray(5 + length),
    };
  }
  throw new Error('Invalid frame kind or size');
}
export function encodeStdio(message: Buffer) {
  if (!message.length || message.length > MAX_CIPHERTEXT) throw new Error('Invalid stdio frame size');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(message.length);
  return Buffer.concat([length, message]);
}
export class StdioDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  push(bytes: Buffer): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, bytes]);
    const frames: Buffer[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (!length || length > MAX_CIPHERTEXT) throw new Error('Invalid stdio frame length');
      if (this.buffer.length < length + 4) break;
      frames.push(this.buffer.subarray(4, length + 4));
      this.buffer = this.buffer.subarray(length + 4);
    }
    return frames;
  }
  end() {
    if (this.buffer.length) throw new Error('Truncated stdio frame');
  }
}
