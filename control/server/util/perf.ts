import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { log, type LogFields } from '../log';

// A synchronous step this long is a visible stall for every Viewer sharing the event loop.
export const SLOW_SYNC_MS = 50;
// Asynchronous operations include queueing and remote work, so only report outliers.
export const SLOW_ASYNC_MS = 1000;
const STALL_MS = 200;
const WINDOW_MS = 1000;
const REPORTED_OPS = 8;

interface OpStats {
  count: number;
  totalMs: number;
  maxMs: number;
}
export interface PerfOp extends OpStats {
  op: string;
  slow: number;
}
export interface LoopWindow {
  atMs: number;
  maxMs: number;
  p99Ms: number;
  meanMs: number;
}

const round = (value: number) => Math.round(value * 10) / 10;

function add(map: Map<string, OpStats>, op: string, ms: number) {
  let stats = map.get(op);
  if (!stats) map.set(op, (stats = { count: 0, totalMs: 0, maxMs: 0 }));
  stats.count++;
  stats.totalMs += ms;
  if (ms > stats.maxMs) stats.maxMs = ms;
  return stats;
}

function ranked(entries: Iterable<[string, OpStats & { slow?: number }]>, limit: number) {
  return [...entries]
    .sort((a, b) => b[1].totalMs - a[1].totalMs)
    .slice(0, limit)
    .map(([op, stats]) => ({
      op,
      count: stats.count,
      totalMs: round(stats.totalMs),
      maxMs: round(stats.maxMs),
      ...(stats.slow === undefined ? {} : { slow: stats.slow }),
    }));
}

/**
 * Process-wide timing of named operations. `sync` brackets work that holds the event loop;
 * `async` brackets whole operations including awaits. Each slow occurrence is logged once
 * (`perf.slow`); the loop monitor attributes stalls to the synchronous work of its window.
 */
export class PerfRegistry {
  private readonly totals = new Map<string, OpStats & { slow: number }>();
  private window = new Map<string, OpStats>();
  private readonly loops: LoopWindow[] = [];

  sync<T>(op: string, fn: () => T, fields?: () => LogFields): T {
    const start = performance.now();
    try {
      return fn();
    } finally {
      this.record(op, performance.now() - start, SLOW_SYNC_MS, fields, true);
    }
  }

  async async<T>(op: string, fn: () => Promise<T>, fields?: () => LogFields): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.record(op, performance.now() - start, SLOW_ASYNC_MS, fields, false);
    }
  }

  record(op: string, ms: number, slowMs: number, fields?: () => LogFields, holdsLoop = false) {
    let total = this.totals.get(op);
    if (!total) this.totals.set(op, (total = { count: 0, totalMs: 0, maxMs: 0, slow: 0 }));
    total.count++;
    total.totalMs += ms;
    if (ms > total.maxMs) total.maxMs = ms;
    if (holdsLoop) add(this.window, op, ms);
    if (ms < slowMs) return;
    total.slow++;
    log.info('perf.slow', { op, ms: round(ms), sync: holdsLoop, ...fields?.() });
  }

  /** Synchronous work since the previous call, heaviest first. */
  takeWindow() {
    const window = this.window;
    this.window = new Map();
    return ranked(window, REPORTED_OPS);
  }

  recordLoop(window: LoopWindow) {
    this.loops.push(window);
    if (this.loops.length > 60) this.loops.shift();
  }

  snapshot(limit = 40) {
    return {
      ops: ranked(this.totals, limit) as PerfOp[],
      eventLoop: this.loops.slice(-10),
    };
  }
}

export const perf = new PerfRegistry();

/** Samples event-loop delay every second and logs which synchronous work filled a stalled window. */
export function startLoopMonitor(registry = perf) {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const timer = setInterval(() => {
    const window: LoopWindow = {
      atMs: Date.now(),
      maxMs: round(histogram.max / 1e6),
      p99Ms: round(histogram.percentile(99) / 1e6),
      meanMs: round(histogram.mean / 1e6),
    };
    histogram.reset();
    const ops = registry.takeWindow();
    registry.recordLoop(window);
    if (window.maxMs >= STALL_MS) log.warn('control.event_loop_stall', { ...window, ops });
  }, WINDOW_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
