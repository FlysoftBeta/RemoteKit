import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ControlDatabase } from '../server/persistence/database';
import { SessionImporter, importChunks } from '../server/session-import/importer';
import { ImportMailbox, createMailClient } from '../server/session-import/mailbox';
import { sealEnvelope } from '../server/session-import/envelope';
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
import { accountsFor, registerUser, TestClock, testGateway } from './server-fixture';

async function harness() {
  const clock = new TestClock();
  const store = new ControlDatabase(':memory:', clock);
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
    store.security.authAttempts,
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
  const deployment = await importer.deployment(user.tenantId, 'viewer.example:3001');
  const envelope = (payload = importPayload()) =>
    sealEnvelope(Buffer.from(deployment.key.x25519, 'base64url'), deployment.key.id, payload);
  const payload = () => importPayload({ createdAt: clock.wallMs() });
  return {
    store,
    clock,
    user,
    gateway,
    importer,
    deployment,
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

test('mail keeps foreign headers and keys, deletes unknown users and replay only after database commit', async () => {
  const h = await harness();
  try {
    const valid = h.payload();
    const foreign = h.envelope();
    foreign[5] ^= 1;
    const malformed = h.envelope();
    malformed[0] ^= 1;
    const unknownUser = sealEnvelope(
      Buffer.from(h.deployment.key.x25519, 'base64url'),
      h.deployment.key.id,
      importPayload({ username: 'missing-user' }),
    );
    const client = new FakeMailClient();
    client.messages = h.messages;
    client.add(1, foreign);
    client.add(2, unknownUser);
    client.add(3, h.envelope(valid));
    client.add(4, h.envelope(valid));
    client.add(5, malformed);
    const originalFactoryRound = h.importer.mailbox;
    await originalFactoryRound.poll();
    assert.deepEqual(h.rounds[0].deleted, [2, 3, 4]);
    assert.ok(h.logs.includes('Session import discarded: unknown user'));
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
    assert.equal(h.importer.mailbox.status().lastSuccessAt === null, false);

    const owned = h.envelope();
    owned[owned.length - 1] ^= 1;
    assert.equal(await h.importer.receive(owned), 'delete');
    const invalid = uncheckedEnvelope(
      Buffer.from(h.deployment.key.x25519, 'base64url'),
      h.deployment.key.id,
      {
        ...h.payload(),
        sites: [{ name: 'bad', url: 'file:///bad' }],
      },
    );
    assert.equal(await h.importer.receive(invalid), 'delete');
    assert.equal(h.store.sessionImports.list(h.user.tenantId).length, 1);
    const stored = h.store.db.prepare('SELECT payload FROM session_imports WHERE id=?').get(valid.id) as {
      payload: string;
    };
    assert.equal(stored.payload.includes(valid.password), false);
    const { username, password, ...session } = valid;
    const saved = h.store.sessionImports.payload(h.user.tenantId, valid.id)!;
    assert.deepEqual(saved, session);
    assert.equal('username' in saved, false);
    assert.equal('password' in saved, false);
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
test('authenticated imports with expired, future or oversized payloads produce rejected records without payloads', async () => {
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
      uncheckedEnvelope(Buffer.from(h.deployment.key.x25519, 'base64url'), h.deployment.key.id, p),
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
    h.store.sessionImports.deleteUser(h.user.tenantId);
    assert.deepEqual(h.importer.state(h.user.tenantId).imports, []);
  } finally {
    await h.close();
  }
});
test('deployment preserves Browser identity and keys persist sealed at rest', async () => {
  const h = await harness();
  try {
    const keys = h.store.sessionImports.keys()!;
    const sealed = h.store.db.prepare('SELECT private_key FROM session_import_keys').get() as {
      private_key: string;
    };
    assert.equal(sealed.private_key.includes(keys.privateKey.toString('base64url')), false);
    const second = new SessionImporter(
      h.store,
      h.gateway,
      h.store.security.authAttempts,
      importConfig,
      undefined,
      h.clock,
      () => {},
    );
    const deployment = await second.deployment(h.user.tenantId, 'other.test:4321');
    assert.deepEqual(deployment, { ...h.deployment, server: 'other.test:4321' });
    assert.deepEqual(deployment.browser, {
      userAgent: browserIdentity.userAgent,
      ...browserIdentity.metadata,
    });
    assert.deepEqual(Object.keys(second.state(h.user.tenantId)).sort(), ['imports', 'receiving']);
    await second.stop();
    const disabled = new SessionImporter(h.store, h.gateway, h.store.security.authAttempts);
    assert.equal(disabled.state(h.user.tenantId).receiving, false);
    await assert.rejects(disabled.deployment(h.user.tenantId, 'host'), { code: 'unavailable' });
    await disabled.stop();
  } finally {
    await h.close();
  }
});

test('WS deployment is admin-only, uses the upgrade Host and current product lease', async () => {
  const store = new ControlDatabase(':memory:');
  const identityTenants: string[] = [];
  const gateway = testGateway({
    async request(method, tenant) {
      if (method === 'session.identity') {
        identityTenants.push(tenant);
        return browserIdentity;
      }
      return {};
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
    const authority = (user: typeof a) => ({
      tenantId: user.tenantId,
      leaseId: user.tenantId,
      epoch: control.viewers.productEpoch(user.tenantId, user.tenantId)!,
    });
    const call = (method: string, params = {}, user = a) =>
      dispatchViewerRequest(control, authority(user), method, params, undefined, 'connected.example:7443');
    await assert.rejects(call('admin.sessionImportDeployment', {}, b), { code: 'forbidden' });
    assert.deepEqual(identityTenants, []);
    const deployment = await call('admin.sessionImportDeployment');
    const key = store.sessionImports.keys()!;
    assert.deepEqual(deployment, {
      v: 1,
      server: 'connected.example:7443',
      mailbox: importConfig.mailbox,
      key: { id: key.keyId, x25519: key.publicKey.toString('base64url') },
      browser: { userAgent: browserIdentity.userAgent, ...browserIdentity.metadata },
    });
    assert.deepEqual(identityTenants, [a.tenantId]);
    const other = importPayload();
    store.sessionImports.insert(b.tenantId, other, Date.now());
    assert.deepEqual(await call('sessionImport.delete', { id: other.id }), { ok: true });
    assert.equal(store.sessionImports.exists(other.id), true);
    assert.deepEqual(await call('sessionImport.state'), {
      receiving: true,
      imports: [],
    });
    await assert.rejects(call('sessionImport.state', { tenant: b.tenantId }), { code: 'invalid_request' });
    await control.security.lock(a.tenantId, control.tenants.get(a.tenantId).viewer!.security);
    for (const method of ['sessionImport.state', 'admin.sessionImportDeployment', 'sessionImport.delete'])
      await assert.rejects(call(method), { code: 'locked' });
  } finally {
    await control.close();
    store.db.close();
  }
});

test('WS deployment is unavailable without a mailbox configuration', async () => {
  const store = new ControlDatabase(':memory:');
  const control = createApplication(
    store,
    testGateway({
      async request() {
        return {};
      },
    }),
  );
  try {
    const user = await registerUser(store, 'unconfigured-admin', 'password123');
    await control.viewers.attachViewer(
      user.tenantId,
      'lease',
      () => {},
      { identity: user.token, valid: () => true },
      true,
    );
    await assert.rejects(
      dispatchViewerRequest(
        control,
        {
          tenantId: user.tenantId,
          leaseId: 'lease',
          epoch: control.viewers.productEpoch(user.tenantId, 'lease')!,
        },
        'admin.sessionImportDeployment',
        {},
        undefined,
        'viewer.test',
      ),
      { code: 'unavailable' },
    );
  } finally {
    await control.close();
    store.db.close();
  }
});

test('wrong passwords and disabled accounts are rejected without retaining payloads or logging passwords', async () => {
  const h = await harness();
  try {
    const wrong = h.payload();
    wrong.password = 'never-log-this-password';
    assert.equal(await h.importer.receive(h.envelope(wrong)), 'delete');
    assert.equal(h.record(wrong.id).state, 'rejected');
    assert.equal(h.record(wrong.id).error, '账户密码不正确');
    h.store.accounts.setDisabled(h.user.user.id, h.clock.wallMs());
    const disabled = h.payload();
    assert.equal(await h.importer.receive(h.envelope(disabled)), 'delete');
    assert.equal(h.record(disabled.id).state, 'rejected');
    assert.equal(h.record(disabled.id).error, '账户已停用');
    assert.equal(
      h.store.db.prepare('SELECT 1 FROM session_imports WHERE payload IS NOT NULL').get(),
      undefined,
    );
    for (const password of [wrong.password, disabled.password])
      assert.equal(JSON.stringify(h.logs).includes(password), false);
    assert.equal(
      h.requests.some((r) => r.method === 'session.storage.import'),
      false,
    );
  } finally {
    await h.close();
  }
});

test('mail and login share the password budget; rate-limited mail is kept and retried each round', async () => {
  const h = await harness();
  try {
    const accounts = accountsFor(h.store);
    for (let i = 0; i < 5; i++)
      await assert.rejects(accounts.login('IMPORT-USER', 'wrong-password'), { code: 'unauthenticated' });
    const wrong = h.payload();
    wrong.password = 'wrong-mail-password';
    assert.equal(await h.importer.receive(h.envelope(wrong)), 'delete');
    assert.equal(h.record(wrong.id).error, '账户密码不正确');
    await assert.rejects(accounts.login('import-user', 'import-password'), { code: 'rate_limited' });
    const pending = h.payload();
    const bytes = h.envelope(pending);
    assert.equal(await h.importer.receive(bytes), 'retry');
    const client = new FakeMailClient();
    client.messages = h.messages;
    client.add(1, bytes);
    for (let round = 0; round < 2; round++) {
      await h.importer.mailbox.poll();
      assert.deepEqual(h.rounds[round].deleted, []);
      assert.ok(h.rounds[round].calls.includes('download:1:2.1:true'));
      assert.ok(h.messages.has(1));
      assert.equal(h.record(pending.id), undefined);
    }
    h.clock.advance(60001);
    await h.importer.mailbox.poll();
    assert.deepEqual(h.rounds[2].deleted, [1]);
    assert.equal(h.messages.has(1), false);
    assert.equal(h.record(pending.id).state, 'pending');
  } finally {
    await h.close();
  }
});

test('replay is deleted before password verification and consumes no password attempts', async () => {
  const h = await harness();
  try {
    const p = h.payload();
    p.username = 'IMPORT-USER';
    assert.equal(await h.importer.receive(h.envelope(p)), 'delete');
    const first = h.record(p.id);
    for (let i = 0; i < 6; i++)
      assert.equal(await h.importer.receive(h.envelope({ ...p, password: 'wrong-password' })), 'delete');
    assert.deepEqual(h.record(p.id), first);
    const accounts = accountsFor(h.store);
    for (let i = 0; i < 5; i++)
      await assert.rejects(accounts.login('import-user', 'wrong-password'), { code: 'unauthenticated' });
    assert.equal(await h.importer.receive(h.envelope({ ...p, password: 'wrong-password' })), 'delete');
    assert.equal(await h.importer.receive(h.envelope(h.payload())), 'retry');
  } finally {
    await h.close();
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
