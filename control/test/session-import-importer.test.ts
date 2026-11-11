import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SendMailOptions } from 'nodemailer';
import { ControlDatabase } from '../server/persistence/database';
import { SessionImporter, importChunks } from '../server/session-import/importer';
import { createMailClient } from '../server/session-import/mailbox';
import { createTransport, splitMessages } from '../server/session-import/outbox';
import { openMessage, publicKeyId, sealMessage } from '../server/session-import/envelope';
import { x25519Public } from '../server/session-import/hpke';
import { PAIR_REJECTED_REASON } from '../server/session-import/pairing';
import { RemoteKitError, type ErrorCode } from '../shared/errors';
import type { ControlEvent, DeviceEvent, ImportMessage } from '../shared/session-import';
import { createApplication } from '../server/application';
import { dispatchViewerRequest } from '../server/http/viewer-socket';
import { runtimeConfig } from '../server/config';
import {
  browserIdentity,
  FakeMailClient,
  importConfig,
  importEvent,
  pairEvent,
  deviceEnvelope,
  controlPrivate,
  controlPublic,
  controlKeyId,
  devicePrivate,
  devicePublic,
  deviceKeyId,
} from './session-import-fixture';
import { accountsFor, registerUser, TestClock, testGateway } from './server-fixture';

function last<T>(values: T[]): T {
  return values[values.length - 1];
}
async function harness(window = 30) {
  const clock = new TestClock();
  const store = new ControlDatabase(':memory:', { clock, buildId: 'test' });
  const user = await registerUser(store, 'import-user', 'import-password');
  store.sessionImports.saveKeys(controlPublic, controlPrivate, controlKeyId);
  const client = new FakeMailClient();
  client.subject = 'RemoteKit session import to ' + controlKeyId;
  const sent: SendMailOptions[] = [];
  let active = false,
    failure: ErrorCode | undefined,
    statusFailure: ErrorCode | undefined,
    smtpFailure = false;
  let statusHook: (() => void) | undefined;
  let chunks = 0;
  const requests: any[] = [];
  const gateway = testGateway({
    async request(method, _tenant, args) {
      requests.push({ method, args });
      if (method === 'session.identity') return browserIdentity;
      if (method === 'session.storage.import') {
        if (failure) throw new RemoteKitError(failure, 'Browser refused');
        chunks++;
        return { state: 'pending' };
      }
      if (method === 'session.storage.importStatus') {
        statusHook?.();
        if (statusFailure) throw new RemoteKitError(statusFailure, 'Job lost');
        return {
          state: 'done',
          cookies: { applied: 2, rejected: 1 },
          localStorage: { applied: 3, rejected: 2 },
        };
      }
      return {};
    },
  });
  gateway.placement.resolve(user.tenantId);
  const peek = gateway.placement.peek.bind(gateway.placement);
  gateway.placement.peek = (tenant) => (active ? peek(tenant) : undefined);
  const logs: string[] = [];
  const importer = new SessionImporter(
    store,
    gateway,
    store.security.authAttempts,
    { ...importConfig, replyWindowSeconds: window },
    () => client,
    clock,
    (s) => logs.push(s),
    () => ({
      async sendMail(mail) {
        if (smtpFailure) throw new RemoteKitError('unavailable', 'SMTP unavailable');
        sent.push(mail);
      },
    }),
  );
  const event = (seq = 2, patch: Partial<ReturnType<typeof importEvent>> = {}) =>
    importEvent({ seq, at: clock.wallMs(), ...patch });
  const pair = (patch: Partial<ReturnType<typeof pairEvent>> = {}) =>
    pairEvent({
      at: clock.wallMs(),
      code: importer.state(user.tenantId).pairing.code ?? pairEvent().code,
      ...patch,
    });
  const receive = (events: DeviceEvent[], ack = 0, key = devicePrivate) =>
    importer.receiveBatch([deviceEnvelope(events, ack, key)]).then((r) => r[0]);
  const replies = (): ControlEvent[] =>
    (
      store.db
        .prepare("SELECT body FROM session_import_events WHERE direction='out' AND tenant=? ORDER BY rowid")
        .all(user.tenantId) as { body: string }[]
    ).map((row) => JSON.parse(row.body));
  const state = () => importer.state(user.tenantId);
  const paired = async (key = devicePrivate) => {
    importer.pairing(user.tenantId, true);
    assert.equal(await receive([pair()], 0, key), 'delete');
  };
  return {
    clock,
    store,
    user,
    client,
    sent,
    gateway,
    importer,
    logs,
    event,
    pair,
    receive,
    replies,
    state,
    paired,
    requests,
    get chunks() {
      return chunks;
    },
    set active(value: boolean) {
      active = value;
    },
    set failure(value: ErrorCode | undefined) {
      failure = value;
    },
    set statusFailure(value: ErrorCode | undefined) {
      statusFailure = value;
    },
    set smtpFailure(value: boolean) {
      smtpFailure = value;
    },
    set statusHook(value: (() => void) | undefined) {
      statusHook = value;
    },
    record(id: string) {
      return store.sessionImports.get(id)!;
    },
    async close() {
      await importer.stop();
      store.db.close();
    },
  };
}
test('pairing opens a fresh encrypted five-word code, closes manually, expires and succeeds once', async () => {
  const h = await harness();
  try {
    assert.deepEqual(h.state().pairing, {
      open: false,
      code: null,
      expiresAt: null,
      failures: 0,
      closedReason: null,
    });
    const first = h.importer.pairing(h.user.tenantId, true);
    assert.equal(first.code!.length, 5);
    assert.equal(first.expiresAt, h.clock.wallMs() + 3 * 86400000);
    const stored = h.store.db.prepare('SELECT code FROM session_import_pairing').get() as any;
    assert.equal(stored.code.includes(first.code!.join(' ')), false);
    const second = h.importer.pairing(h.user.tenantId, true);
    assert.notDeepEqual(first.code, second.code);
    h.importer.pairing(h.user.tenantId, false);
    assert.equal(h.state().pairing.closedReason, 'user');
    h.importer.pairing(h.user.tenantId, true);
    h.clock.advance(3 * 86400000);
    await h.importer.tick();
    assert.equal(h.state().pairing.closedReason, 'expired');
    h.importer.pairing(h.user.tenantId, true);
    await h.receive([
      h.pair({ code: h.state().pairing.code!.map((word) => ' ' + word.toUpperCase() + ' ') }),
    ]);
    assert.equal(h.state().pairing.closedReason, 'paired');
    assert.equal(h.state().pairing.code, null);
    assert.deepEqual(h.state().devices, [
      { keyId: deviceKeyId, name: '测试手机', pairedAt: h.clock.wallMs(), lastRequestAt: h.clock.wallMs() },
    ]);
    assert.equal(last(h.replies()).type, 'paired');
  } finally {
    await h.close();
  }
});
test('closed pairing, password and code failures use the fixed reason and ten failures close the window', async () => {
  const h = await harness();
  try {
    await h.receive([h.pair()]);
    assert.equal(h.state().pairing.failures, 1);
    assert.equal(h.state().timeline[0].paired, false);
    h.importer.pairing(h.user.tenantId, true);
    for (let i = 0; i < 10; i++) {
      const event = h.pair(i % 2 ? { password: 'wrong' } : { code: ['bad', 'bad', 'bad', 'bad', 'bad'] });
      await h.receive([event]);
      h.clock.advance(61000);
      assert.equal(h.state().pairing.failures, i + 1);
      const reply = last(h.replies());
      assert.equal(reply.type, 'pairRejected');
      assert.equal((reply as any).reason, PAIR_REJECTED_REASON);
      assert.equal(reply.seq, 0);
    }
    assert.equal(h.state().pairing.closedReason, 'failures');
    assert.equal(h.state().pairing.open, false);
    assert.equal(h.state().devices.length, 0);
    const body = JSON.stringify(h.store.db.prepare('SELECT body FROM session_import_events').all());
    assert.equal(body.includes('password'), false);
    assert.equal(body.includes('code'), false);
  } finally {
    await h.close();
  }
});
test('unknown user replies only in memory, disabled users reject, same-user repeated pairs succeed and cross-user pairs reject', async () => {
  const h = await harness(0);
  try {
    await h.receive([h.pair({ username: 'unknown' })]);
    assert.equal(h.store.db.prepare('SELECT * FROM session_import_events').all().length, 0);
    assert.equal(h.importer.outbox.status().pending, 1);
    await h.importer.outbox.flush();
    const memory = openMessage(devicePrivate, deviceKeyId, (h.sent[0].attachments![0] as any).content)
      .message as ImportMessage<ControlEvent>;
    assert.equal(memory.events[0].type, 'pairRejected');
    h.store.db.prepare('UPDATE users SET disabled_at=1 WHERE tenant=?').run(h.user.tenantId);
    h.importer.pairing(h.user.tenantId, true);
    await h.receive([h.pair()]);
    assert.equal(h.state().devices.length, 0);
    h.store.db.prepare('UPDATE users SET disabled_at=NULL WHERE tenant=?').run(h.user.tenantId);
    await h.paired();
    await h.receive([h.pair({ seq: 2, password: 'unused', code: ['x', 'x', 'x', 'x', 'x'] })]);
    assert.equal(last(h.replies()).type, 'paired');
    const other = await registerUser(h.store, 'other-user', 'other-password');
    const code = h.importer.pairing(other.tenantId, true).code!;
    await h.receive([h.pair({ seq: 3, username: 'other-user', password: 'other-password', code })]);
    assert.equal(h.importer.state(other.tenantId).timeline[0].replies[0].type, 'pairRejected');
    assert.equal(h.store.sessionImports.device(deviceKeyId)!.tenant, h.user.tenantId);
  } finally {
    await h.close();
  }
});
test('password checks share login rate limits and keep the whole message without stored requests', async () => {
  const h = await harness();
  try {
    h.importer.pairing(h.user.tenantId, true);
    const accounts = accountsFor(h.store);
    for (let i = 0; i < 6; i++)
      await assert.rejects(accounts.login('import-user', 'wrong-password'), { code: 'unauthenticated' });
    assert.equal(await h.receive([h.pair(), h.event()]), 'keep');
    assert.equal(h.state().timeline.length, 0);
    h.clock.advance(61000);
    assert.equal(await h.receive([h.pair(), h.event()]), 'delete');
    assert.equal(h.state().timeline.length, 2);
    assert.equal(h.store.sessionImports.device(deviceKeyId)!.inSeq, 2);
  } finally {
    await h.close();
  }
});
test('pair and imports in one message are trusted in order and sensitive contents are encrypted or omitted', async () => {
  const h = await harness();
  try {
    h.importer.pairing(h.user.tenantId, true);
    const event = h.event();
    await h.receive([h.pair(), event]);
    assert.equal(h.record(event.id).state, 'pending');
    assert.ok(h.store.sessionImports.payload(h.user.tenantId, event.id));
    assert.equal(h.replies().filter((e) => e.type === 'importReceived').length, 1);
    const row = h.store.db.prepare('SELECT payload FROM session_imports').get() as any;
    assert.equal(row.payload.includes('secret'), false);
    const body = JSON.stringify(h.store.db.prepare('SELECT body FROM session_import_events').all());
    assert.equal(body.includes('secret'), false);
    assert.equal(body.includes('import-password'), false);
    assert.equal(body.includes('localStorage'), false);
    const entry = h.state().timeline.find((e) => e.request.type === 'import')!;
    assert.deepEqual(entry.request, {
      type: 'import',
      id: event.id,
      sites: event.sites,
      cookies: 1,
      origins: 1,
    });
    assert.equal(entry.record!.state, 'pending');
    assert.equal(entry.paired, true);
  } finally {
    await h.close();
  }
});
test('unpaired requests before pair are ignored, failed pair stops the rest, success acknowledges the complete range', async () => {
  const h = await harness();
  try {
    const event = h.event(1);
    await h.receive([event, h.pair({ seq: 2 }), h.event(3)]);
    assert.equal(h.store.sessionImports.get(event.id), undefined);
    assert.equal(h.state().timeline.length, 1);
    h.importer.pairing(h.user.tenantId, true);
    const second = h.event(3);
    await h.receive([event, h.pair({ seq: 2 }), second]);
    assert.equal(h.store.sessionImports.get(event.id), undefined);
    assert.equal(h.record(second.id).state, 'pending');
    assert.equal(h.store.sessionImports.device(deviceKeyId)!.inSeq, 3);
  } finally {
    await h.close();
  }
});
test('batch ordering sorts device ranges, ignores duplicates and keeps gaps across rounds', async () => {
  const h = await harness();
  try {
    await h.paired();
    const a = h.event(2),
      b = h.event(3),
      c = h.event(4);
    assert.deepEqual(await h.importer.receiveBatch([deviceEnvelope([c]), deviceEnvelope([a])]), [
      'keep',
      'delete',
    ]);
    assert.equal(h.store.sessionImports.get(c.id), undefined);
    assert.deepEqual(await h.importer.receiveBatch([deviceEnvelope([c]), deviceEnvelope([b])]), [
      'delete',
      'delete',
    ]);
    assert.equal(h.record(c.id).state, 'pending');
    const count = h.state().timeline.length;
    const outSeq = h.store.sessionImports.device(deviceKeyId)!.outSeq;
    await h.receive([a, b, c], outSeq);
    assert.equal(h.state().timeline.length, count);
    assert.equal(h.store.sessionImports.device(deviceKeyId)!.outSeq, outSeq);
    assert.equal(h.store.sessionImports.device(deviceKeyId)!.ackedSeq, outSeq);
  } finally {
    await h.close();
  }
});
test('import lifecycle applies all chunk counts, repeats current state and clears terminal payload', async () => {
  const h = await harness();
  try {
    await h.paired();
    const event = h.event(2, {
      localStorage: [
        {
          origin: 'https://example.com',
          items: Array.from({ length: 5 }, (_, i) => [String(i), 'x'.repeat(200000)]),
        },
      ],
    });
    await h.receive([event]);
    h.active = true;
    await h.importer.tick();
    const chunks = [...importChunks(event)];
    assert.ok(chunks.length > 1);
    const applied = h.replies().find((e) => e.type === 'importApplied') as Extract<
      ControlEvent,
      { type: 'importApplied' }
    >;
    assert.deepEqual(applied.cookies, { applied: 2 * chunks.length, rejected: chunks.length });
    assert.deepEqual(applied.localStorage, { applied: 3 * chunks.length, rejected: 2 * chunks.length });
    assert.equal(h.record(event.id).rejectedItems, 3 * chunks.length);
    assert.equal(h.record(event.id).state, 'applied');
    assert.equal(h.store.sessionImports.payload(h.user.tenantId, event.id), undefined);
    const before = h.chunks;
    await h.receive([{ ...event, seq: 3 }]);
    await h.importer.tick();
    assert.equal(h.chunks, before);
    assert.equal((last(h.replies()) as any).ref, 3);
    for (const chunk of chunks) assert.ok(Buffer.byteLength(JSON.stringify(chunk)) <= 512 * 1024);
  } finally {
    await h.close();
  }
});
test('imports recover lost begin replies and missing jobs with the same persisted identity', async () => {
  const h = await harness();
  try {
    await h.paired();
    const event = h.event();
    h.active = true;
    let begins = 0;
    const ids: string[] = [];
    h.gateway.storageImport = async (_tenant, args) => {
      ids.push(args.importId);
      assert.deepEqual(h.record(event.id).storageJob, { importId: args.importId });
      if (++begins === 1) throw new RemoteKitError('outcome_unknown', 'Reply lost after admission');
      return { state: 'pending' };
    };
    let polls = 0;
    h.gateway.storageImportStatus = async (_tenant, args) => {
      ids.push(args.importId);
      if (++polls === 1) throw new RemoteKitError('not_found', 'Browser restarted');
      return {
        state: 'done',
        cookies: { applied: 2, rejected: 0 },
        localStorage: { applied: 3, rejected: 0 },
      };
    };
    await h.receive([event]);
    await h.importer.tick();
    assert.equal(h.record(event.id).state, 'applied');
    assert.equal(begins, 3);
    assert.deepEqual([...new Set(ids)], [`${event.id}:0`]);
  } finally {
    await h.close();
  }
});

