import { Button } from '@mui/material';
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { formatError } from '../util/format-error';
import { useFloatingAction } from './floating-actions';
import { PageOverlay } from './page-overlay';
import { ViewportInput } from '../input/viewport-input';
import { StatsOverlay } from './stats-overlay';
import { useViewerSession } from './use-viewer-session';
import { useViewportTransition } from '../presentation/use-viewport-transition';
import type { ViewerSession } from '../viewer-session';

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
  useFloatingAction(
    `keyboard:${viewId}`,
    controller &&
      keyboardActive &&
      editing.keyboardEnabled &&
      (editing.observedOwner || editing.keyboardShown)
      ? {
          order: 10,
          anchor: 'bottom-right',
          label: editing.keyboardShown ? '隐藏键盘' : '显示键盘',
          icon: editing.keyboardShown ? 'keyboard-hide' : 'keyboard',
          disabled: !editing.keyboardShown && !editing.keyboardReady,
          className: 'remote-open-keyboard',
          run: () => controller.editing.toggleKeyboard(),
        }
      : null,
  );
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
      {editing.error && (
        <div role="status" className="input-notice">
          {editing.error}
        </div>
      )}
      {snapshot.presentation.error ? (
        <PageOverlay
          kind="error"
          action={
            snapshot.presentation.canRetry && (
              <Button variant="outlined" onClick={() => transport.presentation.retryPresentation()}>
                重试视频
              </Button>
            )
          }
        >
          {formatError(snapshot.presentation.error)}
        </PageOverlay>
      ) : snapshot.rtc.phase === 'exhausted' ? (
        <PageOverlay
          kind="error"
          action={
            <Button variant="outlined" onClick={() => void transport.rtc.connect()}>
              重新连接
            </Button>
          }
        >
          画面连接中断
        </PageOverlay>
      ) : (
        snapshot.rtc.phase !== 'connected' &&
        !resize.frozen && <PageOverlay kind="progress">正在连接浏览器…</PageOverlay>
      )}
      {overlay && <StatsOverlay diagnostics={snapshot.observations} surface={surface} />}
    </section>
  );
}
const emptySubscribe = () => () => {};
const initialEditing = { keyboardEnabled: false, keyboardShown: false, keyboardReady: false };
const emptyEditing = (): import('../editing/editing-view').EditingViewSnapshot => initialEditing;
