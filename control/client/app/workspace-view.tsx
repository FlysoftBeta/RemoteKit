import type { LauncherItem, WindowPlacement } from '../../shared/product';
import { formatError } from '../util/format-error';
import { Add, AdminPanelSettingsOutlined, Logout, WebAssetOutlined } from '@mui/icons-material';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { AdminConsole } from './admin/console';
import type { AdminCall } from './admin/shared';
import { useAuthCamera, type AuthRequest } from '../auth/auth-camera';
import { useAutoLock } from '../auth/auth-idle';
import {
  DiagnosticCollection,
  diagnosticEnvironment,
  type DiagnosticState,
} from '../media/diagnostic-collection';
import { DiagnosticCollectionView, DiagnosticSettings } from './diagnostic-collection-view';
import { FileChooserDialog } from '../files/file-chooser-dialog';
import { FloatingActions, FloatingActionsContext, useFloatingAction } from './floating-actions';
import { FloatingDock } from './floating-dock';
import { deadZoneHeight, useTopInsetProbe } from './top-inset';
import { setUiScale } from './ui-scale';
import { FileLibraryContext, useFileLibrary, type LibraryRequest } from '../files/file-library-state';
import { BlankScreen, RevealScreen } from '../auth/lock-screen';
import type { AudioChannels } from '../media/audio-output';
import { PageDialogs, type Action } from './product-dialogs';
import { SecuritySettings } from '../auth/security-settings';
import { SessionImportSettings, type SessionImportCall } from './session-import';
import { UnlockView } from '../auth/unlock-view';
import { useAutoFullscreen } from './use-auto-fullscreen';
import { useViewerSession } from './use-viewer-session';
import { ViewerSession } from '../viewer-session';
import { selectVisibility } from './visibility';
import { WindowFrame } from './window-frame';
import { WindowDivider } from './window-divider';
import { Launcher } from './launcher';
import { launcherActions, launcherNavigation, launcherPlacement } from './launcher-actions';
import { SpaceSnapshots } from './space-snapshots';
import { HomeBar } from './home-bar';
import { usePagePreviews } from './page-previews';
import { SettingsApp } from './settings-app';
import { AudioControls } from './audio-controls';
import { appName } from './app-icon';
import { WindowDragProvider } from './window-drag';
import { waitForWorkspaceRevision, type WorkspaceCall } from './window-state';

const FULLSCREEN_EXIT_ANCHORS = ['top-left', 'top', 'top-right'] as const;

