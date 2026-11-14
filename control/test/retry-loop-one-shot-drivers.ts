import { Carrier, NodeRegistry } from '../server/cluster/node-link';
import { NoiseHandshake, publicKey, type Transport } from '../server/cluster/noise';
import { decodeFrame, encodeJson } from '../server/cluster/frames';
import { RateLimiter } from '../server/learning/providers/xinjiaoyu/rate-limiter';
import { testNode, nodePrivateKey } from './node-fixture';
import { operation, type OwnerFactory } from './retry-loop-boundary';

export const drivePacedQueue: OwnerFactory = (boundary) => {
  const owner = new RateLimiter({ concurrency: 1, minIntervalMs: 850, jitterMs: 0, maxRetries: 4 });
  const result = operation();
  const run = () =>
    result.run(() => owner.schedule(() => boundary.call({ job: boundary.version }, undefined)));
  return {
    start: run,
    drive: () => {},
    changeInput: () => {
      boundary.version++;
      run();
    },
    error: result.error,
    dispose: () => {},
  };
};

export const driveHandshake: OwnerFactory = (boundary) => {
  const key = Buffer.alloc(32, 17);
  class Native extends Carrier {
    readonly bufferedAmount = 0;
    transport?: Transport;
    handshake = new NoiseHandshake('initiator', nodePrivateKey('alpha'), publicKey(key));
    async send(bytes: Buffer) {
      if (!this.transport) {
        await boundary.call({ reply: 'node.ready' }, undefined);
        this.handshake.readMessage(bytes);
        this.transport = this.handshake.split();
        return;
      }
      const frame = decodeFrame(this.transport.receive.decrypt(bytes));
      if (frame.kind === 'json' && frame.message.method === 'node.desired')
        queueMicrotask(() =>
          this.emit(
            'message',
            this.transport!.send.encrypt(
              encodeJson({ id: frame.message.id, ok: true, result: { accepted: true } }),
            ),
          ),
        );
    }
    close() {
      this.emit('close');
    }
  }
  const owner = new NodeRegistry({
    privateKey: key.toString('base64'),
    buildId: 'dev',
    nodes: { alpha: testNode('alpha') },
    heartbeatTimeoutMs: 1e12,
  });
  let native: Native;
  const run = () => {
    native = new Native();
    owner.accept(native);
    native.emit(
      'message',
      native.handshake.writeMessage(
        Buffer.from(
          JSON.stringify({
            type: 'node.hello',
            role: 'endpoint',
            nodeId: 'alpha',
            buildId: 'dev',
            incarnation: 'a'.repeat(32),
          }),
        ),
      ),
    );
  };
  return {
    start: run,
    drive: () => {},
    changeInput: run,
    error: () => (native.isClosing ? { phase: 'closed' } : undefined),
    dispose: () => owner.stop(),
  };
};
