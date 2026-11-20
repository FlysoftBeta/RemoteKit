import type { ProductState } from '../shared/product';
import { OperationsStore } from './control/operations-store';
import { showFailureScene } from './failures/test-scenes';
import { installLearningMock } from './test-hooks-learning';
import { geometryTest } from './test-hooks-geometry';
import type { ProductAction } from '../shared/product';

if (import.meta.env.DEV && new URLSearchParams(location.search).has('learningMock')) installLearningMock();

declare global {
  interface Window {
    __remotekitTest: {
      state(): ProductState | null;
      unlock(): Promise<void>;
      failures: typeof showFailureScene;
      geometry: typeof geometryTest;
      action(action: ProductAction): Promise<unknown>;
    };
  }
}

let operations: OperationsStore | undefined;
const acceptSnapshot = OperationsStore.prototype.acceptSnapshot;
OperationsStore.prototype.acceptSnapshot = function (state) {
  operations = this;
  return acceptSnapshot.call(this, state);
};

window.__remotekitTest = {
  geometry: geometryTest,
  action: (action) => operations!.action(action),
  failures: showFailureScene,
  state: () => JSON.parse(JSON.stringify(operations?.getSnapshot().authoritative ?? null)),
  async unlock() {
    // LockScreen owns the reveal gesture. Authentication still goes through UnlockView,
    // using the scenario's seeded credentials.
    for (let press = 0; press < 5; press++)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
  },
};

import.meta.hot?.dispose(() => {
  OperationsStore.prototype.acceptSnapshot = acceptSnapshot;
  delete (window as Partial<Window>).__remotekitTest;
});
