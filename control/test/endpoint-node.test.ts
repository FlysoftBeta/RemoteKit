import { installDesiredSource } from './coordination-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { endpointDefaults, testNode, nodePrivateKey } from './node-fixture';
import { NodeRegistry, type RegistryOptions } from '../server/cluster/node-link';
import { Placement } from '../server/cluster/placement';
import { EndpointGateway } from '../server/endpoint/gateway';
import { ControlDatabase } from '../server/persistence/database';
import { FakeNode } from './fake-node';
import { createApplication } from '../server/application';
import { emptyWorkspace } from '../server/persistence/workspaces';
import { log } from '../server/log';

async function harness(overrides: Partial<RegistryOptions> = {}) {
  const key = randomBytes(32);
  const registry = new NodeRegistry({
    nodes: Object.fromEntries(
      ['alpha', 'beta'].map((nodeId) => [
        nodeId,
        { ...testNode(nodeId), limits: { ...testNode(nodeId).limits, maxSessions: 2 } },
      ]),
    ),
    privateKey: key.toString('base64'),
    buildId: 'dev',
    ...overrides,
  });
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  const placement = new Placement(store, registry);
  const gateway = new EndpointGateway(registry, placement);
  installDesiredSource(gateway);
  const server = createServer();
  server.on('upgrade', (req, socket, head) => {
    if (!registry.handleUpgrade(req, socket, head)) socket.destroy();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/node`;
  const clients: FakeNode[] = [];
  return {
    registry,
    store,
    placement,
    gateway,
    url,
    key,
    async connect(hello: Record<string, unknown> = {}, useKey = key) {
      const node = new FakeNode();
      clients.push(node);
      await node.connect(url, useKey, hello);
      return node;
    },
    async close() {
      registry.stop();
      clients.forEach((node) => node.close());
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.db.close();
    },
  };
}

test('encrypted handshake supplies config, rejects unknown/build mismatch, replaces connections', async () => {
  const h = await harness();
  try {
    const first = await h.connect();
    assert.equal(first.helloReply.type, 'node.ready');
    assert.equal(first.helloReply.config.nodeId, 'alpha');
    assert.equal(first.helloReply.configHash, 'alpha');
    const link = h.registry.get('alpha')!;
    const epoch = link.state.state === 'ready' && link.state.connectionEpoch;
    first.handler = () => undefined;
    const received = once(first, 'request');
    const lost = assert.rejects(link.request('test', 'tenant'), { code: 'outcome_unknown' });
    await received;
    const ready = once(link, 'ready');
    await h.connect({ incarnation: first.incarnation });
    assert.equal((await ready)[0].processChanged, false);
    await lost;
    assert.notEqual(link.state.state === 'ready' && link.state.connectionEpoch, epoch);
    const changed = once(link, 'ready');
    await h.connect();
    assert.equal((await changed)[0].processChanged, true);
    await assert.rejects(h.connect({ nodeId: 'missing' }));
    for (const [hello, code] of [[{ buildId: 'old' }, 'build_mismatch']] as const) {
      const rejected = await h.connect(hello);
      assert.equal(rejected.helloReply.code, code);
      await once(rejected.socket, 'close');
      assert.equal(link.state.state, 'ready');
    }
  } finally {
    await h.close();
  }
});

test('IK binds configured node identity and peer revocation to the configured public keys', async () => {
  const h = await harness();
  const removed = new Set<string>();
  h.registry.isRemoved = (node) => removed.has(node);
  try {
    const alpha = await h.connect();
    assert.deepEqual(alpha.helloReply.peers, [
      {
        nodeId: 'beta',
        address: h.registry.get('beta')!.config.peer.address,
        publicKey: h.registry.get('beta')!.configured.publicKey,
      },
    ]);
    const wrong = new FakeNode();
    try {
      await assert.rejects(
        wrong.connect(h.url, h.key, { nodeId: 'alpha' }, nodePrivateKey('beta')),
        /Handshake closed/,
      );
    } finally {
      wrong.close();
    }
    assert.equal(h.registry.get('alpha')!.history().rejected?.code, 'identity_mismatch');
    await assert.rejects(h.connect({ nodeId: 'unknown' }), /Handshake closed/);
    removed.add('beta');
    const pushed = once(alpha, 'frame');
    h.registry.publishPeers();
    assert.deepEqual((await pushed)[0].message, { type: 'node.peers', peers: [] });
    await assert.rejects(h.connect({ nodeId: 'beta' }), /Handshake closed/);
    const identity = h.registry.get('beta')!.configured.publicKey;
    removed.delete('beta');
    h.registry.publishPeers();
    assert.equal((await h.connect({ nodeId: 'beta' })).helloReply.type, 'node.ready');
    assert.equal(h.registry.get('beta')!.configured.publicKey, identity);
  } finally {
    await h.close();
  }
});

test('wrong key, text, malformed ciphertext, handshake deadline and idle deadline close carriers', async () => {
  const h = await harness({ handshakeTimeoutMs: 500, heartbeatTimeoutMs: 1000 });
  try {
    await assert.rejects(h.connect({}, randomBytes(32)));
    const raw = new WebSocket(h.url);
    await once(raw, 'open');
    await once(raw, 'close');
    const node = await h.connect();
    const closed = once(node.socket, 'close');
    node.socket.send('plaintext');
    await closed;
    const corrupted = await h.connect();
    const corruptClosed = once(corrupted.socket, 'close');
    corrupted.socket.send(Buffer.alloc(32));
    await corruptClosed;
    const idle = await h.connect();
    await once(idle.socket, 'close');
  } finally {
    await h.close();
  }
});

test('node request cap, timeout, offline certainty and ping/pong', async () => {
  const h = await harness({ requestTimeoutMs: 80 });
  try {
    const link = h.registry.get('alpha')!;
    await assert.rejects(link.request('test', 'one'), { code: 'unavailable' });
    const node = await h.connect();
    const pong = once(node, 'frame');
    node.send({ type: 'node.ping' });
    assert.equal((await pong)[0].message.type, 'node.pong');
    node.handler = () => undefined;
    const requests = Array.from({ length: 256 }, () =>
      assert.rejects(link.request('test', 'one'), { code: 'outcome_unknown' }),
    );
    await assert.rejects(link.request('excess', 'one'), { code: 'busy' });
    await Promise.all(requests);
    await assert.rejects(link.request('big', 'one', { data: 'x'.repeat(1024 * 1024) }), {
      code: 'limit_exceeded',
    });
  } finally {
    await h.close();
  }
});

test('balanced placement publishes desired once per revision and fences reconnects', async () => {
  const h = await harness();
  try {
    const alpha = await h.connect(),
      beta = await h.connect({ nodeId: 'beta' });
    await h.gateway.synchronize('one');
    await h.gateway.synchronize('one');
    const documents = alpha.requests.filter((request) => request.method === 'session.desired');
    assert.equal(documents.length, 1);
    const first = h.placement.peek('one')!,
      key = documents[0].profileKey;
    assert.equal(Buffer.from(key, 'base64').length, 32);
    assert.equal(first.keyCiphertext.includes(key), false);
    assert.throws(() => h.store.atRestKey.open('other', first.keyCiphertext));
    for (const tenant of ['two', 'three', 'four']) await h.gateway.synchronize(tenant);
    assert.deepEqual(
      ['one', 'two', 'three', 'four'].map((tenant) => h.placement.peek(tenant)!.nodeId),
      ['alpha', 'beta', 'alpha', 'beta'],
    );
    await assert.rejects(h.gateway.synchronize('five'), { code: 'unavailable' });
    const offline = once(h.registry.get('alpha')!, 'offline');
    alpha.close();
    await offline;
    assert.equal(h.gateway.isReady('one'), false);
    assert.equal(h.gateway.isReady('two'), true);
    const next = await h.connect({ incarnation: alpha.incarnation });
    await h.registry.get('alpha')!.request('fixture.barrier', '');
    await h.gateway.synchronize('one');
    const published = next.requests.find((request) => request.method === 'session.desired')!;
    assert.equal(published.sessionId, first.sessionId);
    assert.equal(published.profileKey, key);
    assert.ok(
      next.requests.findIndex((request) => request.method === 'node.desired') <
        next.requests.indexOf(published),
    );
    let signals = 0;
    const unsubscribe = h.gateway.onSignal(() => signals++);
    beta.send({ event: 'rtc.signal', tenantId: 'one', connectionId: 'x', signal: {} });
    beta.send({ event: 'rtc.signal', tenantId: 'two', connectionId: 'x', signal: {} });
    await beta.barrier();
    assert.equal(signals, 1);
    unsubscribe();
  } finally {
    await h.close();
  }
});

test('Endpoint peer authentication failures cannot invalidate the Viewer Control session', async () => {
  const h = await harness();
  try {
    const endpoint = await h.connect();
    endpoint.handle = async () => {
      throw { code: 'unauthenticated', message: 'Peer identity not admitted' };
    };
    await assert.rejects(h.registry.get('alpha')!.request('object.fetch', 'one'), {
      code: 'forbidden',
      message: 'Peer identity not admitted',
    });
    endpoint.desiredHandler = (_document, observation) => {
      observation.converged = false;
      observation.lastError = { code: 'unauthenticated', message: 'Peer identity not admitted' };
    };
    await h.gateway.synchronize('one');
    const observation = await h.gateway.waitObserved('one', (value) => !!value.lastError);
    assert.equal(observation.lastError?.code, 'forbidden');
    assert.equal(observation.lastError?.message, 'Peer identity not admitted');
  } finally {
    await h.close();
  }
});

test('stop and reopen on the same node and epoch accepts the new coordinator observation', async () => {
  const h = await harness();
  try {
    const endpoint = await h.connect();
    let desired = await h.gateway.synchronize('returning');
    h.gateway.setDesiredSource(() => desired);
    endpoint.desiredHandler = (_document, observation) => {
      observation.checkpoint = null;
      observation.data = null;
    };
    const running = await h.gateway.waitObserved('returning', (value) => value.converged);
    desired = { ...desired, revision: '2', run: 'stopped', commit: 'stop-returning' };
    await h.gateway.synchronize('returning');
    const stopped = await h.gateway.waitObserved(
      'returning',
      (value) => value.converged && value.observedRevision === '2' && value.browser === 'stopped',
    );
    endpoint.sessions.delete('returning');
    endpoint.observations.delete('returning');
    desired = { ...desired, revision: '3', run: 'running', commit: null };
    await h.gateway.synchronize('returning');
    const reopened = await h.gateway.waitObserved(
      'returning',
      (value) => value.converged && value.observedRevision === '3' && value.browser === 'running',
    );
    assert.equal(reopened.endpointIncarnation, running.endpointIncarnation);
    assert.equal(reopened.connectionEpoch, running.connectionEpoch);
    assert.equal(reopened.placementEpoch, running.placementEpoch);
    assert.equal(reopened.sessionId, running.sessionId);
    assert.ok(BigInt(stopped.seq) > BigInt(running.seq));
    assert.ok(BigInt(reopened.seq) > BigInt(stopped.seq));
    endpoint.send(stopped);
    await endpoint.barrier();
    assert.equal(h.gateway.observation('returning')?.seq, reopened.seq);
  } finally {
    await h.close();
  }
});

test('clipboard management events cross the encrypted link and reject stale nodes and sessions', async () => {
  const h = await harness();
  const control = createApplication(h.store, h.gateway);
  try {
    h.store.accounts.insertUser({
      id: 'one',
      username: 'one',
      tenant: 'one',
      salt: '',
      password_hash: '',
      is_admin: 0,
    });
    h.store.workspaces.writeWorkspace(emptyWorkspace('one'));
    const alpha = await h.connect();
    const beta = await h.connect({ nodeId: 'beta' });
    h.store.clipboards.record('one', { text: 'seed', html: '' });
    await h.gateway.synchronize('one');
    assert.deepEqual(alpha.requests.find((request) => request.method === 'session.desired')?.clipboard, {
      revision: '1',
      value: { text: 'seed', html: '' },
    });
    alpha.event('one', '1', 'clipboard.changed', {
      browserSequence: '1',
      baseRevision: '1',
      text: 'first',
      html: '',
      excludeFromHistory: false,
    });
    await alpha.barrier();
    await new Promise((resolve) => setImmediate(resolve));
    await control.tenants.drain();
    alpha.event('one', '2', 'clipboard.changed', {
      browserSequence: '2',
      baseRevision: '2',
      text: 'last',
      html: '',
      excludeFromHistory: false,
    });
    await alpha.barrier();
    await new Promise((resolve) => setImmediate(resolve));
    await control.tenants.drain();
    assert.deepEqual(h.store.clipboards.latest('one'), { revision: '3', text: 'last', html: '' });
    const before = alpha.requests.length;
    const warn = test.mock.method(log, 'warn', () => {});
    try {
      alpha.event('one', '3', 'clipboard.changed', {
        browserSequence: '3',
        baseRevision: '3',
        oversize: true,
        textBytes: 5 * 1024 * 1024,
        htmlBytes: 0,
        excludeFromHistory: false,
      });
      await alpha.barrier();
      await control.tenants.drain();
      assert.equal(h.store.clipboards.latest('one')?.revision, '3');
      assert.deepEqual(warn.mock.calls[0].arguments, [
        'clipboard.write_exceeds_limits',
        { textBytes: 5 * 1024 * 1024, htmlBytes: 0 },
      ]);
    } finally {
      warn.mock.restore();
    }
    assert.ok(alpha.requests.slice(before).every((request) => request.method === 'session.events.ack'));
  } finally {
    await control.close();
    await h.close();
  }
});

test('updater resumes binary release downloads and receives no_release in dev', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-release-'));
  const archive = join(directory, 'node.tar.zst');
  const bytes = randomBytes(2 * 1024 * 1024 + 17);
  await writeFile(archive, bytes);
  const descriptor = {
    buildId: 'a'.repeat(64),
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const h = await harness({ release: { archive, descriptor }, buildId: descriptor.buildId });
  try {
    const updater = await h.connect({ role: 'updater', buildId: 'dev' });
    assert.deepEqual(updater.helloReply, { type: 'node.release', release: descriptor });
    const frames: any[] = [];
    const complete = new Promise<void>((resolve) =>
      updater.on('frame', (frame) => {
        frames.push(frame);
        if (frame.message?.type === 'package.end') resolve();
      }),
    );
    updater.send({ type: 'package.get', buildId: descriptor.buildId, offset: 13 });
    await complete;
    let offset = 13;
    for (const frame of frames.slice(0, -1)) {
      assert.equal(frame.kind, 'binary');
      assert.equal(frame.header.offset, offset);
      assert.ok(frame.bytes.length <= 1024 * 1024);
      offset += frame.bytes.length;
    }
    assert.deepEqual(Buffer.concat(frames.slice(0, -1).map((frame) => frame.bytes)), bytes.subarray(13));
    assert.equal(frames[frames.length - 1].message.size, bytes.length);
    assert.equal(h.registry.get('alpha')!.state.state, 'offline');
  } finally {
    await h.close();
    await rm(directory, { recursive: true, force: true });
  }
  const dev = await harness();
  try {
    assert.equal((await dev.connect({ role: 'updater' })).helloReply.code, 'no_release');
  } finally {
    await dev.close();
  }
});

test('node offline and process changes affect only placed tenants while a same-process reconnect retains media generation', async () => {
  const h = await harness();
  const control = createApplication(h.store, h.gateway);
  try {
    await h.connect();
    await h.connect({ nodeId: 'beta' });
    for (const tenant of ['one', 'two']) {
      h.store.workspaces.writeWorkspace(emptyWorkspace(tenant));
      await h.gateway.synchronize(tenant);
    }
    const one = control.tenants.get('one');
    const two = control.tenants.get('two');
    for (const runtime of [one, two]) {
      runtime.beginRtc(runtime.tenantId, 'attempt', 'lease');
      runtime.activateRtc(runtime.tenantId, 'lease');
    }
    control.rtc.endpointOffline('alpha');
    assert.equal(one.connectionId, undefined);
    assert.equal(two.connectionId, 'two');
    await control.reconciler.endpointReady({ nodeId: 'alpha', processChanged: false });
    assert.equal(control.tenants.mediaGeneration('one'), 0);
    assert.equal(one.pendingRtcCheck, true);
    assert.ok(one.rtc.disconnectedPeer);
    await control.reconciler.endpointReady({ nodeId: 'alpha', processChanged: true });
    assert.equal(control.tenants.mediaGeneration('one'), 1);
    assert.equal(control.tenants.mediaGeneration('two'), 0);
    assert.equal(two.connectionId, 'two');
    assert.equal(one.rtc.disconnectedPeer, undefined);
  } finally {
    await control.close();
    await h.close();
  }
});

test('bidirectional requests share the concurrency cap, timeout errors and JSON reply limit', async () => {
  const h = await harness({ requestTimeoutMs: 80 });
  try {
    const node = await h.connect();
    h.registry.handlers.set('fixture.hang', () => new Promise(() => {}));
    const pending = Array.from({ length: 256 }, () =>
      assert.rejects(node.request('fixture.hang', 'tenant'), { code: 'outcome_unknown' }),
    );
    await assert.rejects(node.request('fixture.hang', 'tenant'), { code: 'busy' });
    await Promise.all(pending);
    h.registry.handlers.set('fixture.large', () => ({ data: 'x'.repeat(1024 * 1024) }));
    await assert.rejects(node.request('fixture.large', 'tenant'), { code: 'outcome_unknown' });
  } finally {
    await h.close();
  }
});

test('browser status reasons map once at the Endpoint boundary and keep uncertain outcomes', async () => {
  const h = await harness();
  const control = createApplication(h.store, h.gateway);
  try {
    h.store.workspaces.writeWorkspace(emptyWorkspace('one'));
    const node = await h.connect();
    const detail = 'render generations have unresolved GPU work or leases; retained';
    for (const [reason, message] of [
      ['browser_crashed', '浏览器异常退出，正在恢复…'],
      ['browser_restarting', '浏览器正在恢复，请稍候…'],
      ['output_failed', '浏览器画面输出失败，请稍后重试'],
    ] as const) {
      await h.gateway.synchronize('one');
      node.observe('one', { lastError: { code: 'unavailable', reason, message: detail } });
      await node.barrier();
      await assert.rejects(h.gateway.snapshot('one'), { code: 'unavailable', message, detail });
      const runtime = control.tenants.get('one');
      runtime.reconciliation.error = undefined;
      runtime.started = true;
      await assert.rejects(control.reconciler.reconcileProduct('one'), { message });
      assert.equal(runtime.lastError?.message, message);
      assert.equal(runtime.lastError?.reason, reason);
      assert.equal(control.viewers.productState('one').endpointError?.message, message);
      assert.equal(control.viewers.productState('one').endpointError?.code, 'unavailable');
    }
    node.handler = () => {
      throw { code: 'outcome_unknown', reason: 'browser_restarting', message: detail };
    };
    await assert.rejects(h.gateway.command('one', { viewId: '1', command: 'reload' }), {
      code: 'outcome_unknown',
      message: '浏览器正在恢复，请稍候…',
      detail,
    });
  } finally {
    await control.close();
    await h.close();
  }
});

test('fresh lifecycle decisions get new opIds while generation-bound retries retain identity', async () => {
  const h = await harness();
  try {
    const node = await h.connect();
    await h.gateway.synchronize('one');
    for (let index = 0; index < 2; index++)
      await h.gateway.lifecycle('one', { viewId: '1', action: 'freeze' });
    const fresh = node.requests.filter((request) => request.method === 'view.lifecycle');
    assert.notEqual(fresh[0].opId, fresh[1].opId);
    for (let index = 0; index < 2; index++)
      await h.gateway.lifecycle('one', {
        viewId: '1',
        action: 'unload',
        browserIncarnation: 'browser-1',
        lifecycleGeneration: '4',
      });
    const guarded = node.requests.filter((request) => request.method === 'view.lifecycle').slice(-2);
    assert.equal(guarded[0].opId, guarded[1].opId);
  } finally {
    await h.close();
  }
});
