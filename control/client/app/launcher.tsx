import { AddToQueue, Close, OpenInNew, Search, ViewWeekOutlined } from '@mui/icons-material';
import {
  Alert,
  ButtonBase,
  IconButton,
  InputAdornment,
  ListItemIcon,
  Menu,
  MenuItem,
  TextField,
  Typography,
  useTheme,
} from '@mui/material';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LauncherItem, ProductState, WindowPlacement } from '../../shared/product';
import { fileTypeColor, FileThumbnail } from '../files/file-thumbnail';
import { useLibrary } from '../files/file-library-state';
import { launcherLayout, contrastColor, originColor, type LauncherTile } from './launcher-layout';
import { AppIcon } from './app-icon';
import { useItemDrag, useWindowDragging, type PointerStart } from './window-drag';
import { scaledAnchor, uiScale } from './ui-scale';
import type { WorkspaceCall } from './window-state';
import { formatError } from '../util/format-error';

export function Launcher({
  state,
  call,
  online,
  close,
  activate,
  navigate,
  exiting,
  audio,
}: {
  state: ProductState;
  call: WorkspaceCall;
  online: boolean;
  /** Workspace-wide audio channels; quick to reach from wherever the user is. */
  audio: React.ReactNode;
  close(): void;
  activate(item: LauncherItem, placement?: WindowPlacement, reuseExisting?: boolean): Promise<void>;
  navigate(value: string): Promise<void>;
  exiting?: boolean;
}) {
  const theme = useTheme();
  const [items, setItems] = useState<LauncherItem[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [bounds, setBounds] = useState({ width: 1024, height: 600 });
  const [menu, setMenu] = useState<{ item: LauncherItem; anchor: HTMLElement }>();
  const host = useRef<HTMLDivElement>(null);
  const groupsHost = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measureEdges = () => {
    const node = groupsHost.current!;
    setEdges({ left: node.scrollLeft > 1, right: node.scrollLeft + node.clientWidth < node.scrollWidth - 1 });
  };
  const library = useLibrary();
  useEffect(() => {
    const node = groupsHost.current!;
    const wheel = (event: WheelEvent) => {
      if (!event.deltaY || event.deltaX) return;
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientWidth : 1);
      const canScroll =
        delta > 0 ? node.scrollLeft + node.clientWidth < node.scrollWidth - 1 : node.scrollLeft > 1;
      if (canScroll) {
        event.preventDefault();
        node.scrollLeft += delta;
      }
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, []);
  useLayoutEffect(() => {
    const node = host.current!;
    const groups = groupsHost.current!;
    const measure = () => {
      const bottom = parseFloat(getComputedStyle(groups).paddingBottom);
      setBounds({ width: node.offsetWidth, height: Math.max(0, groups.clientHeight - bottom) });
      measureEdges();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observer.observe(groups);
    measure();
    return () => observer.disconnect();
  }, [items]);
  useEffect(() => {
    let disposed = false;
    const timer = setTimeout(
      () => {
        void call('launcher.get', query.trim() ? { query } : {})
          .then((result) => {
            if (!disposed) {
              setItems(result.items);
              setError('');
            }
          })
          .catch((error) => {
            if (!disposed) setError(formatError(error));
          });
      },
      query ? 150 : 0,
    );
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [call, query]);
  const layout = launcherLayout(items, bounds.height, query, bounds.width);
  useLayoutEffect(measureEdges, [layout.height, items]);
  const perform = (task: () => Promise<void>) => {
    if (busy || !online) return;
    setBusy(true);
    void task()
      .then(close)
      .catch((error) => setError(formatError(error)))
      .finally(() => setBusy(false));
  };
  const checkCapacity = (item?: LauncherItem, reuseExisting = false) => {
    const singleton =
      item?.appId === 'settings' && state.workspace.windows.some((win) => win.appId === 'settings');
    const reuse =
      reuseExisting &&
      state.workspace.windows.some((win) => win.appId === (item?.kind === 'file' ? 'files' : 'browser'));
    if (state.workspace.windows.length >= 16 && !singleton && !reuse)
      throw new Error('窗口已满，请先关闭一些窗口');
  };
  const open = (item: LauncherItem, target?: WindowPlacement, reuseExisting = false) =>
    perform(async () => {
      checkCapacity(item, reuseExisting);
      await activate(item, target, reuseExisting);
    });
  const space = state.workspace.spaces.find((space) => space.id === state.workspace.activeSpaceId);
  const full = !space || space.windowIds.length >= 3;
  const place = (target?: WindowPlacement, reuseExisting = false) => {
    if (menu) open(menu.item, target, reuseExisting);
    setMenu(undefined);
  };
  const liftItem = useItemDrag();
  const dragging = useWindowDragging();
  return (
    <div
      className={`workspace-overlay launcher${exiting ? ' overlay-exiting' : ''}${dragging && 'item' in dragging ? ' launcher-lifted' : ''}`}
      data-theme={theme.palette.mode}
      role="dialog"
      aria-label="开始屏幕"
      ref={host}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="launcher-heading">
        <Typography variant="h5">开始</Typography>
        <div className="launcher-audio">{audio}</div>
        <IconButton aria-label="关闭开始屏幕" onClick={close}>
          <Close />
        </IconButton>
      </div>
      <form
        className="launcher-search"
        onSubmit={(event) => {
          event.preventDefault();
          if (!query.trim()) return;
          perform(async () => {
            const result = await call('launcher.get', { query });
            const first = launcherLayout(result.items, bounds.height, query).groups[0]?.tiles[0];
            checkCapacity(first);
            if (first) await activate(first);
            else await navigate(query.trim());
          });
        }}
      >
        <TextField
          autoFocus
          fullWidth
          placeholder="搜索 App、网页和文件"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          inputProps={{ 'aria-label': '搜索 App、网页和文件' }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) {
              if (event.key === 'Enter') event.preventDefault();
            }
          }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <Search />
                </InputAdornment>
              ),
            },
          }}
        />
      </form>
      {error && <Alert severity="error">{error}</Alert>}
      <div
        className={`launcher-groups${edges.left ? ' fade-left' : ''}${edges.right ? ' fade-right' : ''}`}
        ref={groupsHost}
        onScroll={measureEdges}
        onClick={(event) => {
          if (!(event.target as Element).closest('.launcher-tile')) close();
        }}
      >
        <div className="launcher-rows">
          {layout.groups.map((group) => (
            <section className="launcher-group" key={group.id}>
              <Typography variant="subtitle1">{group.title}</Typography>
              <div className="launcher-row" style={{ height: layout.height }}>
                {group.tiles.map((tile) => {
                  const entry = library.snapshot?.entries.find((entry) => entry.id === tile.entryId);
                  const color = contrastColor(
                    tile.kind === 'file'
                      ? fileTypeColor(entry?.type ?? '', tile.title)
                      : tile.appId === 'browser'
                        ? '#2563b8'
                        : tile.appId === 'files'
                          ? '#b77713'
                          : tile.appId === 'settings'
                            ? '#475569'
                            : (tile.themeColor ?? originColor(tile.url ?? tile.key)),
                  );
                  return (
                    <LauncherTileView
                      key={tile.key}
                      tile={tile}
                      color={color}
                      disabled={!online || busy}
                      open={() => open(tile)}
                      menu={(anchor) => setMenu({ item: tile, anchor })}
                      lift={(pointer) => liftItem(pointer, tile)}
                    >
                      {entry?.type.startsWith('image/') && tile.size !== 'small' && (
                        <div className="launcher-file-image">
                          <FileThumbnail
                            assetId={entry.assetId}
                            type={entry.type}
                            name={entry.name}
                            sx={{ width: '100%', height: '100%' }}
                          />
                        </div>
                      )}
                    </LauncherTileView>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
        {query && !layout.groups.length && <Typography>没有匹配项，按回车搜索或打开网址</Typography>}
      </div>
      <Menu
        anchorEl={scaledAnchor(menu?.anchor)}
        open={!!menu}
        onClose={() => setMenu(undefined)}
        slotProps={{ list: { dense: true } }}
      >
        <MenuItem onClick={() => place()}>
          <ListItemIcon>
            <AddToQueue fontSize="small" />
          </ListItemIcon>
          在新窗口组打开
        </MenuItem>
        <MenuItem
          disabled={full}
          onClick={() =>
            space &&
            place({
              mode: 'split',
              besideWindowId: space.windowIds[space.windowIds.length - 1],
              side: 'right',
            })
          }
        >
          <ListItemIcon>
            <ViewWeekOutlined fontSize="small" />
          </ListItemIcon>
          {full && space ? '当前窗口组已满' : '在当前窗口组打开'}
        </MenuItem>
        {menu?.item.kind === 'page' && state.workspace.windows.some((win) => win.appId === 'browser') && (
          <MenuItem onClick={() => place(undefined, true)}>
            <ListItemIcon>
              <OpenInNew fontSize="small" />
            </ListItemIcon>
            在现有浏览器窗口中打开
          </MenuItem>
        )}
        {menu?.item.kind === 'file' && state.workspace.windows.some((win) => win.appId === 'files') && (
          <MenuItem onClick={() => place(undefined, true)}>
            <ListItemIcon>
              <OpenInNew fontSize="small" />
            </ListItemIcon>
            在现有我的文件窗口中打开
          </MenuItem>
        )}
      </Menu>
    </div>
  );
}

function LauncherTileView({
  tile,
  color,
  disabled,
  open,
  menu,
  lift,
  children,
}: {
  tile: LauncherTile;
  color: string;
  disabled: boolean;
  open(): void;
  menu(anchor: HTMLElement): void;
  lift(pointer: PointerStart): void;
  children: React.ReactNode;
}) {
  const gesture = useRef<
    | {
        x: number;
        y: number;
        lastX: number;
        lastY: number;
        touch: boolean;
        scrolling: boolean;
        moved: boolean;
        consumed: boolean;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined
  >(undefined);
  useEffect(
    () => () => {
      clearTimeout(gesture.current?.timer);
    },
    [],
  );
  return (
    <ButtonBase
      className={`launcher-tile tile-${tile.size}`}
      disabled={disabled}
      style={{ backgroundColor: color, width: tile.width }}
      onClick={(event) => {
        if (event.detail === 0 || (!gesture.current?.consumed && !gesture.current?.moved)) open();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (gesture.current?.touch) return;
        if (gesture.current) gesture.current.consumed = true;
        menu(event.currentTarget);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) {
          clearTimeout(gesture.current?.timer);
          gesture.current = undefined;
          return;
        }
        const anchor = event.currentTarget;
        const { pointerId, pointerType } = event;
        gesture.current = {
          x: event.clientX,
          y: event.clientY,
          lastX: event.clientX,
          lastY: event.clientY,
          touch: event.pointerType === 'touch',
          scrolling: false,
          moved: false,
          consumed: false,
          timer: setTimeout(() => {
            const current = gesture.current;
            if (!current || current.moved) return;
            current.consumed = true;
            // The drag provider tracks the pointer from here; the tile stops scrolling the rows.
            if (anchor.hasPointerCapture(pointerId)) anchor.releasePointerCapture(pointerId);
            lift({ pointerId, pointerType, clientX: current.lastX, clientY: current.lastY, element: anchor });
          }, 400),
        };
        anchor.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = gesture.current;
        if (current?.consumed) return;
        if (current && Math.hypot(event.clientX - current.x, event.clientY - current.y) > 10) {
          current.moved = true;
          clearTimeout(current.timer);
          if (current.touch && !current.consumed) current.scrolling = true;
        }
        if (current?.scrolling) {
          const scroller = event.currentTarget.closest('.launcher-groups')!;
          scroller.scrollLeft -= (event.clientX - current.lastX) / uiScale();
          scroller.scrollTop -= (event.clientY - current.lastY) / uiScale();
        }
        if (current) {
          current.lastX = event.clientX;
          current.lastY = event.clientY;
        }
      }}
      onPointerUp={(event) => {
        const current = gesture.current;
        clearTimeout(current?.timer);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        clearTimeout(gesture.current?.timer);
        gesture.current = undefined;
      }}
    >
      {children}
      <span className="tile-icon">
        <AppIcon appId={tile.appId} iconUrl={tile.iconUrl} file={tile.kind === 'file'} />
      </span>
      <span className="tile-label">{tile.title}</span>
      {tile.size === 'wide' && tile.subtitle && <span className="tile-subtitle">{tile.subtitle}</span>}
    </ButtonBase>
  );
}
