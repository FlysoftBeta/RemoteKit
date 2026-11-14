import { SessionImporter } from '../server/session-import/importer';
import { ControlDatabase } from '../server/persistence/database';
import { openMessage } from '../server/session-import/envelope';
import { registerUser, testGateway } from './server-fixture';
import {
  importConfig,
  FakeMailClient,
  controlPublic,
  controlPrivate,
  controlKeyId,
  devicePublic,
  devicePrivate,
  deviceKeyId,
  deviceEnvelope,
  pairEvent,
  importEvent,
} from './session-import-fixture';
import { operation, type OwnerFactory } from './retry-loop-boundary';

export function driveImports(
  path: 'mailbox' | 'outbox' | 'pair' | 'chunk' | 'record' | 'dispatch' | 'tenant',
): OwnerFactory {
  return async (boundary, t) => {
    const clock = { wallMs: () => Date.now(), monotonicMs: () => Date.now() };
    const store = new ControlDatabase(':memory:', { buildId: 'test', clock });
    const user = await registerUser(store, 'import-user', 'import-password');
    const tenant = user.tenantId;
    store.sessionImports.saveKeys(controlPublic, controlPrivate, controlKeyId);
    const client = new FakeMailClient();
    let config = { ...importConfig, imap: { ...importConfig.imap }, smtp: { ...importConfig.smtp } };
    let active = false;
    const gateway = testGateway({
      observe: () => ({ running: true, browserIncarnation: 'import-browser', views: [] }),
      request: async (method, _tenant, args) => {
        if (method === 'session.storage.import' || method === 'session.storage.importStatus') {
          const result = {
            state: 'done',
            cookies: { applied: 1, rejected: 0 },
            localStorage: { applied: 1, rejected: 0 },
          };
          return path === 'chunk' ? boundary.call({ method, args }, result) : result;
        }
        return {};
      },
    });
    gateway.placement.resolve(tenant);
    const peek = gateway.placement.peek.bind(gateway.placement);
    gateway.placement.peek = (id) => (active ? peek(id) : undefined);
    const create = () =>
      new SessionImporter(
        store,
        gateway,
        store.security.authAttempts,
        config,
        (clientConfig) => {
          if (path === 'mailbox')
            client.connect = () => boundary.call({ host: clientConfig.imap.host }, undefined);
          return client;
        },
        clock,
        () => {},
        (transportConfig) => ({
          sendMail: async (mail) => {
            if (path === 'outbox') {
              const attachment = mail.attachments![0] as { content: Buffer };
              await boundary.call(
                {
                  host: transportConfig.smtp.host,
                  to: mail.to,
                  message: openMessage(devicePrivate, deviceKeyId, attachment.content).message,
                },
                undefined,
              );
            }
          },
        }),
      );
    let owner = create();
    if (path === 'pair') {
      const run = store.security.authAttempts.run.bind(store.security.authAttempts);
      t.mock.method(store.security.authAttempts, 'run', async (key: string, work: () => Promise<unknown>) => {
        await boundary.call({ key }, undefined);
        return run(key, work);
      });
    }
    owner.pairing(tenant, true);
    let pair = deviceEnvelope([pairEvent({ at: Date.now(), code: owner.state(tenant).pairing.code! })]);
    const event = importEvent({ at: Date.now() });
    if (['chunk', 'record', 'dispatch', 'tenant'].includes(path)) {
      await owner.receiveBatch([pair]);
      await owner.receiveBatch([deviceEnvelope([event])]);
    }
    if (path === 'record') {
      const payload = store.sessionImports.payload.bind(store.sessionImports);
      t.mock.method(store.sessionImports, 'payload', (tenant: string, id: string) =>
        boundary.callSync({ tenant, id }, payload(tenant, id)),
      );
    }
    const wakeups: (() => void)[] = [];
    if (path === 'dispatch') {
      const interval = globalThis.setInterval;
      t.mock.method(globalThis, 'setInterval', ((callback: () => void, ms: number) => {
        if (ms === 15000) wakeups.push(callback);
        return interval(callback, ms);
      }) as typeof setInterval);
    }
    if (path === 'dispatch' || path === 'tenant') {
      const prepare = store.db.prepare.bind(store.db);
      t.mock.method(store.db, 'prepare', (sql: string) => {
        const selected =
          path === 'dispatch'
            ? sql.startsWith('DELETE FROM session_import_events')
            : sql.startsWith('SELECT * FROM session_imports WHERE tenant=');
        const statement = prepare(sql);
        return selected ? boundary.callSync({ sql }, statement) : statement;
      });
    }
    const queued = {
      type: 'pairRejected' as const,
      seq: 0 as const,
      ref: 1,
      at: Date.now() - 60000,
      reason: 'refused',
    };
    if (path === 'outbox') owner.outbox.enqueue(devicePublic, 0, [queued]);
    const result = operation();
    const run = () => {
      active = true;
      if (path === 'mailbox') return owner.mailbox.poll();
      if (path === 'outbox') return owner.outbox.flush();
      if (path === 'pair') return owner.receiveBatch([pair]);
      result.run(() => owner.tick());
    };
    return {
      start:
        path === 'dispatch'
          ? () => {
              active = true;
              owner.start();
            }
          : run,
      drive:
        path === 'dispatch'
          ? () => {
              for (const wake of wakeups) wake();
            }
          : run,
      changeInput: async () => {
        boundary.version++;
        if (path === 'mailbox' || path === 'outbox') {
          await owner.stop();
          config = {
            ...config,
            imap: { ...config.imap, host: config.imap.host + '-new' },
            smtp: { ...config.smtp, host: config.smtp.host + '-new' },
          };
          owner = create();
          if (path === 'outbox') owner.outbox.enqueue(devicePublic, 0, [queued]);
        } else if (path === 'pair') {
          owner.pairing(tenant, true);
          pair = deviceEnvelope([pairEvent({ at: Date.now(), code: owner.state(tenant).pairing.code! })]);
        } else {
          Object.defineProperty(store, 'buildId', { configurable: true, value: 'changed' });
          peek(tenant)!.placementEpoch++;
          if (path === 'chunk')
            await owner.receiveBatch([deviceEnvelope([{ ...event, seq: event.seq + 1, at: Date.now() }])]);
        }
        if (path === 'dispatch') for (const wake of wakeups) wake();
        else await run();
      },
      error: () =>
        path === 'mailbox'
          ? (owner.mailbox.status().error ?? undefined)
          : path === 'outbox'
            ? (owner.outbox.status().error ?? undefined)
            : (owner.failures()[0]?.error ??
              owner.state(tenant).timeline.find((item) => item.record?.id === event.id)?.record?.error ??
              result.error()),
      dispose: async () => {
        await owner.stop();
        store.db.close();
      },
    };
  };
}
