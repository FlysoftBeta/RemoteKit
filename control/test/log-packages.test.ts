import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { ControlDatabase } from '../server/persistence/database';
import { readServerSettings } from '../server/persistence/server-settings';
import { LogRetention } from '../server/diagnostics/retention';
import { localDate } from '../server/log';
import { DiagnosticPackages } from '../server/diagnostics/packages';
import { DiagnosticSessions } from '../server/diagnostics/sessions';
import { FileLibrary } from '../server/files/library';
import { FILE_LIMITS } from '../shared/product';
import { RemoteKitError } from '../shared/errors';
import { createHttp } from '../server/http/server';
import { dispatchViewerRequest } from '../server/http/viewer-socket';
import type { DomainServices } from '../server/application';
import type { NodeRegistry } from '../server/cluster/node-link';
import { registerUser } from './server-fixture';
import { logNode } from './log-fixture';
import { hostFiles } from '../server/diagnostics/host-logs';
import { logPackageManifest } from '../server/diagnostics/formats';
import { decodeJson } from '../server/persistence/codec';
import { sourceAppName, sourceChannelName } from '../client/files/files-app-state';
import { archiveStream } from '../server/diagnostics/archive';

function unpack(bytes: Buffer) {
  const data = zstdDecompressSync(bytes);
  const members = new Map<string, Buffer>();
  for (let cursor = 0; data[cursor];) {
    const header = data.subarray(cursor, cursor + 512);
    const field = (start: number, end: number) => header.toString('utf8', start, end).split('\0')[0];
    const name = [field(345, 500), field(0, 100)].filter(Boolean).join('/');
    const size = parseInt(field(124, 136), 8);
    cursor += 512;
    members.set(name, data.subarray(cursor, cursor + size));
    cursor += Math.ceil(size / 512) * 512;
  }
  return members;
}

test('canceling an archive stream waits for its source to release resources', async () => {
  let released = false;
  async function* chunks() {
    try {
      for (let index = 0; index < 8; index++) yield randomBytes(1024 * 1024);
    } finally {
      released = true;
    }
  }
  const stream = archiveStream([{ name: 'large.jsonl', size: 8 * 1024 * 1024, chunks: chunks() }]);
  assert.equal((await stream.next()).done, false);
  await stream.return();
  assert.equal(released, true);
});

