import { Add, AdminPanelSettingsOutlined, Logout, WebAssetOutlined } from '@mui/icons-material';
import { Button, Typography } from '@mui/material';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { RemoteKitError } from '../../shared/errors';
import type { ProductState } from '../../shared/product';
import type { OperationsSnapshot } from '../control/operations-store';
import type { WorkspaceSnapshot } from '../control/workspace-session';
import { KeyboardViewport } from '../editing/keyboard-viewport';
import { ShellKeyboard } from '../editing/shell-keyboard';
import { NoticeCenter, SurfaceState, failureError, notices, presentFailure } from '../failures';
import { FileChooserDialog } from '../files/file-chooser-dialog';
import type { ViewerSession } from '../viewer-session';
import { appName } from './app-icon';
import { DiagnosticCollectionView } from './diagnostic-collection-view';
import type { FloatingActions } from './floating-actions';
import { FloatingDock } from './floating-dock';
import { usePagePreviews } from './page-previews';
import type { Action } from './product-dialogs';
import { SpaceSnapshots } from './space-snapshots';
import './stage.css';
import type { SystemControls } from './system-controls';
import { deadZoneHeight, useTopInsetProbe } from './top-inset';
import { setUiScale } from './ui-scale';
import { useViewerSessionSelector } from './use-viewer-session';
import { selectVisibility } from './visibility';
import { WindowDivider } from './window-divider';
import { useDropTarget, useWindowDragging } from './window-drag';
import { WindowFrame } from './window-frame';
import { useWindowFullscreen } from './window-fullscreen';
import type { WorkspaceCall } from './window-state';
export function useWorkspaceStage(media: ViewerSession, state: ProductState | null, showShell: boolean) {
  const [snapshots] = useState(() => new SpaceSnapshots());
  const [width, setWidth] = useState(0);
  const shell = useRef<HTMLElement>(null);
  const keyboardViewport = useRef(new KeyboardViewport());
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
    let transitioning = true;
    let transitionFrame = 0;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const active = document.activeElement;
      const focused =
        active instanceof HTMLTextAreaElement &&
        active.classList.contains('remote-input') &&
        active.inputMode !== 'none';
      const keyboard = keyboardViewport.current;
      const now = performance.now();
      keyboard.measure(
        {
          visual: visual
            ? {
                width: visual.width,
                height: visual.height,
                offsetLeft: visual.offsetLeft,
                offsetTop: visual.offsetTop,
              }
            : undefined,
          scale: visual?.scale ?? 1,
          layoutWidth: window.innerWidth,
          layoutHeight: window.innerHeight,
          screen: { width: window.screen.width, height: window.screen.height },
        },
        focused,
        window.matchMedia('(pointer: coarse)').matches,
        now,
      );
      keyboard.settle(now);
      const editing = media.editing.mobileEditing;
      const focusedView = focused
        ? active.closest<HTMLElement>('.remote-viewport')?.dataset.viewId
        : undefined;
      const owner = focusedView ?? editing.views.find((view) => editing.forKeyboard(view))?.id ?? '';
      media.viewport.setOcclusion(owner, transitioning ? 0 : keyboard.occludedBottom / scale);
      clearTimeout(settleTimer);
      if (keyboard.deadline !== undefined)
        settleTimer = setTimeout(measure, Math.max(1, keyboard.deadline - now));
      const width = (visual?.width ?? document.documentElement.clientWidth) / scale;
      const height =
        Math.max(
          1,
          (keyboard.open
            ? keyboard.stableHeight
            : (visual?.height ?? document.documentElement.clientHeight)) - deadZone,
        ) / scale;
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
    transitionFrame = requestAnimationFrame(() => {
      transitionFrame = requestAnimationFrame(() => {
        transitioning = false;
        measure();
      });
    });
    const unsubscribeEditing = media.editing.subscribe(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    visual?.addEventListener('resize', measure);
    visual?.addEventListener('scroll', position);
    window.addEventListener('resize', measure);
    document.addEventListener('visibilitychange', measure);
    measure();
    return () => {
      observer.disconnect();
      unsubscribeEditing();
      cancelAnimationFrame(transitionFrame);
      clearTimeout(settleTimer);
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
  return { shell, snapshots, width, scale, deadZone, action, call };
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
  viewportNotice,
  interactionFailure,
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
  viewportNotice: RemoteKitError | undefined;
  interactionFailure?: RemoteKitError;
  obscured: boolean;
  foreground: ReturnType<typeof selectVisibility>['foreground'];
  appContent: React.ComponentProps<typeof WindowFrame>['appContent'];
  openLauncher(): void;
  logout(): void;
  children: React.ReactNode;
}) {
  const rtcPhase = useViewerSessionSelector(media, (snapshot) => snapshot.rtc.phase);
  useLayoutEffect(() => {
    const keyboard = new ShellKeyboard(document, floatingActions);
    return () => keyboard.dispose();
  }, [floatingActions]);
  const { shell, width: contentWidth, call, action } = stage;
  const { fullscreen, productReady, diagnosticState, diagnostics } = controls;
  const { status } = workspaceState;
  const [surfaceFailure, setSurfaceFailure] = useState<RemoteKitError>();
  const report = useCallback((error: unknown) => setSurfaceFailure(failureError(error)), []);
  useEffect(() => {
    if (status === 'online') notices.resolve('control:connection');
    else
      notices.post(
        'control:connection',
        presentFailure(media.control.error ?? new RemoteKitError('unavailable', ''), {
          operation: '恢复工作区连接',
          scope: 'global',
          connection: true,
          issue: status === 'revoked' ? 'lease' : undefined,
        }),
      );
    return () => notices.resolve('control:connection');
  }, [status, media]);
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
      <NoticeCenter />

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

                onGeometry={onGeometry}
                visible={visibility.visibleWindowIds.includes(w.id)}
                fullscreen={fullscreen?.windowId === w.id}
                surfaceFailure={
                  w.id === activeSpace?.focusedWindowId && (interactionFailure ?? surfaceFailure)
                    ? {
                        error: (interactionFailure ?? surfaceFailure)!,
                        operation: interactionFailure ? '保存拖动结果' : '更新窗口布局',
                      }
                    : undefined
                }
              />
            </React.Fragment>
          );
        })}
        {windows.length === 0 && (
          <div className="workspace-empty">
            <SurfaceState
              error={interactionFailure ?? surfaceFailure}
              context={{ operation: interactionFailure ? '保存拖动结果' : '更新窗口布局', scope: 'surface' }}
            />
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
