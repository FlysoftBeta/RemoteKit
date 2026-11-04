import type { DiagnosticEnvironment, DiagnosticMethods, DiagnosticReply } from '../shared/diagnostics';

export function diagnosticEnvironment(): DiagnosticEnvironment {
  const ua = navigator.userAgent;
  const browsers = [
    ['edge', /Edg(?:A|iOS)?\/([\d.]+)/], ['firefox', /(?:Firefox|FxiOS)\/([\d.]+)/],
    ['chrome', /(?:Chrome|CriOS)\/([\d.]+)/], ['chromium', /Chromium\/([\d.]+)/],
    ['safari', /Version\/([\d.]+).*Safari\//],
  ] as const;
  const browser = browsers.find(([, pattern]) => pattern.test(ua));
  const platform = /Android/.test(ua) ? 'android' : /iPhone|iPad|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'ios' : /Windows/.test(ua) ? 'windows' :
    /CrOS/.test(ua) ? 'chromeos' : /Macintosh/.test(ua) ? 'macos' : /Linux/.test(ua) ? 'linux' : 'other';
  const osPatterns = {
    android: /Android ([\d.]+)/, ios: /(?:CPU (?:iPhone )?OS|iPhone OS) ([\d_]+)/,
    windows: /Windows NT ([\d.]+)/, macos: /Mac OS X ([\d_.]+)/, chromeos: /CrOS [\w-]+ ([\d.]+)/,
    linux: undefined, other: undefined,
  };
  const version = (value?: string) => value && /^\d{1,6}(?:[._]\d{1,6}){0,3}$/.test(value)
    ? value.replace(/_/g, '.') : undefined;
  const browserVersion = version(browser?.[1].exec(ua)?.[1]);
  const osVersion = version(osPatterns[platform]?.exec(ua)?.[1]);
  const device = navigator as Navigator & { deviceMemory?: number; connection?: {
    effectiveType?: string; rtt?: number; downlink?: number;
  } };
  const effectiveType = device.connection?.effectiveType;
  return {
    browserFamily: 'brave' in navigator ? 'brave' : browser?.[0] ?? 'other',
    browserMajorVersion: browserVersion ? Number(browserVersion.split('.')[0]) : undefined,
    browserVersion, platform, osVersion,
    viewportWidth: window.visualViewport?.width ?? window.innerWidth,
    viewportHeight: window.visualViewport?.height ?? window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    screenWidth: screen.width, screenHeight: screen.height, screenColorDepth: screen.colorDepth,
    maxTouchPoints: navigator.maxTouchPoints,
    hardwareConcurrency: navigator.hardwareConcurrency, deviceMemoryGiB: device.deviceMemory,
    effectiveConnectionType: effectiveType === 'slow-2g' || effectiveType === '2g' ||
      effectiveType === '3g' || effectiveType === '4g' ? effectiveType : undefined,
    networkRttMs: device.connection?.rtt, networkDownlinkMbps: device.connection?.downlink,
    videoFrameCallbackSupported: typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function',
  };
}

export type DiagnosticRequest = <K extends keyof DiagnosticMethods>(
  method: K, params: DiagnosticMethods[K]['params'],
) => Promise<DiagnosticReply>;

export type DiagnosticState =
  | { phase: 'idle' | 'starting' | 'start-error' }
  | { phase: 'collecting' | 'finalizing' | 'complete' | 'retry' | 'failed'; id: string; samples: number; missingSamples: number; reason?: string };

export class DiagnosticCollection {
  private state: DiagnosticState = { phase: 'idle' };
  private available = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private sending?: Promise<void>;
  private finalizing = false;
  private deadline = 0;
  private since = 0;
  private sequence = 0;
  private generation = 0;

  constructor(
    private readonly request: DiagnosticRequest,
    private readonly capture: (since: number) => object | undefined,
    private readonly changed: (state: DiagnosticState) => void,
  ) {}

  private update(state: DiagnosticState) {
    if (this.disposed) return;
    this.state = state;
    this.changed(state);
  }

  setAvailable(available: boolean) {
    if (this.disposed || available === this.available) return;
    this.available = available;
    if (!available) {
      this.generation++;
      clearTimeout(this.timer);
      if (this.state.phase === 'collecting' || this.state.phase === 'retry')
        this.update({ ...this.state, phase: 'finalizing' });
    } else if (this.state.phase === 'finalizing') {
      void this.finish(true);
    }
  }

  dispose() {
    this.disposed = true;
    this.available = false;
    clearTimeout(this.timer);
  }

  dismiss() {
    if (this.state.phase === 'complete' || this.state.phase === 'failed')
      this.update({ phase: 'idle' });
  }

  async start(environment: DiagnosticEnvironment) {
    if (!this.available || !['idle', 'start-error'].includes(this.state.phase)) return false;
    this.update({ phase: 'starting' });
    const generation = this.generation;
    this.since = performance.now();
    try {
      const reply = await this.request('diagnostics.start', { environment });
      if (this.disposed) return false;
      this.deadline = performance.now() + (reply.maxDurationMs ?? 600_000);
      this.sequence = 0;
      const phase = generation === this.generation ? reply.status : 'finalizing';
      this.update({ phase, id: reply.id, samples: 0, missingSamples: 0, reason: reply.reason });
      if (phase === 'collecting') this.schedule(() => this.sample());
      else if (phase === 'finalizing') void this.finish(true);
      return this.available && generation === this.generation;
    } catch {
      this.update({ phase: 'start-error' });
      return false;
    }
  }

  private schedule(run: () => void) {
    clearTimeout(this.timer);
    if (this.available) this.timer = setTimeout(run, 1000);
  }

  private apply(reply: DiagnosticReply, current: Extract<DiagnosticState, { id: string }>) {
    if (reply.status === 'collecting') return false;
    const reason = reply.reason === 'user' && current.reason === 'duration-limit'
      ? current.reason : reply.reason ?? current.reason;
    this.update({ ...current, phase: reply.status, reason });
    return true;
  }

  private sample() {
    const current = this.state;
    if (!this.available || current.phase !== 'collecting') return;
    if (performance.now() >= this.deadline) {
      this.stop('duration-limit');
      return;
    }
    let data: object | undefined;
    try { data = this.capture(this.since); } catch {}
    if (!data) {
      this.update({ ...current, missingSamples: current.missingSamples + 1 });
      this.schedule(() => this.sample());
      return;
    }
    this.sending = this.sendSample(current.id, ++this.sequence, data);
  }

  private async sendSample(id: string, sequence: number, data: object) {
    try {
      const reply = await this.request('diagnostics.sample', { id, sequence, data });
      const current = this.state;
      if (current.phase !== 'collecting' && current.phase !== 'finalizing') return;
      if (!this.apply(reply, current)) {
        this.update({ ...current, samples: current.samples + 1 });
        if (current.phase === 'collecting') this.schedule(() => this.sample());
      } else if (reply.status === 'finalizing') {
        this.schedule(() => void this.finish(true));
      }
    } catch {
      const current = this.state;
      if (current.phase === 'collecting' || current.phase === 'finalizing') {
        this.update({ ...current, phase: 'finalizing', missingSamples: current.missingSamples + 1 });
        this.schedule(() => void this.finish(false));
      }
    } finally {
      this.sending = undefined;
    }
  }

  stop(reason?: 'duration-limit') {
    const current = this.state;
    if (!this.available || (current.phase !== 'collecting' && current.phase !== 'retry')) return;
    clearTimeout(this.timer);
    this.update({ ...current, phase: 'finalizing', reason: reason ?? current.reason });
    void this.finish(current.phase === 'retry');
  }

  private async finish(checkStatus: boolean) {
    if (!this.available || this.finalizing || this.state.phase !== 'finalizing') return;
    this.finalizing = true;
    const generation = this.generation;
    try {
      await this.sending;
      const current = this.state;
      if (!this.available || generation !== this.generation || current.phase !== 'finalizing') return;
      let reply: DiagnosticReply;
      if (checkStatus) {
        reply = await this.request('diagnostics.status', { id: current.id });
        if (!this.available || generation !== this.generation) return;
        if (reply.status === 'collecting') reply = await this.request('diagnostics.stop', { id: current.id });
      } else {
        reply = await this.request('diagnostics.stop', { id: current.id });
      }
      if (generation !== this.generation) return;
      if (!this.apply(reply, current) || reply.status === 'finalizing')
        this.schedule(() => void this.finish(true));
    } catch {
      if (this.available && generation === this.generation && this.state.phase === 'finalizing')
        this.update({ ...this.state, phase: 'retry' });
    } finally {
      this.finalizing = false;
      if (generation !== this.generation && this.state.phase === 'finalizing')
        this.schedule(() => void this.finish(true));
    }
  }
}
