import './window-menus.css';
import React, { useEffect, useState } from 'react';
import {
  Add,
  ArrowBack,
  Close,
  DriveFileMoveOutlined,
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
import { InstallDialog, SiteCompatibility } from './app-editor';
import { scaledAnchor } from './ui-scale';
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
  const [siteMenuOrigin, setSiteMenuOrigin] = useState<string>();
  const [browserSettings, setBrowserSettings] = useState(false);
  const [install, setInstall] = useState(false);
  useEffect(() => {
    if (!fullscreenWindowId) return;
    setMenu(null);
    setTabMenu(null);
    setSiteMenuOrigin(undefined);
  }, [fullscreenWindowId]);
  const closeMore = () => {
    setMenu(null);
    setSiteMenuOrigin(undefined);
  };
  return {
    menu,
    tabMenu,
    siteMenuOrigin,
    browserSettings,
    install,
    openMore: setMenu,
    openTab: setTabMenu,
    closeMore,
    setSiteMenuOrigin,
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
    siteMenuOrigin,
    browserSettings,
    install,
    openTab: setTabMenu,
    closeMore,
    setSiteMenuOrigin,
    setBrowserSettings,
    setInstall,
  } = controls;
  const openBrowser = () => {
    const target = [...state.workspace.windows]
      .filter((window) => window.appId === 'browser')
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
    if (target) run({ type: 'tab.create', windowId: target.id, url: active?.url });
    else run({ type: 'window.open', appId: 'browser', url: active?.url, placement: { mode: 'space' } });
  };
  const moreItems: { label: string; icon: React.ReactElement; disabled?: boolean; select(): void }[] = browser
    ? [
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
                <ListItemIcon>{item.icon}</ListItemIcon>
                {item.label}
              </MenuItem>
            ))}
            {origin && (
              <MenuItem onClick={() => setSiteMenuOrigin(origin)}>
                <ListItemIcon>
                  <TuneOutlined />
                </ListItemIcon>
                网页兼容性
              </MenuItem>
            )}
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
  );
}
