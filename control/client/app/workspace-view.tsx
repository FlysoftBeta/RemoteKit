import { formatError } from '../util/format-error';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { AdminDialog } from './admin-dialog';
import { useAuthCamera, type AuthRequest } from '../auth/auth-camera';
import { useAutoLock } from '../auth/auth-idle';
import {
  DiagnosticCollection,
  diagnosticEnvironment,
  type DiagnosticState,
} from '../media/diagnostic-collection';
import { DiagnosticCollectionView, DiagnosticSettings } from './diagnostic-collection-view';
import { FileChooserDialog } from '../files/file-chooser-dialog';
import { FileLibraryContext, useFileLibrary, type LibraryRequest } from '../files/file-library-state';
import { BlankScreen, RevealScreen } from '../auth/lock-screen';
import type { AudioChannels } from '../media/audio-output';
import { PageDialogs, SettingsDialog, type Action } from './product-dialogs';
import { SecuritySettings } from '../auth/security-settings';
import { UnlockView } from '../auth/unlock-view';
import { useAutoFullscreen } from './use-auto-fullscreen';
import { useViewerSession } from './use-viewer-session';
import { ViewerSession } from '../viewer-session';
import { selectVisibility } from './visibility';
import { WindowDivider, WindowFrame } from './window-frame';

