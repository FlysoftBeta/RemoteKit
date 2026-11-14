import { errorHandling } from '../../shared/error-policy';
import { RetryUnit } from '../../shared/retry-unit';
import { RemoteKitError } from '../../shared/errors';
import { endpointError } from '../../shared/errors';
import { type Diagnostics } from '../media/types';
import { samePlane } from '../presentation/plane-source';
import type { InputAuthority } from '../presentation/presentation-session';
import { type Layout, type Surface } from '../presentation/types';
import { KeyboardLayout } from './keyboard-layout';
import { mergeGestureMomentum, mergeTouchMoves } from './touch-input';
export interface InputPorts {
  canInput(viewId: string): InputAuthority | null;
  send(message: Outgoing): void;
  layout(): Layout | null;
  attempt(): number;
  scope(): { locked: boolean; epoch?: number };
  channel(): { readyState: RTCDataChannelState; bufferedAmount: number } | null;
  inputStart(at: number): number | undefined;
  report(change: Partial<Diagnostics>): void;
  grantFocus(viewId: string, token: string): void;
  clearEditing(): void;
  reconcileEditing(views: Surface[]): void;
}

import { type Incoming, type Outgoing } from '../rtc/protocol';
import type { InputDelivery, InputRequest, InputResult, QueuedInput } from './types';

export type FocusLease =
  | { phase: 'none' }
  | { phase: 'requested'; id: string; deadline: number }
  | { phase: 'granted'; token: string };
export interface InputSnapshot {
  focus: FocusLease;
  queued: number;
  sent: number;
}
function isDismiss(event: Record<string, unknown>) {
  return (
    event.type === 'editing.dismiss' ||
    ((event.type === 'selection_command' || event.type === 'context_command') && event.command === 'dismiss')
  );
}
export class InputPipeline {
  nextSequence() {
    return String(++this.sequence);
  }
  private focusLease: FocusLease = { phase: 'none' };
  constructor(private readonly ports: InputPorts) {}
  private readonly keyboardLayout = new KeyboardLayout();
  private keyboardChannel?: ReturnType<InputPorts['channel']>;

  private connectKeyboardLayout() {
    const channel = this.ports.channel();
    if (channel?.readyState !== 'open' || this.ports.scope().locked || channel === this.keyboardChannel)
      return;
    this.keyboardChannel = channel;
    const epoch = this.ports.scope().epoch;
    this.keyboardLayout.connect((message) => {
      if (
        this.ports.channel() === channel &&
        channel.readyState === 'open' &&
        !this.ports.scope().locked &&
        this.ports.scope().epoch === epoch
      )
        this.ports.send(message);
    });
  }

  private disconnectKeyboardLayout() {
    this.keyboardLayout.disconnect();
    this.keyboardChannel = undefined;
  }
  readonly touchInputStats = {
    queued: 0,
    merged: 0,
    dropped: 0,
    cancelled: 0,
    sourceGestures: 0,
    arrivalFallbackGestures: 0,
  };

  private queuedInput: QueuedInput[] = [];

  private inputDrainTimer?: ReturnType<typeof setTimeout>;

  private focusTimer?: ReturnType<typeof setTimeout>;
  private focusRetryTimer?: ReturnType<typeof setTimeout>;

  private inputFocus = new Map<string, { token: string; identity: string; focused: boolean }>();

  inputIdentity(surface: Surface) {
    const known = this.inputFocus.get(surface.id);
    return `${this.ports.attempt()}:${surface.session}:${surface.id}:${surface.instance}:${surface.document}:${this.ports.layout()?.generation}:${this.ports.layout()?.epoch}:${known?.token === surface.focus ? known.identity : surface.focus}`;
  }

  private inputResultListeners = new Set<(result: InputResult) => void>();

  private inputDeliveryListeners = new Set<(result: InputDelivery) => void>();

  private sentInput = new Map<string, InputRequest>();

  subscribeInputResults(listener: (result: InputResult) => void) {
    this.inputResultListeners.add(listener);
    return () => {
      this.inputResultListeners.delete(listener);
    };
  }

  subscribeInputDelivery(listener: (delivery: InputDelivery) => void) {
    this.inputDeliveryListeners.add(listener);
    return () => {
      this.inputDeliveryListeners.delete(listener);
    };
  }

  ensureInputFocus(surface: Surface) {
    const known = this.inputFocus.get(surface.id);
    if (known?.focused && known.token === surface.focus) return;
    this.focus(surface, true);
  }

