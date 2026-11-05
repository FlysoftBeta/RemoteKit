import type { EditingSession } from '../editing/editing-session';
import { EditingView, type ResizeObservation } from '../editing/editing-view';
import type { PresentationSession } from '../presentation/presentation-session';
import type { Surface } from '../types';
import { clientPointToDip, pointerPointToDip, wheelDeltaToDip, type PointerAction } from './coordinates';
import type { InputPipeline } from './input-pipeline';
import { mouseButtonModifiers } from './keys';
import { pointerSampleTime } from './touch-input';
import type { TouchSession } from './touch-session';
import { TouchView } from './touch-view';

export interface ViewportInputPorts {
  input: Pick<
    InputPipeline,
    | 'sendInput'
    | 'ensureInputFocus'
    | 'focus'
    | 'inputIdentity'
    | 'subscribeInputResults'
    | 'subscribeInputDelivery'
    | 'touchStartWall'
    | 'subscribe'
  >;
  presentation: Pick<
    PresentationSession,
    'layout' | 'canInput' | 'selectedViewId' | 'subscribe' | 'subscribeFrames'
  >;
  editing: Pick<
    EditingSession,
    'mobileEditing' | 'editingSurface' | 'editingIdentity' | 'subscribe' | 'createView'
  >;
  touch: Pick<TouchSession, 'touchRetirementCurrent' | 'retireTouch' | 'retryTouchTerminal' | 'createView'>;
}

