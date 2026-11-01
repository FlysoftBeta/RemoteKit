// Chromium's Window MSTP API is not included in TypeScript's DOM declarations.
export type ProcessorVideoFrame = VideoFrame & { metadata(): { rtpTimestamp?: number } };
export interface TrackProcessor {
  readable: ReadableStream<ProcessorVideoFrame>;
  readonly totalFrames?: number;
  readonly discardedFrames?: number;
}
export type TrackProcessorConstructor = new (options: { track: MediaStreamTrack; maxBufferSize: number }) => TrackProcessor;
export function createTrackProcessor(track: MediaStreamTrack): TrackProcessor {
  const Constructor = (globalThis as typeof globalThis & { MediaStreamTrackProcessor?: TrackProcessorConstructor }).MediaStreamTrackProcessor;
  if (typeof Constructor !== 'function') throw new Error('浏览器缺少 MediaStreamTrackProcessor；请使用支持的客户端或显式选择 video 接收路径。');
  return new Constructor({ track, maxBufferSize: 1 });
}
export function processorRtpTimestamp(frame: ProcessorVideoFrame): number {
  const rtp = frame.metadata().rtpTimestamp;
  if (!Number.isInteger(rtp) || rtp! < 0 || rtp! > 0xffffffff) throw new Error('VideoFrame.metadata().rtpTimestamp 缺失或不是 uint32，画面与输入已暂停。');
  return rtp!;
}
