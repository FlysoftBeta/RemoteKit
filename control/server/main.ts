import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runtimeConfig } from './config';
import { open } from './persistence/database';
import { LocalProcessLink } from './endpoint/local-process';
import { RemoteNodeLink } from './endpoint/remote-node';
import { EndpointGateway } from './endpoint/gateway';
import { Control } from './control';
import { createHttp } from './http';
import { startApplication } from './application';
const config = runtimeConfig();
mkdirSync(dirname(config.dbPath), { recursive: true });
const database = open(config.dbPath);
const endpointNode = config.node ? new RemoteNodeLink(config.node) : undefined;
const link = endpointNode ?? new LocalProcessLink(config.endpoint, [...config.endpointArgs]);
const control = new Control(database, new EndpointGateway(link));
const server = createHttp(control, {
  tls: config.tls,
  endpointNode,
  origins: [...config.origins],
  clientDir: config.clientDir,
  diagnosticDir: config.diagnosticDir,
});
startApplication(config, database, link, control, server);
