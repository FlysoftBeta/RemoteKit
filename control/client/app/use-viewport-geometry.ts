import { useLayoutEffect, useState, type RefObject } from 'react';
import type { ViewportGeometry } from './viewport-geometry';

export function useViewportGeometry(
  viewport: RefObject<HTMLElement | null>,
  canvas: RefObject<HTMLCanvasElement | null>,
) {
  const [geometry, setGeometry] = useState<ViewportGeometry>();
  useLayoutEffect(() => {
    const section = viewport.current;
    const plane = canvas.current;
    if (!section || !plane) return;
    const measure = () => {
      const next = {
        width: section.clientWidth,
        height: section.clientHeight,
        canvas: {
          left: plane.offsetLeft,
          top: plane.offsetTop,
          width: plane.offsetWidth,
          height: plane.offsetHeight,
        },
      };
      setGeometry((previous) =>
        previous &&
        previous.width === next.width &&
        previous.height === next.height &&
        Object.keys(next.canvas).every(
          (key) =>
            previous.canvas[key as keyof typeof next.canvas] === next.canvas[key as keyof typeof next.canvas],
        )
          ? previous
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(section);
    observer.observe(plane);
    return () => observer.disconnect();
  }, [viewport, canvas]);
  return geometry;
}
