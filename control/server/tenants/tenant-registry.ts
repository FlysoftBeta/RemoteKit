import { systemClock, type Clock } from '../util/clock';
import { KeyedSerialQueue } from '../util/serial-queue';
import { TenantRuntime } from './tenant-runtime';
export class TenantRegistry {
  mediaGeneration(tenantId: string) {
    return this.get(tenantId).mediaGeneration ?? 0;
  }
  private readonly runtimes = new Map<string, TenantRuntime>();
  private readonly queue = new KeyedSerialQueue();
  constructor(private readonly clock: Clock = systemClock) {}
  get(tenantId: string): TenantRuntime {
    let runtime = this.runtimes.get(tenantId);
    if (!runtime) {
      runtime = new TenantRuntime(tenantId, this.clock);
      this.runtimes.set(tenantId, runtime);
    }
    return runtime;
  }
  values(): TenantRuntime[] {
    return [...this.runtimes.values()];
  }
  withViewers(): [string, NonNullable<TenantRuntime['viewer']>][] {
    return this.values().flatMap((runtime) =>
      runtime.viewer
        ? [[runtime.tenantId, runtime.viewer] as [string, NonNullable<TenantRuntime['viewer']>]]
        : [],
    );
  }
  activeTenants(): string[] {
    return this.values()
      .filter((runtime) => runtime.viewer || runtime.started || runtime.pendingRtcCheck)
      .map((runtime) => runtime.tenantId);
  }
  forConnection(connectionId: string): TenantRuntime | undefined {
    return this.values().find((runtime) => runtime.connectionId === connectionId);
  }
  serial<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    this.get(tenantId);
    return this.queue.run(tenantId, work);
  }
  drain(): Promise<void> {
    return this.queue.drain();
  }
  dispose(tenantId: string) {
    this.runtimes.get(tenantId)?.dispose();
    this.runtimes.delete(tenantId);
  }
  async close() {
    for (const runtime of this.runtimes.values()) runtime.closeRtc();
    await this.drain();
    for (const runtime of this.runtimes.values()) runtime.dispose();
    this.runtimes.clear();
  }
}
