import { contrastColor } from './launcher-layout';

const colors = new Map<string, string>();

export function dominantColor(image: HTMLImageElement, key: string): string | undefined {
  const cached = colors.get(key);
  if (cached) return cached;
  if (!image.naturalWidth) return;
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.drawImage(image, 0, 0, 16, 16);
  const pixels = context.getImageData(0, 0, 16, 16).data;
  const sums = [0, 0, 0];
  let weight = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3] / 255;
    for (let channel = 0; channel < 3; channel++) sums[channel] += pixels[index + channel] * alpha;
    weight += alpha;
  }
  if (!weight) return;
  const color = contrastColor(
    '#' +
      sums
        .map((sum) =>
          Math.round(sum / weight)
            .toString(16)
            .padStart(2, '0'),
        )
        .join(''),
  );
  colors.set(key, color);
  return color;
}
