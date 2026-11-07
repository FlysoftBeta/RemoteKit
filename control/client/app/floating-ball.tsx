import {
  FullscreenExit,
  KeyboardHideOutlined,
  KeyboardOutlined,
  StopCircleOutlined,
  VolumeUpOutlined,
} from '@mui/icons-material';
import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FloatingActions, FloatingIcon } from './floating-actions';

const icons: Record<FloatingIcon, React.ReactNode> = {
  keyboard: <KeyboardOutlined fontSize="small" />,
  'keyboard-hide': <KeyboardHideOutlined fontSize="small" />,
  'fullscreen-exit': <FullscreenExit fontSize="small" />,
  sound: <VolumeUpOutlined fontSize="small" />,
  stop: <StopCircleOutlined fontSize="small" />,
};

const BALL = 44;
const DRAG_SLOP = 6;

type Dock = { side: 'left' | 'right'; y: number };
type Drag = { id: number; x: number; y: number; dock: Dock; moved: boolean; height: number };

// Keeps pointer focus where it is, so a remote editor keeps its IME and soft keyboard.
const keepFocus = (event: React.PointerEvent | React.MouseEvent) => event.preventDefault();

export function FloatingBall({ actions }: { actions: FloatingActions }) {
  const list = useSyncExternalStore(actions.subscribe, actions.getSnapshot);
  const [open, setOpen] = useState(false);
  const [dock, setDock] = useState<Dock>({ side: 'right', y: 0.62 });
  const [dragging, setDragging] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<Drag | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const attention = list.find((action) => action.attention)?.attention;

  useEffect(() => {
    if (!list.length) setOpen(false);
  }, [list.length]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  const [panelShift, setPanelShift] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = panel.current;
    const parent = root.current?.offsetParent as HTMLElement | null;
    if (!open || !node || !parent) return setPanelShift(0);
    const box = node.getBoundingClientRect();
    const bounds = parent.getBoundingClientRect();
    const shift = box.top - panelShift < bounds.top + 8 ? bounds.top + 8 - (box.top - panelShift) : 0;
    const bottom = box.bottom - panelShift + shift - (bounds.bottom - 8);
    setPanelShift(shift - Math.max(0, bottom));
  }, [open, dock, list.length]);

  if (!list.length) return null;
  const position = dragging
    ? { left: dragging.x - BALL / 2, top: dragging.y - BALL / 2 }
    : { [dock.side]: 0, top: `calc(${dock.y * 100}% - ${BALL / 2}px)` };
  return (
    <div
      ref={root}
      className={[
        'floating-ball-dock',
        `dock-${dock.side}`,
        open ? 'open' : '',
        dragging ? 'dragging' : '',
        attention ? `attention-${attention}` : '',
      ].join(' ')}
      style={position}
    >
      <button
        type="button"
        className="floating-ball"
        aria-label={open ? '收起快捷操作' : `快捷操作，共 ${list.length} 项`}
        aria-expanded={open}
        aria-controls="floating-ball-panel"
        onMouseDown={keepFocus}
        onPointerDown={(event) => {
          keepFocus(event);
          if (!event.isPrimary || event.button !== 0) return;
          const parent = root.current?.offsetParent as HTMLElement | null;
          drag.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            dock,
            moved: false,
            height: parent?.clientHeight ?? window.innerHeight,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current || current.id !== event.pointerId) return;
          if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < DRAG_SLOP)
            return;
          current.moved = true;
          setOpen(false);
          const parent = (root.current?.offsetParent as HTMLElement | null)?.getBoundingClientRect();
          setDragging({ x: event.clientX - (parent?.left ?? 0), y: event.clientY - (parent?.top ?? 0) });
        }}
        onPointerUp={(event) => {
          const current = drag.current;
          drag.current = null;
          if (!current || current.id !== event.pointerId) return;
          setDragging(null);
          if (!current.moved) {
            setOpen((value) => !value);
            return;
          }
          const parent = (root.current?.offsetParent as HTMLElement | null)?.getBoundingClientRect();
          const width = parent?.width ?? window.innerWidth;
          const x = event.clientX - (parent?.left ?? 0);
          const y = event.clientY - (parent?.top ?? 0);
          const margin = (BALL / 2 + 8) / current.height;
          setDock({
            side: x < width / 2 ? 'left' : 'right',
            y: Math.min(1 - margin, Math.max(margin, y / current.height)),
          });
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen((value) => !value);
          }
        }}
      >
        <span className="floating-ball-core" />
        {attention && <span className="floating-ball-badge" />}
      </button>
      <div
        id="floating-ball-panel"
        ref={panel}
        className="floating-ball-panel"
        role="menu"
        aria-label="快捷操作"
        style={{ display: open ? undefined : 'none', transform: `translateY(${panelShift}px)` }}
      >
        {list.map((action) => (
          <button
            key={action.id}
            type="button"
            role="menuitem"
            className={`floating-action${action.className ? ` ${action.className}` : ''}`}
            disabled={action.disabled}
            aria-label={action.label}
            onMouseDown={keepFocus}
            onPointerDown={keepFocus}
            onClick={() => {
              setOpen(false);
              action.run();
            }}
          >
            {icons[action.icon]}
            <span className="floating-action-text">
              {action.label}
              {action.detail && <span className="floating-action-detail">{action.detail}</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
