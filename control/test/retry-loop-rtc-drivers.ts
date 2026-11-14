import { RtcSession } from '../client/rtc/rtc-session';
import { RemoteKitError } from '../shared/errors';
import { operation, settle, type OwnerFactory } from './retry-loop-boundary';

export function driveRtc(role: 'browser' | 'service', path: 'offer' | 'status' = 'offer'): OwnerFactory {
  return (boundary) => {
    let serial = 0;
    class Peer {
      localDescription?: RTCSessionDescriptionInit;
      connectionState = 'new';
      signalingState = 'stable';
      iceConnectionState = 'new';
      onconnectionstatechange?: () => void;
      readonly serial = ++serial;
      addTransceiver() {
        return { receiver: {} };
      }
      createDataChannel(label: string) {
        return { label };
      }
      async createOffer() {
        return { type: 'offer' as const, sdp: `v=0\r\ns=peer-${this.serial}\r\n` };
      }
      async setLocalDescription(description: RTCSessionDescriptionInit) {
        this.localDescription = description;
      }
      async setRemoteDescription() {
        this.connectionState = 'connected';
        queueMicrotask(() => this.onconnectionstatechange?.());
      }
      async addIceCandidate() {}
      close() {
        this.signalingState = 'closed';
      }
    }
    const restore: (() => void)[] = [];
    for (const [name, value] of Object.entries({
      navigator: { userAgent: 'Chrome/89.0' },
      window: { devicePixelRatio: 1, screen: { width: 1600, height: 900 } },
      RTCPeerConnection: Peer,
      RTCRtpReceiver: { getCapabilities: () => ({ codecs: [] }) },
    })) {
      const previous = Object.getOwnPropertyDescriptor(globalThis, name);
      Object.defineProperty(globalThis, name, { configurable: true, value });
      restore.push(() => {
        if (previous) Object.defineProperty(globalThis, name, previous);
        else Reflect.deleteProperty(globalThis, name);
      });
    }
    const owner = new RtcSession(role);
    let primed = path !== 'status';
    const answer = {
      type: 'answer',
      sdp: 'v=0\r\n',
      connectionId: 'connection',
      endpointGeneration: 1,
      avSync: false,
    };
    owner.setControlRpc(async (method, params) => {
      if (method.endsWith('.offer') && !primed) {
        primed = true;
        throw new RemoteKitError('outcome_unknown', 'prime status reconciliation');
      }
      if (method.endsWith('.offer') || method.endsWith('.offerStatus')) {
        return boundary.call(
          { method, params },
          method.endsWith('.offerStatus') ? { state: 'ready', answer } : answer,
        );
      }
      return {};
    });
    const result = operation();
    return {
      start: async () => {
        result.run(() => owner.connect());
        await settle();
      },
      drive: () => {},
      changeInput: async () => {
        primed = path !== 'status';
        owner.restart('changed input');
        await settle();
      },
      error: () => {
        const state = owner.getSnapshot();
        return 'error' in state ? state.error : undefined;
      },
      dispose: async () => {
        owner.disconnect();
        await settle();
        for (const reset of restore) reset();
      },
    };
  };
}
