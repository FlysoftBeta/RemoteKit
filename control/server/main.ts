import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store';
import { EndpointProcess } from './endpoint';
import { EndpointNode } from './endpoint-node';
import { Control } from './control';
import { createHttp } from './http';
import { parseNetworkSimulation } from './network-sim.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = resolve(process.env.REMOTEKIT_CONTROL_DB ?? resolve(root, 'data/control.db')); mkdirSync(dirname(dbPath), { recursive: true });
const store = new Store(dbPath);
const simulation = parseNetworkSimulation(process.env.REMOTEKIT_NETWORK_SIM);
const endpointNode = process.env.REMOTEKIT_ENDPOINT_NODE_ID ? new EndpointNode({ nodeId: process.env.REMOTEKIT_ENDPOINT_NODE_ID, token: process.env.REMOTEKIT_ENDPOINT_TOKEN ?? '', tlsProxy: process.env.REMOTEKIT_ENDPOINT_TLS_PROXY === '1' }) : undefined;
const endpoint = endpointNode ?? new EndpointProcess(process.env.REMOTEKIT_ENDPOINT ?? resolve(root, '../build/endpoint/endpoint/endpoint_service.exe'), JSON.parse(process.env.REMOTEKIT_ENDPOINT_ARGS ?? '[]'), !!simulation);
const control = new Control(store, endpoint, simulation);
let closing = false;
const background = new Set<Promise<unknown>>();
function run(work: Promise<unknown>) { background.add(work); void work.then(() => background.delete(work), error => { background.delete(work); console.error(error); }); }
const endpointReady = (identity?: { processChanged: boolean }) => { if (!closing) run(control.endpointReady(identity)); };
endpoint.on('ready', endpointReady);
const endpointOffline = () => { if (!closing) control.endpointOffline(); };
endpoint.on('offline', endpointOffline);
const port = Number(process.env.PORT ?? 3001);
const host = process.env.REMOTEKIT_CONTROL_HOST ?? '127.0.0.1';
const tlsKey = process.env.REMOTEKIT_HTTPS_KEY, tlsCert = process.env.REMOTEKIT_HTTPS_CERT;
if (!!tlsKey !== !!tlsCert) throw new Error('REMOTEKIT_HTTPS_KEY and REMOTEKIT_HTTPS_CERT must be configured together');
const tls = tlsKey && tlsCert ? { key: readFileSync(tlsKey), cert: readFileSync(tlsCert) } : undefined;
const scheme = tls ? 'https' : 'http';
const server = createHttp(control, { tls, endpointNode, diagnostics: process.env.REMOTEKIT_DIAGNOSTICS === '1', origins: (process.env.REMOTEKIT_CONTROL_ORIGINS ?? `${scheme}://127.0.0.1:${port},${scheme}://localhost:${port},http://127.0.0.1:5173,http://localhost:5173`).split(',').map(value => value.trim()), clientDir: resolve(root, 'dist/client'), metricsDir: resolve(process.env.REMOTEKIT_METRICS_DIR ?? resolve(root, '../develop/tmp/metrics')) });
const reconciliationTimer = setInterval(() => { if (!closing) run(control.tick()); }, 1500);
server.listen(port, host, () => { endpoint.start(); const address = server.address(); console.log(`RemoteKit Control ${scheme}://${host}:${typeof address === 'object' ? address?.port : port}`); });
let closePromise: Promise<void> | undefined;
function close(): Promise<void> {
  if (closePromise) return closePromise;
  closing = true; clearInterval(reconciliationTimer); endpoint.off('ready', endpointReady); endpoint.off('offline', endpointOffline);
  closePromise = (async () => {
    await server.shutdown();
    while (background.size) await Promise.allSettled([...background]);
    await control.close();
    await endpoint.stop();
    store.db.close();
  })();
  return closePromise;
}
process.on('SIGINT', () => { void close(); }); process.on('SIGTERM', () => { void close(); });
process.once('disconnect', () => { void close(); });
