import { Menu, MenuItem } from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import type { ProductState } from '../../shared/product';
import type { Action } from './product-dialogs';
import type { SpaceSnapshots } from './space-snapshots';
import { scaledAnchor } from './ui-scale';
import { GroupList } from './group-list';
export function LauncherSpaces({
  state,
  snapshots,
  action,
  online,
  newTarget,
  targetNew,
  close,
  report,
}: {
  state: ProductState;
  snapshots: SpaceSnapshots;
  action: Action;
  online: boolean;
  newTarget: boolean;
  targetNew(): void;
  close(): void;
  report(error: unknown): void;
}) {
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement }>();
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const gesture = useRef({ x: 0, y: 0, consumed: false });
  useEffect(() => () => clearTimeout(hold.current), []);
  const run = (command: Parameters<Action>[0]) => void action(command).catch(report);
  return (
    <GroupList
      state={state}
      snapshots={snapshots}
      online={online}
      newTarget={newTarget}
      targetNew={targetNew}
      cardProps={(space) => ({
        onClick: (event) => {
          if (event.detail !== 0 && gesture.current.consumed) return;
          run({ type: 'space.activate', spaceId: space.id });
          close();
        },
        onContextMenu: (event) => {
          event.preventDefault();
          setMenu({ id: space.id, anchor: event.currentTarget });
        },
        onKeyDown: (event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            setMenu({ id: space.id, anchor: event.currentTarget });
          }
        },
        onPointerDown: (event) => {
          clearTimeout(hold.current);
          gesture.current = { x: event.clientX, y: event.clientY, consumed: false };
          if (event.pointerType === 'mouse') return;
          const anchor = event.currentTarget;
          hold.current = setTimeout(() => {
            gesture.current.consumed = true;
            setMenu({ id: space.id, anchor });
          }, 400);
        },
        onPointerMove: (event) => {
          if (Math.hypot(event.clientX - gesture.current.x, event.clientY - gesture.current.y) > 4)
            clearTimeout(hold.current);
        },
        onPointerUp: () => clearTimeout(hold.current),
        onPointerCancel: () => clearTimeout(hold.current),
      })}
    >
      <Menu open={!!menu} anchorEl={scaledAnchor(menu?.anchor)} onClose={() => setMenu(undefined)}>
        <MenuItem
          onClick={() => {
            if (menu) run({ type: 'space.close', spaceId: menu.id });
            setMenu(undefined);
          }}
        >
          关闭窗口组
        </MenuItem>
      </Menu>
    </GroupList>
  );
}
