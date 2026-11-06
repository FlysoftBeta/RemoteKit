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
export class MetricsHistory {
  private samples: { at: number; value: NodeMetrics; pressure: number }[] = [];
  constructor(private readonly maxSessions: number) {}
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
      throw new RemoteKitError('invalid_request', 'Invalid node metrics');
    const pressure = Math.max(
      value.cpu,
      1 - value.memory.available / value.memory.total,
      ...value.gpus.flatMap((gpu) => [gpu.engine3d, gpu.engineVideoEncode]),
      value.sessions / this.maxSessions,
      1 - value.disk.free / value.disk.total,
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
  clear() {
    this.samples = [];
  }
}
