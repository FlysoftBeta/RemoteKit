import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { NodeRegistry } from '../server/cluster/node-link';
import { NoiseHandshake, publicKey, type Transport } from '../server/cluster/noise';
import { decodeFrame, encodeJson, encodeStdio, StdioDecoder } from '../server/cluster/frames';
import { testNode, nodePrivateKey } from './node-fixture';
import type { OwnerFactory } from './retry-loop-boundary';

export const driveLaunch: OwnerFactory = (boundary, t) => {
  const key = Buffer.alloc(32, 17);
  const directory = fileURLToPath(new URL('../../develop/tmp/t7c-matrix/launch', import.meta.url));
  const configured = {
    ...testNode('local'),
    local: { root: directory, executable: 'endpoint_service.exe', versionDir: directory },
  };
  const owner = new NodeRegistry({
    privateKey: key.toString('base64'),
    buildId: 'a'.repeat(64),
    nodes: { local: configured },
    heartbeatTimeoutMs: 1e12,
  });
  const spawn = t.mock.method(childProcess, 'spawn', (executable: string, args: readonly string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {
        child.emit('exit', 0);
        child.emit('close', 0);
      },
    });
    if (executable.endsWith('remotekit_node.exe')) {
      boundary.callSync({ executable, args }, undefined);
      queueMicrotask(() => child.emit('close', 0));
    } else {
      const handshake = new NoiseHandshake('initiator', nodePrivateKey('local'), publicKey(key));
      let transport: Transport | undefined;
      const decoder = new StdioDecoder();
      child.stdin.on('data', (bytes: Buffer) => {
        for (const frame of decoder.push(bytes)) {
          if (!transport) {
            handshake.readMessage(frame);
            transport = handshake.split();
            continue;
          }
          const message = decodeFrame(transport.receive.decrypt(frame));
          if (message.kind === 'json' && message.message.method === 'node.desired')
            queueMicrotask(() =>
              child.stdout.write(
                encodeStdio(
                  transport!.send.encrypt(
                    encodeJson({ id: message.message.id, ok: true, result: { accepted: true } }),
                  ),
                ),
              ),
            );
        }
      });
      queueMicrotask(() =>
        child.stdout.write(
          encodeStdio(
            handshake.writeMessage(
              Buffer.from(
                JSON.stringify({
                  type: 'node.hello',
                  role: 'endpoint',
                  nodeId: 'local',
                  buildId: owner.options.buildId,
                  incarnation: 'a'.repeat(32),
                }),
              ),
            ),
          ),
        ),
      );
    }
    return child;
  });
  syncBuiltinESMExports();
  return {
    start: () => owner.start(),
    drive: () => owner.start(),
    changeInput: () => {
      owner.options.buildId = 'b'.repeat(64);
      owner.start();
    },
    error: () => owner.get('local')!.history().launchError,
    dispose: () => {
      owner.stop();
      spawn.mock.restore();
      syncBuiltinESMExports();
    },
  };
};
