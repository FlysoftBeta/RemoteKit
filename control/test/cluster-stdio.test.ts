import { publicKey } from '../server/cluster/noise';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EndpointLog } from '../server/cluster/endpoint-log';
import { log } from '../server/log';
import { NodeRegistry, StdioCarrier } from '../server/cluster/node-link';
import { endpointDefaults, testNode, nodePrivateKey } from './node-fixture';
import { NoiseHandshake } from '../server/cluster/noise';
import { decodeFrame, encodeJson, encodeStdio, StdioDecoder, jsonObject } from '../server/cluster/frames';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

test('a swapped local bootstrap rejection belongs to the receiving stdio node', () => {
  const key = Buffer.alloc(32, 17);
  const registry = new NodeRegistry({
    privateKey: key.toString('base64'),
    buildId: 'dev',
    nodes: { alpha: testNode('alpha'), beta: testNode('beta') },
  });
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      child.emit('exit', 1);
    },
  });
  const carrier = new StdioCarrier(
    child as unknown as ChildProcessWithoutNullStreams,
    new EndpointLog(join(tmpdir(), 'rk-swapped-identity.log')),
  );
  registry.accept(carrier, 'alpha');
  const handshake = new NoiseHandshake('initiator', nodePrivateKey('beta'), publicKey(key));
  child.stdout.write(
    encodeStdio(
      handshake.writeMessage(
        Buffer.from(
          JSON.stringify({
            type: 'node.hello',
            role: 'endpoint',
            nodeId: 'beta',
            buildId: 'dev',
            incarnation: 'a'.repeat(32),
          }),
        ),
      ),
    ),
  );
  assert.equal(registry.get('alpha')!.history().rejected?.code, 'identity_mismatch');
  assert.equal(registry.get('beta')!.history().rejected, undefined);
  assert.equal(registry.unknownIdentityRejection, undefined);
  registry.stop();
});

for (const code of [1, 0, null, 99, 3, 4]) {
  test(`local Endpoint exit ${code} follows the restart policy`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const children: EventEmitter[] = [];
    t.mock.method(childProcess, 'spawn', () => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill() {
          child.emit('exit', 0);
        },
      });
      children.push(child);
      return child;
    });
    syncBuiltinESMExports();
    const registry = new NodeRegistry({
      privateKey: Buffer.alloc(32).toString('base64'),
      buildId: 'dev',
      nodes: {
        local: {
          ...testNode('local'),
          local: { root: tmpdir(), executable: 'endpoint_service.exe' },
        },
      },
    });
    t.after(() => {
      registry.stop();
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    registry.start();
    children[0].emit('exit', code);
    if (code === 3) {
      t.mock.timers.tick(60_000);
      assert.equal(children.length, 1);
      return;
    }
    if (code !== 4) {
      t.mock.timers.tick(1499);
      assert.equal(children.length, 1);
    }
    t.mock.timers.tick(code === 4 ? 0 : 1);
    assert.equal(children.length, 2);
    children[1].emit('exit', code);
    t.mock.timers.tick(code === 4 ? 0 : 2999);
    assert.equal(children.length, code === 4 ? 3 : 2);
    if (code !== 4) {
      t.mock.timers.tick(1);
      assert.equal(children.length, 3);
    }
    registry.stop();
    t.mock.timers.tick(60_000);
    assert.equal(children.length, 3);
  });
}

