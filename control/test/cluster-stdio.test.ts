import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EndpointLog } from '../server/cluster/endpoint-log';
import { NodeRegistry, StdioCarrier } from '../server/cluster/node-link';
import { nodeDefaults } from '../server/config';
import { NoiseHandshake } from '../server/cluster/noise';
import { decodeFrame, encodeJson, encodeStdio, StdioDecoder, jsonObject } from '../server/cluster/frames';

test('local stdio shares authenticated handshake, encrypted RPCs and lost-reply certainty', async (t) => {
  const key = Buffer.alloc(32, 17);
  const registry = new NodeRegistry({
    key: key.toString('base64'),
    buildId: 'dev',
    nodes: { local: { config: { ...nodeDefaults, nodeId: 'local' }, configHash: 'local-hash' } },
  });
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => {
      child.emit('exit', 1);
    },
  });
  const log = await mkdtemp(join(tmpdir(), 'rk-endpoint-log-'));
  t.after(() => rm(log, { recursive: true, force: true }));
  const endpointLog = new EndpointLog(join(log, 'logs', 'endpoint.log'));
  const carrier = new StdioCarrier(child as unknown as ChildProcessWithoutNullStreams, endpointLog);
  registry.accept(carrier, 'local');
  const handshake = new NoiseHandshake('initiator', key);
  const reply = once(child.stdin, 'data');
  const hello = encodeStdio(
    handshake.writeMessage(
      Buffer.from(
        JSON.stringify({
          type: 'node.hello',
          role: 'endpoint',
          nodeId: 'local',
          buildId: 'dev',
          incarnation: 'a'.repeat(32),
        }),
      ),
    ),
  );
  child.stdout.write(hello.subarray(0, 3));
  child.stdout.write(hello.subarray(3));
  const decoder = new StdioDecoder();
  const response = decoder.push((await reply)[0])[0];
  assert.equal(jsonObject(handshake.readMessage(response)).configHash, 'local-hash');
  const transport = handshake.split();
  const link = registry.get('local')!;
  const outbound = once(child.stdin, 'data');
  const request = link.request('session.snapshot', 'tenant');
  const frame = decodeFrame(transport.receive.decrypt(decoder.push((await outbound)[0])[0]));
  assert.equal(frame.kind, 'json');
  if (frame.kind !== 'json') throw new Error('Expected JSON');
  child.stdout.write(
    encodeStdio(
      transport.send.encrypt(encodeJson({ id: frame.message.id, ok: true, result: { running: true } })),
    ),
  );
  assert.deepEqual(await request, { running: true });
  const lost = assert.rejects(link.request('session.ensure', 'tenant'), { code: 'outcome_unknown' });
  child.emit('exit', 1);
  await lost;
  assert.equal(link.state.state, 'offline');
  child.stderr.write('endpoint stderr line\n');
  await new Promise((resolve) => setImmediate(resolve));
  await endpointLog.flush();
  assert.equal(await readFile(join(log, 'logs', 'endpoint.log'), 'utf8'), 'endpoint stderr line\n');
  registry.stop();
});
