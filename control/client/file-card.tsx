import React, { useRef } from 'react';
import { Box, ButtonBase, Typography } from '@mui/material';
import { FileThumbnail } from './file-thumbnail';
import type { SortActivator } from './sortable-file-items';

export function FileCard({
  id,
  title,
  type,
  assetId,
  blob,
  detail,
  index,
  status,
  selected = false,
  open = false,
  disabled = false,
  selection,
  activator,
  popup = true,
  compact = false,
  localOnly = false,
  onOpen,
}: {
  id: string;
  title: string;
  type: string;
  assetId: string;
  blob?: Blob;
  detail: string;
  index?: number;
  status?: string;
  selected?: boolean;
  open?: boolean;
  disabled?: boolean;
  selection?: React.ReactNode;
  activator?: SortActivator;
  popup?: boolean;
  compact?: boolean;
  localOnly?: boolean;
  onOpen?: (anchor: HTMLElement) => void;
}) {
  const touch = useRef<{ x: number; y: number; moved: boolean } | undefined>(undefined);
  const dot = title.lastIndexOf('.');
  const extension = dot > 0 ? title.slice(dot + 1, dot + 7) : undefined;
  const badge = {
    borderRadius: 1,
    px: 0.65,
    bgcolor: 'background.paper',
    color: 'text.primary',
    lineHeight: 1.6,
  };
  return (
    <Box
      data-file-card={id}
      sx={{
        position: 'relative',
        border: '1px solid',
        borderColor: selected || open ? 'primary.main' : 'divider',
        borderRadius: '10px',
        overflow: 'hidden',
        bgcolor: 'background.paper',
        boxShadow: selected ? 'inset 0 0 0 1px #245db5' : undefined,
      }}
    >
      <ButtonBase
        {...activator?.attributes}
        {...activator?.listeners}
        ref={activator?.ref}
        component="button"
        type="button"
        disabled={disabled || !onOpen}
        aria-label={title}
        aria-haspopup={onOpen && popup ? 'menu' : undefined}
        aria-expanded={open || undefined}
        aria-current={popup && selected && !selection ? true : undefined}
        aria-pressed={!popup ? selected : activator?.attributes['aria-pressed']}
        onPointerDown={(event) => {
          touch.current = { x: event.clientX, y: event.clientY, moved: false };
        }}
        onPointerMove={(event) => {
          const start = touch.current;
          if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) start.moved = true;
        }}
        onPointerCancel={() => {
          if (touch.current) touch.current.moved = true;
        }}
        onClick={(event) => {
          if (!event.detail || !touch.current?.moved) onOpen?.(event.currentTarget);
          touch.current = undefined;
        }}
        sx={{
          display: 'block',
          width: '100%',
          textAlign: 'left',
          borderRadius: 'inherit',
          '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -3 },
        }}
      >
        <FileThumbnail
          assetId={assetId}
          type={type}
          blob={blob}
          extension={extension}
          localOnly={localOnly}
          sx={{ height: compact ? 90 : 108 }}
        />
        <Box sx={{ height: compact ? 32 : 48, p: compact ? 0.25 : 0.75, boxSizing: 'border-box' }}>
          <Typography
            variant="body2"
            noWrap
            title={title}
            sx={compact ? { fontSize: 12, lineHeight: 1.15 } : undefined}
          >
            {title}
          </Typography>
          <Typography
            variant="caption"
            display="block"
            color="text.secondary"
            noWrap
            sx={compact ? { fontSize: 11, lineHeight: 1.15 } : undefined}
          >
            {detail}
          </Typography>
        </Box>
      </ButtonBase>
      {index !== undefined && (
        <Typography
          variant="caption"
          component="span"
          sx={{ ...badge, position: 'absolute', top: 6, left: 6, pointerEvents: 'none' }}
        >
          {index}
        </Typography>
      )}
      {status && (
        <Typography
          variant="caption"
          component="span"
          sx={{ ...badge, position: 'absolute', top: 6, right: selection ? 48 : 6, pointerEvents: 'none' }}
        >
          {status}
        </Typography>
      )}
      {selection && <Box sx={{ position: 'absolute', right: 0, top: 0 }}>{selection}</Box>}
    </Box>
  );
}
