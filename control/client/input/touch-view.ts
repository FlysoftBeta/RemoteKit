import type { PresentationSession } from '../presentation/presentation-session';
import type { Surface } from '../presentation/types';
import { Store } from '../util/store';
import { momentumPosition, type MomentumPacket, type MomentumPlan } from './client-gestures';
import type { InputPipeline } from './input-pipeline';
import { TouchInput, type TouchPacket, type TouchPoint } from './touch-input';
import type { TouchSession } from './touch-session';
import { touchTerminalResult, type TouchOwner } from './touch-terminal';
import type { InputDelivery, InputResult, TouchRetireLease } from './types';
interface ViewportTouchOwner extends TouchOwner {
  start: TouchPacket;
  submissions: number;
  lease?: TouchRetireLease;
  retiring?: boolean;
  cleanupAttempts: number;
  state: TouchPhase;
}
const touchCleanupDelays = [100, 250, 500];
export type TouchPhase =
  | { phase: 'active' }
  | { phase: 'terminalQueued' }
  | { phase: 'submitted' }
  | { phase: 'awaitingProof'; proof: 'accepted-pending' | 'unconfirmed' | 'cleanup' };
export function transitionTouchOwner(
  _state: TouchPhase,
  event: 'queued' | 'submitted' | 'accepted-pending' | 'unconfirmed' | 'cleanup',
): TouchPhase {
  return event === 'queued'
    ? { phase: 'terminalQueued' }
    : event === 'submitted'
      ? { phase: 'submitted' }
      : { phase: 'awaitingProof', proof: event };
}
function terminalState(owner: ViewportTouchOwner) {
  return owner.state.phase === 'active'
    ? undefined
    : owner.state.phase === 'terminalQueued'
      ? 'queued'
      : owner.state.phase === 'submitted'
        ? 'submitted'
        : owner.state.proof;
}
export type TouchOwnerState =
  | { phase: 'idle' | 'released' }
  | {
      phase: 'active' | 'terminalQueued' | 'submitted' | 'awaitingProof';
      sequenceId: string;
      notice?: 'confirming' | 'unconfirmed' | 'cleanup';
    };
