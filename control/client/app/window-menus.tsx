import './window-menus.css';
import React, { useEffect, useState } from 'react';
import {
  Add,
  Check,
  TimelapseOutlined,
  ArrowForward,
  Close,
  DriveFileMoveOutlined,
  Fullscreen,
  InstallDesktopOutlined,
  LinkOutlined,
  OpenInBrowser,
  OpenInNew,
  Refresh,
  SettingsOutlined,
  TuneOutlined,
} from '@mui/icons-material';
import { Divider, ListItemIcon, ListItemText, Menu, MenuItem, MenuList, Popover } from '@mui/material';
import type { ProductState, ProductTab, ProductWindow } from '../../shared/product';
import { isLocalTab } from '../../shared/product';
import type { ViewerSession } from '../viewer-session';
import type { Action } from './product-dialogs';
import { waitForWorkspaceRevision, type WorkspaceCall } from './window-state';
import { BrowserSettingsSheet } from './browser-settings';
import { InstallDialog } from './app-editor';
import { scaledAnchor } from './ui-scale';
import { SiteSettings } from './site-settings';
import { enterWindowFullscreen } from './window-fullscreen';
const dropDown = {
  anchorOrigin: { vertical: 'bottom', horizontal: 'right' },
  transformOrigin: { vertical: 'top', horizontal: 'right' },
} as const;
export function useWindowMenus(fullscreenWindowId?: string) {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [tabMenu, setTabMenu] = useState<{
    anchor: HTMLElement;
    tab: ProductTab;
    fromToolbar?: boolean;
  } | null>(null);
  const [browserSettings, setBrowserSettings] = useState(false);
  const [install, setInstall] = useState(false);
  useEffect(() => {
    if (!fullscreenWindowId) return;
    setMenu(null);
    setTabMenu(null);
  }, [fullscreenWindowId]);
  const closeMore = () => {
    setMenu(null);
  };
  return {
    menu,
    tabMenu,
    browserSettings,
    install,
    openMore: setMenu,
    openTab: setTabMenu,
    closeMore,
    setBrowserSettings,
    setInstall,
  };
}
export type WindowMenuControls = ReturnType<typeof useWindowMenus>;
export function WindowMenus({
  win,
  state,
  active,
  browser,
  origin,
  online,
  action,
  call,
  transport,
  report,
  run,
  createStartTab,
  controls,
}: {
  win: ProductWindow;
  state: ProductState;
  active?: ProductTab;
  browser: boolean;
  origin: string;
  online: boolean;
  action: Action;
  call: WorkspaceCall;
  transport: ViewerSession;
  report(error: unknown): void;
  run(command: Parameters<Action>[0]): void;
  createStartTab(): void;
  controls: WindowMenuControls;
}) {
  const {
    menu,
    tabMenu,
    browserSettings,
    install,
    openTab: setTabMenu,
    closeMore,
    setBrowserSettings,
    setInstall,
  } = controls;
  const [siteSettings, setSiteSettings] = useState<{ origin: string; tabId?: string }>();
  const openBrowser = () => {
    const target = [...state.workspace.windows]
      .filter((window) => window.appId === 'browser')
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
    if (target) run({ type: 'tab.create', windowId: target.id, url: active?.url });
    else run({ type: 'window.open', appId: 'browser', url: active?.url, placement: { mode: 'space' } });
  };
  const fullscreenItem = {
    label: '全屏',
    icon: <Fullscreen />,
    disabled: !active || isLocalTab(active),
    select: () => enterWindowFullscreen(win.id),
  };
  const moreItems: { label: string; icon: React.ReactElement; disabled?: boolean; select(): void }[] = browser
    ? [
        {
          label: '前进',
          icon: <ArrowForward />,
          disabled: !online || !active?.canGoForward,
          select: () => active && run({ type: 'tab.command', tabId: active.id, command: 'forward' }),
        },
        { label: '新建标签页', icon: <Add />, disabled: !online, select: createStartTab },
        {
          label: '新建窗口',
          icon: <OpenInNew />,
          disabled: !online,
          select: () => run({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } }),
        },
        ...(origin
          ? [
              {
                label: '安装为 App…',
                icon: <InstallDesktopOutlined />,
                disabled: !online,
                select: () => setInstall(true),
              },
            ]
          : []),
        fullscreenItem,
      ]
    : [
        {
          label: '刷新',
          icon: <Refresh />,
          disabled: !online || !active,
          select: () => active && run({ type: 'tab.command', tabId: active.id, command: 'reload' }),
        },
        {
          label: '复制链接',
          icon: <LinkOutlined />,
          disabled: !active,
          select: () => {
            void navigator.clipboard.writeText(active?.url ?? '').catch(report);
          },
        },
        {
          label: '在浏览器中打开',
          icon: <OpenInBrowser />,
          disabled: !online || !active,
          select: openBrowser,
        },
        fullscreenItem,
      ];
  return (
    <>
      <Popover
        anchorEl={scaledAnchor(menu)}
        open={!!menu}
        onClose={closeMore}
        anchorOrigin={dropDown.anchorOrigin}
        transformOrigin={dropDown.transformOrigin}
        slotProps={{
          paper: {
            className: 'more-menu',
            sx: { minWidth: 220, maxWidth: 'calc(var(--layout-vw) - 24px)' },
          },
        }}
      >
        <MenuList autoFocusItem={!!menu} dense>
          {browser && (
            <MenuItem
              role="menuitemcheckbox"
              aria-checked={!!active?.idleKeepAlive}
              disabled={!online || !active || isLocalTab(active) || !!active.signIn}
              onClick={() => {
                closeMore();
                if (active)
                  run({ type: 'tab.setIdleKeepAlive', tabId: active.id, enabled: !active.idleKeepAlive });
              }}
            >
              <ListItemIcon>{active?.idleKeepAlive ? <Check /> : <TimelapseOutlined />}</ListItemIcon>
              <ListItemText primary="挂机模式" secondary="离开后保持此页面运行至少 30 分钟" />
            </MenuItem>
          )}
          {moreItems.map((item) => (
            <MenuItem
              key={item.label}
              disabled={item.disabled}
              onClick={() => {
                closeMore();
                item.select();
              }}
            >
              <ListItemIcon>{item.icon}</ListItemIcon>
              {item.label}
            </MenuItem>
          ))}
          <MenuItem
            disabled={!origin || !online}
            onClick={() => {
              closeMore();
              setSiteSettings({ origin, tabId: active?.id });
            }}
          >
            <ListItemIcon>
              <TuneOutlined />
            </ListItemIcon>
            网站设置
          </MenuItem>
          <Divider />
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
            <ListItemIcon>
              <SettingsOutlined />
            </ListItemIcon>
            {browser ? '设置' : 'App 设置'}
          </MenuItem>
        </MenuList>
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
          currentSite={origin && active ? { origin, tabId: active.id } : undefined}
          onClose={() => setBrowserSettings(false)}
        />
      )}
      {siteSettings && (
        <SiteSettings
          origin={siteSettings.origin}
          tabId={siteSettings.tabId}
          state={state}
          action={action}
          online={online}
          onClose={() => setSiteSettings(undefined)}
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
  );
}
