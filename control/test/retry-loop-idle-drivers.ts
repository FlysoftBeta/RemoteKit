import { IdlePolicy } from '../client/auth/idle-policy';
import type { AuthState } from '../shared/security';
import type { OwnerFactory } from './retry-loop-boundary';

export const driveIdle: OwnerFactory = (boundary) => {
  class Detector extends EventTarget {
    userState = 'active';
    screenState = 'unlocked';
    static requestPermission() {
      return Promise.resolve('granted' as const);
    }
    start(options: { threshold: number }) {
      return boundary.call({ threshold: options.threshold }, undefined);
    }
  }
  const permission = Object.assign(new EventTarget(), { state: 'granted' });
  const restore: (() => void)[] = [];
  for (const [name, value] of Object.entries({
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), { hidden: false }),
    navigator: { permissions: { query: async () => permission } },
    IdleDetector: Detector,
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    restore.push(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const owner = new IdlePolicy(() => {});
  return {
    start: () =>
      owner.configure({ locked: false, settings: { lockOnIdle: true, idleSeconds: 600 } } as AuthState),
    drive: () => {},
    changeInput: () => owner.requestSystem(),
    error: () => owner.failure,
    dispose: () => {
      owner.dispose();
      for (const reset of restore) reset();
    },
  };
};
