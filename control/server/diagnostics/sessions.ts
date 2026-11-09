import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { AdminDiagnostic } from '../../shared/admin';
import { RemoteKitError, toRemoteKitError } from '../../shared/errors';
import { writeDiagnosticArchive, type ArchiveEntry } from './archive';
import type { EndpointLogName, LogWindow, LogWindowRequest } from '../endpoint/types';
import { diagnosticClientSample, diagnosticEndpointSnapshot, diagnosticEnvironment } from './projection';

const intervalMs = 2000;
const maxDurationMs = 10 * 60 * 1000;
const maxBytes = 32 * 1024 * 1024;
export const diagnosticMessageLimit = 128 * 1024;
const maxActive = 4;
// Raw logs are read once at stop, newest bytes first, so history from before
// the collection started is included up to each budget.
const logBudgets = {
  browser: 16 * 1024 * 1024,
  endpoint: 8 * 1024 * 1024,
  crashes: 256 * 1024,
  dump: 16 * 1024 * 1024,
  dumpCount: 3,
} as const;
const logWindowBytes = 512 * 1024;
const logDeadlineMs = 15000;
const shutdownLogDeadlineMs = 3000;
const maxRecent = 1024;
const archiveId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const stopReasons = [
  'user',
  'duration-limit',
  'size-limit',
  'disconnected',
  'authorization-changed',
  'shutdown',
] as const;
type StopReason = (typeof stopReasons)[number];
type Status =
  | { id: string; status: 'collecting' | 'finalizing' }
  | { id: string; status: 'complete'; reason: StopReason; bytes: number }
  | { id: string; status: 'failed'; reason: 'archive-write-failed' };
type Source = 'client' | 'control' | 'endpoint' | 'events';
interface CollectedLogs {
  files: Map<ArchiveEntry, Buffer[]>;
  summary: Record<string, unknown>;
}
export interface DiagnosticViewer {
  tenant: string;
  identity: string;
  lease: string;
  epoch: number;
  allowed: () => boolean;
}
interface Session {
  viewer: DiagnosticViewer;
  status: Status;
  startedAt: number;
  startedMonotonicMs: number;
  environment: Record<string, unknown>;
  entries: Record<Source, Buffer[]>;
  bytes: number;
  sequence: number;
  interval?: NodeJS.Timeout;
  expiry?: NodeJS.Timeout;
  eventLoop: ReturnType<typeof monitorEventLoopDelay>;
  finalization?: Promise<Status>;
  unavailable: { control: number; endpoint: number; browserOutput: number; endpointPending: number };
  truncated: Set<string>;
}

export class DiagnosticSessions {
  private readonly active = new Map<string, Session>();
  private readonly sessions = new Map<string, Session>();
  private readonly recent = new Map<string, { tenant: string; status: Status }>();
  private readonly snapshotPending = new Set<string>();
  private readonly downloads = new Map<string, { path: string; id: string; expires: number }>();
  private closing = false;

  constructor(
    private readonly directory: string,
    private readonly sources: {
      control: (tenant: string) => unknown;
      endpoint: (tenant: string) => Promise<unknown>;
      endpointLog: (tenant: string, request: LogWindowRequest) => Promise<LogWindow>;
      controlLog?: () => { data: Buffer; dropped: number };
    },
  ) {}

  start(viewer: DiagnosticViewer, environment: unknown) {
    if (this.closing) throw new RemoteKitError('unavailable', '服务正在关闭');
    const previous = this.active.get(viewer.tenant);
    if (previous) {
      if (!previous.viewer.allowed()) void this.finish(previous, 'authorization-changed');
      else if (
        previous.viewer.lease === viewer.lease &&
        previous.viewer.epoch === viewer.epoch &&
        previous.viewer.identity === viewer.identity
      ) {
        return {
          id: previous.status.id,
          status: 'collecting' as const,
          startedAt: previous.startedAt,
          maxDurationMs,
        };
      } else throw new RemoteKitError('conflict', '当前会话已有诊断正在采集');
    }
    if (this.sessions.size >= maxActive) throw new RemoteKitError('busy', '诊断采集繁忙，请稍后重试');
    const status = { id: randomUUID(), status: 'collecting' } as const;
    const session: Session = {
      viewer,
      status,
      startedAt: Date.now(),
      startedMonotonicMs: performance.now(),
      environment: diagnosticEnvironment(environment),
      entries: { client: [], control: [], endpoint: [], events: [] },
      bytes: 0,
      sequence: 0,
      eventLoop: monitorEventLoopDelay({ resolution: 20 }),
      unavailable: { control: 0, endpoint: 0, browserOutput: 0, endpointPending: 0 },
      truncated: new Set(),
    };
    this.sessions.set(status.id, session);
    this.active.set(viewer.tenant, session);
    session.eventLoop.enable();
    this.append(session, 'events', { event: 'started' });
    session.interval = setInterval(() => this.capture(session), intervalMs).unref();
    session.expiry = setTimeout(() => {
      void this.finish(session, 'duration-limit');
    }, maxDurationMs).unref();
    this.capture(session);
    return { ...status, startedAt: session.startedAt, maxDurationMs };
  }

