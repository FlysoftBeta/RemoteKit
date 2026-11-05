import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestTracker } from '../client/util/request-tracker';
import { RemoteKitError } from '../shared/errors';
import { OperationsStore } from '../client/control/operations-store';
import { ControlSession } from '../client/control/control-session';
import { decodeIncoming, encodeOutgoing, type Outgoing } from '../client/rtc/protocol';
import { EndpointChannel } from '../client/rtc/endpoint-channel';
import { diagnostics } from '../client/media/diagnostics';
import { productSnapshot } from './client-fixture';
import { AuthorizationScope } from '../client/auth/authorization-scope';

test('authorization advances its scope only on lock or peer epoch transitions', () => {
  const scope = new AuthorizationScope({ rtc: { attempt: 1 }, endpoint: { channel: null } });
  const resets: number[] = [];
  scope.resets.subscribe((token) => resets.push(token));
  scope.observePeerAuthorization(1);
  scope.setProductLocked(false);
  scope.setProductLocked(false);
  assert.deepEqual(resets, [1]);
  scope.setProductLocked(true);
  scope.observePeerAuthorization(2);
  assert.deepEqual(resets, [1, 2, 3]);
  assert.equal(scope.getSnapshot().locked, true);
  assert.equal(scope.getSnapshot().peerEpoch, 2);
});

test('request correlation cleans up synchronous send failure, deadlines and scope changes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const tracker = new RequestTracker<number>();
  await assert.rejects(
    tracker.request('one', 20, () => {
      throw new Error('closed');
    }),
    { code: 'unavailable' },
  );
  assert.equal(tracker.size, 0);
  const expired = assert.rejects(
    tracker.request('two', 20, () => {}),
    { code: 'outcome_unknown' },
  );
  t.mock.timers.tick(20);
  await expired;
  const revoked = assert.rejects(
    tracker.request('three', 20, () => {}),
    { code: 'outcome_unknown' },
  );
  tracker.setScope('replacement');
  await revoked;
  assert.equal(tracker.resolve('three', 1), false);
  assert.equal(tracker.size, 0);
});

for (const status of ['accepted', 'applying', 'committed', 'unknown', 'rejected', 'expired'] as const)
  test(`operations preserve ${status} as an execution outcome without replay`, async (t) => {
    const sent: Extract<Outgoing, { type: 'product.action' }>[] = [];
    const store = new OperationsStore({
      ready: () => true,
      send: (message) => {
        if (message.type === 'product.action') sent.push(message);
      },
      status: async () => {
        throw new Error('offline');
      },
    });
    t.after(() => store.reset());
    store.acceptSnapshot(productSnapshot());
    const result = store.action({ type: 'window.create' });
    const rejection = ['rejected', 'expired'].includes(status)
      ? assert.rejects(result, { code: 'rejected' })
      : undefined;
    const operation = sent[0];
    assert.equal('phase' in operation, false);
    const receipt = {
      operationId: operation.operationId,
      operationGeneration: operation.operationGeneration,
      status,
      revision: 2,
    };
    store.handle({
      type: 'product.result',
      version: 1,
      operationId: operation.operationId,
      operationGeneration: operation.operationGeneration,
      result: receipt,
    });
    if (rejection) await rejection;
    else assert.equal((await result).status, status);
    assert.equal(sent.length, 1);
    if (status === 'unknown') {
      store.dismissUnknown();
      assert.equal(store.getSnapshot().pending.length, 0);
    }
  });

test('operation polling follows receipts and authoritative revision retires a committed projection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let operation!: Extract<Outgoing, { type: 'product.action' }>;
  const store = new OperationsStore({
    ready: () => true,
    send: (message) => {
      if (message.type === 'product.action') operation = message;
    },
    status: async () => ({
      operationId: operation.operationId,
      operationGeneration: operation.operationGeneration,
      status: 'committed',
      revision: 2,
    }),
  });
  t.after(() => store.reset());
  store.acceptSnapshot(productSnapshot());
  const response = store.action({ type: 'window.create' });
  const receipt = {
    operationId: operation.operationId,
    operationGeneration: operation.operationGeneration,
    status: 'applying' as const,
  };
  store.handle({
    type: 'product.result',
    version: 1,
    operationId: operation.operationId,
    operationGeneration: operation.operationGeneration,
    result: receipt,
  });
  await response;
  t.mock.timers.tick(2000);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(store.getSnapshot().pending[0].phase, 'committed');
  const state = productSnapshot();
  state.snapshotSequence = 2;
  state.workspace.revision = 2;
  store.acceptSnapshot(state);
  assert.equal(store.getSnapshot().pending.length, 0);
  assert.equal(store.getSnapshot().state?.workspace.windows.length, 0);
});

