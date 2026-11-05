/** Phase-based sampling avoids rounding every sample up to the next full frame period. */
export class MarkerSchedule {
  private next: number | undefined;
  constructor(readonly hz: number) {
    if (!(hz > 0 && hz <= 60)) throw new Error('Marker sample rate must be 1–60 Hz');
  }
  accept(at: number) {
    const period = 1000 / this.hz;
    this.next ??= at;
    if (at < this.next) return false;
    this.next += (Math.floor((at - this.next) / period) + 1) * period;
    return true;
  }
}
