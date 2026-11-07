import {
  Close,
  KeyboardHideOutlined,
  KeyboardOutlined,
  StopCircleOutlined,
  VolumeUpOutlined,
} from '@mui/icons-material';
import { ButtonBase, Tooltip } from '@mui/material';
import React, { useRef, useState, useSyncExternalStore } from 'react';
import type { DockAnchor, FloatingAction, FloatingActions, FloatingIcon } from './floating-actions';

const icons: Record<FloatingIcon, React.ReactNode> = {
  keyboard: <KeyboardOutlined fontSize="small" />,
  'keyboard-hide': <KeyboardHideOutlined fontSize="small" />,
  'fullscreen-exit': <Close fontSize="small" />,
  sound: <VolumeUpOutlined fontSize="small" />,
  stop: <StopCircleOutlined fontSize="small" />,
};

export const ALL_ANCHORS: readonly DockAnchor[] = [
  'top-left',
  'top',
  'top-right',
  'left',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
];
const DRAG_SLOP = 6;

type Drag = { id: string; pointer: number; x: number; y: number; moved: boolean };

// Keeps pointer focus where it is, so a remote editor keeps its IME and soft keyboard.
const keepFocus = (event: React.SyntheticEvent) => event.preventDefault();

export function FloatingDock({ actions }: { actions: FloatingActions }) {
  const list = useSyncExternalStore(actions.subscribe, actions.getSnapshot);
  const [placement, setPlacement] = useState<Record<string, DockAnchor>>({});
  const [dragging, setDragging] = useState<{ id: string; x: number; y: number } | null>(null);
  const drag = useRef<Drag | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  if (!list.length) return null;
  const allowed = (action: FloatingAction) => action.anchors ?? ALL_ANCHORS;
  const anchorOf = (action: FloatingAction) => {
    const chosen = placement[action.id];
    return chosen && allowed(action).includes(chosen) ? chosen : action.anchor;
  };
  const dragged = dragging && list.find((action) => action.id === dragging.id);
  const local = (event: React.PointerEvent) => {
    const box = layer.current!.getBoundingClientRect();
    const scale = layer.current!.offsetWidth ? box.width / layer.current!.offsetWidth : 1;
    return { x: (event.clientX - box.left) / scale, y: (event.clientY - box.top) / scale };
  };
  const nearest = (action: FloatingAction, event: React.PointerEvent) => {
    let best: { anchor: DockAnchor; distance: number } | undefined;
    for (const anchor of allowed(action)) {
      const target = layer.current?.querySelector(`[data-target="${anchor}"]`);
      if (!target) continue;
      const box = target.getBoundingClientRect();
      const distance = Math.hypot(
        box.left + box.width / 2 - event.clientX,
        box.top + box.height / 2 - event.clientY,
      );
      if (!best || distance < best.distance) best = { anchor, distance };
    }
    return best?.anchor;
  };
  const button = (action: FloatingAction) => (
    <Tooltip
      key={action.id}
      title={dragging ? '' : action.detail ? `${action.label} · ${action.detail}` : action.label}
      disableInteractive
    >
      <ButtonBase
        className={[
          'dock-button',
          action.attention ? `attention-${action.attention}` : '',
          dragging?.id === action.id ? 'dragging' : '',
          action.className ?? '',
        ].join(' ')}
        style={dragging?.id === action.id ? { visibility: 'hidden' } : undefined}
        aria-label={action.label}
        disabled={action.disabled}
        onMouseDown={keepFocus}
        onPointerDown={(event) => {
          keepFocus(event);
          if (!event.isPrimary || event.button !== 0) return;
          drag.current = {
            id: action.id,
            pointer: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current || current.pointer !== event.pointerId) return;
          if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < DRAG_SLOP)
            return;
          current.moved = true;
          setDragging({ id: action.id, ...local(event) });
        }}
        onPointerUp={(event) => {
          const current = drag.current;
          drag.current = null;
          if (!current || current.pointer !== event.pointerId) return;
          if (!current.moved) {
            if (!action.disabled) action.run();
            return;
          }
          const anchor = nearest(action, event);
          setDragging(null);
          if (anchor) setPlacement((value) => ({ ...value, [action.id]: anchor }));
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(null);
        }}
        onClick={(event) => {
          // Pointer activation runs on pointerup; this handles keyboard activation only.
          if (event.detail === 0 && !action.disabled) action.run();
        }}
      >
        {icons[action.icon]}
        <span className="visually-hidden">{action.label}</span>
      </ButtonBase>
    </Tooltip>
  );
  return (
    <div className="floating-dock" ref={layer}>
      {ALL_ANCHORS.map((anchor) => {
        const members = list.filter((action) => anchorOf(action) === anchor);
        const target = dragged && allowed(dragged).includes(anchor);
        if (!members.length && !target) return null;
        return (
          <div key={anchor} className={`dock-slot dock-${anchor}`}>
            {members.map(button)}
            {target && <span className="dock-target" data-target={anchor} />}
          </div>
        );
      })}
      {dragged && dragging && (
        <span className="dock-button dock-ghost" style={{ left: dragging.x, top: dragging.y }} aria-hidden>
          {icons[dragged.icon]}
        </span>
      )}
    </div>
  );
}
