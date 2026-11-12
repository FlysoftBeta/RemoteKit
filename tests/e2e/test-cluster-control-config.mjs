import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startStack } from './kit/stack.mjs';
const stack = await startStack({
  scenario: 'cluster-control-config',
  seed: false,
  fixtures: false,
  dev: false,
});
try {
  const config = JSON.parse(readFileSync(stack.run + '/control.json', 'utf8'));
  assert.equal(config.nodes.local.peer.listen, `127.0.0.1:${stack.ports.peer}`);
  assert.equal(config.nodes.local.peer.address, `127.0.0.1:${stack.ports.peer}`);
  assert.notEqual(stack.ports.peer, stack.ports.control);
} finally {
  await stack.stop();
}
