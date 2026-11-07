import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runtimeConfig } from './config';
import { EndpointGateway } from './endpoint/gateway';
import { NodeRegistry } from './cluster/node-link';
import { Placement } from './cluster/placement';
import { loadRelease } from './cluster/release';
import { open } from './persistence/database';

import { createApplication, startApplication } from './application';
import { createHttp } from './http/server';
import { ProcessLog } from './diagnostics/process-log';
const processLog = new ProcessLog(4 * 1024 * 1024);
processLog.install();
const config = runtimeConfig();
mkdirSync(dirname(config.dbPath), { recursive: true });
const database = open(config.dbPath);
const nodes = new NodeRegistry({
  nodes: config.nodes,
  key: config.cluster.key,
  buildId: config.buildId,
  release: loadRelease(config.root, config.buildId),
});
const control = createApplication(
  database,
  new EndpointGateway(nodes, new Placement(database, nodes)),
  undefined,
  undefined,
  config.quotas.tenantObjectBytes,
  config.sessionImport,
);
const server = createHttp(control, {
  tls: config.tls,
  nodes,
  origins: [...config.origins],
  clientDir: config.clientDir,
  diagnosticDir: config.diagnosticDir,
  processLog,
});
startApplication(config, database, nodes, control, server);
