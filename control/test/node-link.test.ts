import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Carrier, NodeRegistry, StdioCarrier, type RegistryOptions } from '../server/cluster/node-link';
import { NoiseHandshake, publicKey, MAX_HANDSHAKE_PAYLOAD, type Transport } from '../server/cluster/noise';
import { decodeFrame, encodeJson, encodeStdio, MAX_JSON } from '../server/cluster/frames';
import { encodeNodeReady } from '../server/cluster/ready';
import { EndpointLog } from '../server/cluster/endpoint-log';
import { log } from '../server/log';
import { testNode, nodePrivateKey } from './node-fixture';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

class MemoryCarrier extends Carrier {
  readonly bufferedAmount = 0;
  closeCalls = 0;
  messages: Buffer[] = [];
  onSend?: (message: Buffer) => Promise<void>;
  send(message: Buffer) {
    this.messages.push(message);
    return this.onSend?.(message) ?? Promise.resolve();
  }
  close() {
    this.closeCalls++;
    this.emit('close');
  }
}

function closeLogs(t: TestContext) {
  const records: { event: string; fields: Record<string, any> }[] = [];
  t.mock.method(log, 'warn', (event: string, fields: Record<string, any>) => records.push({ event, fields }));
  return {
    records,
    causes: () =>
      records.filter((record) => record.event === 'node.link_closed').map((record) => record.fields),
  };
}

function fixture(t: TestContext, overrides: Partial<RegistryOptions> = {}) {
  const key = Buffer.alloc(32, 17);
  const registry = new NodeRegistry({
    nodes: { alpha: testNode('alpha') },
    buildId: 'dev',
    privateKey: key.toString('base64'),
    ...overrides,
  });
  t.after(() => registry.stop());
  function connect(hello: Record<string, unknown> = {}, privateKey = nodePrivateKey('alpha')) {
    const carrier = new MemoryCarrier();
    const handshake = new NoiseHandshake('initiator', privateKey, publicKey(key));
    const peer = {
      carrier,
      transport: undefined as Transport | undefined,
      frames: [] as ReturnType<typeof decodeFrame>[],
      reply: undefined as Record<string, any> | undefined,
      autoFence: true,
      send(message: object) {
        carrier.emit('message', this.transport!.send.encrypt(encodeJson(message)));
      },
    };
    carrier.onSend = async (bytes) => {
      if (!peer.transport) {
        peer.reply = JSON.parse(handshake.readMessage(bytes).toString());
        peer.transport = handshake.split();
        return;
      }
      const frame = decodeFrame(peer.transport.receive.decrypt(bytes));
      peer.frames.push(frame);
      if (peer.autoFence && frame.kind === 'json' && frame.message.method === 'node.desired')
        queueMicrotask(() => peer.send({ id: frame.message.id, ok: true, result: { accepted: true } }));
    };
    registry.accept(carrier);
    carrier.emit(
      'message',
      handshake.writeMessage(
        Buffer.from(
          JSON.stringify({
            type: 'node.hello',
            role: 'endpoint',
            nodeId: 'alpha',
            buildId: 'dev',
            incarnation: 'a'.repeat(32),
            ...hello,
          }),
        ),
      ),
    );
    return peer;
  }
  return { registry, connect, link: registry.get('alpha')! };
}

test('an unconfirmed request times out without closing, then its write and late reply can finish', async (t) => {
  const logs = closeLogs(t);
  const h = fixture(t);
  const peer = h.connect();
  await flush();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const send = peer.carrier.onSend!;
  let deliver!: () => void;
  let request: Record<string, any>;
  peer.carrier.onSend = async (bytes) => {
    await new Promise<void>((resolve) => {
      deliver = resolve;
    });
    await send(bytes);
    const frame = peer.frames[peer.frames.length - 1];
    assert.equal(frame.kind, 'json');
    if (frame.kind === 'json') request = frame.message;
  };
  const pending = assert.rejects(h.link.request('fixture.wait', 'tenant', {}, 20_000), {
    code: 'outcome_unknown',
  });
  await flush();
  t.mock.timers.tick(20_000);
  await pending;
  assert.equal(h.link.state.state, 'ready');
  assert.equal(peer.carrier.isClosing, false);
  assert.deepEqual(logs.causes(), []);
  deliver();
  await flush();
  peer.send({ id: request!.id, opId: request!.opId, ok: true, result: {} });
  assert.equal(h.link.state.state, 'ready');
  peer.carrier.onSend = send;
  const next = h.link.request('fixture.next', 'tenant');
  await flush();
  const frame = peer.frames[peer.frames.length - 1];
  assert.equal(frame.kind, 'json');
  if (frame.kind === 'json')
    peer.send({ id: frame.message.id, opId: frame.message.opId, ok: true, result: {} });
  await next;
});