  async request(viewer: DiagnosticViewer, method: string, params: unknown) {
    if (!viewer.allowed()) throw new RemoteKitError('locked', 'Viewer 已锁定');
    if (params === null || typeof params !== 'object' || Array.isArray(params))
      throw new RemoteKitError('invalid_request', '需要诊断参数');
    const body = params as Record<string, unknown>;
    if (method === 'diagnostics.start') return this.start(viewer, body.environment);
    if (!['diagnostics.sample', 'diagnostics.stop', 'diagnostics.status'].includes(method))
      throw new RemoteKitError('not_found', '接口不存在');
    const id = body.id;
    if (typeof id !== 'string' || !archiveId.test(id))
      throw new RemoteKitError('not_found', '诊断记录不存在');
    const session = this.sessions.get(id);
    if (session && session.viewer.tenant !== viewer.tenant)
      throw new RemoteKitError('not_found', '诊断记录不存在');
    if (!session) return this.terminal(viewer.tenant, id);
    if (session.status.status === 'collecting' && !session.viewer.allowed())
      void this.finish(session, 'authorization-changed');
    if (method === 'diagnostics.status') return session.status;
    if (session.status.status !== 'collecting')
      return method === 'diagnostics.stop' ? (session.finalization ?? session.status) : session.status;
    if (
      session.viewer.lease !== viewer.lease ||
      session.viewer.epoch !== viewer.epoch ||
      session.viewer.identity !== viewer.identity
    )
      throw new RemoteKitError('conflict', '诊断采集属于另一个 Viewer');
    if (method === 'diagnostics.stop') return this.finish(session, 'user');
    const sequence = body.sequence;
    if (
      typeof sequence !== 'number' ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      body.data === null ||
      typeof body.data !== 'object' ||
      Array.isArray(body.data)
    )
      throw new RemoteKitError('invalid_request', '无效的诊断样本');
    if (sequence <= session.sequence) return session.status;
    // Bound floods of tiny samples as well as retained bytes.
    if (session.entries.client.length >= 6000) {
      session.truncated.add('client-sample-count');
      return this.finish(session, 'size-limit');
    }
    session.sequence = sequence;
    const sample = diagnosticClientSample(body.data, session.truncated);
    this.append(session, 'client', { sequence, data: sample });
    return session.status;
  }

  checkViewer(tenant: string, lease: string) {
    const session = this.active.get(tenant);
    if (session?.viewer.lease === lease && !session.viewer.allowed())
      void this.finish(session, 'authorization-changed');
  }

  detachViewer(tenant: string, lease: string, reason: 'disconnected' | 'authorization-changed') {
    const session = this.active.get(tenant);
    if (session?.viewer.lease === lease) void this.finish(session, reason);
  }

  async shutdown() {
    this.closing = true;
    await Promise.all([...this.sessions.values()].map((session) => this.finish(session, 'shutdown')));
  }

  private append(session: Session, source: Source, record: object) {
    if (session.status.status !== 'collecting') return;
    const line = Buffer.from(
      JSON.stringify({
        receivedAt: Date.now(),
        elapsedMs: performance.now() - session.startedMonotonicMs,
        ...record,
      }) + '\n',
    );
    // Keep space for manifest, final event, and tar headers/padding.
    if (session.bytes + line.length > maxBytes - 16 * 1024) {
      session.truncated.add('archive-byte-budget');
      void this.finish(session, 'size-limit');
      return;
    }
    session.bytes += line.length;
    session.entries[source].push(line);
  }

