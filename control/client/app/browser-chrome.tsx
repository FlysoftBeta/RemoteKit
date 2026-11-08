import './browser-chrome.css';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Add,
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
import { Box, InputBase } from '@mui/material';
import type { ProductState, ProductTab, ProductWindow } from '../../shared/product';
import { isLocalTab } from '../../shared/product';
import type { Action } from './product-dialogs';
import { Tool } from './window-tool';
import { BrowserTab, TabDragGhost } from './browser-tab';
import { beginTabPointer, registerTabStrip, tabShift, useTabDrag } from './tab-drag';
import { uiScale, useUiScale } from './ui-scale';
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
  const [address, setAddress] = useState(active && isLocalTab(active) ? '' : (active?.url ?? '')),
    [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null),
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
    setBusy,
    input,
    strip,
    stripRef,
    addressDirty,
    composing,
    drag,
    scale,
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
    setBusy,
    input,
    strip,
    stripRef,
    addressDirty,
    composing,
    drag,
    scale,
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
                  longPress: (anchor) => menus.openTab({ anchor, tab }),
                })
              }
              onContextMenu={(anchor) => menus.openTab({ anchor, tab })}
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
                  const next = (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
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
