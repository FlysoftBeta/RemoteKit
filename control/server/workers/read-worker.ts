import { performance } from 'node:perf_hooks';
import { parentPort, workerData } from 'node:worker_threads';
import Sqlite from 'better-sqlite3';
import { toRemoteKitError, wireError } from '../../shared/errors';
import { strictSqlite } from '../persistence/sqlite';
import { readTasks, type ReadTaskName } from './read-tasks';

const db = new Sqlite((workerData as { path: string }).path, { readonly: true, fileMustExist: true });
db.defaultSafeIntegers(true);
strictSqlite(db);
db.pragma('busy_timeout = 5000');

parentPort!.on('message', ({ id, task, input }: { id: number; task: ReadTaskName; input: unknown }) => {
  const started = performance.now();
  try {
    const run = readTasks[task] as ((db: Sqlite.Database, input: unknown) => unknown) | undefined;
    if (!run) throw new Error(`Unknown read task ${task}`);
    const value = run(db, input);
    parentPort!.postMessage({ id, ms: performance.now() - started, value });
  } catch (cause) {
    parentPort!.postMessage({
      id,
      ms: performance.now() - started,
      error: wireError(toRemoteKitError(cause)),
    });
  }
});
