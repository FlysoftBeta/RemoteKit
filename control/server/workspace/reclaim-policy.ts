export const minute = 60_000;
export const idleKeepAliveFloorMs = 30 * minute;

export interface PageDwell {
  pageKey: string;
  visibleMs: number;
}

export function dwellFactor(pageKey: string | null, pages: readonly PageDwell[]): number {
  const ranked = [...pages].sort((a, b) => b.visibleMs - a.visibleMs || a.pageKey.localeCompare(b.pageKey));
  return ranked
    .slice(0, Math.ceil(ranked.length / 5))
    .some((page) => page.pageKey === pageKey && page.visibleMs >= 5 * minute)
    ? 4
    : 1;
}

export function tabReclaimDelays(factor: number, pressure: boolean) {
  const scale = factor / (pressure ? 4 : 1);
  return { freezeMs: Math.max(10_000, 30_000 * scale), discardMs: Math.max(30_000, 120_000 * scale) };
}

export function returnProbability(absences: readonly number[], absentMs: number): number {
  const survivors = absences.filter((duration) => duration >= absentMs);
  if (!survivors.length) return 0;
  return survivors.filter((duration) => duration < absentMs + 5 * minute).length / survivors.length;
}

export function keepAliveBlocksStop(eligibleMs: number | undefined, exhaustion: boolean): boolean {
  return !exhaustion && (eligibleMs === undefined || eligibleMs < idleKeepAliveFloorMs);
}

export function shouldStopSession(
  absences: readonly number[],
  absentMs: number,
  pressure: boolean,
  keepAliveEligibleMs: readonly (number | undefined)[] = [],
  exhaustion = false,
): boolean {
  if (keepAliveEligibleMs.some((duration) => keepAliveBlocksStop(duration, exhaustion))) return false;
  if (exhaustion) return true;
  if (absences.length < 20) return absentMs >= 10 * minute;
  return (
    absentMs >= (pressure ? 2 : 5) * minute && returnProbability(absences, absentMs) < (pressure ? 0.5 : 0.2)
  );
}

export function hardExhaustion(
  memory: { available: number; total: number } | undefined,
  allocationFailed: boolean,
) {
  return allocationFailed || (!!memory && memory.available / memory.total < 0.05);
}