export function WorkspaceView({ logout, expired }: { logout: () => void; expired: () => void }) {
  const [media] = useState(() => new ViewerSession());
  const [floatingActions] = useState(() => new FloatingActions());
  const snapshot = useViewerSession(media);
  const workspaceState = useSyncExternalStore(media.workspace.subscribe, media.workspace.getSnapshot);
  const { auth, localLock, manualLock, status, error, idleRearmed } = workspaceState;
  const operationState = useSyncExternalStore(media.operations.subscribe, media.operations.getSnapshot);
  const { state, pending: pendingOperations } = operationState;
  const viewportNotice = useSyncExternalStore(media.viewport.subscribe, media.viewport.getSnapshot);
  const [overlay, setOverlay] = useState<{ kind: 'launcher' }>();
  const [visibleLauncher, setVisibleLauncher] = useState<typeof overlay>();
  useEffect(() => {
    if (overlay?.kind === 'launcher') {
      setVisibleLauncher(overlay);
      return;
    }
    const timer = setTimeout(() => setVisibleLauncher(undefined), overlay ? 0 : 160);
    return () => clearTimeout(timer);
  }, [overlay]);
  const [snapshots] = useState(() => new SpaceSnapshots());
  const [adminRequested, setAdmin] = useState(false);
  const admin = adminRequested && !!state?.user.isAdmin;
  const [audioSaving, setAudioSaving] = useState(false);
  const [audioError, setAudioError] = useState('');
  const [stageNotice, setStageNotice] = useState('');
  useEffect(() => {
    if (!stageNotice) return;
    const timer = setTimeout(() => setStageNotice(''), 3500);
    return () => clearTimeout(timer);
  }, [stageNotice]);
  const [width, setWidth] = useState(0);
  const shell = useRef<HTMLElement>(null);
  const previousSpace = useRef<{ id: string | null; windowIds: string[] } | undefined>(undefined);
  const audioPending = useRef(false);
  const connection = useRef(media.control);
  const showShell = !!state && !localLock && auth?.locked === false;
  const authRequest: AuthRequest = media.workspace.request;
  const lock = media.workspace.lock;
  const idle = useAutoLock(auth, lock);
  const camera = useAuthCamera(
    media,
    authRequest,
    localLock ? null : auth,
    status === 'online',
    manualLock,
    !idle.blocked && !localLock && idleRearmed,
    media.workspace.departureObserved,
  );
  const [diagnostics] = useState(
    () =>
      new DiagnosticCollection(
        (method, params) => media.control.request(method, params),
        (since) => media.observations.getDiagnosticCollectionSample(since),
        (snapshot) => setDiagnosticState(snapshot),
      ),
  );
  const [diagnosticState, setDiagnosticState] = useState<DiagnosticState>({ phase: 'idle' });
  useLayoutEffect(() => {
    diagnostics.setAvailable(status === 'online' && showShell);
  }, [diagnostics, status, showShell]);
  useEffect(() => () => diagnostics.dispose(), [diagnostics]);
  useEffect(() => {
    media.workspace.start();
    return () => media.workspace.stop();
  }, [media]);
  useEffect(() => {
    if (status === 'expired') expired();
  }, [status, expired]);
  useAutoFullscreen(showShell && state.workspace.settings.workspace.autoFullscreen === true);
  const pageFullscreen = !!state?.pageFullscreen;
  const contentWidth = width;
  const scale = state?.workspace.settings.workspace.uiScale ?? 1;
  const insets = useTopInsetProbe();
  const deadZone = deadZoneHeight(state?.workspace.settings.workspace.topDeadZone ?? 'off', insets);
  useLayoutEffect(() => {
    setUiScale(scale);
  }, [scale]);
  useLayoutEffect(() => () => setUiScale(1), []);
  useLayoutEffect(() => {
    const node = shell.current;
    if (!showShell || !node) return;
    const visual = window.visualViewport;
    // The shell follows the visual viewport below the dead zone. Under the scaled root its box is
    // in layout px (visual / scale); remote pages get layout px at devicePixelRatio × scale.
    const position = () => {
      node.style.left = `${(visual?.offsetLeft ?? 0) / scale}px`;
      node.style.top = `${((visual?.offsetTop ?? 0) + deadZone) / scale}px`;
    };
    const measure = () => {
      const width = (visual?.width ?? document.documentElement.clientWidth) / scale;
      const height =
        Math.max(1, (visual?.height ?? document.documentElement.clientHeight) - deadZone) / scale;
      node.style.width = `${width}px`;
      node.style.height = `${height}px`;
      setWidth(width);
      media.viewport.measure(
        Math.max(1, width),
        Math.max(1, height - 16),
        (window.devicePixelRatio || 1) * scale,
        document.visibilityState !== 'hidden',
      );
      position();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    visual?.addEventListener('resize', measure);
    visual?.addEventListener('scroll', position);
    window.addEventListener('resize', measure);
    document.addEventListener('visibilitychange', measure);
    measure();
    return () => {
      observer.disconnect();
      visual?.removeEventListener('resize', measure);
      visual?.removeEventListener('scroll', position);
      window.removeEventListener('resize', measure);
      document.removeEventListener('visibilitychange', measure);
    };
  }, [showShell, media, scale, deadZone, pageFullscreen]);
  const call: WorkspaceCall = useCallback((method, params) => media.control.request(method, params), [media]);
  const capturePreviews = usePagePreviews(
    state,
    shell,
    state && showShell ? selectVisibility(state, contentWidth).visibleWindowIds : [],
    call,
  );
  const onGeometry = media.viewport.setGeometry;
  const action: Action = useCallback(
    async (command) => {
      const current = media.operations.getSnapshot().authoritative?.workspace;
      if (
        current &&
        shell.current &&
        [
          'window.open',
          'window.focus',
          'window.place',
          'space.activate',
          'space.close',
          'tab.create',
          'tab.activate',
        ].includes(command.type)
      ) {
        const space = current.spaces.find((space) => space.id === current.activeSpaceId);
        if (space) snapshots.capture(shell.current, space.windowIds);
      }
      if (
        [
          'window.open',
          'window.focus',
          'window.place',
          'space.activate',
          'space.close',
          'tab.create',
          'tab.activate',
          'tab.navigate',
          'tab.command',
          'window.close',
          'tab.close',
        ].includes(command.type)
      )
        capturePreviews();
      return media.operations.action(command);
    },
    [media, snapshots, capturePreviews],
  );
  useEffect(() => {
    if (!overlay) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOverlay(undefined);
      }
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [overlay]);
  useLayoutEffect(() => {
    const workspace = state?.workspace;
    if (previousSpace.current && previousSpace.current.id !== workspace?.activeSpaceId && shell.current)
      snapshots.capture(shell.current, previousSpace.current.windowIds);
    const space = workspace?.spaces.find((space) => space.id === workspace.activeSpaceId);
    previousSpace.current = { id: workspace?.activeSpaceId ?? null, windowIds: space?.windowIds ?? [] };
    snapshots.retain(state?.workspace.windows.map((win) => win.id) ?? []);
  }, [state?.workspace.activeSpaceId, state?.workspace.windows, snapshots]);
  const report = media.workspace.report;
  const saveAudio = (channels: AudioChannels) => {
    if (audioPending.current || status !== 'online' || !snapshot.authorization.ready) return;
    audioPending.current = true;
    setAudioSaving(true);
    setAudioError('');
    void action({ type: 'settings.update', settings: { workspace: { audioChannels: channels } } })
      .catch(() => {
        setAudioError('声音设置未保存，请重试');
      })
      .finally(() => {
        audioPending.current = false;
        setAudioSaving(false);
      });
  };
  const adminCall = useCallback<AdminCall>(
    (method, params) => connection.current!.request(method, params),
    [],
  );
  const sessionImportCall = useCallback<SessionImportCall>(
    (method, params) => connection.current!.request(method, params),
    [],
  );
  const productReady = status === 'online' && snapshot.authorization.ready;
  const fullscreen = state?.pageFullscreen;
  const fullscreenTarget = fullscreen?.target;
  const exitingFullscreen = pendingOperations.some(
    (entry) =>
      entry.action.type === 'page.exitFullscreen' &&
      entry.action.target === fullscreenTarget &&
      (!entry.receipt || ['accepted', 'applying', 'unknown'].includes(entry.receipt.status)),
  );
  const exitFullscreen = useRef<() => void>(() => {});
  exitFullscreen.current = () => {
    if (fullscreenTarget && productReady && !exitingFullscreen)
      void action({ type: 'page.exitFullscreen', target: fullscreenTarget }).catch(report);
  };
  useEffect(() => {
    if (!fullscreenTarget) return;
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.repeat ||
        event.isComposing ||
        document.querySelector('[role="dialog"][aria-modal="true"]')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      exitFullscreen.current();
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [fullscreenTarget]);
  const libraryRequest: LibraryRequest = useCallback(
    (method, params) => connection.current!.request(method, params),
    [],
  );
  const library = useFileLibrary(
    libraryRequest,
    media.files,
    productReady,
    showShell,
    auth?.user.id,
    state?.fileRequests.map((request) => request.id) ?? [],
    state,
  );
  const audioBlocked =
    productReady &&
    media.observations.audio.state === 'blocked' &&
    (state?.workspace.settings.workspace.audioChannels?.left !== false ||
      state?.workspace.settings.workspace.audioChannels?.right !== false);
  useFloatingAction(
    'fullscreen',
    fullscreenTarget
      ? {
          order: 0,
          anchor: 'top-right',
          anchors: FULLSCREEN_EXIT_ANCHORS,
          label: '退出网页全屏',
          icon: 'fullscreen-exit',
          disabled: !productReady || exitingFullscreen,
          run: () => exitFullscreen.current(),
        }
      : null,
    floatingActions,
  );
  useFloatingAction(
    'sound',
    audioBlocked
      ? {
          order: 20,
          anchor: 'bottom-right',
          label: '开启声音',
          detail: '浏览器拦截了自动播放',
          icon: 'sound',
          attention: 'notice',
          run: () => media.observations.audio.resume(),
        }
      : null,
    floatingActions,
  );
  const collecting =
    diagnosticState.phase === 'collecting' ||
    diagnosticState.phase === 'finalizing' ||
    diagnosticState.phase === 'retry';
  useFloatingAction(
    'diagnostics',
    collecting
      ? {
          order: 30,
          anchor: 'bottom',
          label: diagnosticState.phase === 'retry' ? '重试确认' : '停止数据收集',
          detail:
            diagnosticState.phase === 'retry'
              ? '诊断保存尚未确认'
              : diagnosticState.phase === 'finalizing'
                ? '正在保存诊断…'
                : `已收集 ${diagnosticState.samples} 个样本`,
          icon: 'stop',
          attention: 'recording',
          disabled: diagnosticState.phase === 'finalizing' || status !== 'online',
          run: () => diagnostics.stop(),
        }
      : null,
    floatingActions,
  );
  if (localLock || auth?.locked !== false)
    return (
      <RevealScreen key={`${auth?.epoch ?? 'connecting'}:${localLock ?? ''}`}>
        {(close) => (
          <UnlockView
            auth={localLock ? null : auth}
            request={authRequest}
            camera={camera}
            close={close}
            retry={() => (status === 'revoked' ? location.reload() : connection.current?.restart())}
          />
        )}
      </RevealScreen>
    );
  if (!state) return <BlankScreen />;

  const workspace = state.workspace,
    sideBySide = selectVisibility(state, contentWidth).sideBySide,
    activeSpace = selectVisibility(state, contentWidth).space,
    visibility = selectVisibility(state, contentWidth),
    windows = [...workspace.windows].sort((a, b) => {
      const ai = activeSpace?.windowIds.indexOf(a.id) ?? -1;
      const bi = activeSpace?.windowIds.indexOf(b.id) ?? -1;
      return (ai < 0 ? 100 : ai) - (bi < 0 ? 100 : bi);
    }),
    pending = workspace.pendingClose;
  const foreground =
    !overlay && !admin && !(pending && !pending.awaiting)
      ? selectVisibility(state, contentWidth).foreground
      : null;
  const fileRequest =
    foreground?.kind === 'file'
      ? state.fileRequests.find((request) => request.id === foreground.id)
      : undefined;
  const openLauncherItem = async (
    item: LauncherItem,
    placement?: WindowPlacement,
    reuseExisting?: boolean,
  ) => {
    const singleton = item.appId === 'settings' && workspace.windows.some((win) => win.appId === 'settings');
    if (workspace.windows.length >= 16 && !singleton && !reuseExisting)
      throw new Error('窗口已满，请先关闭一些窗口');
    const wasFull =
      !placement && !reuseExisting && !singleton && activeSpace && activeSpace.windowIds.length >= 3;
    const commands = launcherActions(workspace, item, placement, reuseExisting);
    for (const command of commands) {
      const receipt = await action(command);
      if (item.kind === 'file' && item.entryId) {
        const authoritative = await waitForWorkspaceRevision(media, receipt.revision ?? workspace.revision);
        const win = [...authoritative.windows]
          .filter((win) => win.appId === 'files')
          .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
        if (win) {
          await call('window.state', {
            windowId: win.id,
            state: {
              ...win.state,
              previewEntryId: item.entryId,
              previewRequestId: receipt.operationId,
            },
          });
          await call('usage.record', {
            item: `file:${item.entryId}`,
            windowId: win.id,
            source: 'launcher',
          });
        }
      }
    }
    if (wasFull) setStageNotice('当前窗口组已满，已在新窗口组打开');
  };
  const dropLauncherItem = async (item: LauncherItem, placement: WindowPlacement) => {
    await openLauncherItem(item, placement);
    setOverlay(undefined);
  };
  const audioControls = workspace && (
    <AudioControls
      channels={workspace.settings.workspace.audioChannels}
      online={productReady}
      playback={media.observations.audio.state}
      resume={() => media.observations.audio.resume()}
      save={saveAudio}
      busy={audioSaving}
      error={audioError}
    />
  );
  return (
    <FileLibraryContext.Provider value={library}>
      <FloatingActionsContext.Provider value={floatingActions}>
        {deadZone > 0 && (
          <div
            className={`viewer-dead-zone${fullscreen ? ' fullscreen' : ''}`}
            style={{ height: deadZone / scale }}
            aria-hidden
          />
        )}
        <WindowDragProvider
          state={state}
          snapshots={snapshots}
          action={action}
          report={report}
          openItem={dropLauncherItem}
        >
          <main
            className={`viewer-shell${fullscreen ? ' remote-page-fullscreen' : ''}${windows.length ? '' : ' no-windows'}${!sideBySide && activeSpace && activeSpace.windowIds.length > 1 && !fullscreen ? ' window-pill-visible' : ''}`}
            ref={shell}
          >
            <DiagnosticCollectionView state={diagnosticState} dismiss={() => diagnostics.dismiss()} />
            <div className="shell-notices" aria-live="polite">
              {stageNotice && <Alert severity="info">{stageNotice}</Alert>}
              {status !== 'online' && (
                <Alert
                  severity="warning"
                  action={
                    status === 'failed' && (
                      <Button color="inherit" size="small" onClick={() => connection.current?.restart()}>
                        重试
                      </Button>
                    )
                  }
                >
                  {status === 'failed' ? '暂时无法连接' : '正在恢复连接…'}
                </Alert>
              )}
              {status === 'online' && !productReady && (
                <Alert
                  severity={snapshot.rtc.phase === 'exhausted' ? 'warning' : 'info'}
                  action={
                    snapshot.rtc.phase === 'exhausted' && (
                      <Button color="inherit" size="small" onClick={() => void media.rtc.connect()}>
                        重试
                      </Button>
                    )
                  }
                >
                  {snapshot.rtc.phase === 'exhausted' ? '浏览器连接失败' : '正在连接浏览器…'}
                </Alert>
              )}
              {(error || operationState.error || viewportNotice || state.endpointError) && (
                <Alert
                  severity="warning"
                  onClose={() => {
                    media.workspace.dismissError();
                    media.viewport.dismissNotice();
                  }}
                >
                  {error ||
                    (operationState.error && formatError(operationState.error)) ||
                    viewportNotice ||
                    (state.quality.resourceLimitation
                      ? '当前画面尺寸超出可用范围，请缩小窗口或关闭部分窗口。'
                      : state.endpointError)}
                </Alert>
              )}
              {pendingOperations.length > 0 && (
                <Alert
                  severity="info"
                  action={
                    pendingOperations.some((entry) => entry.receipt?.status === 'unknown') ? (
                      <Button color="inherit" size="small" onClick={() => media.operations.dismissUnknown()}>
                        以当前工作区为准
                      </Button>
                    ) : undefined
                  }
                >
                  {pendingOperations.length} 个操作
                  {pendingOperations.some((entry) => entry.receipt?.status === 'unknown')
                    ? '结果未知，请核对工作区'
                    : '正在同步'}
                  {snapshot.observations.channel !== '已连接' ? '，等待数据通道连接' : ''}
                </Alert>
              )}
            </div>
            <FloatingDock actions={floatingActions} />
            {!sideBySide && activeSpace && activeSpace.windowIds.length > 1 && !fullscreen && (
              <div className="narrow-window-switcher" aria-label="空间内窗口">
                {activeSpace.windowIds.map((id) => {
                  const win = workspace.windows.find((win) => win.id === id)!;
                  return (
                    <Button
                      key={id}
                      size="small"
                      variant={id === activeSpace.focusedWindowId ? 'contained' : 'text'}
                      disabled={!productReady}
                      onClick={() => void action({ type: 'window.focus', windowId: id }).catch(report)}
                    >
                      {appName(workspace, win)}
                    </Button>
                  );
                })}
              </div>
            )}
            <div
              className={`window-workspace ${sideBySide ? 'side-by-side' : ''}${overlay ? ' space-obscured' : ''}`}
            >
              {windows.map((w) => {
                const position = activeSpace?.windowIds.indexOf(w.id) ?? -1;
                return (
                  <React.Fragment key={w.id}>
                    {sideBySide && activeSpace && position > 0 && (
                      <WindowDivider
                        space={activeSpace}
                        index={position - 1}
                        online={productReady}
                        action={action}
                        report={report}
                      />
                    )}
                    <WindowFrame
                      win={w}
                      state={state}
                      transport={media}
                      action={action}
                      online={productReady}
                      call={call}
                      weight={sideBySide && position >= 0 ? activeSpace!.weights[position] : 1}
                      settingsContent={(viewState, onState) => (
                        <SettingsApp
                          state={state}
                          viewState={viewState}
                          onState={onState}
                          action={action}
                          call={call}
                          online={productReady}
                          logout={logout}
                          admin={() => setAdmin(true)}
                          security={
                            <SecuritySettings
                              auth={auth}
                              online={status === 'online'}
                              request={authRequest}
                              camera={camera}
                              idle={idle}
                              lock={() => lock('manual')}
                            />
                          }
                          sessionImport={
                            <SessionImportSettings
                              online={productReady}
                              call={sessionImportCall}
                              action={action}
                              windowId={
                                workspace.windows
                                  .filter((win) => win.appId === 'browser')
                                  .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id ?? null
                              }
                              opened={() => {}}
                            />
                          }
                          diagnostics={
                            <DiagnosticSettings
                              state={diagnosticState}
                              online={status === 'online'}
                              start={() => {
                                void diagnostics.start(diagnosticEnvironment());
                              }}
                            />
                          }
                        />
                      )}
                      fileChooser={
                        fileRequest?.windowId === w.id ? (
                          <FileChooserDialog
                            key={fileRequest.id}
                            request={fileRequest}
                            transport={media}
                            viewId={workspace.tabs.find((tab) => tab.id === fileRequest.tabId)?.webviewId}
                          />
                        ) : undefined
                      }
                      report={report}
                      onGeometry={onGeometry}
                      visible={visibility.visibleWindowIds.includes(w.id)}
                      fullscreen={fullscreen?.windowId === w.id}
                    />
                  </React.Fragment>
                );
              })}
              {windows.length === 0 && (
                <div className="workspace-empty">
                  <div className="workspace-empty-body">
                    <WebAssetOutlined className="workspace-empty-icon" />
                    <Typography component="h1" variant="h6">
                      没有打开的窗口
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      从开始屏幕打开 App
                    </Typography>
                    <Button
                      variant="contained"
                      startIcon={<Add />}
                      disabled={!productReady}
                      onClick={() => setOverlay({ kind: 'launcher' })}
                    >
                      打开开始屏幕
                    </Button>
                    <div className="workspace-empty-links">
                      {state.user.isAdmin && (
                        <Button
                          size="small"
                          color="inherit"
                          startIcon={<AdminPanelSettingsOutlined />}
                          disabled={status !== 'online'}
                          onClick={() => setAdmin(true)}
                        >
                          管理员面板
                        </Button>
                      )}
                      <Button size="small" color="inherit" startIcon={<Logout />} onClick={logout}>
                        退出登录
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
            {productReady && (
              <PageDialogs
                state={state}
                action={action}
                activeId={foreground?.kind === 'page' ? foreground.id : null}
              />
            )}
            {state.user.isAdmin && (
              <AdminConsole
                open={admin}
                online={status === 'online'}
                self={state.user.username}
                call={adminCall}
                onClose={() => setAdmin(false)}
              />
            )}
            <HomeBar
              launcher={() => {
                if (shell.current && activeSpace) snapshots.capture(shell.current, activeSpace.windowIds);
                setOverlay({ kind: 'launcher' });
              }}
              previous={() => {
                const previous = [...workspace.spaces]
                  .filter((space) => space.id !== workspace.activeSpaceId)
                  .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
                if (previous) void action({ type: 'space.activate', spaceId: previous.id }).catch(report);
              }}
            />
            {visibleLauncher?.kind === 'launcher' && (
              <Launcher
                state={state}
                audio={audioControls}
                lock={() => lock('manual')}
                snapshots={snapshots}
                action={action}
                report={report}
                call={call}
                exiting={overlay?.kind !== 'launcher'}
                online={productReady}
                close={() => setOverlay(undefined)}
                navigate={async (value, placement) => {
                  await action(launcherNavigation(value, placement ?? launcherPlacement(workspace)));
                  if (!placement && activeSpace && activeSpace.windowIds.length >= 3)
                    setStageNotice('当前窗口组已满，已在新窗口组打开');
                }}
                activate={openLauncherItem}
              />
            )}
            <Dialog
              open={productReady && !!pending && !pending.awaiting}
              onClose={() =>
                productReady &&
                pending &&
                void action({
                  type: 'tab.close',
                  tabId: pending.id,
                  requestId: pending.requestId,
                  cancel: true,
                }).catch(report)
              }
            >
              <DialogTitle>离开此页面？</DialogTitle>
              <DialogContent>此页面可能有未保存的内容。</DialogContent>
              <DialogActions>
                <Button
                  autoFocus
                  onClick={() =>
                    pending &&
                    void action({
                      type: 'tab.close',
                      tabId: pending.id,
                      requestId: pending.requestId,
                      cancel: true,
                    }).catch(report)
                  }
                >
                  保留页面
                </Button>
                <Button
                  onClick={() =>
                    pending &&
                    void action({
                      type: 'tab.close',
                      tabId: pending.id,
                      requestId: pending.requestId,
                      confirm: true,
                    }).catch(report)
                  }
                >
                  离开
                </Button>
              </DialogActions>
            </Dialog>
          </main>
        </WindowDragProvider>
      </FloatingActionsContext.Provider>
    </FileLibraryContext.Provider>
  );
}
