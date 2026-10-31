/** Associates the latest actually observed video frame with a bounded signaling map. */
export class FrameEpochGate {
  private frames = new Map<number, string>();
  epoch: string | undefined;
  rtpTimestamp: number | undefined;
  constructor(private capacity = 256) {}
  setEpoch(epoch: unknown) { this.epoch = typeof epoch === 'string' && /^\d+$/.test(epoch) ? epoch : undefined; }
  observe(timestamp: unknown) { this.rtpTimestamp = Number.isInteger(timestamp) && Number(timestamp) >= 0 && Number(timestamp) <= 0xffffffff ? Number(timestamp) : undefined; }
  record(timestamp: unknown, epoch: unknown) {
    if (!Number.isInteger(timestamp) || Number(timestamp) < 0 || Number(timestamp) > 0xffffffff || typeof epoch !== 'string' || !/^\d+$/.test(epoch)) return;
    const key = Number(timestamp); this.frames.delete(key); this.frames.set(key, epoch);
    while (this.frames.size > this.capacity) this.frames.delete(this.frames.keys().next().value!);
  }
  get ready() { return this.epoch !== undefined && this.rtpTimestamp !== undefined && this.frames.get(this.rtpTimestamp) === this.epoch; }
  epochFor(timestamp: number | undefined) { return timestamp === undefined ? undefined : this.frames.get(timestamp); }
  clear() { this.frames.clear(); this.epoch = undefined; this.rtpTimestamp = undefined; }
}
