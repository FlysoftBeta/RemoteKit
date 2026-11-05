import { RemoteKitError } from '../shared/errors';
import type { ReceiverPlayout } from './receiver-playout';
import type { ReceiverBufferTiming, ReceiverVideoTiming } from './media-diagnostics';
export type { ReceiverVideoTiming } from './media-diagnostics';
export interface Surface {
  id: string;
  session: string;
  instance: string;
  document: string;
  focus: string;
  x: number;
  y: number;
  width: number;
  height: number;
  deviceScaleFactor: number;
  mediaScale?: number;
  mediaScaleX?: number;
  mediaScaleY?: number;
  stale?: boolean;
}
export interface Layout {
  type: 'layout';
  generation: string;
  epoch: string;
  width: number;
  height: number;
  views: Surface[];
  reconfiguring?: true;
}
export interface VideoPresentation {
  viewId: string;
  rtpTimestamp: number;
  layoutEpoch: string;
  paintedAt: number;
  paintedWallTime: number;
  authorizedAt: number;
}
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
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new RemoteKitError(value?.error?.code ?? 'internal', value?.error?.message ?? '请求失败');
  return value as T;
}
