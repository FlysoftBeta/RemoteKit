/** Bounded RTP-to-layout metadata from the signaling channel. */
export class FrameEpochGate {
  private frames = new Map<number, string>();
  constructor(private capacity = 256) {}
  record(timestamp: unknown, epoch: unknown) {
    if (
      !Number.isInteger(timestamp) ||
      Number(timestamp) < 0 ||
      Number(timestamp) > 0xffffffff ||
      typeof epoch !== 'string' ||
      !/^\d+$/.test(epoch)
    )
      return;
    const key = Number(timestamp);
    this.frames.delete(key);
    this.frames.set(key, epoch);
    while (this.frames.size > this.capacity) this.frames.delete(this.frames.keys().next().value!);
  }
  epochFor(timestamp: number | undefined) {
    return timestamp === undefined ? undefined : this.frames.get(timestamp);
  }
  clear() {
    this.frames.clear();
  }
}
