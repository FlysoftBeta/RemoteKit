import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { RemoteTransport } from './transport';
import type { Surface } from './types';
import { FREEZE_MAX_MS, ViewportTransition, visibleContentBounds, sameViewportBounds } from './viewport-transition';

/** A single bounded ROI copy during a visual viewport transaction, never a frame backend. */
export function useViewportTransition(host: RefObject<HTMLElement | null>, transport: RemoteTransport, viewId: string, surface: Surface | undefined, frameReady: boolean, owner: string | undefined) {
  const transition = useRef(new ViewportTransition());
  const bitmap = useRef<HTMLCanvasElement | undefined>(undefined);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastVisualAt = useRef(-Infinity);
  const [settled, setSettled] = useState(0);
  const attempted = useRef(false);
  const [style, setStyle] = useState<CSSProperties>();
  const [frozen, setFrozen] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const latest = useRef({ surface, frameReady, owner, waiting });
  latest.current = { surface, frameReady, owner, waiting };
  const disposeBitmap = () => {
    clearTimeout(timeout.current); timeout.current = undefined;
    const node = bitmap.current;
    if (node) { node.remove(); node.width = node.height = 0; bitmap.current = undefined; }
    setFrozen(false);
  };
  useLayoutEffect(() => {
    transition.current.clear(); attempted.current = false;
    disposeBitmap(); setWaiting(false);
  }, [owner, transport]);
  useEffect(() => {
    const parent = host.current?.parentElement;
    if (!parent) return;
    const measure = (visualChange = false) => {
      const content = parent.getBoundingClientRect();
      const bounds = visibleContentBounds(content, window.visualViewport);
      const state = transition.current, current = latest.current;
      const changed = state.desired && !sameViewportBounds(state.desired, bounds);
      if (visualChange) {
        lastVisualAt.current = performance.now();
        clearTimeout(settleTimer.current);
        settleTimer.current = setTimeout(() => setSettled(value => value + 1), 140);
      }
      if (visualChange && current.owner && state.confirmed && !sameViewportBounds(state.confirmed.bounds, bounds) && !attempted.current) {
        attempted.current = true;
        const frame = transport.getLastPresentation(viewId);
        const source = frame && transport.getPresentedPlane(viewId, frame.rtpTimestamp);
        if (source && state.begin(current.owner, bounds, performance.now(), source.sourceRect.width * source.sourceRect.height, current.frameReady)) {
          try {
            const canvas = document.createElement('canvas'), rect = source.sourceRect;
            canvas.width = Math.ceil(rect.width); canvas.height = Math.ceil(rect.height);
            const context = canvas.getContext('2d');
            if (!context) throw new Error('resize snapshot context unavailable');
            context.drawImage(source.image, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
            const fixed = state.freeze!.bounds;
            Object.assign(canvas.style, { position: 'fixed', left: `${fixed.left}px`, top: `${fixed.top}px`, width: `${fixed.width}px`, height: `${fixed.height}px`, zIndex: '2', pointerEvents: 'none' });
            canvas.className = 'remote-resize-freeze'; canvas.setAttribute('aria-hidden', 'true');
            document.body.append(canvas); bitmap.current = canvas;
            transport.recordResizeFreezeCopy(); setFrozen(true);
            timeout.current = setTimeout(() => { state.freeze = undefined; disposeBitmap(); }, FREEZE_MAX_MS);
          } catch {
            // A failed copy retains the ordinary hidden/live media barrier.
            state.freeze = undefined; disposeBitmap();
          }
        }
      }
      state.desired = bounds;
      if (changed && state.confirmed && (Math.round(state.confirmed.bounds.width) !== Math.round(bounds.width) || Math.round(state.confirmed.bounds.height) !== Math.round(bounds.height))) {
        latest.current.waiting = true; setWaiting(true);
      }
      setStyle({ inset: 'auto', left: bounds.left - content.left, top: bounds.top - content.top, width: bounds.width, height: bounds.height });
    };
    const resize = () => measure(true), layout = () => measure(false);
    const observer = new ResizeObserver(layout); observer.observe(parent);
    window.visualViewport?.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('scroll', resize);
    measure();
    return () => { observer.disconnect(); window.visualViewport?.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('scroll', resize); clearTimeout(settleTimer.current); disposeBitmap(); };
  }, [host, transport, viewId, owner]);
  // Match desired content DIP to an actually ready presentation. Readiness is
  // owned by Transport; this hook cannot bypass its RTP/layout barrier.
  useLayoutEffect(() => {
    const state = transition.current, desired = state.desired, layout = transport.layout;
    if (!owner || !surface || !frameReady || !layout || !desired || !host.current) return;
    const scale = surface.deviceScaleFactor * (surface.mediaScale ?? 1);
    if (Math.abs(surface.width / scale - Math.round(desired.width)) > 1 || Math.abs(surface.height / scale - Math.round(desired.height)) > 1) return;
    if (attempted.current && performance.now() - lastVisualAt.current < 120) return;
    state.ready(owner, `${layout.generation}:${layout.epoch}`, desired);
    if (!state.freeze) { disposeBitmap(); attempted.current = false; setWaiting(false); }
  }, [frameReady, owner, surface, transport.layout?.epoch, transport.layout?.generation, style, settled]);
  return { style, frozen, waiting };
}
