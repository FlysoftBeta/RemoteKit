import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { RemoteTransport } from './transport';
import type { Surface } from './types';
import {
  FREEZE_MAX_MS, KeyboardViewport, ResizePreview, ViewportTransition, resizeSnapshotSize,
  visibleContentBounds, sameViewportBounds, sameViewportSize, surfaceMatchesViewport,
} from './viewport-transition';

/** Retain a bounded copy for the preview. Transport owns frame and input readiness. */
export function useViewportTransition(
  host: RefObject<HTMLElement | null>, transport: RemoteTransport, viewId: string,
  surface: Surface | undefined, frameReady: boolean, owner: string | undefined,
  editor: RefObject<HTMLTextAreaElement | null>,
) {
  const transition = useRef(new ViewportTransition());
  const keyboardViewport = useRef(new KeyboardViewport());
  const preview = useRef(new ResizePreview());
  const bitmap = useRef<HTMLCanvasElement | undefined>(undefined);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const attempted = useRef(false);
  const inputBlocked = useRef(false);
  const [measurement, measured] = useState(0);
  const [style, setStyle] = useState<CSSProperties>();
  const [frozen, setFrozen] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [keyboardDismissals, setKeyboardDismissals] = useState(0);
  const latest = useRef({ frameReady, owner });
  latest.current = { frameReady, owner };

  const disposeBitmap = () => {
    clearTimeout(timeout.current);
    const node = bitmap.current;
    if (node) {
      node.remove();
      node.width = node.height = 0;
      bitmap.current = undefined;
      setFrozen(false);
    }
  };
  useLayoutEffect(() => {
    transition.current.clear();
    attempted.current = inputBlocked.current = false;
    preview.current.clear();
    disposeBitmap(); setWaiting(false); setKeyboard(false);
  }, [owner, transport, viewId]);

  useLayoutEffect(() => {
    const node = host.current, parent = node?.parentElement;
    if (!node || !parent) return;
    const inViewer = parent.classList.contains('window-content');
    const viewport = window.visualViewport;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timerAt = 0;
    let previousPosition: { left: number; top: number; width: number; height: number } | undefined;
    const measure = () => {
      const content = parent.getBoundingClientRect();
      const visual = viewport && { width: viewport.width, height: viewport.height, offsetLeft: viewport.offsetLeft, offsetTop: viewport.offsetTop };
      // The Viewer shell already follows the visual viewport. In a standalone
      // mount, pan the visible region without treating its offset as a resize.
      const bounds = inViewer || !visual ? content : {
        ...visibleContentBounds(content, { ...visual, offsetLeft: 0, offsetTop: 0 }),
        left: Math.max(content.left, visual.offsetLeft), top: Math.max(content.top, visual.offsetTop),
      };
      const position = { left: bounds.left - content.left, top: bounds.top - content.top, width: bounds.width, height: bounds.height };
      const state = transition.current, current = latest.current, geometry = keyboardViewport.current;
      const now = performance.now();
      const changed = !!state.desired && !sameViewportSize(state.desired, bounds);
      const focused = !!editor.current && editor.current.inputMode !== 'none' && document.activeElement === editor.current;
      const change = geometry.measure({
        visual: visual ?? undefined, scale: viewport?.scale ?? 1,
        layoutWidth: window.innerWidth, layoutHeight: window.innerHeight,
      }, focused, window.matchMedia('(pointer: coarse)').matches, now);
      const peek = preview.current.measure(changed, change, now);
      if (geometry.settle(now)) setKeyboardDismissals(geometry.dismissals);
      setKeyboardOpen(geometry.open);

      if (changed && current.owner && state.confirmed && !sameViewportSize(state.confirmed.bounds, bounds)) {
        inputBlocked.current = true;
        setWaiting(true);
        if (!attempted.current) {
          attempted.current = true;
          const frame = transport.getLastPresentation(viewId);
          const source = frame && transport.getPresentedPlane(viewId, frame.rtpTimestamp);
          const size = source && resizeSnapshotSize(source.sourceRect.width, source.sourceRect.height);
          if (source && size && state.begin(current.owner, bounds, now, size.width * size.height, current.frameReady)) {
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
      }
      if (bitmap.current && state.freeze) {
        bitmap.current.classList.toggle('keyboard-peek', peek);
        bitmap.current.style.setProperty('--resize-peek-height', `${bounds.width * state.freeze.bounds.height / state.freeze.bounds.width}px`);
      }
      setKeyboard(inputBlocked.current && peek);
      state.desired = bounds;
      if (!previousPosition || !sameViewportBounds(previousPosition, position)) {
        previousPosition = position;
        setStyle({ inset: 'auto', ...position });
      }

      const deadlines = [geometry.deadline, preview.current.deadline].filter((at): at is number => at !== undefined && at > now);
      const next = deadlines.length ? Math.min(...deadlines) : 0;
      if (next !== timerAt) {
        clearTimeout(timer);
        timerAt = next;
        if (next) timer = setTimeout(() => { timerAt = 0; measure(); measured(value => value + 1); }, Math.ceil(next - now));
      }
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined;
    observer?.observe(parent);
    viewport?.addEventListener('resize', measure);
    if (!inViewer) viewport?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      observer?.disconnect();
      viewport?.removeEventListener('resize', measure);
      if (!inViewer) viewport?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      clearTimeout(timer);
    };
  }, [host, transport, viewId, editor, owner]);

  useLayoutEffect(() => {
    const state = transition.current, desired = state.desired, layout = transport.layout;
    if (!owner || !surface || !frameReady || !layout || !desired || !host.current) return;
    if (!surfaceMatchesViewport(surface, desired)) {
      inputBlocked.current = true;
      setWaiting(true);
      return;
    }
    if (!transport.getLastPresentation(viewId) || performance.now() < preview.current.deadline) return;
    state.ready(owner, `${layout.generation}:${layout.epoch}`, desired);
    if (!state.freeze) {
      disposeBitmap();
      attempted.current = false;
      inputBlocked.current = false;
      setWaiting(false); setKeyboard(false);
    }
  }, [frameReady, owner, surface, transport.layout?.epoch, transport.layout?.generation, style, measurement]);

  useLayoutEffect(() => () => { disposeBitmap(); }, []);
  return { style, frozen, waiting, keyboard, blocksInput: () => inputBlocked.current, keyboardOpen, keyboardDismissals };
}
