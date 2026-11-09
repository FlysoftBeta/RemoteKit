import { Tooltip, Typography, type TypographyProps } from '@mui/material';
import { useRef, useState } from 'react';

/** Single-line text whose tooltip shows the full text, only while it is actually truncated. */
export function OverflowText({
  tip,
  children,
  ...props
}: Omit<TypographyProps, 'title' | 'noWrap'> & { tip?: string }) {
  const [open, setOpen] = useState(false);
  const text = useRef<HTMLElement>(null);
  return (
    <Tooltip
      title={tip ?? children}
      open={open}
      onOpen={() => {
        const node = text.current;
        if (node && node.scrollWidth > node.clientWidth) setOpen(true);
      }}
      onClose={() => setOpen(false)}
    >
      <Typography noWrap {...props} ref={text}>
        {children}
      </Typography>
    </Tooltip>
  );
}
