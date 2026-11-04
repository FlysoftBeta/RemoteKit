import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectionEndpointSample, collectionInputSample, collectionRtcSample, InboundMediaSampler, MediaDiagnosticsHistory, type InboundMediaStats } from '../client/media-diagnostics';
import { negotiatedReceiverPlayout } from '../client/receiver-playout';
import { PresentationDiagnostics } from '../client/presentation-diagnostics';

function report(timestamp: number, fields: Partial<InboundMediaStats> = {}): InboundMediaStats {
  return { id: 'inbound', type: 'inbound-rtp', timestamp, ...fields };
}

test('same-window video diagnostics use the emitted, decoded and assembled denominators', () => {
  const sampler = new InboundMediaSampler();
  sampler.sample(report(100, {
    bytesReceived: 1000, jitterBufferEmittedCount: 10, jitterBufferDelay: 3, jitterBufferTargetDelay: 2,
    jitterBufferMinimumDelay: 1, framesDecoded: 10, totalDecodeTime: 1, totalProcessingDelay: 2,
    framesAssembledFromMultiplePackets: 8, totalAssemblyTime: 1, packetsLost: 3,
    packetsReceived: 10, retransmittedPacketsReceived: 1, retransmittedBytesReceived: 50, nackCount: 2, pliCount: 1, framesDropped: 1,
  }));
  const sample = sampler.sample(report(1100, {
    bytesReceived: 2000, jitterBufferEmittedCount: 20, jitterBufferDelay: 6, jitterBufferTargetDelay: 4,
    jitterBufferMinimumDelay: 2, framesDecoded: 18, totalDecodeTime: 2, totalProcessingDelay: 4,
    framesAssembledFromMultiplePackets: 12, totalAssemblyTime: 2, packetsLost: 2,
    packetsReceived: 25, retransmittedPacketsReceived: 4, retransmittedBytesReceived: 150, nackCount: 6, pliCount: 1, framesDropped: 2,
    jitter: .003, decoderImplementation: 'ExternalDecoder (MediaCodec)', powerEfficientDecoder: false,
  }));
  assert.equal(sample.bitrateBps, 8000);
  assert.equal(sample.decodedFps, 8);
  assert.deepEqual(sample.buffer, {
    windowMs: 1000, jitterBufferEmitted: 10, jitterBufferMeanMs: 300,
    jitterBufferTargetMeanMs: 200, jitterBufferMinimumMeanMs: 100,
  });
  assert.deepEqual(sample.video, {
    ...sample.buffer, decodeMeanMs: 125, processingMeanMs: 250, assemblyMeanMs: 250, multiPacketFrames: 4,
    packetJitterMs: 3, lostPackets: -1, retransmittedPackets: 3, nackCount: 4, pliCount: 0,
    receivedPackets: 15, receivedBytes: 1000, retransmittedBytes: 100,
    receivedPacketRetransmitRatio: .2, receivedByteRetransmitRatio: .1,
    decoderImplementation: 'ExternalDecoder (MediaCodec)', powerEfficientDecoder: false, droppedFrames: 1,
  });
});

test('receive retransmit ratios distinguish zero retransmits from unavailable windows', () => {
  const sampler = new InboundMediaSampler();
  const sample = (at: number, packetsReceived: number, retransmittedPacketsReceived?: number) =>
    sampler.sample(report(at, { packetsReceived, retransmittedPacketsReceived })).video.receivedPacketRetransmitRatio;
  assert.equal(sample(1000, 10, 0), undefined);
  assert.equal(sample(2000, 20, 0), 0);
  assert.equal(sample(3000, 20, 0), undefined);
  assert.equal(sample(4000, 30), undefined);
  assert.equal(sample(5000, 40, 4), undefined);
  assert.equal(sample(6000, 50, 2), undefined);
  assert.equal(sample(7000, 51, 4), undefined);
});

test('audio samples use their own report windows and legacy missing counters stay unknown', () => {
  const audio = new InboundMediaSampler(), legacyVideo = new InboundMediaSampler();
  audio.sample(report(100, { jitterBufferEmittedCount: 100, jitterBufferDelay: 2 }));
  legacyVideo.sample(report(100, { framesDecoded: 10, bytesReceived: 100 }));
  const { buffer } = audio.sample(report(1100, { jitterBufferEmittedCount: 200, jitterBufferDelay: 6 }));
  assert.equal(buffer.jitterBufferMeanMs, 40);
  assert.equal(buffer.jitterBufferMinimumMeanMs, undefined);
  const legacy = legacyVideo.sample(report(1100, { framesDecoded: 30, bytesReceived: 200 }));
  assert.equal(legacy.decodedFps, 20);
  assert.equal(legacy.video.assemblyMeanMs, undefined);
  assert.equal(legacy.video.processingMeanMs, undefined);
  assert.equal(legacy.video.jitterBufferTargetMeanMs, undefined);
  assert.equal(legacy.video.powerEfficientDecoder, undefined);
});

