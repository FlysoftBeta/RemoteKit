export interface Clock {
  monotonicMs(): number;
  wallMs(): number;
}
export const systemClock: Clock = Object.freeze({
  monotonicMs: () => performance.now(),
  wallMs: () => Date.now(),
});
