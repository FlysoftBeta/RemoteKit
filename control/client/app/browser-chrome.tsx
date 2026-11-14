import './browser-chrome.css';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  BedtimeOutlined,
  TimelapseOutlined,
  ArrowBack,
  ArrowForward,
  Language,
  MoreVert,
  Refresh,
  Star,
  StarBorder,
  Stop,
  Tab as TabIcon,
} from '@mui/icons-material';
import { Box, CircularProgress, InputBase } from '@mui/material';
import type { ProductState, ProductTab, ProductWindow } from '../../shared/product';
import { isLocalTab } from '../../shared/product';
import type { Action } from './product-dialogs';
import { Tool } from './window-tool';
import { TabStrip } from './tab-strip';
import type { WindowMenuControls } from './window-menus';
export function useBrowserNavigation({
  win,
  state,
  active,
  focused,
  fullscreen,
  online,
  navigationReady,
  action,
  report,
}: {
  win: ProductWindow;
  state: ProductState;
  active?: ProductTab;
  focused: boolean;
  fullscreen: boolean;
  online: boolean;
  navigationReady: boolean;
  action: Action;
  report(error: unknown): void;
}) {
  type AddressDraft = { phase: 'clean' | 'dirty'; value: string };
  const drafts = useRef(new Map<string | undefined, AddressDraft>());
  const [, redraw] = useState(0);
  const [pending, setPending] = useState(0);
  const busy = pending > 0;
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const latest = useRef({ activeId: active?.id, tabs: state.workspace.tabs });
  latest.current = { activeId: active?.id, tabs: state.workspace.tabs };
  const canonicalAddress = active && isLocalTab(active) ? '' : (active?.pendingUrl ?? active?.url ?? '');
  const address = drafts.current.get(active?.id)?.value ?? canonicalAddress;
  const setDraft = (tabId: string | undefined, draft: AddressDraft) => {
    drafts.current.set(tabId, draft);
    redraw((version) => version + 1);
  };
  const setAddress = (value: string) => setDraft(active?.id, { phase: 'dirty', value });
  const resetAddress = () => setDraft(active?.id, { phase: 'clean', value: canonicalAddress });
  const perform = async (command: Parameters<Action>[0]) => {
    setPending((count) => count + 1);
    try {
      return await action(command);
    } finally {
      setPending((count) => count - 1);
    }
  };
  const moveTab = (tabId: string, windowId: string, index: number) =>
    run({ type: 'tab.move', tabId, windowId, index });
  const run = (command: Parameters<Action>[0]) => {
    if (online) void perform(command).catch(report);
  };
  useLayoutEffect(() => {
    if (drafts.current.get(active?.id)?.phase !== 'dirty')
      setDraft(active?.id, { phase: 'clean', value: canonicalAddress });
  }, [active?.id, canonicalAddress]);
  useLayoutEffect(() => {
    for (const tabId of drafts.current.keys()) {
      if (tabId === undefined ? !!active : !state.workspace.tabs.some((tab) => tab.id === tabId))
        drafts.current.delete(tabId);
    }
  }, [state.workspace.tabs, active?.id]);
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
  const submit = async (value: string) => {
    if (!navigationReady || !value.trim()) return;
    const tabId = active?.id;
    const draft: AddressDraft = { phase: 'clean', value: value.trim() };
    setDraft(tabId, draft);
    try {
      await perform(
        tabId
          ? { type: 'tab.navigate', tabId, url: value.trim() }
          : { type: 'tab.create', windowId: win.id, url: value.trim() },
      );
      if (latest.current.activeId === tabId) input.current?.blur();
    } catch (failure) {
      if (
        drafts.current.get(tabId) === draft &&
        (tabId === undefined || latest.current.tabs.some((tab) => tab.id === tabId))
      )
        setDraft(tabId, { phase: 'dirty', value: value.trim() });
      throw failure;
    }
  };
  const createStartTab = () => {
    if (!online || busy) return;
    const tabId = active?.id;
    void perform({ type: 'tab.create', windowId: win.id })
      .then(() => {
        if (latest.current.activeId === tabId && window.matchMedia('(pointer: fine)').matches) {
          input.current?.focus({ preventScroll: true });
          input.current?.select();
        }
      })
      .catch(report);
  };
  const favorite = state.workspace.favorites.find((favorite) => favorite.url === active?.url);
  const favorited = !!favorite;
  const toggleFavorite = () => {
    if (favorite) run({ type: 'favorite.remove', id: favorite.id });
    else if (active) run({ type: 'favorite.add', url: active.url, title: active.title });
  };
  return {
    address,
    setAddress,
    busy,
    input,
    resetAddress,
    composing,
    moveTab,
    run,
    submit,
    createStartTab,
    favorited,
    toggleFavorite,
  };
}
export type BrowserNavigation = ReturnType<typeof useBrowserNavigation>;
export function BrowserChrome({
  win,
  state,
  active,
  tabs,
  online,
  creatingTab,
  navigationReady,
  origin,
  handle,
  report,
  navigation,
  menus,
}: {
  win: ProductWindow;
  state: ProductState;
  active?: ProductTab;
  tabs: ProductTab[];
  online: boolean;
  creatingTab: boolean;
  navigationReady: boolean;
  origin: string;
  handle: React.ReactNode;
  report(error: unknown): void;
  navigation: BrowserNavigation;
  menus: Pick<WindowMenuControls, 'openMore' | 'openTab'>;
}) {
  const {
    address,
    setAddress,
    busy,
    input,
    resetAddress,
    composing,
    moveTab,
    run,
    submit,
    createStartTab,
    favorited,
    toggleFavorite,
  } = navigation;
  return (
    <>
      <div className="tab-bar">
        {handle}
        <TabStrip
          windowId={win.id}
          group="browser"
          activeId={active?.id}
          items={tabs.map((tab) => ({
            id: tab.id,
            title: tab.title || '新标签页',
            icon: <BrowserTabIcon tab={tab} />,
            attention:
              !!state.pageDialogs?.some((d) => d.tabId === tab.id) ||
              !!state.fileRequests?.some((d) => d.tabId === tab.id),
          }))}
          disabled={!online}
          createDisabled={busy}
          create={createStartTab}
          select={(tabId) => run({ type: 'tab.activate', tabId })}
          close={(tabId) => run({ type: 'tab.close', tabId })}
          move={moveTab}
          menu={(anchor, id) => {
            const tab = tabs.find((tab) => tab.id === id);
            if (tab) menus.openTab({ anchor, tab });
          }}
        />
        <span className="tab-bar-spacer" />
        <Tool
          title="标签页操作"
          disabled={!active}
          onClick={(e) =>
            active && menus.openTab({ anchor: e.currentTarget, tab: active, fromToolbar: true })
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
            void submit(address).catch(report);
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
                resetAddress();
                input.current?.blur();
              }
            }}
          />
        </Box>
        {origin && (
          <Tool title={favorited ? '取消收藏' : '收藏'} disabled={!online} onClick={toggleFavorite}>
            {favorited ? <Star fontSize="small" /> : <StarBorder fontSize="small" />}
          </Tool>
        )}
        <Tool title="更多" onClick={(e) => menus.openMore(e.currentTarget)}>
          <MoreVert fontSize="small" />
        </Tool>
      </div>
    </>
  );
}

function BrowserTabIcon({ tab }: { tab: ProductTab }) {
  if (tab.idleKeepAlive)
    return <TimelapseOutlined className="tab-icon" sx={{ color: 'primary.main' }} titleAccess="挂机模式" />;
  if (tab.loading) return <CircularProgress className="tab-icon" size={13} />;
  if (tab.residency && tab.residency !== 'live') return <BedtimeOutlined className="tab-icon" />;
  return <Language className="tab-icon" />;
}
