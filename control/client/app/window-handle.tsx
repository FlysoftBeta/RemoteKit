import { ChevronRight, DragHandle } from '@mui/icons-material';
import { IconButton, Menu, MenuItem } from '@mui/material';
import React, { useState } from 'react';
import type { ProductState, ProductWindow } from '../../shared/product';
import type { Action } from './product-dialogs';
import { scaledAnchor } from './ui-scale';
import { useWindowDrag } from './window-drag';
import { appName } from './app-icon';

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
  const [groupsMenu, setGroupsMenu] = useState<HTMLElement | null>(null);
  const begin = useWindowDrag();
  const space = state.workspace.spaces.find((space) => space.windowIds.includes(win.id));
  const index = space?.windowIds.indexOf(win.id) ?? -1;
  const run = (command: Parameters<Action>[0]) => {
    setMenu(null);
    setGroupsMenu(null);
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
        <DragHandle fontSize="small" />
      </IconButton>
      <Menu open={!!menu} anchorEl={scaledAnchor(menu)} onClose={() => setMenu(null)}>
        <MenuItem
          onClick={() => run({ type: 'window.place', windowId: win.id, placement: { mode: 'space' } })}
        >
          移到新窗口组
        </MenuItem>
        <MenuItem onClick={(event) => setGroupsMenu(event.currentTarget)}>
          移到窗口组 <ChevronRight fontSize="small" />
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
      <Menu
        open={!!groupsMenu}
        anchorEl={scaledAnchor(groupsMenu)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        onClose={() => setGroupsMenu(null)}
      >
        {state.workspace.spaces
          .filter((group) => group.id !== space?.id)
          .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
          .map((group) => (
            <MenuItem
              key={group.id}
              disabled={group.windowIds.length >= 3}
              onClick={() =>
                run({
                  type: 'window.place',
                  windowId: win.id,
                  placement: {
                    mode: 'split',
                    besideWindowId: group.windowIds[group.windowIds.length - 1],
                    side: 'right',
                  },
                })
              }
            >
              {group.windowIds
                .map((id) => {
                  const window = state.workspace.windows.find((window) => window.id === id)!;
                  return appName(state.workspace, window);
                })
                .join(' · ')}
            </MenuItem>
          ))}
        {state.workspace.spaces.length < 2 && <MenuItem disabled>没有其他窗口组</MenuItem>}
      </Menu>
    </>
  );
}