export interface TouchViewPorts {
  input: Pick<
    InputPipeline,
    'inputIdentity' | 'sendInput' | 'subscribeInputResults' | 'subscribeInputDelivery' | 'touchStartWall'
  >;
  presentation: Pick<PresentationSession, 'layout'>;
  touch: Pick<TouchSession, 'touchRetirementCurrent' | 'retireTouch' | 'retryTouchTerminal'>;
}
export class TouchView extends Store<TouchOwnerState> {
  private touchOwner?: ViewportTouchOwner;
  private momentumOwner?: {
    surface: Surface;
    identity: string;
    origin: number;
    frame?: number;
    packet: MomentumPacket;
  };
  private cancelTimer?: ReturnType<typeof setTimeout>;
  private readonly touches = new TouchInput();
  private readonly unsubscribe: (() => void)[];
  private detached = false;
  get isDetached() {
    return this.detached;
  }
  constructor(
    private readonly ports: TouchViewPorts,
    readonly viewId: string,
    private canvas: HTMLCanvasElement,
  ) {
    super({ phase: 'idle' });
    this.unsubscribe = [
      ports.input.subscribeInputResults(this.result),
      ports.input.subscribeInputDelivery(this.delivery),
    ];
  }
  get surface() {
    return this.ports.presentation.layout?.views.find((view) => view.id === this.viewId);
  }
  get contactIds() {
    return this.touches.contactIds;
  }
  private setNotice(notice?: 'confirming' | 'unconfirmed' | 'cleanup') {
    const owner = this.touchOwner;
    if (!owner) {
      this.publish({ phase: 'released' });
      if (this.detached) this.unsubscribe.forEach((remove) => remove());
      return;
    }
    const phase = owner.state.phase;
    this.publish({
      phase,
      sequenceId: owner.packet.sequenceId,
      notice:
        notice ??
        (owner.state.phase === 'awaitingProof' && owner.state.proof !== 'accepted-pending'
          ? owner.state.proof
          : undefined),
    });
  }
  retryProof = () => {
    const owner = this.touchOwner;
    if (owner && this.ports.touch.retryTouchTerminal(owner.identity, owner.packet.sequenceId))
      this.setNotice('confirming');
  };
  retryEnd = () => {
    if (this.touchOwner) this.touchOwner.state = transitionTouchOwner(this.touchOwner.state, 'cleanup');
    this.cancelTouches();
  };
  dispose() {
    this.detached = true;
    this.cancelTouches();
    if (!this.touchOwner) {
      this.unsubscribe.forEach((remove) => remove());
      this.publish({ phase: 'released' });
    }
  }
  reset() {
    const owner = this.touchOwner;
    if (owner) this.clearTouchOwner(owner, true);
    this.stopMomentum();
    clearTimeout(this.cancelTimer);
  }
  sample(action: 'start' | 'move' | 'end', point: TouchPoint, at: number) {
    this.syncTouchOwner();
    const surface = this.surface;
    if (
      !surface ||
      (action === 'start' && ((this.touchOwner && terminalState(this.touchOwner)) || !this.stopMomentum()))
    )
      return false;
    const identity = this.ports.input.inputIdentity(surface);
    if (!this.touches.matches(identity)) {
      this.cancelTouches();
      return false;
    }
    const invalid = this.touches.stats.invalidClock;
    const packet = this.touches.sample(
      identity,
      action,
      point,
      at,
      action === 'start' ? this.ports.input.touchStartWall(at) : undefined,
    );
    if (!packet) {
      if (invalid !== this.touches.stats.invalidClock) this.cancelTouches();
      return false;
    }
    const existing = this.touchOwner;
    const owner: ViewportTouchOwner = existing ?? {
      surface: { ...surface },
      identity,
      start: packet,
      packet,
      submissions: 0,
      cleanupAttempts: 0,
      state: { phase: 'active' },
    };
    this.touchOwner = owner;
    const terminal = packet.action === 'end' && this.touches.contactIds.length === 0;
    if (
      !this.ports.input.sendInput(
        surface,
        packet,
        packet.action === 'end' ? { touchTerminal: terminal } : undefined,
      )
    ) {
      if (existing) this.cancelTouches();
      else this.clearTouchOwner(owner, true);
      return false;
    }
    owner.packet = packet;
    const plan = this.touches.takeMomentum();
    this.touches.accepted(packet);
    if (terminal) {
      owner.state = transitionTouchOwner(owner.state, 'queued');
      if (plan) this.startMomentum(packet, at - packet.sampleElapsedUs / 1000, plan);
    }
    this.setNotice();
    return true;
  }
  stopMomentum = () => {
    const owner = this.momentumOwner;
    if (!owner) return true;
    if (owner.frame !== undefined) cancelAnimationFrame(owner.frame);
    const current = this.ports.presentation.layout?.views.find((view) => view.id === owner.surface.id);
    if (!current || this.ports.input.inputIdentity(current) !== owner.identity) {
      this.momentumOwner = undefined;
      return true;
    }
    const accepted = this.ports.input.sendInput(current, { ...owner.packet, action: 'cancel' });
    // Browser orders a new down after pending momentum and expires a stale
    // momentum owner. Local animation must stop even if its cancel was blocked.
    this.momentumOwner = undefined;
    return accepted;
  };
  startMomentum = (packet: TouchPacket, origin: number, plan: MomentumPlan) => {
    if (!this.surface) return;
    const owner = {
      surface: { ...this.surface },
      identity: String(packet.inputIdentity),
      origin,
      frame: undefined as number | undefined,
      packet: {
        type: 'gesture',
        gestureMode: 'client-v1',
        sequenceId: packet.sequenceId,
        inputIdentity: packet.inputIdentity,
        action: 'momentum',
        sampleElapsedUs: plan.startElapsedUs,
        cumulativeX: 0,
        cumulativeY: 0,
      } as MomentumPacket,
    };
    this.momentumOwner = owner;
    const tick = () => {
      if (this.momentumOwner !== owner) return;
      const current = this.ports.presentation.layout?.views.find((view) => view.id === owner.surface.id);
      if (!current || this.ports.input.inputIdentity(current) !== owner.identity || document.hidden) {
        this.stopMomentum();
        return;
      }
      const position = momentumPosition(plan, Math.round((performance.now() - origin) * 1000));
      owner.packet = {
        ...owner.packet,
        action: position.done ? 'momentumEnd' : 'momentum',
        sampleElapsedUs: Math.round(position.sampleElapsedUs),
        cumulativeX: position.cumulativeX,
        cumulativeY: position.cumulativeY,
      };
      if (!this.ports.input.sendInput(current, owner.packet)) {
        this.stopMomentum();
        return;
      }
      if (position.done) this.momentumOwner = undefined;
      else owner.frame = requestAnimationFrame(tick);
    };
    owner.frame = requestAnimationFrame(tick);
  };
  releaseTouchCaptures = (ids: number[]) => {
    for (const id of ids) if (this.canvas?.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
  };
  clearTouchOwner = (owner: ViewportTouchOwner, stopAnimation: boolean) => {
    if (this.touchOwner !== owner) return;
    const ids = this.touches.contactIds;
    clearTimeout(this.cancelTimer);
    this.touchOwner = undefined;
    this.touches.reset();
    const momentum = this.momentumOwner;
    if (
      stopAnimation &&
      momentum?.identity === owner.identity &&
      momentum.packet.sequenceId === owner.packet.sequenceId
    ) {
      if (momentum.frame !== undefined) cancelAnimationFrame(momentum.frame);
      this.momentumOwner = undefined;
    }
    this.setNotice(undefined);
    this.releaseTouchCaptures(ids);
  };
  scheduleTouchCleanup = (owner: ViewportTouchOwner, notice: 'cleanup' | 'unconfirmed') => {
    clearTimeout(this.cancelTimer);
    const delay = touchCleanupDelays[owner.cleanupAttempts];
    if (delay === undefined) {
      this.setNotice(notice);
      return;
    }
    ++owner.cleanupAttempts;
    const packet = owner.packet;
    this.cancelTimer = setTimeout(() => {
      if (this.touchOwner !== owner || owner.packet !== packet) return;
      owner.state = transitionTouchOwner(owner.state, 'cleanup');
      this.cancelTouches();
    }, delay);
  };
  cancelTouches = () => {
    this.stopMomentum();
    const owner = this.touchOwner;
    if (!owner) return;
    const current = this.ports.presentation.layout?.views.find((view) => view.id === owner.surface.id);
    const retirement = owner.retiring ? owner.lease : undefined;
    if (
      retirement
        ? !this.ports.touch.touchRetirementCurrent(retirement)
        : !current || this.ports.input.inputIdentity(current) !== owner.identity
    ) {
      this.clearTouchOwner(owner, true);
      return;
    }
    if (terminalState(owner) && terminalState(owner) !== 'cleanup') return;
    const ids = this.touches.contactIds;
    const cancelled = this.touches.cancel() ?? {
      ...owner.packet,
      action: 'cancel' as const,
      points: [],
      samples: undefined,
      gestures: [],
    };
    owner.packet = cancelled;
    owner.state = transitionTouchOwner(owner.state, 'cleanup');
    clearTimeout(this.cancelTimer);
    const started = performance.now();
    const retry = () => {
      if (this.touchOwner !== owner || terminalState(owner) !== 'cleanup') return;
      const view = this.ports.presentation.layout?.views.find((view) => view.id === owner.surface.id);
      if (
        retirement
          ? !this.ports.touch.touchRetirementCurrent(retirement)
          : !view || this.ports.input.inputIdentity(view) !== owner.identity
      ) {
        this.clearTouchOwner(owner, true);
        return;
      }
      if (
        retirement
          ? this.ports.touch.retireTouch(retirement, cancelled)
          : this.ports.input.sendInput(view!, cancelled)
      ) {
        owner.state = transitionTouchOwner(owner.state, retirement ? 'submitted' : 'queued');
        this.touches.accepted(cancelled);
        this.setNotice(undefined);
        return;
      }
      if (performance.now() - started < 250) this.cancelTimer = setTimeout(retry, 10);
      else this.scheduleTouchCleanup(owner, 'cleanup');
    };
    retry();
    this.releaseTouchCaptures(ids);
  };
  syncTouchOwner = () => {
    const current = this.ports.presentation.layout?.views.find((view) => view.id === this.viewId);
    const identity = current && this.ports.input.inputIdentity(current);
    const owner = this.touchOwner;
    if (owner && owner.identity !== identity) {
      const lease = owner.lease;
      if (
        lease &&
        this.ports.presentation.layout &&
        this.ports.presentation.layout.epoch !== lease.layoutEpoch &&
        this.ports.touch.touchRetirementCurrent(lease)
      ) {
        if (!owner.retiring) {
          owner.retiring = true;
          owner.state = transitionTouchOwner(owner.state, 'cleanup');
          owner.cleanupAttempts = 0;
          this.cancelTouches();
        }
      } else this.clearTouchOwner(owner, true);
    }
    const momentum = this.momentumOwner;
    if (momentum && momentum.identity !== identity) {
      if (momentum.frame !== undefined) cancelAnimationFrame(momentum.frame);
      this.momentumOwner = undefined;
    }
  };
  private result = (result: InputResult) => {
    const momentum = this.momentumOwner;
    if (
      momentum?.identity === result.identity &&
      result.event.type === 'gesture' &&
      result.event.sequenceId === momentum.packet.sequenceId &&
      !result.ok
    )
      this.stopMomentum();
    const owner = this.touchOwner;
    if (
      !owner ||
      result.identity !== owner.identity ||
      result.event.type !== 'touch' ||
      result.event.sequenceId !== owner.packet.sequenceId
    )
      return;
    const current = this.ports.presentation.layout?.views.find((view) => view.id === owner.surface.id);
    const identity =
      owner.retiring && owner.lease && this.ports.touch.touchRetirementCurrent(owner.lease)
        ? owner.identity
        : current && this.ports.input.inputIdentity(current);
    if (identity !== owner.identity) return;
    const terminal = touchTerminalResult(owner, result, identity, this.touches.contactIds.length);
    if (terminal) {
      this.clearTouchOwner(owner, terminal === 'invalidated');
      return;
    }
    if (result.event === owner.packet && terminalState(owner)) {
      if (result.touchState === 'accepted-pending' && terminalState(owner) !== 'unconfirmed') {
        owner.state = transitionTouchOwner(owner.state, 'accepted-pending');
        this.setNotice();
      }
      if (result.touchState === 'rejected') {
        owner.state = transitionTouchOwner(owner.state, 'cleanup');
        if (result.event.action === 'cancel') this.scheduleTouchCleanup(owner, 'cleanup');
        else this.cancelTouches();
      }
      return;
    }
    if (!result.ok && !terminalState(owner)) this.cancelTouches();
  };
  private delivery = (delivery: InputDelivery) => {
    const owner = this.touchOwner;
    if (
      !owner ||
      delivery.event.type !== 'touch' ||
      delivery.identity !== owner.identity ||
      delivery.event.sequenceId !== owner.packet.sequenceId
    )
      return;
    if (delivery.phase === 'submitted') {
      ++owner.submissions;
      if (delivery.layoutEpoch && delivery.event.gestureMode === 'client-v1') {
        owner.surface = delivery.surface;
        owner.lease = {
          surface: delivery.surface,
          identity: delivery.identity,
          layoutEpoch: delivery.layoutEpoch,
          authorization: delivery.authorization,
        };
      }
      if (delivery.event === owner.packet && terminalState(owner) === 'queued')
        owner.state = transitionTouchOwner(owner.state, 'submitted');
      this.setNotice();
    }
    if (delivery.phase === 'discarded') {
      this.syncTouchOwner();
      if (this.touchOwner !== owner || owner.retiring) return;
      if (!owner.submissions && delivery.event.action === 'start') {
        this.clearTouchOwner(owner, true);
        return;
      }
      if (delivery.event === owner.packet && terminalState(owner) === 'queued') {
        owner.state = transitionTouchOwner(owner.state, 'cleanup');
        if (delivery.event.action === 'cancel') {
          this.scheduleTouchCleanup(owner, 'cleanup');
          return;
        }
      }
      if (!terminalState(owner) || terminalState(owner) === 'cleanup') this.cancelTouches();
    }
    if (delivery.phase === 'unconfirmed' && delivery.event === owner.packet && terminalState(owner)) {
      owner.state = transitionTouchOwner(owner.state, 'unconfirmed');
      this.setNotice('unconfirmed');
      this.scheduleTouchCleanup(owner, 'unconfirmed');
    }
  };
}
