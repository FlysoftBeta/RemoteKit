import { Box, ButtonBase, CircularProgress, Typography } from '@mui/material';
import React, { useRef } from 'react';
import { FileThumbnail } from './file-thumbnail';
import type { SortActivator } from './sortable-file-items';
import { OverflowText } from '../app/overflow-text';

export interface FileStatus {
  label: string;
  tone: 'progress' | 'warning';
}

const LONG_PRESS_MS = 450;
const MOVE_SLOP = 6;

// Press tracking shared by tiles and rows: a click after the pointer travelled (a swipe or a
// drag) is not an activation, and a touch held still opens `onLongPress` instead of a click.
export function usePress(onOpen?: (anchor: HTMLElement) => void, onLongPress?: () => void) {
  const press = useRef<{ x: number; y: number; moved: boolean; long: boolean; timer?: number }>(undefined);
  const clear = () => window.clearTimeout(press.current?.timer);
  return {
    onPointerDown(event: React.PointerEvent<HTMLElement>) {
      clear();
      const state = { x: event.clientX, y: event.clientY, moved: false, long: false, timer: 0 };
      if (onLongPress && event.pointerType === 'touch')
        state.timer = window.setTimeout(() => {
          state.long = true;
          onLongPress();
        }, LONG_PRESS_MS);
      press.current = state;
    },
    onPointerMove(event: React.PointerEvent<HTMLElement>) {
      const start = press.current;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_SLOP) {
        start.moved = true;
        clear();
      }
    },
    onPointerUp: clear,
    onPointerCancel() {
      clear();
      if (press.current) press.current.moved = true;
    },
    onContextMenu(event: React.MouseEvent<HTMLElement>) {
      if (press.current?.long) event.preventDefault();
    },
    onClick(event: React.MouseEvent<HTMLElement>) {
      const state = press.current;
      press.current = undefined;
      if (state?.long) return;
      if (!event.detail || !state?.moved) onOpen?.(event.currentTarget);
    },
  };
}

function StatusBadge({ status }: { status: FileStatus }) {
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.5,
        maxWidth: '100%',
        px: 0.75,
        py: '1px',
        borderRadius: 10,
        fontSize: 11,
        lineHeight: '16px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        bgcolor: status.tone === 'warning' ? '#fff4e5' : 'rgb(255 255 255 / 92%)',
        color: status.tone === 'warning' ? '#8a4b00' : 'text.primary',
        boxShadow: '0 1px 2px rgb(15 23 42 / 18%)',
      }}
    >
      {status.tone === 'progress' && <CircularProgress size={10} thickness={6} />}
      {status.label}
    </Box>
  );
}

// A file card. `compact` is the basket strip size (96 wide); otherwise it fills its grid cell
// with a 4:3 preview. Corner slots carry the order number, selection control and markers.
export function FileTile({
  id,
  name,
  type,
  assetId,
  blob,
  localOnly = false,
  meta,
  compact = false,
  index,
  status,
  selected = false,
  open = false,
  disabled = false,
  pressed,
  start,
  corner,
  marker,
  activator,
  onOpen,
  onLongPress,
}: {
  id: string;
  name: string;
  type: string;
  assetId: string;
  blob?: Blob;
  localOnly?: boolean;
  meta: string;
  compact?: boolean;
  index?: number;
  status?: FileStatus;
  selected?: boolean;
  open?: boolean;
  disabled?: boolean;
  pressed?: boolean;
  start?: React.ReactNode;
  corner?: React.ReactNode;
  marker?: React.ReactNode;
  activator?: SortActivator;
  onOpen?: (anchor: HTMLElement) => void;
  onLongPress?: () => void;
}) {
  const press = usePress(onOpen, onLongPress);
  return (
    <Box
      data-file-card={id}
      sx={{
        position: 'relative',
        borderRadius: '10px',
        bgcolor: 'background.paper',
        boxShadow: selected
          ? '0 0 0 2px var(--primary)'
          : open
            ? '0 0 0 1px var(--primary)'
            : '0 0 0 1px var(--border)',
        transition: 'box-shadow 120ms',
        '&:hover': {
          boxShadow:
            selected || open ? undefined : '0 0 0 1px var(--border-tile), 0 2px 6px rgb(15 23 42 / 8%)',
        },
      }}
    >
      <ButtonBase
        {...activator?.attributes}
        {...activator?.listeners}
        ref={activator?.ref}
        disabled={disabled || !onOpen}
        aria-label={name}
        aria-haspopup={onOpen && pressed === undefined ? 'menu' : undefined}
        aria-expanded={open || undefined}
        aria-pressed={pressed ?? activator?.attributes['aria-pressed']}
        {...press}
        sx={{
          display: 'block',
          width: '100%',
          textAlign: 'left',
          borderRadius: '10px',
          overflow: 'hidden',
          '&.Mui-focusVisible': { boxShadow: 'inset 0 0 0 2px var(--primary)' },
        }}
      >
        <Box sx={{ position: 'relative' }}>
          <FileThumbnail
            assetId={assetId}
            type={type}
            name={name}
            blob={blob}
            localOnly={localOnly}
            size={compact ? 'small' : 'large'}
            sx={compact ? { height: 84 } : { aspectRatio: '4 / 3' }}
          />
          {status && (
            <Box sx={{ position: 'absolute', left: 6, right: 6, bottom: 6, display: 'flex' }}>
              <StatusBadge status={status} />
            </Box>
          )}
        </Box>
        <Box sx={{ px: compact ? 0.75 : 1, py: compact ? 0.5 : 0.75 }}>
          <OverflowText
            sx={{ fontSize: compact ? 12 : 13, fontWeight: 500, lineHeight: compact ? '16px' : '18px' }}
          >
            {name}
          </OverflowText>
          <Typography
            noWrap
            color="text.secondary"
            sx={{ fontSize: 11, lineHeight: compact ? '15px' : '16px' }}
          >
            {meta}
          </Typography>
        </Box>
      </ButtonBase>
      {index !== undefined && (
        <Box
          component="span"
          sx={{
            position: 'absolute',
            top: 6,
            left: 6,
            minWidth: 20,
            height: 20,
            px: 0.5,
            borderRadius: 10,
            display: 'grid',
            placeItems: 'center',
            fontSize: 11,
            fontWeight: 600,
            bgcolor: 'rgb(31 41 55 / 72%)',
            color: '#fff',
            pointerEvents: 'none',
          }}
        >
          {index}
        </Box>
      )}
      {marker && (
        <Box sx={{ position: 'absolute', top: 6, right: 6, pointerEvents: 'none', display: 'flex' }}>
          {marker}
        </Box>
      )}
      {start && <Box sx={{ position: 'absolute', top: 0, left: 0 }}>{start}</Box>}
      {corner && <Box sx={{ position: 'absolute', top: 0, right: 0 }}>{corner}</Box>}
    </Box>
  );
}

