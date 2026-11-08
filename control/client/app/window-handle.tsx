import { MoreHoriz } from '@mui/icons-material';
import { IconButton, Menu, MenuItem } from '@mui/material';
import { useRef, useState } from 'react';
import type { ProductState, ProductWindow } from '../../shared/product';
import type { Action } from './product-dialogs';
import { scaledAnchor } from './ui-scale';

export function WindowHandle({
  win,
  state,
  online,
  action,
  report,
  onSplit,
}: {
  win: ProductWindow;
  state: ProductState;
  online: boolean;
  action: Action;
  report(error: unknown): void;
  onSplit(windowId: string, side: 'left' | 'right'): void;
}) {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | undefined>(undefined);
  const space = state.workspace.spaces.find((space) => space.windowIds.includes(win.id));
  const run = (command: Parameters<Action>[0]) => {
    setMenu(null);
    void action(command).catch(report);
  };
  return (
    <>
      <IconButton
        aria-label="窗口菜单"
        disabled={!online}
        className="window-handle"
        onClick={(event) => {
          if (!drag.current?.moved) setMenu(event.currentTarget);
        }}
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, y: event.clientY, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag.current && Math.abs(event.clientX - drag.current.x) > 8) drag.current.moved = true;
        }}
        onPointerUp={(event) => {
          if (drag.current?.moved) {
            const target = document
              .elementFromPoint(event.clientX, event.clientY)
              ?.closest<HTMLElement>('[data-window-id]');
            if (target && target.dataset.windowId !== win.id) {
              const bounds = target.getBoundingClientRect();
              if (event.clientY < bounds.top + bounds.height / 2)
                run({
                  type: 'window.place',
                  windowId: win.id,
                  placement: {
                    mode: 'split',
                    besideWindowId: target.dataset.windowId!,
                    side: event.clientX < bounds.left + bounds.width / 2 ? 'left' : 'right',
                  },
                });
            }
          }
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = undefined;
        }}
      >
        <MoreHoriz fontSize="small" />
      </IconButton>
      <Menu open={!!menu} anchorEl={scaledAnchor(menu)} onClose={() => setMenu(null)}>
        <MenuItem
          onClick={() => run({ type: 'window.place', windowId: win.id, placement: { mode: 'space' } })}
        >
          单独显示
        </MenuItem>
        {(['left', 'right'] as const).map((side) => (
          <MenuItem
            key={side}
            disabled={!space || space.windowIds.length >= 3}
            onClick={() => {
              setMenu(null);
              onSplit(win.id, side);
            }}
          >
            {side === 'left' ? '左侧分屏' : '右侧分屏'}
          </MenuItem>
        ))}
        <MenuItem onClick={() => run({ type: 'window.close', windowId: win.id })}>关闭窗口</MenuItem>
      </Menu>
    </>
  );
}
