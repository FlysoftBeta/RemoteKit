export interface TouchPoint { id: number; x: number; y: number; pressure: number }
export interface TouchSample { sampleElapsedUs: number; points: TouchPoint[] }
export interface TouchPacket extends Record<string, unknown> {
  type: 'touch'; action: 'start' | 'move' | 'end' | 'cancel'; points: TouchPoint[];
  sequenceId: string; clockMode: 'source' | 'arrival-fallback'; sampleElapsedUs: number;
  startServerWallUs?: number; samples?: TouchSample[];
}
export const MAX_TOUCH_SAMPLES = 32;
/** Older DOM implementations can expose epoch timestamps; always normalize to performance's axis. */
export function pointerSampleTime(timestamp: number, now: number, timeOrigin: number): number | undefined {
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return;
  const value = timestamp > 1e12 ? timestamp - timeOrigin : timestamp;
  return Number.isFinite(value) && value >= 0 && value <= now + 1 && now - value <= 5000 ? value : undefined;
}
export function mergeTouchMoves(before: Record<string, unknown>, next: Record<string, unknown>): TouchPacket | undefined {
  if (before.type !== 'touch' || next.type !== 'touch' || before.action !== 'move' || next.action !== 'move' || before.sequenceId !== next.sequenceId || before.clockMode !== next.clockMode || before.startServerWallUs !== next.startServerWallUs) return;
  const a = before as TouchPacket, b = next as TouchPacket;
  // Preserve the recent velocity window and final position. Total displacement is
  // still represented by the jump from the last delivered point to this history.
  const samples = [...(a.samples ?? []), { sampleElapsedUs: a.sampleElapsedUs, points: a.points }, ...(b.samples ?? [])].slice(-MAX_TOUCH_SAMPLES);
  return { ...b, samples };
}
/** One instance belongs to one viewport; identity includes focus and layout epochs. */
export class TouchInput {
  private active?: { identity: string; id: string; origin: number; elapsed: number; serverWall?: number; points: Map<number, TouchPoint> };
  private serial = 0;
  readonly stats = { sourceGestures: 0, arrivalFallbackGestures: 0, samples: 0, cancelled: 0, invalidClock: 0 };
  constructor(private readonly prefix = Math.random().toString(36).slice(2)) {}
  get contactIds() { return [...(this.active?.points.keys() ?? [])]; }
  matches(identity: string) { return !this.active || this.active.identity === identity; }
  private packet(action: TouchPacket['action'], points: TouchPoint[], elapsed: number): TouchPacket {
    const state = this.active!;
    return { type: 'touch', action, points, inputIdentity: state.identity, sequenceId: state.id, clockMode: state.serverWall === undefined ? 'arrival-fallback' : 'source', sampleElapsedUs: elapsed, ...(state.serverWall === undefined ? {} : { startServerWallUs: state.serverWall }) };
  }
  cancel(): TouchPacket | undefined {
    if (!this.active) return;
    const packet = this.packet('cancel', [], this.active.elapsed);
    this.active = undefined; this.stats.cancelled++; return packet;
  }
  reset() { this.active = undefined; }
  sample(identity: string, action: Exclude<TouchPacket['action'], 'cancel'>, point: TouchPoint, capturedAt: number, serverStart?: number): TouchPacket | undefined {
    if (!Number.isFinite(capturedAt)) { this.stats.invalidClock++; return; }
    if (!this.active) {
      if (action !== 'start') return;
      this.active = { identity, id: `${this.prefix}:${++this.serial}`, origin: capturedAt, elapsed: 0, serverWall: serverStart, points: new Map() };
      if (serverStart === undefined) this.stats.arrivalFallbackGestures++; else this.stats.sourceGestures++;
    }
    const state = this.active;
    if (state.identity !== identity || capturedAt < state.origin || Math.round((capturedAt - state.origin) * 1000) < state.elapsed) { this.stats.invalidClock++; return; }
    const exists = state.points.has(point.id);
    if ((action === 'start') === exists) return;
    if (action === 'start' && state.points.size >= 16) return;
    state.elapsed = Math.round((capturedAt - state.origin) * 1000);
    const packet = this.packet(action, [point], state.elapsed);
    this.stats.samples++;
    if (action === 'end') state.points.delete(point.id); else state.points.set(point.id, point);
    if (!state.points.size) this.active = undefined;
    return packet;
  }
}
