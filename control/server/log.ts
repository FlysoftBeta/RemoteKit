import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeSync } from 'node:fs';
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
  record.proc = 'control';
  record.pid = process.pid;
  let line: string;
  try {
    line = JSON.stringify(record, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
  } catch (error) {
    line = JSON.stringify({
      ts: record.ts,
      lvl: level,
      ev: event,
      proc: 'control',
      pid: process.pid,
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

export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export class FileLogSink implements LogSink {
  private fd?: number;
  private size = 0;
  private total = 0;
  private day = '';
  private part = 0;
  private exhausted = false;
  private failed = false;

  constructor(
    private readonly directory: string,
    private readonly options: { now?: () => Date; partBytes?: number; dayBytes?: number } = {},
  ) {}

  write(line: string) {
    try {
      const now = this.options.now?.() ?? new Date();
      const day = localDate(now);
      if (day !== this.day || this.fd === undefined) this.openDay(day);
      if (this.exhausted) return;
      const bytes = Buffer.from(line, 'utf8');
      const marker = Buffer.from(
        JSON.stringify({
          ts: now.toISOString(),
          lvl: 'warn',
          ev: 'log.budget_exhausted',
          proc: 'control',
          pid: process.pid,
        }) + '\n',
      );
      if (this.total + bytes.length + marker.length > (this.options.dayBytes ?? 1024 ** 3)) {
        this.append(marker);
        this.exhausted = true;
      } else this.append(bytes);
      this.failed = false;
    } catch (error) {
      // The log cannot record its own failure; report once per failure streak.
      if (!this.failed) process.stderr.write(`control log write failed: ${String(error)}\n` + line);
      this.failed = true;
    }
  }

  close() {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }

  private openDay(day: string) {
    this.close();
    this.day = day;
    this.part = 0;
    this.total = 0;
    const directory = join(this.directory, day);
    mkdirSync(directory, { recursive: true });
    for (const name of readdirSync(directory)) {
      const match = /^control(?:\.(\d+))?\.jsonl$/.exec(name);
      if (!match) continue;
      this.part = Math.max(this.part, Number(match[1] ?? 0));
      this.total += statSync(join(directory, name)).size;
    }
    this.exhausted = this.total >= (this.options.dayBytes ?? 1024 ** 3);
    this.openPart();
    const tail = Buffer.alloc(Math.min(512, this.size));
    if (tail.length) {
      const reader = openSync(join(directory, `control${this.part ? '.' + this.part : ''}.jsonl`), 'r');
      try {
        readSync(reader, tail, 0, tail.length, this.size - tail.length);
      } finally {
        closeSync(reader);
      }
      this.exhausted ||= tail.includes('"ev":"log.budget_exhausted"');
    }
  }

  private openPart() {
    const path = join(this.directory, this.day, `control${this.part ? '.' + this.part : ''}.jsonl`);
    this.fd = openSync(path, 'a');
    this.size = statSync(path).size;
  }

  private append(bytes: Buffer) {
    if (this.size && this.size + bytes.length > (this.options.partBytes ?? 64 * 1024 ** 2)) {
      this.close();
      this.part++;
      this.openPart();
    }
    writeSync(this.fd!, bytes);
    this.size += bytes.length;
    this.total += bytes.length;
  }
}
