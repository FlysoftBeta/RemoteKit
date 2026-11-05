import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { RemoteTransport } from './transport';
import type { Surface } from './types';
import {
  KeyboardViewport, ResizePreview, ViewportTransition, resizeSnapshotSize,
  visibleContentBounds, sameViewportBounds, sameViewportSize, surfaceMatchesViewport,
} from './viewport-transition';

/** Display continuity and coordinate authorization have separate lifetimes.
 * Capture before transport revokes a presentation, keep one memory-bounded image
 * until its replacement is actually presented, and never manipulate DOM focus.
 */
export function useViewportTransition(
  host: RefObject<HTMLElement | null>, transport: RemoteTransport, viewId: string,
  surface: Surface | undefined, frameReady: boolean, owner: string | undefined,
  editor: RefObject<HTMLTextAreaElement | null>,
) {
  const transition = useRef(new ViewportTransition());
  const geometry = useRef(new KeyboardViewport());
  const preview = useRef(new ResizePreview());
  const bitmap = useRef<HTMLCanvasElement | undefined>(undefined);
  const blocked = useRef(false);
  const [measurement, measured] = useState(0);
  const [style, setStyle] = useState<CSSProperties>();
  const [frozen, setFrozen] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [keyboardDismissals, setKeyboardDismissals] = useState(0);

  const dispose = () => {
    const canvas = bitmap.current;
    if (canvas) { canvas.remove(); canvas.width = canvas.height = 0; bitmap.current = undefined; }
    setFrozen(false);
  };
  useLayoutEffect(() => {
    transition.current.clear(); preview.current.clear(); dispose();
    blocked.current = false; setWaiting(false); setKeyboard(false);
    // Occlusion describes the local OS, which may still animate the previous
    // keyboard away after a remote document boundary.
  }, [owner, transport, viewId]);

  useLayoutEffect(() => {
    const node = host.current, parent = node?.parentElement;
    if (!node || !parent) return;
    const inViewer = parent.classList.contains('window-content'), visual = window.visualViewport;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let position: { left: number; top: number; width: number; height: number } | undefined;
    const paintPreview = () => {
      const state = transition.current, image = bitmap.current;
      if (!image || !state.freeze || !state.desired) return;
      image.classList.toggle('keyboard-peek', preview.current.keyboard);
      image.style.setProperty('--resize-peek-height', `${state.desired.width * state.freeze.bounds.height / state.freeze.bounds.width}px`);
    };
    const suspend = (mediaBarrier: boolean) => {
      const state = transition.current, bounds = state.desired;
      blocked.current = true; setWaiting(true);
      if (!owner || !bounds || bitmap.current) return;
      const frame = transport.getLastPresentation(viewId);
      const source = frame && transport.getPresentedPlane(viewId, frame.rtpTimestamp);
      const size = source && resizeSnapshotSize(source.sourceRect.width, source.sourceRect.height);
      if (!source || !size || !state.begin(owner, bounds, size.width * size.height, true, mediaBarrier)) return;
      const canvas = document.createElement('canvas');
      try {
        canvas.width = size.width; canvas.height = size.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('resize snapshot context unavailable');
        const rect = source.sourceRect;
        context.drawImage(source.image, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
        canvas.className = 'remote-resize-freeze'; canvas.setAttribute('aria-hidden', 'true');
        const old = state.freeze!.bounds;
        canvas.style.setProperty('--resize-from-x', String(old.width / Math.max(1, bounds.width)));
        canvas.style.setProperty('--resize-from-y', String(old.height / Math.max(1, bounds.height)));
        bitmap.current = canvas; node.append(canvas); paintPreview();
        transport.recordResizeFreezeCopy(); setFrozen(true);
      } catch { canvas.width = canvas.height = 0; state.freeze = undefined; }
    };
    const measure = () => {
      const content = parent.getBoundingClientRect();
      const vv = visual && { width: visual.width, height: visual.height, offsetLeft: visual.offsetLeft, offsetTop: visual.offsetTop };
      const bounds = inViewer || !vv ? content : {
        ...visibleContentBounds(content, { ...vv, offsetLeft: 0, offsetTop: 0 }),
        left: Math.max(content.left, vv.offsetLeft), top: Math.max(content.top, vv.offsetTop),
      };
      const next = { left: bounds.left - content.left, top: bounds.top - content.top, width: bounds.width, height: bounds.height };
      const state = transition.current, now = performance.now();
      const changed = !!state.desired && !sameViewportSize(state.desired, bounds);
      const focused = !!editor.current && editor.current.inputMode !== 'none' && document.activeElement === editor.current;
      const change = geometry.current.measure({ visual: vv ?? undefined, scale: visual?.scale ?? 1,
        layoutWidth: window.innerWidth, layoutHeight: window.innerHeight }, focused, window.matchMedia('(pointer: coarse)').matches, now);
      preview.current.measure(changed, change, now);
      if (geometry.current.settle(now)) setKeyboardDismissals(geometry.current.dismissals);
      setKeyboardOpen(geometry.current.open);
      state.desired = bounds;
      if (changed && state.confirmed && !sameViewportSize(state.confirmed.bounds, bounds)) suspend(false);
      paintPreview(); setKeyboard(blocked.current && preview.current.keyboard);
      if (!position || !sameViewportBounds(position, next)) { position = next; setStyle({ inset: 'auto', ...next }); }
      clearTimeout(timer);
      const deadlines = [geometry.current.deadline, preview.current.deadline].filter((at): at is number => at !== undefined && at > now);
      if (deadlines.length) timer = setTimeout(() => { measure(); measured(n => n + 1); }, Math.ceil(Math.min(...deadlines) - now));
    };
    const observer = new ResizeObserver(measure); observer.observe(parent);
    visual?.addEventListener('resize', measure);
    if (!inViewer) visual?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    const unsubscribe = transport.subscribePresentationInvalidation(id => { if (id === viewId) suspend(true); });
    measure();
    return () => {
      observer.disconnect(); unsubscribe(); clearTimeout(timer);
      visual?.removeEventListener('resize', measure); visual?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [host, transport, viewId, editor, owner]);

  useLayoutEffect(() => {
    const state = transition.current, bounds = state.desired, layout = transport.layout;
    if (!owner || !surface || !frameReady || !layout || !bounds) return;
    if (!surfaceMatchesViewport(surface, bounds)) { blocked.current = true; setWaiting(true); return; }
    if (!transport.getLastPresentation(viewId) || performance.now() < preview.current.deadline) return;
    state.ready(owner, `${layout.generation}:${layout.epoch}`, bounds);
    if (!state.freeze) { dispose(); preview.current.complete(); blocked.current = false; setWaiting(false); setKeyboard(false); }
  }, [frameReady, owner, surface, transport.layout?.epoch, transport.layout?.generation, style, measurement]);
  useLayoutEffect(() => () => { dispose(); }, []);
  return { style, frozen, waiting, keyboard, blocksInput: () => blocked.current, keyboardOpen, keyboardDismissals };
}