  private capture(session: Session) {
    if (!session.viewer.allowed()) {
      void this.finish(session, 'authorization-changed');
      return;
    }
    const tenant = session.viewer.tenant;
    try {
      const loop = session.eventLoop;
      const eventLoopDelayMs = loop.count
        ? { mean: loop.mean / 1e6, p95: loop.percentile(95) / 1e6, max: loop.max / 1e6, samples: loop.count }
        : undefined;
      loop.reset();
      this.append(session, 'control', {
        runtime: {
          cpuUsageUs: process.cpuUsage(),
          memoryBytes: process.memoryUsage(),
          uptimeSeconds: process.uptime(),
          eventLoopDelayMs,
        },
        workspace: this.sources.control(tenant),
      });
    } catch {
      session.unavailable.control++;
    }
    if (session.status.status !== 'collecting') return;
    if (this.snapshotPending.has(tenant) || this.snapshotPending.size >= maxActive) {
      session.unavailable.endpointPending++;
      return;
    }
    this.snapshotPending.add(tenant);
    const requestedElapsedMs = performance.now() - session.startedMonotonicMs;
    // The transport has its own timeout. Mark this sample unavailable after a
    // shorter collection deadline, but never queue another RPC while it is in flight.
    let timely = true;
    const deadline = setTimeout(() => {
      timely = false;
      if (session.status.status === 'collecting') session.unavailable.endpoint++;
    }, intervalMs - 200).unref();
    void Promise.resolve()
      .then(() =>
        session.status.status === 'collecting' && session.viewer.allowed()
          ? this.sources.endpoint(tenant)
          : undefined,
      )
      .then((snapshot) => {
        if (!timely || session.status.status !== 'collecting' || !session.viewer.allowed()) return;
        if (snapshot === null || typeof snapshot !== 'object') {
          session.unavailable.endpoint++;
          return;
        }
        const data = diagnosticEndpointSnapshot(snapshot, session.truncated);
        if (data.browserOutputAvailable !== true) session.unavailable.browserOutput++;
        this.append(session, 'endpoint', { requestedElapsedMs, data });
      })
      .catch(() => {
        if (timely && session.status.status === 'collecting') session.unavailable.endpoint++;
      })
      .finally(() => {
        clearTimeout(deadline);
        this.snapshotPending.delete(tenant);
      });
  }

  private finish(session: Session, reason: StopReason): Promise<Status> {
    if (session.finalization) return session.finalization;
    const { id } = session.status;
    const endedAt = Date.now();
    const elapsedMs = performance.now() - session.startedMonotonicMs;
    clearInterval(session.interval);
    clearTimeout(session.expiry);
    session.eventLoop.disable();
    this.active.delete(session.viewer.tenant);
    session.status = { id, status: 'finalizing' };
    session.entries.events.push(
      Buffer.from(JSON.stringify({ receivedAt: endedAt, elapsedMs, event: 'stopped', reason }) + '\n'),
    );
    session.finalization = this.collectLogs(session.viewer.tenant, reason)
      .then((logs) => this.write(session, reason, endedAt, elapsedMs, logs))
      .then((status) => {
        session.status = status;
        this.sessions.delete(id);
        if (this.recent.size >= maxRecent) this.recent.delete(this.recent.keys().next().value!);
        this.recent.set(id, { tenant: session.viewer.tenant, status });
        return status;
      });
    return session.finalization;
  }

  private async write(
    session: Session,
    reason: StopReason,
    endedAt: number,
    elapsedMs: number,
    logs: CollectedLogs,
  ): Promise<Status> {
    const { id } = session.status;
    const manifest = {
      schemaVersion: 1,
      id,
      startedAt: session.startedAt,
      endedAt,
      elapsedMs,
      reason,
      interrupted: reason !== 'user',
      runtime: { node: process.versions.node, platform: process.platform, architecture: process.arch },
      environment: session.environment,
      limits: {
        maxDurationMs,
        maxBytes,
        sampleIntervalMs: intervalMs,
        messageBytes: diagnosticMessageLimit,
        logBytes: logBudgets,
      },
      logs: logs.summary,
      sources: Object.fromEntries(
        Object.entries(session.entries).map(([source, rows]) => [
          source,
          { records: rows.length, available: rows.length > 0 },
        ]),
      ),
      unavailable: session.unavailable,
      truncated: [...session.truncated],
      clocks: {
        receivedAt: 'Control Unix epoch milliseconds',
        elapsedMs: 'Control monotonic milliseconds since start',
        requestedElapsedMs: 'Control monotonic milliseconds since start at Endpoint request',
        clientTimeMs: 'Viewer performance.now milliseconds',
        endpoint: 'Endpoint native counters/timing domains; compare deltas within the same source',
        cpuUsageUs: 'Control process cumulative user/system microseconds',
      },
    };
    const entries = new Map<ArchiveEntry, Buffer[]>([
      ['manifest.json', [Buffer.from(JSON.stringify(manifest, null, 2) + '\n')]],
    ]);
    for (const source of ['client', 'control', 'endpoint', 'events'] as const)
      if (session.entries[source].length) entries.set(`${source}.jsonl`, session.entries[source]);
    for (const [name, chunks] of logs.files) entries.set(name, chunks);
    return writeDiagnosticArchive(
      this.ownerDirectory(session.viewer.tenant),
      id,
      entries,
      endedAt,
      reason,
    ).then<Status, Status>(
      (bytes) => ({ id, status: 'complete', bytes, reason }),
      () => ({ id, status: 'failed', reason: 'archive-write-failed' }),
    );
  }

