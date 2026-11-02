// Automation-only bounded ownership of immutable painted-canvas snapshots.
export class BenchmarkMarkerReadback {
  constructor({ maxPending = 4, timeoutMs = 5000, api = globalThis } = {}) {
    this.api = api; this.maxPending = maxPending; this.timeoutMs = timeoutMs;
    this.pending = new Map(); this.nextId = 0; this.closed = false;
    this.stats = { submitted: 0, completed: 0, failed: 0, maxPending: 0, bitmapCreated: 0, bitmapTransferred: 0, bitmapClosedMain: 0, bitmapClosedWorker: 0, workerTerminated: 0 };
  }
  async start() {
    const a = this.api;
    if (typeof a.Worker !== 'function' || typeof a.createImageBitmap !== 'function') throw new Error('worker marker requires Worker and createImageBitmap');
    this.worker = new a.Worker(new URL('./benchmark-marker-worker.js', import.meta.url), { type: 'module' });
    await new Promise((resolve, reject) => {
      const timer = a.setTimeout(() => { this.close('worker initialization timeout'); reject(new Error('worker marker initialization timeout')); }, this.timeoutMs);
      this.worker.onmessage = ({ data }) => {
        a.clearTimeout(timer);
        if (data.type !== 'ready') { this.close(data.error || 'worker initialization failed'); reject(new Error(data.error || 'worker initialization failed')); return; }
        resolve();
      };
      this.worker.onerror = event => { a.clearTimeout(timer); this.close(event.message || 'worker initialization error'); reject(new Error(event.message || 'worker initialization error')); };
    });
    this.worker.onmessage = ({ data }) => this.complete(data);
    this.worker.onerror = event => this.close(event.message || 'marker worker error');
    this.worker.onmessageerror = () => this.close('marker worker message decoding failed');
    this.unload = () => this.close('page closed');
    a.addEventListener?.('pagehide', this.unload);
    return this;
  }
  submit(image, rect, identity) {
    const a = this.api, id = ++this.nextId, captureStartedAt = a.performance.now();
    ++this.stats.submitted;
    if (this.closed || this.pending.size >= this.maxPending) {
      ++this.stats.failed;
      return Promise.reject(new Error(this.closed ? 'marker readback closed' : 'marker readback capacity exceeded'));
    }
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const job = { id, identity, rect: { ...rect }, captureStartedAt, resolve, reject };
    this.pending.set(id, job); this.stats.maxPending = Math.max(this.stats.maxPending, this.pending.size);
    job.timer = a.setTimeout(() => this.close(`marker job ${id} timeout`), this.timeoutMs);
    // Call NOW, in the paint notification stack, before any await or microtask.
    // Canvas snapshot construction can itself cost main-thread time; record it.
    try {
      let snapshot;
      if(Object.values(rect).every(Number.isInteger))snapshot=a.createImageBitmap(image,rect.x,rect.y,rect.width,rect.height);
      else {
        // Shared presentation may scale X/Y independently during a static CSS resize.
        // Normalize the real displayed ROI synchronously before the next frame can replace it.
        const sample=typeof a.OffscreenCanvas==='function'?new a.OffscreenCanvas(256,112):a.document.createElement('canvas');sample.width=256;sample.height=112;
        const context=sample.getContext('2d');if(!context)throw new Error('Marker ROI normalization unavailable');
        context.drawImage(image,rect.x,rect.y,rect.width,rect.height,0,0,256,112);snapshot=a.createImageBitmap(sample);
      }
      job.captureCallMs = a.performance.now() - captureStartedAt;
      Promise.resolve(snapshot).then(bitmap => {
        ++this.stats.bitmapCreated;
        if (!this.pending.has(id)) { bitmap.close(); ++this.stats.bitmapClosedMain; return; }
        job.bitmapReadyMs = a.performance.now() - captureStartedAt;
        try { this.worker.postMessage({ id, bitmap }, [bitmap]); ++this.stats.bitmapTransferred; }
        catch (error) { bitmap.close(); ++this.stats.bitmapClosedMain; this.fail(job, error); }
      }, error => this.fail(job, error));
    } catch (error) { job.captureCallMs = a.performance.now() - captureStartedAt; this.fail(job, error); }
    return promise;
  }
  fail(job, error) {
    if (!this.pending.delete(job.id)) return;
    this.api.clearTimeout(job.timer); ++this.stats.failed;
    job.reject(new Error(`marker job ${job.id}: ${String(error)}`));
  }
  complete(data) {
    if (data.bitmapClosed) ++this.stats.bitmapClosedWorker;
    const job = this.pending.get(data.id);
    if (!job) return;
    if (data.error || !data.bitmapClosed) { this.fail(job, data.error || 'worker did not close bitmap'); return; }
    this.pending.delete(job.id); this.api.clearTimeout(job.timer); ++this.stats.completed;
    job.resolve({ id: job.id, identity: job.identity, sourceRect: job.rect, marker: data.marker, costs: { captureCallMs: job.captureCallMs, bitmapReadyMs: job.bitmapReadyMs, turnaroundMs: this.api.performance.now() - job.captureStartedAt, ...data.costs } });
  }
  close(reason = 'marker readback closed') {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.pending.values()) this.fail(job, reason);
    if (this.worker) { this.worker.terminate(); ++this.stats.workerTerminated; }
    this.api.removeEventListener?.('pagehide', this.unload);
  }
}
