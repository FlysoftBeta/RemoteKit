import { KeyboardViewport } from '../editing/keyboard-viewport';
import type { CSSProperties } from 'react';
import { uiScale } from '../app/ui-scale';
import { RemoteKitError } from '../../shared/errors';
import { diagnostics } from '../media/diagnostics';
import type { Surface } from './types';
import { Store } from '../util/store';
import type { PresentationSession } from './presentation-session';
import {
  ViewportTransition,
  pixelAlignedViewportBounds,
  resizeSnapshotSize,
  sameViewportBounds,
  sameViewportSize,
  surfaceMatchesViewport,
  visibleContentBounds,
} from './viewport-transition';

export interface ResizeSnapshot {
  style?: CSSProperties;
  frozen: boolean;
  waiting: boolean;
  keyboardOpen: boolean;
  keyboardDismissals: number;
}
export class ViewportPreviewAdapter extends Store<ResizeSnapshot> {
  private readonly transition = new ViewportTransition();
  private readonly geometry = new KeyboardViewport();
  private bitmap?: HTMLCanvasElement;
  private get blocked() {
    return this.transition.state.phase !== 'stable';
  }
  private set blocked(blocked: boolean) {
    if (blocked) this.transition.wait('layout');
    else this.transition.settled();
    this.presentation.setTransitionBlocked(this.viewId, blocked);
  }
  private style?: CSSProperties;
  private frozen = false;
  private waiting = false;
  private keyboardOpen = false;
  private keyboardDismissals = 0;
  private surface?: Surface;
  private frameReady = false;
  private owner?: string;
  private remove?: () => void;
  private measure = () => {};
  constructor(
    private readonly presentation: Pick<
      PresentationSession,
      | 'layout'
      | 'getLastPresentation'
      | 'getPresentedPlane'
      | 'recordResizeFreezeCopy'
      | 'subscribePresentationInvalidation'
      | 'setTransitionBlocked'
    >,
    readonly viewId: string,
    private readonly host: HTMLElement,
    private readonly editor: HTMLTextAreaElement,
  ) {
    super({ frozen: false, waiting: false, keyboardOpen: false, keyboardDismissals: 0 });
    this.remove = this.attach();
  }
  private changed() {
    const next = {
      style: this.style,
      frozen: this.frozen,
      waiting: this.waiting,
      keyboardOpen: this.keyboardOpen,
      keyboardDismissals: this.keyboardDismissals,
    };
    const previous = this.getSnapshot();
    if (
      Object.keys(next).some(
        (key) => next[key as keyof ResizeSnapshot] !== previous[key as keyof ResizeSnapshot],
      )
    )
      this.publish(next);
  }
  setFrozen = (value: ResizeSnapshot['frozen']) => {
    this.frozen = value;
  };
  setWaiting = (value: ResizeSnapshot['waiting']) => {
    this.waiting = value;
  };
  setKeyboardOpen = (value: ResizeSnapshot['keyboardOpen']) => {
    this.keyboardOpen = value;
  };
  setKeyboardDismissals = (value: ResizeSnapshot['keyboardDismissals']) => {
    this.keyboardDismissals = value;
  };
  setStyle = (value: ResizeSnapshot['style']) => {
    this.style = value;
  };
  blocksInput = () => this.blocked;
  configure(surface: Surface | undefined, frameReady: boolean, owner: string | undefined) {
    this.surface = surface;
    this.frameReady = frameReady;
    if (owner !== this.owner) {
      this.owner = owner;
      this.transition.clear();
      this.dispose();
      this.blocked = false;
      this.waiting = false;
    }
    this.measure();
    this.confirm();
    this.changed();
  }
  dispose = () => {
    const canvas = this.bitmap;
    if (canvas) {
      canvas.remove();
      canvas.width = canvas.height = 0;
      this.bitmap = undefined;
    }
    this.setFrozen(false);
  };
  private attach = () => {
    const node = this.host,
      parent = node?.parentElement;
    if (!node || !parent) return;
    const inViewer = parent.classList.contains('window-content'),
      visual = window.visualViewport;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let position:
      | {
          left: number;
          top: number;
          width: number;
          height: number;
        }
      | undefined;
    const suspend = (mediaBarrier: boolean) => {
      const state = this.transition,
        bounds = state.desired;
      this.blocked = true;
      this.setWaiting(true);
      if (!this.owner || !bounds || this.bitmap) return;
      const frame = this.presentation.getLastPresentation(this.viewId);
      const source = frame && this.presentation.getPresentedPlane(this.viewId, frame.rtpTimestamp);
      const size = source && resizeSnapshotSize(source.sourceRect.width, source.sourceRect.height);
      if (!source || !size || !state.begin(this.owner, bounds, size.width * size.height, true, mediaBarrier))
        return;
      const canvas = document.createElement('canvas');
      try {
        canvas.width = size.width;
        canvas.height = size.height;
        const context = canvas.getContext('2d');
        if (!context) throw new RemoteKitError('unavailable', '无法获取窗口预览画面');
        const rect = source.sourceRect;
        context.drawImage(
          source.image,
          rect.x,
          rect.y,
          rect.width,
          rect.height,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        canvas.className = 'remote-resize-freeze';
        canvas.setAttribute('aria-hidden', 'true');
        const old = state.freeze!.bounds;
        canvas.style.setProperty('--resize-from-x', String(old.width / Math.max(1, bounds.width)));
        canvas.style.setProperty('--resize-from-y', String(old.height / Math.max(1, bounds.height)));
        this.bitmap = canvas;
        node.append(canvas);
        this.presentation.recordResizeFreezeCopy();
        this.setFrozen(true);
        this.changed();
      } catch (error) {
        diagnostics.record('resize-preview', error);
        canvas.width = canvas.height = 0;
        state.freeze = undefined;
      }
    };
    const measure = () => {
      const outer = parent.getBoundingClientRect();
      const scale = uiScale();
      const content = {
        left: outer.left + parent.clientLeft * scale,
        top: outer.top + parent.clientTop * scale,
        width: parent.clientWidth * scale,
        height: parent.clientHeight * scale,
      };
      const vv = visual && {
        width: visual.width,
        height: visual.height,
        offsetLeft: visual.offsetLeft,
        offsetTop: visual.offsetTop,
      };
      const seen =
        inViewer || !vv
          ? { left: content.left, top: content.top, width: content.width, height: content.height }
          : {
              ...visibleContentBounds(content, { ...vv, offsetLeft: 0, offsetTop: 0 }),
              left: Math.max(content.left, vv.offsetLeft),
              top: Math.max(content.top, vv.offsetTop),
            };
      // Client rects are visual px; surfaces and element styles use layout px, which differ by the
      // Viewer's UI scale transform.
      const bounds = pixelAlignedViewportBounds(seen, scale, window.devicePixelRatio || 1);
      const next = {
        left: bounds.left - content.left / scale,
        top: bounds.top - content.top / scale,
        width: bounds.width,
        height: bounds.height,
      };
      const state = this.transition,
        now = performance.now();
      const changed = !!state.desired && !sameViewportSize(state.desired, bounds);
      const focused =
        !!this.editor && this.editor.inputMode !== 'none' && document.activeElement === this.editor;
      this.geometry.measure(
        {
          visual: vv ?? undefined,
          scale: visual?.scale ?? 1,
          layoutWidth: window.innerWidth,
          layoutHeight: window.innerHeight,
          screen: { width: window.screen.width, height: window.screen.height },
        },
        focused,
        window.matchMedia('(pointer: coarse)').matches,
        now,
      );
      if (this.geometry.settle(now)) this.setKeyboardDismissals(this.geometry.dismissals);
      this.setKeyboardOpen(this.geometry.open);
      state.desired = bounds;
      if (changed && state.confirmed && !sameViewportSize(state.confirmed.bounds, bounds)) suspend(false);
      if (!position || !sameViewportBounds(position, next)) {
        position = next;
        this.setStyle({ inset: 'auto', ...next });
      }
      this.confirm();
      this.changed();
      clearTimeout(timer);
      const deadlines = [this.geometry.deadline].filter((at): at is number => at !== undefined && at > now);
      if (deadlines.length) timer = setTimeout(measure, Math.ceil(Math.min(...deadlines) - now));
    };
    this.measure = measure;
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    visual?.addEventListener('resize', measure);
    if (!inViewer) visual?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    const unsubscribe = this.presentation.subscribePresentationInvalidation((id) => {
      if (id === this.viewId) suspend(true);
    });
    measure();
    return () => {
      observer.disconnect();
      unsubscribe();
      clearTimeout(timer);
      visual?.removeEventListener('resize', measure);
      visual?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  };
  private confirm = () => {
    const state = this.transition,
      bounds = state.desired,
      layout = this.presentation.layout;
    if (!this.owner || !this.surface || !this.frameReady || !layout || !bounds) return;
    if (!surfaceMatchesViewport(this.surface, bounds)) {
      this.blocked = true;
      this.setWaiting(true);
      return;
    }
    // Late RTP metadata can authorize this layout without identifying current
    // pixels. Only the preview copy needs an exact compositor observation.
    state.ready(this.owner, `${layout.generation}:${layout.epoch}`, bounds);
    if (!state.freeze) {
      this.dispose();
      this.blocked = false;
      this.setWaiting(false);
    }
  };
  detach() {
    this.remove?.();
    this.dispose();
    this.presentation.setTransitionBlocked(this.viewId, false);
  }
}
