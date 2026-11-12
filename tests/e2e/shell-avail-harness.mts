import { runtimeConfig } from '../../control/server/config';
import { NodeRegistry } from '../../control/server/cluster/node-link';
import { Placement } from '../../control/server/cluster/placement';
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
});
const gateway = new EndpointGateway(nodes, new Placement(store, nodes));
const control = createApplication(store, gateway);
const server = createHttp(control, { nodes, origins: [...config.origins], clientDir: config.clientDir });
const removed = nodes.isRemoved;
const paused = new Set<string>();
nodes.isRemoved = (id) => paused.has(id) || removed(id);
startApplication(config, store, nodes, control, server);
const notify = (message: object) => {
  if (process.connected) process.send?.(message, () => {});
};
const locate = nodes.handlers.get('object.locate')!;
nodes.handlers.set('object.locate', (node, request) => {
  notify({ event: 'object.locate', nodeId: node.nodeId, request });
  return locate(node, request);
});
process.on('message', (message: any) => {
  void (async () => {
    if (message.method === 'inspect')
      return {
        nodes: nodes
          .all()
          .map((node) => ({ nodeId: node.nodeId, state: node.state, metrics: node.metrics.latest()?.value })),
        placements: store.db.prepare('SELECT * FROM session_placements').all(),
        replicas: store.db.prepare('SELECT * FROM object_replicas').all(),
        services: [...(control.servicePeers as any).connections.values()].map((entry: any) => ({
          tenant: entry.tenant,
          nodeId: entry.node.nodeId,
          connectionId: entry.connectionId,
          epoch: entry.peer.epoch,
        })),
        users: store.db.prepare('SELECT id,username,tenant FROM users').all(),
      };
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
    throw Error('Unknown shell availability harness command');
  })().then(
    (result) =>
      notify({
        id: message.id,
        result: JSON.parse(
          JSON.stringify(result, (_, value) => (typeof value === 'bigint' ? Number(value) : value)),
        ),
      }),
    (error) => notify({ id: message.id, error: String(error.stack ?? error) }),
  );
});
