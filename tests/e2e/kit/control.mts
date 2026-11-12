import { createApplication, startApplication } from '../../../control/server/application';
import { NodeRegistry } from '../../../control/server/cluster/node-link';
import { Placement } from '../../../control/server/cluster/placement';
import { loadRelease } from '../../../control/server/cluster/release';
import { runtimeConfig } from '../../../control/server/config';
import { EndpointGateway } from '../../../control/server/endpoint/gateway';
import { createHttp } from '../../../control/server/http/server';
import { configureLog, FileLogSink } from '../../../control/server/log';
import { open } from '../../../control/server/persistence/database';
const config = runtimeConfig();
configureLog(new FileLogSink(config.logDir));
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
const control = createApplication(
  store,
  gateway,
  undefined,
  clock,
  config.quotas.tenantObjectBytes,
  config.sessionImport,
);
const server = createHttp(control, {
  nodes,
  diagnosticDir: config.diagnosticDir,
  logDir: config.logDir,
  origins: [...config.origins],
  clientDir: config.clientDir,
});
const removed = nodes.isRemoved;
const paused = new Set<string>();
nodes.isRemoved = (id) => paused.has(id) || removed(id);
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
    if (message.method === 'down') {
      paused.add(message.nodeId);
      nodes.get(message.nodeId)!.evict();
      (nodes.get(message.nodeId) as any).child?.kill();
      await control.objects.tick();
      const other = nodes.all().find((node) => node.nodeId !== message.nodeId)!;
      if (message.exclusiveObject) {
        await other.request('object.delete', '', { ids: [message.exclusiveObject] });
        store.db
          .prepare('DELETE FROM object_replicas WHERE id=? AND node_id=?')
          .run(message.exclusiveObject, other.nodeId);
      }
      control.library.refreshAvailability(message.tenant);
      return { offline: true };
    }
    if (message.method === 'up') {
      paused.delete(message.nodeId);
      nodes.get(message.nodeId)!.start();
      return { starting: true };
    }
    if (message.method === 'seedFace') {
      const viewer = control.tenants.get(message.tenant).viewer!.security;
      await control.security.capabilities(message.tenant, viewer);
      const model = viewer.face.modelVersion!;
      const record = store.security.security(viewer.user.id);
      const template = Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0));
      record.face = {
        sealed: store.security.faceVault.seal(viewer.user.id, template, model),
        modelVersion: model,
      };
      record.settings.faceEnabled = true;
      store.security.saveSecurity(viewer.user.id, record);
      return { model };
    }
    if (message.method === 'stop') return control.userAdmin.stop(message.username);
    if (message.method === 'snapshots')
      return Promise.all(
        store.db
          .prepare('SELECT username,tenant FROM users')
          .all()
          .map(async (user: any) => ({
            username: user.username,
            state: control.viewers.productState(user.tenant),
            snapshot: await control.endpoint.snapshot(user.tenant, { outputDiagnostics: true }).catch(String),
          })),
      );
    if (message.method === 'advance') {
      elapsed += message.ms;
      await control.reconciler.tick();
      return { elapsed };
    }
    if (message.method === 'inspect') {
      return {
        services: [...(control.servicePeers as any).connections.values()].map((entry: any) => ({
          tenant: entry.tenant,
          nodeId: entry.node.nodeId,
          connectionId: entry.connectionId,
          epoch: entry.peer.epoch,
        })),
        nodes: control.nodeAdmin.list().map((node) => ({
          ...node,
          metrics: nodes.get(node.nodeId!)?.metrics.latest()?.value,
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
        checkpointObjects: store.db.prepare('SELECT tenant,manifest_id,id FROM checkpoint_objects').all(),
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