for (const kind of ['send', 'binary', 'request', 'reply', 'pong'] as const) {
  test(`${kind} keeps a pending write, then logs a write error once with its code`, async (t) => {
    const logs = closeLogs(t);
    const h = fixture(t);
    const peer = h.connect();
    await flush();
    let rejectWrite!: (error: Error) => void;
    peer.carrier.onSend = () =>
      new Promise<void>((_, reject) => {
        rejectWrite = reject;
      });
    let pending: Promise<unknown> | undefined;
    if (kind === 'send') h.link.send({ type: 'node.peers', peers: [] });
    if (kind === 'binary')
      pending = assert.rejects(h.link.sendBinary({}, Buffer.from('chunk'), peer.reply!.connectionEpoch), {
        code: 'unavailable',
      });
    if (kind === 'request')
      pending = assert.rejects(h.link.request('fixture.write', 'tenant'), { code: 'unavailable' });
    if (kind === 'reply') {
      h.registry.handlers.set('fixture.read', () => ({}));
      peer.send({
        request: 'fixture.read',
        id: 'remote',
        opId: 'remote-op',
        tenantId: 'tenant',
        endpointIncarnation: 'a'.repeat(32),
        replay: false,
        params: {},
      });
    }
    if (kind === 'pong') peer.send({ type: 'node.ping' });
    await flush();
    assert.equal(peer.carrier.isClosing, false);
    assert.equal(h.link.state.state, 'ready');
    rejectWrite(Object.assign(new Error('pipe failed'), { code: 'EPIPE' }));
    await pending;
    await flush();
    assert.equal(h.link.state.state, 'offline');
    assert.deepEqual(logs.causes(), [
      { nodeId: 'alpha', reason: 'write_error', detail: 'EPIPE: pipe failed' },
    ]);
    peer.carrier.emit('close');
    assert.equal(logs.causes().length, 1);
  });
}

test('oversized reverse replies preserve the request opId in the fallback', async (t) => {
  closeLogs(t);
  const h = fixture(t);
  const peer = h.connect();
  await flush();
  h.registry.handlers.set('object.locate', () => ({ data: 'x'.repeat(MAX_JSON) }));
  peer.send({
    request: 'object.locate',
    id: 'locate',
    opId: 'locate-op',
    tenantId: 'tenant',
    endpointIncarnation: 'a'.repeat(32),
    replay: false,
    params: {},
  });
  await flush();
  const frame = peer.frames[peer.frames.length - 1];
  assert.equal(frame.kind, 'json');
  if (frame.kind !== 'json') throw new Error('Expected reply');
  assert.equal(frame.message.id, 'locate');
  assert.equal(frame.message.opId, 'locate-op');
  assert.equal(frame.message.ok, false);
  assert.equal(frame.message.error.code, 'outcome_unknown');
  assert.equal(peer.carrier.isClosing, false);
});

for (const code of ['busy', 'limit_exceeded']) {
  test(`a bounded ${code} reply rejects only its request`, async (t) => {
    const logs = closeLogs(t);
    const h = fixture(t);
    const peer = h.connect();
    await flush();
    const pending = assert.rejects(h.link.request('fixture.read', 'tenant'), { code });
    await flush();
    const frame = peer.frames[peer.frames.length - 1];
    if (frame.kind !== 'json') throw new Error('Expected request');
    peer.send({ id: frame.message.id, opId: frame.message.opId, ok: false, error: { code, message: code } });
    await pending;
    assert.equal(h.link.state.state, 'ready');
    assert.deepEqual(logs.causes(), []);
  });
}

