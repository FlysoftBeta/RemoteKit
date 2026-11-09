import { RemoteKitError } from '../../shared/errors';
import { diagnostics } from '../media/diagnostics';
import { type FileChannel, type PhotoBurstDecision } from './file-channel';

export type { PhotoBurstDecision } from './file-channel';

export interface CaptureStats {
  samplingMs: number;
  frameCount: number;
  stopReason: 'deadline' | 'quality' | 'aborted' | 'error';
  sourceWidth: number;
  sourceHeight: number;
}

interface CapturedFrame {
  frameId: string;
  blob: Blob;
  preview: Blob;
  width: number;
  height: number;
}

export interface CapturedBurst {
  frames: CapturedFrame[];
  decision: PhotoBurstDecision;
  stats: CaptureStats;
}

interface CaptureOptions {
  viewportWidth: number;
  viewportHeight: number;
  onSamplingEnd?: (stats: CaptureStats) => void;
  onPreview?: (blob: Blob) => void;
}

const sampleIntervalMs = 50;
const maxSamplingMs = 1000;
const maxPixels = 8 * 1024 * 1024;
const maxAnalysisBytes = 44 * 1024;

export function photoCoverCrop(
  sourceWidth: number,
  sourceHeight: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  if (
    [sourceWidth, sourceHeight, viewportWidth, viewportHeight].some(
      (value) => !Number.isFinite(value) || value <= 0,
    )
  ) {
    throw new RemoteKitError('unavailable', '摄像头尚未准备好');
  }
  const aspect = viewportWidth / viewportHeight;
  const cropWidth = Math.min(sourceWidth, sourceHeight * aspect);
  const cropHeight = Math.min(sourceHeight, sourceWidth / aspect);
  const scale = Math.min(1, Math.sqrt(maxPixels / (cropWidth * cropHeight)));
  return {
    x: (sourceWidth - cropWidth) / 2,
    y: (sourceHeight - cropHeight) / 2,
    cropWidth,
    cropHeight,
    width: Math.max(1, Math.floor(cropWidth * scale)),
    height: Math.max(1, Math.floor(cropHeight * scale)),
  };
}

function makeCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function release(canvas: HTMLCanvasElement) {
  canvas.width = canvas.height = 1;
}

function encode(
  canvas: HTMLCanvasElement,
  format: 'image/jpeg' | 'image/png',
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob?.type === format && blob.size ? resolve(blob) : reject(new Error('无法生成照片'))),
      format,
      quality,
    );
  });
}

function draw(
  canvas: HTMLCanvasElement,
  source: CanvasImageSource,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new RemoteKitError('internal', '无法拍照');
  context.drawImage(source, x, y, width, height, 0, 0, canvas.width, canvas.height);
}

interface Snapshot {
  canvas: HTMLCanvasElement;
  preview?: Blob;
}

function validateDecision(decision: PhotoBurstDecision, available: Map<string, Snapshot>) {
  if (
    !decision ||
    typeof decision.stop !== 'boolean' ||
    typeof decision.uncertain !== 'boolean' ||
    typeof decision.reason !== 'string' ||
    !Array.isArray(decision.keepFrameIds) ||
    !Array.isArray(decision.candidates) ||
    decision.candidates.length > 2 ||
    new Set(decision.candidates.map((candidate) => candidate?.frameId)).size !== decision.candidates.length ||
    decision.keepFrameIds.length < 1 ||
    decision.keepFrameIds.length > 2 ||
    new Set(decision.keepFrameIds).size !== decision.keepFrameIds.length ||
    !decision.keepFrameIds.includes(decision.selectedFrameId) ||
    decision.keepFrameIds.some((id) => !available.get(id)?.preview) ||
    decision.candidates.some(
      (candidate) =>
        !candidate || !Number.isFinite(candidate.score) || !decision.keepFrameIds.includes(candidate.frameId),
    )
  ) {
    throw new RemoteKitError('internal', '拍照选片结果无效');
  }
}

/** Freeze distinct source frames during the shutter window. Only retained
 * originals survive to PNG encoding, after releasing the shutter. */
