import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProductOperation, OperationReceipt } from '../shared/product';
import { RequestTracker } from '../client/util/request-tracker';
import { RemoteKitError } from '../shared/errors';
import {
  OperationsStore as BaseOperationsStore,
  type OperationsPort,
} from '../client/control/operations-store';
import { ControlSession } from '../client/control/control-session';
import { decodeIncoming, encodeOutgoing, type Outgoing } from '../client/rtc/protocol';
import { EndpointChannel } from '../client/rtc/endpoint-channel';
import { diagnostics } from '../client/media/diagnostics';
import { productSnapshot } from './client-fixture';
import { AuthorizationScope } from '../client/auth/authorization-scope';

class OperationsStore extends BaseOperationsStore {
  private readonly replies: Map<string, (receipt: OperationReceipt) => void>;
  constructor(port: Omit<OperationsPort, 'submit'> & { dispatch(operation: ProductOperation): void }) {
    const replies = new Map<string, (receipt: OperationReceipt) => void>();
    super({
      ...port,
      submit: (operation) =>
        new Promise((resolve) => {
          replies.set(operation.operationId, resolve);
          port.dispatch(operation);
        }),
    });
    this.replies = replies;
  }
  acceptReceipt(receipt: OperationReceipt) {
    const resolve = this.replies.get(receipt.operationId);
    if (resolve) {
      this.replies.delete(receipt.operationId);
      resolve(receipt);
    } else {
      const state = this.getSnapshot().authoritative;
      if (state)
        this.acceptSnapshot({
          ...state,
          snapshotSequence: (state.snapshotSequence ?? 0) + 1,
          operationReceipts: [receipt],
        });
    }
  }
}

test('authorization advances its scope only on lock or peer epoch transitions', () => {
  const scope = new AuthorizationScope({ endpoint: { channel: null } });
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

test('retryable receipts resubmit the same operation identity and status final failures stop polling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: ProductOperation[] = [];
  let store: OperationsStore;
  store = new OperationsStore({
    ready: () => true,
    dispatch: (message) => {
      sent.push(message);
      queueMicrotask(() =>
        store.acceptReceipt({
          operationId: message.operationId,
          operationGeneration: message.operationGeneration,
          ...(sent.length < 3
            ? { status: 'failed', error: { code: 'busy', message: '繁忙', retryAfterMs: 0 } }
            : { status: 'committed' }),
        }),
      );
    },
    status: async () => {
      throw new Error('retryable admission must resubmit, not poll');
    },
  });
  t.after(() => store.reset());
  store.acceptSnapshot(productSnapshot());
  const result = store.action({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } });
  for (let index = 0; index < 12; index++) {
    await Promise.resolve();
    t.mock.timers.tick(0);
  }
  assert.equal((await result).status, 'committed');
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[0], sent[1]);
  assert.deepEqual(sent[1], sent[2]);
  store.reset();
  let polls = 0;
  const stopped = new OperationsStore({
    ready: () => true,
    dispatch: (message) => {
      queueMicrotask(() =>
        stopped.acceptReceipt({
          operationId: message.operationId,
          operationGeneration: message.operationGeneration,
          status: 'unknown',
        }),
      );
    },
    status: async () => {
      polls++;
      throw new RemoteKitError('forbidden', '无权查询');
    },
  });
  t.after(() => stopped.reset());
  stopped.acceptSnapshot(productSnapshot());
  await assert.rejects(
    stopped.action({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } }),
    { code: 'forbidden' },
  );
  t.mock.timers.tick(60_000);
  assert.equal(polls, 1);
  assert.equal(stopped.getSnapshot().pending.length, 0);
});

