import { Typography } from '@mui/material';
import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { RemoteKitError } from '../../shared/errors';
import type { ProductState, ProductWindow } from '../../shared/product';
import { BUILTIN_APP_TITLES, SEARCH_ENGINES, isBuiltinApp, isLocalApp } from '../../shared/product';
import { SurfaceState, failureError } from '../failures';
import { IdleKeepAliveNotice } from '../failures/idle-keep-alive';
import { failureContext, ownOperation } from '../failures/operations';
import { FilesWindow } from '../files/files-window';
import { SignInHost } from '../learning/sign-in-host';
import { diagnostics } from '../media/diagnostics';
import type { ViewerSession } from '../viewer-session';
import { AppChrome } from './app-chrome';
import { BrowserChrome, useBrowserNavigation } from './browser-chrome';
import { PageOverlay } from './page-overlay';
import { PermissionPrompt } from './permission-prompt';
import type { Action } from './product-dialogs';
import { RemoteViewport } from './remote-viewport';
import { StartPage } from './start-page';
import { useViewerSessionSelector } from './use-viewer-session';
import { useDropTarget, useWindowDragging } from './window-drag';
import './window-frame.css';
import { WindowHandle } from './window-handle';
import { WindowMenus, useWindowMenus } from './window-menus';
import { useWindowState, type WorkspaceCall } from './window-state';
const LearningApp = lazy(() =>
  import('../learning/learning-app').then((module) => ({ default: module.LearningApp })),
);
export function WindowFrame({
  win,
  state,
  transport,
  action: dispatchAction,
  online,
  appContent,
  fileChooser,
  call,
  weight,
  onGeometry,
  visible,
  fullscreen,
  surfaceFailure,
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
  onGeometry: (id: string, width: number, height: number) => void;
  visible: boolean;
  fullscreen: boolean;
  surfaceFailure?: { error: RemoteKitError; operation: string };
}) {
  const [windowFailure, setWindowFailure] = useState<RemoteKitError>();
  const report = useCallback(
    (error: unknown) => setWindowFailure(error === undefined ? undefined : failureError(error)),
    [],
  );
  const action = useCallback(
    (command: Parameters<Action>[0]) => {
      setWindowFailure(undefined);
      return dispatchAction(ownOperation(command, win.id));
    },
    [dispatchAction, win.id],
  );
  const operationFailure = useSyncExternalStore(
    transport.operations.subscribe,
    transport.operations.getSnapshot,
    transport.operations.getSnapshot,
  ).error;
  const receiptFailure =
    operationFailure && failureContext(operationFailure)?.ownerKey === win.id ? operationFailure : undefined;
  const failure = windowFailure ?? receiptFailure ?? surfaceFailure?.error;
  const failureOperation =
    windowFailure || receiptFailure ? '完成页面操作' : (surfaceFailure?.operation ?? '完成页面操作');
  const productLocked = useViewerSessionSelector(transport, (snapshot) => snapshot.authorization.locked);
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
          failure={failure}
          failureOperation={failureOperation}
        />
      ) : local ? (
        <>
          <div className="app-title-bar">
            {handle}
            <Typography variant="subtitle2">{title}</Typography>
          </div>
          <div className="local-app-content">
            <SurfaceState
              error={failure}
              context={{ operation: failureOperation, scope: 'surface', targetId: win.id }}
            />
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
            <SurfaceState
              live
              error={failure}
              context={{ operation: failureOperation, scope: 'surface', targetId: win.id }}
            />
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
                  <SurfaceState
                    live
                    error={active.popup.error}
                    context={{
                      operation: '打开新页面',
                      scope: 'surface',
                      action: {
                        label: '关闭标签页',
                        run: () => {
                          void action({ type: 'tab.close', tabId: active.id }).catch(report);
                        },
                      },
                    }}
                  />
                ) : active.lifecycleRecoveryError ? (
                  <SurfaceState
                    live
                    error={active.lifecycleRecoveryError}
                    context={{ operation: '恢复页面', scope: 'surface', consequence: '原页面实例已不可用' }}
                  />
                ) : (
                  !presentationError &&
                  (active.restoring || (active.residency && active.residency !== 'live')) && (
                    <PageOverlay kind="progress">正在唤醒已休眠的标签页…</PageOverlay>
                  )
                )}
              </>
            )}
            <IdleKeepAliveNotice
              tenant={state.workspace.tenantId}
              tab={active}
              visible={visible && online && !productLocked}
              acknowledge={(command) => {
                void action(command).catch(report);
              }}
            />
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
