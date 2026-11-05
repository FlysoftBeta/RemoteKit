import test from 'node:test';
import assert from 'node:assert/strict';
import {
  drawMarker,
  decodeMarker,
  percentiles,
  MARKER_WIDTH,
  MARKER_HEIGHT,
} from '../public/marker-codec.js';
test('pixel marker survives level shifts, validates checksum and uint32 wrap', () => {
  const image = {
    width: MARKER_WIDTH,
    height: MARKER_HEIGHT,
    data: new Uint8ClampedArray(MARKER_WIDTH * MARKER_HEIGHT * 4),
    colorSpace: 'srgb',
  } as ImageData;
  const context = {
    fillStyle: '',
    fillRect(x: number, y: number, width: number, height: number) {
      const colors: Record<string, number[]> = {
        '#fff': [235, 235, 235],
        '#000': [20, 20, 20],
        '#00ffff': [15, 230, 235],
        '#ff00ff': [230, 15, 235],
      };
      const rgb = colors[this.fillStyle];
      for (let row = y; row < y + height; row++)
        for (let col = x; col < x + width; col++)
          image.data.set([...rgb, 255], (row * MARKER_WIDTH + col) * 4);
    },
  };
  drawMarker(context as unknown as CanvasRenderingContext2D, 0xffffffff, 0x80000001, 65535);
  assert.deepEqual(decodeMarker(image), { frameId: 0xffffffff, timestamp: 0x80000001, stimulus: 65535 });
  image.data.fill(0, (24 * MARKER_WIDTH + 8) * 4, (24 * MARKER_WIDTH + 8) * 4 + 4);
  assert.equal(decodeMarker(image), null);
  assert.deepEqual(percentiles([]), { p50: null, p95: null, p99: null });
  assert.deepEqual(percentiles([5, 1, 4, 3, 2]), { p50: 3, p95: 5, p99: 5 });
});
