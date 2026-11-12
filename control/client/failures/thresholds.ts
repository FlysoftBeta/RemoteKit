export const recoveringDelayMs = 1500;
export const longRecoveryMs = 20_000;
export const connectionRecoveryMs = 30_000;
export function recoveryTiming(since: number, now: number, connection = false) {
  const elapsed = now - since;
  return {
    visible: elapsed >= recoveringDelayMs,
    long: elapsed >= longRecoveryMs,
    calm: elapsed >= (connection ? connectionRecoveryMs : longRecoveryMs),
  };
}