test('an unmatched reply is logged and keeps the link', async (t) => {
  const logs = closeLogs(t);
  const h = fixture(t);
  const peer = h.connect();
  await flush();
  peer.send({ id: 'unknown', ok: true, result: {} });
  await flush();
  assert.equal(h.link.state.state, 'ready');
  assert.deepEqual(logs.causes(), []);
  assert.ok(logs.records.some((record) => record.event === 'node.reply_unmatched'));
});

for (const failure of [
  'hello',
  'identity',
  'build',
  'decrypt',
  'frame',
  'opId',
  'fencing',
  'replacement',
] as const) {
  test(`logs the ${failure} close decision exactly once`, async (t) => {
    const logs = closeLogs(t);
    const h = fixture(t);
    const hello = failure === 'hello' ? { type: 'invalid' } : failure === 'build' ? { buildId: 'other' } : {};
    const peer = h.connect(hello, failure === 'identity' ? Buffer.alloc(32, 23) : undefined);
    if (failure === 'fencing') peer.autoFence = false;
    await flush();
    let reason = 'handshake_failed';
    let detail: RegExp = /./;
    if (failure === 'hello') detail = /Invalid node hello/;
    if (failure === 'identity') detail = /identity mismatch/;
    if (failure === 'build') detail = /build_mismatch/;
    if (failure === 'decrypt') {
      peer.carrier.emit('message', Buffer.alloc(16));
      reason = 'decrypt_failed';
    }
    if (failure === 'frame') {
      peer.carrier.emit('message', peer.transport!.send.encrypt(Buffer.from([99])));
      reason = 'frame_decode_error';
      detail = /Invalid frame/;
    }
    if (failure === 'opId') {
      const pending = assert.rejects(h.link.request('fixture.read', 'tenant'), { code: 'outcome_unknown' });
      await flush();
      const frame = peer.frames[peer.frames.length - 1];
      if (frame.kind !== 'json') throw new Error('Expected request');
      peer.send({ id: frame.message.id, ok: false, error: { code: 'busy', message: 'Busy' } });
      await pending;
      reason = 'protocol_violation';
      detail = /opId/;
    }
    if (failure === 'fencing') {
      const frame = peer.frames[peer.frames.length - 1];
      if (frame.kind !== 'json') throw new Error('Expected fencing');
      peer.send({ id: frame.message.id, ok: false, error: { code: 'busy', message: 'Busy' } });
      await flush();
      reason = 'fencing_failed';
      detail = /Busy/;
    }
    if (failure === 'replacement') {
      h.connect();
      await flush();
      reason = 'replaced';
      detail = /New connection epoch/;
    }
    const causes = logs.causes();
    assert.equal(causes.length, 1);
    assert.equal(causes[0].reason, reason);
    assert.match(causes[0].detail, detail);
    peer.carrier.emit('close');
    assert.equal(logs.causes().length, 1);
  });
}