  focusPointer(surface: Surface) {
    this.cancelPendingFocus(undefined, 'pointer-superseded');
    this.ensureInputFocus(surface);
  }

  touchStartWall(sampleAt: number) {
    return this.ports.inputStart(sampleAt);
  }

  private sequence = 0n;

  readonly inputTrace: Record<string, unknown>[] = [];

  readonly inputResults: Record<string, unknown>[] = [];

  private traceInput(
    phase: string,
    surface: Surface,
    event: Record<string, unknown>,
    reason?: string,
    sequence?: string,
  ) {
    this.inputTrace.push({
      at: performance.now(),
      phase,
      view: surface.id,
      eventType: event.type,
      action: event.action,
      reason,
      sequence,
      epoch: this.ports.layout()?.epoch,
      ...(event.type === 'touch' || event.type === 'gesture'
        ? {
            sourceClock: event.clockMode,
            sampleElapsedUs: event.sampleElapsedUs,
            touchSequenceId: event.sequenceId,
          }
        : {}),
    });
    if (this.inputTrace.length > 128) this.inputTrace.shift();
  }

  private focusSequence = 0n;

  private pendingFocus: {
    requestId: string;
    focused: boolean;
    view: string;
    session: string;
    token: string;
    instance: string;
    document: string;
    generation: string;
    epoch: string;
    events: QueuedInput[];
    retry: RetryUnit;
  } | null = null;

  flushFocusedInput() {
    const pending = this.pendingFocus;
    if (!pending || !this.ports.canInput(pending.view)) return;
    const surface = this.ports.layout()?.views.find((view) => view.id === pending.view);
    if (
      this.focusLease.phase !== 'granted' ||
      !surface ||
      surface.session !== pending.session ||
      surface.instance !== pending.instance ||
      surface.document !== pending.document ||
      this.ports.layout()?.generation !== pending.generation ||
      this.ports.layout()!.epoch !== pending.epoch
    )
      return;
    if (this.inputFocus.get(pending.view)?.token !== surface.focus) {
      this.cancelPendingFocus(pending.requestId);
      return;
    }
    this.pendingFocus?.retry.cancel();
    this.pendingFocus = null;
    if (!pending.focused) {
      this.focusLease = { phase: 'none' };
      this.notify();
      return;
    }
    for (const item of pending.events) this.queuedInput.push({ ...item, surface: { ...surface } });
    this.drainInput();
  }

  reportInputDelivery(
    request: InputRequest,
    phase: InputDelivery['phase'],
    sequence?: string,
    reason?: string,
  ) {
    if (request.event.type !== 'touch' && request.event.type !== 'gesture') return;
    const delivery = {
      phase,
      surface: request.surface,
      identity: request.identity,
      event: request.event,
      sequence,
      reason,
    };
    queueMicrotask(() => this.inputDeliveryListeners.forEach((listener) => listener(delivery)));
  }

  private discardQueuedInput(reason: string, staleOnly = false) {
    this.queuedInput = this.queuedInput.filter((item) => {
      if (staleOnly && this.queuedInputCurrent(item)) return true;
      this.touchInputStats.dropped++;
      this.reportInputDelivery(item, 'discarded', undefined, reason);
      return false;
    });
  }

  private queuedInputCurrent(item: QueuedInput) {
    if (isDismiss(item.event)) return item.surface;
    const current = this.ports.layout()?.views.find((view) => view.id === item.surface.id);
    if (
      current &&
      samePlane(current, item.surface) &&
      current.focus === item.surface.focus &&
      this.ports.layout()?.epoch === item.epoch &&
      this.ports.layout()?.generation === item.generation &&
      this.inputIdentity(current) === item.identity
    )
      return current;
  }

  private cancelPendingFocus(requestId = this.pendingFocus?.requestId, reason = 'focus-changed') {
    const pending = this.pendingFocus;
    if (!pending || pending.requestId !== requestId) return false;
    clearTimeout(this.focusTimer);
    clearTimeout(this.focusRetryTimer);
    this.focusTimer = undefined;
    this.focusRetryTimer = undefined;
    if (this.inputFocus.get(pending.view)?.identity === requestId) this.inputFocus.delete(pending.view);
    this.pendingFocus?.retry.cancel();
    this.pendingFocus = null;
    this.focusLease = { phase: 'none' };
    for (const item of pending.events) this.reportInputDelivery(item, 'discarded', undefined, reason);
    this.notify();
    return true;
  }

