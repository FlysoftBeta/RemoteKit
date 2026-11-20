import { setReduceMotion } from './motion-preference';
import { getSnapshot as devicePreferences } from './device-preferences';
import { buildAction } from '../control/action-builder';
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { RemoteKitError } from '../../shared/errors';
import { BlankScreen, LockScreen } from '../auth/lock-screen';
import { UnlockView } from '../auth/unlock-view';
import { useWorkspaceClipboard } from '../clipboard/workspace-clipboard';
import { deviceClipboard } from '../clipboard/device-clipboard';
import { KeyboardPreferenceContext } from '../editing/local-autofocus';
import { failureError, notices, onFailureAction, presentFailure } from '../failures';
import { useBackgroundNotices } from '../failures/background';
import { FileLibraryContext, useFileLibrary, type LibraryRequest } from '../files/file-library-state';
import { ViewerSession } from '../viewer-session';
import type { AdminCall } from './admin/shared';
import { FloatingActions, FloatingActionsContext } from './floating-actions';
import { OverlayHost, openLauncherItem, useWorkspaceOverlays } from './overlay-host';
import type { SessionImportCall } from './session-import';
import { Stage, useWorkspaceStage } from './stage';
import { useSystemControls } from './system-controls';
import { selectVisibility } from './visibility';
import { WindowDragProvider } from './window-drag';
import { WorkspaceSettings } from './workspace-settings';

// Only the administrator downloads the console App.
const AdminApp = lazy(() => import('./admin/console').then((m) => ({ default: m.AdminApp })));