test('handshake timeout logs once at its deadline', (t) => {
  const logs = closeLogs(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = fixture(t, { handshakeTimeoutMs: 5000 });
  const carrier = new MemoryCarrier();
  h.registry.accept(carrier, 'alpha');
  t.mock.timers.tick(5000);
  assert.deepEqual(logs.causes(), [
    {
      nodeId: 'alpha',
      reason: 'handshake_timeout',
      detail: 'Node hello not completed before handshake deadline',
    },
  ]);
});

test('a pending handshake rejection still closes at the handshake deadline with its original cause', (t) => {
  const logs = closeLogs(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = fixture(t, { handshakeTimeoutMs: 5000 });
  const carrier = new MemoryCarrier();
  carrier.onSend = () => new Promise(() => {});
  h.registry.accept(carrier);
  const handshake = new NoiseHandshake('initiator', nodePrivateKey('alpha'), publicKey(Buffer.alloc(32, 17)));
  carrier.emit(
    'message',
    handshake.writeMessage(
      Buffer.from(
        JSON.stringify({
          type: 'node.hello',
          role: 'endpoint',
          nodeId: 'alpha',
          buildId: 'other',
          incarnation: 'a'.repeat(32),
        }),
      ),
    ),
  );
  assert.equal(carrier.closeCalls, 0);
  assert.deepEqual(logs.causes(), [
    { nodeId: 'alpha', reason: 'handshake_failed', detail: 'build_mismatch' },
  ]);
  t.mock.timers.tick(5000);
  assert.equal(carrier.closeCalls, 1);
  assert.equal(logs.causes().length, 1);
});

test('heartbeat expiry logs its existing event and one close cause', async (t) => {
  const logs = closeLogs(t);
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const h = fixture(t);
  const peer = h.connect();
  await flush();
  t.mock.timers.tick(45_000);
  assert.equal(peer.carrier.isClosing, true);
  assert.equal(logs.records.filter((record) => record.event === 'node.heartbeat_timeout').length, 1);
  assert.equal(logs.causes().length, 1);
  assert.equal(logs.causes()[0].reason, 'heartbeat_timeout');
});

for (const failure of [
  'length',
  'truncated',
  'stdout-end',
  'stdout-error',
  'stdin-error',
  'exit',
  'child-error',
] as const) {
  test(`stdio ${failure} retains its cause across child termination`, async (t) => {
    const logs = closeLogs(t);
    const h = fixture(t);
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {
        child.emit('exit', 1, null);
      },
    });
    const carrier = new StdioCarrier(
      child as unknown as ChildProcessWithoutNullStreams,
      new EndpointLog(join(tmpdir(), 'rk-node-link-unused.log')),
    );
    h.registry.accept(carrier, 'alpha');
    let reason: string;
    if (failure === 'length') {
      child.stdout.write(Buffer.alloc(4));
      reason = 'frame_decode_error';
    } else if (failure === 'truncated') {
      child.stdout.end(encodeStdio(Buffer.from('hello')).subarray(0, 5));
      reason = 'frame_decode_error';
    } else if (failure === 'stdout-end') {
      child.stdout.end();
      reason = 'stdout_end';
    } else if (failure === 'stdout-error' || failure === 'stdin-error') {
      child[failure === 'stdout-error' ? 'stdout' : 'stdin'].emit(
        'error',
        Object.assign(new Error('broken'), { code: 'EIO' }),
      );
      reason = failure === 'stdout-error' ? 'stdout_error' : 'write_error';
    } else if (failure === 'exit') {
      child.emit('exit', 9, null);
      reason = 'child_exit';
    } else {
      child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }));
      reason = 'child_error';
    }
    await flush();
    assert.equal(logs.causes().length, 1);
    assert.equal(logs.causes()[0].reason, reason);
    assert.equal(logs.causes()[0].nodeId, 'alpha');
    if (failure.endsWith('error')) assert.match(logs.causes()[0].detail, /EIO|ENOENT/);
    child.emit('exit', 1, null);
    assert.equal(logs.causes().length, 1);
  });
}

test('node.ready accepts the payload limit and rejects one extra byte before attachment', async (t) => {
  const logs = closeLogs(t);
  for (const extra of [0, 1]) {
    const alpha = testNode('alpha');
    const betaTemplate = testNode('beta');
    const peers = [{ nodeId: 'beta', address: '', publicKey: betaTemplate.publicKey }];
    const base = encodeNodeReady(alpha, peers, 'dev', '0'.repeat(36)).length;
    const beta = {
      ...betaTemplate,
      config: {
        ...betaTemplate.config,
        peer: { ...betaTemplate.config.peer, address: 'x'.repeat(MAX_HANDSHAKE_PAYLOAD - base + extra) },
      },
    };
    const h = fixture(t, { nodes: { alpha, beta } });
    const peer = h.connect();
    await flush();
    if (!extra) {
      assert.equal(peer.reply!.type, 'node.ready');
      assert.equal(peer.carrier.isClosing, false);
    } else {
      assert.equal(peer.reply, undefined);
      assert.equal(h.link.state.state, 'offline');
      assert.equal(peer.carrier.messages.length, 0);
      assert.deepEqual(logs.records.find((record) => record.event === 'node.ready_oversize')!.fields, {
        nodeId: 'alpha',
        bytes: MAX_HANDSHAKE_PAYLOAD + 1,
        limit: MAX_HANDSHAKE_PAYLOAD,
      });
      const causes = logs.causes();
      assert.equal(causes[causes.length - 1].reason, 'ready_oversize');
    }
  }
});
