import { Tooltip, Typography, type TypographyProps } from '@mui/material';
import { useState } from 'react';

/** Single-line text whose tooltip shows the full text, only while it is actually truncated. */
export function OverflowText({
  tip,
  children,
  ...props
}: Omit<TypographyProps, 'title' | 'noWrap'> & { tip?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      title={tip ?? children}
      open={open}
      onOpen={(event) => {
        const text = event.currentTarget as HTMLElement;
        if (text.scrollWidth > text.clientWidth) setOpen(true);
      }}
      onClose={() => setOpen(false)}
    >
      <Typography noWrap {...props}>
        {children}
      </Typography>
    </Tooltip>
  );
}
