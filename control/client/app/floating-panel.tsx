import { Box, Paper } from '@mui/material';
import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useUiScale } from './ui-scale';

export interface PanelPlacement {
  left: number;
  top: number;
  // The panel's bottom edge sits at `top` (it opens upward from an anchor).
  above?: boolean;
}

const KEEP_VISIBLE = 64;

// A non-modal surface floating over the shell: no backdrop, the page underneath stays usable,
// and the header doubles as a drag handle. Without a placement it rests at the bottom centre;
// once dragged it stays where the user left it. Lengths are layout px (the panel lives in the
// scaled <body>); pointer deltas are visual px and are divided by the UI scale.
export function FloatingPanel({
  label,
  placement,
  width,
  maxHeight,
  header,
  children,
  onEscape,
}: {
  label: string;
  placement?: PanelPlacement;
  width: number;
  maxHeight: number;
  header: React.ReactNode;
  children: React.ReactNode;
  onEscape?: () => void;
}) {
  const paper = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; x: number; y: number; left: number; top: number }>(undefined);
  const [moved, setMoved] = useState<{ left: number; top: number }>();
  const [dragging, setDragging] = useState(false);
  const scale = useUiScale();
  const position: React.CSSProperties = moved
    ? { left: moved.left, top: moved.top }
    : placement
      ? {
          left: placement.left,
          top: placement.top,
          transform: placement.above ? 'translateY(-100%)' : undefined,
        }
      : { left: '50%', bottom: 16, transform: 'translateX(-50%)' };
  const clamp = (left: number, top: number) => {
    const rect = paper.current?.getBoundingClientRect();
    const panelWidth = (rect?.width ?? 0) / scale;
    const viewWidth = window.innerWidth / scale;
    const viewHeight = window.innerHeight / scale;
    return {
      left: Math.min(viewWidth - KEEP_VISIBLE, Math.max(KEEP_VISIBLE - panelWidth, left)),
      top: Math.min(viewHeight - KEEP_VISIBLE, Math.max(0, top)),
    };
  };
  return createPortal(
    <Paper
      ref={paper}
      role="dialog"
      aria-modal={false}
      aria-label={label}
      elevation={0}
      style={{ ...position, maxHeight }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !onEscape) return;
        event.stopPropagation();
        onEscape();
      }}
      sx={{
        position: 'fixed',
        zIndex: 1260,
        width,
        maxWidth: 'calc(var(--layout-vw) - 16px)',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: '14px',
        overflow: 'hidden',
        boxShadow: '0 12px 32px rgb(15 23 42 / 24%), 0 0 0 1px rgb(15 23 42 / 8%)',
      }}
    >
      <Box
        data-panel-handle
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as Element).closest('button, input, a')) return;
          const rect = paper.current?.getBoundingClientRect();
          if (!rect) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            pointer: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: rect.left / scale,
            top: rect.top / scale,
          };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || start.pointer !== event.pointerId) return;
          setMoved(
            clamp(
              start.left + (event.clientX - start.x) / scale,
              start.top + (event.clientY - start.y) / scale,
            ),
          );
        }}
        onPointerUp={() => {
          drag.current = undefined;
          setDragging(false);
        }}
        onPointerCancel={() => {
          drag.current = undefined;
          setDragging(false);
        }}
        sx={{
          flex: 'none',
          cursor: dragging ? 'grabbing' : 'grab',
          touchAction: 'none',
          userSelect: 'none',
        }}
      >
        <Box
          aria-hidden
          sx={{
            width: 36,
            height: 4,
            mx: 'auto',
            mt: 0.75,
            borderRadius: 2,
            bgcolor: dragging ? 'primary.main' : 'var(--border-tab)',
          }}
        />
        {header}
      </Box>
      {children}
    </Paper>,
    document.body,
  );
}
