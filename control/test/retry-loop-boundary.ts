import type { TestContext } from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import { RemoteKitError, type ErrorCode } from '../shared/errors';
import { configureLog } from '../server/log';
import { diagnostics } from '../client/media/diagnostics';

export interface Attempt {
  at: number;
  input: unknown;
}

/** A dependency, deliberately without access to the owner's retry machinery. */
export class FailingBoundary {
  readonly attempts: Attempt[] = [];
  code?: ErrorCode;
  retryAfterMs?: number;
  version = 1;
  async call<T>(input: unknown, value: T): Promise<T> {
    return this.callSync(input, value);
  }
  callSync<T>(input: unknown, value: T): T {
    this.attempts.push({ at: Date.now(), input: structuredClone(input) });
    if (this.code)
      throw new RemoteKitError(this.code, 'injected dependency failure', {
        errorId: 'e-0123456789',
        retryAfterMs: this.retryAfterMs,
      });
    return value;
  }
  readStoredFailure<T>(input: unknown, rows: (code: ErrorCode | undefined) => T): T {
    this.attempts.push({ at: Date.now(), input: structuredClone(input) });
    return rows(this.code);
  }
}

export interface OwnerDriver {
  advance?(milliseconds: number): Promise<unknown>;
  start(): void | Promise<unknown>;
  drive(): void | Promise<unknown>;
  changeInput(): void | Promise<unknown>;
  error(): unknown;
  dispose(): void | Promise<unknown>;
}

export type OwnerFactory = (boundary: FailingBoundary, t: TestContext) => OwnerDriver | Promise<OwnerDriver>;

export function ownerMocks(context: TestContext) {
  const timers = ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'].map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)!] as const,
  );
  const methods: { restore(): void; resetCalls(): void }[] = [];
  const mock = new Proxy(context.mock, {
    get(target, key) {
      if (key === 'method')
        return (...args: unknown[]) => {
          const method = Reflect.apply(target.method, target, args);
          methods.push(method.mock);
          return method;
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    context: new Proxy(context, {
      get(target, key) {
        if (key === 'mock') return mock;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
    restore() {
      context.mock.reset();
      // Node restores mocks in creation order; nested replacements need reverse order.
      for (const method of methods.reverse()) {
        method.restore();
        method.resetCalls();
      }
      methods.length = 0;
      for (const [name, descriptor] of timers) Object.defineProperty(globalThis, name, descriptor);
      syncBuiltinESMExports();
    },
  };
}

export async function settle() {
  for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

export function observeLogs(t: TestContext, event: string) {
  const warnings: unknown[] = [];
  const recoveries: unknown[] = [];
  const record = (name: string, fields?: unknown) => {
    if (name === event + '_failed' || name === event + '.failed') warnings.push(fields);
    if (name === event + '_recovered' || name === event + '.recovered') recoveries.push(fields);
  };
  t.mock.method(diagnostics, 'record', record);
  const consoleRecord = (line: string) => {
    try {
      const value = JSON.parse(line);
      record(value.ev, value);
    } catch {
      // Other owner diagnostics are outside this streak's log stream.
    }
  };
  configureLog({ write: consoleRecord });
  t.after(() =>
    configureLog({
      write: (line) => {
        process.stderr.write(line);
      },
    }),
  );
  t.mock.method(console, 'warn', consoleRecord);
  t.mock.method(console, 'info', consoleRecord);
  return { warnings, recoveries };
}

/** Retain a public operation's rejected result without awaiting a retrying operation. */
export function operation() {
  let failure: unknown;
  let pending = false;
  return {
    error: () => failure,
    run(work: () => Promise<unknown>) {
      if (pending) return;
      pending = true;
      failure = undefined;
      void work().then(
        () => {
          pending = false;
          failure = undefined;
        },
        (error: unknown) => {
          pending = false;
          failure = error;
        },
      );
    },
  };
}
