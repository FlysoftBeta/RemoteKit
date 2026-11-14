import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiagnosticSessions } from '../server/diagnostics/sessions';
import {
  DiagnosticCollection,
  type DiagnosticState,
  type DiagnosticRequest,
} from '../client/media/diagnostic-collection';
import { operation, settle, type OwnerFactory } from './retry-loop-boundary';

export function driveDiagnosticServer(path: 'control' | 'endpoint' | 'archive'): OwnerFactory {
  return async (boundary, t) => {
    t.mock.method(performance, 'now', () => Date.now());
    const evidenceRoot = resolve(fileURLToPath(new URL('../../develop/tmp/t7c-matrix/', import.meta.url)));
    const directory = resolve(evidenceRoot, 'diagnostics-' + crypto.randomUUID());
    const callbacks: (() => void)[] = [];
    const interval = setInterval;
    t.mock.method(globalThis, 'setInterval', (callback: () => void, ms: number) => {
      callbacks.push(callback);
      return interval(callback, ms);
    });
    const mkdir = fs.mkdir;
    let restoreMkdir: (() => void) | undefined;
    if (path === 'archive') {
      const mock = t.mock.method(fs, 'mkdir', (async (...args: Parameters<typeof fs.mkdir>) => {
        await boundary.call({ directory: args[0] }, undefined);
        return mkdir(...args);
      }) as typeof fs.mkdir);
      restoreMkdir = () => mock.mock.restore();
      syncBuiltinESMExports();
    }
    let owner = new DiagnosticSessions(directory, {
      control: () => (path === 'control' ? boundary.callSync({ tenant: 'tenant' }, {}) : {}),
      endpoint: () => (path === 'endpoint' ? boundary.call({ tenant: 'tenant' }, {}) : Promise.resolve({})),
      endpointLog: async () => ({ available: false, data: '', truncated: false }) as never,
    });
    const viewer = { tenant: 'tenant', lease: 'lease', identity: 'user', epoch: 1, allowed: () => true };
    let id = '';
    const result = operation();
    const begin = async () => {
      id = owner.start(viewer, {}).id;
      if (path === 'archive') await owner.request(viewer, 'diagnostics.stop', { id });
    };
    const run = async () => {
      if (path === 'archive') await owner.request(viewer, 'diagnostics.stop', { id });
      else return;
    };
    return {
      start: begin,
      drive: run,
      changeInput: async () => {
        await owner.shutdown();
        owner = new DiagnosticSessions(directory, {
          control: () => (path === 'control' ? boundary.callSync({ tenant: 'tenant' }, {}) : {}),
          endpoint: () =>
            path === 'endpoint' ? boundary.call({ tenant: 'tenant' }, {}) : Promise.resolve({}),
          endpointLog: async () => ({ available: false, data: '', truncated: false }) as never,
        });
        await begin();
      },
      error: () => owner.failures('tenant')[0] ?? result.error(),
      dispose: async () => {
        await owner.shutdown();
        restoreMkdir?.();
        syncBuiltinESMExports();
        assert.equal(dirname(directory), evidenceRoot);
        await fs.rm(directory, { recursive: true, force: true });
      },
    };
  };
}

export function driveDiagnosticClient(path: 'finish' | 'start'): OwnerFactory {
  return (boundary, t) => {
    t.mock.method(performance, 'now', () => Date.now());
    let state: DiagnosticState = { phase: 'idle' };
    const request = ((method: string, params: unknown) => {
      if (
        (path === 'start' && method === 'diagnostics.start') ||
        (path === 'finish' && method !== 'diagnostics.start')
      )
        return boundary.call(
          { method, params },
          { id: 'diagnostic-' + boundary.version, status: path === 'start' ? 'collecting' : 'complete' },
        );
      return Promise.resolve({ id: 'diagnostic-' + boundary.version, status: 'collecting' });
    }) as DiagnosticRequest;
    const owner = new DiagnosticCollection(
      request,
      () => ({}),
      (next) => {
        state = next;
      },
    );
    owner.setAvailable(true);
    const begin = async () => {
      await owner.start({} as never);
      if (path === 'finish') owner.stop();
    };
    const result = operation();
    return {
      start: () => result.run(begin),
      drive: () => {},
      changeInput: () => {
        boundary.version++;
        owner.dismiss();
        result.run(begin);
      },
      error: () => ('error' in state ? state.error : undefined),
      dispose: async () => {
        owner.dispose();
        await settle();
      },
    };
  };
}
