import type { Diagnostics } from './types';

export function statsViewModel(diagnostics: Diagnostics, viewId?: string) {
  const endpoint = diagnostics.endpoint;
  const requested = endpoint?.rtcPlayoutDelayRequested as { maxMs?: number } | undefined;
  return {
    presentationFps: viewId ? diagnostics.paintFpsByView?.[viewId] : diagnostics.displayFramesPerSecond,
    videoTiming: viewId ? diagnostics.videoTimingByView?.[viewId] : undefined,
    receiverTiming: diagnostics.receiverVideoTiming,
    inputFps: endpoint?.gccTargetFps,
    targetBitrate: endpoint?.gccTargetBitrate,
    queueFullDrops: endpoint?.queueFullDrops,
    playoutExtension: diagnostics.receiverVideoPlayoutExtensionNegotiated,
    requestedPlayoutCap: requested?.maxMs,
    mediaPolicy: endpoint?.mediaPolicy as
      | {
          requested?: { maxFps?: number; degradationPreference?: string };
          applied?: { maxFps?: number; degradationPreference?: string };
        }
      | undefined,
  };
}
