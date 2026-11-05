import { RequestTracker } from '../util/request-tracker';
/** One remote host's wall clock. Never share a calibration between hosts. */
export class ClockDomain {
  revision = 0;
  private sample?: {
    offset: number;
    uncertainty: number;
    at: number;
    wall: number;
    remote: number;
    mono?: number;
  };
  reset() {
    this.sample = undefined;
    this.revision++;
  }
  calibrate(
    start: number,
    startWall: number,
    end: number,
    endWall: number,
    remote: number,
    mono?: number,
  ): boolean {
    if (
      ![start, startWall, end, endWall, remote].every(Number.isFinite) ||
      (mono !== undefined && !Number.isFinite(mono)) ||
      end < start ||
      Math.abs(endWall - startWall - (end - start)) > 5
    ) {
      this.reset();
      return false;
    }
    const uncertainty = (end - start) / 2 + 1;
    if (uncertainty > 25) return false;
    const offset = remote - (startWall + endWall) / 2,
      previous = this.sample;
    if (
      previous &&
      (!this.mapping(end, endWall) ||
        Math.abs(offset - previous.offset) > uncertainty + previous.uncertainty + 5 ||
        (mono !== undefined &&
          previous.mono !== undefined &&
          (mono < previous.mono || Math.abs(remote - previous.remote - (mono - previous.mono)) > 5)))
    ) {
      this.reset();
      return false;
    }
    this.sample = { offset, uncertainty, at: end, wall: endWall, remote, mono };
    return true;
  }
  mapping(now: number, wall: number, historical = false): { wall: number; uncertainty: number } | undefined {
    const sample = this.sample;
    if (!sample || ![now, wall].every(Number.isFinite)) return;
    if (
      (!historical && now < sample.at) ||
      Math.abs(now - sample.at) > 15000 ||
      Math.abs(wall - sample.wall - (now - sample.at)) > 5
    ) {
      this.reset();
      return;
    }
    return { wall: wall + sample.offset, uncertainty: sample.uncertainty };
  }
  remoteConsistent(wall: number, mono: number, uncertainty: number): boolean {
    const sample = this.sample;
    if (!sample) return false;
    if (
      sample.mono !== undefined &&
      Math.abs(wall - sample.remote - (mono - sample.mono)) > 5 + uncertainty
    ) {
      this.reset();
      return false;
    }
    return true;
  }
}

/** Bounded single-flight sampling. Instance/reset lifetime is the transport channel. */
export class ClockProbe {
  private readonly requests = new RequestTracker<void>();
  private pending?: { requestId: string; at: number; wall: number };
  private last = -Infinity;
  private serial = 0;
  private generation = 0;
  private observed?: { at: number; wall: number };
  constructor(readonly clock: ClockDomain) {}
  reset() {
    this.requests.clear();
    this.pending = undefined;
    this.last = -Infinity;
    this.observed = undefined;
    this.generation++;
    this.clock.reset();
  }
  begin(now: number, wall: number) {
    if (![now, wall].every(Number.isFinite)) return;
    const observed = this.observed;
    if (observed && (now < observed.at || Math.abs(wall - observed.wall - (now - observed.at)) > 5))
      this.reset();
    this.observed = { at: now, wall };
    if (this.pending && now - this.pending.at >= 1500) this.pending = undefined;
    if ((this.pending && this.requests.has(this.pending.requestId)) || now - this.last < 5000) return;
    const requestId = `clock-${this.generation}-${++this.serial}`;
    this.pending = { requestId, at: now, wall };
    void this.requests
      .request(requestId, 1500, () => {})
      .catch(() => {
        /* A missed clock sample carries no product outcome. */
      });
    this.last = now;
    return { type: 'clock.ping' as const, version: 1 as const, requestId };
  }
  complete(requestId: string, now: number, wall: number, remote: number, mono?: number) {
    const pending = this.pending;
    if (!pending || pending.requestId !== requestId) return false;
    this.requests.resolve(requestId, undefined);
    this.pending = undefined;
    if (now < pending.at || now - pending.at >= 1500) return false;
    return this.clock.calibrate(pending.at, pending.wall, now, wall, remote, mono);
  }
  pong(
    value: Extract<import('../rtc/protocol').Incoming, { type: 'clock.pong' }>,
    now: number,
    wall: number,
  ) {
    return this.complete(value.requestId, now, wall, value.serverTimeMs, value.serverMonotonicMs);
  }
}
