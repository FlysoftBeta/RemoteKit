import { Add } from '@mui/icons-material';
import { ButtonBase, Menu, MenuItem, Typography } from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import type { ProductState } from '../../shared/product';
import type { Action } from './product-dialogs';
import { AppIcon, appName } from './app-icon';
import type { SpaceSnapshots } from './space-snapshots';
import { scaledAnchor } from './ui-scale';
import { useWindowDragging } from './window-drag';

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
  const workspace = state.workspace;
  const spaces = [...workspace.spaces].sort(
    (a, b) =>
      Number(b.id === workspace.activeSpaceId) - Number(a.id === workspace.activeSpaceId) ||
      b.lastActiveAt - a.lastActiveAt,
  );
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement }>();
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const gesture = useRef({ x: 0, y: 0, consumed: false });
  const dragging = useWindowDragging();
  useEffect(() => () => clearTimeout(hold.current), []);
  const run = (command: Parameters<Action>[0]) => void action(command).catch(report);
  return (
    <aside className="launcher-spaces" aria-label="窗口组栏">
      <ButtonBase
        className={`launcher-space-new${newTarget ? ' target-space' : ''}`}
        data-new-group
        aria-label="新窗口组"
        aria-pressed={newTarget}
        onClick={targetNew}
        disabled={!online}
      >
        <Add />
        <span>新窗口组</span>
      </ButtonBase>
      {spaces.map((space) => (
        <ButtonBase
          key={space.id}
          className={`launcher-space-card${!newTarget && space.id === workspace.activeSpaceId ? ' target-space' : ''}${dragging && space.windowIds.length >= 3 ? ' drop-disabled' : ''}`}
          data-space-card={space.id}
          aria-label={
            space.id === workspace.activeSpaceId
              ? '当前窗口组'
              : space.windowIds
                  .map((id) =>
                    appName(
                      workspace,
                      workspace.windows.find((win) => win.id === id)!,
                    ),
                  )
                  .join(' · ')
          }
          aria-current={space.id === workspace.activeSpaceId ? 'true' : undefined}
          disabled={!online}
          onClick={(event) => {
            if (event.detail !== 0 && gesture.current.consumed) return;
            run({ type: 'space.activate', spaceId: space.id });
            close();
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ id: space.id, anchor: event.currentTarget });
          }}
          onKeyDown={(event) => {
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
              event.preventDefault();
              setMenu({ id: space.id, anchor: event.currentTarget });
            }
          }}
          onPointerDown={(event) => {
            clearTimeout(hold.current);
            gesture.current = { x: event.clientX, y: event.clientY, consumed: false };
            if (event.pointerType === 'mouse') return;
            const anchor = event.currentTarget;
            hold.current = setTimeout(() => {
              gesture.current.consumed = true;
              setMenu({ id: space.id, anchor });
            }, 400);
          }}
          onPointerMove={(event) => {
            if (Math.hypot(event.clientX - gesture.current.x, event.clientY - gesture.current.y) > 4)
              clearTimeout(hold.current);
          }}
          onPointerUp={() => clearTimeout(hold.current)}
          onPointerCancel={() => clearTimeout(hold.current)}
        >
          {space.id === workspace.activeSpaceId && <span className="launcher-space-badge">当前</span>}
          <span className="launcher-space-preview">
            {space.windowIds.map((id, index) => {
              const win = workspace.windows.find((win) => win.id === id)!;
              const app = workspace.apps.find((app) => `web:${app.id}` === win.appId);
              const image = snapshots.get(id);
              return (
                <span key={id} className="launcher-window-preview" style={{ flexGrow: space.weights[index] }}>
                  {image ? (
                    <img src={image} alt="" draggable={false} />
                  ) : (
                    <AppIcon appId={win.appId} iconUrl={app?.iconUrl} />
                  )}
                  <Typography component="span" noWrap>
                    {appName(workspace, win)}
                  </Typography>
                </span>
              );
            })}
          </span>
        </ButtonBase>
      ))}
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
    </aside>
  );
}