// A list row: optional leading control, the file (thumbnail, name, details) and trailing
// actions. The file area is one button when `onOpen` is given.
export function FileRow({
  id,
  name,
  type,
  assetId,
  blob,
  localOnly = false,
  meta,
  detail,
  status,
  selected = false,
  disabled = false,
  pressed,
  leading,
  trailing,
  onOpen,
  onLongPress,
}: {
  id: string;
  name: string;
  type: string;
  assetId: string;
  blob?: Blob;
  localOnly?: boolean;
  meta: string;
  detail?: string;
  status?: FileStatus;
  selected?: boolean;
  disabled?: boolean;
  pressed?: boolean;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  onOpen?: (anchor: HTMLElement) => void;
  onLongPress?: () => void;
}) {
  const press = usePress(onOpen, onLongPress);
  const body = (
    <>
      <FileThumbnail
        assetId={assetId}
        type={type}
        name={name}
        blob={blob}
        localOnly={localOnly}
        size="small"
        sx={{ width: 40, height: 40, flex: 'none', borderRadius: '8px' }}
      />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <OverflowText sx={{ fontSize: 14, lineHeight: '20px' }}>{name}</OverflowText>
        {detail && (
          <Typography noWrap color="text.secondary" sx={{ fontSize: 12, lineHeight: '18px' }}>
            {detail}
          </Typography>
        )}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
          {status && <StatusBadge status={status} />}
          <Typography noWrap color="text.secondary" sx={{ fontSize: 12, lineHeight: '18px' }}>
            {meta}
          </Typography>
        </Box>
      </Box>
    </>
  );
  const bodySx = {
    display: 'flex',
    alignItems: 'center',
    gap: 1.25,
    flex: 1,
    minWidth: 0,
    alignSelf: 'stretch',
    px: 0.5,
    borderRadius: '8px',
    textAlign: 'left',
    justifyContent: 'flex-start',
  } as const;
  return (
    <Box
      data-file-row={id}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.25,
        minHeight: 56,
        px: 0.5,
        borderRadius: '10px',
        bgcolor: selected ? 'var(--primary-tab-drop)' : 'background.paper',
        '&:hover': { bgcolor: selected ? 'rgb(36 93 181 / 12%)' : 'var(--surface-subtle)' },
      }}
    >
      {leading}
      {onOpen ? (
        <ButtonBase
          disabled={disabled}
          aria-label={name}
          aria-pressed={pressed}
          aria-haspopup={pressed === undefined ? 'menu' : undefined}
          {...press}
          sx={{ ...bodySx, '&.Mui-focusVisible': { boxShadow: 'inset 0 0 0 2px var(--primary)' } }}
        >
          {body}
        </ButtonBase>
      ) : (
        <Box sx={bodySx}>{body}</Box>
      )}
      {trailing && <Box sx={{ display: 'flex', alignItems: 'center', flex: 'none' }}>{trailing}</Box>}
    </Box>
  );
}
