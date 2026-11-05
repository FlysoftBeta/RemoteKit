/**
 * Preparation for a serial audio/no-audio experiment. No product policy changes.
 * REMOTEKIT_QA_UD710_AUDIO=on|off (required). Uses the existing 70-second stimulus.
 */
import assert from 'node:assert/strict';
import { createMarkerCodec } from './ud710-marker.mjs';
import { createScenario as createBaseScenario, createScrollStimulus } from './ud710-lag-scenario.mjs';
export { viewport, endpointArgs, controlEnvironment } from './ud710-lag-scenario.mjs';

const audio = process.env.REMOTEKIT_QA_UD710_AUDIO;
assert(['on', 'off'].includes(audio), 'Set REMOTEKIT_QA_UD710_AUDIO=on or off');
assert(
  !process.env.REMOTEKIT_QA_UD710_RATE_CONTROL || process.env.REMOTEKIT_QA_UD710_RATE_CONTROL === 'vbr',
  'The audio isolation experiment requires the VBR baseline',
);
export const receiverAudio = audio === 'on' ? 'recvonly' : 'inactive';
const probeMode = process.env.REMOTEKIT_QA_UD710_PROBE ?? 'checked';
assert(['checked', 'metadata-only'].includes(probeMode), 'Invalid marker probe mode');

function installProbe(createCodec, checked) {
  const codec = createCodec();
  const video = document.querySelector('.remote-video-plane video');
  if (!video || (checked && typeof VideoFrame !== 'function') || !video.requestVideoFrameCallback)
    throw Error('The checked marker experiment requires VideoFrame and rVFC');
  const canvas = document.createElement('canvas');
  canvas.width = codec.width;
  canvas.height = codec.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const probe = window.diagnosticQA;
  probe.lagFrames = [];
  probe.lagDims = [video.videoWidth, video.videoHeight];
  probe.lagClockOffset = () => Date.now() - (performance.timeOrigin + performance.now());
  probe.lagProbe = {
    version: checked ? 'crc16-frame-timestamp-v1' : 'metadata-only',
    every: 4,
    attempted: 0,
    valid: 0,
    rejected: {},
  };
  const reject = (reason) => (probe.lagProbe.rejected[reason] = (probe.lagProbe.rejected[reason] ?? 0) + 1);
  function record(now, data) {
    const row = { now, ...data, marker: null };
    if (checked && probe.lagFrames.length % probe.lagProbe.every === 0) {
      const began = performance.now();
      probe.lagProbe.attempted++;
      let snapshot;
      try {
        const layout = probe.latestLayout;
        const plane = layout?.planes?.[0];
        if (
          layout?.planes?.length !== 1 ||
          layout.reconfiguring ||
          !plane?.ready ||
          plane.mediaScaleX !== 1 ||
          plane.mediaScaleY !== 1 ||
          layout.width !== video.videoWidth ||
          layout.height !== video.videoHeight
        ) {
          reject('layout');
        } else {
          // Freeze the element's current pixels, then compare their real media
          // timestamp with the callback; never assign the callback time to them.
          snapshot = new VideoFrame(video);
          row.snapshotTimestampUs = snapshot.timestamp;
          row.snapshotDeltaUs = snapshot.timestamp - data.mediaTime * 1e6;
          if (!Number.isFinite(row.snapshotDeltaUs) || Math.abs(row.snapshotDeltaUs) > 1000) {
            reject('frame-mismatch');
          } else {
            ctx.drawImage(
              snapshot,
              plane.x,
              plane.y,
              codec.width,
              codec.height,
              0,
              0,
              codec.width,
              codec.height,
            );
            const marker = codec.readPixels(ctx.getImageData(0, 0, codec.width, codec.height).data);
            if (!marker.ok) reject(marker.reason);
            else {
              const delay = (performance.timeOrigin + data.presentationTime - marker.value) | 0;
              if (delay < 0 || delay >= 10000) reject('time-range');
              else {
                row.marker = { ...marker, delay };
                probe.lagProbe.valid++;
              }
            }
          }
        }
      } catch (error) {
        reject('exception');
        probe.lagProbe.lastError = String(error);
      } finally {
        snapshot?.close();
        row.probeDurationMs = performance.now() - began;
      }
    }
    probe.lagFrames.push(row);
    video.requestVideoFrameCallback(record);
  }
  video.requestVideoFrameCallback(record);
}

