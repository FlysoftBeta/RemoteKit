// Shared classic-worker/fixture algorithm. No DOM, full-frame copies or retained input.
(function (scope) {
  function score(pixels, width, height) {
    let mean = 0,
      clipped = 0;
    for (let i = 0; i < pixels.length; i++) {
      mean += pixels[i];
      if (pixels[i] < 12 || pixels[i] > 243) clipped++;
    }
    mean /= pixels.length;
    let tenengrad = 0,
      laplacian = 0,
      noise = 0,
      count = 0;
    const residuals = [];
    for (let y = 1; y < height - 1; y++)
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        const gx =
          pixels[i - width + 1] +
          2 * pixels[i + 1] +
          pixels[i + width + 1] -
          pixels[i - width - 1] -
          2 * pixels[i - 1] -
          pixels[i + width - 1];
        const gy =
          pixels[i + width - 1] +
          2 * pixels[i + width] +
          pixels[i + width + 1] -
          pixels[i - width - 1] -
          2 * pixels[i - width] -
          pixels[i - width + 1];
        const lap = 4 * pixels[i] - pixels[i - 1] - pixels[i + 1] - pixels[i - width] - pixels[i + width];
        tenengrad += gx * gx + gy * gy;
        laplacian += lap * lap;
        // Isolated high frequencies are a noise signal, not evidence of useful edges.
        residuals.push(Math.abs(lap));
        count++;
      }
    tenengrad /= count;
    laplacian /= count;
    residuals.sort((a, b) => a - b);
    noise = residuals[Math.floor(residuals.length * 0.5)] || 0;
    const exposure = Math.min(1, mean / 55, (255 - mean) / 55) * (1 - clipped / pixels.length);
    const penalty = 1 + (noise * noise) / 64;
    return {
      tenengrad,
      laplacian,
      mean,
      noise,
      exposure,
      score: (tenengrad * exposure) / penalty,
      laplacianScore: (laplacian * exposure) / penalty,
    };
  }
  scope.RemoteKitCameraScore = score;
  if (typeof scope.importScripts === 'function')
    scope.onmessage = async (event) => {
      const { id, generation, bitmap, width, height, format, probe } = event.data;
      const reply = (value) => scope.postMessage({ id, generation, ...value });
      if (probe) {
        let canvas;
        try {
          canvas = new OffscreenCanvas(1, 1);
          reply({ supported: !!canvas.getContext('2d') && typeof canvas.convertToBlob === 'function' });
        } catch {
          reply({ supported: false });
        } finally {
          if (canvas) canvas.width = canvas.height = 1;
        }
        return;
      }
      let full, small;
      try {
        let pixels = event.data.pixels,
          w = width,
          h = height;
        const drawStart = performance.now();
        if (bitmap) {
          if (
            width < 1 ||
            height < 1 ||
            width * height > 4 * 1024 * 1024 ||
            bitmap.width !== width ||
            bitmap.height !== height
          )
            throw new Error('invalid bitmap');
          full = new OffscreenCanvas(width, height);
          full.getContext('2d').drawImage(bitmap, 0, 0);
          bitmap.close();
          w = 160;
          h = Math.max(3, Math.round((w * height) / width));
          if (h > 256) {
            h = 256;
            w = Math.max(3, Math.round((h * width) / height));
          }
          small = new OffscreenCanvas(w, h);
          const context = small.getContext('2d');
          context.drawImage(full, 0, 0, w, h);
          const rgba = context.getImageData(0, 0, w, h).data;
          pixels = new Uint8Array(w * h);
          for (let p = 0; p < pixels.length; p++)
            pixels[p] = (rgba[p * 4] * 77 + rgba[p * 4 + 1] * 150 + rgba[p * 4 + 2] * 29) >> 8;
        }
        if (
          !(pixels instanceof Uint8Array) ||
          w < 3 ||
          h < 3 ||
          w * h !== pixels.length ||
          pixels.length > 256 * 256
        )
          throw new Error('invalid scoring input');
        const drawMs = performance.now() - drawStart,
          start = performance.now();
        const result = score(pixels, w, h),
          elapsedMs = performance.now() - start;
        const blobStart = performance.now();
        const blob = full ? await full.convertToBlob({ type: format, quality: 0.92 }) : undefined;
        reply({ result, elapsedMs, drawMs, blob, blobWallMs: performance.now() - blobStart });
      } catch {
        reply({ error: 'photo processing failed' });
      } finally {
        bitmap?.close();
        if (full) full.width = full.height = 1;
        if (small) small.width = small.height = 1;
      }
    };
})(globalThis);
