import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ButtonBase, Paper } from '@mui/material';
import { MoreHoriz } from '@mui/icons-material';
import { unscaledLayer } from '../app/ui-scale';
import { placeViewportSelectionMenu } from '../app/viewport-geometry';
import type { SelectionAction } from '../rtc/protocol';
import type { HandleKind, SelectionTarget } from './target';
import './selection.css';

const labels: Record<SelectionAction, string> = {
  cut: '剪切',
  copy: '复制',
  paste: '粘贴',
  selectAll: '全选',
  contextMenu: '更多',
};

export function SelectionUI({
  target,
  changed,
  close,
  dismiss,
}: {
  target: SelectionTarget;
  changed?: number;
  close(): void;
  dismiss(): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [revision, update] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const drag = useRef<{ which: HandleKind; pointer: number; dx: number; dy: number } | undefined>(undefined);
  const handles = target.handles();
  useLayoutEffect(() => {
    const refresh = () => {
      if (!target.alive()) close();
      else update((value) => value + 1);
    };
    const outside = (event: PointerEvent) => {
      if (root.current && !event.composedPath().includes(root.current)) dismiss();
    };
    const hidden = () => {
      if (document.hidden) dismiss();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', refresh, true);
    document.addEventListener('selectionchange', refresh);
    document.addEventListener('input', refresh);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('resize', refresh);
    window.addEventListener('blur', dismiss);
    window.visualViewport?.addEventListener('resize', refresh);
    window.visualViewport?.addEventListener('scroll', refresh);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', refresh, true);
      document.removeEventListener('selectionchange', refresh);
      document.removeEventListener('input', refresh);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('resize', refresh);
      window.removeEventListener('blur', dismiss);
      window.visualViewport?.removeEventListener('resize', refresh);
      window.visualViewport?.removeEventListener('scroll', refresh);
    };
  }, [target, close, dismiss]);
  useLayoutEffect(() => {
    const node = menu.current;
    if (!node) return;
    const place = () => {
      const viewport = window.visualViewport;
      const position = placeViewportSelectionMenu(
        target.anchor(),
        {
          left: viewport?.offsetLeft ?? 0,
          top: viewport?.offsetTop ?? 0,
          width: viewport?.width ?? innerWidth,
          height: viewport?.height ?? innerHeight,
        },
        node.offsetWidth,
        24,
      );
      Object.assign(node.style, { left: `${position.left}px`, top: `${position.top}px` });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(node);
    return () => observer.disconnect();
  }, [target, revision, changed, dragging]);
  return createPortal(
    <div ref={root} className="selection-layer" onContextMenu={(event) => event.preventDefault()}>
      {(Object.entries(handles) as [HandleKind, NonNullable<typeof handles.start>][]).map(
        ([which, handle]) =>
          handle.visible && (
            <button
              key={which}
              className={`selection-handle selection-handle-${which}`}
              aria-label={which === 'start' ? '选择起点' : which === 'end' ? '选择终点' : '移动光标'}
              style={{ left: handle.x, top: handle.y }}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = {
                  which,
                  pointer: event.pointerId,
                  dx: handle.x - event.clientX,
                  dy: handle.y - handle.lineHeight / 2 - event.clientY,
                };
                setDragging(true);
              }}
              onPointerMove={(event) => {
                const value = drag.current;
                if (!value || value.pointer !== event.pointerId) return;
                event.preventDefault();
                target.dragHandle(value.which, { x: event.clientX + value.dx, y: event.clientY + value.dy });
                update((value) => value + 1);
              }}
              onPointerUp={(event) => {
                if (drag.current?.pointer !== event.pointerId) return;
                if (drag.current.which === 'insertion')
                  target.dragHandle('insertion', {
                    x: event.clientX + drag.current.dx,
                    y: event.clientY + drag.current.dy,
                  });
                event.currentTarget.releasePointerCapture(event.pointerId);
                drag.current = undefined;
                setDragging(false);
              }}
              onLostPointerCapture={() => {
                drag.current = undefined;
                setDragging(false);
              }}
              onPointerCancel={() => {
                drag.current = undefined;
                setDragging(false);
              }}
            />
          ),
      )}
      {!dragging && target.commands().length > 0 && (
        <Paper ref={menu} className="selection-menu" elevation={0} role="toolbar" aria-label="文本选择">
          {target.commands().map((command) => (
            <ButtonBase
              key={command}
              className="selection-menu-command"
              disableRipple
              aria-label={labels[command]}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                void Promise.resolve(target.run(command))
                  .then(() => {
                    if (command === 'selectAll') update((value) => value + 1);
                    else close();
                  })
                  .catch((failure: unknown) =>
                    setError(failure instanceof Error ? failure.message : '剪贴板操作失败'),
                  );
              }}
            >
              {command === 'contextMenu' ? <MoreHoriz fontSize="small" /> : labels[command]}
            </ButtonBase>
          ))}
        </Paper>
      )}
      {error && (
        <div className="selection-error" role="alert">
          {error}
        </div>
      )}
    </div>,
    unscaledLayer(),
  );
}
