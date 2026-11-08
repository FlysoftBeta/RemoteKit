import {
  ClientGestures,
  type GestureCandidate,
  type MomentumPacket,
  type MomentumPlan,
  type LongPressPacket,
} from './client-gestures';
export interface TouchPoint {
  id: number;
  x: number;
  y: number;
  pressure: number;
  width?: number;
  height?: number;
}
export interface TouchSample {
  sampleElapsedUs: number;
  points: TouchPoint[];
}
export interface TouchPacket extends Record<string, unknown> {
  type: 'touch';
  action: 'start' | 'move' | 'end' | 'cancel';
  points: TouchPoint[];
  sequenceId: string;
  clockMode: 'source' | 'arrival-fallback';
  sampleElapsedUs: number;
  startServerWallUs?: number;
  samples?: TouchSample[];
  gestureMode: 'client-v1';
  gestures: GestureCandidate[];
}
export const MAX_TOUCH_SAMPLES = 32;
/** Progress is cumulative: retaining the newest sample preserves all displacement. */
export function mergeGestureMomentum(
  before: Record<string, unknown>,
  next: Record<string, unknown>,
): MomentumPacket | undefined {
  if (
    before.type !== 'gesture' ||
    next.type !== 'gesture' ||
    before.gestureMode !== 'client-v1' ||
    next.gestureMode !== 'client-v1' ||
    before.action !== 'momentum' ||
    next.action !== 'momentum' ||
    before.sequenceId !== next.sequenceId ||
    before.inputIdentity !== next.inputIdentity ||
    Number(next.sampleElapsedUs) < Number(before.sampleElapsedUs)
  )
    return;
  return next as MomentumPacket;
}
/** Older DOM implementations can expose epoch timestamps; always normalize to performance's axis. */
export function pointerSampleTime(timestamp: number, now: number, timeOrigin: number): number | undefined {
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return;
  const value = timestamp > 1e12 ? timestamp - timeOrigin : timestamp;
  return Number.isFinite(value) && value >= 0 && value <= now + 1 && now - value <= 5000 ? value : undefined;
}
export function mergeTouchMoves(
  before: Record<string, unknown>,
  next: Record<string, unknown>,
): TouchPacket | undefined {
  if (
    before.type !== 'touch' ||
    next.type !== 'touch' ||
    before.action !== 'move' ||
    next.action !== 'move' ||
    before.sequenceId !== next.sequenceId ||
    before.clockMode !== next.clockMode ||
    before.startServerWallUs !== next.startServerWallUs
  )
    return;
  const a = before as TouchPacket,
    b = next as TouchPacket;
  // Preserve the recent velocity window and final position. Total displacement is
  // still represented by the jump from the last delivered point to this history.
  if (a.gestureMode !== b.gestureMode) return;
  const gestures = [...(a.gestures ?? []), ...(b.gestures ?? [])];
  if (gestures.length > 8) return;
  const samples = [
    ...(a.samples ?? []),
    { sampleElapsedUs: a.sampleElapsedUs, points: a.points },
    ...(b.samples ?? []),
  ].slice(-MAX_TOUCH_SAMPLES);
  return { ...b, samples, gestures };
}
/** One instance belongs to one viewport; identity includes focus and layout epochs. */
export class TouchInput {
  private active?: {
    identity: string;
    id: string;
    origin: number;
    elapsed: number;
    serverWall?: number;
    points: Map<number, TouchPoint>;
    clocks: Map<number, number>;
    terminal?: TouchPacket;
    recognizer: ClientGestures;
  };
  private serial = 0;
  private pendingMomentum?: MomentumPlan;
  takeMomentum() {
    const plan = this.pendingMomentum;
    this.pendingMomentum = undefined;
    return plan;
  }
  readonly stats = {
    sourceGestures: 0,
    arrivalFallbackGestures: 0,
    samples: 0,
    cancelled: 0,
    invalidClock: 0,
    skippedHistory: 0,
  };
  constructor(private readonly prefix = Math.random().toString(36).slice(2)) {}
  get contactIds() {
    return [...(this.active?.points.keys() ?? [])];
  }
  matches(identity: string) {
    return !this.active || this.active.identity === identity;
  }
  get longPressPending() {
    return !!this.active && !this.active.terminal && this.active.recognizer.longPressPending;
  }
  longPress(at: number): LongPressPacket | undefined {
    const state = this.active;
    if (!state || state.terminal) return;
    const elapsed = Math.max(state.elapsed, Math.round((at - state.origin) * 1000));
    const point = state.recognizer.longPress(elapsed);
    if (!point) return;
    return {
      type: 'gesture',
      gestureMode: 'client-v1',
      sequenceId: state.id,
      inputIdentity: state.identity,
      action: 'longPress',
      sampleElapsedUs: elapsed,
      ...point,
    };
  }
  private packet(action: TouchPacket['action'], points: TouchPoint[], elapsed: number): TouchPacket {
    const state = this.active!;
    return {
      type: 'touch',
      action,
      points,
      inputIdentity: state.identity,
      sequenceId: state.id,
      clockMode: state.serverWall === undefined ? 'arrival-fallback' : 'source',
      sampleElapsedUs: elapsed,
      gestureMode: 'client-v1',
      gestures: [],
      ...(state.serverWall === undefined ? {} : { startServerWallUs: state.serverWall }),
    };
  }
  cancel(): TouchPacket | undefined {
    if (!this.active) return;
    if (this.active.terminal?.action === 'cancel') return this.active.terminal;
    const packet = this.packet('cancel', [], this.active.elapsed);
    packet.gestures = this.active.recognizer.update('cancel', [], this.active.elapsed);
    this.pendingMomentum = undefined;
    this.active.terminal = packet;
    this.stats.cancelled++;
    return packet;
  }
  /** Release only after the transport has accepted the terminal into its queue. */
  accepted(packet: TouchPacket) {
    if (
      this.active?.id === packet.sequenceId &&
      (packet.action === 'cancel' || (packet.action === 'end' && !this.active.points.size))
    )
      this.active = undefined;
  }
  reset() {
    this.active = undefined;
    this.pendingMomentum = undefined;
  }
  sample(
    identity: string,
    action: Exclude<TouchPacket['action'], 'cancel'>,
    point: TouchPoint,
    capturedAt: number,
    serverStart?: number,
  ): TouchPacket | undefined {
    if (!Number.isFinite(capturedAt)) {
      this.stats.invalidClock++;
      return;
    }
    if (!this.active) {
      if (action !== 'start') return;
      this.active = {
        identity,
        id: `${this.prefix}:${++this.serial}`,
        origin: capturedAt,
        elapsed: 0,
        serverWall: serverStart,
        points: new Map(),
        clocks: new Map(),
        recognizer: new ClientGestures(),
      };
      this.pendingMomentum = undefined;
      if (serverStart === undefined) this.stats.arrivalFallbackGestures++;
      else this.stats.sourceGestures++;
    }
    const state = this.active;
    if (state.terminal) return;
    if (
      state.identity !== identity ||
      capturedAt < state.origin ||
      capturedAt < (state.clocks.get(point.id) ?? state.origin) ||
      capturedAt - state.origin > 86400000
    ) {
      this.stats.invalidClock++;
      return;
    }
    const exists = state.points.has(point.id);
    if ((action === 'start') === exists) return;
    if (action === 'start' && state.points.size >= 16) return;
    state.clocks.set(point.id, capturedAt);
    const elapsed = Math.round((capturedAt - state.origin) * 1000);
    // Coalesced histories are ordered per pointer, not across pointers. A history
    // older than the published wire watermark cannot be replayed; retain its
    // real source clock and wait for this pointer's current sample instead.
    if (elapsed < state.elapsed && action === 'move') {
      this.stats.skippedHistory++;
      return;
    }
    if (elapsed < state.elapsed) {
      this.stats.invalidClock++;
      return;
    }
    state.elapsed = elapsed;
    const packet = this.packet(action, [point], state.elapsed);
    packet.gestures = state.recognizer.update(action, [point], elapsed);
    this.pendingMomentum = state.recognizer.momentum;
    this.stats.samples++;
    if (action === 'end') state.points.delete(point.id);
    else state.points.set(point.id, point);
    if (!state.points.size) state.terminal = packet;
    return packet;
  }
}
