import type { ReceiverBufferTiming, ReceiverVideoTiming } from './media-diagnostics';
import type { ReceiverPlayout } from './receiver-playout';
export type { ReceiverVideoTiming } from './media-diagnostics';
interface TimingPercentile {
  samples: number;
  p95: number;
}
export interface VideoPlaneTiming {
  callbackFps?: number;
  videoElementFps?: number;
  videoElementDrops?: number;
  receiveToSubmit?: TimingPercentile;
  submitToCallback?: TimingPercentile;
  expectedDisplayLateness?: TimingPercentile;
  processing?: TimingPercentile;
}
export interface RenderingDiagnostics {
  backend: 'pending' | 'video' | 'unavailable';
  backendReason?: string;
  videoCompositorByView?: Record<string, { frames: number; callbacks: number; fps?: number }>;
  visibility?: string;
  freezeCopies: number;
  mediaRefreshRequests: number;
}
export interface Diagnostics {
  receiverPlayout?: Partial<Record<'video' | 'audio', ReceiverPlayout>>;
  rendering?: RenderingDiagnostics;
  receiveSelection?: { profile: string; reason: string };
  presentationEstimate?: { presentationLatencyMs: number; clockUncertaintyMs: number; sampleCount: number };
  connection: string;
  channel: string;
  framesDecoded?: number;
  framesPerSecond?: number;
  displayFramesPerSecond?: number;
  decodedFramesPerSecond?: number;
  paintFpsByView?: Record<string, number | undefined>;
  videoTimingByView?: Record<string, VideoPlaneTiming>;
  receiverVideoTiming?: ReceiverVideoTiming;
  receiverAudioTiming?: ReceiverBufferTiming;
  receiverVideoPlayoutExtensionNegotiated?: boolean;
  markerSampleHz?: number;
  bytesReceived?: number;
  receiveBitrateBps?: number;
  roundTripTime?: number;
  codec?: string;
  videoWidth?: number;
  videoHeight?: number;
  endpoint?: Record<string, unknown>;
  error?: string;
  selectedCandidates?: unknown;
  connectionId?: string;
  marker?: { kind: 'input' | 'render'; p50: number; p95: number; samples: number };
}
