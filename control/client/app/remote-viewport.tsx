import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RemoteKitError } from '../../shared/errors';
import { sameEditingDocument } from '../editing/mobile-editing-state';
import { SurfaceState } from '../failures';
import { ViewportInput } from '../input/viewport-input';
import { useViewportTransition } from '../presentation/use-viewport-transition';
import { RemoteSelection } from '../selection/remote-selection';
import { canonicalJson } from '../util/canonical-json';
import type { ViewerSession } from '../viewer-session';
import { ContextMenu } from './context-menu';
import { useFloatingAction } from './floating-actions';
import './remote-viewport.css';
import { StatsOverlay } from './stats-overlay';
import { useViewerSessionSelector } from './use-viewer-session';
import { useViewportGeometry } from './use-viewport-geometry';
import { projectEditableCaret } from './viewport-geometry';

export function RemoteViewport({
  transport,
  viewId,
  overlay = false,
  keyboardActive = true,
  autoKeyboard = false,
  onFocus,
  onFrameReady,
  showConnectingOverlay = true,
}: {
  transport: ViewerSession;
  viewId: string;
  overlay?: boolean;
  keyboardActive?: boolean;
  autoKeyboard?: boolean;
  onFocus?: () => void;
  onFrameReady?: (ready: boolean) => void;
  showConnectingOverlay?: boolean;
}) {
  const snapshot = useViewerSessionSelector(
    transport,
    (snapshot) => ({
      surface: snapshot.presentation.layout?.views.find((view) => view.id === viewId),
      presentationError: snapshot.presentation.error,
      editingSurface: snapshot.editing.views.find((view) => view.id === viewId),
      attempt: snapshot.editing.attempt,
      current: snapshot.editing.current?.view?.id === viewId ? snapshot.editing.current : undefined,
      selection: snapshot.editing.selection?.view?.id === viewId ? snapshot.editing.selection : undefined,
      contextMenu:
        snapshot.editing.contextMenu?.view?.id === viewId ? snapshot.editing.contextMenu : undefined,
      rtcPhase: snapshot.rtc.phase,
    }),
    (previous, next) => canonicalJson(previous) === canonicalJson(next),
  );
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<HTMLElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const focused = useRef(onFocus);
  focused.current = onFocus;
  const [controller, setController] = useState<ViewportInput>();
  const [frameReady, setFrameReady] = useState(false);
  useLayoutEffect(() => onFrameReady?.(frameReady), [frameReady, onFrameReady]);
  const [dismissedContextMenu, setDismissedContextMenu] = useState<string>();
  const viewportFailure = useSyncExternalStore(transport.viewport.subscribe, transport.viewport.getSnapshot);
  const product = useSyncExternalStore(transport.operations.subscribe, transport.operations.getSnapshot);
  const geometry = useViewportGeometry(viewport, canvas);
  const surface = snapshot.surface;
  const editingSurface = snapshot.editingSurface;
  const owner =
    editingSurface &&
    `${snapshot.attempt}:${editingSurface.session}:${editingSurface.id}:${editingSurface.instance}:${editingSurface.document}`;
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
    () => controller?.configure(keyboardActive, autoKeyboard, resize),
    [
      controller,
      keyboardActive,
      autoKeyboard,
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
  useLayoutEffect(() => {
    const node = editor.current;
    if (!node || resize.waiting) return;
    const position = () => {
      const caret =
        document.activeElement === node && surface && geometry
          ? projectEditableCaret(surface, snapshot.current, geometry)
          : undefined;
      Object.assign(node.style, {
        left: caret ? `${caret.left}px` : '',
        top: caret ? `${caret.top}px` : '',
        height: caret ? `${caret.height}px` : '',
        fontSize: caret ? `${caret.fontSize}px` : '',
        lineHeight: caret?.lineHeight ?? '',
      });
    };
    position();
    node.addEventListener('focus', position);
    node.addEventListener('blur', position);
    return () => {
      node.removeEventListener('focus', position);
      node.removeEventListener('blur', position);
    };
  }, [surface, geometry, snapshot.current, resize.waiting]);
  const selection = snapshot.selection;
  const context = snapshot.contextMenu;
  const contextMenu =
    context?.view &&
    surface &&
    sameEditingDocument(surface, context.view) &&
    frameReady &&
    !resize.waiting &&
    `${owner}:${context.menu?.id}` !== dismissedContextMenu
      ? context.menu
      : undefined;
  const tab = product.state?.workspace.tabs.find((tab) => tab.webviewId === viewId);
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
      data-view-id={viewId}
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
      <RemoteSelection
        key={owner}
        transport={transport}
        message={selection}
        surface={surface}
        geometry={geometry}
        canvas={canvas.current}
        ready={frameReady && !resize.waiting && keyboardActive}
      />
      {contextMenu && surface && geometry && tab && product.state && (
        <ContextMenu
          key={`${owner}:${contextMenu.id}`}
          menu={contextMenu}
          surface={surface}
          geometry={geometry}
          viewport={viewport}
          editor={editor}
          transport={transport}
          tab={tab}
          engine={product.state.workspace.settings.browser.searchEngine}
          onClosed={() => setDismissedContextMenu(`${owner}:${contextMenu.id}`)}
        />
      )}
      <SurfaceState
        live
        error={editing.error}
        context={{
          operation: '发送键盘输入',
          scope: 'field',
          input: true,
          text: editing.error?.code === 'invalid_request' ? editing.error.message : undefined,
          action: { label: '重新输入', run: () => editor.current?.focus() },
        }}
      />
      <SurfaceState
        live
        error={
          snapshot.presentationError ??
          (viewportFailure?.code === 'limit_exceeded' ? undefined : viewportFailure) ??
          (snapshot.rtcPhase === 'exhausted'
            ? transport.rtc.getSnapshot().phase === 'exhausted'
              ? (transport.rtc.getSnapshot() as { error?: RemoteKitError }).error
              : undefined
            : showConnectingOverlay && snapshot.rtcPhase !== 'connected'
              ? new RemoteKitError('unavailable', '')
              : ((product.state?.endpointErrorKind === 'output-capacity'
                  ? undefined
                  : product.state?.endpointError) ?? undefined))
        }
        context={{
          operation: snapshot.presentationError
            ? '显示远程视频'
            : viewportFailure
              ? '更新远程画面尺寸'
              : '连接浏览器',
          scope: 'surface',
          connection: !snapshot.presentationError && !viewportFailure,
          targetId: viewId,
        }}
      />
      {overlay && <ViewportStats transport={transport} surface={surface} />}
    </section>
  );
}
const emptySubscribe = () => () => {};
const initialEditing = { keyboardEnabled: false, keyboardShown: false, keyboardReady: false };
const emptyEditing = (): import('../editing/editing-view').EditingViewSnapshot => initialEditing;

function ViewportStats({
  transport,
  surface,
}: {
  transport: ViewerSession;
  surface?: import('../presentation/types').Surface;
}) {
  const diagnostics = useViewerSessionSelector(transport, (snapshot) => snapshot.observations);
  return <StatsOverlay diagnostics={diagnostics} surface={surface} />;
}
