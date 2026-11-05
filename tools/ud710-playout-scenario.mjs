/** Serial 50/10ms receiver experiment; existing Endpoint option only. */
import assert from 'node:assert/strict';
import { createScenario as createAudioScenario, endpointArgs as baseArgs } from './ud710-av-scenario.mjs';
export { viewport, controlEnvironment, receiverAudio } from './ud710-av-scenario.mjs';

const maximum = Number(process.env.REMOTEKIT_QA_UD710_PLAYOUT_MAX_MS);
assert([10, 50].includes(maximum), 'Set REMOTEKIT_QA_UD710_PLAYOUT_MAX_MS=10 or 50');
assert.equal(process.env.REMOTEKIT_QA_UD710_AUDIO, 'on');
assert.equal(process.env.REMOTEKIT_QA_UD710_PROBE ?? 'checked', 'checked');
export const endpointArgs = [...baseArgs, '--rtc-playout-max-ms=' + maximum];

export function createScenario() {
  const base = createAudioScenario();
  return {
    ...base,
    async measure(context) {
      await context.log('playout-experiment', { requestedMinMs: 0, requestedMaxMs: maximum });
      await base.measure(context);
    },
    async validateArchive(context) {
      await base.validateArchive(context);
      const requested = context.endpointSamples
        .map((row) => row.stats?.rtcPlayoutDelayRequested)
        .filter(Boolean);
      assert(requested.length > 0, 'Missing Endpoint playout request telemetry');
      assert(
        requested.every((row) => row.minMs === 0 && row.maxMs === maximum),
        'Endpoint playout request differs',
      );
      const playout = context.client
        .map((row) => row.media?.playout)
        .filter((row) => row?.senderRequestedMaxMs !== undefined);
      assert(playout.length > 0, 'Missing Viewer playout readback');
      assert(
        playout.every(
          (row) =>
            row.senderRequestedMinMs === 0 &&
            row.senderRequestedMaxMs === maximum &&
            row.rtpExtensionNegotiated === true &&
            row.videoTargetMs === 0,
        ),
        'Viewer playout readback differs',
      );
      await context.log('playout-validation', {
        endpointSamples: requested.length,
        clientSamples: playout.length,
        requested: requested.at(-1),
        receiver: playout.at(-1),
      });
    },
  };
}
