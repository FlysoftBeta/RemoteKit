/** A bounded short sequence, with ranking delegated to Endpoint. */
export async function capturePhotoBurst(video: HTMLVideoElement, signal: AbortSignal) {
    const maxPixels = 4 * 1024 * 1024;
    const scale = Math.min(1, Math.sqrt(maxPixels / (video.videoWidth * video.videoHeight)));
    if (!video.videoWidth || !video.videoHeight) throw new Error('摄像头尚未准备好');
    const full = document.createElement('canvas'), preview = document.createElement('canvas');
    full.width = Math.max(1, Math.floor(video.videoWidth * scale));
    full.height = Math.max(1, Math.floor(video.videoHeight * scale));
    const previewScale = Math.min(1, 320 / Math.max(full.width, full.height));
    preview.width = Math.max(1, Math.floor(full.width * previewScale));
    preview.height = Math.max(1, Math.floor(full.height * previewScale));
    const fullContext = full.getContext('2d'), previewContext = preview.getContext('2d');
    if (!fullContext || !previewContext) throw new Error('无法拍照');
    const encode = (canvas: HTMLCanvasElement, quality: number) => new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法生成照片')), 'image/jpeg', quality);
    });
    const check = () => { if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); };
    const snapshots: { blob: Blob; preview: Blob }[] = [];
    let bytes = 0;
    const start = performance.now();
    try {
        for (let index = 0; index < 6; index++) {
            check();
            if (index && performance.now() - start >= 850) break;
            const capturedAt = performance.now();
            fullContext.drawImage(video, 0, 0, full.width, full.height);
            previewContext.drawImage(full, 0, 0, preview.width, preview.height);
            const [blob, small] = await Promise.all([encode(full, .9), encode(preview, .75)]);
            check();
            bytes += blob.size + small.size;
            if (bytes > 24 * 1024 * 1024) {
                if (!snapshots.length) throw new Error('照片数据超出拍摄限制');
                break;
            }
            snapshots.push({ blob, preview: small });
            if (index < 5) await new Promise(resolve => setTimeout(resolve, Math.max(0, 100 - (performance.now() - capturedAt))));
        }
        return snapshots;
    } finally {
        full.width = full.height = preview.width = preview.height = 1;
    }
}