  private receiveInputResult(message: import('../rtc/protocol').InputResultMessage) {
    const sequence = String(message.clientSequence);
    const sent = this.sentInput.get(sequence);
    if (!sent) return;
    this.sentInput.delete(sequence);
    const ok = message.ok;
    const error = message.error ? endpointError(message.error) : undefined;
    for (const listener of this.inputResultListeners)
      listener({
        surface: sent.surface,
        identity: sent.identity,
        event: sent.event,
        sequence,
        ok,
        error,
      });
    if (!ok && error && errorHandling(error.code) !== 'canceled') this.ports.report({ error: error.message });
  }

  sendInput(surface: Surface, event: Record<string, unknown>) {
    if (this.ports.scope().locked || this.ports.scope().epoch === 0) return false;
    const terminalTouch =
      isDismiss(event) ||
      ((event.type === 'touch' || event.type === 'gesture') &&
        (event.action === 'cancel' || event.action === 'end' || event.action === 'momentumEnd'));
    if (
      this.ports.channel()?.readyState !== 'open' ||
      !this.ports.layout() ||
      (!terminalTouch && !this.ports.canInput(surface.id))
    ) {
      this.traceInput(
        'blocked',
        surface,
        event,
        this.ports.channel()?.readyState !== 'open' ? 'channel' : 'unmatched-or-unpainted-frame',
      );
      return false;
    }
    const current = isDismiss(event)
      ? surface
      : this.ports.layout()!.views.find((view) => view.id === surface.id);
    if (!current || (!isDismiss(event) && !samePlane(current, surface))) {
      this.traceInput('blocked', surface, event, 'stale-surface');
      return false;
    }
    const identity = this.inputIdentity(current);
    if (
      (event.type === 'touch' || event.type === 'gesture') &&
      event.inputIdentity !== undefined &&
      event.inputIdentity !== identity
    ) {
      this.touchInputStats.dropped++;
      return false;
    }
    const pending =
      this.pendingFocus?.view === surface.id && (!isDismiss(event) || this.pendingFocus.focused)
        ? this.pendingFocus
        : undefined;
    if (pending && !pending.focused && !isDismiss(event)) {
      this.traceInput('blocked', surface, event, 'blur-pending');
      return false;
    }
    if (event.type === 'touch') {
      if (event.action === 'start' && event.sampleElapsedUs === 0) {
        if (event.clockMode === 'source') this.touchInputStats.sourceGestures++;
        else this.touchInputStats.arrivalFallbackGestures++;
      }
      if (event.action === 'cancel') this.touchInputStats.cancelled++;
    }
    const queued: QueuedInput = {
      surface: { ...current },
      identity,
      event,
      epoch: this.ports.layout()!.epoch,
      generation: this.ports.layout()!.generation,
    };
    const queue = pending?.events ?? this.queuedInput;
    const previous = queue[queue.length - 1];
    const merged =
      previous?.identity === identity
        ? (mergeTouchMoves(previous.event, event) ?? mergeGestureMomentum(previous.event, event))
        : undefined;
    if (merged) {
      previous.event = merged;
      this.touchInputStats.merged++;
    } else {
      // Reserve queue space for terminal packets when ordinary admission is full.
      if (this.queuedInput.length + (this.pendingFocus?.events.length ?? 0) >= (terminalTouch ? 128 : 112)) {
        this.touchInputStats.dropped++;
        return false;
      }
      queue.push(queued);
      this.touchInputStats.queued++;
    }
    this.reportInputDelivery(queued, 'queued');
    if (!pending) this.drainInput();
    else this.notify();
    return true;
  }

