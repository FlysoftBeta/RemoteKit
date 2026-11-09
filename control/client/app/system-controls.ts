import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ViewerSession } from '../viewer-session';
import type { WorkspaceSnapshot } from '../control/workspace-session';
import type { OperationsSnapshot } from '../control/operations-store';
import type { useViewerSession } from './use-viewer-session';
import { useAuthCamera, type AuthRequest } from '../auth/auth-camera';
import { useAutoLock } from '../auth/auth-idle';
import type { AudioChannels } from '../media/audio-output';
import { DiagnosticCollection, type DiagnosticState } from '../media/diagnostic-collection';
import { useFloatingAction, type FloatingActions } from './floating-actions';
import type { Action } from './product-dialogs';
import { toggleFullscreen, useAutoFullscreen } from './use-auto-fullscreen';
import { fullscreenWindowId } from './visibility';
import { exitWindowFullscreen, useWindowFullscreen } from './window-fullscreen';
const FULLSCREEN_EXIT_ANCHORS = ['top-left', 'top', 'top-right'] as const;
export function useSystemControls({
  media,
  workspaceState,
  operationState,
  snapshot,
  action,
  showShell,
  floatingActions,
}: {
  media: ViewerSession;
  workspaceState: WorkspaceSnapshot;
  operationState: OperationsSnapshot;
  snapshot: ReturnType<typeof useViewerSession>;
  action: Action;
  showShell: boolean;
  floatingActions: FloatingActions;
}) {
  const { auth, localLock, manualLock, status, idleRearmed } = workspaceState;
  const { state, pending: pendingOperations } = operationState;
  const [browserFullscreen, setBrowserFullscreen] = useState(!!document.fullscreenElement);
  useEffect(() => {
    const change = () => setBrowserFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', change);
    return () => document.removeEventListener('fullscreenchange', change);
  }, []);
  const [audioSaving, setAudioSaving] = useState(false);
  const [audioError, setAudioError] = useState('');
  const audioPending = useRef(false);
  const report = media.workspace.report;
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
  useAutoFullscreen(showShell && state?.workspace.settings.workspace.autoFullscreen === true);
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
  const productReady = status === 'online' && snapshot.authorization.ready;
  const pageFullscreen = state?.pageFullscreen;
  const fullscreenTarget = pageFullscreen?.target;
  const chosenFullscreen = useWindowFullscreen();
  const activeWindowIds = state?.workspace.spaces.find(
    (space) => space.id === state.workspace.activeSpaceId,
  )?.windowIds;
  // A window shown fullscreen by choice ends when it leaves the stage (closed, moved, other space).
  const chosenOnStage = !!chosenFullscreen && !!activeWindowIds?.includes(chosenFullscreen);
  useEffect(() => {
    if (chosenFullscreen && state && !chosenOnStage) exitWindowFullscreen();
  }, [chosenFullscreen, chosenOnStage, state]);
  const windowFullscreen = chosenOnStage ? chosenFullscreen : null;
  const fullscreenWindow = state ? fullscreenWindowId(state, windowFullscreen) : undefined;
  const fullscreen = fullscreenWindow ? { windowId: fullscreenWindow } : undefined;
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
      : windowFullscreen
        ? {
            order: 0,
            anchor: 'top-right',
            anchors: FULLSCREEN_EXIT_ANCHORS,
            label: '退出全屏',
            icon: 'fullscreen-exit',
            run: exitWindowFullscreen,
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
  return {
    authRequest,
    lock: () => lock('manual'),
    idle,
    camera,
    diagnostics,
    diagnosticState,
    productReady,
    fullscreen,
    windowFullscreen,
    browserFullscreen: {
      active: browserFullscreen,
      toggle: () => void toggleFullscreen().catch(report),
    },
    audio: state
      ? {
          channels: state.workspace.settings.workspace.audioChannels,
          online: productReady,
          playback: media.observations.audio.state,
          resume: () => media.observations.audio.resume(),
          save: saveAudio,
          busy: audioSaving,
          error: audioError,
        }
      : null,
    sync: {
      pending: pendingOperations.length,
      unknown: pendingOperations.some((entry) => entry.receipt?.status === 'unknown'),
      channelReady: snapshot.observations.channel === '已连接',
      dismissUnknown: () => media.operations.dismissUnknown(),
    },
  };
}
export type SystemControls = ReturnType<typeof useSystemControls>;
