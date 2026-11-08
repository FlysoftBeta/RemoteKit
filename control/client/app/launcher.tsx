import { Close, Search } from '@mui/icons-material';
import {
  Alert,
  ButtonBase,
  IconButton,
  InputAdornment,
  Menu,
  MenuItem,
  TextField,
  Typography,
  useTheme,
} from '@mui/material';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LauncherItem, ProductState, WindowPlacement } from '../../shared/product';
import { fileTypeColor, FileThumbnail } from '../files/file-thumbnail';
import { useLibrary } from '../files/file-library-state';
import { launcherLayout, contrastColor, originColor, type LauncherTile } from './launcher-layout';
import { AppIcon } from './app-icon';
import { scaledAnchor, uiScale } from './ui-scale';
import type { WorkspaceCall } from './window-state';
import { formatError } from '../util/format-error';

export function Launcher({
  state,
  call,
  placement,
  online,
  close,
  activate,
  navigate,
  exiting,
}: {
  state: ProductState;
  call: WorkspaceCall;
  placement?: WindowPlacement;
  online: boolean;
  close(): void;
  activate(item: LauncherItem, placement?: WindowPlacement, newWindow?: boolean): Promise<void>;
  navigate(value: string, placement?: WindowPlacement): Promise<void>;
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
  const layout = launcherLayout(items, bounds.height, query);
  useLayoutEffect(measureEdges, [layout.height, items]);
  const perform = (task: () => Promise<void>) => {
    if (busy || !online) return;
    setBusy(true);
    void task()
      .then(close)
      .catch((error) => setError(formatError(error)))
      .finally(() => setBusy(false));
  };
  const open = (item: LauncherItem, target = placement, newWindow = false) =>
    perform(() => activate(item, target, newWindow));
  const split = (side: 'left' | 'right'): WindowPlacement | undefined => {
    const space = state.workspace.spaces.find((space) => space.id === state.workspace.activeSpaceId);
    return space && space.windowIds.length < 3
      ? {
          mode: 'split',
          besideWindowId: space.windowIds[side === 'left' ? 0 : space.windowIds.length - 1],
          side,
        }
      : undefined;
  };
  return (
    <div
      className={`workspace-overlay launcher${exiting ? ' overlay-exiting' : ''}`}
      data-theme={theme.palette.mode}
      role="dialog"
      aria-label="开始屏幕"
      ref={host}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="launcher-heading">
        <Typography variant="h5">
          {placement?.mode === 'split' ? (placement.side === 'left' ? '在左侧分屏' : '在右侧分屏') : '开始'}
        </Typography>
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
            if (first) await activate(first, placement);
            else await navigate(query.trim(), placement);
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
                      edge={(side) => {
                        const target = split(side);
                        if (target) open(tile, target);
                      }}
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
      <Menu anchorEl={scaledAnchor(menu?.anchor)} open={!!menu} onClose={() => setMenu(undefined)}>
        <MenuItem
          onClick={() => {
            if (menu) open(menu.item, undefined, true);
            setMenu(undefined);
          }}
        >
          新窗口
        </MenuItem>
        {(['left', 'right'] as const).map((side) => (
          <MenuItem
            key={side}
            disabled={!split(side)}
            onClick={() => {
              const target = split(side);
              if (menu && target) open(menu.item, target);
              setMenu(undefined);
            }}
          >
            {side === 'left' ? '在左侧分屏' : '在右侧分屏'}
          </MenuItem>
        ))}
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
  edge,
  children,
}: {
  tile: LauncherTile;
  color: string;
  disabled: boolean;
  open(): void;
  menu(anchor: HTMLElement): void;
  edge(side: 'left' | 'right'): void;
  children: React.ReactNode;
}) {
  const gesture = useRef<
    | {
        x: number;
        y: number;
        lastX: number;
        lastY: number;
        touch: boolean;
        armed: boolean;
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
        gesture.current = {
          x: event.clientX,
          y: event.clientY,
          lastX: event.clientX,
          lastY: event.clientY,
          touch: event.pointerType === 'touch',
          armed: false,
          scrolling: false,
          moved: false,
          consumed: false,
          timer: setTimeout(() => {
            if (gesture.current && !gesture.current.moved) {
              gesture.current.armed = true;
            }
          }, 500),
        };
        anchor.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = gesture.current;
        if (current && Math.hypot(event.clientX - current.x, event.clientY - current.y) > 10) {
          current.moved = true;
          clearTimeout(current.timer);
          if (current.touch && !current.armed) current.scrolling = true;
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
        if (current?.moved && !current.scrolling) {
          const width = document.documentElement.clientWidth;
          if (event.clientX <= 48 * uiScale()) edge('left');
          else if (event.clientX >= width - 48 * uiScale()) edge('right');
          current.consumed = true;
        } else if (current?.armed && !current.consumed && !current.moved) {
          current.consumed = true;
          const anchor = event.currentTarget;
          // Let the touch's synthesized click finish before mounting a modal backdrop.
          current.timer = setTimeout(() => menu(anchor), 0);
        }
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
