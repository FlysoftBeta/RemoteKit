import { connect, createServer } from 'node:net';

export async function createNetworkProxy({ port, upstreamPort, preserveHotReload = false }) {
  let online = true;
  const sockets = new Map();
  const proxy = createServer((socket) => {
    socket.once('data', (bytes) => {
      const hotReload = preserveHotReload && /^GET \/\?token=/.test(bytes.toString('utf8'));
      if (!online && !hotReload) return socket.destroy();
      const upstream = connect(upstreamPort, '127.0.0.1');
      for (const peer of [socket, upstream]) {
        sockets.set(peer, hotReload);
        peer.on('error', () => {});
        peer.on('close', () => {
          sockets.delete(peer);
          socket.destroy();
          upstream.destroy();
        });
      }
      upstream.write(bytes);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
  });
  await new Promise((done, reject) => {
    proxy.once('error', reject);
    proxy.listen(port, '127.0.0.1', done);
  });
  return {
    origin: `http://127.0.0.1:${proxy.address().port}`,
    disconnect() {
      online = false;
      // Vite reconnects by reloading the page, which would replace the Viewer under test.
      for (const [socket, hotReload] of sockets) if (!hotReload) socket.destroy();
    },
    reconnect() {
      online = true;
    },
    async close() {
      online = false;
      for (const socket of sockets.keys()) socket.destroy();
      await new Promise((done) => proxy.close(done));
    },
  };
}