export function WorkspaceView({ logout, expired }: { logout: () => void; expired: () => void }) {
  const [media] = useState(() => new ViewerSession());
  const snapshot = useViewerSession(media);
  const workspaceState = useSyncExternalStore(media.workspace.subscribe, media.workspace.getSnapshot);
  const { auth, localLock, manualLock, status, error, idleRearmed } = workspaceState;
  const operationState = useSyncExternalStore(media.operations.subscribe, media.operations.getSnapshot);
  const { state, pending: pendingOperations } = operationState;
  const viewportNotice = useSyncExternalStore(media.viewport.subscribe, media.viewport.getSnapshot);
  const [settings, setSettings] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [audioSaving, setAudioSaving] = useState(false);
  const [audioError, setAudioError] = useState('');
  const [focusAddress, setFocusAddress] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const shell = useRef<HTMLElement>(null);
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
  useAutoFullscreen(showShell && state.workspace.settings.autoFullscreen === true);
  useLayoutEffect(() => {
    const node = shell.current;
    if (!showShell || !node) return;
    const visual = window.visualViewport;
    const position = () => {
      node.style.left = `${visual?.offsetLeft ?? 0}px`;
      node.style.top = `${visual?.offsetTop ?? 0}px`;
    };
    const measure = () => {
      node.style.width = `${visual?.width ?? document.documentElement.clientWidth}px`;
      node.style.height = `${visual?.height ?? document.documentElement.clientHeight}px`;
      const bounds = node.getBoundingClientRect();
      setWidth(bounds.width);
      media.viewport.measure(
        bounds.width,
        bounds.height,
        window.devicePixelRatio || 1,
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
  }, [showShell, media]);
  const onGeometry = media.viewport.setGeometry;
  const action: Action = media.operations.action;
  const report = media.workspace.report;
  const saveAudio = (channels: AudioChannels) => {
    if (audioPending.current || status !== 'online' || !snapshot.authorization.ready) return;
    audioPending.current = true;
    setAudioSaving(true);
    setAudioError('');
    void action({ type: 'settings.update', settings: { audioChannels: channels } })
      .catch(() => {
        setAudioError('声音设置未保存，请重试');
      })
      .finally(() => {
        audioPending.current = false;
        setAudioSaving(false);
      });
  };
  const loadRegistration = useCallback(() => connection.current!.request('admin.get', {}), []);
  const saveRegistration = useCallback(
    (serverCredential: string) =>
      connection.current!.request('admin.setRegistrationCredential', { serverCredential }),
    [],
  );
  const loadNodes = useCallback(() => connection.current!.request('admin.nodes', {}), []);
  const changeNode = useCallback(
    (nodeId: string, action: 'remove' | 'readd') =>
      connection.current!.request(action === 'remove' ? 'admin.removeNode' : 'admin.readdNode', { nodeId }),
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
    sideBySide = selectVisibility(state, width).sideBySide,
    windows = workspace.windows,
    pending = workspace.pendingClose;
  const foreground =
    !settings && !admin && !(pending && !pending.awaiting) ? selectVisibility(state, width).foreground : null;
  const fileRequest =
    foreground?.kind === 'file'
      ? state.fileRequests.find((request) => request.id === foreground.id)
      : undefined;
  return (
    <FileLibraryContext.Provider value={library}>
      <main className={`viewer-shell${fullscreen ? ' remote-page-fullscreen' : ''}`} ref={shell}>
        <DiagnosticCollectionView
          state={diagnosticState}
          online={status === 'online'}
          stop={() => diagnostics.stop()}
          dismiss={() => diagnostics.dismiss()}
        />
        {pendingOperations.length > 0 && (
          <Alert
            severity="info"
            sx={{ position: 'absolute', top: 88, left: '50%', transform: 'translateX(-50%)', zIndex: 1190 }}
            action={
              pendingOperations.some((entry) => entry.receipt?.status === 'unknown') ? (
                <Button onClick={() => media.operations.dismissUnknown()}>以当前工作区为准</Button>
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
        {productReady &&
          media.observations.audio.state === 'blocked' &&
          (workspace.settings.audioChannels?.left !== false ||
            workspace.settings.audioChannels?.right !== false) && (
            <Button
              variant="contained"
              onClick={() => media.observations.audio.resume()}
              sx={{ position: 'absolute', top: 96, left: '50%', transform: 'translateX(-50%)', zIndex: 1200 }}
            >
              点击开启声音
            </Button>
          )}
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
            sx={
              !error && (viewportNotice || state.quality.resourceLimitation)
                ? { position: 'absolute', top: 8, left: 12, right: 12, zIndex: 1400 }
                : undefined
            }
          >
            {error ||
              (operationState.error && formatError(operationState.error)) ||
              viewportNotice ||
              (state.quality.resourceLimitation
                ? '当前画面尺寸超出可用范围，请缩小窗口或关闭部分窗口。'
                : state.endpointError)}
          </Alert>
        )}
        <div className={`window-workspace ${sideBySide ? 'side-by-side' : ''}`}>
          {windows.map((w, index) => (
            <React.Fragment key={w.id}>
              {sideBySide && index > 0 && (
                <WindowDivider
                  before={windows[index - 1]}
                  after={w}
                  windows={workspace.windows}
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
                onSettings={() => setSettings(true)}
                onAdmin={() => setAdmin(true)}
                onLogout={logout}
                report={report}
                onGeometry={onGeometry}
                focusAddress={focusAddress}
                visible={
                  fullscreen ? w.id === fullscreen.windowId : sideBySide || w.id === workspace.activeWindowId
                }
                fullscreen={fullscreen?.windowId === w.id}
                audioSaving={audioSaving}
                audioError={audioError}
                saveAudio={saveAudio}
              />
            </React.Fragment>
          ))}
          {fullscreen && (
            <Button
              className="remote-fullscreen-exit"
              variant="contained"
              size="small"
              disabled={!productReady || exitingFullscreen}
              onClick={() => exitFullscreen.current()}
            >
              退出网页全屏
            </Button>
          )}
          {windows.length === 0 && (
            <div className="workspace-empty">
              <Typography variant="h6">开始浏览</Typography>
              <Button
                variant="contained"
                disabled={!productReady}
                onClick={() => void action({ type: 'window.create' }).catch(report)}
              >
                新建窗口
              </Button>
              <Button color="inherit" onClick={logout}>
                退出登录
              </Button>
              {state.user.isAdmin && (
                <Button disabled={status !== 'online'} onClick={() => setAdmin(true)}>
                  管理员面板
                </Button>
              )}
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
        {fileRequest && (
          <FileChooserDialog
            key={fileRequest.id}
            request={fileRequest}
            transport={media}
            viewId={workspace.tabs.find((tab) => tab.id === fileRequest.tabId)?.webviewId}
          />
        )}
        {state.user.isAdmin && (
          <AdminDialog
            loadNodes={loadNodes}
            changeNode={changeNode}
            open={admin}
            online={status === 'online'}
            onClose={() => setAdmin(false)}
            load={loadRegistration}
            save={saveRegistration}
          />
        )}
        <SettingsDialog
          online={productReady}
          state={state}
          open={settings}
          onClose={() => setSettings(false)}
          action={action}
          logout={logout}
          diagnostics={
            settings && (
              <DiagnosticSettings
                state={diagnosticState}
                online={status === 'online'}
                start={() => {
                  void diagnostics.start(diagnosticEnvironment()).then((started) => {
                    if (started) setSettings(false);
                  });
                }}
              />
            )
          }
          security={
            settings && (
              <SecuritySettings
                auth={auth}
                online={status === 'online'}
                request={authRequest}
                camera={camera}
                idle={idle}
                lock={() => lock('manual')}
              />
            )
          }
        />
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
    </FileLibraryContext.Provider>
  );
}
