import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect, createServer } from 'node:net';
import { test } from 'node:test';
import { createNetworkProxy } from './network.mjs';

test('network faults close product traffic, preserve Vite, and permit reconnection', async (t) => {
  const upstream = createServer((socket) => socket.pipe(socket));
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const network = await createNetworkProxy({
    port: 0,
    upstreamPort: upstream.address().port,
    preserveHotReload: true,
  });
  const clients = [];
  t.after(async () => {
    for (const socket of clients) socket.destroy();
    await network.close();
    await new Promise((done) => upstream.close(done));
  });
  async function client(message) {
    const socket = connect(Number(new URL(network.origin).port), '127.0.0.1');
    clients.push(socket);
    await once(socket, 'connect');
    socket.write(message);
    return socket;
  }
  const product = await client('product traffic');
  assert.equal(String((await once(product, 'data'))[0]), 'product traffic');
  const vite = await client('GET /?token=fixture HTTP/1.1\r\n\r\n');
  await once(vite, 'data');
  const closed = once(product, 'close');
  network.disconnect();
  await closed;
  vite.write('Vite stays connected');
  assert.equal(String((await once(vite, 'data'))[0]), 'Vite stays connected');
  const blocked = await client('blocked traffic');
  await once(blocked, 'close');
  network.reconnect();
  const restored = await client('restored traffic');
  assert.equal(String((await once(restored, 'data'))[0]), 'restored traffic');
});