export class ViewportInput {
  readonly editing: EditingView;
  readonly touch: TouchView;
  private readonly remove: (() => void)[] = [];
  private pressed?: { pointerId: number; identity: string; button: number; x: number; y: number };
  private tap?: { id: number; x: number; y: number; at: number };
  constructor(
    private readonly ports: ViewportInputPorts,
    readonly viewId: string,
    private readonly canvas: HTMLCanvasElement,
    private readonly editor: HTMLTextAreaElement,
    private readonly focused: () => void,
  ) {
    this.touch = ports.touch.createView(ports, viewId, canvas);
    this.editing = ports.editing.createView(ports, viewId, editor);
    this.listen(canvas, 'pointerdown', (event) => this.pointer(event as PointerEvent, 'down'));
    this.listen(canvas, 'pointermove', (event) => this.pointer(event as PointerEvent, 'move'));
    this.listen(canvas, 'pointerup', (event) => this.pointer(event as PointerEvent, 'up'));
    this.listen(canvas, 'pointercancel', (event) => this.pointer(event as PointerEvent, 'cancel'));
    this.listen(canvas, 'pointerleave', (event) => {
      if ((event as PointerEvent).pointerType !== 'touch') this.pointer(event as PointerEvent, 'leave');
    });
    this.listen(canvas, 'lostpointercapture', (event) => {
      const pointer = event as PointerEvent;
      if (pointer.pointerType === 'touch' && this.touch.contactIds.includes(pointer.pointerId))
        this.touch.cancelTouches();
    });
    this.listen(canvas, 'contextmenu', (event) => event.preventDefault());
    this.listen(canvas, 'wheel', (event) => this.wheel(event as WheelEvent), { passive: false });
    this.listen(editor, 'focus', this.editing.onFocus);
    this.listen(editor, 'blur', this.editing.onBlur);
    this.listen(editor, 'keydown', (event) => this.editing.key(event as KeyboardEvent, 'down'));
    this.listen(editor, 'keyup', (event) => this.editing.key(event as KeyboardEvent, 'up'));
    this.listen(editor, 'beforeinput', (event) => this.editing.edit(event as InputEvent, 'before'));
    this.listen(editor, 'input', (event) => this.editing.edit(event as InputEvent, 'input'));
    this.listen(editor, 'compositionstart', this.editing.compositionStart);
    this.listen(editor, 'compositionupdate', (event) =>
      this.editing.compositionUpdate((event as CompositionEvent).data),
    );
    this.listen(editor, 'compositionend', (event) =>
      this.editing.compositionEnd((event as CompositionEvent).data),
    );
    this.listen(window, 'blur', () => this.release(document.hidden || document.activeElement !== editor));
    this.listen(document, 'visibilitychange', () => {
      if (document.hidden) this.release();
    });
    this.remove.push(
      ports.input.subscribe(this.editing.observe),
      ports.editing.subscribe(this.editing.observe),
      ports.presentation.subscribeFrames(this.editing.observe),
      ports.presentation.subscribe(() => {
        this.touch.syncTouchOwner();
        this.editing.observe();
      }),
    );
  }
  private get surface() {
    return this.ports.presentation.layout?.views.find((view) => view.id === this.viewId);
  }
  configure(enabled: boolean, manual: boolean, resize: ResizeObservation) {
    this.editing.configure(enabled, manual, resize);
  }
  dispose() {
    this.remove.forEach((remove) => remove());
    this.release();
    this.touch.dispose();
    this.editing.dispose();
  }
  private listen(
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions,
  ) {
    target.addEventListener(type, listener, options);
    this.remove.push(() => target.removeEventListener(type, listener, options));
  }
  private identity(surface: Surface) {
    const layout = this.ports.presentation.layout;
    return `${surface.session}:${surface.id}:${surface.instance}:${surface.document}:${layout?.generation}:${layout?.epoch}`;
  }
  private release(endEditing = true) {
    const held = this.pressed,
      surface = this.surface;
    if (held) {
      if (surface && held.identity === this.identity(surface))
        this.ports.input.sendInput(surface, {
          type: 'mouse',
          action: 'up',
          x: held.x,
          y: held.y,
          button: held.button,
          modifiers: 0,
          click_count: 1,
        });
      if (this.canvas.hasPointerCapture(held.pointerId)) this.canvas.releasePointerCapture(held.pointerId);
      this.pressed = undefined;
    }
    this.touch.cancelTouches();
    this.editing.release(endEditing);
  }
  private pointer(event: PointerEvent, action: PointerAction) {
    const touch = event.pointerType === 'touch';
    const surface = this.surface;
    if (
      touch &&
      this.tap &&
      (action === 'cancel' ||
        action === 'down' ||
        Math.hypot(event.clientX - this.tap.x, event.clientY - this.tap.y) > 8)
    )
      this.tap = undefined;
    if (touch && action === 'cancel') {
      this.touch.cancelTouches();
      return;
    }
    const captured = this.canvas.hasPointerCapture(event.pointerId);
    const pressed =
      this.pressed?.pointerId === event.pointerId &&
      surface &&
      this.pressed.identity === this.identity(surface)
        ? this.pressed
        : undefined;
    const release = () => {
      if (action === 'up' || action === 'cancel') {
        if (captured) this.canvas.releasePointerCapture(event.pointerId);
        if (this.pressed?.pointerId === event.pointerId) this.pressed = undefined;
      }
    };
    if (!surface || !this.ports.presentation.canInput(this.viewId)) {
      if (touch) this.touch.cancelTouches();
      release();
      return;
    }
    const bounds = this.canvas.getBoundingClientRect();
    const point = pointerPointToDip(
      surface,
      bounds,
      event.clientX,
      event.clientY,
      action,
      captured || !!pressed,
    );
    if (!point) {
      release();
      return;
    }
    if (action === 'down') {
      event.preventDefault();
      this.ports.presentation.selectedViewId = this.viewId;
      this.focused();
      if (touch && !this.touch.contactIds.length)
        this.tap = { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now() };
      if (!touch) {
        if (event.button === 0) this.editing.activateKeyboard();
        if (this.editor.inputMode === 'none') this.editing.focusEditor(false);
      }
      this.ports.input.ensureInputFocus(surface);
      this.canvas.setPointerCapture(event.pointerId);
      if (!touch)
        this.pressed = {
          pointerId: event.pointerId,
          identity: this.identity(surface),
          button: [1, 2, 3, 4, 5][event.button] ?? 0,
          ...point,
        };
    }
    if (pressed) Object.assign(pressed, point);
    if (touch) {
      const now = performance.now();
      const history =
        action === 'move' && typeof event.getCoalescedEvents === 'function'
          ? event.getCoalescedEvents().slice(-32)
          : [];
      let previous = -Infinity;
      for (const sample of [...history, event]) {
        const at = pointerSampleTime(sample.timeStamp, now, performance.timeOrigin);
        if (at === undefined) {
          this.touch.cancelTouches();
          break;
        }
        if (at <= previous) continue;
        previous = at;
        const position = pointerPointToDip(
          surface,
          bounds,
          sample.clientX,
          sample.clientY,
          action,
          captured || action === 'down',
        );
        if (
          position &&
          !this.touch.sample(
            action === 'down' ? 'start' : action === 'up' ? 'end' : 'move',
            { id: event.pointerId, ...position, pressure: sample.pressure },
            at,
          )
        )
          break;
      }
      if (action === 'up' && !this.touch.contactIds.length) {
        const tap = this.tap;
        this.tap = undefined;
        if (tap?.id === event.pointerId && now - tap.at < 500) this.editing.activateKeyboard();
      }
    } else if (action !== 'cancel' || pressed)
      this.ports.input.sendInput(surface, {
        type: 'mouse',
        action: action === 'cancel' ? 'up' : action,
        ...point,
        button:
          action === 'cancel'
            ? pressed!.button
            : action === 'move' || action === 'leave'
              ? 0
              : ([1, 2, 3, 4, 5][event.button] ?? 0),
        modifiers: this.modifiers(event) | mouseButtonModifiers(event.buttons),
        click_count: action === 'move' || action === 'leave' ? 0 : Math.min(3, Math.max(1, event.detail)),
      });
    release();
  }
  private wheel(event: WheelEvent) {
    const surface = this.surface;
    if (!surface || !this.ports.presentation.canInput(this.viewId)) return;
    const point = clientPointToDip(
      surface,
      this.canvas.getBoundingClientRect(),
      event.clientX,
      event.clientY,
    );
    if (!point) return;
    event.preventDefault();
    this.ports.input.ensureInputFocus(surface);
    const delta = wheelDeltaToDip(surface, event.deltaX, event.deltaY, event.deltaMode);
    this.ports.input.sendInput(surface, {
      type: 'wheel',
      ...point,
      dx: -delta.x,
      dy: -delta.y,
      modifiers: this.modifiers(event),
    });
  }
  private modifiers(event: MouseEvent) {
    return (
      Number(event.shiftKey) |
      (Number(event.ctrlKey) << 1) |
      (Number(event.altKey) << 2) |
      (Number(event.metaKey) << 3)
    );
  }
}