export function WorkspaceView({ logout, expired }: { logout(): void; expired(): void }) {
  const [dragFailure, setDragFailure] = useState<RemoteKitError>();
  const [media] = useState(() => new ViewerSession());
  const [floatingActions] = useState(() => new FloatingActions());
  const workspaceState = useSyncExternalStore(media.workspace.subscribe, media.workspace.getSnapshot);
  const operationState = useSyncExternalStore(media.operations.subscribe, media.operations.getSnapshot);
  const viewportNotice = useSyncExternalStore(media.viewport.subscribe, media.viewport.getSnapshot);
  const { auth, localLock, status } = workspaceState;
  const identity = useRef<string | undefined>(undefined);
  if (auth?.user.id) identity.current = auth.user.id;
  const { state } = operationState;
  useEffect(() => {
    if (operationState.error)
      notices.post(
        'workspace:operation',
        presentFailure(operationState.error, { operation: '更新工作区', scope: 'global' }),
      );
  }, [operationState.error]);
  const reduceMotion = state?.workspace.settings.workspace.reduceMotion ?? false;
  useLayoutEffect(() => {
    setReduceMotion(reduceMotion);
  }, [reduceMotion]);
  useLayoutEffect(() => () => setReduceMotion(false), []);
  const showShell = !!state && !localLock && auth?.locked === false;
  useWorkspaceClipboard(showShell && status === 'online' ? auth.user.id : undefined, media.control);
  useEffect(() => {
    const set = (text: string) => media.control.request('clipboard.set', { text });
    deviceClipboard.configure(
      showShell && status === 'online' ? auth.user.id : undefined,
      state?.workspace.settings.workspace.clipboardSync ?? false,
      set,
      (revision) => media.control.request('clipboard.applied', { revision }),
    );
    return () => deviceClipboard.configure(undefined, false, set);
  }, [media, showShell, status, auth?.user.id, state?.workspace.settings.workspace.clipboardSync]);
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
  useBackgroundNotices(state, status === 'online' && showShell, sessionImportCall);
  const libraryRequest = useCallback<LibraryRequest>(
    (method, params) => media.control.request(method, params),
    [media],
  );
  const library = useFileLibrary(
    libraryRequest,
    media.libraryFiles,
    controls.shellReady,
    showShell,
    identity.current,
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
      notices.clear();
    };
  }, [media]);
  useEffect(() => {
    if (status === 'expired') expired();
  }, [status, expired]);
  useEffect(
    () =>
      onFailureAction((kind, context) => {
        if (kind === 'reload') location.reload();
        else if (kind === 'sign-in') expired();
        else if (kind === 'unlock') media.workspace.lock('manual');
        else if (kind === 'choose-file') {
          const input = document.createElement('input');
          input.type = 'file';
          if (devicePreferences().compatibility) input.accept = 'image/*';
          input.onchange = () => {
            const files = Array.from(input.files ?? []);
            if (!files.length) return;
            const sourceRequest =
              context.requestId &&
              media.operations
                .getSnapshot()
                .state?.fileRequests.find(
                  (request) => request.id === context.requestId && request.windowId === context.ownerKey,
                );
            if (context.requestId && !sourceRequest) return;
            try {
              library
                .importQueue(sourceRequest ? 'basket' : 'library', context.ownerKey)
                .enqueue(
                  files,
                  library.snapshot?.basket.length ?? 0,
                  sourceRequest
                    ? { kind: 'request', requestId: sourceRequest.id }
                    : { kind: 'files', channel: 'upload', partitionId: null },
                );
              if (!sourceRequest)
                void stage
                  .action(buildAction({ type: 'window.open', appId: 'files', placement: { mode: 'space' } }))
                  .catch((error) => setDragFailure(failureError(error)));
            } catch (error) {
              setDragFailure(failureError(error));
            }
          };
          input.click();
        } else if (kind === 'files')
          void stage
            .action(buildAction({ type: 'window.open', appId: 'files', placement: { mode: 'space' } }))
            .catch((error) => setDragFailure(failureError(error)));
        else if (kind === 'site-settings')
          void stage
            .action(buildAction({ type: 'window.open', appId: 'settings', placement: { mode: 'space' } }))
            .catch((error) => setDragFailure(failureError(error)));
        else if (kind === 'tabs') {
          const workspace = media.operations.getSnapshot().state?.workspace;
          const windowId =
            context.ownerKey ??
            workspace?.tabs.find((tab) => tab.id === context.targetId)?.windowId ??
            context.targetId;
          if (windowId && workspace?.windows.some((win) => win.id === windowId))
            void stage
              .action({ type: 'window.focus', windowId })
              .catch((error) => setDragFailure(failureError(error)));
        } else if (kind === 'provider-login') {
          void stage
            .action(
              buildAction({
                type: 'window.open',
                appId: context.credential === 'xinjiaoyu' ? 'questions' : 'study',
                placement: { mode: 'space' },
              }),
            )
            .catch((error) => setDragFailure(failureError(error)));
        } else if (kind === 'windows') overlays.openLauncher();
      }),
    [media, stage.action, expired, library.importQueue, library.snapshot],
  );
  useEffect(() => {
    const error =
      viewportNotice?.code === 'limit_exceeded'
        ? viewportNotice
        : state?.endpointErrorKind === 'output-capacity'
          ? state.endpointError
          : undefined;
    if (error)
      notices.post(
        'capacity:output',
        presentFailure(error, {
          operation: '调整远程画面',
          scope: 'global',
          capacity: 'windows',
          text: '画面尺寸超出可用范围，部分画面尚未显示',
        }),
      );
    else notices.resolve('capacity:output');
  }, [viewportNotice, state?.endpointError]);
  const seenTasks = useRef(new Map<string, string>());
  const taskViewer = showShell && status === 'online';
  useEffect(() => {
    if (!taskViewer) return;
    for (const task of state?.backgroundTasks ?? []) {
      if (seenTasks.current.get(task.id) === task.state) continue;
      seenTasks.current.set(task.id, task.state);
      notices.post(
        'task:download:' + task.id,
        task.error
          ? presentFailure(task.error, {
              operation: '下载到我的文件',
              scope: 'global',
              targetId: task.id,
            })
          : { class: 'B', text: `${task.name} 已下载到我的文件` },
      );
      void media.control
        .request('task.acknowledge', { id: task.id })
        .catch((error) =>
          notices.post(
            'task:acknowledge',
            presentFailure(failureError(error), { operation: '确认下载提示', scope: 'global' }),
          ),
        );
    }
  }, [media, taskViewer, state?.backgroundTasks]);
  const pending = state?.workspace.pendingClose;
  const foreground =
    state && !overlays.launcherOpen && !(pending && !pending.awaiting)
      ? selectVisibility(state, stage.width, controls.windowFullscreen).foreground
      : null;
  return (
    <KeyboardPreferenceContext.Provider value={state?.workspace.settings.workspace.autoKeyboard ?? false}>
      {localLock || auth?.locked !== false ? (
        <LockScreen
          key={`${auth?.epoch ?? 'connecting'}:${localLock ?? ''}`}
          auth={localLock ? null : auth}
          camera={controls.camera}
        >
          {(close, face) => (
            <UnlockView
              auth={localLock ? null : auth}
              request={controls.authRequest}
              face={face}
              close={close}
              connectionError={media.control.error}
              revoked={status === 'revoked'}
            />
          )}
        </LockScreen>
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
              report={(error) => setDragFailure(failureError(error))}
              openItem={async (item, placement) => {
                overlays.closeLauncher();
                await openLauncherItem({
                  item,
                  placement,
                  state,
                  action: stage.action,
                  call: stage.call,
                  media,
                });
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
                interactionFailure={dragFailure}
                obscured={overlays.launcherOpen}
                foreground={foreground}
                openLauncher={overlays.openLauncher}
                logout={logout}
                appContent={(appId, viewState, onState) =>
                  appId === 'admin' ? (
                    <Suspense fallback={null}>
                      <AdminApp
                        online={controls.shellReady}
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
