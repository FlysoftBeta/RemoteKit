import { errorHandling, retryDelay } from './error-policy';
import {
  RemoteKitError,
  endpointError,
  wireError,
  parseWireError,
  type ErrorCode,
  type WireError,
} from './errors';

export type RetryUnitState =
  | { phase: 'idle' }
  | { phase: 'waiting'; attempt: number; until: number }
  | { phase: 'faulted'; code: ErrorCode; errorId?: string; input: string }
  | { phase: 'dropped' };

export interface RetryUnitOptions {
  name?: string;
  now?: () => number;
  busyBudget?: number;
  failed?: (error: RemoteKitError) => void;
  recovered?: () => void;
}

export interface RetryUnitRecord {
  identity: string;
  input: string;
  attempts: number;
  streak: boolean;
  state: RetryUnitState;
  error?: WireError;
}

/** One unit retains its input and identity while waiting; conflict asks its owner to recompute. */
export class RetryUnit {
  state: RetryUnitState = { phase: 'idle' };
  error?: RemoteKitError;
  private input = '';
  private identityValue: string = globalThis.crypto.randomUUID();
  get identity() {
    return this.identityValue;
  }
  private attempts = 0;
  private streak = false;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly shutdown = new AbortController();
  private readonly now: () => number;

  constructor(private readonly options: RetryUnitOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }
  static delay(error: Pick<WireError, 'code' | 'retryAfterMs'>, attempt: number, busyBudget = 8) {
    if (error.code === 'busy' && attempt >= busyBudget) return;
    const handling = errorHandling(error.code);
    return (
      retryDelay(error, attempt) ??
      (handling === 'reconcile' || handling === 'refresh'
        ? retryDelay({ code: 'unavailable' }, attempt)
        : undefined)
    );
  }

  restore(record: RetryUnitRecord) {
    if (this.closed) return this;
    this.cancel();
    this.input = record.input;
    this.identityValue = record.identity;
    this.attempts = record.attempts;
    this.streak = record.streak;
    this.state = record.state;
    this.error = record.error && parseWireError(record.error);
    return this;
  }

  record(): RetryUnitRecord {
    return {
      identity: this.identityValue,
      input: this.input,
      attempts: this.attempts,
      streak: this.streak,
      state: this.state,
      ...(this.error ? { error: wireError(this.error) } : {}),
    };
  }

  ready(input = this.input) {
    if (this.closed) return false;
    if (input !== this.input) {
      this.input = input;
      this.identityValue = globalThis.crypto.randomUUID();
      this.attempts = 0;
      this.state = { phase: 'idle' };
      this.error = undefined;
      this.cancel();
    }
    return this.state.phase === 'idle' || (this.state.phase === 'waiting' && this.now() >= this.state.until);
  }

  fail(cause: unknown) {
    const error = endpointError(cause);
    if (this.closed) return { first: false, delay: undefined, error, handling: errorHandling(error.code) };
    const first = !this.streak;
    if (!error.errorId && ['internal', 'unavailable', 'outcome_unknown'].includes(error.code))
      error.errorId =
        this.error?.errorId ??
        `${typeof window === 'undefined' ? 'c' : 'v'}-${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
    this.streak = error.code !== 'canceled';
    this.error = error;
    const handling = errorHandling(error.code);
    const delay = RetryUnit.delay(error, this.attempts, this.options.busyBudget);
    this.attempts++;
    this.state =
      handling === 'drop' || handling === 'canceled'
        ? { phase: 'dropped' }
        : delay === undefined
          ? { phase: 'faulted', code: error.code, errorId: error.errorId, input: this.input }
          : { phase: 'waiting', attempt: this.attempts, until: this.now() + delay };
    if (first && handling !== 'canceled') {
      if (this.options.failed) this.options.failed(error);
      else
        console.warn(
          JSON.stringify({
            ev: `${this.options.name ?? 'retry_unit'}_failed`,
            code: error.code,
            errorId: error.errorId,
            message: error.message,
            stack: error.stack,
          }),
        );
    }
    if (this.state.phase === 'faulted') this.state.errorId = error.errorId;
    return { first, delay, error, handling };
  }

  succeed() {
    if (this.closed) return false;
    const recovered = this.streak;
    this.streak = false;
    this.attempts = 0;
    this.error = undefined;
    this.state = { phase: 'idle' };
    this.cancel();
    if (recovered) {
      if (this.options.recovered) this.options.recovered();
      else console.info(JSON.stringify({ ev: `${this.options.name ?? 'retry_unit'}_recovered` }));
    }
    return recovered;
  }

  async execute<T>(
    input: string,
    work: (identity: string) => Promise<T>,
    recompute?: () => void | Promise<void>,
  ) {
    if (!this.ready(input)) return { ran: false as const, error: this.error };
    try {
      if (this.error?.code === 'conflict') {
        await recompute?.();
        if (this.closed) return { ran: false as const, error: this.error };
        this.identityValue = globalThis.crypto.randomUUID();
      }
      const value = await work(this.identityValue);
      this.succeed();
      return { ran: true as const, value };
    } catch (cause) {
      return { ran: true as const, error: this.fail(cause).error };
    }
  }

  /** Timers only wake an eligible unit; an input change cancels obsolete work. */
  schedule(work: () => void) {
    this.cancel();
    if (this.closed || this.state.phase !== 'waiting') return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        if (!this.closed) work();
      },
      Math.max(0, this.state.until - this.now()),
    );
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  cancel() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  close() {
    this.closed = true;
    this.cancel();
    this.shutdown.abort();
  }

  wait(signal?: AbortSignal) {
    if (this.closed) return Promise.reject(new RemoteKitError('canceled', ''));
    if (this.state.phase !== 'waiting') return Promise.reject(this.error);
    const until = this.state.until;
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        cleanup();
        reject(new RemoteKitError('canceled', ''));
      };
      const cleanup = () => {
        signal?.removeEventListener('abort', abort);
        this.shutdown.signal.removeEventListener('abort', abort);
      };
      const timer = setTimeout(
        () => {
          cleanup();
          resolve();
        },
        Math.max(0, until - this.now()),
      );
      signal?.addEventListener('abort', abort, { once: true });
      this.shutdown.signal.addEventListener('abort', abort, { once: true });
      if (signal?.aborted || this.closed) abort();
    });
  }
}
