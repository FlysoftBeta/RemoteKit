import { stageRuntime } from '../integration/stage-runtime.mjs';
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
      http: { listen: `127.0.0.1:${port}`, origins: [`http://127.0.0.1:${port}`] },
      storage: {
        database: join(run, 'control.db'),
        diagnostics: join(run, 'diagnostics'),
        logs: join(run, 'logs'),
      },
      nodes: {
        [nodeId]: remote
          ? { remote: { control: `ws://127.0.0.1:${port}/api/node` } }
          : {
              local: {
                executable: stageRuntime(executable, browser, join(run, 'node-runtime/bin')),
                root: join(run, 'node'),
              },
            },
      },
    }),
  );
  const config = runtimeConfig({ REMOTEKIT_CONTROL_CONFIG: configPath }, []);
  const store = new ControlDatabase(config.dbPath, { buildId: config.buildId });
  const endpoint = new NodeRegistry({
    nodes: config.nodes,
    privateKey: config.identity.privateKey,
    buildId: config.buildId,
  });
  const gateway = new EndpointGateway(endpoint, new Placement(store, endpoint));
  const control = createApplication(store, gateway);
  endpoint.on('ready', (identity) => void control.reconciler.endpointReady(identity).catch(console.error));
  endpoint.on('offline', (node) => control.rtc.endpointOffline(node));
  return { store, endpoint, control, nodeId };
}
