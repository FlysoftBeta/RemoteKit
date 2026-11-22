// Presents the received track in a <video> and, for every presented frame, measures how much of a
// downsampled copy is black. A frame whose pixels are almost all near zero is "black": encoded or
// decoded content never produces that from the schedlab fixtures, which have no black regions.
const WIDTH = 96,
  HEIGHT = 54,
  DARK = 12;
export function startBlackProbe(peer, send) {
  const video = document.createElement('video');
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  document.body.append(video);
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  let batch = [];
  setInterval(() => {
    if (batch.length) send({ type: 'probe', frames: batch.splice(0) });
  }, 250);
  const sample = (_now, metadata) => {
    context.drawImage(video, 0, 0, WIDTH, HEIGHT);
    const pixels = context.getImageData(0, 0, WIDTH, HEIGHT).data;
    let sum = 0,
      dark = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i],
        g = pixels[i + 1],
        b = pixels[i + 2];
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (r <= DARK && g <= DARK && b <= DARK) ++dark;
    }
    const count = pixels.length / 4;
    batch.push({
      at: performance.timeOrigin + performance.now(),
      rtpTimestamp: metadata.rtpTimestamp,
      width: metadata.width,
      height: metadata.height,
      presented: metadata.presentedFrames,
      mean: Math.round((sum / count) * 10) / 10,
      dark: Math.round((dark / count) * 1000) / 1000,
    });
    video.requestVideoFrameCallback(sample);
  };
  peer.addEventListener('track', ({ track }) => {
    video.srcObject = new MediaStream([track]);
    video.play().catch((error) => send({ type: 'receiverError', message: String(error) }));
    video.requestVideoFrameCallback(sample);
  });
}
