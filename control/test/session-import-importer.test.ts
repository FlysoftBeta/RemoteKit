import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ControlDatabase } from '../server/persistence/database';
import { SessionImporter, importChunks } from '../server/session-import/importer';
import { ImportMailbox, createMailClient } from '../server/session-import/mailbox';
import { sealEnvelope } from '../server/session-import/envelope';
import { parsePairingCode } from '../server/session-import/pairing';
import { RemoteKitError, type ErrorCode } from '../shared/errors';
import { createApplication } from '../server/application';
import { dispatchViewerRequest } from '../server/http/viewer-socket';
import { runtimeConfig } from '../server/config';
import {
  browserIdentity,
  FakeMailClient,
  importConfig,
  importPayload,
  uncheckedEnvelope,
} from './session-import-fixture';
import { registerUser, TestClock, testGateway } from './server-fixture';

async function harness() {
  const store = new ControlDatabase(':memory:');
  const clock = new TestClock();
  const user = await registerUser(store, 'import-user', 'import-password');
  const rounds: FakeMailClient[] = [];
  const messages = new FakeMailClient().messages;
  const requests: { method: string; args: any }[] = [];
  let active = false;
  let failure: ErrorCode | undefined;
  let statusFailure: ErrorCode | undefined;
  let statusPending = false;
  let timeout = false;
  let rejectionCount = 0;
  const gateway = testGateway({
    async request(method, _tenant, args) {
      requests.push({ method, args });
      if (method === 'session.identity') return browserIdentity;
      if (method === 'session.storage.import') {
        if (failure) throw new RemoteKitError(failure, 'Browser refused');
        return { accepted: true, job: 'job-' + requests.length, browserIncarnation: 'browser-1' };
      }
      if (method === 'session.storage.importStatus') {
        if (timeout) {
          clock.advance(60001);
          return { state: 'pending' };
        }
        if (statusFailure) throw new RemoteKitError(statusFailure, 'Job lost');
        if (statusPending) return { state: 'pending' };
        return {
          state: 'done',
          cookies: { applied: 1, rejected: rejectionCount },
          localStorage: { applied: 1, rejected: 0 },
        };
      }
      return {};
    },
  });
  const peek = gateway.placement.peek.bind(gateway.placement);
  gateway.placement.peek = (tenant) => (active ? peek(tenant) : undefined);
  const logs: string[] = [];
  const importer = new SessionImporter(
    store,
    gateway,
    importConfig,
    () => {
      const client = new FakeMailClient();
      client.messages = messages;
      rounds.push(client);
      return client;
    },
    clock,
    (message) => logs.push(message),
  );
  const paired = await importer.pair(user.tenantId, 'viewer.example:3001');
  const pairing = parsePairingCode(paired.code);
  const envelope = (payload = importPayload()) =>
    sealEnvelope(Buffer.from(pairing.key.x25519, 'base64url'), pairing.key.id, {
      ...payload,
      token: pairing.token,
    });
  const payload = () => importPayload({ token: pairing.token, createdAt: clock.wallMs() });
  return {
    store,
    clock,
    user,
    gateway,
    importer,
    pairing,
    messages,
    rounds,
    requests,
    logs,
    payload,
    envelope,
    set active(value: boolean) {
      active = value;
    },
    set failure(value: ErrorCode | undefined) {
      failure = value;
    },
    set statusFailure(value: ErrorCode | undefined) {
      statusFailure = value;
    },
    set timeout(value: boolean) {
      timeout = value;
    },
    set statusPending(value: boolean) {
      statusPending = value;
    },
    set rejectionCount(value: number) {
      rejectionCount = value;
    },
    record(id: string) {
      return store.sessionImports.list(user.tenantId).find((r) => r.id === id)!;
    },
    async close() {
      await importer.stop();
      store.db.close();
    },
  };
}

