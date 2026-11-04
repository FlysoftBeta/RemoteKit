import { CameraCandidatePool, cameraBudget } from './camera-candidates';
export class CameraCapture {
    private canvases = new Set<HTMLCanvasElement>();
    private worker?: Worker;
    private generation = 0;
    private pending?: {
        resolve: (result: any) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    };
    readonly pool = new CameraCandidatePool();
    readonly metrics = { snapshots: 0, skipped: 0, snapshotSyncMs: [] as number[], blobWallMs: [] as number[], workerWallMs: [] as number[], scoreMs: [] as number[], peakPixels: 0, bitmapWallMs: [] as number[], workerDrawMs: [] as number[], path: 'canvas' };
    cancel() { this.generation++; this.worker?.terminate(); this.worker = undefined; if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending.reject(new Error('拍照已取消'));
        this.pending = undefined;
    } this.pool.clear(); for(const canvas of this.canvases)canvas.width=canvas.height=1;this.canvases.clear(); }
    private request(payload: Record<string, unknown>, transfers: Transferable[], generation: number) {
        if (this.pending) {
            this.metrics.skipped++;
            return Promise.reject(new Error('评分仍在进行'));
        }
        this.worker ??= new Worker('/camera-score.js');
        const worker = this.worker, start = performance.now();
        return new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => { this.pending = undefined; worker.terminate(); if (this.worker === worker)
                this.worker = undefined; reject(new Error('照片处理超时，请重试')); }, 2000);
            this.pending = { resolve, reject, timer };
            worker.onmessage = event => {
                const message = event.data;
                if (generation !== this.generation || message.generation !== generation || !this.pending)
                    return;
                clearTimeout(timer);
                this.pending = undefined;
                this.metrics.workerWallMs.push(performance.now() - start);
                if (message.result) this.metrics.scoreMs.push(message.elapsedMs ?? 0);
                if (message.error)
                    reject(new Error('无法处理照片'));
                else
                    resolve(message);
            };
            worker.onerror = () => { if (generation !== this.generation)
                return; clearTimeout(timer); this.pending = undefined; worker.terminate(); if (this.worker === worker)
                this.worker = undefined; reject(new Error('无法处理照片')); };
            try { worker.postMessage({ id: this.metrics.snapshots, generation, ...payload }, transfers); }
            catch (error) { clearTimeout(timer); this.pending = undefined; reject(error); }
        });
    }
    async capture(video: HTMLVideoElement, format: 'image/jpeg' | 'image/png') {
        this.cancel();
        this.metrics.snapshots = this.metrics.skipped = this.metrics.peakPixels = 0;
        this.metrics.bitmapWallMs = []; this.metrics.workerDrawMs = []; this.metrics.path = 'canvas';
        this.metrics.snapshotSyncMs = []; this.metrics.blobWallMs = []; this.metrics.workerWallMs = []; this.metrics.scoreMs = [];
        const generation = this.generation, start = performance.now();
        const full = document.createElement('canvas'), small = document.createElement('canvas');
        this.canvases.add(full);this.canvases.add(small);
        small.width = 160;
        small.height = 90;
        try {
            let bitmapPath = false;
            if (typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function') {
                try { bitmapPath = (await this.request({ probe: true }, [], generation)).supported === true; }
                catch (error) { if (generation !== this.generation) throw error; }
            }
            this.metrics.path = bitmapPath ? 'bitmap-worker' : 'canvas';
            for (let i = 0; i < cameraBudget.samples; i++) {
                if (generation !== this.generation)
                    throw new Error('拍照已取消');
                if (i && performance.now() - start > cameraBudget.durationMs)
                    break;
                const tick = performance.now();
                const sourcePixels = video.videoWidth * video.videoHeight;
                if (!sourcePixels)
                    throw new Error('摄像头尚未准备好');
                const scale = Math.min(1, Math.sqrt(cameraBudget.maxFramePixels / sourcePixels));
                const width = Math.max(1, Math.floor(video.videoWidth * scale));
                const height = Math.max(1, Math.floor(video.videoHeight * scale));
                let score: number, blob: Blob;
                // Conservative logical pixel budget includes retained candidates, bitmap and Worker backing.
                this.metrics.peakPixels = Math.max(this.metrics.peakPixels, (bitmapPath ? 2 : 1) * width * height + this.pool.candidates.reduce((sum, c) => sum + c.width * c.height, 0));
                if (bitmapPath) {
                    const bitmapStart = performance.now();
                    let bitmap: ImageBitmap, syncMs: number;
                    try {
                        const bitmapPromise = createImageBitmap(video, { resizeWidth: width, resizeHeight: height, resizeQuality: 'low' });
                        syncMs = performance.now() - bitmapStart;
                        bitmap = await bitmapPromise;
                    }
                    catch (error) {
                        if (generation !== this.generation) throw new Error('拍照已取消');
                        // Unsupported video bitmap/resize implementations retain the canvas path.
                        bitmapPath = false; this.metrics.path = 'canvas'; i--; continue;
                    }
                    if (generation !== this.generation) { bitmap.close(); throw new Error('拍照已取消'); }
                    this.metrics.bitmapWallMs.push(performance.now() - bitmapStart);
                    this.metrics.snapshots++;
                    const transferStart = performance.now();
                    const result = this.request({ bitmap, width, height, format }, [bitmap], generation);
                    this.metrics.snapshotSyncMs.push(syncMs + performance.now() - transferStart);
                    let message;
                    try { message = await result; } catch (error) { bitmap.close(); throw error; }
                    score = message.result.score; blob = message.blob;
                    this.metrics.blobWallMs.push(message.blobWallMs);
                    this.metrics.workerDrawMs.push(message.drawMs);
                } else {
                    const ctx = full.getContext('2d')!, low = small.getContext('2d')!;
                    full.width = Math.max(1, Math.floor(video.videoWidth * scale));
                    full.height = Math.max(1, Math.floor(video.videoHeight * scale));
                    // Both low-resolution score and final Blob derive from this one immutable canvas snapshot.
                    ctx.drawImage(video, 0, 0, full.width, full.height);
                    small.width = 160;
                    small.height = Math.max(3, Math.round(160 * full.height / full.width));
                    if (small.height > 256) {
                        small.height = 256;
                        small.width = Math.max(3, Math.round(256 * full.width / full.height));
                    }
                    low.drawImage(full, 0, 0, small.width, small.height);
                    const rgba = low.getImageData(0, 0, small.width, small.height).data, pixels = new Uint8Array(small.width * small.height);
                    for (let p = 0; p < pixels.length; p++)
                        pixels[p] = (rgba[p * 4] * 77 + rgba[p * 4 + 1] * 150 + rgba[p * 4 + 2] * 29) >> 8;
                    this.metrics.snapshotSyncMs.push(performance.now() - tick);
                    this.metrics.snapshots++;
                    const blobStart = performance.now();
                    const [scored, encoded] = await Promise.all([this.request({ pixels, width: small.width, height: small.height }, [pixels.buffer], generation), new Promise<Blob>((resolve, reject) => full.toBlob(value => { if(generation===this.generation)this.metrics.blobWallMs.push(performance.now() - blobStart); value ? resolve(value) : reject(new Error('无法保存照片')); }, format, .92))]);
                    score = scored.result.score; blob = encoded;
                }
                if (generation !== this.generation)
                    throw new Error('拍照已取消');
                this.pool.offer({ id: i, at: tick, score, width, height, blob });
                this.metrics.peakPixels = Math.max(this.metrics.peakPixels, (bitmapPath ? 2 : 1) * width * height + this.pool.candidates.reduce((sum, c) => sum + c.width * c.height, 0));
                const wait = 100 - (performance.now() - tick);
                if (wait > 0)
                    await new Promise(resolve => setTimeout(resolve, wait));
            }
            return [...this.pool.candidates].sort((a, b) => a.at - b.at);
        }
        finally {
            full.width = full.height = small.width = small.height = 1;
            this.canvases.delete(full);this.canvases.delete(small);
            if (generation === this.generation) {
                this.worker?.terminate();
                this.worker = undefined;
            }
        }
    }
}
