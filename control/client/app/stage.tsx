import './stage.css';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Add, AdminPanelSettingsOutlined, Logout, WebAssetOutlined } from '@mui/icons-material';
import { Alert, Button, Typography } from '@mui/material';
import type { ProductState } from '../../shared/product';
import type { ViewerSession } from '../viewer-session';
import type { WorkspaceSnapshot } from '../control/workspace-session';
import type { OperationsSnapshot } from '../control/operations-store';
import type { useViewerSession } from './use-viewer-session';
import { formatError } from '../util/format-error';
import { FileChooserDialog } from '../files/file-chooser-dialog';
import { DiagnosticCollectionView } from './diagnostic-collection-view';
import { FloatingDock } from './floating-dock';
import type { FloatingActions } from './floating-actions';
import { deadZoneHeight, useTopInsetProbe } from './top-inset';
import { setUiScale } from './ui-scale';
import { selectVisibility } from './visibility';
import { useWindowFullscreen } from './window-fullscreen';
import { WindowFrame } from './window-frame';
import { WindowDivider } from './window-divider';
import { appName } from './app-icon';
import { SpaceSnapshots } from './space-snapshots';
import { usePagePreviews } from './page-previews';
import type { Action } from './product-dialogs';
import type { WorkspaceCall } from './window-state';
import type { SystemControls } from './system-controls';
import { useDropTarget, useWindowDragging } from './window-drag';
export function useWorkspaceStage(media: ViewerSession, state: ProductState | null, showShell: boolean) {
  const [snapshots] = useState(() => new SpaceSnapshots());
  const [stageNotice, setStageNotice] = useState('');
  useEffect(() => {
    if (!stageNotice) return;
    const timer = setTimeout(() => setStageNotice(''), 3500);
    return () => clearTimeout(timer);
  }, [stageNotice]);
  const [width, setWidth] = useState(0);
  const shell = useRef<HTMLElement>(null);
  const previousSpace = useRef<{ id: string | null; windowIds: string[] } | undefined>(undefined);
  const contentWidth = width;
  const windowFullscreen = useWindowFullscreen();
  const fullscreen = !!state?.pageFullscreen || !!windowFullscreen;
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
        Math.max(1, height),
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
  }, [showShell, media, scale, deadZone, fullscreen]);
  const call: WorkspaceCall = useCallback((method, params) => media.control.request(method, params), [media]);
  const capturePreviews = usePagePreviews(
    state,
    shell,
    state && showShell ? selectVisibility(state, contentWidth, windowFullscreen).visibleWindowIds : [],
    call,
  );
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
  useLayoutEffect(() => {
    const workspace = state?.workspace;
    if (previousSpace.current && previousSpace.current.id !== workspace?.activeSpaceId && shell.current)
      snapshots.capture(shell.current, previousSpace.current.windowIds);
    const space = workspace?.spaces.find((space) => space.id === workspace.activeSpaceId);
    previousSpace.current = { id: workspace?.activeSpaceId ?? null, windowIds: space?.windowIds ?? [] };
    snapshots.retain(state?.workspace.windows.map((win) => win.id) ?? []);
  }, [state?.workspace.activeSpaceId, state?.workspace.windows, snapshots]);
  return { shell, snapshots, width, scale, deadZone, action, call, stageNotice, notify: setStageNotice };
}
export type WorkspaceStage = ReturnType<typeof useWorkspaceStage>;
export function Stage({
  state,
  media,
  stage,
  controls,
  floatingActions,
  workspaceState,
  operationState,
  snapshot,
  viewportNotice,
  obscured,
  foreground,
  appContent,
  openLauncher,
  logout,
  children,
}: {
  state: ProductState;
  media: ViewerSession;
  stage: WorkspaceStage;
  controls: Pick<
    SystemControls,
    'fullscreen' | 'windowFullscreen' | 'productReady' | 'diagnosticState' | 'diagnostics'
  >;
  floatingActions: FloatingActions;
  workspaceState: WorkspaceSnapshot;
  operationState: OperationsSnapshot;
  snapshot: ReturnType<typeof useViewerSession>;
  viewportNotice: string;
  obscured: boolean;
  foreground: ReturnType<typeof selectVisibility>['foreground'];
  appContent: React.ComponentProps<typeof WindowFrame>['appContent'];
  openLauncher(): void;
  logout(): void;
  children: React.ReactNode;
}) {
  const { shell, width: contentWidth, stageNotice, call, action } = stage;
  const { fullscreen, productReady, diagnosticState, diagnostics } = controls;
  const { status, error } = workspaceState;
  const report = media.workspace.report;
  const onGeometry = media.viewport.setGeometry;
  const workspace = state.workspace;
  const visibility = selectVisibility(state, contentWidth, controls.windowFullscreen);
  const { sideBySide, space: activeSpace } = visibility;
  const windows = [...workspace.windows].sort((a, b) => {
    const ai = activeSpace?.windowIds.indexOf(a.id) ?? -1;
    const bi = activeSpace?.windowIds.indexOf(b.id) ?? -1;
    return (ai < 0 ? 100 : ai) - (bi < 0 ? 100 : bi);
  });
  const fileRequest =
    foreground?.kind === 'file'
      ? state.fileRequests.find((request) => request.id === foreground.id)
      : undefined;
  const shellDrop = useDropTarget('shell', undefined);
  const stageDrop = useDropTarget('stage', undefined);
  const dragging = useWindowDragging();
  const shellRef = useCallback(
    (element: HTMLElement | null) => {
      shell.current = element;
      shellDrop.ref(element);
    },
    [shell, shellDrop.ref],
  );
  return (
    <main
      className={`${dragging ? 'window-dragging ' : ''}viewer-shell${fullscreen ? ' remote-page-fullscreen' : ''}${windows.length ? '' : ' no-windows'}${!sideBySide && activeSpace && activeSpace.windowIds.length > 1 && !fullscreen ? ' window-pill-visible' : ''}`}
      ref={shellRef}
    >
      <DiagnosticCollectionView state={diagnosticState} dismiss={() => diagnostics.dismiss()} />
      <div className="shell-notices" aria-live="polite">
        {stageNotice && <Alert severity="info">{stageNotice}</Alert>}
        {status !== 'online' && (
          <Alert
            severity="warning"
            action={
              status === 'failed' && (
                <Button color="inherit" size="small" onClick={() => media.control.restart()}>
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
        ref={stageDrop.ref}
        className={`window-workspace ${sideBySide ? 'side-by-side' : ''}${obscured ? ' space-obscured' : ''}`}
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
                appContent={appContent}
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
                onClick={() => openLauncher()}
              >
                打开开始屏幕
              </Button>
              <div className="workspace-empty-links">
                {state.user.isAdmin && (
                  <Button
                    size="small"
                    color="inherit"
                    startIcon={<AdminPanelSettingsOutlined />}
                    disabled={!productReady}
                    onClick={() =>
                      void action({
                        type: 'window.open',
                        appId: 'admin',
                        placement: { mode: 'space' },
                      }).catch(report)
                    }
                  >
                    管理
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
      {children}
    </main>
  );
}