test('out-of-order polls, counter decreases, stream changes and peer resets do not create spurious deltas', () => {
  const sampler = new InboundMediaSampler();
  sampler.sample(report(100, { framesDecoded: 10, jitterBufferEmittedCount: 10 }));
  assert.equal(sampler.sample(report(99, { framesDecoded: 1 })).decodedFps, undefined);
  assert.equal(sampler.sample(report(1100, { framesDecoded: 8, jitterBufferEmittedCount: 8 })).decodedFps, undefined);
  assert.equal(sampler.sample(report(2100, { framesDecoded: 30, id: 'replacement' })).decodedFps, undefined);
  assert.equal(sampler.sample(report(3100, { framesDecoded: 60, id: 'replacement' })).decodedFps, 30);
  sampler.reset();
  assert.equal(sampler.sample(report(4100, { framesDecoded: 90, id: 'replacement' })).decodedFps, undefined);
});

test('playout extension is an exact negotiated capability with unknown on unsupported browsers', () => {
  const uri = 'http://www.webrtc.org/experiments/rtp-hdrext/playout-delay';
  const receiver = (uris: string[]) => ({ getParameters: () => ({ headerExtensions: uris.map(uri => ({ uri })) }) }) as RTCRtpReceiver;
  assert.equal(negotiatedReceiverPlayout(receiver([uri])), true);
  assert.equal(negotiatedReceiverPlayout(receiver([uri + '/other'])), false);
  assert.equal(negotiatedReceiverPlayout({} as RTCRtpReceiver), undefined);
});

test('history exports the latest thirty scalar samples with local elapsed time and no identifying payload', () => {
  const history = new MediaDiagnosticsHistory();
  const privateValue = 'PRIVATE-ORIGIN-AND-TOKEN';
  const viewId = 'PRIVATE-VIEW-ID';
  const decoder = { decoderImplementation: 'https://private.example', id: privateValue };
  for (let index = 0; index < 35; index++) history.record(5000 + index * 1000, {
    connection: privateValue, channel: privateValue, connectionId: privateValue,
    receiverVideoTiming: decoder,
    receiverVideoPlayoutExtensionNegotiated: false,
    selectedCandidates: { remote: privateValue },
    endpoint: {
      token: privateValue, lastEncodeMs: 11,
      rtcPlayoutDelayRequested: { minMs: 0, maxMs: 50, address: privateValue },
      senderRtcStats: {
        sampleTimeUs: 123456, localCandidate: { address: privateValue },
        selectedPair: { availableOutgoingBitrate: 40000000, ip: privateValue },
        outbound: Array.from({ length: 5 }, (_, stream) => ({
          id: privateValue + stream, kind: 'video', ssrc: privateValue, transportId: privateValue,
          packetsSent: 100, totalPacketSendDelay: .22, retransmittedBytesSent: 88,
        })),
      },
      comp: { presentationRefreshAttempts: 3, presentationRefreshForcedBegins: 2, presentationRefreshSuccesses: 1, id: privateValue },
      queueFullDrops: 2,
    },
    paintFpsByView: { [viewId]: index },
    videoTimingByView: { [viewId]: { callbackFps: 19 } },
  }, viewId);
  const output = history.export('Android Chromium/138');
  assert.equal(output.schema, 1);
  assert.equal(output.userAgent, 'Android Chromium/138');
  assert.equal(output.samples.length, 30);
  assert.equal(output.samples[0].elapsedMs, 0);
  assert.equal(output.samples[0].presentation?.compositorFps, 5);
  assert.equal(output.samples[29].elapsedMs, 29000);
  assert.equal(output.samples[29].presentation?.compositorFps, 34);
  assert.equal(output.samples[29].playout.senderRequestedMaxMs, 50);
  assert.equal(output.samples[29].playout.rtpExtensionNegotiated, false);
  assert.equal(output.samples[29].media.availableOutgoingBitrate, 40000000);
  assert.equal(output.samples[29].comp?.presentationRefreshForcedBegins, 2);
  assert.equal(output.samples[29].comp?.queueFullDrops, 2);
  assert.equal(output.samples[29].sender?.clock, 'endpoint-webrtc-report');
  assert.equal(output.samples[29].sender?.sampleTimeUs, 123456);
  assert.equal(output.samples[29].sender?.outbound.length, 4);
  assert.deepEqual(output.samples[29].sender?.outbound[0], { stream: 1, packetsSent: 100, totalPacketSendDelay: .22, retransmittedBytesSent: 88 });
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE|https:\/\/private/);
});

