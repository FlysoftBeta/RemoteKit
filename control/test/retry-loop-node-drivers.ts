import { Carrier, NodeRegistry } from '../server/cluster/node-link';
import { NoiseHandshake, publicKey, type Transport } from '../server/cluster/noise';
import { decodeFrame, encodeJson } from '../server/cluster/frames';
import { testNode, nodePrivateKey } from './node-fixture';
import { wireError, toRemoteKitError } from '../shared/errors';
import { operation, settle, type OwnerFactory } from './retry-loop-boundary';

class MemoryCarrier extends Carrier {
  readonly bufferedAmount = 0;
  onSend?: (bytes: Buffer) => Promise<void>;
  send(bytes: Buffer) {
    return this.onSend?.(bytes) ?? Promise.resolve();
  }
  close() {
    this.emit('close');
  }
}

export const driveNodeCoordination: OwnerFactory = (boundary) => {
  const key = Buffer.alloc(32, 17);
  const owner = new NodeRegistry({
    nodes: { alpha: testNode('alpha') },
    buildId: 'dev',
    privateKey: key.toString('base64'),
    heartbeatTimeoutMs: 1e12,
  });
  owner.fencing = () => [
    { tenantId: 'tenant', sessionId: 'a'.repeat(32), placementEpoch: boundary.version, dataState: 'dirty' },
  ];
  const carrier = new MemoryCarrier();
  const handshake = new NoiseHandshake('initiator', nodePrivateKey('alpha'), publicKey(key));
  let transport: Transport | undefined;
  carrier.onSend = async (bytes) => {
    if (!transport) {
      handshake.readMessage(bytes);
      transport = handshake.split();
      return;
    }
    const frame = decodeFrame(transport.receive.decrypt(bytes));
    if (frame.kind !== 'json' || frame.message.method !== 'node.desired') return;
    const { id, ...document } = frame.message;
    void boundary.call(document, { accepted: true }).then(
      (result) => carrier.emit('message', transport!.send.encrypt(encodeJson({ id, ok: true, result }))),
      (cause: unknown) =>
        carrier.emit(
          'message',
          transport!.send.encrypt(encodeJson({ id, ok: false, error: wireError(toRemoteKitError(cause)) })),
        ),
    );
  };
  const result = operation();
  const link = owner.get('alpha')!;
  return {
    start: async () => {
      owner.accept(carrier);
      carrier.emit(
        'message',
        handshake.writeMessage(
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
      await settle();
      result.run(() => link.coordinate());
    },
    drive: () => result.run(() => link.coordinate()),
    changeInput: () => {
      boundary.version++;
      result.run(() => link.coordinate());
    },
    error: () => link.history().coordinationError,
    dispose: () => owner.stop(),
  };
};
