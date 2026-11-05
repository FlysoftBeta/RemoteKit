import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runtimeConfig } from './config';
import { EndpointGateway } from './endpoint/gateway';
import { LocalProcessLink } from './endpoint/local-process';
import { RemoteNodeLink } from './endpoint/remote-node';
import { open } from './persistence/database';

import { createApplication, startApplication } from './application';
import { createHttp } from './http/server';
const config = runtimeConfig();
mkdirSync(dirname(config.dbPath), { recursive: true });
const database = open(config.dbPath);
const endpointNode = config.node ? new RemoteNodeLink(config.node) : undefined;
const link = endpointNode ?? new LocalProcessLink(config.endpoint, [...config.endpointArgs]);
const control = createApplication(database, new EndpointGateway(link));
const server = createHttp(control, {
  tls: config.tls,
  endpointNode,
  origins: [...config.origins],
  clientDir: config.clientDir,
  diagnosticDir: config.diagnosticDir,
});
startApplication(config, database, link, control, server);
