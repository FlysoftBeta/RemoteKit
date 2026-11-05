// Self-contained factory: the identical codec runs in the fixture and probe.
export function createMarkerCodec() {
  const width = 224,
    height = 80;
  function crc16(bytes) {
    let crc = 0xffff;
    for (const byte of bytes) {
      crc ^= byte << 8;
      for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
    }
    return crc;
  }
  function encode(value, sequence) {
    const bytes = new Uint8Array(10);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0x524b);
    view.setUint32(2, value >>> 0);
    view.setUint16(6, sequence & 0xffff);
    view.setUint16(8, crc16(bytes.subarray(0, 8)));
    return bytes;
  }
  function decode(bytes) {
    if (bytes.length !== 10) return { ok: false, reason: 'length' };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint16(0) !== 0x524b) return { ok: false, reason: 'magic' };
    if (view.getUint16(8) !== crc16(bytes.subarray(0, 8))) return { ok: false, reason: 'crc' };
    return { ok: true, value: view.getUint32(2), sequence: view.getUint16(6) };
  }
  function draw(ctx, bytes) {
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = 'black';
    for (let bit = 0; bit < 80; bit++) {
      if (bytes[bit >>> 3] & (1 << (bit & 7)))
        ctx.fillRect((bit % 16) * 14, Math.floor(bit / 16) * 16, 14, 16);
    }
  }
  function readPixels(pixels) {
    if (pixels.length !== width * height * 4) return { ok: false, reason: 'dimensions' };
    const bytes = new Uint8Array(10);
    for (let bit = 0; bit < 80; bit++) {
      const x = (bit % 16) * 14 + 7,
        y = Math.floor(bit / 16) * 16 + 8;
      let brightness = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const offset = ((y + dy) * width + x + dx) * 4;
          brightness += (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3;
        }
      }
      brightness /= 9;
      if (brightness >= 80 && brightness <= 175) return { ok: false, reason: 'ambiguous' };
      if (brightness < 80) bytes[bit >>> 3] |= 1 << (bit & 7);
    }
    return decode(bytes);
  }
  return { width, height, crc16, encode, decode, draw, readPixels };
}
