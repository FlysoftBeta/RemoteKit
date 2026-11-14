import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { isRemoteKitError, type RemoteKitError } from '../shared/errors';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown> & { err?: unknown };

export interface LogSink {
  write(line: string): void;
}

const levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const causeDepth = 5;

// Until main() installs the file sink (and in unit tests) records go to stderr.
const stderrSink: LogSink = { write: (line) => process.stderr.write(line) };
let sink: LogSink = stderrSink;
let threshold: LogLevel = 'info';

export function configureLog(next: LogSink, level: LogLevel = 'info') {
  sink = next;
  threshold = level;
}

function serializeError(error: unknown, depth = 0): Record<string, unknown> {
  if (isRemoteKitError(error))
    return {
      code: error.code,
      message: error.message,
      ...(error.reason === undefined ? {} : { reason: error.reason }),
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      ...(error.errorId === undefined ? {} : { errorId: error.errorId }),
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      ...causeOf(error.cause, depth),
    };
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const code = (error as Error & { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      ...(code === undefined ? {} : { code }),
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      ...causeOf(cause, depth),
    };
  }
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    return {
      ...Object.fromEntries(
        ['name', 'code', 'message', 'reason', 'detail', 'errorId', 'stack']
          .filter((key) => value[key] !== undefined)
          .map((key) => [key, value[key]]),
      ),
      ...causeOf(value.cause, depth),
    };
  }
  return { value: String(error) };
}

function causeOf(cause: unknown, depth: number) {
  return cause === undefined || depth >= causeDepth ? {} : { cause: serializeError(cause, depth + 1) };
}

function emit(level: LogLevel, event: string, fields?: LogFields) {
  if (levels[level] < levels[threshold]) return;
  const record: Record<string, unknown> = { ts: new Date().toISOString(), lvl: level, ev: event };
  for (const [key, value] of Object.entries(fields ?? {}))
    record[key] = key === 'err' ? serializeError(value) : value;
  let line: string;
  try {
    line = JSON.stringify(record, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
  } catch (error) {
    line = JSON.stringify({
      ts: record.ts,
      lvl: level,
      ev: event,
      unserializable: String(error),
    });
  }
  sink.write(line + '\n');
}

export const log = {
  debug: (event: string, fields?: LogFields) => emit('debug', event, fields),
  info: (event: string, fields?: LogFields) => emit('info', event, fields),
  warn: (event: string, fields?: LogFields) => emit('warn', event, fields),
  error: (event: string, fields?: LogFields) => emit('error', event, fields),
};

export function newErrorId(): string {
  return 'c-' + randomBytes(5).toString('hex');
}

const reported = new WeakSet<RemoteKitError>();

// Errors that the caller cannot resolve by itself get an errorId the user can
// quote; the record carrying the full cause chain is written once, here.
export function reportError(error: RemoteKitError, event: string, fields?: LogFields) {
  if (['canceled', 'busy', 'rate_limited'].includes(error.code) && error.errorId === undefined) return error;
  identifyError(error);
  if (reported.has(error)) return error;
  reported.add(error);
  const level = error.code === 'internal' ? 'error' : 'warn';
  emit(level, event, { ...fields, errorId: error.errorId, err: error });
  return error;
}

export function identifyError(error: RemoteKitError) {
  if (['internal', 'unavailable', 'outcome_unknown'].includes(error.code) && !error.errorId)
    error.errorId = newErrorId();
  return error;
}

export const logFileName = 'control.jsonl';
const rotateBytes = 16 * 1024 * 1024;
const backups = 4;

export function logFiles(directory: string): string[] {
  const current = join(directory, logFileName);
  return [current, ...Array.from({ length: backups }, (_, index) => `${current}.${index + 1}`)];
}

export class FileLogSink implements LogSink {
  private fd: number;
  private size: number;
  private failed = false;
  private readonly path: string;

  constructor(
    private readonly directory: string,
    private readonly maxBytes = rotateBytes,
  ) {
    mkdirSync(directory, { recursive: true });
    this.path = join(directory, logFileName);
    this.fd = openSync(this.path, 'a');
    this.size = statSync(this.path).size;
  }

  write(line: string) {
    const bytes = Buffer.from(line, 'utf8');
    try {
      if (this.size > 0 && this.size + bytes.length > this.maxBytes) this.rotate();
      writeSync(this.fd, bytes);
      this.size += bytes.length;
      this.failed = false;
    } catch (error) {
      // The log cannot record its own failure; report once per failure streak.
      if (!this.failed) process.stderr.write(`control log write failed: ${String(error)}\n` + line);
      this.failed = true;
    }
  }

  close() {
    closeSync(this.fd);
  }

  private rotate() {
    closeSync(this.fd);
    try {
      const files = logFiles(this.directory);
      rmSync(files[backups], { force: true });
      for (let index = backups - 1; index >= 0; index--)
        try {
          renameSync(files[index], files[index + 1]);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    } finally {
      this.fd = openSync(this.path, 'a');
      this.size = statSync(this.path).size;
    }
  }
}
