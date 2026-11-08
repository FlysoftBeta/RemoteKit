import { DragIndicator } from '@mui/icons-material';
import { IconButton, Menu, MenuItem } from '@mui/material';
import React, { useState } from 'react';
import type { ProductState, ProductWindow } from '../../shared/product';
import type { Action } from './product-dialogs';
import { scaledAnchor } from './ui-scale';
import { useWindowDrag } from './window-drag';

export function WindowHandle({
  win,
  state,
  online,
  action,
  report,
}: {
  win: ProductWindow;
  state: ProductState;
  online: boolean;
  action: Action;
  report(error: unknown): void;
}) {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const begin = useWindowDrag();
  const space = state.workspace.spaces.find((space) => space.windowIds.includes(win.id));
  const index = space?.windowIds.indexOf(win.id) ?? -1;
  const run = (command: Parameters<Action>[0]) => {
    setMenu(null);
    void action(command).catch(report);
  };
  return (
    <>
      <IconButton
        aria-label="窗口把手"
        disabled={!online}
        className="window-handle"
        onPointerDown={(event) => begin(event, { windowId: win.id })}
        onClick={(event) => setMenu(event.currentTarget)}
      >
        <DragIndicator fontSize="small" style={{ transform: 'rotate(90deg)' }} />
      </IconButton>
      <Menu open={!!menu} anchorEl={scaledAnchor(menu)} onClose={() => setMenu(null)}>
        <MenuItem
          onClick={() => run({ type: 'window.place', windowId: win.id, placement: { mode: 'space' } })}
        >
          移到新窗口组
        </MenuItem>
        {(['left', 'right'] as const).map((side) => (
          <MenuItem
            key={side}
            disabled={!space || (side === 'left' ? index <= 0 : index >= space.windowIds.length - 1)}
            onClick={() => {
              if (space)
                run({
                  type: 'window.place',
                  windowId: win.id,
                  placement: {
                    mode: 'split',
                    besideWindowId: space.windowIds[index + (side === 'left' ? -1 : 1)],
                    side,
                  },
                });
            }}
          >
            {side === 'left' ? '向左移' : '向右移'}
          </MenuItem>
        ))}
        <MenuItem onClick={() => run({ type: 'window.close', windowId: win.id })}>关闭窗口</MenuItem>
      </Menu>
    </>
  );
}
