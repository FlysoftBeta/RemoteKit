import { KeyboardPreferenceContext } from '../editing/local-autofocus';
import { Suspense, lazy, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { ViewerSession } from '../viewer-session';
import { BlankScreen, RevealScreen } from '../auth/lock-screen';
import { UnlockView } from '../auth/unlock-view';
import { FileLibraryContext, useFileLibrary, type LibraryRequest } from '../files/file-library-state';
import type { AdminCall } from './admin/shared';
import type { SessionImportCall } from './session-import';
import { FloatingActions, FloatingActionsContext } from './floating-actions';
import { Stage, useWorkspaceStage } from './stage';
import { OverlayHost, openLauncherItem, useWorkspaceOverlays } from './overlay-host';
import { useSystemControls } from './system-controls';
import { WorkspaceSettings } from './workspace-settings';
import { selectVisibility } from './visibility';
import { WindowDragProvider } from './window-drag';

// Only the administrator downloads the console App.
const AdminApp = lazy(() => import('./admin/console').then((m) => ({ default: m.AdminApp })));

export function WorkspaceView({ logout, expired }: { logout(): void; expired(): void }) {
  const [media] = useState(() => new ViewerSession());
  const [floatingActions] = useState(() => new FloatingActions());
  const workspaceState = useSyncExternalStore(media.workspace.subscribe, media.workspace.getSnapshot);
  const operationState = useSyncExternalStore(media.operations.subscribe, media.operations.getSnapshot);
  const viewportNotice = useSyncExternalStore(media.viewport.subscribe, media.viewport.getSnapshot);
  const { auth, localLock, status } = workspaceState;
  const { state } = operationState;
  const showShell = !!state && !localLock && auth?.locked === false;
  const stage = useWorkspaceStage(media, state, showShell);
  const controls = useSystemControls({
    media,
    workspaceState,
    operationState,
    action: stage.action,
    showShell,
    floatingActions,
  });
  const overlays = useWorkspaceOverlays();
  const adminCall = useCallback<AdminCall>(
    (method, params) => media.control.request(method, params),
    [media],
  );
  const sessionImportCall = useCallback<SessionImportCall>(
    (method, params) => media.control.request(method, params),
    [media],
  );
  const libraryRequest = useCallback<LibraryRequest>(
    (method, params) => media.control.request(method, params),
    [media],
  );
  const library = useFileLibrary(
    libraryRequest,
    media.files,
    controls.productReady,
    showShell,
    auth?.user.id,
    state?.fileRequests.map((request) => request.id) ?? [],
    media.control.library,
    state,
  );
  useEffect(() => {
    let active = true;
    const start = async () => {
      if (import.meta.env.DEV) await import('../test-hooks');
      if (active) media.workspace.start();
    };
    void start();
    return () => {
      active = false;
      media.workspace.stop();
    };
  }, [media]);
  useEffect(() => {
    if (status === 'expired') expired();
  }, [status, expired]);
  const pending = state?.workspace.pendingClose;
  const foreground =
    state && !overlays.launcherOpen && !(pending && !pending.awaiting)
      ? selectVisibility(state, stage.width, controls.windowFullscreen).foreground
      : null;
  return (
    <KeyboardPreferenceContext.Provider value={state?.workspace.settings.workspace.autoKeyboard ?? false}>
      {localLock || auth?.locked !== false ? (
        <RevealScreen key={`${auth?.epoch ?? 'connecting'}:${localLock ?? ''}`}>
          {(close) => (
            <UnlockView
              auth={localLock ? null : auth}
              request={controls.authRequest}
              camera={controls.camera}
              close={close}
              retry={() => (status === 'revoked' ? location.reload() : media.control.restart())}
            />
          )}
        </RevealScreen>
      ) : !state ? (
        <BlankScreen />
      ) : (
        <FileLibraryContext.Provider value={library}>
          <FloatingActionsContext.Provider value={floatingActions}>
            {stage.deadZone > 0 && (
              <div
                className={`viewer-dead-zone${controls.fullscreen ? ' fullscreen' : ''}`}
                style={{ height: stage.deadZone / stage.scale }}
                aria-hidden
              />
            )}
            <WindowDragProvider
              state={state}
              snapshots={stage.snapshots}
              action={stage.action}
              report={media.workspace.report}
              openItem={async (item, placement) => {
                await openLauncherItem({
                  item,
                  placement,
                  state,
                  action: stage.action,
                  call: stage.call,
                  media,
                  notify: stage.notify,
                });
                overlays.closeLauncher();
              }}
            >
              <Stage
                state={state}
                media={media}
                stage={stage}
                controls={controls}
                floatingActions={floatingActions}
                workspaceState={workspaceState}
                operationState={operationState}
                viewportNotice={viewportNotice}
                obscured={overlays.launcherOpen}
                foreground={foreground}
                openLauncher={overlays.openLauncher}
                logout={logout}
                appContent={(appId, viewState, onState) =>
                  appId === 'admin' ? (
                    <Suspense fallback={null}>
                      <AdminApp
                        online={controls.productReady}
                        self={state.user.username}
                        call={adminCall}
                        viewState={viewState}
                        onState={onState}
                      />
                    </Suspense>
                  ) : (
                    <WorkspaceSettings
                      state={state}
                      viewState={viewState}
                      onState={onState}
                      action={stage.action}
                      call={stage.call}
                      sessionImportCall={sessionImportCall}
                      controls={controls}
                      workspaceState={workspaceState}
                      auth={auth}
                      logout={logout}
                    />
                  )
                }
              >
                <OverlayHost
                  state={state}
                  media={media}
                  stage={stage}
                  controls={controls}
                  overlays={overlays}
                  foreground={foreground}
                  readAnnouncement={(id) => media.control.request('announcement.read', { id })}
                />
              </Stage>
            </WindowDragProvider>
          </FloatingActionsContext.Provider>
        </FileLibraryContext.Provider>
      )}
    </KeyboardPreferenceContext.Provider>
  );
}
