import React, { useEffect, useRef, useState } from 'react';
import {
  Box,
  CircularProgress,
  Divider,
  IconButton,
  InputBase,
  Menu,
  MenuList,
  Popover,
  MenuItem,
  Switch,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Add,
  ArrowBack,
  ArrowForward,
  Close,
  Language,
  MoreVert,
  Refresh,
  Stop,
  ViewColumn,
  Tab as TabIcon,
  Check,
  OpenInNew,
  BedtimeOutlined,
  ChevronRight,
} from '@mui/icons-material';
import type { ProductState, ProductTab, ProductWindow } from '../shared/product';
import { RemoteTransport } from './transport';
import { RemoteViewport } from './remote-viewport';
import type { Action } from './product-dialogs';
import { StartPage } from './start-page';
import { MyFiles } from './my-files';
import { isLocalTab, SEARCH_ENGINES } from '../shared/product';
import { AudioControls } from './audio-controls';
import type { AudioChannels } from './audio-output';
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
export function WindowFrame({
  win,
  state,
  transport,
  action,
  online,
  onSettings,
  onAdmin,
  onLogout,
  report,
  onGeometry,
  focusAddress,
  visible,
  fullscreen,
  audioSaving,
  audioError,
  saveAudio,
}: {
  win: ProductWindow;
  state: ProductState;
  transport: RemoteTransport;
  action: Action;
  online: boolean;
  onSettings: () => void;
  onAdmin: () => void;
  onLogout: () => void;
  report: (error: unknown) => void;
  onGeometry: (id: string, width: number, height: number) => void;
  focusAddress: string | null;
  visible: boolean;
  fullscreen: boolean;
  audioSaving: boolean;
  audioError: string;
  saveAudio: (channels: AudioChannels) => void;
}) {
  const tabs = state.workspace.tabs.filter((t) => t.windowId === win.id),
    active = tabs.find((t) => t.id === win.activeTabId),
    focused = state.workspace.activeWindowId === win.id;
  const creatingTab = win.id.startsWith('pending-') || !!win.activeTabId?.startsWith('pending-');
  const navigationReady = online && !creatingTab;
  const [address, setAddress] = useState(active && isLocalTab(active) ? '' : (active?.url ?? '')),
    [busy, setBusy] = useState(false),
    [menu, setMenu] = useState<HTMLElement | null>(null),
    [switcher, setSwitcher] = useState<HTMLElement | null>(null),
    [tabMenu, setTabMenu] = useState<{
      anchor: HTMLElement;
      tab: ProductTab;
    } | null>(null),
    [siteMenuOrigin, setSiteMenuOrigin] = useState<string>(),
    [siteSaving, setSiteSaving] = useState<
      Partial<Record<'tabletUa' | 'manualKeyboard', { origin: string; value: boolean }>>
    >({});
  const input = useRef<HTMLInputElement>(null),
    content = useRef<HTMLDivElement>(null),
    strip = useRef<HTMLDivElement>(null);
  const addressDirty = useRef(false),
    previousTab = useRef(active?.id),
    composing = useRef(false);
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
  useEffect(() => {
    if (focusAddress === win.id) {
      input.current?.focus({ preventScroll: true });
      input.current?.select();
    }
  }, [focusAddress]);
  const fullscreenWindowId = state.pageFullscreen?.windowId;
  useEffect(() => {
    if (!fullscreenWindowId) return;
    setMenu(null);
    setTabMenu(null);
    setSwitcher(null);
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
    if (tabBounds.left < bounds.left) bar.scrollLeft += tabBounds.left - bounds.left;
    else if (tabBounds.right > bounds.right) bar.scrollLeft += tabBounds.right - bounds.right;
  }, [active?.id]);
  useEffect(() => {
    const node = content.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      onGeometry(win.id, Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)));
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
  } catch {}
  const sitePreferences = state.workspace.sites[origin];
  const closeMore = () => {
    setMenu(null);
    setSiteMenuOrigin(undefined);
  };
  const toggleSitePreference = (preference: 'tabletUa' | 'manualKeyboard') => {
    if (
      !online ||
      !origin ||
      siteSaving[preference] ||
      (preference === 'tabletUa' && !state.integrations.siteUa)
    )
      return;
    const value = !sitePreferences?.[preference];
    setSiteSaving((current) => ({ ...current, [preference]: { origin, value } }));
    const update = preference === 'tabletUa' ? { tabletUa: value } : { manualKeyboard: value };
    void action({ type: 'site.set', origin, tabId: active?.id, ...update })
      .then((result) => {
        if (result.application) report(new Error('设置已保存，下次加载生效'));
      })
      .catch(report)
      .finally(() => setSiteSaving((current) => ({ ...current, [preference]: undefined })));
  };
  const activate = () => {
    if (!focused && online) void action({ type: 'window.activate', windowId: win.id }).catch(report);
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
  return (
    <section
      className={`window-frame ${focused ? 'focused-window' : ''}`}
      style={{ flexGrow: win.weight, display: visible ? undefined : 'none' }}
      aria-label={`浏览器窗口 ${state.workspace.windows.indexOf(win) + 1}`}
      onPointerDownCapture={activate}
    >
      <div className="tab-bar">
        <div className="tab-strip" role="tablist" aria-label="标签页" ref={strip}>
          {tabs.map((tab, index) => (
            <div
              className={`browser-tab ${active?.id === tab.id ? 'selected-tab' : ''}`}
              key={tab.id}
              onContextMenu={(e) => {
                e.preventDefault();
                setTabMenu({ anchor: e.currentTarget, tab });
              }}
            >
              <button
                type="button"
                className="tab-select"
                role="tab"
                disabled={!online}
                tabIndex={active?.id === tab.id ? 0 : -1}
                aria-selected={active?.id === tab.id}
                onClick={() => run({ type: 'tab.activate', tabId: tab.id })}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                    e.preventDefault();
                    const next = (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                    (strip.current?.querySelectorAll('.tab-select')[next] as HTMLElement)?.focus({
                      preventScroll: true,
                    });
                  }
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    run({ type: 'tab.activate', tabId: tab.id });
                  }
                }}
              >
                {tab.loading ? (
                  <CircularProgress className="tab-loading-indicator" size={13} />
                ) : tab.residency && tab.residency !== 'live' ? (
                  <BedtimeOutlined fontSize="inherit" />
                ) : (
                  <Language fontSize="inherit" />
                )}
                <span className="tab-title">
                  {tab.title || '新标签页'}
                  {(state.pageDialogs?.some((d) => d.tabId === tab.id) ||
                    state.fileRequests?.some((d) => d.tabId === tab.id)) && (
                    <span aria-label="页面等待处理请求"> ●</span>
                  )}
                </span>
              </button>
              <IconButton
                className="tab-close"
                size="small"
                aria-label={`关闭 ${tab.title || '标签页'}`}
                disabled={!online}
                onClick={() => run({ type: 'tab.close', tabId: tab.id })}
              >
                <Close fontSize="inherit" />
              </IconButton>
            </div>
          ))}
        </div>
        <Tool title="新建标签页" disabled={!online || busy} onClick={createStartTab}>
          <Add fontSize="small" />
        </Tool>
        <Tool
          title={`切换窗口，共 ${state.workspace.windows.length} 个`}
          onClick={(e) => setSwitcher(e.currentTarget)}
        >
          <ViewColumn fontSize="small" />
        </Tool>
        <Tool
          title="标签页操作"
          disabled={!active}
          onClick={(e) => active && setTabMenu({ anchor: e.currentTarget, tab: active })}
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
          disabled={!online || !active || active.kind === 'files'}
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
              if (e.key === 'Enter' && (composing.current || e.nativeEvent.isComposing || e.keyCode === 229))
                e.preventDefault();
              if (e.key === 'Escape') {
                addressDirty.current = false;
                setAddress(active && isLocalTab(active) ? '' : (active?.url ?? ''));
                input.current?.blur();
              }
            }}
          />
        </Box>
        <Tool title="更多" onClick={(e) => setMenu(e.currentTarget)}>
          <MoreVert fontSize="small" />
        </Tool>
      </div>
      <div className="window-content" ref={content}>
        {active?.kind === 'files' ? (
          <MyFiles key={active.id} visible={visible} />
        ) : !active || active.kind === 'start' ? (
          <>
            <StartPage
              key={active?.id ?? 'empty'}
              engineLabel={
                SEARCH_ENGINES.find((engine) => engine.value === state.workspace.settings.searchEngine)
                  ?.label ?? 'Google'
              }
              online={navigationReady}
              onSubmit={submit}
            />
            {creatingTab && (
              <div className="page-overlay" role="status">
                正在创建标签页…
              </div>
            )}
          </>
        ) : (
          <>
            <RemoteViewport
              key={active.id}
              transport={transport}
              viewId={active.webviewId}
              overlay={state.workspace.settings.showStats ?? false}
              keyboardActive={online && (focused || fullscreen) && visible}
              manualKeyboard={!!sitePreferences?.manualKeyboard}
              onFocus={activate}
            />
            {active.popup?.status === 'pending' ? (
              <div className="page-overlay" role="status">
                正在创建页面…
              </div>
            ) : active.popup?.status === 'failed' ? (
              <div className="page-overlay" role="alert">
                {active.popup.error || '未能打开此页面'}
              </div>
            ) : active.lifecycleRecoveryError ? (
              <div className="page-overlay" role="alert">
                {active.lifecycleRecoveryError}
              </div>
            ) : (
              !transport.presentationError &&
              (active.restoring || (active.residency && active.residency !== 'live')) && (
                <div className="page-overlay" role="status">
                  正在唤醒已休眠的标签页…
                </div>
              )
            )}
          </>
        )}
      </div>
      <Popover
        anchorEl={menu}
        open={!!menu}
        onClose={closeMore}
        slotProps={{ paper: { sx: { width: 360, maxWidth: 'calc(100vw - 24px)' } } }}
      >
        {origin && siteMenuOrigin === origin ? (
          <MenuList aria-label="网页兼容性处理">
            <MenuItem autoFocus onClick={() => setSiteMenuOrigin(undefined)}>
              <ArrowBack fontSize="small" sx={{ mr: 1.5 }} />
              网页兼容性处理
            </MenuItem>
            <Typography
              variant="caption"
              color="text.secondary"
              component="li"
              sx={{ px: 2, pb: 1, overflowWrap: 'anywhere' }}
            >
              {origin}
            </Typography>
            <Divider component="li" />
            {(
              [
                ['tabletUa', '使用平板版网站'],
                ['manualKeyboard', '不自动弹出键盘'],
              ] as const
            ).map(([preference, label]) => {
              const disabled =
                !online ||
                !!siteSaving[preference] ||
                (preference === 'tabletUa' && !state.integrations.siteUa);
              const pending = siteSaving[preference];
              const checked = pending?.origin === origin ? pending.value : !!sitePreferences?.[preference];
              return (
                <MenuItem
                  key={preference}
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  disabled={disabled}
                  onClick={() => toggleSitePreference(preference)}
                >
                  <Typography sx={{ flex: 1 }}>{label}</Typography>
                  <Switch
                    size="small"
                    checked={checked}
                    disabled={disabled}
                    slotProps={{ input: { tabIndex: -1, 'aria-hidden': true } }}
                    sx={{ pointerEvents: 'none' }}
                  />
                </MenuItem>
              );
            })}
          </MenuList>
        ) : (
          <>
            <MenuList autoFocusItem={!!menu}>
              <MenuItem
                disabled={!online}
                onClick={() => {
                  setMenu(null);
                  createStartTab();
                }}
              >
                新建标签页
              </MenuItem>
              <MenuItem
                disabled={!online}
                onClick={() => {
                  setMenu(null);
                  run({ type: 'window.create' });
                }}
              >
                新建窗口
              </MenuItem>
              <MenuItem
                disabled={!online}
                onClick={() => {
                  setMenu(null);
                  run({ type: 'tab.files', windowId: win.id });
                }}
              >
                我的文件
              </MenuItem>
              <MenuItem
                disabled={!online || !active?.canGoForward}
                onClick={() => {
                  setMenu(null);
                  active &&
                    run({
                      type: 'tab.command',
                      tabId: active.id,
                      command: 'forward',
                    });
                }}
              >
                前进
              </MenuItem>
              <Divider />
              <MenuItem
                disabled={!online}
                onClick={() => {
                  setMenu(null);
                  run({
                    type: 'window.layout',
                    mode: state.workspace.layoutMode === 'focused' ? 'side-by-side' : 'focused',
                  });
                }}
              >
                {state.workspace.layoutMode === 'focused' ? '并排显示' : '只显示此窗口'}
              </MenuItem>
              <MenuItem
                disabled={!online}
                onClick={() => {
                  setMenu(null);
                  run({ type: 'window.close', windowId: win.id });
                }}
              >
                关闭此窗口
              </MenuItem>
              <Divider />
              <MenuItem disabled={!origin} onClick={() => setSiteMenuOrigin(origin)}>
                <Typography sx={{ flex: 1 }}>网页兼容性处理</Typography>
                <ChevronRight fontSize="small" />
              </MenuItem>
              <Divider />
            </MenuList>
            <AudioControls
              channels={state.workspace.settings.audioChannels ?? { left: true, right: true }}
              online={online}
              playback={transport.audio.state}
              resume={() => transport.audio.resume()}
              save={saveAudio}
              busy={audioSaving}
              error={audioError}
            />
            <Divider />
            <MenuList>
              <MenuItem
                onClick={() => {
                  setMenu(null);
                  onSettings();
                }}
              >
                设置
              </MenuItem>
              {state.user.isAdmin && (
                <MenuItem
                  disabled={!online}
                  onClick={() => {
                    setMenu(null);
                    onAdmin();
                  }}
                >
                  管理员面板
                </MenuItem>
              )}
              <Divider />
              <MenuItem disabled>{state.user.username}</MenuItem>
              <MenuItem
                onClick={() => {
                  setMenu(null);
                  onLogout();
                }}
              >
                退出登录
              </MenuItem>
            </MenuList>
          </>
        )}
      </Popover>
      <Menu anchorEl={switcher} open={!!switcher} onClose={() => setSwitcher(null)}>
        {state.workspace.windows.map((w, index) => (
          <MenuItem
            key={w.id}
            disabled={!online}
            aria-label={`切换到窗口 ${index + 1}`}
            onClick={() => {
              setSwitcher(null);
              run({ type: 'window.activate', windowId: w.id });
            }}
          >
            {w.id === win.id ? <Check fontSize="small" /> : <span className="menu-icon-space" />}
            <span>
              {index + 1} · {state.workspace.tabs.find((t) => t.id === w.activeTabId)?.title || '新窗口'}
            </span>
          </MenuItem>
        ))}
        <Divider />
        <MenuItem
          disabled={!online}
          onClick={() => {
            setSwitcher(null);
            run({ type: 'window.create' });
          }}
        >
          新建窗口
        </MenuItem>
        <MenuItem
          disabled={!online}
          onClick={() => {
            setSwitcher(null);
            run({
              type: 'window.layout',
              mode: state.workspace.layoutMode === 'focused' ? 'side-by-side' : 'focused',
            });
          }}
        >
          {state.workspace.layoutMode === 'focused' ? '并排显示' : '只显示此窗口'}
        </MenuItem>
      </Menu>
      <Menu anchorEl={tabMenu?.anchor} open={!!tabMenu} onClose={() => setTabMenu(null)}>
        <MenuItem
          disabled={!online}
          onClick={() => {
            if (tabMenu)
              run({ type: 'window.create', url: isLocalTab(tabMenu.tab) ? undefined : tabMenu.tab.url });
            setTabMenu(null);
          }}
        >
          <OpenInNew fontSize="small" /> 在新窗口打开
        </MenuItem>
        {state.workspace.windows
          .filter((w) => w.id !== win.id)
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
              移到窗口 {state.workspace.windows.indexOf(w) + 1}
            </MenuItem>
          ))}
      </Menu>
    </section>
  );
}
export function WindowDivider({
  before,
  after,
  windows,
  online,
  action,
  report,
}: {
  before: ProductWindow;
  after: ProductWindow;
  windows: ProductWindow[];
  online: boolean;
  action: Action;
  report: (error: unknown) => void;
}) {
  const drag = useRef<{
    x: number;
    width: number;
    before: number;
    after: number;
  } | null>(null);
  const divider = useRef<HTMLDivElement>(null);
  const weights = useRef({ before: before.weight, after: after.weight });
  weights.current = { before: before.weight, after: after.weight };
  const revision = useRef(0);
  const restoreWeights = () => {
    const previous = divider.current?.previousElementSibling as HTMLElement | null;
    const next = divider.current?.nextElementSibling as HTMLElement | null;
    if (previous) previous.style.flexGrow = String(weights.current.before);
    if (next) next.style.flexGrow = String(weights.current.after);
  };
  useEffect(() => {
    if (!drag.current) restoreWeights();
  }, [before.weight, after.weight]);
  const clampRatio = (ratio: number, width?: number) => {
    const available =
      width ??
      ((divider.current?.previousElementSibling as HTMLElement)?.offsetWidth ?? 0) +
        ((divider.current?.nextElementSibling as HTMLElement)?.offsetWidth ?? 0);
    const minimum = Math.min(0.5, 360 / Math.max(1, available));
    return Math.max(minimum, Math.min(1 - minimum, ratio));
  };
  const change = (ratio: number) => {
    if (!online) {
      restoreWeights();
      return;
    }
    const attempt = ++revision.current;
    const sum = before.weight + after.weight,
      next = clampRatio(ratio);
    void action({
      type: 'window.layout',
      mode: 'side-by-side',
      weights: windows.map((w) => ({
        windowId: w.id,
        weight: w.id === before.id ? sum * next : w.id === after.id ? sum * (1 - next) : w.weight,
      })),
    }).catch((error) => {
      if (revision.current === attempt) restoreWeights();
      report(error);
    });
  };
  return (
    <div
      className="window-divider"
      ref={divider}
      role="separator"
      tabIndex={online ? 0 : -1}
      aria-disabled={!online}
      aria-label="调整窗口宽度"
      aria-orientation="vertical"
      aria-valuenow={Math.round((before.weight / (before.weight + after.weight)) * 100)}
      aria-valuemin={15}
      aria-valuemax={85}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          change(before.weight / (before.weight + after.weight) + (e.key === 'ArrowLeft' ? -0.05 : 0.05));
        }
      }}
      onPointerDown={(e) => {
        if (!online) return;
        const previous = e.currentTarget.previousElementSibling as HTMLElement,
          next = e.currentTarget.nextElementSibling as HTMLElement;
        drag.current = {
          x: e.clientX,
          width: previous.offsetWidth + next.offsetWidth,
          before: before.weight,
          after: after.weight,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const current = drag.current;
        if (!current || !online) return;
        const ratio = clampRatio(
          current.before / (current.before + current.after) + (e.clientX - current.x) / current.width,
          current.width,
        );
        (e.currentTarget.previousElementSibling as HTMLElement).style.flexGrow = String(
          (current.before + current.after) * ratio,
        );
        (e.currentTarget.nextElementSibling as HTMLElement).style.flexGrow = String(
          (current.before + current.after) * (1 - ratio),
        );
      }}
      onPointerUp={(e) => {
        const current = drag.current;
        if (current)
          change(current.before / (current.before + current.after) + (e.clientX - current.x) / current.width);
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
        ++revision.current;
        restoreWeights();
      }}
      onLostPointerCapture={() => {
        if (drag.current) {
          drag.current = null;
          ++revision.current;
          restoreWeights();
        }
      }}
    />
  );
}
