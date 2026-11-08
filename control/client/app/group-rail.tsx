import { ChevronLeft, ChevronRight, DashboardOutlined, HomeOutlined } from '@mui/icons-material';
import { ButtonBase, IconButton, Menu, MenuItem, Tooltip } from '@mui/material';
import React, { useEffect, useRef, useState } from 'react';
import type { ProductState } from '../../shared/product';
import type { Action } from './product-dialogs';
import { AppIcon, appName } from './app-icon';
import { scaledAnchor } from './ui-scale';
import { useWindowDrag, useWindowDragging } from './window-drag';

export function GroupRail({
  state,
  action,
  online,
  report,
  launcher,
  switcher,
  expanded,
}: {
  state: ProductState;
  action: Action;
  online: boolean;
  report(error: unknown): void;
  launcher(): void;
  switcher(): void;
  expanded: boolean;
}) {
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement }>();
  const press = useRef<
    | { timer: ReturnType<typeof setTimeout>; x: number; y: number; pressed: boolean; consumed: boolean }
    | undefined
  >(undefined);
  const dragging = useWindowDragging();
  const begin = useWindowDrag();
  useEffect(() => () => clearTimeout(press.current?.timer), []);
  const run = (command: Parameters<Action>[0]) => void action(command).catch(report);
  const toggle = () => run({ type: 'settings.update', settings: { workspace: { groupRail: !expanded } } });
  if (!expanded)
    return (
      <Tooltip title="展开组栏">
        <IconButton className="group-rail-expand" aria-label="展开组栏" disabled={!online} onClick={toggle}>
          <ChevronRight />
        </IconButton>
      </Tooltip>
    );
  return (
    <aside className="group-rail" aria-label="窗口组">
      <Tooltip title="开始" placement="right">
        <IconButton aria-label="开始" onClick={launcher}>
          <HomeOutlined />
        </IconButton>
      </Tooltip>
      <div className="group-rail-list">
        {state.workspace.spaces.map((space, index) => {
          const focused = state.workspace.windows.find((win) => win.id === space.focusedWindowId)!;
          const disabled =
            !!dragging &&
            (!('spaceId' in dragging)
              ? space.windowIds.length >= 3
              : (state.workspace.spaces.find((item) => item.id === dragging.spaceId)?.windowIds.length ?? 0) +
                  space.windowIds.length >
                3);
          return (
            <div
              className={`group-rail-entry${space.id === state.workspace.activeSpaceId ? ' active' : ''}${disabled ? ' drop-disabled' : ''}`}
              key={space.id}
              data-rail-space={space.id}
            >
              <ButtonBase
                className="group-rail-card"
                aria-label={`窗口组 ${index + 1}: ${appName(state.workspace, focused)}`}
                disabled={!online}
                onClick={() => {
                  if (!press.current?.consumed) run({ type: 'space.activate', spaceId: space.id });
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ id: space.id, anchor: event.currentTarget });
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0 || !online) return;
                  const anchor = event.currentTarget;
                  press.current = {
                    x: event.clientX,
                    y: event.clientY,
                    pressed: true,
                    consumed: false,
                    timer: setTimeout(() => {
                      if (press.current) press.current.consumed = true;
                      setMenu({ id: space.id, anchor });
                    }, 400),
                  };
                  anchor.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  const current = press.current;
                  if (
                    current?.pressed &&
                    !current.consumed &&
                    Math.hypot(event.clientX - current.x, event.clientY - current.y) > 4
                  ) {
                    clearTimeout(current.timer);
                    current.consumed = true;
                    begin(event, { spaceId: space.id });
                  }
                }}
                onPointerUp={() => {
                  clearTimeout(press.current?.timer);
                  if (press.current) press.current.pressed = false;
                }}
                onLostPointerCapture={() => {
                  clearTimeout(press.current?.timer);
                  if (press.current) press.current.pressed = false;
                }}
                onPointerCancel={() => clearTimeout(press.current?.timer)}
              >
                {space.windowIds.map((id, position) => {
                  const win = state.workspace.windows.find((win) => win.id === id)!;
                  const icon = state.workspace.apps.find((app) => `web:${app.id}` === win.appId)?.iconUrl;
                  return (
                    <span
                      className={`group-rail-window app-${win.appId.startsWith('web:') ? 'web' : win.appId}`}
                      key={id}
                      style={{ flexGrow: space.weights[position] }}
                    >
                      <AppIcon appId={win.appId} iconUrl={icon} />
                    </span>
                  );
                })}
              </ButtonBase>
              <span className="group-rail-title">{appName(state.workspace, focused)}</span>
            </div>
          );
        })}
        {dragging && !('spaceId' in dragging) && (
          <div className="group-rail-new" data-new-group>
            +<span>新窗口组</span>
          </div>
        )}
      </div>
      <Tooltip title="切换器" placement="right">
        <IconButton aria-label="切换器" onClick={switcher}>
          <DashboardOutlined />
        </IconButton>
      </Tooltip>
      <Tooltip title="收起组栏" placement="right">
        <IconButton aria-label="收起组栏" disabled={!online} onClick={toggle}>
          <ChevronLeft />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={scaledAnchor(menu?.anchor)} open={!!menu} onClose={() => setMenu(undefined)}>
        <MenuItem
          disabled={!online}
          onClick={() => {
            if (menu) run({ type: 'space.close', spaceId: menu.id });
            setMenu(undefined);
          }}
        >
          关闭窗口组
        </MenuItem>
        <MenuItem
          disabled={
            !online ||
            (state.workspace.spaces.find((space) => space.id === menu?.id)?.windowIds.length ?? 0) < 2
          }
          onClick={() => {
            const ids =
              state.workspace.spaces.find((space) => space.id === menu?.id)?.windowIds.slice() ?? [];
            setMenu(undefined);
            void (async () => {
              for (const windowId of ids)
                await action({ type: 'window.place', windowId, placement: { mode: 'space' } });
            })().catch(report);
          }}
        >
          拆开
        </MenuItem>
      </Menu>
    </aside>
  );
}
