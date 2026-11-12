import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createClusterControl } from './cluster-control.mts';

test('cluster harness provisions the requested peer listener independently of HTTP', async () => {
  const evidence = resolve('develop/tmp/fix1-shots');
  await mkdir(evidence, { recursive: true });
  const run = await mkdtemp(join(evidence, 'peer-port-'));
  const { store, endpoint, control, nodeId } = await createClusterControl({
    run,
    executable: '',
    browser: '',
    port: 34180,
    peerPort: 34189,
    remote: true,
  });
  try {
    assert.equal(endpoint.get(nodeId)!.config.peer.listen, '127.0.0.1:34189');
    assert.equal(endpoint.get(nodeId)!.config.peer.address, '127.0.0.1:34189');
  } finally {
    await control.close();
    endpoint.stop();
    store.db.close();
  }
});