  private async collectLogs(tenant: string, reason: StopReason): Promise<CollectedLogs> {
    const files = new Map<ArchiveEntry, Buffer[]>();
    const summary: Record<string, unknown> = {};
    const control = this.sources.controlLog?.();
    if (control) {
      files.set('logs/control.log', [control.data]);
      summary.control = { bytes: control.data.length, droppedBefore: control.dropped };
    } else summary.control = { available: false };
    const deadline = Date.now() + (reason === 'shutdown' ? shutdownLogDeadlineMs : logDeadlineMs);
    const read = async (log: EndpointLogName, budget: number, entry: ArchiveEntry) => {
      try {
        const tail = await this.readTail(tenant, log, budget, deadline);
        if (tail.chunks.length) files.set(entry, tail.chunks);
        summary[log] = { exists: tail.exists, size: tail.size, start: tail.start, bytes: tail.bytes };
        return tail;
      } catch (error) {
        summary[log] = { error: error instanceof Error ? error.message : 'unavailable' };
        return undefined;
      }
    };
    await read('browser', logBudgets.browser, 'logs/browser.log');
    const endpoint = await read('endpoint', logBudgets.endpoint, 'logs/endpoint.log');
    if (endpoint && endpoint.start === 0 && endpoint.bytes < logBudgets.endpoint)
      await read('endpoint.1', logBudgets.endpoint - endpoint.bytes, 'logs/endpoint.log.1');
    const crashes = await read('crashes', logBudgets.crashes, 'crashes/events.jsonl');
    for (const dump of crashes?.dumps.slice(0, logBudgets.dumpCount) ?? []) {
      if (!/^[0-9a-f-]{36}\.dmp$/i.test(dump.name) || !Number.isSafeInteger(dump.size)) continue;
      if (dump.size > logBudgets.dump) {
        summary[`dump/${dump.name}`] = { size: dump.size, error: 'dump size limit' };
        continue;
      }
      const entry = `crashes/${dump.name}` as ArchiveEntry;
      const data = await read(`dump/${dump.name}`, logBudgets.dump, entry);
      if (data && (data.start !== 0 || data.bytes !== dump.size)) {
        files.delete(entry);
        summary[`dump/${dump.name}`] = { error: 'incomplete dump' };
      }
    }
    return { files, summary };
  }

