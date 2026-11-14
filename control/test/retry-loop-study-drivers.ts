import { ControlDatabase } from '../server/persistence/database';
import { emptyWorkspace } from '../server/persistence/workspaces';
import { StudySync } from '../server/learning/study-sync';
import type { LearningAccounts } from '../server/learning/accounts';
import type { StudyService } from '../server/learning/study-service';
import type { FileLibrary } from '../server/files/library';
import { operation, type OwnerFactory } from './retry-loop-boundary';

export function driveStudy(
  path: 'collection' | 'attachment' | 'download' | 'import' | 'retention' | 'global' | 'tenant',
): OwnerFactory {
  return (boundary, t) => {
    const store = new ControlDatabase(':memory:', { buildId: 'test' });
    store.workspaces.writeWorkspace(emptyWorkspace('tenant'));
    store.db.prepare('INSERT OR IGNORE INTO learning_settings(tenant) VALUES (?)').run('tenant');
    const accounts = {
      session: () => (path === 'tenant' ? boundary.callSync({ credentials: 'changyan' }, {}) : {}),
      generation: () => boundary.version,
      state: () => ({ status: 'signed_in' }),
      signedInTenants: () =>
        path === 'global' ? boundary.callSync({ dispatch: 'tenants' }, ['tenant']) : ['tenant'],
    } as unknown as LearningAccounts;
    const importedEntries = new Set(path === 'retention' ? ['entry'] : []);
    const library = {
      entryExists: (_tenant: string, entryId: string) => importedEntries.has(entryId),
      expireStudyEntry: (_tenant: string, entryId: string, operationId: string) =>
        boundary.call({ entryId, operationId }, undefined),
      importFromControl: async (
        _tenant: string,
        params: { entryId: string },
        _authorize: unknown,
        commit: () => void,
      ) => {
        if (path === 'import') await boundary.call(params, undefined);
        commit();
        importedEntries.add(params.entryId);
      },
    } as unknown as FileLibrary;
    const item = {
      key: 'attachment',
      name: 'file',
      extension: 'txt',
      publishedAt: Date.now(),
      subject: 'subject',
      detail: '',
    };
    const study = {
      collect: (cutoff: number) =>
        path === 'collection' ? boundary.call({ cutoff }, []) : Promise.resolve([]),
      resolve: (key: string) =>
        path === 'attachment' ? boundary.call({ key }, item) : Promise.resolve(item),
      download: async () => ({
        size: 1,
        stream: (async function* () {
          yield Buffer.from('x');
        })(),
      }),
    } as unknown as StudyService;
    const objects = {
      put: async (tenant: string, stream: AsyncIterable<Buffer>) => {
        const chunks: Buffer[] = [];
        for await (const bytes of stream) chunks.push(Buffer.from(bytes));
        if (path === 'download')
          await boundary.call({ tenant, bytes: Buffer.concat(chunks).toString('hex') }, undefined);
        const id = 'a'.repeat(64);
        store.db.prepare('INSERT OR IGNORE INTO objects VALUES (?,?,?,?,?)').run(id, 1, 1, id, Date.now());
        return { id, size: 1 };
      },
      render: () => {},
      derived: () => undefined,
    };
    const owner = new StudySync(
      store,
      accounts,
      library,
      objects,
      () => study,
      () => {},
      () => Date.now(),
      () => 0.5,
    );
    const callbacks: (() => void)[] = [];
    if (path === 'global' || path === 'tenant') {
      const interval = setInterval;
      t.mock.method(globalThis, 'setInterval', (callback: () => void, ms: number) => {
        callbacks.push(callback);
        return interval(callback, ms);
      });
    }
    if (path === 'retention')
      store.db
        .prepare(
          `INSERT INTO learning_downloads
      (tenant,key,published_at,saved_at,entry_id,state) VALUES ('tenant','attachment',0,0,'entry','saved')`,
        )
        .run();
    const result = operation();
    const run = () => {
      if (path === 'global' || path === 'tenant') {
        callbacks.forEach((callback) => callback());
        return;
      }
      if (path === 'collection') owner.sync('tenant', true);
      else if (['attachment', 'download', 'import'].includes(path))
        result.run(() => owner.save('tenant', 'attachment', true));
      else result.run(() => owner.retention('tenant'));
    };
    return {
      start: () => {
        if (path === 'global' || path === 'tenant') owner.start();
        run();
      },
      drive: run,
      changeInput: () => {
        boundary.version++;
        Object.defineProperty(store, 'buildId', { value: String(boundary.version), configurable: true });
        if (path === 'retention')
          store.db
            .prepare("UPDATE learning_settings SET retention_days=retention_days+1 WHERE tenant='tenant'")
            .run();
        run();
      },
      error: () =>
        path === 'global' || path === 'tenant'
          ? owner.failures()[0]
          : path !== 'collection'
            ? owner.state('tenant').attachmentFailures?.[0]?.error
            : owner.state('tenant').error,
      dispose: async () => {
        await owner.stop();
        store.db.close();
      },
    };
  };
}
