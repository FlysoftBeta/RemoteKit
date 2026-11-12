import { decodeJson } from '../server/persistence/codec';
import { diagnosticManifest, archiveMetadata } from '../server/diagnostics/formats';
import { RemoteKitError } from '../shared/errors';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { WebSocket } from 'ws';
import { createHttp } from '../server/http/server';
import { DiagnosticSessions } from '../server/diagnostics/sessions';
import { createApplication, type DomainServices } from '../server/application';
import { collectionInputSample, collectionRtcSample } from '../client/media/media-diagnostics';
import type { DiagnosticReply } from '../shared/diagnostics';

function entries(archive: Buffer) {
  assert.equal(archive.subarray(0, 4).toString('hex'), '28b52ffd');
  const tar = zstdDecompressSync(archive);
  const files = new Map<string, string>();
  let cursor = 0;
  while (tar[cursor] !== 0) {
    const header = Buffer.from(tar.subarray(cursor, cursor + 512));
    assert.equal(header.toString('ascii', 257, 263), 'ustar\0');
    const checksum = parseInt(header.toString('ascii', 148, 154), 8);
    header.fill(32, 148, 156);
    assert.equal(
      checksum,
      header.reduce((sum, byte) => sum + byte, 0),
    );
    const name = header.toString('ascii', 0, 100).split('\0')[0];
    const size = parseInt(header.toString('ascii', 124, 135), 8);
    cursor += 512;
    files.set(name, tar.toString('utf8', cursor, cursor + size));
    cursor += Math.ceil(size / 512) * 512;
  }
  assert.deepEqual(tar.subarray(cursor), Buffer.alloc(1024));
  return files;
}