  drainInput() {
    clearTimeout(this.inputDrainTimer);
    this.inputDrainTimer = undefined;
    const channel = this.ports.channel();
    if (
      channel?.readyState !== 'open' ||
      !this.ports.layout() ||
      this.ports.scope().locked ||
      this.ports.scope().epoch === 0
    )
      return;
    while (this.queuedInput.length && channel.bufferedAmount <= 256 * 1024) {
      const item = this.queuedInput[0],
        current = this.queuedInputCurrent(item);
      if (!current) {
        this.queuedInput.shift();
        this.touchInputStats.dropped++;
        this.reportInputDelivery(item, 'discarded', undefined, 'stale-input-identity');
        continue;
      }
      if (!isDismiss(item.event) && !this.ports.canInput(current.id)) break;
      this.queuedInput.shift();
      const sequence = this.nextSequence();
      try {
        const target = {
          view: current.id,
          session: current.session,
          instance: current.instance,
          document: current.document,
          focus: current.focus,
          outputGeneration: item.generation,
          layoutEpoch: item.epoch,
          sequence,
        };
        this.ports.send(
          item.event.type === 'editing.dismiss'
            ? {
                ...target,
                type: 'editing.dismiss',
                target: String(item.event.target),
                revision: String(item.event.revision),
              }
            : { ...target, type: 'input', event: item.event },
        );
      } catch {
        this.touchInputStats.dropped++;
        this.reportInputDelivery(item, 'discarded', undefined, 'channel-send-failed');
        if (item.event.type === 'touch') {
          this.queuedInput = this.queuedInput.filter((queued) => {
            if (
              queued.identity !== item.identity ||
              queued.event.sequenceId !== item.event.sequenceId ||
              (queued.event.type !== 'touch' && queued.event.type !== 'gesture')
            )
              return true;
            this.touchInputStats.dropped++;
            this.reportInputDelivery(queued, 'discarded', undefined, 'touch-send-failed');
            return false;
          });
        }
        break;
      }
      this.sentInput.set(sequence, item);
      while (this.sentInput.size > 256) this.sentInput.delete(this.sentInput.keys().next().value!);
      this.reportInputDelivery(item, 'submitted', sequence);
      this.traceInput('sent', current, item.event, undefined, sequence);
    }
    if (this.queuedInput.length) this.inputDrainTimer = setTimeout(() => this.drainInput(), 10);
    this.notify();
  }

  focus(surface: Surface, focused: boolean) {
    if (this.ports.scope().locked || this.ports.scope().epoch === 0) return;
    if (!focused) {
      this.ports.clearEditing();
      this.notify();
    }
    if (
      this.ports.channel()?.readyState !== 'open' ||
      !this.ports.layout() ||
      !this.ports.canInput(surface.id)
    )
      return;
    const current = this.ports.layout()!.views.find((view) => view.id === surface.id);
    if (!current || !samePlane(current, surface)) return;
    const pending = this.pendingFocus;
    if (
      pending &&
      pending.view === current.id &&
      pending.session === current.session &&
      pending.instance === current.instance &&
      pending.document === current.document &&
      pending.epoch === this.ports.layout()!.epoch &&
      pending.generation === this.ports.layout()!.generation &&
      pending.focused === focused
    )
      return;
    this.cancelPendingFocus();
    const requestId = `${this.ports.attempt()}:${++this.focusSequence}`;
    this.inputFocus.set(current.id, { token: current.focus, identity: requestId, focused });
    this.focusLease = { phase: 'requested', id: requestId, deadline: performance.now() + 2000 };
    this.pendingFocus = {
      requestId,
      focused,
      view: current.id,
      session: current.session,
      token: current.focus,
      instance: current.instance,
      document: current.document,
      generation: this.ports.layout()!.generation,
      epoch: this.ports.layout()!.epoch,
      events: [],
      retry: new RetryUnit({ busyBudget: 3, name: 'input.focus' }),
    };
    this.pendingFocus.retry.ready(requestId);
    this.discardQueuedInput('focus-changed', true);
    this.notify();
    this.sendPendingFocus();
  }

  private sendPendingFocus() {
    const pending = this.pendingFocus;
    if (!pending || !pending.retry.ready()) return;
    this.layoutChanged();
    if (
      this.pendingFocus !== pending ||
      this.ports.scope().locked ||
      this.ports.channel()?.readyState !== 'open'
    )
      return;
    clearTimeout(this.focusTimer);
    this.focusLease = { phase: 'requested', id: pending.requestId, deadline: performance.now() + 2000 };
    this.focusTimer = setTimeout(() => {
      if (this.pendingFocus === pending)
        this.handle({
          type: 'focus',
          focusRequestId: pending.requestId,
          layoutEpoch: pending.epoch,
          ok: false,
          error: { code: 'outcome_unknown', message: '远程焦点请求结果未知' },
        });
    }, 2000);
    try {
      this.ports.send({
        type: 'focus',
        focusRequestId: pending.requestId,
        view: pending.view,
        session: pending.session,
        instance: pending.instance,
        document: pending.document,
        focus: pending.token,
        layoutEpoch: pending.epoch,
        focused: pending.focused,
      });
    } catch (cause) {
      pending.retry.fail(new RemoteKitError('unavailable', '远程焦点请求未发送', { cause }));
      pending.retry.schedule(() => this.sendPendingFocus());
    }
  }

