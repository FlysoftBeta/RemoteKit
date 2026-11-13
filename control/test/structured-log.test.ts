import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { configureLog, FileLogSink, log, logFiles, reportError } from '../server/log';
import { RemoteKitError, nativeError, wireError } from '../shared/errors';
import { formatError } from '../client/util/format-error';
import { controlLogTail } from '../server/diagnostics/control-log';
import { findError } from '../server/diagnostics/error-search';
import limits from '../../protocol/limits.json';
import { dispatchViewerRequest } from '../server/http/viewer-socket';
import { createHttp } from '../server/http/server';
import type { DomainServices } from '../server/application';
import type { NodeRegistry } from '../server/cluster/node-link';
import { EndpointLog } from '../server/cluster/endpoint-log';
import { testGateway } from './server-fixture';
import { EndpointSnapshotError } from '../server/endpoint/gateway';

const capture = () => {
  const records: any[] = [];
  configureLog({ write: (line) => records.push(JSON.parse(line)) }, 'debug');
  return records;
};

test('node log search accepts the line limit and omits the next line', async () => {
  for (const count of [limits.logSearchLines, limits.logSearchLines + 1]) {
    const nodes = {
      all: () => [
        {
          nodeId: 'node',
          state: { state: 'ready' },
          request: async () => ({ lines: Array.from({ length: count }, (_, i) => String(i)) }),
        },
      ],
    } as unknown as Pick<NodeRegistry, 'all'>;
    const result = await findError('e-1234567890', undefined, nodes);
    assert.equal(result.records.length, limits.logSearchLines);
    assert.equal(result.records[result.records.length - 1].line, String(limits.logSearchLines - 1));
  }
});

test('file sink rotates four backups and the diagnostic tail uses the newest combined bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-control-log-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sink = new FileLogSink(directory, 4);
  try {
    for (let index = 0; index < 7; index++) sink.write(`${index}ab\n`);
  } finally {
    sink.close();
  }
  assert.deepEqual(await Promise.all(logFiles(directory).map((file) => readFile(file, 'utf8'))), [
    '6ab\n',
    '5ab\n',
    '4ab\n',
    '3ab\n',
    '2ab\n',
  ]);
  const tail = await controlLogTail(directory, 6);
  assert.equal(tail.data.toString(), 'b\n6ab\n');
  assert.equal(tail.dropped, 2);
});

test('reportError assigns once, keeps Endpoint IDs and serializes the diagnosis and cause', () => {
  const records = capture();
  const failure = new RemoteKitError('internal', 'failed', { cause: new Error('root diagnosis') });
  reportError(failure, 'fixture.failed', { tenant: 'tenant' });
  reportError(failure, 'fixture.again_failed');
  assert.match(failure.errorId!, /^c-[0-9a-f]{10}$/);
  assert.equal(records.length, 1);
  assert.equal(records[0].errorId, failure.errorId);
  assert.equal(records[0].err.cause.message, 'root diagnosis');
  const endpoint = nativeError({ code: 'rejected', message: 'native diagnosis', errorId: 'e-1234567890' });
  reportError(endpoint, 'endpoint.failed');
  assert.equal(records[1].errorId, 'e-1234567890');
  assert.equal(wireError(endpoint).errorId, 'e-1234567890');
  assert.match(
    reportError(new RemoteKitError('invalid_request', ''), 'fixture.failed').errorId!,
    /^c-[0-9a-f]{10}$/,
  );
  log.debug('fixture.debug', { count: 1n });
  assert.equal(records[3].count, '1');
  log.error('fixture.native_failed', {
    err: { code: 'internal', message: 'native diagnosis', reason: 'corrupt_state' },
  });
  assert.equal(records[4].err.message, 'native diagnosis');
  assert.equal(records[4].err.reason, 'corrupt_state');
});

