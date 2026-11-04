/**
 * Summarize the sender, receiver and video callback records from a local lag run.
 * node tools/analyze-ud710-lag.mjs <run directory>
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const [run] = process.argv.slice(2);
assert(run, 'Expected a local lag run directory');

function readJsonLines(content) {
  return content.trim().split(/\r?\n/).map(JSON.parse);
}

const stages = new Map(readJsonLines(readFileSync(join(run, 'diagnostic-collection-results.jsonl'), 'utf8'))
  .map(({stage, value}) => [stage, value]));
assert(stages.has('success') && stages.has('frame-raw'), 'Expected a completed local lag scenario');
const archivePath = stages.get('archive').archivePath;
const archiveName = basename(archivePath);
const ownerName = basename(dirname(archivePath));
const archive = zstdDecompressSync(readFileSync(join(run, 'diagnostics', ownerName, archiveName)), {
  maxOutputLength:32 * 1024 * 1024,
});
const entries = new Map();
for (let offset = 0; archive[offset];) {
  const name = archive.toString('ascii', offset, offset + 100).split('\0')[0];
  const size = Number.parseInt(archive.toString('ascii', offset + 124, offset + 136), 8);
  assert(size > 0 && offset + 512 + size <= archive.length, 'Invalid diagnostic tar member');
  const body = archive.toString('utf8', offset + 512, offset + 512 + size);
  entries.set(name, name.endsWith('.jsonl') ? readJsonLines(body) : JSON.parse(body));
  offset += 512 + Math.ceil(size / 512) * 512;
}

const clients = entries.get('client.jsonl');
const endpoint = entries.get('endpoint.jsonl');
const manifest = entries.get('manifest.json');
const {frames, timeOrigin, dims} = stages.get('frame-raw');
const phases = [...stages].filter(([name]) => name.startsWith('phase-'))
  .map(([name, {wall, offset, client}]) => ({name, wall, offset, client}));
const phaseAt = wall => phases.findLast(row => wall >= row.wall)?.name ?? 'setup';
const frameMetadata = new Map();
for (const row of clients) {
  for (const frame of row.data.presentation?.metadata ?? []) {
    if (!Number.isFinite(frame.atMs) || !Number.isInteger(frame.rtpTimestamp)) continue;
    frameMetadata.set(`${frame.layoutEpoch}:${frame.rtpTimestamp}`, frame);
  }
}
const finite = n => Number.isFinite(n) ? Number(n.toFixed(3)) : undefined;
function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const q = p => finite(sorted[Math.ceil(sorted.length * p) - 1]);
  return {samples:sorted.length, min:finite(sorted[0]), p50:q(.5), p95:q(.95), max:q(1)};
}
const sum = values => values.filter(Number.isFinite).reduce((total, value) => total + value, 0);
const delta = (before, after, key) => Number.isFinite(before[key]) && Number.isFinite(after[key])
  && after[key] >= before[key] ? after[key] - before[key]
  : NaN;
const videoSender = sample => sample.senderRtcStats?.outbound?.find(stream => stream.kind === 'video');
const senderWindows = [];
const skippedSenderWindows = {streamChanged:0, nonIncreasingClock:0, counterReset:0};
for (let i = 1; i < endpoint.length; ++i) {
  const previous = endpoint[i - 1];
  const current = endpoint[i];
  const before = previous.data.stats;
  const after = current.data.stats;
  if (!before || !after) continue;
  const beforeVideo = videoSender(before);
  const afterVideo = videoSender(after);
  if (!beforeVideo || !afterVideo) continue;
  if (beforeVideo.ssrc !== afterVideo.ssrc) {
    skippedSenderWindows.streamChanged++;
    continue;
  }
  const ms = (after.senderRtcStats.sampleTimeUs - before.senderRtcStats.sampleTimeUs) / 1000;
  if (!(ms > 0)) {
    skippedSenderWindows.nonIncreasingClock++;
    continue;
  }
  if (['packetsSent', 'bytesSent', 'totalPacketSendDelay', 'keyFramesEncoded']
    .some(key => afterVideo[key] < beforeVideo[key]) || after.encodedBytes < before.encodedBytes) {
    skippedSenderWindows.counterReset++;
    continue;
  }
  const packets = delta(beforeVideo, afterVideo, 'packetsSent');
  const delayMs = delta(beforeVideo, afterVideo, 'totalPacketSendDelay') * 1000;
  const encodedBytes = delta(before, after, 'encodedBytes');
  const encodedFrames = delta(before, after, 'encodeCompleted');
  const targetStartMbps = before.gccTargetBitrate / 1e6;
  const targetEndMbps = after.gccTargetBitrate / 1e6;
  const midpoint = manifest.startedAt + (previous.elapsedMs + current.elapsedMs) / 2;
  senderWindows.push({
    phase:phaseAt(midpoint), midpoint, ms, packets, delayMs, queueMeanMs:packets > 0 ? delayMs / packets : undefined,
    encodedBytes, encodedFrames, encodedMbps:encodedBytes * 8 / (ms * 1000),
    sentMbps:delta(beforeVideo, afterVideo, 'bytesSent') * 8 / (ms * 1000),
    targetStartMbps, targetEndMbps,
    qsvTargetKbps:after.appliedBitrate / 1000, qsvMaxKbps:after.appliedMaxBitrate / 1000,
    qsvNominalFps:after.appliedFps, observedSourceFps:after.gccTargetFps,
    keyframes:delta(beforeVideo, afterVideo, 'keyFramesEncoded'),
    tailSubmissions:delta(before, after, 'tailIdrSubmissions'), tailCompletions:delta(before, after, 'tailIdrCompletions'),
    rateUpdates:delta(before, after, 'rateUpdates'),
  });
}

const summaries = {};
function idrMetadataBetween(start, end) {
  const received = [...frameMetadata.values()].filter(frame => {
    const wall = frame.atMs + timeOrigin;
    return wall >= start && wall < end;
  });
  const keyframes = received.filter(frame => frame.keyframe === true);
  const sizes = keyframes.map(frame => frame.encodedBytes);
  return {
    observedFrames:received.length,
    observedKeyframes:keyframes.length,
    observedKeyframeBytes:sum(sizes),
    keyframeBytes:distribution(sizes),
  };
}
for (let index = 0; index < phases.length - 1; ++index) {
  const {name, wall} = phases[index];
  const end = phases[index + 1].wall;
  const present = frames.filter(frame => {
    const submittedAt = frame.presentationTime + timeOrigin;
    return submittedAt >= wall && submittedAt < end;
  });
  const client = clients.filter(row => phaseAt(row.data.clientTimeMs + timeOrigin) === name);
  const send = senderWindows.filter(row => row.phase === name);
  const first = present[0];
  const last = present.at(-1);
  const markers = new Map();
  for (const frame of present) {
    if (!frame.marker) continue;
    const key = `${frame.marker.sequence ?? ''}:${frame.marker.value}`;
    if (!markers.has(key)) markers.set(key, frame.marker.delay);
  }
  const firstNewMarker = name.startsWith('phase-motion') &&
    present.find(frame => frame.marker && ((wall - frame.marker.value) | 0) <= 0);
  const sendWithDelay = send.filter(row => row.packets > 0 && Number.isFinite(row.delayMs));
  const byField = (samples, select) => distribution(samples.map(select));
  summaries[name] = {
    durationMs:end - wall,
    callbacks:present.length,
    callbackGapMs:distribution(present.slice(1).map((frame, index) => frame.now - present[index].now)),
    videoFreezeCountObserved:finite(delta(client[0]?.data.rtc.inboundVideo ?? {}, client.at(-1)?.data.rtc.inboundVideo ?? {}, 'freezeCount')),
    videoFreezeDurationObservedMs:finite(delta(client[0]?.data.rtc.inboundVideo ?? {}, client.at(-1)?.data.rtc.inboundVideo ?? {}, 'totalFreezesDuration') * 1000),
    compositorFps:finite(first ? (last.presentedFrames - first.presentedFrames + 1) * 1000 / (end - wall) : 0),
    receiveToSubmitMs:byField(present, frame => frame.presentationTime - frame.receiveTime),
    firstObservedNewMarkerMs:firstNewMarker ? finite(timeOrigin + firstNewMarker.presentationTime - wall) : undefined,
    markerToSubmitMs:distribution([...markers.values()]),
    decodeMs:byField(present, frame => frame.processingDuration * 1000),
    probeDurationMs:byField(present, frame => frame.probeDurationMs),
    frameAssociationDeltaUs:byField(present.filter(frame => frame.marker), frame => frame.snapshotDeltaUs),
    rttMs:byField(client, row => row.data.rtc.selectedPair?.currentRoundTripTime * 1000),
    videoBufferWindowMeanMs:byField(client, row => row.data.media.video?.jitterBufferMeanMs),
    audioBufferWindowMeanMs:byField(client, row => row.data.media.audio?.jitterBufferMeanMs),
    videoTargetBufferWindowMeanMs:byField(client, row => row.data.media.video?.jitterBufferTargetMeanMs),
    videoMinimumBufferWindowMeanMs:byField(client, row => row.data.media.video?.jitterBufferMinimumMeanMs),
    audioTargetBufferWindowMeanMs:byField(client, row => row.data.media.audio?.jitterBufferTargetMeanMs),
    videoAssemblyWindowMeanMs:byField(client, row => row.data.media.video?.assemblyMeanMs),
    videoProcessingWindowMeanMs:byField(client, row => row.data.media.video?.processingMeanMs),
    senderQueuePacketWeightedMs:finite(sum(sendWithDelay.map(row => row.delayMs)) / sum(sendWithDelay.map(row => row.packets))),
    senderQueueWindowMeanMs:byField(send, row => row.queueMeanMs),
    actualEncodedMbps:byField(send, row => row.encodedMbps),
    meanEncodedFrameBytes:finite(sum(send.map(row => row.encodedBytes)) / sum(send.map(row => row.encodedFrames))),
    actualSentMbps:byField(send, row => row.sentMbps),
    gccTargetMbps:byField(send, row => row.targetEndMbps),
    qsvTargetKbps:byField(send, row => row.qsvTargetKbps),
    qsvMaxKbps:byField(send, row => row.qsvMaxKbps),
    qsvNominalFps:byField(send, row => row.qsvNominalFps),
    observedSourceFps:byField(send, row => row.observedSourceFps),
    keyframes:sum(send.map(row => row.keyframes)),
    idrMetadata:idrMetadataBetween(wall, end),
    ...(name.startsWith('phase-motion') ? { firstTwoSecondsIdrMetadata:idrMetadataBetween(wall, wall + 2000) } : {}),
    tailSubmissions:sum(send.map(row => row.tailSubmissions)),
    tailCompletions:sum(send.map(row => row.tailCompletions)),
    rateUpdates:sum(send.map(row => row.rateUpdates)),
  };
}

const endpointLog = readFileSync(join(run, 'control.stderr.log'), 'utf8');
const resets = [...endpointLog.matchAll(/QSV rate Reset: .*newSequence=(\w+) status=(-?\d+)/g)];
const qsvInitializations = [...endpointLog.matchAll(/^QSV actual: (\d+)x(\d+).* RC=(\d+) TargetKbps=(\d+) MaxKbps=(\d+).*$/gm)]
  .map(([, width, height, mode, targetKbps, maxKbps]) => ({
    width:Number(width), height:Number(height), mode:Number(mode), targetKbps:Number(targetKbps), maxKbps:Number(maxKbps),
  }));
const lastEndpoint = endpoint.at(-1).data.stats;
const summary = {
  experiment:stages.get('experiment'),
  markerValidation:stages.get('marker-validation'),
  audioValidation:stages.get('audio-validation'),
  atlas:dims,
  browser:manifest.environment,
  settings:entries.get('control.jsonl').at(-1)?.workspace?.settings,
  mediaPolicy:lastEndpoint.mediaPolicy,
  encoder:lastEndpoint.encoder,
  tailIdrSubmissions:lastEndpoint.tailIdrSubmissions,
  tailIdrCompletions:lastEndpoint.tailIdrCompletions,
  qsvResets:resets.length,
  qsvResetsNewSequence:resets.filter(match => match[1] === 'ON').length,
  qsvResetsNonzeroStatus:resets.filter(match => match[2] !== '0').length,
  qsvInitializations,
  skippedSenderWindows,
  imageQuality:Object.fromEntries([...stages].filter(([name]) => name.startsWith('quality-'))),
  phases,
  summaries,
};
writeFileSync(join(run, 'comparison.json'), JSON.stringify({...summary, senderWindows}, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
