import { Session } from 'node:inspector/promises';
import { RemoteKitError } from '../../shared/errors';

export const cpuProfileSamplingUs = 1000;
// Ten minutes at 1ms sampling serializes to roughly 10 MiB.
export const cpuProfileMaxBytes = 24 * 1024 * 1024;

export type CpuProfileResult = { data: Buffer } | { error: unknown };

/**
 * A V8 CPU profile of the main thread, in the DevTools `.cpuprofile` format. Each collection
 * owns its own inspector session; V8 runs concurrent profiles independently.
 */
export class CpuProfile {
  private readonly session = new Session();
  private readonly started: Promise<unknown>;
  private stopping?: Promise<CpuProfileResult>;

  constructor() {
    // Resolves to the start failure, if any, so a failed start is reported once by stop().
    this.started = (async () => {
      this.session.connect();
      await this.session.post('Profiler.enable');
      await this.session.post('Profiler.setSamplingInterval', { interval: cpuProfileSamplingUs });
      await this.session.post('Profiler.start');
    })().then(
      () => undefined,
      (error: unknown) => error ?? new Error('CPU profiler failed to start'),
    );
  }

  stop(): Promise<CpuProfileResult> {
    return (this.stopping ??= this.finish());
  }

  private async finish(): Promise<CpuProfileResult> {
    try {
      const failure = await this.started;
      if (failure !== undefined) return { error: failure };
      const { profile } = await this.session.post('Profiler.stop');
      const data = Buffer.from(JSON.stringify(profile));
      if (data.length > cpuProfileMaxBytes)
        return {
          error: new RemoteKitError('limit_exceeded', 'CPU profile exceeds its size limit', {
            detail: `CPU profile is ${data.length} bytes; limit ${cpuProfileMaxBytes}`,
          }),
        };
      return { data };
    } catch (error) {
      return { error };
    } finally {
      this.session.disconnect();
    }
  }
}
