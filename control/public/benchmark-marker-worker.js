// Internal benchmark worker. The bitmap is a snapshot of the already painted
// plane; no video/decoder source is available in this realm.
import { decodeMarker, MARKER_WIDTH, MARKER_HEIGHT } from './marker-codec.js';

let context;
try {
  context = new OffscreenCanvas(MARKER_WIDTH, MARKER_HEIGHT).getContext('2d');
  if (!context) throw new Error('OffscreenCanvas 2D context unavailable');
  self.postMessage({ type: 'ready' });
} catch (error) { self.postMessage({ type: 'init-error', error: String(error) }); }

self.onmessage = ({ data }) => {
  const { id, bitmap } = data;
  let result;
  try {
    const drawAt = performance.now();
    // Each job owns a complete new sample. Transparent input must not expose
    // pixels (and a valid CRC) left behind by the previous bitmap.
    context.clearRect(0, 0, MARKER_WIDTH, MARKER_HEIGHT);
    context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, MARKER_WIDTH, MARKER_HEIGHT);
    const readAt = performance.now();
    const pixels = context.getImageData(0, 0, MARKER_WIDTH, MARKER_HEIGHT);
    const decodeAt = performance.now();
    const marker = decodeMarker(pixels);
    const endedAt = performance.now();
    result = { id, marker, costs: { workerDrawMs: readAt - drawAt, workerReadbackMs: decodeAt - readAt, workerDecodeMs: endedAt - decodeAt, workerTotalMs: endedAt - drawAt } };
  } catch (error) { result = { id, error: String(error) }; }
  finally { bitmap.close(); }
  self.postMessage({ ...result, bitmapClosed: true });
};
