export interface ReceiverPlayout {
  jitterBufferTargetSupported: boolean;
  jitterBufferTarget: number | null;
  playoutDelayHintSupported: boolean;
  playoutDelayHint: number | null;
  error?: string;
}

/** Feature detection must not create an inert standard property on Chrome89. */
export function configureReceiverPlayout(receiver: RTCRtpReceiver): ReceiverPlayout {
  const target = receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null; playoutDelayHint?: number | null };
  const result: ReceiverPlayout = {
    jitterBufferTargetSupported: 'jitterBufferTarget' in target,
    jitterBufferTarget: null,
    playoutDelayHintSupported: 'playoutDelayHint' in target,
    playoutDelayHint: null,
  };
  if (result.jitterBufferTargetSupported) {
    try { target.jitterBufferTarget = 0; result.jitterBufferTarget = target.jitterBufferTarget ?? null; }
    catch { result.error = 'jitter-buffer-target-rejected'; }
  }
  if (result.jitterBufferTarget !== 0 && result.playoutDelayHintSupported) {
    try { target.playoutDelayHint = 0; result.playoutDelayHint = target.playoutDelayHint ?? null; }
    catch { result.error = 'playout-delay-hint-rejected'; }
  }
  return result;
}