  handle(message: Incoming) {
    if (message.type === 'layout') this.layoutChanged();
    const channel = this.ports.channel()!;
    if (message.type === 'input.result' || message.type === 'focus') {
      if (message.type === 'input.result') this.receiveInputResult(message);
      this.inputResults.push({ ...message, at: performance.now() });
      if (this.inputResults.length > 128) this.inputResults.shift();
      if (message.type === 'focus' && this.ports.layout()) {
        const pending = this.pendingFocus,
          token = message.token;
        const view =
          pending &&
          this.ports
            .layout()!
            .views.find(
              (view) =>
                view.id === pending.view &&
                view.session === pending.session &&
                view.instance === pending.instance &&
                view.document === pending.document,
            );
        const matches =
          pending &&
          view &&
          message.focusRequestId === pending.requestId &&
          message.layoutEpoch === pending.epoch &&
          this.ports.layout()!.epoch === pending.epoch &&
          this.ports.layout()!.generation === pending.generation;
        if (matches && message.ok === false) {
          const error = endpointError(message.error);
          const { delay } = pending.retry.fail(error);
          if (delay !== undefined) {
            clearTimeout(this.focusTimer);
            if (error.code === 'conflict') {
              for (const item of pending.events)
                this.reportInputDelivery(item, 'discarded', undefined, 'focus-conflict');
              pending.events = [];
            }
            pending.retry.schedule(() => {
              if (this.pendingFocus !== pending) return;
              if (error.code === 'conflict') {
                const current = this.ports.layout()?.views.find((view) => view.id === pending.view);
                if (!current) {
                  this.cancelPendingFocus(pending.requestId);
                  return;
                }
                pending.requestId = `${this.ports.attempt()}:${++this.focusSequence}`;
                pending.token = current.focus;
                this.inputFocus.set(current.id, {
                  token: current.focus,
                  identity: pending.requestId,
                  focused: pending.focused,
                });
              }
              this.sendPendingFocus();
            });
          } else {
            this.cancelPendingFocus(pending.requestId, 'focus-rejected');
            if (errorHandling(error.code) !== 'canceled') this.ports.report({ error: error.message });
          }
        }
        if (
          matches &&
          message.ok &&
          token &&
          token.view === pending.view &&
          token.session === pending.session &&
          token.instance === pending.instance &&
          token.document === pending.document &&
          typeof token.focus === 'string'
        ) {
          clearTimeout(this.focusTimer);
          this.focusTimer = undefined;
          const focus = this.inputFocus.get(view.id);
          if (focus?.identity === pending.requestId) focus.token = token.focus;
          pending.retry.succeed();
          this.focusLease = { phase: 'granted', token: token.focus };
          this.ports.grantFocus(view.id, token.focus);
          this.ports.reconcileEditing(this.ports.layout()!.views);
          this.flushFocusedInput();
          this.notify();
        }
      }
    }
  }

  layoutChanged() {
    this.connectKeyboardLayout();
    const pending = this.pendingFocus;
    const surface = this.ports.layout()?.views.find((view) => view.id === pending?.view);
    if (
      pending &&
      (!surface ||
        surface.session !== pending.session ||
        surface.instance !== pending.instance ||
        surface.document !== pending.document ||
        this.ports.layout()?.generation !== pending.generation ||
        this.ports.layout()?.epoch !== pending.epoch)
    )
      this.cancelPendingFocus(pending.requestId);
    this.discardQueuedInput('layout-changed', true);
    this.flushFocusedInput();
    this.notify();
  }

  reset() {
    this.disconnectKeyboardLayout();
    clearTimeout(this.inputDrainTimer);
    this.inputDrainTimer = undefined;
    this.cancelPendingFocus(undefined, 'scope-changed');
    this.discardQueuedInput('scope-changed');
    this.inputFocus.clear();
    this.focusLease = { phase: 'none' };
    this.sentInput.clear();
    this.notify();
  }

  private notify() {
    this.snapshot = Object.freeze({
      focus: this.focusLease,
      queued: this.queuedInput.length + (this.pendingFocus?.events.length ?? 0),
      sent: this.sentInput.size,
    });
    this.listeners.forEach((listener) => listener());
  }

  private readonly listeners = new Set<() => void>();

  private snapshot: InputSnapshot = { focus: { phase: 'none' }, queued: 0, sent: 0 };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;
  onRtc = (event: import('../rtc/rtc-session').RtcEvent) => {
    if (event.type === 'closed') this.reset();
  };
  onChannel = (event: import('../rtc/endpoint-channel').ChannelEvent) => {
    if (event.type === 'bound' || event.type === 'closed') this.disconnectKeyboardLayout();
    if (event.type === 'open') this.connectKeyboardLayout();
    if (event.type === 'writable') this.drainInput();
  };
}