export async function capturePhotoBurst(
  video: HTMLVideoElement,
  signal: AbortSignal,
  rpc: FileChannel,
  options: CaptureOptions,
): Promise<CapturedBurst> {
  if (signal.aborted) throw new RemoteKitError('canceled', '');
  const start = performance.now();
  const deadline = start + maxSamplingMs;
  const { videoWidth: sourceWidth, videoHeight: sourceHeight } = video;
  const crop = photoCoverCrop(sourceWidth, sourceHeight, options.viewportWidth, options.viewportHeight);
  const analysisScale = Math.min(1, 512 / Math.max(crop.width, crop.height));
  const snapshots = new Map<string, Snapshot>();
  let analysis: HTMLCanvasElement | undefined;
  let frameCount = 0;
  let burstId: string | undefined;
  let stats: CaptureStats | undefined;
  let retired = false;
  let failure: unknown;
  let inFlight: Promise<void> | undefined;
  let cancelFrame: (() => void) | undefined;
  let resolveSampling!: (stats: CaptureStats) => void;
  let rejectAbort!: (error: Error) => void;
  const sampling = new Promise<CaptureStats>((resolve) => {
    resolveSampling = resolve;
  });
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  void aborted.catch((error) => diagnostics.record('camera-capture', error));
  const opening = rpc.beginPhotoBurst(signal).then((result) => {
    if (signal.aborted || retired) {
      void rpc.cancelPhotoBurst(result.burstId).catch((error) => diagnostics.record('camera-capture', error));
      throw new RemoteKitError('canceled', '');
    }
    burstId = result.burstId;
    return burstId;
  });
  void opening.catch((error) => diagnostics.record('camera-capture', error));
  const timer = setTimeout(() => stop('deadline'), Math.max(0, deadline - performance.now()));

  function stop(reason: CaptureStats['stopReason']) {
    if (stats) return;
    clearTimeout(timer);
    cancelFrame?.();
    cancelFrame = undefined;
    stats = {
      samplingMs: performance.now() - start,
      frameCount,
      stopReason: reason,
      sourceWidth,
      sourceHeight,
    };
    resolveSampling(stats);
    options.onSamplingEnd?.(stats);
  }
  function releaseSnapshots() {
    for (const { canvas } of snapshots.values()) release(canvas);
    snapshots.clear();
    if (analysis) release(analysis);
    analysis = undefined;
  }
  function abort() {
    rejectAbort(new RemoteKitError('canceled', ''));
    releaseSnapshots();
    stop('aborted');
  }
  signal.addEventListener('abort', abort, { once: true });

  let lastSlot = -1;
  let lastFrameCount: number | undefined;
  let lastMediaTime: number | undefined;
  let previewSent = false;
  async function sample(frameId: string) {
    const canvas = makeCanvas(crop.width, crop.height);
    const snapshot: Snapshot = { canvas };
    snapshots.set(frameId, snapshot);
    try {
      draw(canvas, video, crop.x, crop.y, crop.cropWidth, crop.cropHeight);
      analysis ??= makeCanvas(
        Math.max(1, Math.floor(crop.width * analysisScale)),
        Math.max(1, Math.floor(crop.height * analysisScale)),
      );
      draw(analysis, canvas, 0, 0, crop.width, crop.height);
      for (const quality of [0.8, 0.6, 0.4, 0.2]) {
        const jpeg = await Promise.race([encode(analysis, 'image/jpeg', quality), aborted]);
        if (retired) return;
        if (jpeg.size <= maxAnalysisBytes) {
          snapshot.preview = jpeg;
          break;
        }
        if (stats || performance.now() >= deadline) break;
      }
      if (!snapshot.preview) {
        release(canvas);
        snapshots.delete(frameId);
        return;
      }
      if (!previewSent) {
        previewSent = true;
        options.onPreview?.(snapshot.preview);
      }
      const currentBurstId = await Promise.race([opening, aborted]);
      const decision = await rpc.samplePhotoBurst(
        currentBurstId,
        frameId,
        snapshot.preview,
        [...snapshots.keys()],
        signal,
      );
      if (signal.aborted || retired) return;
      validateDecision(decision, snapshots);
      for (const [id, candidate] of snapshots) {
        if (decision.keepFrameIds.includes(id)) continue;
        release(candidate.canvas);
        snapshots.delete(id);
      }
      if (decision.stop) stop(performance.now() >= deadline ? 'deadline' : 'quality');
    } catch (error) {
      release(canvas);
      snapshots.delete(frameId);
      if ((error instanceof RemoteKitError && error.code === 'busy') || signal.aborted) return;
      failure = error;
      stop('error');
    }
  }
  function onFrame(frameCounter: number, mediaTime?: number) {
    cancelFrame = undefined;
    const now = performance.now();
    if (now >= deadline) stop('deadline');
    if (stats) return;
    const slot = Math.floor((now - start) / sampleIntervalMs);
    const distinct =
      Number.isFinite(frameCounter) &&
      frameCounter > (lastFrameCount ?? 0) &&
      (mediaTime === undefined || (Number.isFinite(mediaTime) && mediaTime > (lastMediaTime ?? -1)));
    if (distinct) {
      lastFrameCount = frameCounter;
      lastMediaTime = mediaTime;
      if (slot > lastSlot) {
        lastSlot = slot;
        if (!inFlight && (!burstId || rpc.canSamplePhotoBurst())) {
          if (video.videoWidth !== sourceWidth || video.videoHeight !== sourceHeight) {
            failure = new Error('相机画面尺寸已变化，请重新拍摄');
            stop('error');
            return;
          }
          const frameId = String(++frameCount);
          inFlight = sample(frameId).finally(() => {
            inFlight = undefined;
          });
        }
      }
    }
    if (!stats) scheduleFrame();
  }
  function scheduleFrame() {
    if (typeof video.requestVideoFrameCallback === 'function') {
      const handle = video.requestVideoFrameCallback((_, frame) =>
        onFrame(frame.presentedFrames, frame.mediaTime),
      );
      cancelFrame = () => video.cancelVideoFrameCallback(handle);
    } else {
      const handle = setTimeout(() => {
        const quality = video.getVideoPlaybackQuality?.();
        const presented = quality
          ? quality.totalVideoFrames - quality.droppedVideoFrames
          : ((video as HTMLVideoElement & { webkitDecodedFrameCount?: number }).webkitDecodedFrameCount ?? 0);
        onFrame(presented);
      }, 16);
      cancelFrame = () => clearTimeout(handle);
    }
  }

  try {
    if (signal.aborted) abort();
    else scheduleFrame();
    const activeBurst = await Promise.race([opening, aborted]);
    const finalStats = await sampling;
    await Promise.race([inFlight, aborted]);
    if (signal.aborted) await aborted;
    if (failure !== undefined) throw failure;
    const decision = await Promise.race([
      rpc.endPhotoBurst(activeBurst, [...snapshots.keys()], signal),
      aborted,
    ]);
    burstId = undefined;
    validateDecision(decision, snapshots);
    const selectedIds = decision.uncertain
      ? [
          decision.selectedFrameId,
          ...decision.candidates
            .map((candidate) => candidate.frameId)
            .filter((id) => id !== decision.selectedFrameId),
        ]
      : [decision.selectedFrameId];
    const frames: CapturedFrame[] = [];
    for (const [id, snapshot] of snapshots) {
      if (!selectedIds.includes(id)) {
        release(snapshot.canvas);
        snapshots.delete(id);
      }
    }
    for (const frameId of selectedIds) {
      const snapshot = snapshots.get(frameId)!;
      const blob = await Promise.race([encode(snapshot.canvas, 'image/png'), aborted]);
      release(snapshot.canvas);
      snapshots.delete(frameId);
      frames.push({ frameId, blob, preview: snapshot.preview!, width: crop.width, height: crop.height });
    }
    return { frames, decision, stats: finalStats };
  } finally {
    retired = true;
    signal.removeEventListener('abort', abort);
    releaseSnapshots();
    if (burstId)
      void rpc.cancelPhotoBurst(burstId).catch((error) => diagnostics.record('camera-capture', error));
    if (!stats) stop('error');
  }
}
