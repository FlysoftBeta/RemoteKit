import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { ViewerSession } from '../viewer-session';
import { BlankScreen, RevealScreen } from '../auth/lock-screen';
import { UnlockView } from '../auth/unlock-view';
import { FileLibraryContext, useFileLibrary, type LibraryRequest } from '../files/file-library-state';
import type { AdminCall } from './admin/shared';
import type { SessionImportCall } from './session-import';
import { FloatingActions, FloatingActionsContext } from './floating-actions';
import { useViewerSession } from './use-viewer-session';
import { Stage, useWorkspaceStage } from './stage';
import { OverlayHost, openLauncherItem, useWorkspaceOverlays } from './overlay-host';
import { useSystemControls } from './system-controls';
import { WorkspaceSettings } from './workspace-settings';
import { selectVisibility } from './visibility';
import { WindowDragProvider } from './window-drag';

export function WorkspaceView({ logout, expired }: { logout(): void; expired(): void }) {
  const [media] = useState(() => new ViewerSession());
  const [floatingActions] = useState(() => new FloatingActions());
  const snapshot = useViewerSession(media);
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
    snapshot,
    action: stage.action,
    showShell,
    floatingActions,
  });
  const overlays = useWorkspaceOverlays(!!state?.user.isAdmin);
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
    state,
  );
  useEffect(() => {
    media.workspace.start();
    return () => media.workspace.stop();
  }, [media]);
  useEffect(() => {
    if (status === 'expired') expired();
  }, [status, expired]);
  if (localLock || auth?.locked !== false)
    return (
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
    );
  if (!state) return <BlankScreen />;
  const pending = state.workspace.pendingClose;
  const foreground =
    !overlays.launcherOpen && !overlays.admin && !(pending && !pending.awaiting)
      ? selectVisibility(state, stage.width).foreground
      : null;
  return (
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
            snapshot={snapshot}
            viewportNotice={viewportNotice}
            obscured={overlays.launcherOpen}
            foreground={foreground}
            openLauncher={overlays.openLauncher}
            openAdmin={overlays.openAdmin}
            logout={logout}
            settingsContent={(viewState, onState) => (
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
                openAdmin={overlays.openAdmin}
              />
            )}
          >
            <OverlayHost
              state={state}
              media={media}
              stage={stage}
              controls={controls}
              overlays={overlays}
              foreground={foreground}
              adminCall={adminCall}
              status={status}
            />
          </Stage>
        </WindowDragProvider>
      </FloatingActionsContext.Provider>
    </FileLibraryContext.Provider>
  );
}
