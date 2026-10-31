export const MARKER_WIDTH = 256, MARKER_HEIGHT = 112, CELL = 16;
function crc(bytes) { let value = 65535; for (const byte of bytes) { value ^= byte << 8; for (let bit = 0; bit < 8; bit++) value = ((value << 1) ^ (value & 32768 ? 4129 : 0)) & 65535; } return value; }
export function markerBytes(frameId, timestamp, stimulus) {
  const bytes = new Uint8Array(12); const data = new DataView(bytes.buffer);
  data.setUint32(0, frameId >>> 0); data.setUint32(4, timestamp >>> 0); data.setUint16(8, stimulus & 65535); data.setUint16(10, crc(bytes.slice(0, 10))); return bytes;
}
export function drawMarker(ctx, frameId, timestamp, stimulus) {
  const bytes = markerBytes(frameId, timestamp, stimulus);
  for (let col = 0; col < 16; col++) { ctx.fillStyle = col % 2 ? '#ff00ff' : '#00ffff'; ctx.fillRect(col * CELL, 0, CELL, CELL); }
  for (let bit = 0; bit < 96; bit++) { ctx.fillStyle = bytes[bit >> 3] & (128 >> (bit & 7)) ? '#fff' : '#000'; ctx.fillRect((bit % 16) * CELL, (1 + Math.floor(bit / 16)) * CELL, CELL, CELL); }
}
export function decodeMarker(image) {
  if (image.width !== MARKER_WIDTH || image.height !== MARKER_HEIGHT) return null;
  const pixel = (x, y) => { const offset = (y * image.width + x) * 4; return [image.data[offset], image.data[offset + 1], image.data[offset + 2]]; };
  for (let col = 0; col < 16; col++) { const [r, g, b] = pixel(col * CELL + 8, 8); if (b < 140 || (col % 2 ? r < 140 || g > 110 : g < 140 || r > 110)) return null; }
  const bytes = new Uint8Array(12);
  for (let bit = 0; bit < 96; bit++) { const [r, g, b] = pixel((bit % 16) * CELL + 8, (1 + Math.floor(bit / 16)) * CELL + 8); if ((r + g + b) / 3 > 128) bytes[bit >> 3] |= 128 >> (bit & 7); }
  const data = new DataView(bytes.buffer); if (data.getUint16(10) !== crc(bytes.slice(0, 10))) return null;
  return { frameId: data.getUint32(0), timestamp: data.getUint32(4), stimulus: data.getUint16(8) };
}
export function percentiles(values) { if (!values.length) return { p50: null, p95: null, p99: null }; const sorted = [...values].sort((a, b) => a - b); const at = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]; return { p50: at(.5), p95: at(.95), p99: at(.99) }; }
