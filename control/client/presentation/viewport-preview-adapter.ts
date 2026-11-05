import type { CSSProperties } from 'react';
import { RemoteKitError } from '../../shared/errors';
import { diagnostics } from '../media/diagnostics';
import type { Surface } from './types';
import { Store } from '../util/store';
import type { PresentationSession } from './presentation-session';
import {
  KeyboardViewport,
  ResizePreview,
  ViewportTransition,
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
  keyboard: boolean;
  keyboardOpen: boolean;
  keyboardDismissals: number;
}
export class ViewportPreviewAdapter extends Store<ResizeSnapshot> {
  private readonly transition = new ViewportTransition();
  private readonly geometry = new KeyboardViewport();
  private readonly preview = new ResizePreview();
  private bitmap?: HTMLCanvasElement;
  private get blocked() {
    return this.transition.state.phase !== 'stable';
  }
  private set blocked(blocked: boolean) {
    if (blocked) this.transition.wait(this.preview.keyboard ? 'keyboard' : 'layout');
    else this.transition.settled();
    this.presentation.setTransitionBlocked(this.viewId, blocked);
  }
  private style?: CSSProperties;
  private frozen = false;
  private waiting = false;
  private keyboard = false;
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
    super({ frozen: false, waiting: false, keyboard: false, keyboardOpen: false, keyboardDismissals: 0 });
    this.remove = this.attach();
  }
  private changed() {
    const next = {
      style: this.style,
      frozen: this.frozen,
      waiting: this.waiting,
      keyboard: this.keyboard,
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
  setKeyboard = (value: ResizeSnapshot['keyboard']) => {
    this.keyboard = value;
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
  private measured = (_: unknown) => {
    this.confirm();
    this.changed();
  };
  blocksInput = () => this.blocked;
  configure(surface: Surface | undefined, frameReady: boolean, owner: string | undefined) {
    this.surface = surface;
    this.frameReady = frameReady;
    if (owner !== this.owner) {
      this.owner = owner;
      this.transition.clear();
      this.preview.clear();
      this.dispose();
      this.blocked = false;
      this.waiting = false;
      this.keyboard = false;
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
    const paintPreview = () => {
      const state = this.transition,
        image = this.bitmap;
      if (!image || !state.freeze || !state.desired) return;
      image.classList.toggle('keyboard-peek', this.preview.keyboard);
      image.style.setProperty(
        '--resize-peek-height',
        `${(state.desired.width * state.freeze.bounds.height) / state.freeze.bounds.width}px`,
      );
    };
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
        if (!context) throw new RemoteKitError('unavailable', 'resize snapshot context unavailable');
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
        paintPreview();
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
      const content = parent.getBoundingClientRect();
      const vv = visual && {
        width: visual.width,
        height: visual.height,
        offsetLeft: visual.offsetLeft,
        offsetTop: visual.offsetTop,
      };
      const bounds =
        inViewer || !vv
          ? content
          : {
              ...visibleContentBounds(content, { ...vv, offsetLeft: 0, offsetTop: 0 }),
              left: Math.max(content.left, vv.offsetLeft),
              top: Math.max(content.top, vv.offsetTop),
            };
      const next = {
        left: bounds.left - content.left,
        top: bounds.top - content.top,
        width: bounds.width,
        height: bounds.height,
      };
      const state = this.transition,
        now = performance.now();
      const changed = !!state.desired && !sameViewportSize(state.desired, bounds);
      const focused =
        !!this.editor && this.editor.inputMode !== 'none' && document.activeElement === this.editor;
      const change = this.geometry.measure(
        {
          visual: vv ?? undefined,
          scale: visual?.scale ?? 1,
          layoutWidth: window.innerWidth,
          layoutHeight: window.innerHeight,
        },
        focused,
        window.matchMedia('(pointer: coarse)').matches,
        now,
      );
      this.preview.measure(changed, change, now);
      if (this.geometry.settle(now)) this.setKeyboardDismissals(this.geometry.dismissals);
      this.setKeyboardOpen(this.geometry.open);
      state.desired = bounds;
      if (changed && state.confirmed && !sameViewportSize(state.confirmed.bounds, bounds)) suspend(false);
      paintPreview();
      this.setKeyboard(this.blocked && this.preview.keyboard);
      if (!position || !sameViewportBounds(position, next)) {
        position = next;
        this.setStyle({ inset: 'auto', ...next });
      }
      this.confirm();
      this.changed();
      clearTimeout(timer);
      const deadlines = [this.geometry.deadline, this.preview.deadline].filter(
        (at): at is number => at !== undefined && at > now,
      );
      if (deadlines.length)
        timer = setTimeout(
          () => {
            measure();
            this.measured(undefined);
          },
          Math.ceil(Math.min(...deadlines) - now),
        );
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
    if (!this.presentation.getLastPresentation(this.viewId) || performance.now() < this.preview.deadline)
      return;
    state.ready(this.owner, `${layout.generation}:${layout.epoch}`, bounds);
    if (!state.freeze) {
      this.dispose();
      this.preview.complete();
      this.blocked = false;
      this.setWaiting(false);
      this.setKeyboard(false);
    }
  };
  detach() {
    this.remove?.();
    this.dispose();
    this.presentation.setTransitionBlocked(this.viewId, false);
  }
}