test('clearing history drops prior samples and requires a fresh Endpoint sender snapshot', () => {
  const history = new MediaDiagnosticsHistory();
  const record = (at: number, sampleTimeUs: number, packetsSent: number, retransmittedPacketsSent = 0, totalPacketSendDelay = 0) => history.record(at, {
    connection: '', channel: '',
    endpoint: { senderRtcStats: { sampleTimeUs, outbound: [{ kind: 'video', id: 'same-id', packetsSent, retransmittedPacketsSent, totalPacketSendDelay }] } },
  });
  record(1000, 1000000, 100);
  history.clear();
  assert.deepEqual(history.export('browser').samples, []);
  record(2000, 1000000, 100);
  record(3000, 1000000, 100);
  record(4000, 4000000, 200);
  record(5000, 5000000, 300, 5, .5);
  record(6000, 5000000, 300, 5, .5);
  record(7000, 6000000, 1);
  const samples = history.export('browser').samples;
  assert.equal(samples[0].elapsedMs, 0);
  assert.deepEqual(samples.map(sample => sample.sender?.outbound[0].stream), [undefined, undefined, 1, 1, 1, 2]);
  assert.equal(samples[3].sender?.outbound[0].packetRetransmitRatio, .05);
  assert.equal(samples[3].sender?.outbound[0].packetSendMeanMs, 5);
  assert.equal(samples[3].sender?.outbound[0].windowMs, 1000);
  assert.equal(samples[4].sender?.outbound[0].windowMs, undefined);
  assert.equal(samples[5].sender?.outbound[0].packetRetransmitRatio, undefined);
});

test('collection projects broad browser and Endpoint stats and only bounded recent input timings', () => {
  const secret = 'PRIVATE-TOKEN';
  const rtc = collectionRtcSample(report(2000, {
    id: secret, framesDecoded: 50, jitter: .01, decoderImplementation: 'ExternalDecoder (MediaCodecVideoDecoder)',
    powerEfficientDecoder: true,
  }), undefined, {
    id: secret, localCandidateId: secret, remoteCandidateId: secret, timestamp: 2000,
    state: 'succeeded', nominated: true, currentRoundTripTime: .01,
  } as RTCIceCandidatePairStats);
  const endpoint = collectionEndpointSample({
    encoder: 'qsv', qsvVpp: 'external', queueWaitUs: 32, comp: { occupied: 2, url: secret },
    qsvLowPower: { requested: 16, queryStatus: -14, label: secret },
    mediaPolicy: { requested: { maxFps: 60, degradationPreference: 'maintain-framerate', token: secret } },
    token: secret,
  });
  const input = collectionInputSample(Array.from({ length: 30 }, (_, at) => ({
    at, phase: 'sent', eventType: 'gesture', action: 'momentum', sourceClock: 'arrival-fallback',
    sampleElapsedUs: at * 1000, sequence: String(at), view: secret, key: secret, text: secret,
  })), [
    { at: 1, type: 'input.result', clientSequence: '1', ok: true },
    { at: 28, type: 'input.result', clientSequence: '27', ok: false, touchState: 'rejected', error: 'stale_layout' },
    { at: 29, type: 'input.result', clientSequence: secret, token: secret, error: secret },
  ], 5);
  assert.equal(rtc.clock, 'browser-rtc-stats');
  assert.equal(rtc.inboundVideo?.decoderImplementation, 'ExternalDecoder (MediaCodecVideoDecoder)');
  assert.equal(rtc.selectedPair?.currentRoundTripTime, .01);
  assert.equal(endpoint?.qsvLowPower?.queryStatus, -14);
  assert.equal(endpoint?.comp?.occupied, 2);
  assert.equal(input.trace.length, 24);
  assert.equal(input.trace[0].atMs, 6);
  assert.equal(input.trace[21].sequence, '27');
  assert.equal(input.results[0].sequence, '27');
  assert.equal(input.results[0].reason, 'stale_layout');
  assert.equal(input.results[1].sequence, undefined);
  assert.equal(input.results[1].reason, undefined);
  assert.doesNotMatch(JSON.stringify({ rtc, endpoint, input }), /PRIVATE/);
});

test('collection gets bounded per-frame browser timings without exposing a view identifier', () => {
  const presentation = new PresentationDiagnostics();
  for (let index = 0; index < 40; index++) presentation.video(index, index + 9000, '2', '2', {
    presentedFrames: index + 1, presentationTime: index - 1, expectedDisplayTime: index + 1,
    receiveTime: index - 10, processingDuration: .003,
  }, 'PRIVATE-VIEW');
  assert.equal(presentation.recentVideo(0).length, 32);
  const tail = presentation.recentVideo(38);
  assert.equal(tail.length, 2);
  assert.deepEqual(tail[0], {
    atMs: 38, rtpTimestamp: 9038, presentedFrames: 39, expectedDisplayTimeMs: 39,
    presentationTimeMs: 37, receiveTimeMs: 28, processingDurationSeconds: .003,
  });
  assert.doesNotMatch(JSON.stringify(tail), /PRIVATE/);
});
