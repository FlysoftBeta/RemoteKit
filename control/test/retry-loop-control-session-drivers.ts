import { ControlSession } from '../client/control/control-session';
import { httpStatus } from '../shared/errors';
import { productSnapshot } from './client-fixture';
import { settle, type OwnerFactory } from './retry-loop-boundary';

export const driveControlSession: OwnerFactory = (boundary, t) => {
  t.mock.method(performance, 'now', () => Date.now());
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number }) => void;
    constructor(url: string) {
      void boundary.call({ url }, undefined).then(
        () => {
          this.readyState = 1;
          this.onopen?.();
          this.onmessage?.({ data: JSON.stringify({ type: 'auth', auth: { locked: false } }) });
          this.onmessage?.({ data: JSON.stringify({ type: 'state', state: productSnapshot() }) });
        },
        () => {
          this.readyState = 3;
          this.onclose?.({ code: 1006 });
        },
      );
    }
    send() {}
    close() {
      this.readyState = 3;
      this.onclose?.({ code: 1000 });
    }
  }
  const restore: (() => void)[] = [];
  for (const [name, value] of Object.entries({
    WebSocket: Socket,
    location: { protocol: 'http:', host: 'localhost', origin: 'http://localhost' },
    fetch: async () =>
      new Response(
        JSON.stringify(
          boundary.code
            ? {
                error: {
                  code: boundary.code,
                  message: 'injected auth probe',
                  errorId: 'e-0123456789',
                  retryAfterMs: boundary.retryAfterMs,
                },
              }
            : {},
        ),
        { status: boundary.code ? httpStatus[boundary.code] : 200 },
      ),
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    restore.push(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const create = () =>
    new ControlSession(
      () => {},
      () => {},
    );
  let owner = create();
  return {
    start: () => owner.connect(),
    drive: () => {},
    changeInput: () => {
      if (owner.getSnapshot().phase === 'expired') {
        owner.close();
        owner = create();
        owner.connect();
      } else owner.reconnect();
    },
    error: () => owner.error,
    dispose: async () => {
      owner.close();
      await settle();
      for (const reset of restore) reset();
    },
  };
};
