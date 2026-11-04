import test from 'node:test';
import assert from 'node:assert/strict';
import { DiagnosticCollection, type DiagnosticRequest, type DiagnosticState } from '../client/diagnostic-collection';
import type { DiagnosticEnvironment, DiagnosticReply } from '../shared/diagnostics';

const environment: DiagnosticEnvironment = {
  browserFamily: 'brave', browserMajorVersion: 138, platform: 'android',
  viewportWidth: 400, viewportHeight: 800, screenWidth: 400, screenHeight: 800,
  devicePixelRatio: 2, screenColorDepth: 24, maxTouchPoints: 5, videoFrameCallbackSupported: true,
};
const reply = (status: DiagnosticReply['status'], reason?: string): DiagnosticReply => ({ id: 'test-id', status, reason });
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('stop freezes capture and waits for the one pending sample before finalizing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests: string[] = [];
  let releaseSample!: (value: DiagnosticReply) => void;
  let state: DiagnosticState | undefined;
  const request: DiagnosticRequest = async (method, params) => {
    requests.push(method);
    if (method === 'diagnostics.sample') {
      assert.deepEqual(params, { id: 'test-id', sequence: 1, data: { measure: 1 } });
      return new Promise(resolve => { releaseSample = resolve; });
    }
    return reply(method === 'diagnostics.start' ? 'collecting' : 'complete', method === 'diagnostics.stop' ? 'user' : undefined);
  };
  const collector = new DiagnosticCollection(request, () => ({ measure: 1 }), next => { state = next; });
  collector.setAvailable(true);
  assert.equal(await collector.start(environment), true);
  t.mock.timers.tick(1000);
  collector.stop();
  t.mock.timers.tick(6000);
  assert.deepEqual(requests, ['diagnostics.start', 'diagnostics.sample']);
  assert.equal(state?.phase, 'finalizing');
  releaseSample(reply('collecting'));
  await settle();
  assert.deepEqual(requests, ['diagnostics.start', 'diagnostics.sample', 'diagnostics.stop']);
  assert.deepEqual(state, { phase: 'complete', id: 'test-id', samples: 1, missingSamples: 0, reason: 'user' });
  collector.dispose();
});

test('an unavailable sample is counted and authorization loss halts capture until terminal status', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests: string[] = [];
  let state: DiagnosticState | undefined;
  let captures = 0;
  const request: DiagnosticRequest = async method => {
    requests.push(method);
    return method === 'diagnostics.start' ? reply('collecting') : reply('complete', 'authorization-changed');
  };
  const collector = new DiagnosticCollection(request, () => { captures++; throw new Error('capture unavailable'); },
    next => { state = next; });
  collector.setAvailable(true);
  await collector.start(environment);
  t.mock.timers.tick(1000);
  collector.setAvailable(false);
  t.mock.timers.tick(5000);
  assert.equal(captures, 1);
  assert.deepEqual(requests, ['diagnostics.start']);
  collector.setAvailable(true);
  await settle();
  assert.deepEqual(requests, ['diagnostics.start', 'diagnostics.status']);
  assert.deepEqual(state, { phase: 'complete', id: 'test-id', samples: 0, missingSamples: 1, reason: 'authorization-changed' });
  collector.dispose();
});

test('a lost stop reply keeps the ID and checks status on retry', async () => {
  const requests: string[] = [];
  let state: DiagnosticState | undefined;
  const request: DiagnosticRequest = async method => {
    requests.push(method);
    if (method === 'diagnostics.stop') throw new Error('stop reply lost');
    return method === 'diagnostics.start' ? reply('collecting') : reply('complete', 'user');
  };
  const collector = new DiagnosticCollection(request, () => undefined, next => { state = next; });
  collector.setAvailable(true);
  await collector.start(environment);
  collector.stop();
  await settle();
  assert.deepEqual(state, { phase: 'retry', id: 'test-id', samples: 0, missingSamples: 0, reason: undefined });
  collector.stop();
  await settle();
  assert.deepEqual(requests, ['diagnostics.start', 'diagnostics.stop', 'diagnostics.status']);
  assert.equal(state?.phase, 'complete');
  collector.dispose();
});

test('server-initiated finalization stops capture and polls for the saved ID', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests: string[] = [];
  let state: DiagnosticState | undefined;
  const request: DiagnosticRequest = async method => {
    requests.push(method);
    if (method === 'diagnostics.start') return reply('collecting');
    if (method === 'diagnostics.sample') return reply('finalizing', 'duration-limit');
    return reply('complete', 'duration-limit');
  };
  const collector = new DiagnosticCollection(request, () => ({ measure: 1 }), next => { state = next; });
  collector.setAvailable(true);
  await collector.start(environment);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(state?.phase, 'finalizing');
  t.mock.timers.tick(1000);
  await settle();
  assert.deepEqual(requests, ['diagnostics.start', 'diagnostics.sample', 'diagnostics.status']);
  assert.deepEqual(state, { phase: 'complete', id: 'test-id', samples: 0, missingSamples: 0, reason: 'duration-limit' });
  collector.dispose();
});
