import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { RemoteTransport } from './transport';
import type { Surface } from './types';
import { FREEZE_MAX_MS, KeyboardViewport, ViewportTransition, resizeSnapshotSize, visibleContentBounds, sameViewportSize, surfaceMatchesViewport } from './viewport-transition';

const KEYBOARD_SETTLE_MS = 140;

/** A bounded copy for the resize preview. Transport owns frame and input readiness. */
export function useViewportTransition(
  host: RefObject<HTMLElement | null>, transport: RemoteTransport, viewId: string,
  surface: Surface | undefined, frameReady: boolean, owner: string | undefined,
  editor: RefObject<HTMLTextAreaElement | null>, editable: boolean,
) {
  const transition = useRef(new ViewportTransition());
  const keyboardViewport = useRef(new KeyboardViewport());
  const bitmap = useRef<HTMLCanvasElement | undefined>(undefined);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keyboardUntil = useRef(0);
  const attempted = useRef(false);
  const inputBlocked = useRef(false);
  const [settled, setSettled] = useState(0);
  const [style, setStyle] = useState<CSSProperties>();
  const [frozen, setFrozen] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const latest = useRef({ frameReady, owner, editable });
  latest.current = { frameReady, owner, editable };
  const disposeBitmap = () => {
    clearTimeout(timeout.current); timeout.current = undefined;
    const node = bitmap.current;
    if (node) { node.remove(); node.width = node.height = 0; bitmap.current = undefined; }
    setFrozen(false);
  };
  useLayoutEffect(() => {
    transition.current.clear(); attempted.current = false;
    keyboardViewport.current.clear(); keyboardUntil.current = 0;
    inputBlocked.current = false;
    disposeBitmap(); setWaiting(false); setKeyboard(false);
  }, [owner, transport, viewId]);
  useEffect(() => {
    const node = host.current, parent = node?.parentElement;
    if (!node || !parent) return;
    // The product shell already lays out inside the visual viewport.
    // Standalone automation mounts outside that shell.
    const inViewer = parent.classList.contains('window-content');
    const measure = () => {
      const content = parent.getBoundingClientRect();
      const viewport = window.visualViewport;
      const visual = viewport && { width: viewport.width, height: viewport.height, offsetLeft: viewport.offsetLeft, offsetTop: viewport.offsetTop };
      const bounds = inViewer ? content : visibleContentBounds(content, visual);
      const state = transition.current, current = latest.current;
      const changed = !!state.desired && !sameViewportSize(state.desired, bounds);
      const focused = current.editable && !!editor.current && document.activeElement === editor.current;
      // Read live browser viewport geometry in either observer. A later
      // viewport event can also reclassify a preview already copied by RO.
      const peek = keyboardViewport.current.measure({
        visual: visual ?? undefined, scale: viewport?.scale ?? 1,
        layoutWidth: window.innerWidth, layoutHeight: window.innerHeight,
      }, focused, window.matchMedia('(pointer: coarse)').matches);
      if (peek && (changed || attempted.current)) {
        keyboardUntil.current = performance.now() + KEYBOARD_SETTLE_MS;
        clearTimeout(settleTimer.current);
        settleTimer.current = setTimeout(() => setSettled(value => value + 1), KEYBOARD_SETTLE_MS);
        setKeyboard(true);
      } else if (changed && !peek) {
        keyboardUntil.current = 0;
        setKeyboard(false);
      }
      if (changed && current.owner && state.confirmed && !sameViewportSize(state.confirmed.bounds, bounds) && !attempted.current) {
        attempted.current = true;
        const frame = transport.getLastPresentation(viewId);
        const source = frame && transport.getPresentedPlane(viewId, frame.rtpTimestamp);
        const size = source && resizeSnapshotSize(source.sourceRect.width, source.sourceRect.height);
        if (source && size && state.begin(current.owner, bounds, performance.now(), size.width * size.height, current.frameReady)) {
          try {
            const canvas = document.createElement('canvas'), rect = source.sourceRect;
            canvas.width = size.width; canvas.height = size.height;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('resize snapshot context unavailable');
            context.drawImage(source.image, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
            const old = state.freeze!.bounds;
            canvas.className = 'remote-resize-freeze'; canvas.setAttribute('aria-hidden', 'true');
            canvas.style.setProperty('--resize-from-x', String(old.width / Math.max(1, bounds.width)));
            canvas.style.setProperty('--resize-from-y', String(old.height / Math.max(1, bounds.height)));
            node.append(canvas); bitmap.current = canvas;
            transport.recordResizeFreezeCopy(); setFrozen(true);
            timeout.current = setTimeout(() => { state.freeze = undefined; disposeBitmap(); }, FREEZE_MAX_MS);
          } catch {
            state.freeze = undefined; disposeBitmap();
          }
        }
      }
      if (bitmap.current && state.freeze) {
        bitmap.current.classList.toggle('keyboard-peek', peek || keyboardUntil.current !== 0);
        bitmap.current.style.setProperty('--resize-peek-height', `${bounds.width * state.freeze.bounds.height / state.freeze.bounds.width}px`);
      }
      state.desired = bounds;
      if (changed && state.confirmed && !sameViewportSize(state.confirmed.bounds, bounds)) {
        inputBlocked.current = true;
        setWaiting(true);
      }
      setStyle({ inset: 'auto', left: bounds.left - content.left, top: bounds.top - content.top, width: bounds.width, height: bounds.height });
    };
    const observer = new ResizeObserver(measure); observer.observe(parent);
    window.visualViewport?.addEventListener('resize', measure);
    if (!inViewer) window.visualViewport?.addEventListener('scroll', measure);
    measure();
    return () => { observer.disconnect(); window.visualViewport?.removeEventListener('resize', measure); if (!inViewer) window.visualViewport?.removeEventListener('scroll', measure); clearTimeout(settleTimer.current); disposeBitmap(); };
  }, [host, transport, viewId, owner, editor]);
  useLayoutEffect(() => {
    const state = transition.current, desired = state.desired, layout = transport.layout;
    if (!owner || !surface || !frameReady || !layout || !desired || !host.current) return;
    if (!surfaceMatchesViewport(surface, desired) || performance.now() < keyboardUntil.current) return;
    state.ready(owner, `${layout.generation}:${layout.epoch}`, desired);
    if (!state.freeze) {
      disposeBitmap(); attempted.current = false; keyboardUntil.current = 0;
      inputBlocked.current = false;
      setWaiting(false); setKeyboard(false);
    }
  }, [frameReady, owner, surface, transport.layout?.epoch, transport.layout?.generation, style, settled]);
  return { style, frozen, waiting, keyboard, blocksInput: () => inputBlocked.current, keyboardOpen: () => keyboardViewport.current.open, keyboardRestoreCount: () => keyboardViewport.current.restoreCount };
}
