import { OperationsStore } from '../client/control/operations-store';
import { productSnapshot } from './client-fixture';
import { operation, type OwnerFactory } from './retry-loop-boundary';

export function driveOperations(path: 'submission' | 'query' | 'readiness'): OwnerFactory {
  return (boundary) => {
    const owner = new OperationsStore({
      ready: () => (path === 'readiness' ? boundary.callSync({ ready: boundary.version }, true) : true),
      submit: (request) =>
        path === 'readiness'
          ? Promise.resolve({ ...request, status: 'committed', revision: 0 })
          : path === 'submission'
            ? boundary.call(
                { method: 'submit', operation: request },
                { ...request, status: 'committed', revision: 0 },
              )
            : Promise.resolve({ ...request, status: 'unknown' }),
      status: (request) =>
        boundary.call(
          { method: 'status', operation: request },
          { ...request, status: 'committed', revision: 0 },
        ),
    });
    const result = operation();
    const begin = () => {
      owner.acceptSnapshot(productSnapshot());
      result.run(() => owner.action({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } }));
    };
    return {
      start: begin,
      drive: () => {},
      changeInput: () => {
        owner.reset();
        begin();
      },
      error: () => owner.getSnapshot().error,
      dispose: () => owner.reset(),
    };
  };
}