test('Viewer diagnostics enforce product auth and ownership and publish a sanitized, restart-readable tar.zst', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-diagnostics-'));
  const leases = new Map<string, { lease: string; epoch?: number; allowed: boolean }>();
  const emitter = new EventEmitter();
  const snapshots: string[] = [];
  // Larger than one 512 KiB window so the tail walk must stitch windows.
  const browserLog = Buffer.from(
    Array.from({ length: 30000 }, (_, i) => `[INFO:CONSOLE] line ${i}\n`).join(''),
  );
  const logReads: unknown[] = [];
  const control = {
    events: emitter,
    store: {
      accounts: {
        identity: (token: string) =>
          token ? { tenantId: token === 'new-token' ? 'one' : token } : undefined,
      },
      workspaces: {
        workspace: () => ({
          revision: 4,
          spaces: [],
          activeSpaceId: null,
          tabs: [{ title: 'sensitive-title' }],
          windows: [],
          settings: {
            workspace: { qualityPreference: 'auto', unrelatedSetting: 'sensitive-setting' },
            browser: { searchEngine: 'google' },
          },
        }),
      },
    },
    endpoint: {
      readLog: async (tenant: string, request: { log: string; end?: number; maxBytes: number }) => {
        logReads.push({ tenant, ...request });
        if (request.log !== 'browser') return { exists: false, size: 0, start: 0, end: 0, data: '' };
        const end = Math.min(request.end ?? browserLog.length, browserLog.length);
        const start = Math.max(0, end - request.maxBytes);
        return {
          exists: true,
          size: browserLog.length,
          start,
          end,
          data: browserLog.subarray(start, end).toString('base64'),
        };
      },
      snapshot: async (tenant: string, options: unknown) => {
        assert.deepEqual(options, { outputDiagnostics: true });
        snapshots.push(tenant);
        return {
          running: true,
          browserIncarnation: 'sensitive-id',
          rtc: { active: true, connectionId: 'sensitive-connection' },
          stats: {
            comp: { begins: 7 },
            qsvRateControl: {
              lowDelayBrc: 16,
              maxFrameSize: 0,
              maxFrameSizeI: 0,
              maxFrameSizeP: 0,
              bufferSizeKb: 6000,
              initialDelayKb: 3000,
              token: 99,
            },
            decoderImplementation: 'password-from-page',
            senderRtcStats: {
              outbound: [
                { kind: 'video', packetsSent: 3, token: 99 },
                { kind: 'audio', packetsSent: 12, bytesSent: 345, token: 88 },
              ],
            },
          },
          views: [
            {
              width: 1920,
              title: 'sensitive-title',
              url: 'https://secret.invalid',
              compositor: { osr: { kind: 'custom-osr', enabled: true } },
            },
          ],
          outputDiagnostics: {
            ok: true,
            output: { kind: 'osr-renderer', submitted: '10', generation: '500' },
          },
        };
      },
    },
    viewers: {
      assertViewer() {},
      attachViewer: async (tenant: string, lease: string) => {
        leases.set(tenant, { lease, epoch: tenant === 'locked' ? undefined : 1, allowed: true });
      },
      detachViewer: async () => {},
      productAllowed: (tenant: string, lease: string) =>
        leases.get(tenant)?.lease === lease && leases.get(tenant)?.allowed,
      productEpoch: (tenant: string, lease: string) =>
        leases.get(tenant)?.lease === lease ? leases.get(tenant)?.epoch : undefined,
      pollFaceAuth: async () => {},
    },
    rtc: { clearSignals() {} },
    accounts: {
      identity: (token: string) => (token ? { tenantId: token === 'new-token' ? 'one' : token } : undefined),
    },
  } as unknown as DomainServices;
  const server = createHttp(control, {
    origins: ['http://test.local'],
    clientDir: '.',
    diagnosticDir: directory,
    logDir: directory,
  });
  await writeFile(join(directory, 'control.jsonl.1'), 'older control record\n');
  await writeFile(join(directory, 'control.jsonl'), 'latest control record\n');
  t.after(async () => {
    await server.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  let nextRequest = 0;
  async function viewer(token: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/socket`, {
      origin: 'http://test.local',
      headers: { cookie: `rk_session=${token}` },
    });
    await once(ws, 'open');
    return {
      ws,
      request: async (method: string, params: object): Promise<DiagnosticReply> => {
        const id = String(++nextRequest);
        return new Promise((resolve, reject) => {
          const receive = (raw: Buffer) => {
            const message = JSON.parse(raw.toString());
            if (message.id !== id) return;
            ws.off('message', receive);
            if (message.type === 'result') resolve(message.result);
            else reject(new RemoteKitError(message.error.code, message.error.message));
          };
          ws.on('message', receive);
          ws.send(JSON.stringify({ id, method: 'diagnostics.' + method, params }));
        });
      },
    };
  }
  const one = await viewer('one'),
    two = await viewer('two'),
    locked = await viewer('locked');
  await assert.rejects(locked.request('start', {}), { code: 'locked' });
  const auth = leases.get('one')!;
  auth.allowed = false;
  await assert.rejects(one.request('start', {}), { code: 'locked' });
  auth.allowed = true;
  const started = await one.request('start', {
    environment: { platform: 'android', browserVersion: '139.0.1.2', userAgent: 'sensitive-UA' },
  });
  const { id } = started;
  assert.equal(started.status, 'collecting');
  assert.deepEqual(await one.request('start', {}), started);
  await assert.rejects(two.request('status', { id }), { code: 'not_found' });
  await assert.rejects(two.request('stop', { id }), { code: 'not_found' });
  await assert.rejects(one.request('sample', { id, sequence: 1, data: { title: 'x'.repeat(128 * 1024) } }), {
    code: 'limit_exceeded',
  });
  const data = {
    rtc: collectionRtcSample({
      id: 'rtcid',
      type: 'inbound-rtp',
      timestamp: 17,
      bytesReceived: 100,
      decoderImplementation: 'ExternalDecoder (MediaCodecVideoDecoder)',
    }),
    input: collectionInputSample(
      [
        {
          at: 50,
          sourceClock: 'arrival-fallback',
          sequence: '4',
          action: 'momentumEnd',
          text: 'sensitive-key',
        },
      ],
      [
        {
          at: 51,
          error: { code: 'unavailable', message: 'endpoint_backpressure' },
          type: 'input.result',
          clientSequence: '4',
        },
      ],
      0,
    ),
    connection: { peerState: 'connected', host: 'secret.invalid', sdp: 99 },
    layout: { generation: '12' },
    presentation: {
      frames: [{ atMs: 50, rtpTimestamp: 12345, expectedDisplayTimeMs: 66, processingDurationSeconds: 0.03 }],
      metadata: Array.from({ length: 64 }, (_, i) => ({ atMs: i, rtpTimestamp: i * 1000 })),
    },
  };
  assert.equal((await one.request('sample', { id, sequence: 1, data })).status, 'collecting');
  await one.request('sample', { id, sequence: 1, data: {} });
  const [complete, duplicate] = await Promise.all([one.request('stop', { id }), one.request('stop', { id })]);
  assert.deepEqual(complete, duplicate);
  assert.equal(complete.status, 'complete');
  assert.equal(complete.reason, 'user');
  const owner = join(directory, createHash('sha256').update('one').digest('hex'));
  assert.deepEqual((await readdir(owner)).sort(), [`${id}.reason`, `${id}.tar.zst`]);
  const bytes = await readFile(join(owner, `${id}.tar.zst`));
  assert.equal(complete.bytes, bytes.length);
  const files = entries(bytes);
  assert.deepEqual(
    [...files.keys()],
    [
      'manifest.json',
      'client.jsonl',
      'control.jsonl',
      'endpoint.jsonl',
      'events.jsonl',
      'logs/control.jsonl',
      'logs/browser.log',
    ],
  );
  assert.equal(files.get('logs/control.jsonl'), 'older control record\nlatest control record\n');
  assert.equal(files.get('logs/browser.log'), browserLog.toString());
  assert.deepEqual(
    logReads.map((read) => (read as { log: string }).log),
    ['browser', 'browser', 'endpoint', 'endpoint.1', 'crashes'],
  );
  const manifest = JSON.parse(files.get('manifest.json')!);
  assert.deepEqual(decodeJson(files.get('manifest.json')!, diagnosticManifest, 'manifest'), manifest);
  for (const value of [
    { ...manifest, id: undefined },
    { ...manifest, unknown: true },
    { ...manifest, id: 7 },
  ])
    assert.throws(() => decodeJson(JSON.stringify(value), diagnosticManifest, 'manifest'), {
      reason: 'corrupt_record',
    });
  const metadata = { version: 1, reason: 'user' };
  assert.deepEqual(decodeJson(JSON.stringify(metadata), archiveMetadata, 'metadata'), metadata);
  for (const value of [
    { ...metadata, reason: undefined },
    { ...metadata, unknown: true },
    { ...metadata, reason: 7 },
  ])
    assert.throws(() => decodeJson(JSON.stringify(value), archiveMetadata, 'metadata'), {
      reason: 'corrupt_record',
    });

  assert.deepEqual(manifest.logs, {
    control: { bytes: Buffer.byteLength('older control record\nlatest control record\n'), droppedBefore: 0 },
    browser: { exists: true, size: browserLog.length, start: 0, bytes: browserLog.length },
    endpoint: { exists: false, size: 0, start: 0, bytes: 0 },
    'endpoint.1': { exists: false, size: 0, start: 0, bytes: 0 },
    crashes: { exists: false, size: 0, start: 0, bytes: 0 },
  });
  assert.deepEqual(manifest.environment, { platform: 'android', browserVersion: '139.0.1.2' });
  assert.equal(manifest.sources.client.records, 1);
  assert.equal(manifest.interrupted, false);
  const archived = JSON.parse(files.get('client.jsonl')!).data;
  assert.equal(archived.rtc.inboundVideo.decoderImplementation, 'ExternalDecoder (MediaCodecVideoDecoder)');
  assert.deepEqual(archived.input.trace[0], {
    atMs: 50,
    action: 'momentumEnd',
    sourceClock: 'arrival-fallback',
    sequence: '4',
  });
  assert.equal(archived.input.results[0].reason, 'endpoint_backpressure');
  assert.deepEqual(archived.presentation, data.presentation);
  const endpoint = JSON.parse(files.get('endpoint.jsonl')!).data;
  assert.equal(endpoint.stats.comp.begins, 7);
  assert.deepEqual(endpoint.stats.qsvRateControl, {
    lowDelayBrc: 16,
    maxFrameSize: 0,
    maxFrameSizeI: 0,
    maxFrameSizeP: 0,
    bufferSizeKb: 6000,
    initialDelayKb: 3000,
  });
  assert.deepEqual(endpoint.stats.senderRtcStats.outbound, [
    { kind: 'video', packetsSent: 3 },
    { kind: 'audio', packetsSent: 12, bytesSent: 345 },
  ]);
  assert.equal(endpoint.browserOutput.submitted, '10');
  assert.equal(endpoint.views[0].compositor.osr.enabled, true);
  // Raw logs are archived verbatim; projected samples stay sanitized.
  assert.doesNotMatch(
    [...files]
      .filter(([name]) => !name.startsWith('logs/'))
      .map(([, text]) => text)
      .join(''),
    /sensitive-|secret\.invalid|password-from-page|rtcid|"sdp"|"token"/,
  );
  assert.deepEqual(snapshots, ['one']);

  const second = await one.request('start', {});
  auth.allowed = false;
  auth.epoch = 2;
  emitter.emit('auth', 'one', auth.lease, { locked: true });
  await assert.rejects(one.request('sample', { id: second.id, sequence: 1, data }), { code: 'locked' });
  const replacement = await viewer('new-token');
  assert.equal((await replacement.request('stop', { id: second.id })).reason, 'authorization-changed');
  const third = await replacement.request('start', {});
  replacement.ws.close();
  await once(replacement.ws, 'close');
  const reconnect = await viewer('one');
  assert.equal((await reconnect.request('stop', { id: third.id })).reason, 'disconnected');

  const restarted = new DiagnosticSessions(directory, {
    control: () => ({}),
    endpoint: async () => ({}),
    endpointLog: () => Promise.reject(new Error('unused')),
  });
  const query = { tenant: 'one', identity: 'changed', lease: 'after-restart', epoch: 1, allowed: () => true };
  assert.deepEqual(await restarted.request(query, 'diagnostics.stop', { id }), complete);
  await assert.rejects(restarted.request({ ...query, tenant: 'two' }, 'diagnostics.status', { id }), {
    code: 'not_found',
  });
});

test('global capacity includes finalization, and shutdown drains even when Endpoint is unresponsive or archive writes fail', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-diagnostics-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const blockingFile = join(directory, 'blocking');
  await writeFile(blockingFile, 'sentinel');
  const manager = new DiagnosticSessions(blockingFile, {
    control: () => ({}),
    endpoint: () => new Promise(() => {}),
    endpointLog: () => Promise.reject(new RemoteKitError('unavailable', 'Endpoint offline')),
  });
  const viewer = (tenant: string) => ({
    tenant,
    identity: tenant,
    lease: tenant,
    epoch: 1,
    allowed: () => true,
  });
  const started = await Promise.all(
    ['a', 'b', 'c', 'd'].map((tenant) => manager.request(viewer(tenant), 'diagnostics.start', {})),
  );
  await assert.rejects(manager.request(viewer('e'), 'diagnostics.start', {}), { code: 'busy' });
  const stopping = manager.request(viewer('a'), 'diagnostics.stop', { id: started[0].id });
  await assert.rejects(manager.request(viewer('e'), 'diagnostics.start', {}), { code: 'busy' });
  await manager.shutdown();
  const failed = await stopping;
  assert.deepEqual(
    { ...failed, error: undefined },
    { id: started[0].id, status: 'failed', reason: 'archive-write-failed', error: undefined },
  );
  assert(failed.status === 'failed');
  assert.equal(failed.error?.code, 'internal');
  assert.match(failed.error?.errorId ?? '', /^c-[0-9a-f]{10}$/);
  assert.equal(
    (await manager.request(viewer('b'), 'diagnostics.status', { id: started[1].id })).status,
    'failed',
  );
  assert.equal(await readFile(blockingFile, 'utf8'), 'sentinel');
});

test('crash diagnostics retain binary dumps, bound count and skip oversized or partial files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rk-crash-diagnostics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const names = [1, 2, 3, 4].map(
    (value) => `${String(value).padStart(8, '0')}-0000-0000-0000-000000000000.dmp`,
  );
  const dump = Buffer.from([0x4d, 0x44, 0x4d, 0x50, 0, 255, 128, 1]);
  const event = Buffer.from(JSON.stringify({ event: 'browser_crashed', exitCode: 0x80000003 }) + '\n');
  const reads: string[] = [];
  const manager = new DiagnosticSessions(directory, {
    control: () => ({}),
    endpoint: async () => ({}),
    endpointLog: async (_tenant, request) => {
      reads.push(request.log);
      const data =
        request.log === 'crashes' ? event : request.log.startsWith('dump/') ? dump : Buffer.alloc(0);
      const end = Math.min(request.end ?? data.length, data.length);
      const start = Math.max(0, end - request.maxBytes);
      return {
        exists: data.length > 0,
        size: data.length,
        start,
        end,
        data: data.subarray(start, end).toString('base64'),
        ...(request.log === 'crashes'
          ? {
              dumps: names.map((name, i) => ({
                name,
                size: i === 1 ? 17 * 1024 * 1024 : i === 2 ? dump.length + 1 : dump.length,
              })),
            }
          : {}),
      };
    },
  });
  t.after(() => manager.shutdown());
  const viewer = { tenant: 'one', identity: 'one', lease: 'one', epoch: 1, allowed: () => true };
  const started = manager.start(viewer, {});
  const result = await manager.request(viewer, 'diagnostics.stop', { id: started.id });
  assert.equal(result.status, 'complete');
  const owner = join(directory, createHash('sha256').update('one').digest('hex'));
  const compressed = await readFile(join(owner, started.id + '.tar.zst'));
  const tar = zstdDecompressSync(compressed);
  const files = entries(compressed);
  assert.equal(files.get('crashes/events.jsonl'), event.toString());
  assert(tar.includes(dump));
  assert(files.has('crashes/' + names[0]));
  assert(!files.has('crashes/' + names[1]));
  assert(!files.has('crashes/' + names[2]));
  assert(!reads.includes('dump/' + names[3]));
  const manifest = JSON.parse(files.get('manifest.json')!);
  assert.deepEqual(decodeJson(files.get('manifest.json')!, diagnosticManifest, 'manifest'), manifest);
  for (const value of [
    { ...manifest, id: undefined },
    { ...manifest, unknown: true },
    { ...manifest, id: 7 },
  ])
    assert.throws(() => decodeJson(JSON.stringify(value), diagnosticManifest, 'manifest'), {
      reason: 'corrupt_record',
    });
  const metadata = { version: 1, reason: 'user' };
  assert.deepEqual(decodeJson(JSON.stringify(metadata), archiveMetadata, 'metadata'), metadata);
  for (const value of [
    { ...metadata, reason: undefined },
    { ...metadata, unknown: true },
    { ...metadata, reason: 7 },
  ])
    assert.throws(() => decodeJson(JSON.stringify(value), archiveMetadata, 'metadata'), {
      reason: 'corrupt_record',
    });

  assert.equal(manifest.logs['dump/' + names[1]].error, 'dump size limit');
  assert.equal(manifest.logs['dump/' + names[2]].error, 'incomplete dump');
});