test('authorization loss clears optimistic work and rejects its old correlation', async () => {
  const store = new OperationsStore({
    ready: () => true,
    send: () => {},
    status: async () => {
      throw new Error('offline');
    },
  });
  store.acceptSnapshot(productSnapshot());
  const response = assert.rejects(store.action({ type: 'window.create' }), { code: 'outcome_unknown' });
  store.reset(2);
  await response;
  assert.equal(store.getSnapshot().state, null);
  assert.deepEqual(store.getSnapshot().pending, []);
});

test('an old scope status request cannot block polling in a new scope', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: Extract<Outgoing, { type: 'product.action' }>[] = [];
  let queries = 0;
  const store = new OperationsStore({
    ready: () => true,
    send: (message) => {
      if (message.type === 'product.action') sent.push(message);
    },
    status: async () => {
      queries++;
      return new Promise(() => {});
    },
  });
  t.after(() => store.reset());
  const submit = async () => {
    store.acceptSnapshot(productSnapshot());
    const result = store.action({ type: 'window.create' });
    const operation = sent[sent.length - 1];
    store.handle({
      type: 'product.result',
      version: 1,
      operationId: operation.operationId,
      operationGeneration: operation.operationGeneration,
      result: {
        operationId: operation.operationId,
        operationGeneration: operation.operationGeneration,
        status: 'applying',
      },
    });
    await result;
  };
  await submit();
  t.mock.timers.tick(2000);
  assert.equal(queries, 1);
  store.reset(1);
  await submit();
  t.mock.timers.tick(2000);
  assert.equal(queries, 2);
});

test('one decoder validates message families and malformed packets are counted without dispatch', () => {
  for (const raw of [
    '{',
    '{}',
    '{"type":"frame","rtpTimestamp":"5","layoutEpoch":"1"}',
    '{"type":"files.result","version":1,"requestId":4,"ok":true}',
    '{"type":"input.result","clientSequence":"1","ok":1}',
  ])
    assert.equal(decodeIncoming(raw).type, 'decode-error');
  assert.deepEqual(JSON.parse(encodeOutgoing({ type: 'media.refresh', authEpoch: 2 })), {
    type: 'media.refresh',
    authEpoch: 2,
  });
  const endpoint = new EndpointChannel({ authorization: { productLocked: false, peerAuthEpoch: 2 } });
  const channel = { readyState: 'connecting', send() {} } as unknown as RTCDataChannel;
  let received = 0;
  endpoint.messages.subscribe(() => received++);
  endpoint.bindChannel(channel);
  const before = diagnostics.getSnapshot().malformed;
  channel.onmessage?.({ data: '{' } as MessageEvent);
  channel.onmessage?.({ data: JSON.stringify({ type: 'stats', authEpoch: 1 }) } as MessageEvent);
  channel.onmessage?.({ data: JSON.stringify({ type: 'stats', authEpoch: 2 }) } as MessageEvent);
  assert.equal(diagnostics.getSnapshot().malformed, before + 1);
  assert.equal(received, 1);
});

test('control requests map send failures and structured errors without leaving deadline work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let socket!: Socket;
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    onmessage?: (event: { data: string }) => void;
    fail = true;
    sent: { id: string }[] = [];
    constructor() {
      socket = this;
    }
    send(raw: string) {
      if (this.fail) throw new Error('closed');
      this.sent.push(JSON.parse(raw));
    }
    close() {
      this.readyState = 3;
    }
  }
  for (const [name, value] of Object.entries({
    WebSocket: Socket,
    location: { protocol: 'https:', host: 'viewer' },
  })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() =>
      old ? Object.defineProperty(globalThis, name, old) : Reflect.deleteProperty(globalThis, name),
    );
  }
  const control = new ControlSession(
    () => {},
    () => {},
  );
  t.after(() => control.close());
  control.connect();
  await assert.rejects(control.request('admin.get', {}), { code: 'unavailable' });
  socket.fail = false;
  const response = assert.rejects(
    control.request('admin.get', {}),
    (error: unknown) => error instanceof RemoteKitError && error.code === 'forbidden',
  );
  socket.onmessage?.({
    data: JSON.stringify({
      type: 'error',
      id: socket.sent[0].id,
      error: { code: 'forbidden', message: 'denied' },
    }),
  });
  await response;
  t.mock.timers.tick(20000);
  control.close();
  assert.equal(control.getSnapshot().phase, 'stopped');
});
