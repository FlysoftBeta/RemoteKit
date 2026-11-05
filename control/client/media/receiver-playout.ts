import { diagnostics } from './diagnostics';
export interface ReceiverPlayout {
  jitterBufferTargetSupported: boolean;
  jitterBufferTarget: number | null;
  playoutDelayHintSupported: boolean;
  playoutDelayHint: number | null;
  error?: string;
}

const playoutDelayUri = 'http://www.webrtc.org/experiments/rtp-hdrext/playout-delay';

export function negotiatedReceiverPlayout(receiver?: RTCRtpReceiver) {
  try {
    const extensions = receiver?.getParameters?.()?.headerExtensions;
    return extensions?.some((extension) => extension.uri === playoutDelayUri);
  } catch (error) {
    diagnostics.record('receiver-parameters', error);
    return undefined;
  }
}

/** Feature detection must not create an inert standard property on Chrome89. */
export function configureReceiverPlayout(receiver: RTCRtpReceiver): ReceiverPlayout {
  const target = receiver as RTCRtpReceiver & {
    jitterBufferTarget?: number | null;
    playoutDelayHint?: number | null;
  };
  const result: ReceiverPlayout = {
    jitterBufferTargetSupported: 'jitterBufferTarget' in target,
    jitterBufferTarget: null,
    playoutDelayHintSupported: 'playoutDelayHint' in target,
    playoutDelayHint: null,
  };
  if (result.jitterBufferTargetSupported) {
    try {
      target.jitterBufferTarget = 0;
      result.jitterBufferTarget = target.jitterBufferTarget ?? null;
    } catch {
      result.error = 'jitter-buffer-target-rejected';
    }
  }
  if (result.jitterBufferTarget !== 0 && result.playoutDelayHintSupported) {
    try {
      target.playoutDelayHint = 0;
      result.playoutDelayHint = target.playoutDelayHint ?? null;
    } catch {
      result.error = 'playout-delay-hint-rejected';
    }
  }
  return result;
}
