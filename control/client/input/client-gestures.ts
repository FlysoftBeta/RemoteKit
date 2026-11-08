import type { TouchPoint } from './touch-input';

export type GestureType =
  | 'tapDown'
  | 'tapCancel'
  | 'tap'
  | 'longTap'
  | 'scrollBegin'
  | 'scrollUpdate'
  | 'scrollEnd'
  | 'pinchBegin'
  | 'pinchUpdate'
  | 'pinchEnd'
  | 'flingStart'
  | 'flingCancel';
export interface GestureCandidate {
  type: GestureType;
  x: number;
  y: number;
  deltaX?: number;
  deltaY?: number;
  scale?: number;
  velocityX?: number;
  velocityY?: number;
}
export const GESTURE_SLOP_DIP = 8;
export const PINCH_SLOP_DIP = 8;
export const TAP_MAX_US = 500000;
export const LONG_PRESS_US = 500000;
export const VELOCITY_WINDOW_US = 100000;
export const FLING_MIN_VELOCITY = 50;
export const FLING_MAX_VELOCITY = 8000;
export const MOMENTUM_DECAY = 4.2;
export const MOMENTUM_MAX_US = 2000000;
export interface MomentumPlan {
  startElapsedUs: number;
  velocityX: number;
  velocityY: number;
}
export interface MomentumPacket extends Record<string, unknown> {
  type: 'gesture';
  gestureMode: 'client-v1';
  sequenceId: string;
  action: 'momentum' | 'momentumEnd' | 'cancel';
  sampleElapsedUs: number;
  cumulativeX: number;
  cumulativeY: number;
}
export interface LongPressPacket extends Record<string, unknown> {
  type: 'gesture';
  gestureMode: 'client-v1';
  sequenceId: string;
  action: 'longPress';
  sampleElapsedUs: number;
  x: number;
  y: number;
}

/** Analytic integral; dropped/late animation frames do not change the curve. */
export function momentumPosition(plan: MomentumPlan, elapsedUs: number) {
  const durationUs = Math.min(
    MOMENTUM_MAX_US,
    Math.max(
      0,
      (Math.log(Math.max(FLING_MIN_VELOCITY, Math.hypot(plan.velocityX, plan.velocityY)) / 5) /
        MOMENTUM_DECAY) *
        1e6,
    ),
  );
  const time = Math.min(durationUs, Math.max(0, elapsedUs - plan.startElapsedUs));
  const integral = -Math.expm1((-MOMENTUM_DECAY * time) / 1e6) / MOMENTUM_DECAY;
  return {
    cumulativeX: plan.velocityX * integral,
    cumulativeY: plan.velocityY * integral,
    sampleElapsedUs: plan.startElapsedUs + time,
    done: elapsedUs >= plan.startElapsedUs + durationUs,
  };
}

