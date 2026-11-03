// Read-only DevTools helper for the ordinary f1b2638 Viewer. No network, SDP,
// cookies, tokens, URLs, page text, input identities or server paths are exported.
(() => {
  let transport;
  outer: for (const element of document.querySelectorAll('*')) {
    const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
    for (let fiber = key && element[key]; fiber; fiber = fiber.return) {
      for (let hook = fiber.memoizedState; hook; hook = hook.next) {
        const value = hook.memoizedState?.current;
        if (value && typeof value.getPresentationDiagnostics === 'function') {
          transport = value; break outer;
        }
      }
    }
  }
  if (!transport) throw Error('请在已连接的 RemoteKit 普通 Viewer 页面运行');
  const pick = (object, keys) => Object.fromEntries(keys.map(key => [key, object?.[key]]));
  const diagnostics = transport.diagnostics, endpoint = diagnostics.endpoint ?? {}, presentation = transport.getPresentationDiagnostics();
  const output = {
    ua: navigator.userAgent, visibility: document.visibilityState,
    frameSource: presentation.frameSource,
    processorFallbackReason: transport.signaling?.processorFallbackReason,
    receiver: pick(diagnostics, ['displayFramesPerSecond', 'decodedFramesPerSecond', 'videoWidth', 'videoHeight', 'receiveBitrateBps', 'roundTripTime']),
    rendering: { ...pick(presentation.rendering, ['backend', 'backendReason', 'plane2dDraws', 'atlasSnapshotCopies']), shared: pick(presentation.rendering?.shared, ['uploads', 'planeDraws', 'failures', 'fallbackReason']) },
    planes: Object.values(presentation.canvasPaintByView ?? {}).map(plane => pick(plane, ['frames', 'redraws', 'fps'])),
    processor: pick(presentation.processor, ['read', 'invalid', 'stale', 'authorized', 'rafCallbacks', 'rafAdmitted', 'replaced', 'width', 'height', 'scheduler', 'scheduling']),
    metadata: pick(presentation.epoch, ['matched', 'missed', 'unknownAtVideo', 'wrongEpochAtVideo', 'missingRtp', 'metadataCount', 'lateMetadataForMissed']),
    source: pick(endpoint, ['sourceWidth', 'sourceHeight', 'encodedWidth', 'encodedHeight', 'mediaScale', 'negotiatedReceiveLevel', 'samplingFpsBudget', 'resolutionLimitation', 'sourceFrameIntervalMs', 'gccTargetBitrate', 'gccTargetFps', 'queueFullDrops']),
    policy: { requested: pick(endpoint.mediaPolicy?.requested, ['degradationPreference', 'maxFps']), applied: pick(endpoint.mediaPolicy?.applied, ['degradationPreference', 'maxFps']) },
    feedback: pick(endpoint, ['feedbackVisible', 'feedbackRafSamples', 'feedbackDisplayHzEstimate', 'feedbackAgeMs', 'feedbackWindowMs', 'feedbackDecodedFrames', 'feedbackVideoFrames']),
  };
  const text = JSON.stringify(output, null, 2);
  console.log(text);
  if (typeof copy === 'function') copy(text);
  return '只读诊断已输出；支持时也已复制到剪贴板';
})();
