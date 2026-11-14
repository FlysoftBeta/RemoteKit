import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { attachViewerSocket } from '../server/http/viewer-socket';
import type { DomainServices } from '../server/application';
import { settle, type OwnerFactory } from './retry-loop-boundary';

export function driveViewerServer(path: 'face' | 'heartbeat'): OwnerFactory {
  return (boundary, t) => {
    const server = new EventEmitter();
    const socket = Object.assign(new EventEmitter(), {
      readyState: 1,
      bufferedAmount: 0,
      send() {},
      close() {
        socket.emit('close');
      },
      terminate() {
        socket.emit('close');
      },
      ping() {
        socket.emit('pong');
      },
    });
    t.mock.method(WebSocketServer.prototype, 'handleUpgrade', ((
      _request: unknown,
      _socket: unknown,
      _head: unknown,
      callback: (ws: unknown) => void,
    ) => callback(socket)) as never);
    let armed = false;
    const control = {
      events: new EventEmitter(),
      accounts: {
        identity: () =>
          armed && path === 'heartbeat'
            ? boundary.callSync({ token: 'token' }, { tenantId: 'tenant' })
            : { tenantId: 'tenant' },
      },
      viewers: {
        attachViewer: async () => {},
        detachViewer: async () => {},
        productEpoch: () => boundary.version,
        pollFaceAuth: () =>
          path === 'face' ? boundary.call({ poll: 'face' }, undefined) : Promise.resolve(),
        productAllowed: () => true,
      },
    } as unknown as DomainServices;
    const callbacks = new Map<number, () => void>();
    const interval = setInterval;
    t.mock.method(globalThis, 'setInterval', (callback: () => void, ms: number) => {
      callbacks.set(ms, callback);
      return interval(callback, ms);
    });
    const owner = attachViewerSocket(
      control,
      server as Server,
      {},
      {
        firstViewer: new Map(),
        checkOrigin() {},
        readToken: () => 'token',
        authenticationIdentity: () => 'identity',
        track: (promise) => promise,
        isClosing: () => false,
      },
    );
    server.emit(
      'upgrade',
      { url: '/api/socket', headers: { origin: 'http://localhost', host: 'localhost' }, socket: {} },
      {},
      Buffer.alloc(0),
    );
    const run = () => {
      callbacks.get(path === 'face' ? 500 : 30000)!();
    };
    return {
      start: () => {
        armed = true;
        run();
      },
      drive: run,
      changeInput: () => {
        boundary.version++;
        run();
      },
      error: () => owner.failures()[0],
      dispose: async () => {
        armed = false;
        owner.close();
        await settle();
      },
    };
  };
}
