import type { PresentationSession } from '../presentation/presentation-session';
import type { Surface } from '../presentation/types';
import { Store } from '../util/store';
import { momentumPosition, type MomentumPacket, type MomentumPlan } from './client-gestures';
import type { InputPipeline } from './input-pipeline';
import { TouchInput, type TouchPacket, type TouchPoint } from './touch-input';
import type { InputDelivery, InputResult } from './types';

interface TouchOwner {
  surface: Surface;
  identity: string;
  packet: TouchPacket;
}
export type TouchOwnerState = { phase: 'idle' | 'released' } | { phase: 'active'; sequenceId: string };
export interface TouchViewPorts {
  input: Pick<
    InputPipeline,
    'inputIdentity' | 'sendInput' | 'subscribeInputResults' | 'subscribeInputDelivery' | 'touchStartWall'
  >;
  presentation: Pick<PresentationSession, 'layout'>;
}
export class TouchView extends Store<TouchOwnerState> {
  private touchOwner?: TouchOwner;
  private momentumOwner?: {
    surface: Surface;
    identity: string;
    origin: number;
    frame?: number;
    packet: MomentumPacket;
  };
  private readonly touches = new TouchInput();
  private readonly unsubscribe: (() => void)[];
  private detached = false;
  get isDetached() {
    return this.detached;
  }
  constructor(
    private readonly ports: TouchViewPorts,
    readonly viewId: string,
    private readonly canvas: HTMLCanvasElement,
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
  dispose() {
    this.detached = true;
    this.cancelTouches();
    this.unsubscribe.forEach((remove) => remove());
    this.publish({ phase: 'released' });
  }
  reset() {
    this.stopMomentum();
    this.clearTouchOwner();
  }
  sample(action: 'start' | 'move' | 'end', point: TouchPoint, at: number) {
    if (this.detached) return false;
    this.syncTouchOwner();
    const surface = this.surface;
    if (!surface) return false;
    if (action === 'start') this.stopMomentum();
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
    this.touchOwner ??= { surface: { ...surface }, identity, packet };
    if (!this.ports.input.sendInput(surface, packet)) {
      this.cancelTouches();
      return false;
    }
    this.touchOwner.packet = packet;
    const terminal = action === 'end' && this.touches.contactIds.length === 0;
    const plan = this.touches.takeMomentum();
    this.touches.accepted(packet);
    if (terminal) {
      this.clearTouchOwner();
      if (plan) this.startMomentum(packet, at - packet.sampleElapsedUs / 1000, plan);
    } else {
      this.publish({ phase: 'active', sequenceId: packet.sequenceId });
    }
    return true;
  }
  stopMomentum = () => {
    const owner = this.momentumOwner;
    if (!owner) return;
    if (owner.frame !== undefined) cancelAnimationFrame(owner.frame);
    const current = this.ports.presentation.layout?.views.find((view) => view.id === owner.surface.id);
    if (!current || this.ports.input.inputIdentity(current) !== owner.identity) {
      this.momentumOwner = undefined;
      return;
    }
    this.ports.input.sendInput(current, { ...owner.packet, action: 'cancel' });
    // Browser orders a new down after pending momentum and expires a stale
    // momentum owner. Local animation must stop even if its cancel was blocked.
    this.momentumOwner = undefined;
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
  private releaseTouchCaptures(ids: number[]) {
    for (const id of ids) if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
  }
  private clearTouchOwner() {
    const ids = this.touches.contactIds;
    this.touchOwner = undefined;
    this.touches.reset();
    this.releaseTouchCaptures(ids);
    this.publish({ phase: 'released' });
  }
  cancelTouches = () => {
    this.stopMomentum();
    const owner = this.touchOwner;
    if (!owner) return;
    const current = this.surface;
    const cancelled = this.touches.cancel();
    if (cancelled && current && this.ports.input.inputIdentity(current) === owner.identity)
      this.ports.input.sendInput(current, cancelled);
    this.clearTouchOwner();
  };
  syncTouchOwner = () => {
    const current = this.surface;
    const identity = current && this.ports.input.inputIdentity(current);
    if (this.touchOwner && this.touchOwner.identity !== identity) this.clearTouchOwner();
    if (this.momentumOwner && this.momentumOwner.identity !== identity) this.stopMomentum();
  };
  private result = (result: InputResult) => {
    if (result.ok) return;
    if (
      this.momentumOwner?.identity === result.identity &&
      result.event.sequenceId === this.momentumOwner.packet.sequenceId
    )
      this.stopMomentum();
    const owner = this.touchOwner;
    if (
      owner &&
      result.identity === owner.identity &&
      result.event.type === 'touch' &&
      result.event.sequenceId === owner.packet.sequenceId
    )
      this.cancelTouches();
  };
  private delivery = (delivery: InputDelivery) => {
    const owner = this.touchOwner;
    if (
      owner &&
      delivery.phase === 'discarded' &&
      delivery.identity === owner.identity &&
      delivery.event.type === 'touch' &&
      delivery.event.sequenceId === owner.packet.sequenceId
    ) {
      this.syncTouchOwner();
      this.cancelTouches();
    }
  };
}
