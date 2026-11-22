import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import type Database from 'better-sqlite3';
import { RemoteKitError, parseWireError } from '../../shared/errors';
import { perf, SLOW_ASYNC_MS, SLOW_SYNC_MS } from '../util/perf';
import { readTasks, type ReadTaskInput, type ReadTaskName, type ReadTaskOutput } from './read-tasks';

declare const __REMOTEKIT_READ_WORKER__: string | undefined;

/**
 * Runs whole-database read analyses off the main event loop. Each worker owns a read-only
 * connection; WAL gives it a consistent snapshot without blocking the main connection, which
 * remains the only writer. Results are plans: the caller rechecks each item before acting.
 */
export interface ReadPool {
  run<K extends ReadTaskName>(task: K, input: ReadTaskInput<K>): Promise<ReadTaskOutput<K>>;
  close(): Promise<void>;
}

export function createReadPool(path: string, db: Database.Database): ReadPool {
  // An in-memory database is private to its connection; only that connection can read it.
  if (!path || path === ':memory:') return new InlineReadPool(db);
  return new WorkerReadPool(path, Math.min(2, Math.max(1, availableParallelism() - 1)));
}

class InlineReadPool implements ReadPool {
  constructor(private readonly db: Database.Database) {}
  async run<K extends ReadTaskName>(task: K, input: ReadTaskInput<K>): Promise<ReadTaskOutput<K>> {
    await Promise.resolve();
    return perf.sync(`read.${task}`, () =>
      (readTasks[task] as (db: Database.Database, input: unknown) => ReadTaskOutput<K>)(this.db, input),
    );
  }
  async close() {}
}

interface Pending {
  task: string;
  resolve: (value: any) => void;
  reject: (error: RemoteKitError) => void;
}
interface Slot {
  worker: Worker;
  pending: Map<number, Pending>;
}
interface Reply {
  id: number;
  ms: number;
  value?: unknown;
  error?: unknown;
}

class WorkerReadPool implements ReadPool {
  private readonly slots: Slot[] = [];
  private nextId = 0;
  private closed = false;
  constructor(
    private readonly path: string,
    private readonly size: number,
  ) {}

  run<K extends ReadTaskName>(task: K, input: ReadTaskInput<K>): Promise<ReadTaskOutput<K>> {
    if (this.closed)
      return Promise.reject(
        new RemoteKitError('unavailable', '后台读取服务已关闭', { detail: 'Read pool closed' }),
      );
    const slot = this.slot();
    const id = ++this.nextId;
    const started = performance.now();
    return new Promise<ReadTaskOutput<K>>((resolve, reject) => {
      slot.pending.set(id, { task, resolve, reject });
      slot.worker.postMessage({ id, task, input });
    }).finally(() => perf.record(`read.${task}`, performance.now() - started, SLOW_ASYNC_MS));
  }

  private slot() {
    if (this.slots.length < this.size) return this.spawn();
    return this.slots.reduce((least, slot) => (slot.pending.size < least.pending.size ? slot : least));
  }

  private spawn(): Slot {
    const entry =
      typeof __REMOTEKIT_READ_WORKER__ === 'string'
        ? new URL(__REMOTEKIT_READ_WORKER__, import.meta.url)
        : new URL('./read-worker.ts', import.meta.url);
    const worker = new Worker(entry, { workerData: { path: this.path } });
    const slot: Slot = { worker, pending: new Map() };
    this.slots.push(slot);
    worker.unref();
    worker.on('message', (reply: Reply) => {
      const pending = slot.pending.get(reply.id);
      if (!pending) return;
      slot.pending.delete(reply.id);
      perf.record(`read.${pending.task}.run`, reply.ms, SLOW_SYNC_MS);
      if (reply.error === undefined) pending.resolve(reply.value);
      else
        pending.reject(
          parseWireError(reply.error) ??
            new RemoteKitError('internal', '后台读取失败', { detail: 'Invalid read worker error' }),
        );
    });
    worker.on('error', (cause) => this.retire(slot, cause));
    worker.on('exit', (code) => this.retire(slot, new Error(`Read worker exited with ${code}`)));
    return slot;
  }

  // A worker that failed loses its in-flight tasks; the next task starts a fresh worker.
  private retire(slot: Slot, cause: unknown) {
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
    for (const pending of slot.pending.values())
      pending.reject(
        new RemoteKitError('unavailable', '后台读取服务暂时不可用', {
          detail: `Read worker failed: ${(cause as Error)?.message ?? String(cause)}`,
          cause,
        }),
      );
    slot.pending.clear();
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.slots].map((slot) => slot.worker.terminate()));
  }
}
