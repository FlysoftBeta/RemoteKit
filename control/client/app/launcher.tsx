import { useAutoFocus } from '../editing/local-autofocus';
import './launcher.css';
import {
  AddToQueue,
  Close,
  OpenInNew,
  Search,
  ViewWeekOutlined,
  Fullscreen,
  FullscreenExit,
  LockOutlined,
} from '@mui/icons-material';
import {
  Alert,
  ButtonBase,
  IconButton,
  InputAdornment,
  ListItemIcon,
  Menu,
  MenuItem,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  isSingletonApp,
  type LauncherItem,
  type ProductState,
  type WindowPlacement,
} from '../../shared/product';
import { fileTypeColor, FileThumbnail, FileTypeIcon } from '../files/file-thumbnail';
import { useLibrary } from '../files/file-library-state';
import { launcherLayout, contrastColor, originColor, type LauncherTile } from './launcher-layout';
import { AppIcon } from './app-icon';
import { useItemDrag, useWindowDragging, type PointerStart } from './window-drag';
import { scaledAnchor, uiScale } from './ui-scale';
import type { WorkspaceCall } from './window-state';
import { LauncherSpaces } from './launcher-spaces';
import type { SpaceSnapshots } from './space-snapshots';
import type { Action } from './product-dialogs';
import { dominantColor } from './dominant-color';
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
  sync,
  lock,
  fullscreen,
  toggleFullscreen,
  snapshots,
  action,
  report,
}: {
  state: ProductState;
  lock(): void;
  fullscreen: boolean;
  toggleFullscreen(): void;
  snapshots: SpaceSnapshots;
  action: Action;
  report(error: unknown): void;
  call: WorkspaceCall;
  online: boolean;
  /** Workspace-wide audio channels; quick to reach from wherever the user is. */
  audio: React.ReactNode;
  /** Whether workspace operations have reached the Endpoint; shown only here. */
  sync: React.ReactNode;
  close(): void;
  activate(item: LauncherItem, placement?: WindowPlacement, reuseExisting?: boolean): Promise<void>;
  navigate(value: string, placement?: WindowPlacement): Promise<void>;
  exiting?: boolean;
}) {
  const autoFocusRef = useAutoFocus<HTMLInputElement>();
  const [newTarget, setNewTarget] = useState(false);
  useEffect(() => {
    if (!exiting) setNewTarget(false);
  }, [exiting]);
  const [items, setItems] = useState<LauncherItem[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [bounds, setBounds] = useState({ width: 1024, height: 600 });
  const [menu, setMenu] = useState<{ item: LauncherItem; anchor: HTMLElement }>();
  const host = useRef<HTMLDivElement>(null);
  const groupsHost = useRef<HTMLDivElement>(null);
  const rowsHost = useRef<HTMLDivElement>(null);
  const edgeSizes = useRef({ width: 0, contentWidth: 0 });
  const [edges, setEdges] = useState({ left: false, right: false });
  const measureEdges = () => {
    const node = groupsHost.current!;
    const left = node.scrollLeft > 1;
    const right = node.scrollLeft + edgeSizes.current.width < edgeSizes.current.contentWidth - 1;
    setEdges((previous) => (previous.left === left && previous.right === right ? previous : { left, right }));
  };
  const library = useLibrary();
  useEffect(() => {
    const node = groupsHost.current!;
    const wheel = (event: WheelEvent) => {
      if (!event.deltaY || event.deltaX) return;
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? edgeSizes.current.width : 1);
      const canScroll =
        delta > 0
          ? node.scrollLeft + edgeSizes.current.width < edgeSizes.current.contentWidth - 1
          : node.scrollLeft > 1;
      if (canScroll) {
        event.preventDefault();
        node.scrollLeft += delta;
      }
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, []);
  useLayoutEffect(() => {
    const groups = groupsHost.current!;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (entry.target === groups) {
          edgeSizes.current.width = width;
          setBounds((previous) =>
            previous.width === width && previous.height === height ? previous : { width, height },
          );
        } else edgeSizes.current.contentWidth = width;
      }
      measureEdges();
    });
    observer.observe(groups);
    observer.observe(rowsHost.current!);
    return () => observer.disconnect();
  }, []);
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
      !!item?.appId &&
      isSingletonApp(item.appId) &&
      state.workspace.windows.some((win) => win.appId === item.appId);
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
  const full = !!space && space.windowIds.length >= 3;
  const place = (target?: WindowPlacement, reuseExisting = false) => {
    if (menu) open(menu.item, target, reuseExisting);
    setMenu(undefined);
  };
  const liftItem = useItemDrag();
  const dragging = useWindowDragging();
  return (
    <div
      className={`workspace-overlay launcher${exiting ? ' overlay-exiting' : ''}${dragging && 'item' in dragging ? ' launcher-lifted' : ''}`}
      role="dialog"
      aria-label="开始屏幕"
      ref={host}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="launcher-heading">
        <Typography variant="h5">开始</Typography>
        <div className="launcher-system-controls">
          {sync}
          <div className="launcher-audio">{audio}</div>
          <Tooltip title="锁定">
            <IconButton aria-label="锁定" onClick={lock}>
              <LockOutlined />
            </IconButton>
          </Tooltip>
          <Tooltip title={fullscreen ? '退出全屏' : '全屏'}>
            <IconButton aria-label={fullscreen ? '退出全屏' : '全屏'} onClick={toggleFullscreen}>
              {fullscreen ? <FullscreenExit /> : <Fullscreen />}
            </IconButton>
          </Tooltip>
          <Tooltip title="关闭开始屏幕">
            <IconButton aria-label="关闭开始屏幕" onClick={close}>
              <Close />
            </IconButton>
          </Tooltip>
        </div>
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
            if (first) await activate(first, newTarget ? { mode: 'space' } : undefined);
            else await navigate(query.trim(), newTarget ? { mode: 'space' } : undefined);
          });
        }}
      >
        <TextField
          inputRef={autoFocusRef}
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
      <div className="launcher-body">
        <div
          className={`launcher-groups${edges.left ? ' fade-left' : ''}${edges.right ? ' fade-right' : ''}`}
          ref={groupsHost}
          onScroll={measureEdges}
          onClick={(event) => {
            if (!(event.target as Element).closest('.launcher-tile')) close();
          }}
        >
          <div ref={rowsHost} className="launcher-rows">
            {layout.groups.map((group) => (
              <section className="launcher-group" key={group.id}>
                <Typography variant="subtitle1">{group.title}</Typography>
                <div
                  className="launcher-row"
                  style={{
                    gridTemplateRows: `repeat(${group.rows}, ${layout.unit}px)`,
                    gridAutoColumns: `${layout.unit}px`,
                    gap: layout.gap,
                  }}
                >
                  {group.tiles.map((tile) => {
                    const entry = library.snapshot?.entries.find((entry) => entry.id === tile.entryId);
                    const color = contrastColor(
                      tile.kind === 'file'
                        ? fileTypeColor(entry?.type ?? '', tile.title)
                        : tile.appId === 'browser'
                          ? '#2563b8'
                          : tile.appId === 'files'
                            ? '#0d9488'
                            : tile.appId === 'study'
                              ? '#c2570c'
                              : tile.appId === 'questions'
                                ? '#4f46e5'
                                : tile.appId === 'settings'
                                  ? '#475569'
                                  : tile.appId === 'admin'
                                    ? '#7c3aed'
                                    : (tile.themeColor ?? originColor(tile.url ?? tile.key)),
                    );
                    return (
                      <LauncherTileView
                        key={tile.key}
                        tile={tile}
                        color={color}
                        imageFile={!!entry?.type.startsWith('image/')}
                        assetId={entry?.assetId}
                        fileType={entry?.type}
                        disabled={!online || busy}
                        open={() => open(tile, newTarget ? { mode: 'space' } : undefined)}
                        menu={(anchor) => setMenu({ item: tile, anchor })}
                        lift={(pointer) => {
                          try {
                            checkCapacity(tile);
                            liftItem(pointer, tile);
                          } catch (error) {
                            setError(formatError(error));
                          }
                        }}
                      >
                        {entry?.type.startsWith('image/') && (
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
        <LauncherSpaces
          state={state}
          snapshots={snapshots}
          action={action}
          online={online}
          newTarget={newTarget}
          targetNew={() => setNewTarget(true)}
          close={close}
          report={report}
        />
      </div>
      <Menu
        anchorEl={scaledAnchor(menu?.anchor)}
        open={!!menu}
        onClose={() => setMenu(undefined)}
        slotProps={{ list: { dense: true } }}
      >
        <MenuItem onClick={() => place({ mode: 'space' })}>
          <ListItemIcon>
            <AddToQueue fontSize="small" />
          </ListItemIcon>
          在新窗口组打开
        </MenuItem>
        <MenuItem
          disabled={full}
          onClick={() =>
            place(
              space
                ? {
                    mode: 'split',
                    besideWindowId: space.windowIds[space.windowIds.length - 1],
                    side: 'right',
                  }
                : { mode: 'space' },
            )
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
  imageFile,
  assetId,
  fileType,
  disabled,
  open,
  menu,
  lift,
  children,
}: {
  tile: LauncherTile;
  color: string;
  imageFile: boolean;
  assetId?: string;
  fileType?: string;
  disabled: boolean;
  open(): void;
  menu(anchor: HTMLElement): void;
  lift(pointer: PointerStart): void;
  children: React.ReactNode;
}) {
  const [imageColor, setImageColor] = useState<string>();
  const [previewFailed, setPreviewFailed] = useState(false);
  const preview = tile.kind === 'page' && tile.previewUrl && !previewFailed;
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
        timer?: ReturnType<typeof setTimeout>;
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
      className={`launcher-tile tile-${tile.size}${imageFile ? ' tile-image-file' : ''}${preview ? ' tile-page-preview' : ''}`}
      data-tile-key={tile.key}
      onLoadCapture={(event) => {
        if (!(event.target instanceof HTMLImageElement) || (!imageFile && !preview)) return;
        if (!event.target.matches('.launcher-page-image, .launcher-file-image img')) return;
        const value = dominantColor(event.target, assetId ?? tile.previewUrl!);
        if (value) setImageColor(value);
      }}
      disabled={disabled}
      style={
        {
          backgroundColor: imageColor ?? color,
          gridColumn: `${tile.column + 1} / span ${tile.columns}`,
          gridRow: `${tile.row + 1} / span ${tile.rows}`,
          '--tile-color': imageColor ?? color,
        } as React.CSSProperties
      }
      onClick={(event) => {
        if (event.detail === 0 || (!gesture.current?.consumed && !gesture.current?.moved)) open();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (gesture.current?.touch) return;
        if (gesture.current) gesture.current.consumed = true;
        menu(event.currentTarget);
      }}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          menu(event.currentTarget);
        }
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
          touch: event.pointerType !== 'mouse',
          scrolling: false,
          moved: false,
          consumed: false,
          timer:
            event.pointerType !== 'mouse'
              ? setTimeout(() => {
                  const current = gesture.current;
                  if (!current || current.moved) return;
                  current.consumed = true;
                  // The drag provider tracks the pointer from here; the tile stops scrolling the rows.
                  if (anchor.hasPointerCapture(pointerId)) anchor.releasePointerCapture(pointerId);
                  lift({
                    pointerId,
                    pointerType,
                    clientX: current.lastX,
                    clientY: current.lastY,
                  });
                }, 400)
              : undefined,
        };
        anchor.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = gesture.current;
        if (current?.consumed) return;
        if (current && Math.hypot(event.clientX - current.x, event.clientY - current.y) / uiScale() > 4) {
          current.moved = true;
          clearTimeout(current.timer);
          if (current.touch) current.scrolling = true;
          else {
            current.consumed = true;
            const anchor = event.currentTarget;
            if (anchor.hasPointerCapture(event.pointerId)) anchor.releasePointerCapture(event.pointerId);
            lift({
              pointerId: event.pointerId,
              pointerType: event.pointerType,
              clientX: event.clientX,
              clientY: event.clientY,
            });
          }
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
      {preview && (
        <img
          className="launcher-page-image"
          src={tile.previewUrl}
          alt=""
          draggable={false}
          onError={() => setPreviewFailed(true)}
        />
      )}
      {preview && <span className="tile-preview-scrim" />}
      {children}
      <span className="tile-icon">
        {tile.kind === 'file' ? (
          <FileTypeIcon type={fileType ?? ''} name={tile.title} />
        ) : tile.kind === 'page' ? (
          !preview && <PageIcon key={tile.url} url={tile.url!} iconUrl={tile.iconUrl} />
        ) : (
          <AppIcon appId={tile.appId} iconUrl={tile.iconUrl} />
        )}
      </span>
      <span className="tile-label">{tile.title}</span>
      {tile.size !== 'small' && tile.subtitle && <span className="tile-subtitle">{tile.subtitle}</span>}
    </ButtonBase>
  );
}

function PageIcon({ url, iconUrl }: { url: string; iconUrl?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <AppIcon />;
  return (
    <img
      className="launcher-app-icon"
      src={iconUrl ?? new URL('/favicon.ico', url).href}
      alt=""
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}