for (const outcome of ['success', 'failure', 'stopped', 'dev'] as const) {
  test(`local runtime installation: ${outcome}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'rk-local-install-'));
    const calls: { executable: string; args: readonly string[]; child: any }[] = [];
    t.mock.method(childProcess, 'spawn', (executable: string, args: readonly string[]) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill() {
          child.emit('exit', 0);
          child.emit('close', 0);
        },
      });
      calls.push({ executable, args, child });
      return child;
    });
    syncBuiltinESMExports();
    t.after(async () => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(directory, { recursive: true, force: true });
    });
    const errors: unknown[][] = [];
    t.mock.method(log, 'error', (...args: unknown[]) => {
      errors.push(args);
    });
    const registry = new NodeRegistry({
      privateKey: Buffer.alloc(32).toString('base64'),
      buildId: outcome === 'dev' ? 'dev' : 'a'.repeat(64),
      nodes: {
        local: {
          ...testNode('local'),
          configHash: 'hash',
          local: {
            root: directory,
            executable: join(directory, 'endpoint_service.exe'),
            versionDir: directory,
          },
        },
      },
    });
    t.after(() => registry.stop());
    registry.start();
    registry.start();
    assert.equal(calls.length, 1);
    if (outcome === 'dev') {
      assert.equal(calls[0].executable, join(directory, 'endpoint_service.exe'));
      assert.deepEqual(calls[0].args, ['--stdio', `--node-root=${directory}`]);
      return;
    }
    assert.equal(calls[0].executable, join(directory, 'bin/remotekit_node.exe'));
    assert.deepEqual(calls[0].args, ['install', `--root=${directory}`, `--package=${directory}`]);
    if (outcome === 'stopped') registry.stop();
    else calls[0].child.emit('close', outcome === 'success' ? 0 : 1);
    await new Promise((resolve) => setImmediate(resolve));
    if (outcome === 'success') {
      assert.equal(calls.length, 2);
      assert.equal(calls[1].executable, join(directory, 'endpoint_service.exe'));
    } else {
      assert.equal(calls.length, 1);
      if (outcome === 'failure') {
        assert.equal(registry.get('local')!.state.state, 'offline');
        assert.equal(errors[0][0], 'node.install_failed');
        assert.equal((errors[0][1] as { nodeId: string }).nodeId, 'local');
      }
    }
  });
}

test('local stdio shares authenticated handshake, encrypted RPCs and lost-reply certainty', async (t) => {
  const key = Buffer.alloc(32, 17);
  const registry = new NodeRegistry({
    privateKey: key.toString('base64'),
    buildId: 'dev',
    nodes: { local: { ...testNode('local'), configHash: 'local-hash' } },
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
  const handshake = new NoiseHandshake('initiator', nodePrivateKey('local'), publicKey(key));
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
  const fenced = once(child.stdin, 'data');
  const frameQueue = decoder.push((await fenced)[0]);
  const initial = decodeFrame(transport.receive.decrypt(frameQueue[0]));
  assert.equal(initial.kind, 'json');
  if (initial.kind !== 'json') throw Error('Expected fencing');
  assert.equal(initial.message.method, 'node.desired');
  child.stdout.write(
    encodeStdio(
      transport.send.encrypt(encodeJson({ id: initial.message.id, ok: true, result: { accepted: true } })),
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const link = registry.get('local')!;
  const outbound = once(child.stdin, 'data');
  const request = link.request('fixture.read', 'tenant');
  const frame = decodeFrame(transport.receive.decrypt(decoder.push((await outbound)[0])[0]));
  assert.equal(frame.kind, 'json');
  if (frame.kind !== 'json') throw new Error('Expected JSON');
  child.stdout.write(
    encodeStdio(
      transport.send.encrypt(
        encodeJson({ id: frame.message.id, opId: frame.message.opId, ok: true, result: { running: true } }),
      ),
    ),
  );
  assert.deepEqual(await request, { running: true });
  const written = once(child.stdin, 'data');
  const lost = assert.rejects(link.request('fixture.write', 'tenant'), { code: 'outcome_unknown' });
  await written;
  await new Promise((resolve) => setImmediate(resolve));
  child.emit('exit', 1);
  await lost;
  assert.equal(link.state.state, 'offline');
  child.stderr.write('endpoint stderr line\n');
  await new Promise((resolve) => setImmediate(resolve));
  await endpointLog.flush();
  assert.equal(await readFile(join(log, 'logs', 'endpoint.log'), 'utf8'), 'endpoint stderr line\n');
  registry.stop();
});
