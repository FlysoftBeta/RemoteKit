import assert from 'node:assert/strict';
import test from 'node:test';
import { IdlePolicy } from '../client/auth/idle-policy';
import type { AuthState } from '../shared/security';

test('idle policy tracks activity, hidden locking and disposal outside React', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { hidden: false });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const locks: string[] = [];
  const policy = new IdlePolicy((reason) => locks.push(reason));
  t.after(() => {
    policy.dispose();
    for (const [name, descriptor] of [
      ['window', originalWindow],
      ['document', originalDocument],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  const auth = {
    locked: false,
    settings: { lockOnIdle: true, idleSeconds: 5, lockOnHidden: true },
  } as AuthState;
  policy.configure(auth);
  now = 4000;
  t.mock.timers.tick(4000);
  assert.deepEqual(locks, []);
  window.dispatchEvent(new Event('keydown'));
  now = 8000;
  t.mock.timers.tick(4000);
  assert.deepEqual(locks, []);
  now = 9000;
  t.mock.timers.tick(1000);
  assert.deepEqual(locks, ['idle']);
  document.hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(locks, ['idle', 'hidden']);
  policy.configure({ ...auth, locked: true });
  document.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(locks, ['idle', 'hidden']);
  policy.dispose();
  now = 20000;
  t.mock.timers.tick(11000);
  assert.deepEqual(locks, ['idle', 'hidden']);
});
