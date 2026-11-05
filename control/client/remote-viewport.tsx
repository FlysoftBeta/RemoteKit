import { KeyboardHideOutlined, KeyboardOutlined } from '@mui/icons-material';
import { Button } from '@mui/material';
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { formatError } from './format-error';
import { ViewportInput } from './input/viewport-input';
import { StatsOverlay } from './stats-overlay';
import { useViewerSession } from './use-viewer-session';
import { useViewportTransition } from './use-viewport-transition';
import type { ViewerSession } from './viewer-session';

export function RemoteViewport({
  transport,
  viewId,
  overlay = false,
  keyboardActive = true,
  manualKeyboard = false,
  onFocus,
}: {
  transport: ViewerSession;
  viewId: string;
  overlay?: boolean;
  keyboardActive?: boolean;
  manualKeyboard?: boolean;
  onFocus?: () => void;
}) {
  const snapshot = useViewerSession(transport);
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<HTMLElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const focused = useRef(onFocus);
  focused.current = onFocus;
  const [controller, setController] = useState<ViewportInput>();
  const [frameReady, setFrameReady] = useState(false);
  const surface = snapshot.presentation.layout?.views.find((view) => view.id === viewId);
  const editingSurface = snapshot.editing.views.find((view) => view.id === viewId);
  const owner =
    editingSurface &&
    `${snapshot.editing.attempt}:${editingSurface.session}:${editingSurface.id}:${editingSurface.instance}:${editingSurface.document}`;
  const resize = useViewportTransition(viewport, transport, viewId, surface, frameReady, owner, editor);
  useLayoutEffect(() => {
    if (!canvas.current || !editor.current) return;
    const value = new ViewportInput(transport, viewId, canvas.current, editor.current, () =>
      focused.current?.(),
    );
    setController(value);
    const remove = transport.presentation.registerViewport(viewId, canvas.current, setFrameReady);
    return () => {
      value.dispose();
      remove();
    };
  }, [transport, viewId]);
  useLayoutEffect(
    () => controller?.configure(keyboardActive, manualKeyboard, resize),
    [
      controller,
      keyboardActive,
      manualKeyboard,
      resize.waiting,
      resize.keyboardOpen,
      resize.keyboardDismissals,
      frameReady,
    ],
  );
  const editing = useSyncExternalStore(
    controller?.editing.subscribe ?? emptySubscribe,
    controller?.editing.getSnapshot ?? emptyEditing,
  );
  const touch = useSyncExternalStore(
    controller?.touch.subscribe ?? emptySubscribe,
    controller?.touch.getSnapshot ?? emptyTouch,
  );
  const touchNotice = 'notice' in touch ? touch.notice : undefined;
  return (
    <section
      ref={viewport}
      style={resize.style}
      className={`remote-viewport${resize.waiting ? ' resize-waiting' : ''}`}
      aria-label="远程页面"
    >
      <canvas
        ref={canvas}
        aria-label="远程页面画面"
        className={frameReady && !resize.waiting ? '' : 'no-frame'}
      />
      <textarea
        ref={editor}
        className="remote-input"
        aria-label="远程页面键盘输入"
        inputMode="none"
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
      />
      {editing.keyboardEnabled && (editing.observedOwner || editing.keyboardShown) && (
        <Button
          size="small"
          className="remote-open-keyboard"
          startIcon={editing.keyboardShown ? <KeyboardHideOutlined /> : <KeyboardOutlined />}
          disabled={!editing.keyboardShown && !editing.keyboardReady}
          onPointerDown={(event) => event.preventDefault()}
          onClick={controller?.editing.toggleKeyboard}
        >
          {editing.keyboardShown ? '隐藏键盘' : '显示键盘'}
        </Button>
      )}
      {editing.error && (
        <div role="status" className="input-notice">
          {editing.error}
        </div>
      )}
      {touchNotice && (
        <div role="status" className="input-notice">
          {touchNotice === 'cleanup'
            ? '触控结束暂未送达。'
            : touchNotice === 'confirming'
              ? '正在确认触控…'
              : '触控结束尚未确认。'}
          {touchNotice === 'unconfirmed' && (
            <Button
              size="small"
              onPointerDown={(event) => event.preventDefault()}
              onClick={controller?.touch.retryProof}
            >
              重试确认
            </Button>
          )}
          {touchNotice !== 'confirming' && (
            <Button
              size="small"
              onPointerDown={(event) => event.preventDefault()}
              onClick={controller?.touch.retryEnd}
            >
              重试结束
            </Button>
          )}
        </div>
      )}
      {snapshot.presentation.error ? (
        <div className="page-overlay" role="alert">
          {formatError(snapshot.presentation.error)}
          {snapshot.presentation.canRetry && (
            <Button sx={{ pointerEvents: 'auto' }} onClick={() => transport.presentation.retryPresentation()}>
              重试视频
            </Button>
          )}
        </div>
      ) : (
        (snapshot.rtc.phase === 'exhausted' || (snapshot.rtc.phase !== 'connected' && !resize.frozen)) && (
          <div className="page-overlay" role="status">
            {snapshot.rtc.phase === 'exhausted' ? '画面连接中断' : '正在连接浏览器…'}
            {snapshot.rtc.phase === 'exhausted' && (
              <Button onClick={() => void transport.rtc.connect()}>重新连接</Button>
            )}
          </div>
        )
      )}
      {overlay && <StatsOverlay diagnostics={snapshot.observations} surface={surface} />}
    </section>
  );
}
const emptySubscribe = () => () => {};
const initialEditing = { keyboardEnabled: false, keyboardShown: false, keyboardReady: false };
const emptyEditing = (): import('./editing/editing-view').EditingViewSnapshot => initialEditing;
const initialTouch = { phase: 'idle' as const };
const emptyTouch = (): import('./input/touch-view').TouchOwnerState => initialTouch;