/** Source-time recognition only. Browser retains all preventDefault/touch-action decisions. */
export class ClientGestures {
  private points = new Map<number, TouchPoint>();
  private origin?: { x: number; y: number };
  private previous?: { x: number; y: number; span: number };
  private scrolling = false;
  private pinching = false;
  private tap = true;
  private longPressed = false;
  private spanOrigin = 0;
  private history: { t: number; x: number; y: number }[] = [];
  private travel = { x: 0, y: 0 };
  momentum?: MomentumPlan;
  get longPressPending() {
    return this.tap && !this.longPressed && this.points.size === 1;
  }
  longPress(elapsedUs: number) {
    if (!this.longPressPending || elapsedUs < LONG_PRESS_US) return;
    this.longPressed = true;
    const point = this.points.values().next().value!;
    return { x: point.x, y: point.y };
  }
  update(
    action: 'start' | 'move' | 'end' | 'cancel',
    changed: TouchPoint[],
    elapsedUs: number,
  ): GestureCandidate[] {
    const result: GestureCandidate[] = [];
    const emit = (type: GestureType, center = this.previous ?? this.origin ?? { x: 0, y: 0 }, extra = {}) =>
      result.push({ type, x: center.x, y: center.y, ...extra });
    if (action === 'cancel') {
      if (this.tap && !this.longPressed) emit('tapCancel');
      if (this.pinching) emit('pinchEnd');
      if (this.scrolling) emit('scrollEnd');
      this.points.clear();
      this.momentum = undefined;
      return result;
    }
    const beforeCount = this.points.size;
    for (const p of changed) this.points.set(p.id, { ...p });
    const values = [...this.points.values()];
    const center = {
      x: values.reduce((s, p) => s + p.x, 0) / values.length,
      y: values.reduce((s, p) => s + p.y, 0) / values.length,
      span: 0,
    };
    center.span =
      2 *
      Math.sqrt(
        values.reduce((s, p) => s + (p.x - center.x) ** 2 + (p.y - center.y) ** 2, 0) / values.length,
      );
    if (!this.origin) {
      this.origin = center;
      emit('tapDown', center);
    }
    if (this.longPressed) {
      this.previous = center;
      if (action === 'end') {
        for (const p of changed) this.points.delete(p.id);
        if (!this.points.size) emit('longTap', center);
      }
      return result;
    }
    if (action === 'start' && beforeCount) {
      if (this.tap) {
        emit('tapCancel', center);
        this.tap = false;
      }
      this.spanOrigin = center.span;
      if (!this.scrolling) this.origin = center;
      // Contact-set changes must not become artificial translation/velocity.
      this.previous = center;
      this.history = [{ t: elapsedUs, ...this.travel }];
    }
    const previous = this.previous ?? center;
    const dx = center.x - previous.x,
      dy = center.y - previous.y;
    this.travel.x += dx;
    this.travel.y += dy;
    this.history.push({ t: elapsedUs, ...this.travel });
    this.history = this.history.filter((p) => p.t >= elapsedUs - VELOCITY_WINDOW_US).slice(-64);
    const displacement = Math.hypot(center.x - this.origin.x, center.y - this.origin.y);
    const pinchStart = values.length >= 2 && Math.abs(center.span - this.spanOrigin) > PINCH_SLOP_DIP;
    if (!this.scrolling && (displacement > GESTURE_SLOP_DIP || pinchStart)) {
      if (this.tap) {
        emit('tapCancel', center);
        this.tap = false;
      }
      emit('scrollBegin', center, { deltaX: center.x - this.origin.x, deltaY: center.y - this.origin.y });
      // Include the distance accumulated below slop exactly once.
      emit('scrollUpdate', center, { deltaX: center.x - this.origin.x, deltaY: center.y - this.origin.y });
      this.scrolling = true;
    }
    if (pinchStart && !this.pinching) {
      emit('pinchBegin', center);
      this.pinching = true;
    }
    if (this.scrolling && !result.some((g) => g.type === 'scrollBegin') && (dx || dy))
      emit('scrollUpdate', center, { deltaX: dx, deltaY: dy });
    if (this.pinching && previous.span > 0 && center.span > 0 && center.span !== previous.span)
      emit('pinchUpdate', center, {
        scale: center.span / (result.some((g) => g.type === 'pinchBegin') ? this.spanOrigin : previous.span),
      });
    this.previous = center;
    if (action === 'end') {
      for (const p of changed) this.points.delete(p.id);
      if (this.points.size < 2 && this.pinching) {
        emit('pinchEnd', center);
        this.pinching = false;
      }
      if (!this.points.size) {
        if (this.tap) {
          if (elapsedUs <= TAP_MAX_US) emit('tap', center);
          else emit('tapCancel', center);
        }
        if (this.scrolling) {
          const first = this.history[0],
            last = this.history[this.history.length - 1];
          const seconds = (last.t - first.t) / 1e6;
          let vx = seconds > 0.008 ? (last.x - first.x) / seconds : 0,
            vy = seconds > 0.008 ? (last.y - first.y) / seconds : 0;
          const speed = Math.hypot(vx, vy),
            clamp = Math.min(1, FLING_MAX_VELOCITY / speed);
          vx *= clamp;
          vy *= clamp;
          if (speed >= FLING_MIN_VELOCITY) {
            this.momentum = { startElapsedUs: elapsedUs, velocityX: vx, velocityY: vy };
            emit('flingStart', center, { velocityX: vx, velocityY: vy });
          } else emit('scrollEnd', center);
        }
      } else {
        const remaining = [...this.points.values()];
        this.previous = {
          x: remaining.reduce((s, p) => s + p.x, 0) / remaining.length,
          y: remaining.reduce((s, p) => s + p.y, 0) / remaining.length,
          span: 0,
        };
        const remainingCenter = this.previous;
        remainingCenter.span =
          2 *
          Math.sqrt(
            remaining.reduce(
              (sum, p) => sum + (p.x - remainingCenter.x) ** 2 + (p.y - remainingCenter.y) ** 2,
              0,
            ) / remaining.length,
          );
        this.spanOrigin = remainingCenter.span;
        this.history = [{ t: elapsedUs, ...this.travel }];
      }
    }
    return result;
  }
}
