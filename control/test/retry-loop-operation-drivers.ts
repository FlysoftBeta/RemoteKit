import { buildAction } from '../client/control/action-builder';
import { OperationsStore } from '../client/control/operations-store';
import { productSnapshot } from './client-fixture';
import { operation, type OwnerFactory } from './retry-loop-boundary';

export function driveOperations(path: 'submission' | 'query' | 'readiness' | 'dependency'): OwnerFactory {
  return (boundary) => {
    const owner = new OperationsStore({
      ready: () => (path === 'readiness' ? boundary.callSync({ ready: boundary.version }, true) : true),
      submit: (request) =>
        path === 'readiness'
          ? Promise.resolve({ ...request, status: 'committed', revision: 0 })
          : path === 'submission' || (path === 'dependency' && request.action.type === 'window.open')
            ? boundary.call(
                { method: 'submit', operation: request },
                { ...request, status: 'committed', revision: 0 },
              )
            : Promise.resolve({ ...request, status: path === 'dependency' ? 'committed' : 'unknown' }),
      status: (request) =>
        boundary.call(
          { method: 'status', operation: request },
          { ...request, status: 'committed', revision: 0 },
        ),
    });
    const result = operation();
    const begin = () => {
      owner.acceptSnapshot(productSnapshot());
      result.run(async () => {
        const action = buildAction({ type: 'window.open', appId: 'browser', placement: { mode: 'space' } });
        const creator = owner.action(action);
        if (path !== 'dependency') return creator;
        return Promise.all([
          creator,
          owner.action({ type: 'window.state', windowId: action.windowId, state: { section: 'home' } }),
        ]);
      });
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
