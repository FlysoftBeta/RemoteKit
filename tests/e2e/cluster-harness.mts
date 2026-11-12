import { runtimeConfig } from '../../control/server/config';
import { NodeRegistry } from '../../control/server/cluster/node-link';
import { Placement } from '../../control/server/cluster/placement';
import { loadRelease } from '../../control/server/cluster/release';
import { EndpointGateway } from '../../control/server/endpoint/gateway';
import { open } from '../../control/server/persistence/database';
import { createApplication, startApplication } from '../../control/server/application';
import { createHttp } from '../../control/server/http/server';

const config = runtimeConfig();
const store = open(config.dbPath, { buildId: config.buildId });
const nodes = new NodeRegistry({
  nodes: config.nodes,
  privateKey: config.identity.privateKey,
  buildId: config.buildId,
  release: loadRelease(config.root, config.buildId),
});
let elapsed = 0;
const clock = {
  monotonicMs: () => performance.now() + elapsed,
  wallMs: () => Date.now(),
};
const gateway = new EndpointGateway(nodes, new Placement(store, nodes));
const control = createApplication(store, gateway, undefined, clock);
const server = createHttp(control, {
  nodes,
  origins: [...config.origins],
  clientDir: config.clientDir,
});
const notify = (message: object) => {
  if (process.connected) process.send?.(message, () => {});
};
startApplication(config, store, nodes, control, server);
nodes.on('ready', (identity) =>
  notify({
    event: 'node.ready',
    ...identity,
    buildId: nodes.get(identity.nodeId)?.buildId,
  }),
);
nodes.on('offline', (nodeId) => notify({ event: 'node.offline', nodeId }));
const locate = nodes.handlers.get('object.locate')!;
nodes.handlers.set('object.locate', (node, request) => {
  notify({ event: 'object.locate', nodeId: node.nodeId, request });
  return locate(node, request);
});
process.on('message', (message: any) => {
  void (async () => {
    if (message.method === 'advance') {
      elapsed += message.ms;
      await control.reconciler.tick();
      return { elapsed };
    }
    if (message.method === 'stop') return control.userAdmin.stop(message.username);
    if (message.method === 'inspect') {
      return {
        nodes: control.nodeAdmin.list().map((node) => ({
          ...node,
          metrics: nodes.get(node.nodeId)?.metrics.latest()?.value,
        })),
        observations: Object.fromEntries(
          store.db
            .prepare('SELECT tenant FROM session_placements')
            .all()
            .map((row: any) => [row.tenant, gateway.observation(row.tenant)]),
        ),
        users: store.db.prepare('SELECT username,tenant FROM users').all(),
        placements: store.db
          .prepare(
            'SELECT tenant,session_id,node_id,placement_epoch,run_state,data_state,pending_commit,checkpoint_id FROM session_placements',
          )
          .all(),
        checkpoints: store.db.prepare('SELECT * FROM checkpoints').all(),
        replicas: store.db.prepare('SELECT * FROM object_replicas').all(),
        runtimes: control.tenants.values().map((runtime) => ({
          tenant: runtime.tenantId,
          viewer: !!runtime.viewer,
          started: runtime.started,
          error: runtime.lastError,
        })),
      };
    }
    if (message.method === 'evict') {
      // Retain the catalog entry so background replication cannot race the demand read.
      await nodes.get(message.nodeId)!.request('object.delete', message.tenant, { ids: [message.objectId] });
      return { evicted: true };
    }
    if (message.method === 'storageImport') {
      const result = await gateway.storageImport(message.tenant, message.params);
      if (message.loseReply) throw Error('outcome_unknown: forced lost begin reply after admission');
      return result;
    }
    if (message.method === 'storageImportStatus')
      return gateway.storageImportStatus(message.tenant, message.params);
    throw Error('Unknown harness command');
  })().then(
    (result) =>
      notify({
        id: message.id,
        result: JSON.parse(
          JSON.stringify(result, (_, value) => (typeof value === 'bigint' ? Number(value) : value)),
        ),
      }),
    (error) => notify({ id: message.id, error: `${error.code ? error.code + ': ' : ''}${String(error)}` }),
  );
});
