export function matchGeometry(observations, { start, request, views }) {
  const matchesSize = (view, window) => {
    if (!view) return false;
    const sx = view.deviceScaleFactor * (view.mediaScaleX ?? view.mediaScale ?? 1);
    const sy = view.deviceScaleFactor * (view.mediaScaleY ?? view.mediaScale ?? 1);
    return (
      Math.abs(view.width - Math.round(window.width) * sx) <= 1 &&
      Math.abs(view.height - Math.round(window.height) * sy) <= 1
    );
  };
  const matches = [];
  for (const { viewId, window } of views) {
    const pageHeight = Math.max(120, window.height - window.occludedBottom);
    const signals = observations.wire.filter(
      (e) =>
        e.message.type === 'frame' &&
        e.message.viewports?.some(
          (v) =>
            v.viewId === viewId &&
            v.occlusionRevision === window.occlusionRevision &&
            Math.abs(v.pageHeight - pageHeight) <= 1,
        ),
    );
    const byRtp = new Map();
    for (const signal of signals) {
      if (!byRtp.has(signal.message.rtpTimestamp)) byRtp.set(signal.message.rtpTimestamp, signal);
    }
    const frame = observations.frames.find(
      (f) =>
        f.at >= request.at &&
        f.viewId === viewId &&
        f.layout?.epoch === byRtp.get(f.rtp)?.message.layoutEpoch &&
        f.width === f.layout.width &&
        f.height === f.layout.height &&
        f.layout.views.length === views.length &&
        matchesSize(
          f.layout.views.find((v) => v.id === viewId),
          window,
        ),
    );
    if (!frame) return;
    const input = observations.inputs.find(
      (e) =>
        e.at >= start &&
        e.input[viewId] &&
        matchesSize(e.input[viewId].surface, window) &&
        Math.abs((e.input[viewId].pageHeight ?? window.height) - pageHeight) <= 1,
    );
    if (!input) return;
    matches.push({ viewId, window, frame, signal: byRtp.get(frame.rtp), inputAt: input.at });
  }
  if (!matches.length) return;
  return {
    start,
    request,
    matches,
    end: Math.max(...matches.map((m) => m.frame.at)),
    inputAt: Math.max(...matches.map((m) => m.inputAt)),
    epoch: matches.at(-1).frame.layout.epoch,
  };
}