test('retention settings strictly persist and prune dates, crash mtimes and completed collections', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-retention-'));
  const store = new ControlDatabase(join(directory, 'control.db'), { buildId: 'test' });
  const now = new Date(2026, 10, 14, 12);
  const root = join(directory, 'logs');
  const archives = join(directory, 'diagnostics');
  const manager = new DiagnosticSessions(archives, {
    control: () => ({}),
    endpoint: async () => ({}),
    nodeLogs: () => undefined,
  });
  const owner = join(archives, createHash('sha256').update('tenant').digest('hex'));
  await Promise.all([
    mkdir(join(root, '2026-11-11'), { recursive: true }),
    mkdir(join(root, '2026-11-12'), { recursive: true }),
    mkdir(join(root, 'crashes', 'control'), { recursive: true }),
    mkdir(owner, { recursive: true }),
  ]);
  const old = new Date(2026, 10, 11);
  const fresh = new Date(2026, 10, 12);
  for (const [name, time] of [
    ['old.dmp', old],
    ['keep.dmp', fresh],
  ] as const) {
    const file = join(root, 'crashes', 'control', name);
    await writeFile(file, 'dump');
    await utimes(file, time, time);
  }
  const id = randomUUID();
  await writeFile(join(owner, id + '.tar.zst'), 'archive');
  await writeFile(join(owner, id + '.reason'), '{"version":1,"reason":"user"}');
  await utimes(join(owner, id + '.tar.zst'), old, old);
  const sent: number[] = [];
  const nodes = { setLogRetentionDays: (days: number) => sent.push(days) } as unknown as NodeRegistry;
  const retention = new LogRetention(store, nodes, root, manager, () => now);
  t.after(async () => {
    await retention.close();
    await manager.shutdown();
    store.db.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(readServerSettings(store.db).logRetentionDays, 30);
  await retention.change(2);
  assert.deepEqual(sent, [2]);
  assert.equal(readServerSettings(store.db).logRetentionDays, 2);
  await assert.rejects(stat(join(root, '2026-11-11')), { code: 'ENOENT' });
  assert((await stat(join(root, '2026-11-12'))).isDirectory());
  await assert.rejects(stat(join(root, 'crashes/control/old.dmp')), { code: 'ENOENT' });
  assert((await stat(join(root, 'crashes/control/keep.dmp'))).isFile());
  await assert.rejects(stat(join(owner, id + '.tar.zst')), { code: 'ENOENT' });
  await assert.rejects(stat(join(owner, id + '.reason')), { code: 'ENOENT' });
  for (const days of [0, 366, 2.5, '30', null])
    await assert.rejects(retention.change(days), { code: 'invalid_request' });
  store.db.prepare('UPDATE server_settings SET data=?').run('{"version":1,"logRetentionDays":"30"}');
  assert.throws(() => readServerSettings(store.db), { reason: 'corrupt_record' });
});

test('day packages stream all hosts into the existing library importer, record failures, and enforce quota', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-package-'));
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  const { tenantId: tenant } = await registerUser(store, 'admin', 'password123');
  const day = localDate();
  await mkdir(join(directory, day));
  await writeFile(join(directory, day, 'control.jsonl'), 'control bytes');
  const node = logNode(new Map([[`${day}/endpoint.jsonl`, Buffer.from('node bytes')]]));
  const unavailable = { nodeId: 'offline', state: { state: 'offline' } };
  const failed = {
    ...node,
    nodeId: 'failed',
    request: async () => {
      throw new Error('failed host');
    },
  };
  const nodes = { all: () => [node, unavailable, failed] } as unknown as NodeRegistry;
  let quota = false;
  let bytes = Buffer.alloc(0);
  const objects = {
    require() {},
    available: () => true,
    checkQuota() {
      if (quota) throw new RemoteKitError('limit_exceeded', 'quota');
    },
    async put(_tenant: string, chunks: AsyncIterable<Uint8Array>, options: { maxBytes: number }) {
      assert.equal(_tenant, tenant);
      const buffers: Buffer[] = [];
      for await (const chunk of chunks) buffers.push(Buffer.from(chunk));
      bytes = Buffer.concat(buffers);
      assert(bytes.length <= options.maxBytes);
      return { id: 'a'.repeat(64), size: bytes.length };
    },
  };
  const library = new FileLibrary(store.library, {} as never, FILE_LIMITS, objects, () => null);
  const packages = new DiagnosticPackages(
    { objects, library } as unknown as DomainServices,
    nodes,
    directory,
    undefined,
    () => 30,
  );
  t.after(async () => {
    await packages.close();
    await library.close();
    store.db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const operationId = randomUUID();
  assert.equal(packages.package(tenant, day, operationId, () => {}).state, 'running');
  assert.equal(packages.package(tenant, day, operationId, () => {}).state, 'running');
  assert.throws(() => packages.package(tenant, day, randomUUID(), () => {}), { code: 'busy' });
  await packages.close();
  const job = packages.jobs(tenant)[0];
  assert.equal(job.state, 'done');
  const members = unpack(bytes);
  assert.equal(members.get(`control/${day}/control.jsonl`)?.toString(), 'control bytes');
  assert.equal(members.get(`node/${day}/endpoint.jsonl`)?.toString(), 'node bytes');
  const manifest = JSON.parse(members.get('manifest.json')!.toString());
  assert.deepEqual(
    decodeJson(members.get('manifest.json')!.toString(), logPackageManifest, 'logs.manifest'),
    manifest,
  );
  assert.throws(
    () => decodeJson(JSON.stringify({ ...manifest, unexpected: true }), logPackageManifest, 'logs.manifest'),
    { reason: 'corrupt_record' },
  );
  assert.equal(manifest.kind, 'logs');
  assert.equal(manifest.date, day);
  assert(manifest.hosts.find((host: any) => host.host === 'offline').failed);
  assert(manifest.hosts.find((host: any) => host.host === 'failed').failed);
  const entry = store.library.snapshot(tenant).entries[0];
  assert.deepEqual(entry.source, { app: 'diagnostics', channel: 'logs' });
  assert.equal(entry.name, `RemoteKit 日志 ${day}.tar.zst`);
  assert.equal(sourceAppName('diagnostics'), '诊断信息');
  assert.equal(sourceChannelName({ app: 'diagnostics', channel: 'logs' }), '日志');
  assert.equal((await packages.dates())[0].date, day);
  quota = true;
  packages.package(tenant, day, randomUUID(), () => {});
  await packages.close();
  const failure = packages.jobs(tenant)[1];
  assert.equal(failure.state, 'failed');
  if (failure.state === 'failed') {
    assert.equal(failure.code, 'limit_exceeded');
    assert.match(failure.errorId, /^c-/);
  }
  assert.equal(store.library.snapshot(tenant).entries.length, 1);
});

test('retention runs at startup and the next local midnight', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-midnight-'));
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  const now = new Date(2026, 10, 14, 23, 59).getTime();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const sent: number[] = [];
  const nodes = { setLogRetentionDays: (days: number) => sent.push(days) } as unknown as NodeRegistry;
  const retention = new LogRetention(store, nodes, directory);
  t.after(async () => {
    await retention.close();
    store.db.close();
    await rm(directory, { recursive: true, force: true });
  });
  retention.start();
  assert.deepEqual(sent, [30]);
  t.mock.timers.tick(60000);
  assert.deepEqual(sent, [30, 30]);
});

test('admin.diagnostics.save is idempotent, admin-only, and uses collection source', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-save-'));
  const id = randomUUID();
  const path = join(directory, id + '.tar.zst');
  await writeFile(path, 'archive');
  const imports: any[] = [];
  const services = {
    store: { accounts: { userForTenant: () => ({ isAdmin: true }) } },
    viewers: { assertViewer() {}, assertProductViewer() {} },
    objects: {
      put: async (_tenant: string, chunks: AsyncIterable<Uint8Array>) => {
        for await (const _chunk of chunks) {
        }
        return { id: 'b'.repeat(64), size: 7 };
      },
    },
    library: {
      importFromControl: async (_tenant: string, input: any) => {
        imports.push(input);
        return { entryId: input.entryId };
      },
    },
  } as unknown as DomainServices;
  const packages = new DiagnosticPackages(
    services,
    { all: () => [] },
    directory,
    { archiveFile: async () => ({ path, id }) } as unknown as DiagnosticSessions,
    () => 30,
  );
  t.after(async () => {
    await packages.close();
    await rm(directory, { recursive: true, force: true });
  });
  const params = { id, operationId: randomUUID() };
  const authority = { tenantId: 'tenant', leaseId: 'lease', epoch: 1 };
  const diagnostic = { packages, identity: 'identity', allowed: () => true };
  const call = () => dispatchViewerRequest(services, authority, 'admin.diagnostics.save', params, diagnostic);
  assert.deepEqual(await call(), await call());
  assert.equal(imports.length, 1);
  assert.deepEqual(imports[0].source, { app: 'diagnostics', channel: 'collection' });
  assert.equal(imports[0].name, `RemoteKit 诊断 ${id}.tar.zst`);
  await truncate(path, 256 * 1024 * 1024 + 1);
  await assert.rejects(
    packages.save('tenant', id, randomUUID(), () => {}),
    { code: 'limit_exceeded' },
  );
  services.store.accounts.userForTenant = () => ({ isAdmin: false }) as never;
  await assert.rejects(call(), { code: 'forbidden' });
});

test('day listing includes earlier date files and crash files modified on the requested day', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-pinned-log-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const day = localDate();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const older = localDate(yesterday);
  await Promise.all([
    mkdir(join(directory, day)),
    mkdir(join(directory, older)),
    mkdir(join(directory, 'crashes/control'), { recursive: true }),
  ]);
  await writeFile(join(directory, day, 'manager.jsonl'), 'manager');
  await writeFile(join(directory, older, 'browser-session.jsonl'), 'pinned browser child');
  await writeFile(join(directory, older, 'endpoint.jsonl'), 'old endpoint');
  await utimes(join(directory, older, 'endpoint.jsonl'), yesterday, yesterday);
  await writeFile(join(directory, 'crashes/control/report.json'), 'report');
  const files = await hostFiles(directory, day);
  assert.deepEqual(
    files.map((file) => file.path).sort(),
    [`${older}/browser-session.jsonl`, `${day}/manager.jsonl`, 'crashes/control/report.json'].sort(),
  );
});
