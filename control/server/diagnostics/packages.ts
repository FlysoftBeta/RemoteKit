import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DomainServices } from '../application';
import type { NodeRegistry } from '../cluster/node-link';
import { RemoteKitError, toRemoteKitError } from '../../shared/errors';
import type { LogPackageJob, LogDay } from '../../shared/admin';
import { newErrorId, reportError } from '../log';
import { encodeJson, type Decoded } from '../persistence/codec';
import { archiveStream, type ArchiveMember } from './archive';
import { logPackageManifest } from './formats';
import { datePattern, hostDays, hostFiles, readHostFile, type LogFile } from './host-logs';
import { logReadBytes, nodeLogDays, nodeLogList, nodeLogRead } from './node-logs';
import type { DiagnosticSessions } from './sessions';

const maxFileBytes = 256 * 1024 * 1024;
type Host = Decoded<typeof logPackageManifest>['hosts'][number];
type Services = Pick<DomainServices, 'objects' | 'library'>;
export class DiagnosticPackages {
  private readonly operations = new Map<
    string,
    { input: string; job: LogPackageJob; work: Promise<unknown> }
  >();
  private readonly saves = new Map<string, { input: string; work: Promise<{ entryId: string }> }>();
  constructor(
    private readonly services: Services,
    private readonly nodes: Pick<NodeRegistry, 'all'>,
    private readonly directory: string,
    private readonly sessions: DiagnosticSessions | undefined,
    private readonly days: () => number,
  ) {}
  async dates(): Promise<LogDay[]> {
    const hosts = await Promise.all([
      hostDays(this.directory, this.days()).then((days) => ({ host: 'control', days })),
      ...this.nodes
        .all()
        .filter((node) => node.state.state === 'ready')
        .map(async (node) => {
          try {
            return { host: node.nodeId, days: await nodeLogDays(node, 5000) };
          } catch (cause) {
            return {
              host: node.nodeId,
              days: [] as string[],
              failed: reportError(toRemoteKitError(cause), 'logs.days_failed', { nodeId: node.nodeId })
                .errorId,
            };
          }
        }),
    ]);
    return [...new Set(hosts.flatMap((host) => host.days))]
      .sort()
      .reverse()
      .map((date) => ({
        date,
        hosts: hosts.map((host) => ({
          host: host.host,
          present: host.days.includes(date),
          ...('failed' in host && host.failed ? { errorId: host.failed } : {}),
        })),
      }));
  }
  jobs(tenant: string) {
    return [...this.operations]
      .filter(([key]) => key.startsWith(tenant + ':'))
      .map(([, value]) => ({ ...value.job }));
  }
  private key(tenant: string, operationId: unknown) {
    if (typeof operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(operationId))
      throw new RemoteKitError('invalid_request', '无效的操作 ID');
    return `${tenant}:${operationId}`;
  }
  package(tenant: string, date: unknown, operationId: unknown, authorize: () => void) {
    if (typeof date !== 'string' || !datePattern.test(date))
      throw new RemoteKitError('invalid_request', '无效的日志日期');
    const key = this.key(tenant, operationId);
    const existing = this.operations.get(key);
    if (existing) {
      if (existing.input !== date) throw new RemoteKitError('conflict', '操作 ID 已用于其他日期');
      return { ...existing.job };
    }
    if ([...this.operations.values()].some(({ job }) => job.date === date && job.state === 'running'))
      throw new RemoteKitError('busy', '该日期正在打包');
    const job: LogPackageJob = { operationId: operationId as string, date, state: 'running', bytes: 0 };
    const entry: { input: string; job: LogPackageJob; work: Promise<unknown> } = {
      input: date,
      job,
      work: Promise.resolve(),
    };
    this.operations.set(key, entry);
    entry.work = this.build(tenant, date, job, operationId as string, authorize)
      .then(({ entryId }) => {
        entry.job = {
          operationId: job.operationId,
          date,
          state: 'done',
          entryId,
          fileName: `RemoteKit 日志 ${date}.tar.zst`,
        };
      })
      .catch((cause) => {
        const error = toRemoteKitError(cause);
        error.errorId ??= newErrorId();
        reportError(error, 'logs.package_failed', { date });
        entry.job = {
          operationId: job.operationId,
          date,
          state: 'failed',
          errorId: error.errorId,
          code: error.code,
        };
      });
    return { ...job };
  }
  private async saveObject(
    tenant: string,
    chunks: AsyncIterable<Uint8Array>,
    name: string,
    channel: 'logs' | 'collection',
    operationId: string,
    authorize: () => void,
  ) {
    authorize();
    const object = await this.services.objects.put(tenant, chunks, { maxBytes: maxFileBytes });
    authorize();
    const entryId = createHash('sha256').update(`${tenant}\0${operationId}`).digest('hex').slice(0, 32);
    return this.services.library.importFromControl(
      tenant,
      {
        operationId,
        entryId,
        assetId: object.id,
        name,
        type: 'application/zstd',
        size: object.size,
        source: { app: 'diagnostics', channel },
        detail: '',
      },
      authorize,
    );
  }
  private async build(
    tenant: string,
    date: string,
    job: LogPackageJob,
    operationId: string,
    authorize: () => void,
  ) {
    const directory = await mkdtemp(join(tmpdir(), 'rk-log-package-'));
    const hosts: Host[] = [];
    const nodes = this.nodes.all();
    const self = this;
    async function* members(): AsyncGenerator<ArchiveMember> {
      for (const target of [
        { host: 'control', node: undefined },
        ...nodes.map((node) => ({ host: node.nodeId, node })),
      ]) {
        const host: Host = { host: target.host, files: [] };
        hosts.push(host);
        try {
          if (target.node && target.node.state.state !== 'ready')
            throw new RemoteKitError('unavailable', '节点离线');
          const files = target.node
            ? await nodeLogList(target.node, date, 15000)
            : await hostFiles(self.directory, date, self.days());
          for (const file of files) {
            const spool = join(directory, randomUUID());
            const output = await open(spool, 'wx');
            try {
              for (let offset = 0; offset < file.size;) {
                const length = Math.min(logReadBytes, file.size - offset);
                const part = target.node
                  ? await nodeLogRead(target.node, file.path, offset, length, 15000)
                  : await readHostFile(self.directory, file.path, offset, length);
                if (part.data.length !== length) throw new Error('incomplete log file');
                await output.writeFile(part.data);
                offset += part.data.length;
                if (job.state === 'running') job.bytes += part.data.length;
              }
            } finally {
              await output.close();
            }
            host.files.push(file);
            yield { name: `${host.host}/${file.path}`, size: file.size, chunks: createReadStream(spool) };
            await rm(spool);
          }
        } catch (cause) {
          const error = reportError(toRemoteKitError(cause), 'logs.host_failed', { host: host.host, date });
          host.failed = `${error.code}${error.errorId ? ': ' + error.errorId : ''}`;
        }
      }
      const manifest = Buffer.from(
        encodeJson({ schemaVersion: 1, kind: 'logs', date, hosts }, logPackageManifest, 'logs.manifest'),
      );
      yield { name: 'manifest.json', size: manifest.length, chunks: [manifest] };
    }
    try {
      return await this.saveObject(
        tenant,
        archiveStream(members()),
        `RemoteKit 日志 ${date}.tar.zst`,
        'logs',
        operationId,
        authorize,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  save(tenant: string, id: unknown, operationId: unknown, authorize: () => void) {
    const key = this.key(tenant, operationId);
    if (typeof id !== 'string') throw new RemoteKitError('invalid_request', '无效的诊断 ID');
    const previous = this.saves.get(key);
    if (previous) {
      if (previous.input !== id) throw new RemoteKitError('conflict', '操作 ID 已用于其他诊断包');
      return previous.work;
    }
    const work = (async () => {
      if (!this.sessions) throw new RemoteKitError('not_found', '诊断采集未配置');
      const archive = await this.sessions.archiveFile(id);
      if ((await stat(archive.path)).size > maxFileBytes)
        throw new RemoteKitError('limit_exceeded', '文件超过大小上限');
      return this.saveObject(
        tenant,
        createReadStream(archive.path),
        `RemoteKit 诊断 ${id}.tar.zst`,
        'collection',
        operationId as string,
        authorize,
      );
    })();
    this.saves.set(key, { input: id, work });
    return work;
  }
  async close() {
    await Promise.allSettled(
      [...this.operations.values()]
        .map((operation) => operation.work)
        .concat([...this.saves.values()].map((save) => save.work)),
    );
  }
}
