import { RemoteKitError } from '../../shared/errors';

export interface NodeMetrics {
  cpu: number;
  memory: { total: number; available: number };
  gpus: {
    luid: string;
    name: string;
    engine3d: number;
    engineVideoEncode: number;
    dedicatedUsed: number;
    dedicatedTotal: number;
  }[];
  disk: { total: number; free: number };
  sessions: number;
  objectBytes: number;
}
export interface MetricsSample {
  at: number;
  value: NodeMetrics;
  pressure: number;
}
function utilization(value: NodeMetrics): number[] {
  return [
    value.cpu,
    1 - value.memory.available / value.memory.total,
    Math.max(0, ...value.gpus.map((gpu) => gpu.engine3d)),
    Math.max(0, ...value.gpus.map((gpu) => gpu.engineVideoEncode)),
    1 - value.disk.free / value.disk.total,
  ];
}
export class MetricsHistory {
  private samples: MetricsSample[] = [];
  private baseline?: number[];
  private knownCosts?: number[];
  constructor(
    private readonly maxSessions: number | null,
    private readonly peers: () => MetricsHistory[] = () => [],
  ) {}
  record(value: NodeMetrics, now = Date.now()) {
    const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    const unit = (n: unknown) => nonnegative(n) && n <= 1;
    if (
      !value ||
      !unit(value.cpu) ||
      !value.memory ||
      !value.disk ||
      !nonnegative(value.memory.total) ||
      value.memory.total === 0 ||
      !nonnegative(value.memory.available) ||
      value.memory.available > value.memory.total ||
      !nonnegative(value.disk.total) ||
      value.disk.total === 0 ||
      !nonnegative(value.disk.free) ||
      value.disk.free > value.disk.total ||
      !Number.isSafeInteger(value.sessions) ||
      value.sessions < 0 ||
      !nonnegative(value.objectBytes) ||
      !Array.isArray(value.gpus) ||
      value.gpus.some(
        (gpu) =>
          !gpu ||
          typeof gpu.luid !== 'string' ||
          typeof gpu.name !== 'string' ||
          !unit(gpu.engine3d) ||
          !unit(gpu.engineVideoEncode) ||
          !nonnegative(gpu.dedicatedUsed) ||
          !nonnegative(gpu.dedicatedTotal),
      )
    )
      throw new RemoteKitError('invalid_request', '节点指标格式无效', { detail: 'Invalid node metrics' });
    const resources = utilization(value);
    if (value.sessions === 0) {
      this.baseline = resources.map((u, i) => (this.baseline ? 0.2 * u + 0.8 * this.baseline[i] : u));
    } else {
      this.knownCosts = resources.map((u, i) => Math.max(0, u - (this.baseline?.[i] ?? 0)) / value.sessions);
    }
    const pressure = Math.max(
      ...resources,
      this.maxSessions === null ? 0 : value.sessions / this.maxSessions,
    );
    this.samples.push({ at: now, value, pressure });
    // Retain the sample covering the beginning of the rolling interval.
    while (this.samples.length > 1 && this.samples[1].at <= now - 30000) this.samples.shift();
  }
  latest(now = Date.now()) {
    const sample = this.samples[this.samples.length - 1];
    return sample && now - sample.at <= 30000 ? sample : undefined;
  }
  underPressure(now = Date.now()) {
    return (
      !!this.latest(now) &&
      this.samples[0].at <= now - 30000 &&
      this.samples.every((sample) => sample.pressure >= 0.85) &&
      this.samples.every((sample, i) => i === 0 || sample.at - this.samples[i - 1].at <= 10000)
    );
  }
  relieved(now = Date.now()) {
    const sample = this.latest(now);
    return !!sample && sample.pressure < 0.85;
  }
  predicted(now = Date.now()): number | undefined {
    const sample = this.latest(now);
    if (!sample) return undefined;
    const peers = this.peers().filter((peer) => peer !== this && peer.latest(now) && peer.knownCosts);
    const costs =
      sample.value.sessions > 0
        ? this.knownCosts!
        : utilization(sample.value).map((_, i) =>
            peers.length ? peers.reduce((sum, peer) => sum + peer.knownCosts![i], 0) / peers.length : 0,
          );
    return Math.max(
      ...utilization(sample.value).map((u, i) => u + costs[i]),
      this.maxSessions === null ? 0 : (sample.value.sessions + 1) / this.maxSessions,
    );
  }
  clear() {
    this.baseline = undefined;
    this.knownCosts = undefined;
    this.samples = [];
  }
}