test('mail keeps foreign headers and keys, deletes bad tokens and replay only after database commit', async () => {
  const h = await harness();
  try {
    const valid = h.payload();
    const foreign = h.envelope();
    foreign[5] ^= 1;
    const malformed = h.envelope();
    malformed[0] ^= 1;
    const badToken = sealEnvelope(
      Buffer.from(h.pairing.key.x25519, 'base64url'),
      h.pairing.key.id,
      importPayload(),
    );
    const client = new FakeMailClient();
    client.messages = h.messages;
    client.add(1, foreign);
    client.add(2, badToken);
    client.add(3, h.envelope(valid));
    client.add(4, h.envelope(valid));
    client.add(5, malformed);
    const originalFactoryRound = h.importer.mailbox;
    await originalFactoryRound.poll();
    assert.deepEqual(h.rounds[0].deleted, [2, 3, 4]);
    assert.equal(h.store.sessionImports.list(h.user.tenantId).length, 1);
    assert.equal(h.record(valid.id).state, 'pending');
    const first = h.record(valid.id);
    await h.importer.receive(h.envelope({ ...valid, device: 'Replay changed' }));
    assert.deepEqual(h.record(valid.id), first);
    await h.importer.mailbox.poll();
    assert.equal(
      h.rounds[1].calls.some((c) => c.startsWith('download:')),
      false,
    );
    assert.ok(h.messages.has(1));
    assert.ok(h.messages.has(5));
    assert.equal(h.importer.state(h.user.tenantId).mailbox.lastSuccessAt === null, false);

    const owned = h.envelope();
    owned[owned.length - 1] ^= 1;
    assert.equal(await h.importer.receive(owned), 'delete');
    const invalid = uncheckedEnvelope(Buffer.from(h.pairing.key.x25519, 'base64url'), h.pairing.key.id, {
      ...h.payload(),
      site: { name: 'bad', url: 'file:///bad' },
    });
    assert.equal(await h.importer.receive(invalid), 'delete');
    assert.equal(h.store.sessionImports.list(h.user.tenantId).length, 1);
    const stored = h.store.db.prepare('SELECT payload FROM session_imports WHERE id=?').get(valid.id) as {
      payload: string;
    };
    assert.equal(stored.payload.includes(valid.token), false);
    assert.deepEqual(h.store.sessionImports.payload(h.user.tenantId, valid.id), valid);
  } finally {
    await h.close();
  }
});
test('mail callback commit precedes uid deletion, UIDVALIDITY changes invalidate skip and round errors retry', async () => {
  const clients: FakeMailClient[] = [];
  let committed = false;
  let callbacks = 0;
  let validity = 1n;
  let fail = false;
  const mailbox = new ImportMailbox(
    importConfig,
    async (bytes) => {
      callbacks++;
      if (bytes.toString() === 'foreign') return 'keep';
      committed = true;
      return 'delete';
    },
    () => {
      const client = new FakeMailClient();
      client.uidValidity = validity;
      client.add(1, Buffer.from('foreign'));
      client.add(2, Buffer.from('own'));
      const originalDelete = client.messageDelete.bind(client);
      client.messageDelete = async (uid, options) => {
        assert.ok(committed);
        return originalDelete(uid, options);
      };
      if (fail) client.failure = new Error('connection lost');
      clients.push(client);
      return client;
    },
    () => {},
  );
  try {
    await mailbox.poll();
    assert.equal(callbacks, 2);
    assert.ok(clients[0].calls.indexOf('fetch:done') < clients[0].calls.indexOf('download:1:2.1:true'));
    assert.ok(clients[0].calls.includes('search:RemoteKit session import:true'));
    await mailbox.poll();
    assert.equal(callbacks, 3);
    validity = 2n;
    await mailbox.poll();
    assert.equal(callbacks, 5);
    fail = true;
    await mailbox.poll();
    assert.equal(mailbox.status().lastError, 'connection lost');
    assert.ok(mailbox.status().lastErrorAt);
    fail = false;
    await mailbox.poll();
    assert.ok(mailbox.status().lastSuccessAt);
    assert.equal(mailbox.status().lastError, 'connection lost');
    assert.ok(clients.every((client) => client.calls.includes('close')));
    const real = createMailClient(importConfig);
    assert.deepEqual((real as any).clientInfo.name, 'RemoteKit');
    assert.equal((real as any).options.secure, true);
    assert.equal((real as any).options.logger, false);
    real.close();
  } finally {
    await mailbox.stop();
  }
});
test('valid tokens with expired, future or oversized payloads produce rejected records without payloads', async () => {
  const h = await harness();
  try {
    for (const createdAt of [h.clock.wallMs() - 30 * 86400000 - 1, h.clock.wallMs() + 600001]) {
      const p = { ...h.payload(), createdAt };
      assert.equal(await h.importer.receive(h.envelope(p)), 'delete');
      assert.equal(h.record(p.id).state, 'rejected');
      assert.ok(h.record(p.id).error);
    }
    const p = h.payload();
    p.localStorage[0].items = [['', '\u0000'.repeat(50000)]];
    await h.importer.receive(
      uncheckedEnvelope(Buffer.from(h.pairing.key.x25519, 'base64url'), h.pairing.key.id, p),
    );
    assert.equal(h.record(p.id).state, 'rejected');
    assert.equal(
      h.store.db.prepare('SELECT 1 FROM session_imports WHERE payload IS NOT NULL').get(),
      undefined,
    );
    assert.equal(h.requests.filter((r) => r.method === 'session.storage.import').length, 0);
  } finally {
    await h.close();
  }
});
test('import waits for active placement, chunks fit 512 KiB and preserve whole escaped entries', async () => {
  const h = await harness();
  try {
    const p = h.payload();
    p.cookies = Array.from({ length: 150 }, (_, i) => ({
      ...p.cookies[0],
      name: 'cookie' + i,
      value: 'x'.repeat(4000),
    }));
    p.localStorage = [
      {
        origin: 'https://example.com',
        items: Array.from({ length: 9 }, (_, i) => ['key' + i, '\u0000'.repeat(40000)]),
      },
    ];
    const expected = [...importChunks(p)];
    assert.ok(expected.length > 3);
    assert.ok(expected.every((chunk) => Buffer.byteLength(JSON.stringify(chunk)) <= 512 * 1024));
    assert.deepEqual(
      expected.flatMap((chunk) => chunk.cookies),
      p.cookies,
    );
    assert.deepEqual(
      expected.flatMap((chunk) => chunk.localStorage.flatMap((s) => s.items)),
      p.localStorage[0].items,
    );
    await h.importer.receive(h.envelope(p));
    await h.importer.tick();
    assert.equal(h.record(p.id).state, 'pending');
    assert.equal(
      h.requests.some((r) => r.method === 'session.storage.import'),
      false,
    );
    h.active = true;
    h.rejectionCount = 1;
    await Promise.all([h.importer.tick(), h.importer.tick()]);
    assert.equal(h.record(p.id).state, 'applied');
    assert.equal(h.record(p.id).rejectedItems, expected.length);
    assert.deepEqual(
      h.requests.filter((r) => r.method === 'session.storage.import').map((r) => r.args),
      expected,
    );
    assert.equal(
      (h.store.db.prepare('SELECT payload FROM session_imports WHERE id=?').get(p.id) as any).payload,
      null,
    );
    assert.ok(
      h.requests
        .filter((r) => r.method === 'session.storage.importStatus')
        .every((r) => r.args.browserIncarnation === 'browser-1'),
    );
  } finally {
    await h.close();
  }
});
test('uncertain, unavailable, busy and stale jobs remain pending and a later tick retries from the start', async () => {
  const h = await harness();
  try {
    for (const code of ['outcome_unknown', 'unavailable', 'busy', 'conflict'] as const) {
      const p = h.payload();
      await h.importer.receive(h.envelope(p));
      h.active = true;
      h.failure = code;
      await h.importer.tick();
      assert.equal(h.record(p.id).state, 'pending');
      assert.ok(h.store.sessionImports.payload(h.user.tenantId, p.id));
      h.failure = undefined;
      h.statusFailure = 'conflict';
      await h.importer.tick();
      assert.equal(h.record(p.id).state, 'pending');
      h.statusFailure = undefined;
      await h.importer.tick();
      assert.equal(h.record(p.id).state, 'applied');
      h.active = false;
    }
    const p = h.payload();
    await h.importer.receive(h.envelope(p));
    h.active = true;
    h.timeout = true;
    await h.importer.tick();
    assert.equal(h.record(p.id).state, 'pending');
    h.timeout = false;
    await h.importer.tick();
    assert.equal(h.record(p.id).state, 'applied');
  } finally {
    await h.close();
  }
});
test('explicit browser rejections fail and clear payload; deleting pending records stops further application', async () => {
  const h = await harness();
  try {
    for (const code of ['invalid_request', 'rejected'] as const) {
      const p = h.payload();
      await h.importer.receive(h.envelope(p));
      h.failure = code;
      h.active = true;
      await h.importer.tick();
      assert.equal(h.record(p.id).state, 'failed');
      assert.equal(h.record(p.id).error, 'Browser refused');
      assert.equal(
        (h.store.db.prepare('SELECT payload FROM session_imports WHERE id=?').get(p.id) as any).payload,
        null,
      );
      h.active = false;
    }
    const p = h.payload();
    await h.importer.receive(h.envelope(p));
    h.failure = undefined;
    h.statusPending = true;
    h.active = true;
    const applying = h.importer.tick();
    h.importer.delete(h.user.tenantId, p.id);
    await applying;
    assert.equal(h.record(p.id), undefined);
    h.store.sessionImports.deleteUser(h.user.user.id, h.user.tenantId);
    assert.equal(h.importer.state(h.user.tenantId).pairing, null);
    assert.deepEqual(h.importer.state(h.user.tenantId).imports, []);
  } finally {
    await h.close();
  }
});
test('pairing rotates credentials, state hides secrets and keys persist sealed at rest', async () => {
  const h = await harness();
  try {
    const keys = h.store.sessionImports.keys()!;
    const sealed = h.store.db.prepare('SELECT private_key FROM session_import_keys').get() as {
      private_key: string;
    };
    assert.equal(sealed.private_key.includes(keys.privateKey.toString('base64url')), false);
    const second = new SessionImporter(h.store, h.gateway, importConfig, undefined, h.clock, () => {});
    const newer = parsePairingCode((await second.pair(h.user.tenantId, 'other.test:4321')).code);
    assert.equal(newer.key.id, h.pairing.key.id);
    assert.equal(newer.server, 'other.test:4321');
    assert.deepEqual(newer.browser, { userAgent: browserIdentity.userAgent, ...browserIdentity.metadata });
    await h.importer.receive(h.envelope(h.payload()));
    assert.equal(h.store.sessionImports.list(h.user.tenantId).length, 0);
    assert.equal(JSON.stringify(second.state(h.user.tenantId)).includes(newer.token), false);
    second.unpair(h.user.tenantId);
    assert.equal(second.state(h.user.tenantId).pairing, null);
    await second.stop();
    const disabled = new SessionImporter(h.store, h.gateway);
    assert.equal(disabled.state(h.user.tenantId).mailbox.configured, false);
    await assert.rejects(disabled.pair(h.user.tenantId, 'host'), { code: 'unavailable' });
    await disabled.stop();
  } finally {
    await h.close();
  }
});
test('WS import methods use the current product lease, scope records and pair with the upgrade Host', async () => {
  const store = new ControlDatabase(':memory:');
  const gateway = testGateway({
    async request(method) {
      return method === 'session.identity' ? browserIdentity : {};
    },
  });
  const control = createApplication(store, gateway, undefined, undefined, undefined, importConfig);
  try {
    const a = await registerUser(store, 'ws-import-a', 'password123');
    const b = await registerUser(store, 'ws-import-b', 'password123');
    for (const user of [a, b])
      await control.viewers.attachViewer(
        user.tenantId,
        user.tenantId,
        () => {},
        { identity: user.token, valid: () => true },
        true,
      );
    const authority = {
      tenantId: a.tenantId,
      leaseId: a.tenantId,
      epoch: control.viewers.productEpoch(a.tenantId, a.tenantId)!,
    };
    const call = (method: string, params = {}) =>
      dispatchViewerRequest(control, authority, method, params, undefined, 'connected.example:7443');
    const paired = await call('sessionImport.pair');
    assert.deepEqual(Object.keys(paired).sort(), ['code', 'createdAt']);
    assert.equal(parsePairingCode(paired.code).server, 'connected.example:7443');
    const other = importPayload();
    store.sessionImports.insert(b.tenantId, other, Date.now());
    assert.deepEqual(await call('sessionImport.delete', { id: other.id }), { ok: true });
    assert.equal(store.sessionImports.exists(other.id), true);
    const state = await call('sessionImport.state');
    assert.deepEqual(Object.keys(state).sort(), ['imports', 'mailbox', 'pairing']);
    assert.deepEqual(state.pairing, { createdAt: paired.createdAt });
    assert.deepEqual(state.imports, []);
    assert.deepEqual(await call('sessionImport.unpair'), { ok: true });
    await assert.rejects(call('sessionImport.state', { tenant: b.tenantId }), { code: 'invalid_request' });
    await control.security.lock(a.tenantId, control.tenants.get(a.tenantId).viewer!.security);
    for (const method of [
      'sessionImport.state',
      'sessionImport.pair',
      'sessionImport.unpair',
      'sessionImport.delete',
    ])
      await assert.rejects(call(method), { code: 'locked' });
  } finally {
    await control.close();
    store.db.close();
  }
});
test('session import config is optional, strict and applies only the specified defaults', async () => {
  const directory = await mkdtemp(resolve('develop/tmp/session-import-config-'));
  const configPath = resolve(directory, 'control.json');
  const load = () => runtimeConfig({ REMOTEKIT_CONTROL_CONFIG: configPath }, []);
  try {
    const initial = load();
    assert.equal(initial.sessionImport, undefined);
    assert.equal('sessionImport' in JSON.parse(await readFile(configPath, 'utf8')), false);
    const minimal = {
      mailbox: 'import@example.com',
      imap: { host: 'imap.example.com', user: 'u', password: 'p' },
    };
    await writeFile(configPath, JSON.stringify({ nodes: {}, sessionImport: minimal }));
    assert.deepEqual(load().sessionImport, {
      ...minimal,
      imap: { ...minimal.imap, port: 993 },
      folder: 'INBOX',
      pollSeconds: 60,
    });
    for (const invalid of [
      null,
      {},
      { ...minimal, extra: 1 },
      { ...minimal, imap: { ...minimal.imap, tls: false } },
      { ...minimal, pollSeconds: 14 },
      { ...minimal, pollSeconds: 3601 },
      { ...minimal, pollSeconds: '60' },
      { ...minimal, imap: { ...minimal.imap, port: 0 } },
      { ...minimal, imap: { ...minimal.imap, password: '' } },
      { ...minimal, folder: '' },
      { ...minimal, mailbox: 'bad' },
    ]) {
      await writeFile(configPath, JSON.stringify({ nodes: {}, sessionImport: invalid }));
      assert.throws(load, { code: 'invalid_request' });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
