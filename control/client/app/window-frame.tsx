import './window-frame.css';
import { useDropTarget, useWindowDragging } from './window-drag';
import { useViewerSessionSelector } from './use-viewer-session';
import { diagnostics } from '../media/diagnostics';
import { Typography } from '@mui/material';
import React, { Suspense, lazy, useEffect, useMemo, useRef } from 'react';
import type { ProductState, ProductWindow } from '../../shared/product';
import { BUILTIN_APP_TITLES, SEARCH_ENGINES, isBuiltinApp, isLocalApp } from '../../shared/product';
import { FilesWindow } from '../files/files-window';
import { WindowHandle } from './window-handle';
import { useWindowState, type WorkspaceCall } from './window-state';
import { PageOverlay } from './page-overlay';
import type { Action } from './product-dialogs';
import { RemoteViewport } from './remote-viewport';
import { StartPage } from './start-page';
import type { ViewerSession } from '../viewer-session';
import { BrowserChrome, useBrowserNavigation } from './browser-chrome';
import { AppChrome } from './app-chrome';
import { WindowMenus, useWindowMenus } from './window-menus';
import { PermissionPrompt } from './permission-prompt';
import { SignInHost } from '../learning/sign-in-host';
const LearningApp = lazy(() =>
  import('../learning/learning-app').then((module) => ({ default: module.LearningApp })),
);
export function WindowFrame({
  win,
  state,
  transport,
  action,
  online,
  appContent,
  fileChooser,
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
  appContent: (
    appId: 'settings' | 'admin',
    viewState: Record<string, unknown>,
    onState: (state: unknown) => void,
  ) => React.ReactNode;
  call: WorkspaceCall;
  weight: number;
  report: (error: unknown) => void;
  onGeometry: (id: string, width: number, height: number) => void;
  visible: boolean;
  fullscreen: boolean;
}) {
  const presentationError = useViewerSessionSelector(transport, (snapshot) => snapshot.presentation.error);
  const drop = useDropTarget('window', win.id);
  const dragging = useWindowDragging();
  const source = dragging && 'windowId' in dragging && dragging.windowId === win.id;
  const windowTabs = state.workspace.tabs.filter((t) => t.windowId === win.id),
    tabs = windowTabs.filter((tab) => !tab.signIn),
    active = windowTabs.find((t) => t.id === win.activeTabId),
    focused =
      state.workspace.spaces.find((space) => space.id === state.workspace.activeSpaceId)?.focusedWindowId ===
      win.id;
  const [viewState, onState] = useWindowState(win, call, report);
  const app = state.workspace.apps.find((app) => `web:${app.id}` === win.appId);
  const browser = win.appId === 'browser';
  const local = isLocalApp(win.appId);
  const title = isBuiltinApp(win.appId)
    ? BUILTIN_APP_TITLES[win.appId]
    : (app?.name ?? BUILTIN_APP_TITLES.browser);
  const creatingTab = win.id.startsWith('pending-') || !!win.activeTabId?.startsWith('pending-');
  const navigationReady = online && !creatingTab;
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = content.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      if (width > 0 && height > 0) onGeometry(win.id, width, height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [win.id, onGeometry, local]);
  const signInHost = useMemo(
    () => ({
      transport,
      keyboardActive: online && (focused || fullscreen) && visible,
      measure: (width: number, height: number) => onGeometry(win.id, width, height),
      retry: (tabId: string) => {
        void action({ type: 'tab.command', tabId, command: 'reload' }).catch(report);
      },
    }),
    [transport, online, focused, fullscreen, visible, onGeometry, win.id, action, report],
  );
  let origin = '';
  try {
    const parsed = new URL(active?.url ?? '');
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origin = parsed.origin;
  } catch (error) {
    diagnostics.record('window-frame', error);
  }
  const activate = () => {
    if (!focused && online) void action({ type: 'window.focus', windowId: win.id }).catch(report);
  };
  const navigation = useBrowserNavigation({
    win,
    state,
    active,
    focused: focused && !local,
    fullscreen,
    online,
    navigationReady,
    action,
    report,
  });
  const menus = useWindowMenus(state.pageFullscreen?.windowId);
  const prompt = state.pageDialogs?.find(
    (dialog) => dialog.windowId === win.id && dialog.tabId === active?.id,
  );
  const { submit } = navigation;
  const handle = <WindowHandle win={win} state={state} online={online} action={action} report={report} />;
  return (
    <section
      ref={drop.ref}
      data-window-replace={drop.replace ? 'true' : undefined}
      className={`window-frame ${focused ? 'focused-window' : ''}`}
      style={{ flexGrow: weight, display: visible ? undefined : 'none', opacity: source ? 0.35 : undefined }}
      data-window-id={win.id}
      aria-label={`${title}窗口`}
      onPointerDownCapture={activate}
    >
      {win.appId === 'files' ? (
        <FilesWindow
          windowId={win.id}
          call={call}
          state={viewState}
          onState={onState}
          handle={handle}
          launch={win.state?.launch}
        />
      ) : local ? (
        <>
          <div className="app-title-bar">
            {handle}
            <Typography variant="subtitle2">{title}</Typography>
          </div>
          <div className="local-app-content">
            {win.appId === 'study' || win.appId === 'questions' ? (
              <SignInHost.Provider value={signInHost}>
                <Suspense fallback={<div role="status">正在打开…</div>}>
                  <LearningApp
                    appId={win.appId}
                    windowId={win.id}
                    state={state}
                    tab={active?.signIn ? active : undefined}
                    call={call}
                    action={action}
                    online={online}
                    transport={transport}
                  />
                </Suspense>
              </SignInHost.Provider>
            ) : (
              appContent(win.appId as 'settings' | 'admin', viewState, onState)
            )}
          </div>
        </>
      ) : (
        <>
          {browser ? (
            <BrowserChrome
              win={win}
              state={state}
              active={active}
              tabs={tabs}
              online={online}
              creatingTab={creatingTab}
              navigationReady={navigationReady}
              origin={origin}
              handle={handle}
              report={report}
              navigation={navigation}
              menus={menus}
            />
          ) : (
            <AppChrome
              win={win}
              active={active}
              app={app}
              title={title}
              origin={origin}
              online={online}
              handle={handle}
              run={navigation.run}
              openMore={menus.openMore}
            />
          )}
          <div className="window-content" ref={content}>
            {online && prompt && (prompt.kind === 'permission' || prompt.kind === 'protocol_handler') && (
              <PermissionPrompt key={prompt.id} dialog={prompt} action={action} />
            )}
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
                  autoKeyboard={state.workspace.settings.workspace.autoKeyboard}
                  onFocus={activate}
                />
                {active.popup?.status === 'pending' ? (
                  <PageOverlay kind="progress">正在创建页面…</PageOverlay>
                ) : active.popup?.status === 'failed' ? (
                  <PageOverlay kind="error">{active.popup.error || '未能打开此页面'}</PageOverlay>
                ) : active.lifecycleRecoveryError ? (
                  <PageOverlay kind="error">{active.lifecycleRecoveryError}</PageOverlay>
                ) : (
                  !presentationError &&
                  (active.restoring || (active.residency && active.residency !== 'live')) && (
                    <PageOverlay kind="progress">正在唤醒已休眠的标签页…</PageOverlay>
                  )
                )}
              </>
            )}
          </div>
          <WindowMenus
            win={win}
            state={state}
            active={active}
            browser={browser}
            origin={origin}
            online={online}
            action={action}
            call={call}
            transport={transport}
            report={report}
            run={navigation.run}
            createStartTab={navigation.createStartTab}
            controls={menus}
          />
        </>
      )}
      {fileChooser}
    </section>
  );
}