  // Walks backwards from the size seen by the first window, so concurrent
  // appends do not shift the bytes already collected.
  private async readTail(tenant: string, log: EndpointLogName, budget: number, deadline: number) {
    const chunks: Buffer[] = [];
    let dumps: { name: string; size: number }[] = [];
    let end: number | undefined,
      size = 0,
      start = 0,
      bytes = 0,
      exists = false;
    while (bytes < budget) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('log read deadline');
      let timer: NodeJS.Timeout | undefined;
      const window = await Promise.race([
        this.sources.endpointLog(tenant, {
          log,
          ...(end === undefined ? {} : { end }),
          maxBytes: Math.min(logWindowBytes, budget - bytes),
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('log read deadline')), remaining);
        }),
      ]).finally(() => clearTimeout(timer));
      if (
        !window ||
        typeof window.exists !== 'boolean' ||
        ![window.size, window.start, window.end].every(Number.isSafeInteger) ||
        typeof window.data !== 'string'
      )
        throw new Error('invalid log window');
      if (end === undefined) dumps = window.dumps ?? [];
      if (!window.exists) break;
      if (!exists) size = window.size;
      exists = true;
      const data = Buffer.from(window.data, 'base64');
      if (data.length !== window.end - window.start) throw new Error('invalid log window');
      chunks.unshift(data);
      bytes += data.length;
      start = window.start;
      if (window.start === 0 || !data.length) break;
      end = window.start;
    }
    return { chunks, exists, size, start, bytes, dumps };
  }

  private ownerDirectory(tenant: string) {
    return join(this.directory, createHash('sha256').update(tenant).digest('hex'));
  }

  private async terminal(tenant: string, id: string): Promise<Status> {
    const cached = this.recent.get(id);
    if (cached?.tenant === tenant) return cached.status;
    if (!cached) {
      const directory = this.ownerDirectory(tenant);
      try {
        const archive = await stat(join(directory, `${id}.tar.zst`));
        const reason = await readFile(join(directory, `${id}.reason`), 'utf8');
        if (!archive.isFile() || !stopReasons.includes(reason as StopReason))
          throw new RemoteKitError('internal', '诊断记录已损坏');
        return { id, status: 'complete', bytes: archive.size, reason: reason as StopReason };
      } catch (error) {
        if (error instanceof RemoteKitError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT')
          throw ['EIO', 'EBUSY', 'EMFILE', 'ENFILE'].includes(code ?? '')
            ? new RemoteKitError('unavailable', '无法读取诊断记录', { detail: String(error) })
            : toRemoteKitError(error);
      }
    }
    throw new RemoteKitError('not_found', '诊断记录不存在');
  }

  private async stored() {
    const owners = await readdir(this.directory, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    const archives: { owner: string; id: string; path: string }[] = [];
    for (const owner of owners) {
      if (!owner.isDirectory() || !/^[0-9a-f]{64}$/.test(owner.name)) continue;
      for (const name of await readdir(join(this.directory, owner.name))) {
        const id = name.endsWith('.tar.zst') ? name.slice(0, -'.tar.zst'.length) : '';
        if (archiveId.test(id))
          archives.push({ owner: owner.name, id, path: join(this.directory, owner.name, name) });
      }
    }
    return archives;
  }

  async archives(tenants: ReadonlyMap<string, string>): Promise<AdminDiagnostic[]> {
    const names = new Map(
      [...tenants].map(([tenant, username]) => [createHash('sha256').update(tenant).digest('hex'), username]),
    );
    const list: AdminDiagnostic[] = [];
    for (const archive of await this.stored()) {
      const info = await stat(archive.path).catch(() => undefined);
      if (!info?.isFile()) continue;
      const reason = await readFile(archive.path.slice(0, -'.tar.zst'.length) + '.reason', 'utf8').catch(
        () => '',
      );
      list.push({
        id: archive.id,
        username: names.get(archive.owner) ?? null,
        createdAt: Math.round(info.mtimeMs),
        bytes: info.size,
        reason,
      });
    }
    return list.sort((a, b) => b.createdAt - a.createdAt);
  }

  private async archive(id: unknown) {
    const archive =
      typeof id === 'string' && archiveId.test(id)
        ? (await this.stored()).find((item) => item.id === id)
        : undefined;
    if (!archive) throw new RemoteKitError('not_found', '诊断记录不存在');
    return archive;
  }

  async deleteArchive(id: unknown) {
    const archive = await this.archive(id);
    await rm(archive.path, { force: true });
    await rm(archive.path.slice(0, -'.tar.zst'.length) + '.reason', { force: true });
    this.recent.delete(archive.id);
  }

  async deleteOwner(tenant: string) {
    const session = this.active.get(tenant);
    if (session) await this.finish(session, 'authorization-changed');
    for (const [id, item] of this.recent) if (item.tenant === tenant) this.recent.delete(id);
    await rm(this.ownerDirectory(tenant), { recursive: true, force: true });
  }

  // Downloads are plain HTTP GETs, so the unlocked Viewer request mints a short-lived single-use ticket.
  async downloadTicket(id: unknown) {
    const archive = await this.archive(id);
    const now = Date.now();
    for (const [ticket, item] of this.downloads) if (item.expires <= now) this.downloads.delete(ticket);
    const ticket = randomBytes(32).toString('hex');
    this.downloads.set(ticket, { path: archive.path, id: archive.id, expires: now + 60000 });
    return ticket;
  }

  takeDownload(ticket: string) {
    const item = this.downloads.get(ticket);
    this.downloads.delete(ticket);
    if (!item || item.expires <= Date.now()) throw new RemoteKitError('not_found', '下载链接已失效');
    return item;
  }
}
