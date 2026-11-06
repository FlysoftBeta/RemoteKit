import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeConfig } from '../../control/server/config.ts';
import { NodeRegistry } from '../../control/server/cluster/node-link.ts';
import { Placement } from '../../control/server/cluster/placement.ts';
import { EndpointGateway } from '../../control/server/endpoint/gateway.ts';
import { ControlDatabase } from '../../control/server/persistence/database.ts';
import { createApplication } from '../../control/server/application.ts';

export async function createClusterControl(options: {
  run: string;
  executable: string;
  browser: string;
  port: number;
  remote?: boolean;
}) {
  const { run, executable, browser, port, remote } = options;
  const nodeId = remote ? 'robust-qa' : 'local';
  const configPath = join(run, 'control.json');
  await writeFile(
    configPath,
    JSON.stringify({
      http: { host: '127.0.0.1', port, origins: [`http://127.0.0.1:${port}`] },
      database: join(run, 'control.db'),
      diagnostics: join(run, 'diagnostics'),
      cluster: {
        keyFile: 'cluster.key',
        ...(remote ? { advertiseUrl: `ws://127.0.0.1:${port}/api/node` } : {}),
      },
      nodeDefaults: { browser, dataPath: join(run, 'endpoint') },
      nodes: { [nodeId]: remote ? {} : { launch: { executable, root: join(run, 'node') } } },
    }),
  );
  const config = runtimeConfig({ REMOTEKIT_CONTROL_CONFIG: configPath }, []);
  const store = new ControlDatabase(config.dbPath);
  const endpoint = new NodeRegistry({
    nodes: config.nodes,
    key: config.cluster.key,
    buildId: config.buildId,
  });
  const gateway = new EndpointGateway(endpoint, new Placement(store, endpoint));
  const control = createApplication(store, gateway);
  endpoint.on('ready', (identity) => void control.reconciler.endpointReady(identity).catch(console.error));
  endpoint.on('offline', (node) => control.rtc.endpointOffline(node));
  return { store, endpoint, control, nodeId };
}