for (const status of ['accepted', 'applying', 'committed', 'unknown', 'failed'] as const)
  test(`operations preserve ${status} as an execution outcome without replay`, async (t) => {
    const sent: ProductOperation[] = [];
    const store = new OperationsStore({
      ready: () => true,
      dispatch: (message) => {
        sent.push(message);
      },
      status: async (operation) => ({ ...operation, status: 'unknown' }),
    });
    t.after(() => store.reset());
    store.acceptSnapshot(productSnapshot());
    const result = store.action({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } });
    const rejection = status === 'failed' ? assert.rejects(result, { code: 'rejected' }) : undefined;
    const operation = sent[0];
    assert.equal('phase' in operation, false);
    const receipt = {
      operationId: operation.operationId,
      operationGeneration: operation.operationGeneration,
      ...(status === 'failed'
        ? { status, error: { code: 'rejected' as const, message: '操作被拒绝' } }
        : { status }),
      revision: 2,
    };
    store.acceptReceipt(receipt);
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
  let operation!: ProductOperation;
  const store = new OperationsStore({
    ready: () => true,
    dispatch: (message) => {
      operation = message;
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
  const response = store.action({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } });
  const receipt = {
    operationId: operation.operationId,
    operationGeneration: operation.operationGeneration,
    status: 'applying' as const,
  };
  store.acceptReceipt(receipt);
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

test('HTTP auth credentials are sent once and never enter pending snapshots through receipt polling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: ProductOperation[] = [];
  const phases: string[] = [];
  const store = new OperationsStore({
    ready: () => true,
    dispatch: (message) => {
      sent.push(message);
    },
    status: async (operation) => {
      assert.deepEqual(operation, {
        operationId: sent[0].operationId,
        operationGeneration: sent[0].operationGeneration,
      });
      return { ...operation, status: 'committed', revision: 1 };
    },
  });
  t.after(() => store.reset());
  store.subscribe(() => {
    const snapshot = store.getSnapshot();
    assert.ok(!JSON.stringify(snapshot).includes('AUTH_SECRET'));
    for (const entry of snapshot.pending) {
      assert.deepEqual(entry.action, {
        type: 'page.reply',
        dialogId: 'auth-dialog',
        reply: { kind: 'http_auth', accept: true },
      });
      assert.equal('username' in entry.action.reply, false);
      assert.equal('password' in entry.action.reply, false);
      phases.push(entry.phase);
    }
  });
  store.acceptSnapshot(productSnapshot());
  const action = {
    type: 'page.reply' as const,
    dialogId: 'auth-dialog',
    reply: {
      kind: 'http_auth' as const,
      accept: true as const,
      username: 'AUTH_SECRET_USER',
      password: 'AUTH_SECRET_PASSWORD',
    },
  };
  const response = store.action(action);
  assert.deepEqual(sent[0].action, action);
  store.acceptReceipt({
    operationId: sent[0].operationId,
    operationGeneration: sent[0].operationGeneration,
    status: 'unknown',
  });
  assert.equal((await response).status, 'committed');
  assert.equal(store.getSnapshot().pending[0].phase, 'committed');
  t.mock.timers.tick(2000);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(store.getSnapshot().pending[0].phase, 'committed');
  const state = productSnapshot();
  state.snapshotSequence = 2;
  state.workspace.revision = 1;
  store.acceptSnapshot(state);
  assert.deepEqual(store.getSnapshot().pending, []);
  assert.equal(sent.length, 1);
  assert.ok(['unsent', 'sent', 'unknown', 'committed'].every((phase) => phases.includes(phase)));
  assert.equal(action.reply.password, 'AUTH_SECRET_PASSWORD');
});

test('HTTP auth outcome_unknown queries use only operation identity and never resend the action', async (t) => {
  const sent: ProductOperation[] = [];
  const queries: unknown[] = [];
  const store = new OperationsStore({
    ready: () => true,
    dispatch: (message) => {
      sent.push(message);
    },
    status: async (operation) => {
      queries.push(operation);
      return { ...operation, status: 'committed', revision: 1 };
    },
  });
  t.after(() => store.reset());
  store.acceptSnapshot(productSnapshot());
  const response = store.action({
    type: 'page.reply',
    dialogId: 'auth-dialog',
    reply: {
      kind: 'http_auth',
      accept: true,
      username: 'AUTH_SECRET_USER',
      password: 'AUTH_SECRET_PASSWORD',
    },
  });
  store.acceptReceipt({
    operationId: sent[0].operationId,
    operationGeneration: sent[0].operationGeneration,
    status: 'unknown',
    error: { code: 'outcome_unknown', message: '回复丢失' },
  });
  assert.equal((await response).status, 'committed');
  assert.deepEqual(queries, [
    { operationId: sent[0].operationId, operationGeneration: sent[0].operationGeneration },
  ]);
  assert.equal(sent.length, 1);
  assert.ok(!JSON.stringify(store.getSnapshot()).includes('AUTH_SECRET'));
});

test('authorization loss clears optimistic work and rejects its old correlation', async () => {
  const store = new OperationsStore({
    ready: () => true,
    dispatch: () => {},
    status: async () => {
      throw new Error('offline');
    },
  });
  store.acceptSnapshot(productSnapshot());
  const response = assert.rejects(
    store.action({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } }),
    { code: 'outcome_unknown' },
  );
  store.reset(2);
  await response;
  assert.equal(store.getSnapshot().state, null);
  assert.deepEqual(store.getSnapshot().pending, []);
});

test('an old scope status request cannot block polling in a new scope', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: ProductOperation[] = [];
  let queries = 0;
  const store = new OperationsStore({
    ready: () => true,
    dispatch: (message) => {
      sent.push(message);
    },
    status: async () => {
      queries++;
      return new Promise(() => {});
    },
  });
  t.after(() => store.reset());
  const submit = async () => {
    store.acceptSnapshot(productSnapshot());
    const result = store.action({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } });
    const operation = sent[sent.length - 1];
    store.acceptReceipt({
      operationId: operation.operationId,
      operationGeneration: operation.operationGeneration,
      status: 'applying',
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
  const libraries: unknown[] = [];
  control.library.subscribe((snapshot) => libraries.push(snapshot));
  socket.onmessage?.({ data: JSON.stringify({ type: 'library', snapshot: { revision: 7 } }) });
  assert.deepEqual(libraries, [{ revision: 7 }]);
  await assert.rejects(control.request('admin.overview', {}), { code: 'unavailable' });
  socket.fail = false;
  const response = assert.rejects(
    control.request('admin.overview', {}),
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

test('product transport rejection retains its code without querying an unadmitted operation', async (t) => {
  let operation!: ProductOperation;
  const store = new OperationsStore({
    ready: () => true,
    dispatch: (message) => {
      operation = message;
    },
    status: async () => {
      throw new Error('unadmitted operation must not be queried');
    },
  });
  t.after(() => store.reset());
  store.acceptSnapshot(productSnapshot());
  const response = store.action({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } });
  store.acceptReceipt({
    operationId: operation.operationId,
    operationGeneration: operation.operationGeneration,
    status: 'failed',
    error: { code: 'forbidden', message: '无权执行' },
  });
  await assert.rejects(
    response,
    (error: unknown) =>
      error instanceof RemoteKitError && error.code === 'forbidden' && error.message === '无权执行',
  );
  assert.equal(store.getSnapshot().pending.length, 0);
  assert.equal(store.getSnapshot().error?.code, 'forbidden');
});

test('a later retryable receipt resubmits the admitted operation with its original identity', async (t) => {
  const sent: ProductOperation[] = [];
  let store: OperationsStore;
  store = new OperationsStore({
    ready: () => true,
    dispatch: (message) => {
      sent.push(message);
      queueMicrotask(() =>
        store.acceptReceipt({
          operationId: message.operationId,
          operationGeneration: message.operationGeneration,
          status: sent.length === 1 ? 'accepted' : 'committed',
        }),
      );
    },
    status: async (operation) => ({ ...operation, status: 'unknown' }),
  });
  t.after(() => store.reset());
  store.acceptSnapshot(productSnapshot());
  assert.equal(
    (await store.action({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } })).status,
    'accepted',
  );
  store.acceptReceipt({
    operationId: sent[0].operationId,
    operationGeneration: sent[0].operationGeneration,
    status: 'failed',
    error: { code: 'busy', message: '繁忙', retryAfterMs: 0 },
  });
  for (let index = 0; index < 10; index++) await Promise.resolve();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(store.getSnapshot().pending[0]?.phase, 'committed');
});

test('viewport state observations cannot bypass a retry hint', async (t) => {
  const { ViewportRequests } = await import('../client/control/viewport-requests');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { fullscreenElement: null } });
  t.after(() =>
    descriptor
      ? Object.defineProperty(globalThis, 'document', descriptor)
      : Reflect.deleteProperty(globalThis, 'document'),
  );
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let calls = 0;
  const requests = new ViewportRequests(async () => {
    calls++;
    if (calls === 1) throw new RemoteKitError('busy', '繁忙', { retryAfterMs: 2000 });
  });
  t.after(() => requests.reset());
  requests.observe(productSnapshot(), true);
  requests.measure(800, 600, 1, true);
  t.mock.timers.tick(100);
  for (let index = 0; index < 5; index++) await Promise.resolve();
  assert.equal(calls, 1);
  requests.observe({ ...productSnapshot(), snapshotSequence: 2 }, true);
  t.mock.timers.tick(1000);
  for (let index = 0; index < 5; index++) await Promise.resolve();
  assert.equal(calls, 1);
  t.mock.timers.tick(1200);
  t.mock.timers.tick(100);
  for (let index = 0; index < 5; index++) await Promise.resolve();
  assert.equal(calls, 2);
});
