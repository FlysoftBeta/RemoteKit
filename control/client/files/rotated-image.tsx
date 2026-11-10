import { Box } from '@mui/material';
import { useLayoutEffect, useRef, useState } from 'react';

export function RotatedImage({
  src,
  alt,
  turns,
  fit = 'contain',
  onLoad,
  onError,
}: {
  src: string;
  alt: string;
  turns: number;
  fit?: 'cover' | 'contain';
  onLoad?: (image: HTMLImageElement) => void;
  onError: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const swapped = turns % 2 !== 0;
  useLayoutEffect(() => {
    const element = host.current!;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <Box ref={host} sx={{ position: 'absolute', inset: 0 }}>
      <Box
        component="img"
        src={src}
        alt={alt}
        draggable={false}
        onLoad={(event) => onLoad?.(event.currentTarget)}
        onError={onError}
        sx={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          display: 'block',
          width: swapped ? size.height : '100%',
          height: swapped ? size.width : '100%',
          objectFit: turns ? 'contain' : fit,
          transform: `translate(-50%, -50%) rotate(${turns * 90}deg)`,
        }}
      />
    </Box>
  );
}