test('Endpoint stderr write failures log once per streak and recover after a successful write', async (t) => {
  const records = capture();
  const directory = await mkdtemp(join(tmpdir(), 'rk-endpoint-stderr-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'endpoint.log');
  await mkdir(path);
  const sink = new EndpointLog(path);
  sink.write(Buffer.from('first'));
  sink.write(Buffer.from('second'));
  await sink.flush();
  assert.equal(records.filter((record) => record.ev === 'endpoint_log.write_failed').length, 1);
  await rm(path, { recursive: true });
  sink.write(Buffer.from('recovered'));
  await sink.flush();
  assert.equal(await readFile(path, 'utf8'), 'recovered');
  await rm(path);
  await mkdir(path);
  sink.write(Buffer.from('third'));
  await sink.flush();
  assert.equal(records.filter((record) => record.ev === 'endpoint_log.write_failed').length, 2);
});

test('Viewer error formatting uses shared messages and appends the original error ID', async () => {
  const { errorCodeMessage, httpStatus } = await import('../shared/errors');
  for (const code of Object.keys(httpStatus) as (keyof typeof httpStatus)[])
    assert.equal(formatError(new RemoteKitError(code, '')), errorCodeMessage(code));
  assert.equal(
    formatError(new RemoteKitError('internal', '失败', { errorId: 'c-1234567890' })),
    '失败（错误 ID c-1234567890）',
  );
  assert.equal(
    formatError(nativeError({ code: 'internal', message: 'private', errorId: 'e-1234567890' })),
    '服务内部错误（错误 ID e-1234567890）',
  );
});

test('one-shot wrapping preserves Endpoint diagnosis IDs, reasons and hints', async () => {
  capture();
  const gateway = testGateway({
    request: async () => {
      throw {
        code: 'unavailable',
        message: 'native startup failed',
        reason: 'browser_restarting',
        errorId: 'e-1234567890',
        retryAfterMs: 25,
      };
    },
  });
  await assert.rejects(gateway.snapshot('tenant', { outputDiagnostics: true }), (error) => {
    assert.ok(error instanceof RemoteKitError);
    assert.equal(error.errorId, 'e-1234567890');
    assert.equal(error.reason, 'browser_restarting');
    assert.equal(error.retryAfterMs, 25);
    return true;
  });
  const native = nativeError({ code: 'unavailable', message: 'native diagnosis', errorId: 'e-1234567890' });
  const snapshot = new EndpointSnapshotError(native, undefined);
  assert.equal(snapshot.errorId, native.errorId);
  assert.equal(snapshot.cause, native);
});

function fakeControl() {
  return {
    events: new EventEmitter(),
    accounts: { identity: () => ({ tenantId: 'tenant' }) },
    store: { accounts: { userForTenant: () => ({ isAdmin: true }) } },
    viewers: {
      assertViewer() {},
      assertProductViewer() {},
      attachViewer: async () => undefined,
      detachViewer: async () => {},
      productEpoch: () => 1,
      productAllowed: () => true,
      pollFaceAuth: async () => {},
    },
    rtc: {
      clearSignals() {},
      offer: async () => {
        throw new Error('full WS diagnosis');
      },
    },
  } as unknown as DomainServices;
}

test('WS failure replies carry the error ID of the structured log record', async (t) => {
  const records = capture();
  const server = createHttp(fakeControl(), { origins: ['http://test.local'], clientDir: '.' });
  t.after(() => server.shutdown());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/api/socket`, {
    origin: 'http://test.local',
    headers: { cookie: 'rk_session=token' },
  });
  await once(client, 'open');
  const response = new Promise<any>((resolve) =>
    client.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString());
      if (message.id === 'failure') resolve(message);
    }),
  );
  client.send(JSON.stringify({ id: 'failure', method: 'rtc.offer', params: {} }));
  const reply = await response;
  const record = records.find((record) => record.ev === 'viewer.request_failed');
  assert.match(reply.error.errorId, /^c-[0-9a-f]{10}$/);
  assert.equal(reply.error.errorId, record.errorId);
  assert.equal(record.err.cause.message, 'full WS diagnosis');
  assert.equal(record.method, 'rtc.offer');
  client.terminate();
});

test('admin.findError validates IDs, confirms JSON matches and caps rotated Control log results', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-error-search-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const errorId = 'c-1234567890';
  const current = JSON.stringify({ errorId, ev: 'current.failed' });
  await writeFile(
    logFiles(directory)[0],
    [JSON.stringify({ note: errorId }), '{broken ' + errorId, current].join('\n') + '\n',
  );
  await writeFile(
    logFiles(directory)[1],
    Array.from({ length: 60 }, () => JSON.stringify({ errorId })).join('\n'),
  );
  const control = fakeControl();
  const authority = { tenantId: 'tenant', leaseId: 'lease', epoch: 1 };
  const call = (id: string) =>
    dispatchViewerRequest(control, authority, 'admin.findError', { errorId: id }, undefined, undefined, {
      directory,
      nodes: { all: () => [] },
    });
  const result = await call(errorId);
  assert.equal(result.records.length, 50);
  assert.deepEqual(result.records[0], { source: 'control', line: current });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(await call('c-0000000000'), { records: [], failures: [] });
  await assert.rejects(call('../../secret'), { code: 'invalid_request' });
});

test('admin.findError queries every ready node in parallel using the management contract', async () => {
  capture();
  const calls: string[] = [];
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    release = resolve;
  });
  const nodes = {
    all: () => [
      {
        nodeId: 'one',
        state: { state: 'ready' },
        request: async (method: string, tenant: string, params: unknown, timeout: number) => {
          assert.equal(method, 'node.logs.search');
          assert.equal(tenant, '');
          assert.deepEqual(params, { errorId: 'e-1234567890' });
          assert.equal(timeout, 5000);
          calls.push('one');
          await entered;
          return { lines: ['{"ts":"first"}', '{"ts":"second"}'] };
        },
      },
      {
        nodeId: 'two',
        state: { state: 'ready' },
        request: async () => {
          calls.push('two');
          release();
          throw new Error('offline');
        },
      },
      {
        nodeId: 'offline',
        state: { state: 'offline' },
        request: async () => assert.fail('offline node queried'),
      },
    ],
  } as unknown as Pick<NodeRegistry, 'all'>;
  const result = await dispatchViewerRequest(
    fakeControl(),
    { tenantId: 'tenant', leaseId: 'lease', epoch: 1 },
    'admin.findError',
    { errorId: 'e-1234567890' },
    undefined,
    undefined,
    { nodes },
  );
  assert.deepEqual(calls, ['one', 'two']);
  assert.deepEqual(result.records, [
    { source: 'one', line: '{"ts":"first"}' },
    { source: 'one', line: '{"ts":"second"}' },
  ]);
  assert.deepEqual(
    result.failures.map((failure: { nodeId: string }) => failure.nodeId),
    ['two'],
  );
  assert.equal(result.failures[0].error.code, 'internal');
  assert.match(result.failures[0].error.errorId, /^c-[0-9a-f]{10}$/);
});
