import { EventEmitter } from 'node:events';
import { ObjectIndex } from '../server/cluster/objects';
import { ControlDatabase } from '../server/persistence/database';
import type { NodeLink, NodeRegistry } from '../server/cluster/node-link';
import type { OwnerFactory } from './retry-loop-boundary';

export function driveObjects(
  path: 'inventory' | 'gc' | 'relief' | 'replica' | 'render' | 'maintenance',
): OwnerFactory {
  return (boundary, t) => {
    const store = new ControlDatabase(':memory:', { buildId: 'test' });
    const source = 'a'.repeat(64),
      document = 'b'.repeat(64);
    let owner: ObjectIndex;
    let relieved = false;
    const selected = {
      inventory: 'object.inventory',
      gc: 'object.delete',
      relief: 'session.cold.delete',
      replica: 'object.fetch',
      render: 'object.render',
      maintenance: '',
    }[path];
    const nodes = ['alpha', 'beta'].slice(0, path === 'replica' ? 2 : 1).map((nodeId) => {
      const node = {
        nodeId,
        state: { state: 'ready', connectionEpoch: 'epoch' },
        diskDraining: path === 'relief',
        config: { peer: { address: nodeId } },
        limits: { diskReserveBytes: 1 },
        metrics: {
          latest: () => ({
            pressure: 0,
            value: { disk: { total: 1e12, free: path === 'relief' && !relieved ? 0 : 1e12 } },
          }),
        },
        async request(
          method: string,
          _tenant: string,
          fields: unknown,
          _timeout?: unknown,
          identity?: string,
        ) {
          if (method === selected) await boundary.call({ nodeId, method, fields, identity }, undefined);
          if (method === 'session.cold.delete') relieved = true;
          if (method === 'object.inventory') return { objects: [], next: null };
          if (method === 'object.fetch')
            store.db.prepare('INSERT OR IGNORE INTO object_replicas VALUES (?,?)').run(source, nodeId);
          if (method === 'object.render') {
            owner.committed(node as unknown as NodeLink, {
              objectId: document,
              size: 20,
              storedSize: 20,
              storedSha256: document,
              derivedFrom: source,
              kind: 'document',
            });
            return { documentId: document };
          }
          return {};
        },
      };
      return node;
    });
    const registry = Object.assign(new EventEmitter(), {
      handlers: new Map(),
      all: () => nodes,
      get: (id: string) => nodes.find((node) => node.nodeId === id),
      isRemoved: () => false,
      options: { buildId: 'test' },
    }) as unknown as NodeRegistry;
    owner = new ObjectIndex(
      store,
      registry,
      null,
      () => true,
      () => false,
    );
    if (path === 'maintenance') {
      const prepare = store.db.prepare.bind(store.db);
      t.mock.method(store.db, 'prepare', (sql: string) =>
        sql.startsWith('DELETE FROM checkpoints WHERE')
          ? boundary.callSync({ sql }, prepare(sql))
          : prepare(sql),
      );
    }
    if (path !== 'inventory' && path !== 'relief') {
      store.db.prepare('INSERT INTO objects VALUES (?,?,?,?,?)').run(source, 10, 10, source, 0);
      store.db.prepare('INSERT INTO object_replicas VALUES (?,?)').run(source, 'alpha');
      if (path !== 'gc')
        store.db.prepare('INSERT INTO object_claims VALUES (?,?,?)').run('tenant', source, Date.now());
    }
    const run = () => {
      if (path === 'replica' || path === 'render')
        store.db.prepare('UPDATE object_claims SET claimed_at=? WHERE id=?').run(Date.now(), source);
      if (path === 'inventory') registry.emit('ready', { nodeId: 'alpha' });
      else if (path === 'gc') return owner.gc();
      else if (path === 'render') owner.render(source);
      else if (path === 'replica') return owner.replicate();
      else return owner.tick();
    };
    return {
      start: run,
      drive: run,
      changeInput: () => {
        relieved = false;
        registry.options.buildId = 'changed';
        for (const node of nodes) node.state.connectionEpoch = 'changed';
        nodes[0].diskDraining = path === 'relief';
        return run();
      },
      error: () => owner.failures()[0]?.error,
      dispose: async () => {
        await owner.close();
        store.db.close();
      },
    };
  };
}
