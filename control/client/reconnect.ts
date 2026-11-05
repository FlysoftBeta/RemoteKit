export class ReconnectPolicy {
  wanted = false;
  attempt = 0;
  pending = false;
  start() {
    this.wanted = true;
    this.attempt = 0;
    this.pending = false;
  }
  stop() {
    this.wanted = false;
    this.attempt = 0;
    this.pending = false;
  }
  connected() {
    this.attempt = 0;
    this.pending = false;
  }
  schedule(): { delayMs: number; attempt: number } | undefined {
    if (!this.wanted || this.pending || this.attempt >= 3) return;
    const delayMs = [2000, 5000, 10000][this.attempt++];
    this.pending = true;
    return { delayMs, attempt: this.attempt };
  }
  beginRetry() {
    if (!this.wanted || !this.pending) return false;
    this.pending = false;
    return true;
  }
}
