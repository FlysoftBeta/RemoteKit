import { diagnostics } from '../media/diagnostics';
import {
  Add,
  ArrowBack,
  ArrowForward,
  Close,
  DriveFileMoveOutlined,
  Language,
  MoreVert,
  Star,
  StarBorder,
  OpenInNew,
  Refresh,
  Stop,
  Tab as TabIcon,
} from '@mui/icons-material';
import {
  Box,
  Divider,
  IconButton,
  InputBase,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  MenuList,
  Popover,
  Tooltip,
  Typography,
} from '@mui/material';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProductState, ProductTab, ProductWindow } from '../../shared/product';
import { isLocalTab, SEARCH_ENGINES } from '../../shared/product';
import { FilesApp } from '../files/files-app';
import { WindowHandle } from './window-handle';
import { useWindowState, waitForWorkspaceRevision, type WorkspaceCall } from './window-state';
import { BrowserSettingsSheet } from './browser-settings';
import { InstallDialog, SiteCompatibility } from './app-editor';
import { AppIcon } from './app-icon';
import { PageOverlay } from './page-overlay';
import type { Action } from './product-dialogs';
import { RemoteViewport } from './remote-viewport';
import { StartPage } from './start-page';
import { ViewerSession } from '../viewer-session';
import { BrowserTab, TabDragGhost } from './browser-tab';
import { beginTabPointer, registerTabStrip, tabShift, useTabDrag } from './tab-drag';
import { scaledAnchor, uiScale, useUiScale } from './ui-scale';
export function Tool({
  title,
  children,
  onClick,
  disabled,
  className,
}: {
  title: string;
  children: React.ReactNode;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Tooltip title={title}>
      <span className="tool-wrap">
        <IconButton className={className} aria-label={title} disabled={disabled} onClick={onClick}>
          {children}
        </IconButton>
      </span>
    </Tooltip>
  );
}
const dropDown = {
  anchorOrigin: { vertical: 'bottom', horizontal: 'right' },
  transformOrigin: { vertical: 'top', horizontal: 'right' },
} as const;
export function WindowFrame({
  win,
  state,
  transport,
  action,
  online,
  settingsContent,
  fileChooser,
  onSplit,
  call,
  weight,
  report,
  onGeometry,
  visible,
  fullscreen,
}: {
  win: ProductWindow;
  state: ProductState;
  transport: ViewerSession;
  action: Action;
  online: boolean;
  fileChooser?: React.ReactNode;
  settingsContent: (viewState: Record<string, unknown>, onState: (state: unknown) => void) => React.ReactNode;
  onSplit: (windowId: string, side: 'left' | 'right') => void;
  call: WorkspaceCall;
  weight: number;
  report: (error: unknown) => void;
  onGeometry: (id: string, width: number, height: number) => void;
  visible: boolean;
  fullscreen: boolean;
}) {
  const tabs = state.workspace.tabs.filter((t) => t.windowId === win.id),
    active = tabs.find((t) => t.id === win.activeTabId),
    focused =
      state.workspace.spaces.find((space) => space.id === state.workspace.activeSpaceId)?.focusedWindowId ===
      win.id;
  const [viewState, onState] = useWindowState(win, call, report);
  const [browserSettings, setBrowserSettings] = useState(false);
  const [install, setInstall] = useState(false);
  const app = state.workspace.apps.find((app) => `web:${app.id}` === win.appId);
  const browser = win.appId === 'browser';
  const local = win.appId === 'files' || win.appId === 'settings';
  const title =
    win.appId === 'files' ? '我的文件' : win.appId === 'settings' ? '设置' : (app?.name ?? '浏览器');
  const creatingTab = win.id.startsWith('pending-') || !!win.activeTabId?.startsWith('pending-');
  const navigationReady = online && !creatingTab;
  const [address, setAddress] = useState(active && isLocalTab(active) ? '' : (active?.url ?? '')),
    [busy, setBusy] = useState(false),
    [menu, setMenu] = useState<HTMLElement | null>(null),
    [tabMenu, setTabMenu] = useState<{
      anchor: HTMLElement;
      tab: ProductTab;
      fromToolbar?: boolean;
    } | null>(null),
    [siteMenuOrigin, setSiteMenuOrigin] = useState<string>();
  const input = useRef<HTMLInputElement>(null),
    content = useRef<HTMLDivElement>(null),
    strip = useRef<HTMLDivElement>(null);
  const addressDirty = useRef(false),
    previousTab = useRef(active?.id),
    composing = useRef(false);
  const drag = useTabDrag(),
    scale = useUiScale();
  const stripRef = useCallback(
    (element: HTMLDivElement | null) => {
      strip.current = element;
      registerTabStrip(win.id, element);
    },
    [win.id],
  );
  const moveTab = (tabId: string, windowId: string, index: number) =>
    run({ type: 'tab.move', tabId, windowId, index });
  const run = (command: Parameters<Action>[0]) => {
    if (!online) return;
    setBusy(true);
    void action(command)
      .catch(report)
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    if (previousTab.current !== active?.id) addressDirty.current = false;
    previousTab.current = active?.id;
    if (!addressDirty.current)
      setAddress(active && isLocalTab(active) ? '' : (active?.pendingUrl ?? active?.url ?? ''));
  }, [active?.id, active?.url, active?.pendingUrl, active?.kind]);
  const fullscreenWindowId = state.pageFullscreen?.windowId;
  useEffect(() => {
    if (!fullscreenWindowId) return;
    setMenu(null);
    setTabMenu(null);
    setSiteMenuOrigin(undefined);
  }, [fullscreenWindowId]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        !fullscreen &&
        focused &&
        !document.querySelector('[role="dialog"][aria-modal="true"]') &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === 'l'
      ) {
        event.preventDefault();
        event.stopPropagation();
        input.current?.focus({ preventScroll: true });
        input.current?.select();
      }
    };
    document.addEventListener('keydown', listener, true);
    return () => document.removeEventListener('keydown', listener, true);
  }, [focused, fullscreen]);
  useEffect(() => {
    const bar = strip.current;
    const selected = bar?.querySelector('[aria-selected="true"]')?.closest('.browser-tab');
    if (!bar || !selected) return;
    const bounds = bar.getBoundingClientRect();
    const tabBounds = selected.getBoundingClientRect();
    if (tabBounds.left < bounds.left) bar.scrollLeft += (tabBounds.left - bounds.left) / uiScale();
    else if (tabBounds.right > bounds.right) bar.scrollLeft += (tabBounds.right - bounds.right) / uiScale();
  }, [active?.id]);
  useEffect(() => {
    const node = content.current;
    if (!node) return;
    const measure = () => {
      // Layout px: the remote page's DIP size, independent of the UI scale transform.
      const width = node.offsetWidth,
        height = node.offsetHeight;
      if (!width || !height) return;
      onGeometry(win.id, width, height);
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined;
    observer?.observe(node);
    measure();
    return () => observer?.disconnect();
  }, [win.id, onGeometry]);
  let origin = '';
  try {
    const parsed = new URL(active?.url ?? '');
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origin = parsed.origin;
  } catch (error) {
    diagnostics.record('window-frame', error);
  }
  const sitePreferences = state.workspace.sites[origin];
  const closeMore = () => {
    setMenu(null);
    setSiteMenuOrigin(undefined);
  };
  const activate = () => {
    if (!focused && online) void action({ type: 'window.focus', windowId: win.id }).catch(report);
  };
  const submit = async (value: string) => {
    if (!navigationReady || !value.trim()) return;
    // Release the draft before dispatch so the pending projection and any WS
    // snapshot arriving before the receipt can update the canonical address.
    addressDirty.current = false;
    setAddress(value.trim());
    try {
      await action(
        active
          ? { type: 'tab.navigate', tabId: active.id, url: value.trim() }
          : { type: 'tab.create', windowId: win.id, url: value.trim() },
      );
    } catch (failure) {
      addressDirty.current = true;
      throw failure;
    }
  };
  const createStartTab = () => {
    if (!online || busy) return;
    setBusy(true);
    void action({ type: 'tab.create', windowId: win.id })
      .then(() => {
        if (window.matchMedia('(pointer: fine)').matches) {
          input.current?.focus({ preventScroll: true });
          input.current?.select();
        }
      })
      .catch(report)
      .finally(() => setBusy(false));
  };
  const toggleFavorite = () => {
    const favorite = state.workspace.favorites.find((favorite) => favorite.url === active?.url);
    if (favorite) run({ type: 'favorite.remove', id: favorite.id });
    else if (active) run({ type: 'favorite.add', url: active.url, title: active.title });
  };
  const openBrowser = () => {
    const target = [...state.workspace.windows]
      .filter((window) => window.appId === 'browser')
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
    if (target) run({ type: 'tab.create', windowId: target.id, url: active?.url });
    else run({ type: 'window.open', appId: 'browser', url: active?.url, placement: { mode: 'space' } });
  };
  const moreItems = browser
    ? [
        { label: '新建标签页', disabled: !online, select: createStartTab },
        {
          label: '新建窗口',
          disabled: !online,
          select: () => run({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } }),
        },
        { label: '安装为 App…', disabled: !online || !origin, select: () => setInstall(true) },
        {
          label: state.workspace.favorites.some((favorite) => favorite.url === active?.url)
            ? '取消收藏'
            : '收藏',
          disabled: !online || !origin,
          select: toggleFavorite,
        },
      ]
    : [
        {
          label: '刷新',
          disabled: !online || !active,
          select: () => active && run({ type: 'tab.command', tabId: active.id, command: 'reload' }),
        },
        {
          label: '复制链接',
          disabled: !active,
          select: () => {
            void navigator.clipboard.writeText(active?.url ?? '').catch(report);
          },
        },
        { label: '在浏览器中打开', disabled: !online || !active, select: openBrowser },
      ];
  return (
    <section
      className={`window-frame ${focused ? 'focused-window' : ''}`}
      style={{ flexGrow: weight, display: visible ? undefined : 'none' }}
      data-window-id={win.id}
      aria-label={`${title}窗口`}
      onPointerDownCapture={activate}
    >
      {local ? (
        <>
          <div className="app-title-bar">
            <WindowHandle
              win={win}
              state={state}
              online={online}
              action={action}
              report={report}
              onSplit={onSplit}
            />
            <Typography variant="subtitle2">{title}</Typography>
          </div>
          <div className="local-app-content">
            {win.appId === 'files' ? (
              <FilesApp
                windowId={win.id}
                state={viewState}
                onState={onState}
                previewEntryId={
                  typeof viewState.previewEntryId === 'string' ? viewState.previewEntryId : undefined
                }
              />
            ) : (
              settingsContent(viewState, onState)
            )}
          </div>
        </>
      ) : (
        <>
          {browser ? (
            <>
              <div className="tab-bar">
                <WindowHandle
                  win={win}
                  state={state}
                  online={online}
                  action={action}
                  report={report}
                  onSplit={onSplit}
                />
                <div
                  className={`tab-strip${drag ? ' tab-strip-dragging' : ''}${drag?.target?.windowId === win.id && drag.sourceWindowId !== win.id ? ' tab-drop-target' : ''}`}
                  role="tablist"
                  aria-label="标签页"
                  ref={stripRef}
                >
                  {tabs.map((tab, index) => (
                    <BrowserTab
                      key={tab.id}
                      tab={tab}
                      selected={active?.id === tab.id}
                      online={online}
                      attention={
                        !!state.pageDialogs?.some((d) => d.tabId === tab.id) ||
                        !!state.fileRequests?.some((d) => d.tabId === tab.id)
                      }
                      dragSource={drag?.tabId === tab.id}
                      shift={tabShift(drag, win.id, tab.id, index)}
                      onPointerDown={(event) =>
                        online &&
                        beginTabPointer({
                          event,
                          tabId: tab.id,
                          windowId: win.id,
                          title: tab.title || '新标签页',
                          index,
                          move: moveTab,
                          longPress: (anchor) => setTabMenu({ anchor, tab }),
                        })
                      }
                      onContextMenu={(anchor) => setTabMenu({ anchor, tab })}
                      onSelect={() => run({ type: 'tab.activate', tabId: tab.id })}
                      onClose={() => run({ type: 'tab.close', tabId: tab.id })}
                      onKeyDown={(e) => {
                        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.ctrlKey && e.shiftKey) {
                          e.preventDefault();
                          const to = index + (e.key === 'ArrowRight' ? 1 : -1);
                          if (to >= 0 && to < tabs.length) moveTab(tab.id, win.id, to);
                          return;
                        }
                        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                          e.preventDefault();
                          const next =
                            (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                          (strip.current?.querySelectorAll('.tab-select')[next] as HTMLElement)?.focus({
                            preventScroll: true,
                          });
                        }
                      }}
                    />
                  ))}
                </div>
                {drag?.sourceWindowId === win.id &&
                  createPortal(
                    <TabDragGhost
                      title={drag.title}
                      left={(drag.x - drag.grabX) / scale}
                      top={(drag.y - drag.grabY) / scale}
                      width={drag.width}
                    />,
                    document.body,
                  )}
                <Tool
                  title="新建标签页"
                  className="new-tab-button"
                  disabled={!online || busy}
                  onClick={createStartTab}
                >
                  <Add fontSize="small" />
                </Tool>
                <span className="tab-bar-spacer" />
                <Tool
                  title="标签页操作"
                  disabled={!active}
                  onClick={(e) =>
                    active && setTabMenu({ anchor: e.currentTarget, tab: active, fromToolbar: true })
                  }
                >
                  <TabIcon fontSize="small" />
                </Tool>
              </div>
              <div className="navigation-bar">
                <Tool
                  title="后退"
                  disabled={!online || !active || !active.canGoBack}
                  onClick={() => active && run({ type: 'tab.command', tabId: active.id, command: 'back' })}
                >
                  <ArrowBack fontSize="small" />
                </Tool>
                <Tool
                  title="前进"
                  className="forward-button"
                  disabled={!online || !active || !active.canGoForward}
                  onClick={() => active && run({ type: 'tab.command', tabId: active.id, command: 'forward' })}
                >
                  <ArrowForward fontSize="small" />
                </Tool>
                <Tool
                  title={active?.loading ? '停止加载' : '刷新'}
                  disabled={!online || !active || isLocalTab(active)}
                  onClick={() =>
                    active &&
                    run({
                      type: 'tab.command',
                      tabId: active.id,
                      command: active.loading ? 'stop' : 'reload',
                    })
                  }
                >
                  {active?.loading ? <Stop fontSize="small" /> : <Refresh fontSize="small" />}
                </Tool>
                <Box
                  component="form"
                  className="address-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (composing.current || busy || !navigationReady || !address.trim()) return;
                    setBusy(true);
                    void submit(address)
                      .then(() => input.current?.blur())
                      .catch(report)
                      .finally(() => setBusy(false));
                  }}
                >
                  <Language fontSize="small" />
                  <InputBase
                    inputRef={input}
                    fullWidth
                    placeholder={creatingTab ? '正在创建标签页…' : '搜索或输入网址'}
                    inputProps={{
                      'aria-label': '搜索或输入网址',
                      autoComplete: 'off',
                      spellCheck: false,
                    }}
                    value={address}
                    disabled={!navigationReady || busy}
                    onChange={(e) => {
                      addressDirty.current = true;
                      setAddress(e.target.value);
                    }}
                    onCompositionStart={() => {
                      composing.current = true;
                    }}
                    onCompositionEnd={() => {
                      composing.current = false;
                    }}
                    onKeyDown={(e) => {
                      if (
                        e.key === 'Enter' &&
                        (composing.current || e.nativeEvent.isComposing || e.keyCode === 229)
                      )
                        e.preventDefault();
                      if (e.key === 'Escape') {
                        addressDirty.current = false;
                        setAddress(active && isLocalTab(active) ? '' : (active?.url ?? ''));
                        input.current?.blur();
                      }
                    }}
                  />
                </Box>
                <Tool
                  title={
                    state.workspace.favorites.some((favorite) => favorite.url === active?.url)
                      ? '取消收藏'
                      : '收藏'
                  }
                  disabled={!online || !origin}
                  onClick={() => {
                    const favorite = state.workspace.favorites.find(
                      (favorite) => favorite.url === active?.url,
                    );
                    if (favorite) run({ type: 'favorite.remove', id: favorite.id });
                    else if (active) run({ type: 'favorite.add', url: active.url, title: active.title });
                  }}
                >
                  {state.workspace.favorites.some((favorite) => favorite.url === active?.url) ? (
                    <Star fontSize="small" />
                  ) : (
                    <StarBorder fontSize="small" />
                  )}
                </Tool>
                <Tool title="更多" onClick={(e) => setMenu(e.currentTarget)}>
                  <MoreVert fontSize="small" />
                </Tool>
              </div>
            </>
          ) : (
            <>
              <div className="app-title-bar">
                <WindowHandle
                  win={win}
                  state={state}
                  online={online}
                  action={action}
                  report={report}
                  onSplit={onSplit}
                />
                <span className="app-title-icon">
                  <AppIcon appId={win.appId} iconUrl={app?.iconUrl} />
                </span>
                <Typography variant="subtitle2" noWrap sx={{ flex: 1 }}>
                  {active?.title || title}
                </Typography>
                <Tool
                  title="后退"
                  disabled={!online || !active?.canGoBack}
                  onClick={() => active && run({ type: 'tab.command', tabId: active.id, command: 'back' })}
                >
                  <ArrowBack fontSize="small" />
                </Tool>
                <Tool title="更多" onClick={(e) => setMenu(e.currentTarget)}>
                  <MoreVert fontSize="small" />
                </Tool>
              </div>
              {(app?.display === 'browser' || (active?.url && !active.url.startsWith(app?.scope ?? ''))) && (
                <div className="app-origin-strip">{app?.display === 'browser' ? active?.url : origin}</div>
              )}
            </>
          )}
          <div className="window-content" ref={content}>
            {!active || active.kind === 'start' ? (
              <>
                <StartPage
                  key={active?.id ?? 'empty'}
                  engineLabel={
                    SEARCH_ENGINES.find(
                      (engine) => engine.value === state.workspace.settings.browser.searchEngine,
                    )?.label ?? 'Google'
                  }
                  online={navigationReady}
                  favorites={state.workspace.favorites}
                  onSubmit={submit}
                />
                {creatingTab && <PageOverlay kind="progress">正在创建标签页…</PageOverlay>}
              </>
            ) : (
              <>
                <RemoteViewport
                  key={active.id}
                  transport={transport}
                  viewId={active.webviewId}
                  overlay={state.workspace.settings.workspace.showStats ?? false}
                  keyboardActive={online && (focused || fullscreen) && visible}
                  manualKeyboard={!!sitePreferences?.manualKeyboard}
                  onFocus={activate}
                />
                {active.popup?.status === 'pending' ? (
                  <PageOverlay kind="progress">正在创建页面…</PageOverlay>
                ) : active.popup?.status === 'failed' ? (
                  <PageOverlay kind="error">{active.popup.error || '未能打开此页面'}</PageOverlay>
                ) : active.lifecycleRecoveryError ? (
                  <PageOverlay kind="error">{active.lifecycleRecoveryError}</PageOverlay>
                ) : (
                  !transport.presentation.presentationError &&
                  (active.restoring || (active.residency && active.residency !== 'live')) && (
                    <PageOverlay kind="progress">正在唤醒已休眠的标签页…</PageOverlay>
                  )
                )}
              </>
            )}
          </div>
          <Popover
            anchorEl={scaledAnchor(menu)}
            open={!!menu}
            onClose={closeMore}
            anchorOrigin={dropDown.anchorOrigin}
            transformOrigin={dropDown.transformOrigin}
            slotProps={{
              paper: {
                className: 'more-menu',
                sx: { width: 320, maxWidth: 'calc(var(--layout-vw) - 24px)' },
              },
            }}
          >
            {origin && siteMenuOrigin === origin ? (
              <MenuList aria-label="网页兼容性" dense>
                <MenuItem autoFocus onClick={() => setSiteMenuOrigin(undefined)}>
                  <ListItemIcon>
                    <ArrowBack fontSize="small" />
                  </ListItemIcon>
                  <ListItemText
                    primary="网页兼容性"
                    secondary={origin}
                    slotProps={{ secondary: { sx: { overflowWrap: 'anywhere' } } }}
                  />
                </MenuItem>
              </MenuList>
            ) : (
              <MenuList autoFocusItem={!!menu} dense>
                {moreItems.map((item) => (
                  <MenuItem
                    key={item.label}
                    disabled={item.disabled}
                    onClick={() => {
                      closeMore();
                      item.select();
                    }}
                  >
                    {item.label}
                  </MenuItem>
                ))}
                <MenuItem disabled={!origin} onClick={() => setSiteMenuOrigin(origin)}>
                  网页兼容性
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    closeMore();
                    if (browser) setBrowserSettings(true);
                    else {
                      void action({ type: 'window.open', appId: 'settings', placement: { mode: 'space' } })
                        .then(async (receipt) => {
                          const workspace = await waitForWorkspaceRevision(
                            transport,
                            receipt.revision ?? state.workspace.revision,
                          );
                          const settings = workspace.windows.find((window) => window.appId === 'settings');
                          if (settings)
                            await call('window.state', { windowId: settings.id, state: { section: 'apps' } });
                        })
                        .catch(report);
                    }
                  }}
                >
                  {browser ? '设置' : 'App 设置'}
                </MenuItem>
              </MenuList>
            )}
            {origin && siteMenuOrigin === origin && (
              <div className="site-menu-content">
                <SiteCompatibility
                  origin={origin}
                  tabId={active?.id}
                  state={state}
                  action={action}
                  online={online}
                />
              </div>
            )}
          </Popover>
          <Menu
            anchorEl={scaledAnchor(tabMenu?.anchor)}
            open={!!tabMenu}
            onClose={() => setTabMenu(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: tabMenu?.fromToolbar ? 'right' : 'left' }}
            transformOrigin={{ vertical: 'top', horizontal: tabMenu?.fromToolbar ? 'right' : 'left' }}
            slotProps={{ list: { dense: true } }}
          >
            <MenuItem
              disabled={!online}
              onClick={() => {
                if (tabMenu)
                  run({
                    type: 'window.open',
                    appId: 'browser',
                    placement: { mode: 'space' },
                    url: isLocalTab(tabMenu.tab) ? undefined : tabMenu.tab.url,
                  });
                setTabMenu(null);
              }}
            >
              <ListItemIcon>
                <OpenInNew fontSize="small" />
              </ListItemIcon>
              在新窗口打开
            </MenuItem>
            {state.workspace.windows
              .filter(
                (w) =>
                  w.id !== win.id &&
                  w.appId === 'browser' &&
                  state.workspace.spaces
                    .find((space) => space.windowIds.includes(win.id))
                    ?.windowIds.includes(w.id),
              )
              .map((w) => (
                <MenuItem
                  key={w.id}
                  disabled={!online}
                  onClick={() => {
                    if (tabMenu)
                      run({
                        type: 'tab.move',
                        tabId: tabMenu.tab.id,
                        windowId: w.id,
                      });
                    setTabMenu(null);
                  }}
                >
                  <ListItemIcon>
                    <DriveFileMoveOutlined fontSize="small" />
                  </ListItemIcon>
                  移到窗口 {state.workspace.windows.indexOf(w) + 1}
                </MenuItem>
              ))}
            <Divider />
            <MenuItem
              disabled={!online}
              onClick={() => {
                if (tabMenu) run({ type: 'tab.close', tabId: tabMenu.tab.id });
                setTabMenu(null);
              }}
            >
              <ListItemIcon>
                <Close fontSize="small" />
              </ListItemIcon>
              关闭标签页
            </MenuItem>
          </Menu>
          {browserSettings && (
            <BrowserSettingsSheet
              state={state}
              action={action}
              call={call}
              online={online}
              onClose={() => setBrowserSettings(false)}
            />
          )}
          {install && active && (
            <InstallDialog
              tabId={active.id}
              state={state}
              call={call}
              action={action}
              onClose={() => setInstall(false)}
            />
          )}
        </>
      )}
      {fileChooser}
    </section>
  );
}
