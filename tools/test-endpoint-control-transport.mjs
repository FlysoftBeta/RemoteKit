// CPU-only WinHTTP client / real WebSocket integration, no Chromium or GPU.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../control/package.json', import.meta.url));
const { WebSocketServer } = require('ws');
const executable = process.argv[2];
if (!executable)
  throw Error('usage: node tools/test-endpoint-control-transport.mjs <endpoint_control_transport_tests.exe>');
const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 1024 * 1024 });
await new Promise((resolve) => server.once('listening', resolve));
let connections = 0,
  fresh = false,
  ping = false,
  protocolPong = false,
  finished = false;
let endpointIncarnation;
const timers = new Set();
const later = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timers.add(timer);
};
server.on('connection', (socket, request) => {
  assert.equal(request.url, '/api/endpoint');
  assert.equal(request.headers.authorization, 'Bearer test-secret');
  const index = ++connections;
  socket.on('pong', () => (protocolPong = true));
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'node.hello') {
      assert.match(message.endpointIncarnation, /^[a-f0-9]{32}$/);
      endpointIncarnation ??= message.endpointIncarnation;
      assert.equal(message.endpointIncarnation, endpointIncarnation);
      assert.deepEqual(message, { type: 'node.hello', version: 1, nodeId: 'test-node', endpointIncarnation });
      socket.send(JSON.stringify({ type: 'node.ready', version: 1, connectionEpoch: `epoch-${index}` }));
      if (index === 1) {
        socket.send('{"id":', { fin: false });
        socket.send('"old"}', { fin: true });
        later(() => socket.terminate(), 250);
      } else if (index === 2) {
        socket.send('{"id":"new"}');
        socket.ping('control-heartbeat');
      } else if (index === 3) {
        // Oversized fragmented message must reconnect without dispatch.
        later(() => socket.send('{"id":"finish"}'), 50);
      } else throw Error('unexpected reconnect');
    } else if (message.type === 'node.ping') {
      ping = true;
      socket.send('{"type":"node.pong"}');
      // Exercise the exact payload boundary across multiple WebSocket fragments.
      const chunk = 'x'.repeat(512 * 1024);
      socket.send(chunk, { fin: false });
      socket.send(chunk, { fin: false });
      socket.send('x', { fin: true });
    } else if (message.id === 'fresh') fresh = true;
    else if (message.id === 'finished') finished = true;
    else throw Error(`stale/unexpected message: ${JSON.stringify(message)}`);
  });
});
const child = spawn(executable, [`http://127.0.0.1:${server.address().port}/api/endpoint`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (bytes) => (output += bytes));
child.stderr.on('data', (bytes) => (output += bytes));
const timeout = setTimeout(() => child.kill(), 45000);
const code = await new Promise((resolve) => child.once('exit', resolve));
clearTimeout(timeout);
for (const timer of timers) clearTimeout(timer);
for (const socket of server.clients) socket.terminate();
await new Promise((resolve) => server.close(resolve));
assert.equal(code, 0, output);
assert.equal(connections, 3);
assert.ok(fresh);
assert.ok(ping);
assert.ok(protocolPong);
assert.ok(finished);
console.log(
  'WinHTTP integration passed: auth, fragmented text, generation isolation, application/protocol heartbeat, oversize reconnect, shutdown drain and receive cancellation',
);
