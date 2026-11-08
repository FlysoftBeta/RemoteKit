import { Close } from '@mui/icons-material';
import { ButtonBase, IconButton, Typography, useTheme } from '@mui/material';
import React, { useEffect, useRef, useState } from 'react';
import type { ProductSpace, ProductState } from '../../shared/product';
import type { Action } from './product-dialogs';
import { AppIcon, appName } from './app-icon';
import { SpaceSnapshots } from './space-snapshots';
import { uiScale } from './ui-scale';

export function SpaceSwitcher({
  state,
  snapshots,
  action,
  close,
  report,
  online,
}: {
  state: ProductState;
  snapshots: SpaceSnapshots;
  action: Action;
  close(): void;
  report(error: unknown): void;
  online: boolean;
}) {
  const theme = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const [aspect, setAspect] = useState(16 / 9);
  useEffect(() => {
    const viewer = host.current!.parentElement!;
    const measure = () => setAspect(viewer.clientWidth / viewer.clientHeight);
    const observer = new ResizeObserver(measure);
    observer.observe(viewer);
    measure();
    return () => observer.disconnect();
  }, []);
  const [dragging, setDragging] = useState<string>();
  const pointer = useRef<
    | {
        id: string;
        x: number;
        y: number;
        lastX: number;
        lastY: number;
        touch: boolean;
        armed: boolean;
        scrolling: boolean;
        moved: boolean;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined
  >(undefined);
  useEffect(() => () => clearTimeout(pointer.current?.timer), []);
  const spaces = [...state.workspace.spaces].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  const run = (command: Parameters<Action>[0]) => void action(command).catch(report);
  const merge = async (source: ProductSpace, target: ProductSpace) => {
    if (source.id === target.id || source.windowIds.length + target.windowIds.length > 3) return;
    let besideWindowId = target.windowIds[target.windowIds.length - 1];
    for (const windowId of source.windowIds) {
      await action({
        type: 'window.place',
        windowId,
        placement: { mode: 'split', besideWindowId, side: 'right' },
      });
      besideWindowId = windowId;
    }
  };
  return (
    <div
      className="workspace-overlay space-switcher"
      data-theme={theme.palette.mode}
      ref={host}
      role="dialog"
      aria-label="空间切换器"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="launcher-heading">
        <Typography variant="h5">空间</Typography>
        <IconButton aria-label="关闭切换器" onClick={close}>
          <Close />
        </IconButton>
      </div>
      <div className="space-cards">
        {spaces.map((space, index) => (
          <div
            className={`space-card${space.id === state.workspace.activeSpaceId ? ' active-space-card' : ''}${dragging === space.id ? ' dragging-space-card' : ''}`}
            data-space-card={space.id}
            key={space.id}
            style={{ width: 200 + space.windowIds.length * 160 }}
            onPointerDown={(event) => {
              if (event.button !== 0 || (event.target as Element).closest('.space-close')) return;
              pointer.current = {
                id: space.id,
                x: event.clientX,
                y: event.clientY,
                lastX: event.clientX,
                lastY: event.clientY,
                touch: event.pointerType === 'touch',
                armed: false,
                scrolling: false,
                moved: false,
                timer: setTimeout(() => {
                  if (pointer.current && !pointer.current.moved) pointer.current.armed = true;
                }, 500),
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const current = pointer.current;
              if (!current || !online) return;
              if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 12) {
                current.moved = true;
                clearTimeout(current.timer);
                if (
                  current.touch &&
                  !current.armed &&
                  (host.current!.offsetWidth < 600
                    ? Math.abs(event.clientY - current.y) > Math.abs(event.clientX - current.x)
                    : Math.abs(event.clientX - current.x) > Math.abs(event.clientY - current.y))
                )
                  current.scrolling = true;
                if (!current.scrolling) setDragging(space.id);
              }
              if (current.scrolling) {
                const scroller = event.currentTarget.parentElement!;
                if (host.current!.offsetWidth < 600)
                  scroller.scrollTop -= (event.clientY - current.lastY) / uiScale();
                else scroller.scrollLeft -= (event.clientX - current.lastX) / uiScale();
              }
              current.lastX = event.clientX;
              current.lastY = event.clientY;
            }}
            onPointerUp={(event) => {
              const current = pointer.current;
              if (!current) return;
              clearTimeout(current.timer);
              pointer.current = undefined;
              setDragging(undefined);
              if (online && current.moved && !current.scrolling) {
                const targetId = document
                  .elementFromPoint(event.clientX, event.clientY)
                  ?.closest<HTMLElement>('[data-space-card]')?.dataset.spaceCard;
                const target = spaces.find((item) => item.id === targetId);
                if (target && target.id !== space.id) void merge(space, target).catch(report);
                else if ((current.y - event.clientY) / uiScale() >= 60)
                  run({ type: 'space.close', spaceId: space.id });
              } else if (online && !current.moved) {
                run({ type: 'space.activate', spaceId: space.id });
                close();
              }
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => {
              clearTimeout(pointer.current?.timer);
              pointer.current = undefined;
              setDragging(undefined);
            }}
          >
            <div className="space-card-heading">
              <div className="space-card-titles">
                {space.windowIds.map((id, position) => {
                  const win = state.workspace.windows.find((win) => win.id === id)!;
                  const app = state.workspace.apps.find((app) => `web:${app.id}` === win.appId);
                  return (
                    <React.Fragment key={id}>
                      {position > 0 && <span> · </span>}
                      <span className="space-card-title">
                        <AppIcon appId={win.appId} iconUrl={app?.iconUrl} />
                        <span>{appName(state.workspace, win)}</span>
                      </span>
                    </React.Fragment>
                  );
                })}
              </div>
              <IconButton
                className="space-close"
                aria-label={`关闭空间 ${index + 1}`}
                disabled={!online}
                onClick={() => run({ type: 'space.close', spaceId: space.id })}
              >
                <Close fontSize="small" />
              </IconButton>
            </div>
            <ButtonBase
              component="div"
              tabIndex={0}
              className="space-preview"
              style={{ aspectRatio: aspect }}
              aria-label={`进入空间 ${index + 1}`}
              onKeyDown={(event) => {
                if (online && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault();
                  run({ type: 'space.activate', spaceId: space.id });
                  close();
                }
              }}
            >
              {space.windowIds.map((id, position) => {
                const win = state.workspace.windows.find((win) => win.id === id)!;
                const app = state.workspace.apps.find((app) => `web:${app.id}` === win.appId);
                const image = snapshots.get(id);
                return (
                  <div
                    key={id}
                    className="space-window-preview"
                    style={{ flexGrow: space.weights[position] }}
                  >
                    {image ? (
                      <img src={image} alt="" draggable={false} />
                    ) : (
                      <span className="space-preview-icon">
                        <AppIcon appId={win.appId} iconUrl={app?.iconUrl} />
                      </span>
                    )}
                    <Typography variant="caption" noWrap>
                      {appName(state.workspace, win)}
                    </Typography>
                  </div>
                );
              })}
            </ButtonBase>
          </div>
        ))}
        {!spaces.length && <Typography>没有打开的空间</Typography>}
      </div>
    </div>
  );
}
