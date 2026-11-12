import type { ProductState } from '../shared/product';
import { OperationsStore } from './control/operations-store';
import { showFailureScene } from './failures/test-scenes';
import { installLearningMock } from './test-hooks-learning';

if (import.meta.env.DEV && new URLSearchParams(location.search).has('learningMock')) installLearningMock();

declare global {
  interface Window {
    __remotekitTest: {
      state(): ProductState | null;
      unlock(): Promise<void>;
      failures: typeof showFailureScene;
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
  failures: showFailureScene,
  state: () => JSON.parse(JSON.stringify(operations?.getSnapshot().authoritative ?? null)),
  async unlock() {
    // RevealScreen owns the pattern and its completed-pattern action. Authentication
    // still goes through UnlockView, using the scenario's seeded credentials.
    for (const direction of ['Up', 'Up', 'Down', 'Down', 'Left', 'Right', 'Left', 'Right']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: `Arrow${direction}`, cancelable: true }));
    }
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
  },
};

import.meta.hot?.dispose(() => {
  OperationsStore.prototype.acceptSnapshot = acceptSnapshot;
  delete (window as Partial<Window>).__remotekitTest;
});
