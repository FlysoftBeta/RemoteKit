// Usage: node tools/summarize-osr-video-profile.mjs develop/tmp/<case>
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

if (process.argv.length !== 3) throw Error('Provide one evidence directory');
const root = resolve(process.argv[2]);
async function optional(path) {
  try {
    return await readFile(join(root, path), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (p) => sorted[Math.ceil(p * sorted.length) - 1] ?? null;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) };
}

const report = JSON.parse(await readFile(join(root, 'video-profile.json'), 'utf8'));
const cleanText = await optional('video-profile-clean.json');
const remote = ((await optional('remote-input.jsonl')) ?? '').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const primary = summarize(report);
const cleanWindow = cleanText ? summarize(JSON.parse(cleanText)) : null;
const result = {
  primary,
  cleanWindow,
  samePeerAcrossWindows:
    cleanWindow && primary.peerAfter?.connectionId
      ? primary.peerAfter?.connectionId === cleanWindow.peerBefore?.connectionId &&
        primary.peerAfter?.trackId === cleanWindow.peerBefore?.trackId
      : null,
};
await writeFile(join(root, 'segment-summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      ...result,
      primary: { ...primary, rows: undefined },
      cleanWindow: cleanWindow && { ...cleanWindow, rows: undefined },
    },
    null,
    2,
  ),
);

