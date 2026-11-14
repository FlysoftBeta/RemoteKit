import { JSDOM } from 'jsdom';
import { PresentationSession } from '../client/presentation/presentation-session';
import type { OwnerFactory } from './retry-loop-boundary';

export function drivePresentation(path: 'negotiation' | 'metadata'): OwnerFactory {
  return (boundary, t) => {
    t.mock.method(performance, 'now', () => Date.now());
    const dom = new JSDOM('', { pretendToBeVisual: true });
    const restore: (() => void)[] = [];
    Object.defineProperty(dom.window.HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      value: () => 1,
    });
    for (const [name, value] of Object.entries({ document: dom.window.document, ResizeObserver: class {} })) {
      const previous = Object.getOwnPropertyDescriptor(globalThis, name);
      Object.defineProperty(globalThis, name, { configurable: true, value });
      restore.push(() => {
        if (previous) Object.defineProperty(globalThis, name, previous);
        else Reflect.deleteProperty(globalThis, name);
      });
    }
    let owner: PresentationSession;
    const channel = { readyState: 'open', bufferedAmount: 0 } as RTCDataChannel;
    const ports = {
      endpoint: {
        channel,
        sendChannel: (_channel: unknown, message: { type: string }) => {
          if (
            (path === 'negotiation' && message.type === 'media.presentation') ||
            (path === 'metadata' && message.type === 'media.refresh')
          )
            boundary.callSync(message, undefined);
          if (message.type === 'media.presentation')
            owner.handle({ type: 'presentation.mode', version: 1, backend: 'video' });
        },
      },
      rtc: { peer: {} as RTCPeerConnection, attempt: 1, markConnection() {} },
      authorization: { productLocked: false, peerAuthEpoch: 1, browserReady: true },
    };
    owner = new PresentationSession(ports as never);
    const refresh = () => dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
    const begin = () => {
      owner.onChannel({ type: 'open' } as never);
      if (path === 'metadata') refresh();
    };
    return {
      start: begin,
      drive: path === 'metadata' ? refresh : () => {},
      changeInput: () => {
        ports.rtc.attempt++;
        ports.authorization.peerAuthEpoch++;
        owner.reset();
        begin();
      },
      error: () => owner.failure,
      dispose: () => {
        owner.reset();
        dom.window.close();
        restore.forEach((reset) => reset());
      },
    };
  };
}
