import { MediaObservations } from '../client/media/observations';
import type { OwnerFactory } from './retry-loop-boundary';

export function driveMediaClock(path: 'control' | 'endpoint'): OwnerFactory {
  return (boundary, t) => {
    t.mock.method(performance, 'now', () => Date.now());
    const document = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { visibilityState: 'visible' },
    });
    let owner: MediaObservations;
    const peer = { getStats: async () => new Map(), getReceivers: () => [] } as unknown as RTCPeerConnection;
    const ports = {
      rtc: {
        peer,
        attempt: 1,
        controlRpc: (method: string, input: unknown) =>
          method === 'clock.ping' ? boundary.call(input, { serverTime: Date.now() }) : Promise.resolve({}),
      },
      authorization: { productLocked: false, peerAuthEpoch: 1 },
      endpoint: {
        channel: path === 'endpoint' ? { readyState: 'open', bufferedAmount: 0 } : null,
        sendChannel: (_channel: unknown, input: { requestId: string }) => {
          boundary.callSync(input, undefined);
          owner.handle({
            type: 'clock.pong',
            requestId: input.requestId,
            serverTimeMs: Date.now(),
            serverMonotonicMs: Date.now(),
          } as never);
        },
      },
      presentation: {
        sampleVideoWindows: () => [],
        currentVideoWindows: () => [],
        getRenderingDiagnostics: () => ({}),
        layout: null,
      },
      input: { inputTrace: [], inputResults: [] },
    };
    owner = new MediaObservations(ports as never);
    const run = () => (path === 'endpoint' ? owner.sampleEndpointClock() : owner.readStats(peer));
    return {
      start: run,
      drive: run,
      changeInput: () => {
        ports.rtc.attempt++;
        owner.reset();
        return run();
      },
      error: () => owner.failures()[0],
      dispose: () => {
        owner.reset();
        if (document) Object.defineProperty(globalThis, 'document', document);
        else Reflect.deleteProperty(globalThis, 'document');
      },
    };
  };
}