function summarize(r) {
  const frames = r.rawVideoFrames.filter((frame) => frame.visible);
  const callbackFrameGaps = frames.slice(1).reduce((sum, frame, index) => {
    const gap = frame.presentedFrames - frames[index].presentedFrames - 1;
    return sum + (Number.isFinite(gap) ? Math.max(0, gap) : 0);
  }, 0);
  const selected = r.rtcSamples.map(({ at, rtc }) => {
    const transport = rtc.find((s) => s.type === 'transport' && s.selectedCandidatePairId);
    const pair = rtc.find((s) => s.id === transport?.selectedCandidatePairId);
    return {
      at,
      pairId: pair?.id,
      rttMs: pair?.currentRoundTripTime * 1000,
      availableIncomingMbps: pair?.availableIncomingBitrate / 1e6,
    };
  });
  const remoteInWindow = remote.filter(
    (event) => event.wall >= r.startedWall && event.wall <= r.startedWall + r.elapsedMs,
  );
  const rows = r.inputSamples.map((input) => {
    const send = r.inputSends.find((candidate) => candidate.stimulus === input.sequence);
    const handler = remoteInWindow.find((candidate) => candidate.stimulus === input.sequence);
    const handlerWall = handler?.handlerWall ?? handler?.wall;
    const marker = input.marker;
    const frame = marker && frames.find((candidate) => candidate.rtpTimestamp === marker.rtp);
    return {
      sequence: input.sequence,
      handlerFrame: handler?.frame,
      pixelFrame: marker?.frameId,
      eventToSendMs: send?.at - input.eventAt,
      sendToRemoteHandlerMs: handlerWall - (r.timeOrigin + send?.at),
      handlerDrawCallMs: handler?.at - handler?.handlerAt,
      handlerToSampledMarkerDrawMs:
        marker && marker.renderToObservedMs !== null
          ? marker.observedWall - marker.renderToObservedMs - handlerWall
          : null,
      handlerToSampledVideoReceiveMs: r.timeOrigin + frame?.receiveTime - handlerWall,
      receiveToSubmitMs: frame?.presentationTime - frame?.receiveTime,
      submitToCallbackMs: marker?.observedAt - frame?.presentationTime,
      eventToCallbackMs: input.callbackDelayMs,
      eventToExpectedDisplayMs: input.expectedDisplayDelayMs,
    };
  });
  const stageNames = [
    'eventToSendMs',
    'sendToRemoteHandlerMs',
    'handlerDrawCallMs',
    'handlerToSampledMarkerDrawMs',
    'handlerToSampledVideoReceiveMs',
    'receiveToSubmitMs',
    'submitToCallbackMs',
    'eventToCallbackMs',
    'eventToExpectedDisplayMs',
  ];
  const stage = Object.fromEntries(stageNames.map((key) => [key, distribution(rows.map((row) => row[key]))]));
  const metadata = new Map(r.frameMetadata.map((frame) => [frame.rtp, frame.at]));
  const frameStages = Object.fromEntries(
    Object.entries({
      receiveToSubmit: frames.map((frame) => frame.presentationTime - frame.receiveTime),
      processing: frames.map((frame) => frame.processingDuration * 1000),
      submitToCallback: frames.map((frame) => frame.at - frame.presentationTime),
      callbackMinusExpectedDisplay: frames.map((frame) => frame.at - frame.expectedDisplayTime),
      metadataRelativeToCallback: frames.map((frame) => metadata.get(frame.rtpTimestamp) - frame.at),
    }).map(([key, samples]) => [key, distribution(samples)]),
  );
  const before = r.rtcSamples[0],
    after = r.rtcSamples[r.rtcSamples.length - 1];
  const inbound = (sample) =>
    sample.rtc.find((s) => s.type === 'inbound-rtp' && (s.kind ?? s.mediaType) === 'video');
  const first = inbound(before),
    last = inbound(after);
  const sameInbound = first?.id && first.id === last?.id;
  const delta = (key) => (sameInbound ? last[key] - first[key] : NaN);
  const beforeEndpoint = before.diagnostics?.endpoint,
    afterEndpoint = after.diagnostics?.endpoint;
  const endpointDelta = (start, end, keys) =>
    Object.fromEntries(
      keys.map((key) => [
        key,
        Number.isFinite(start?.[key]) && Number.isFinite(end?.[key]) ? end[key] - start[key] : null,
      ]),
    );
  return {
    markerMode: r.markerMode ?? 'sync45',
    startedAt: r.startedAt,
    elapsedMs: r.elapsedMs,
    clientVersion: r.clientVersion,
    viewer: r.viewer,
    layout: r.actualLayout,
    clock: r.clock,
    clockSample: r.clockSample,
    peerBefore: before.peer,
    peerAfter: after.peer,
    selected,
    selectedRttMs: distribution(selected.map((pair) => pair.rttMs)),
    visibleCompositorFps: r.visibleCompositorFps,
    visibleCallbackFps: r.visibleCallbackFps,
    visibleCallbacks: frames.length,
    callbackFrameGaps,
    decodedFps: r.decodedFps,
    receivedVideoMbps: r.receivedVideoMbps,
    playbackQualityDelta: r.playbackQualityDelta,
    backend: r.presentation.rendering.backend,
    rtcPlayoutDelayRequested: afterEndpoint?.rtcPlayoutDelayRequested,
    receiverPlayout: after.diagnostics?.receiverPlayout,
    endpointDelta: endpointDelta(beforeEndpoint, afterEndpoint, [
      'atlasDeliveredFrames',
      'encodeSubmitted',
      'encodeCompleted',
      'encodeDropped',
      'encodedBytes',
      'rateUpdates',
      'queueFullDrops',
      'errorDrops',
    ]),
    compDelta: endpointDelta(beforeEndpoint?.comp, afterEndpoint?.comp, [
      'begins',
      'readyObserved',
      'rejectNotReady',
      'adaptDrops',
      'adaptErrors',
    ]),
    markerReads: r.markerReads,
    markerReadCostMs: r.markerReadCostMs,
    invalidMarkers: r.invalid,
    markerCapacitySkipped: r.markerReadback?.capacitySkipped,
    renderToObservedMs: r.renderToObservedMs,
    inputs: rows.length,
    matchedInputs: rows.filter((row) => Number.isFinite(row.eventToCallbackMs)).length,
    stage,
    frameStages,
    rtcMeanMs: {
      jitterBuffer: (1000 * delta('jitterBufferDelay')) / delta('jitterBufferEmittedCount'),
      decode: (1000 * delta('totalDecodeTime')) / delta('framesDecoded'),
      processing: (1000 * delta('totalProcessingDelay')) / delta('framesDecoded'),
    },
    rows,
  };
}