export function validateAudioEvidence(client, endpointSamples, expected) {
  assert(['on', 'off'].includes(expected));
  assert(
    client.some((sample) => sample.rtc?.inboundVideo?.bytesReceived > 0) &&
      endpointSamples.some((sample) =>
        sample.stats?.senderRtcStats?.outbound?.some(
          (stream) => stream.kind === 'video' && stream.bytesSent > 0,
        ),
      ),
    'Missing live RTC reports; audio absence cannot be established',
  );
  const received = client.map((sample) => sample.rtc?.inboundAudio).filter(Boolean);
  const sent = endpointSamples
    .flatMap((sample) => sample.stats?.senderRtcStats?.outbound ?? [])
    .filter((stream) => stream.kind === 'audio');
  const maximum = (rows, key) => Math.max(0, ...rows.map((row) => row[key]).filter(Number.isFinite));
  const evidence = {
    expected,
    inboundSamples: received.length,
    outboundSamples: sent.length,
    packetsReceived: maximum(received, 'packetsReceived'),
    bytesReceived: maximum(received, 'bytesReceived'),
    packetsSent: maximum(sent, 'packetsSent'),
    bytesSent: maximum(sent, 'bytesSent'),
  };
  if (expected === 'off') {
    assert.equal(
      evidence.packetsReceived + evidence.bytesReceived + evidence.packetsSent + evidence.bytesSent,
      0,
      'Audio-off run still carried audio RTP',
    );
  } else {
    assert(
      evidence.packetsReceived > 0 &&
        evidence.packetsSent > 0 &&
        evidence.bytesReceived > 0 &&
        evidence.bytesSent > 0,
      'Audio-on run lacks sender/receiver evidence of delivered audio',
    );
  }
  return evidence;
}

export function createScenario() {
  const codec = createMarkerCodec();
  const stimulus = createScrollStimulus({
    markerWidth: codec.width,
    markerHeight: codec.height,
    markerScript: `const markerCodec = (${createMarkerCodec.toString()})();
      let markerSequence = 0;
      function marker() { markerCodec.draw(ctx, markerCodec.encode(Date.now(), markerSequence++)); }`,
  });
  const base = createBaseScenario({
    stimulus,
    start: async ({ page }) => {
      const state = await page.evaluate(() => window.diagnosticQA.media());
      assert.deepEqual(
        state.transceivers.filter((row) => row.kind === 'audio').map((row) => row.direction),
        [receiverAudio],
        'Audio negotiation does not match the selected experiment',
      );
      await page.evaluate(
        `(${installProbe.toString()})(${createMarkerCodec.toString()}, ${probeMode === 'checked'})`,
      );
    },
  });
  return {
    ...base,
    async measure(context) {
      await context.log('experiment', {
        name: 'audio-isolation',
        audio,
        receiverAudio,
        probeMode,
        markerVersion: 'crc16-frame-timestamp-v1',
      });
      await base.measure(context);
      const probe = await context.read('diagnosticQA.lagProbe');
      await context.log('marker-validation', probe);
      if (probeMode === 'checked')
        assert(
          probe.valid >= 100 && probe.valid / probe.attempted >= 0.8,
          'Insufficient checked marker coverage; this run cannot establish marker latency',
        );
      else assert.equal(probe.attempted, 0, 'Metadata-only control performed pixel reads');
    },
    async validateArchive({ client, endpointSamples, log }) {
      const evidence = validateAudioEvidence(client, endpointSamples, audio);
      await log('audio-validation', evidence);
    },
  };
}
