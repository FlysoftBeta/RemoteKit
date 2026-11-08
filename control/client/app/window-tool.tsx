import './window-tool.css';
import type React from 'react';
import { IconButton, Tooltip } from '@mui/material';
export function Tool({
  title,
  children,
  onClick,
  disabled,
  className,
}: {
  title: string;
  children: React.ReactNode;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Tooltip title={title}>
      <span className="tool-wrap">
        <IconButton className={className} aria-label={title} disabled={disabled} onClick={onClick}>
          {children}
        </IconButton>
      </span>
    </Tooltip>
  );
}