test('invalid or old imports fail per event, and id conflicts never overwrite another device', async () => {
  const h = await harness();
  try {
    await h.paired();
    const event = h.event(2, { cookies: Array(4097).fill(importEvent().cookies[0]) });
    const old = h.event(3, { at: h.clock.wallMs() - 31 * 86400000 });
    const bad = h.event(4, { sites: [] });
    const valid = h.event(5);
    await h.receive([event, old, bad, valid]);
    assert.equal(h.record(event.id).error, 'Cookie 超过 4096 条');
    assert.equal(h.record(old.id).error, '导入已超过 30 天');
    assert.equal(h.record(bad.id).state, 'failed');
    assert.equal(h.record(valid.id).state, 'pending');
    assert.equal((h.replies().find((e) => e.type === 'importFailed') as any).retryable, false);
    const another = randomBytes(32);
    await h.paired(another);
    await h.receive([{ ...valid, seq: 2 }], 0, another);
    const otherKeyId = publicKeyId(x25519Public(another));
    const reply = h.state().timeline.find((e) => e.keyId === otherKeyId && e.request.type === 'import')!
      .replies[0] as any;
    assert.equal(reply.reason, '导入 ID 冲突');
    assert.equal(reply.retryable, false);
    assert.equal(h.record(valid.id).keyId, deviceKeyId);
  } finally {
    await h.close();
  }
});
test('withdraw and Viewer discard clear pending payloads, use the correct refs and permit a retry', async () => {
  const h = await harness();
  try {
    await h.paired();
    const event = h.event();
    await h.receive([event]);
    await h.receive([{ ...event, seq: 3 }]);
    assert.equal((last(h.replies()) as any).type, 'importReceived');
    h.importer.discard(h.user.tenantId, event.id);
    assert.equal(h.record(event.id).state, 'discarded');
    assert.equal((last(h.replies()) as any).ref, 3);
    assert.throws(() => h.importer.discard(h.user.tenantId, event.id), { code: 'invalid_request' });
    await h.receive([{ ...event, seq: 4 }]);
    assert.equal(h.record(event.id).state, 'pending');
    await h.receive([{ seq: 5, at: h.clock.wallMs(), type: 'withdraw', id: event.id }]);
    assert.equal(h.record(event.id).state, 'discarded');
    assert.equal((last(h.replies()) as any).ref, 5);
    assert.equal(h.store.sessionImports.payload(h.user.tenantId, event.id), undefined);
  } finally {
    await h.close();
  }
});
test('device removal discards pending imports, emits revoked, preserves timeline and deletes later mail silently', async () => {
  const h = await harness(0);
  try {
    await h.paired();
    const event = h.event();
    await h.receive([event]);
    h.importer.removeDevice(h.user.tenantId, deviceKeyId);
    assert.equal(h.state().devices.length, 0);
    assert.equal(h.record(event.id).state, 'discarded');
    assert.equal(
      h.state().timeline.every((e) => !e.paired),
      true,
    );
    const events = h.store.sessionImports.outgoing();
    assert.equal(last(events).event.type, 'revoked');
    const count = events.length;
    assert.equal(await h.receive([h.event(3)]), 'delete');
    assert.equal(h.store.sessionImports.outgoing().length, count);
    await h.importer.outbox.flush();
    const sent = openMessage(devicePrivate, deviceKeyId, (h.sent[0].attachments![0] as any).content)
      .message as ImportMessage<ControlEvent>;
    assert.equal(last(sent.events).type, 'revoked');
    assert.equal(sent.ack, 2);
  } finally {
    await h.close();
  }
});
test('outbox waits for the newest event window, caps delay at five minutes and sends v2 mail', async () => {
  const h = await harness(600);
  try {
    await h.paired();
    await h.importer.outbox.flush();
    assert.equal(h.sent.length, 0);
    h.clock.advance(290000);
    await h.receive([h.event()]);
    await h.importer.outbox.flush();
    assert.equal(h.sent.length, 0);
    h.clock.advance(10000);
    await h.importer.outbox.flush();
    assert.equal(h.sent.length, 1);
    const mail = h.sent[0];
    assert.equal(mail.subject, 'RemoteKit session import to ' + deviceKeyId);
    assert.equal(mail.from, importConfig.mailbox);
    assert.equal(mail.to, importConfig.appMailbox);
    assert.deepEqual(mail.headers, { 'X-RemoteKit-Import': '2' });
    assert.equal(mail.attachments![0].filename, 'message.rksi');
    const message = openMessage(devicePrivate, deviceKeyId, (mail.attachments![0] as any).content)
      .message as ImportMessage<ControlEvent>;
    assert.equal(message.ack, 2);
    assert.deepEqual(
      message.events.map((e) => e.type),
      ['paired', 'importReceived'],
    );
    assert.equal(h.importer.outbox.status().pending, 0);
    await h.receive([h.event(3)], 2);
    h.clock.advance(599999);
    await h.importer.outbox.flush();
    // The oldest-event cap also applies when only one event is waiting.
    assert.equal(h.sent.length, 2);
  } finally {
    await h.close();
  }
});
test('outbox debounce window restarts after each event', async () => {
  const h = await harness();
  try {
    await h.paired();
    h.clock.advance(20000);
    await h.receive([h.event()]);
    h.clock.advance(10000);
    await h.importer.outbox.flush();
    assert.equal(h.sent.length, 0);
    h.clock.advance(20000);
    await h.importer.outbox.flush();
    assert.equal(h.sent.length, 1);
  } finally {
    await h.close();
  }
});
test('outbox doubles retry backoff to one hour, retains errors and clears pending after recovery', async () => {
  const h = await harness(0);
  try {
    await h.paired();
    h.smtpFailure = true;
    for (let attempt = 1; attempt <= 8; attempt++) {
      await h.importer.outbox.flush();
      assert.equal(h.importer.outbox.status().lastErrorAt, h.clock.wallMs());
      assert.equal(h.importer.outbox.status().pending, 1);
      assert.equal(h.importer.outbox.status().lastError, 'SMTP unavailable');
      const failedAt = h.clock.wallMs();
      const delay = Math.min(1000 * 2 ** (attempt - 1), 300000);
      h.clock.advance(delay - 1);
      await h.importer.outbox.flush();
      assert.equal(h.importer.outbox.status().lastErrorAt, failedAt);
      h.clock.advance(1);
    }
    h.smtpFailure = false;
    await h.importer.outbox.flush();
    assert.equal(h.sent.length, 1);
    assert.equal(h.importer.outbox.status().lastError, null);
  } finally {
    await h.close();
  }
});
test('ack-driven retransmission queues the unacknowledged range at most every fifteen minutes', async () => {
  const h = await harness(0);
  try {
    await h.paired();
    await h.receive([h.event()]);
    await h.importer.outbox.flush();
    await h.receive([], 1);
    assert.equal(h.importer.outbox.status().pending, 1);
    await h.importer.outbox.flush();
    await h.receive([], 1);
    assert.equal(h.importer.outbox.status().pending, 0);
    h.clock.advance(899999);
    await h.receive([], 1);
    assert.equal(h.importer.outbox.status().pending, 0);
    h.clock.advance(1);
    await h.receive([], 1);
    assert.equal(h.importer.outbox.status().pending, 1);
    await h.importer.outbox.flush();
    await h.receive([], 2);
    assert.equal(h.importer.outbox.status().pending, 0);
    assert.equal(h.store.sessionImports.device(deviceKeyId)!.ackedSeq, 2);
    const message = openMessage(devicePrivate, deviceKeyId, (last(h.sent).attachments![0] as any).content)
      .message as ImportMessage<ControlEvent>;
    assert.deepEqual(
      message.events.map((e) => e.seq),
      [2],
    );
  } finally {
    await h.close();
  }
});
test('outbox splits at real uncompressed limits and separates seq-zero rejections from ordered ranges', () => {
  const events: ControlEvent[] = Array.from({ length: 4 }, (_, i) => ({
    seq: i + 1,
    at: 0,
    type: 'importFailed',
    ref: 1,
    id: 'bf81f466-e992-48e5-a3d3-6b168556c471',

    reason: 'x'.repeat(9 * 1024 * 1024),
    retryable: false,
  }));
  const envelopes = splitMessages(
    { publicKey: controlPublic, privateKey: controlPrivate },
    devicePublic,
    2,
    events,
  );
  assert.ok(envelopes.length > 1);
  const opened = envelopes.map(
    (e) => openMessage(devicePrivate, deviceKeyId, e.bytes).message as ImportMessage<ControlEvent>,
  );
  assert.deepEqual(
    opened.flatMap((m) => m.events.map((e) => e.seq)),
    [1, 2, 3, 4],
  );
  const ranges = splitMessages({ publicKey: controlPublic, privateKey: controlPrivate }, devicePublic, 0, [
    { seq: 0, at: 0, type: 'pairRejected', ref: 1, reason: 'rejected' },
    { seq: 1, at: 0, type: 'paired', ref: 2, username: 'u' },
  ]);
  assert.equal(ranges.length, 2);
});
test('mailbox batches attachments, sorts before applying, re-reads gaps and skips only other recipients or versions', async () => {
  const h = await harness();
  try {
    await h.paired();
    const a = h.event(2),
      b = h.event(3),
      c = h.event(4);
    h.client.add(1, deviceEnvelope([c]));
    h.client.add(2, deviceEnvelope([a]));
    const another = randomBytes(32);
    h.client.add(
      3,
      sealMessage(devicePrivate, devicePublic, x25519Public(another), { v: 2, ack: 0, events: [] }),
    );
    const v1 = Buffer.alloc(100);
    v1.write('RKSI');
    v1[4] = 1;
    h.client.add(4, v1);
    h.client.add(5, Buffer.alloc(100));
    h.client.add(7, deviceEnvelope([a]), 'RemoteKit session import to 0000000000000000');
    h.client.add(8, deviceEnvelope([a]), '欢迎来到网易邮箱');
    await h.importer.mailbox.poll();
    assert.deepEqual(h.client.deleted, [2, 5]);
    assert.ok(h.client.calls.includes('search:since:true'));
    assert.ok(!h.client.calls.some((c) => c.startsWith('download:7:') || c.startsWith('download:8:')));
    assert.ok(h.client.messages.has(7) && h.client.messages.has(8));
    assert.ok(h.client.calls.indexOf('fetch:done') < h.client.calls.indexOf('download:1:2.1:true'));
    h.client.add(6, deviceEnvelope([b]));
    await h.importer.mailbox.poll();
    assert.deepEqual(h.client.deleted, [2, 5, 1, 6]);
    assert.equal(h.client.calls.filter((c) => c === 'download:1:2.1:true').length, 2);
    assert.equal(h.client.calls.filter((c) => c === 'download:3:2.1:true').length, 1);
    assert.equal(h.client.calls.filter((c) => c === 'download:4:2.1:true').length, 1);
    h.client.failure = new RemoteKitError('unavailable', 'IMAP closed');
    await h.importer.mailbox.poll();
    assert.equal(h.importer.mailbox.status().lastError, 'IMAP closed');
    h.client.failure = undefined;
    h.clock.advance(1000);
    await h.importer.mailbox.poll();
    assert.equal(h.importer.mailbox.status().lastError, null);
  } finally {
    await h.close();
  }
});
test('mailbox starts at the current time and then resumes from its UID watermark', async () => {
  const h = await harness();
  try {
    const subject = h.client.subject;
    const now = h.clock.wallMs();
    h.client.add(1, Buffer.alloc(100), subject, new Date(now - 2 * 24 * 60 * 60 * 1000));
    await h.importer.mailbox.poll();
    assert.ok(h.client.calls.includes('search:since:true'));
    assert.ok(!h.client.calls.some((c) => c.startsWith('download:1:')));
    h.client.add(2, Buffer.alloc(100), 'unrelated', new Date(now));
    h.client.calls.length = 0;
    await h.importer.mailbox.poll();
    assert.ok(h.client.calls.includes('range:2:*'));
    assert.ok(!h.client.calls.includes('search:since:true'));
    h.client.calls.length = 0;
    await h.importer.mailbox.poll();
    assert.ok(h.client.calls.includes('range:3:*'));
    assert.ok(!h.client.calls.some((c) => c.startsWith('download:')));
    h.client.add(3, Buffer.alloc(100), subject, new Date(now));
    h.client.calls.length = 0;
    await h.importer.mailbox.poll();
    assert.ok(h.client.calls.includes('download:3:2.1:true'));
    assert.deepEqual(h.client.deleted, [3]);
    h.client.uidValidity = 2n;
    h.client.calls.length = 0;
    await h.importer.mailbox.poll();
    assert.ok(h.client.calls.includes('search:since:true'));
    assert.ok(!h.client.calls.some((c) => c.startsWith('download:1:')));
    assert.deepEqual(h.store.sessionImports.mailCursor(0).uidValidity, '2');
  } finally {
    await h.close();
  }
});
test('retention deletes old events and terminal imports, keeps pending imports and caps timeline at newest 200', async () => {
  const h = await harness();
  try {
    await h.paired();
    const event = h.event();
    await h.receive([event]);
    h.importer.discard(h.user.tenantId, event.id);
    const pending = h.event(3);
    await h.receive([pending]);
    h.clock.advance(181 * 86400000);
    await h.importer.tick();
    assert.equal(h.store.sessionImports.get(event.id), undefined);
    assert.equal(h.record(pending.id).state, 'pending');
    assert.equal(h.state().timeline.length, 0);
    h.active = true;
    await h.importer.tick();
    assert.equal(h.record(pending.id).state, 'applied');
    assert.equal((last(h.replies()) as Extract<ControlEvent, { type: 'importApplied' }>).ref, 3);
    h.active = false;
    const events = Array.from({ length: 205 }, (_, i) => h.event(i + 4));
    await h.receive(events);
    assert.equal(h.state().timeline.length, 200);
    assert.equal(h.state().timeline[0].seq, 208);
  } finally {
    await h.close();
  }
});
test('TLS factories require implicit IMAP TLS, send IMAP ID, and enforce SMTP TLS', () => {
  const imap = createMailClient(importConfig) as any;
  assert.equal(imap.options.secure, true);
  assert.equal(imap.options.disableAutoIdle, true);
  assert.deepEqual(imap.options.clientInfo, { name: 'RemoteKit', version: '1' });
  imap.close();
  for (const port of [465, 587]) {
    const transport = createTransport({ ...importConfig, smtp: { ...importConfig.smtp, port } }) as any;
    assert.equal(transport.options.secure, port === 465);
    assert.equal(transport.options.requireTLS, port === 587);
    transport.close();
  }
});
test('WS methods require the product lease, deployment is admin-only and overview exposes inbox/outbox failures', async () => {
  const h = await harness(0);
  const control = createApplication(h.store, h.gateway, undefined, h.clock, undefined, importConfig);
  await control.sessionImporter.stop();
  control.sessionImporter = h.importer;
  try {
    const other = await registerUser(h.store, 'ws-other', 'password123');
    for (const user of [h.user, other])
      await control.viewers.attachViewer(
        user.tenantId,
        user.tenantId,
        () => {},
        { identity: user.token, valid: () => true },
        true,
      );
    const authority = (user = h.user) => ({
      tenantId: user.tenantId,
      leaseId: user.tenantId,
      epoch: control.viewers.productEpoch(user.tenantId, user.tenantId)!,
    });
    const call = (method: string, params = {}, user = h.user) =>
      dispatchViewerRequest(control, authority(user), method, params, undefined, 'connected.example:7443');
    await assert.rejects(call('admin.sessionImportDeployment', {}, other), { code: 'forbidden' });
    const deployment = await call('admin.sessionImportDeployment');
    assert.equal(deployment.server, 'connected.example:7443');
    assert.equal(deployment.key.id, controlKeyId);
    assert.equal((await call('sessionImport.state')).receiving, true);
    assert.equal((await call('sessionImport.pairing', { open: true })).open, true);
    await h.receive([h.pair(), h.event()]);
    const id = h.state().timeline.find((e) => e.request.type === 'import')!.record!.id;
    await assert.rejects(call('sessionImport.discard', { id }, other), { code: 'invalid_request' });
    assert.deepEqual(await call('sessionImport.discard', { id }), { ok: true });
    h.smtpFailure = true;
    await h.importer.outbox.flush();
    h.client.failure = new RemoteKitError('unavailable', 'IMAP failed');
    await h.importer.mailbox.poll();
    const overview = await call('admin.overview');
    assert.equal(overview.sessionImport.lastError, 'IMAP failed');
    assert.equal(overview.sessionImport.outbox.lastError, 'SMTP unavailable');
    assert.ok(overview.sessionImport.outbox.pending > 0);
    await assert.rejects(call('sessionImport.removeDevice', { keyId: deviceKeyId }, other), {
      code: 'not_found',
    });
    assert.deepEqual(await call('sessionImport.removeDevice', { keyId: deviceKeyId }), { ok: true });
    await assert.rejects(call('sessionImport.delete', { id }), { code: 'invalid_request' });
    await assert.rejects(call('sessionImport.state', { tenant: other.tenantId }), {
      code: 'invalid_request',
    });
    await control.security.lock(h.user.tenantId, control.tenants.get(h.user.tenantId).viewer!.security);
    for (const method of [
      'sessionImport.state',
      'sessionImport.pairing',
      'sessionImport.removeDevice',
      'sessionImport.discard',
      'admin.sessionImportDeployment',
    ])
      await assert.rejects(call(method), { code: 'locked' });
  } finally {
    await control.close();
    h.store.db.close();
  }
});
test('disabled importer state and deployment do not expose or generate keys', async () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  const importer = new SessionImporter(
    store,
    testGateway({
      async request() {
        return {};
      },
    }),
    store.security.authAttempts,
  );
  try {
    assert.equal(importer.state('tenant').receiving, false);
    assert.equal(store.sessionImports.keys(), undefined);
    await assert.rejects(importer.deployment('tenant', 'host'), { code: 'unavailable' });
    assert.throws(() => importer.pairing('tenant', true), { code: 'unavailable' });
  } finally {
    await importer.stop();
    store.db.close();
  }
});
test('session import config is optional, strict, requires SMTP/app mailbox and validates TLS ports and windows', async () => {
  const scratch = resolve(import.meta.dirname, '../../develop/tmp');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(resolve(scratch, 'session-import-config-'));
  const configPath = resolve(directory, 'control.json');
  const load = () => runtimeConfig({ REMOTEKIT_CONTROL_CONFIG: configPath }, []);
  try {
    assert.equal(load().sessionImport, undefined);
    assert.equal('sessionImport' in JSON.parse(await readFile(configPath, 'utf8')), false);
    const minimal = {
      mailbox: 'import@example.com',
      appMailbox: 'app@example.com',
      imap: { host: 'imap.example.com', user: 'u', password: 'p' },
      smtp: { host: 'smtp.example.com', port: 465, user: 'u', password: 'p' },
    };
    await writeFile(configPath, JSON.stringify({ nodes: {}, sessionImport: minimal }));
    assert.deepEqual(load().sessionImport, {
      ...minimal,
      imap: { ...minimal.imap, port: 993 },
      folder: 'INBOX',
      pollSeconds: 60,
      replyWindowSeconds: 30,
    });
    for (const invalid of [
      null,
      {},
      { ...minimal, smtp: undefined },
      { ...minimal, appMailbox: undefined },
      { ...minimal, appMailbox: 'bad' },
      { ...minimal, extra: 1 },
      { ...minimal, imap: { ...minimal.imap, tls: false } },
      { ...minimal, smtp: { ...minimal.smtp, tls: false } },
      ...['25', 25, 0, 466, 588].map((port) => ({ ...minimal, smtp: { ...minimal.smtp, port } })),
      { ...minimal, replyWindowSeconds: -1 },
      { ...minimal, replyWindowSeconds: 601 },
      { ...minimal, replyWindowSeconds: '30' },
      { ...minimal, pollSeconds: 14 },
      { ...minimal, pollSeconds: 3601 },
      { ...minimal, folder: '' },
      { ...minimal, mailbox: 'bad' },
    ]) {
      await writeFile(configPath, JSON.stringify({ nodes: {}, sessionImport: invalid }));
      assert.throws(load, { code: 'invalid_request' });
    }
    for (const port of [465, 587])
      for (const replyWindowSeconds of [0, 600]) {
        await writeFile(
          configPath,
          JSON.stringify({
            nodes: {},
            sessionImport: { ...minimal, smtp: { ...minimal.smtp, port }, replyWindowSeconds },
          }),
        );
        assert.equal(load().sessionImport!.replyWindowSeconds, replyWindowSeconds);
      }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('multiple pair events cannot reassign a newly paired key to a second tenant', async () => {
  const h = await harness();
  try {
    const other = await registerUser(h.store, 'other-pair-user', 'other-password');
    h.importer.pairing(h.user.tenantId, true);
    const otherCode = h.importer.pairing(other.tenantId, true).code!;
    await h.receive([
      h.pair(),
      h.pair({ seq: 2, username: 'other-pair-user', password: 'other-password', code: otherCode }),
    ]);
    assert.equal(h.store.sessionImports.device(deviceKeyId)!.tenant, h.user.tenantId);
    assert.equal(h.importer.state(other.tenantId).timeline[0].replies[0].type, 'pairRejected');
    assert.equal(h.importer.state(other.tenantId).pairing.failures, 1);
  } finally {
    await h.close();
  }
});
test('closing a pairing window during password verification rejects without reopening it', async () => {
  const h = await harness();
  try {
    h.importer.pairing(h.user.tenantId, true);
    const event = h.pair();
    const original = h.store.security.authAttempts.run.bind(h.store.security.authAttempts);
    h.store.security.authAttempts.run = async (key, work, limit, interval) => {
      const result = await original(key, work, limit, interval);
      h.importer.pairing(h.user.tenantId, false);
      return result;
    };
    await h.receive([event]);
    assert.equal(h.state().devices.length, 0);
    assert.equal(h.state().pairing.closedReason, 'user');
    assert.equal(last(h.replies()).type, 'pairRejected');
  } finally {
    await h.close();
  }
});
test('discard and retry while a Browser job runs cannot finish the replacement payload with the old result', async () => {
  const h = await harness();
  try {
    await h.paired();
    h.active = true;
    let release!: () => void, started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    h.gateway.storageImportStatus = async () => {
      calls++;
      if (calls === 1) {
        started();
        await blocked;
      }
      return {
        state: 'done',
        cookies: { applied: calls, rejected: 0 },
        localStorage: { applied: 0, rejected: 0 },
      };
    };
    const event = h.event();
    await h.receive([event]);
    await waiting;
    h.importer.discard(h.user.tenantId, event.id);
    await h.receive([{ ...event, seq: 3 }]);
    release();
    await h.importer.tick();
    assert.equal(calls, 2);
    assert.equal(h.record(event.id).state, 'applied');
    const applied = last(h.replies()) as Extract<ControlEvent, { type: 'importApplied' }>;
    assert.equal(applied.ref, 3);
    assert.equal(applied.cookies.applied, 2);
  } finally {
    await h.close();
  }
});
test('SMTP completion after tenant deletion cannot mark a reused event row as mailed', async () => {
  const h = await harness();
  try {
    await h.paired();
    const old = h.store.sessionImports.outgoing()[0];
    h.store.sessionImports.deleteUser(h.user.tenantId);
    h.store.sessionImports.addDevice(
      deviceKeyId,
      h.user.tenantId,
      devicePublic,
      'replacement',
      h.clock.wallMs(),
    );
    h.store.sessionImports.incoming(
      h.user.tenantId,
      deviceKeyId,
      devicePublic,
      'replacement',
      h.pair(),
      h.clock.wallMs(),
    );
    h.store.sessionImports.reply(
      h.user.tenantId,
      deviceKeyId,
      { type: 'paired', ref: 1, username: 'replacement' },
      h.clock.wallMs(),
    );
    const replacement = h.store.sessionImports.outgoing()[0];
    assert.equal(replacement.rowId, old.rowId);
    h.store.sessionImports.mailed(old, h.clock.wallMs());
    assert.equal(h.store.sessionImports.outgoing().length, 1);
  } finally {
    await h.close();
  }
});

test('tenant hard-delete purges every row and sends the final revocation from memory after commit', async () => {
  const h = await harness(0);
  try {
    await h.paired();
    const event = h.event();
    await h.receive([event]);
    const mail = h.store.transaction(() => h.importer.deleteUser(h.user.tenantId));
    h.importer.queueDeletedDevices(mail);
    for (const table of [
      'session_import_pairing',
      'session_import_devices',
      'session_import_events',
      'session_imports',
    ])
      assert.equal(
        h.store.db.prepare(`SELECT * FROM ${table} WHERE tenant=?`).all(h.user.tenantId).length,
        0,
      );
    const pending = h.importer.outbox.status().pending;
    assert.equal(await h.receive([h.pair()]), 'delete');
    assert.equal(h.importer.outbox.status().pending, pending);
    await h.importer.outbox.flush();
    const message = openMessage(devicePrivate, deviceKeyId, (h.sent[0].attachments![0] as any).content)
      .message as ImportMessage<ControlEvent>;
    assert.equal(message.ack, 2);
    assert.equal(last(message.events).type, 'revoked');
    assert.deepEqual(
      message.events.map((e) => e.seq),
      [1, 2, 3],
    );
    assert.equal(h.importer.outbox.status().pending, 0);
  } finally {
    await h.close();
  }
});
