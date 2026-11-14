import { ApplicationBackground, type DomainServices } from '../server/application';
import type { NodeRegistry } from '../server/cluster/node-link';
import type { OwnerFactory } from './retry-loop-boundary';

export function driveApplication(
  path: 'reconciler' | 'objects' | 'servicePeers' | 'endpointReady',
): OwnerFactory {
  return (boundary) => {
    const work = (name: string) =>
      path === name ? boundary.call({ job: name }, undefined) : Promise.resolve();
    const node = { nodeId: 'node', state: { state: 'ready', connectionEpoch: 1 } };
    const control = {
      reconciler: { tick: () => work('reconciler'), endpointReady: () => work('endpointReady') },
      objects: { tick: () => work('objects') },
      servicePeers: { tick: () => work('servicePeers') },
      library: { endpointReady: () => {} },
    };
    const owner = new ApplicationBackground(
      control as unknown as DomainServices,
      { all: () => [node], get: () => node } as unknown as NodeRegistry,
    );
    const run = () =>
      path === 'endpointReady'
        ? owner.endpointReady({ nodeId: 'node', processChanged: false })
        : owner.tick();
    return {
      start: run,
      drive: run,
      changeInput: () => {
        node.state.connectionEpoch++;
        return run();
      },
      error: () => owner.failures()[0]?.error,
      dispose: () => owner.close(),
    };
  };
}
