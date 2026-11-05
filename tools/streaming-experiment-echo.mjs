import dgram from 'node:dgram';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoopbackRelay, parseNetworkSimulation } from '../control/server/network-sim.mjs';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bind = (socket) => new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
const target = (socket) => ({ address: '127.0.0.1', port: socket.address().port });
const percentile = (numbers, p) =>
  [...numbers].sort((a, b) => a - b)[Math.ceil(numbers.length * p) - 1] ?? null;
async function setup(mbps, queue = 300000) {
  const client = dgram.createSocket('udp4'),
    server = dgram.createSocket('udp4');
  await Promise.all([bind(client), bind(server)]);
  const relay = await new LoopbackRelay(
    parseNetworkSimulation(JSON.stringify({ downlinkMbps: mbps, maxQueueBytes: queue })),
    target(client),
  ).bind();
  relay.setServer(target(server));
  return {
    client,
    server,
    relay,
    close() {
      relay.close();
      client.close();
      server.close();
    },
  };
}
async function rtt() {
  const env = await setup(24);
  const samples = [];
  let unexpectedSource = 0;
  env.server.on('message', (packet, remote) => {
    if (remote.port !== env.relay.serverAddress.port || remote.address !== '127.0.0.1') unexpectedSource++;
    env.server.send(packet, remote.port, remote.address);
  });
  try {
    for (let sequence = 0; sequence < 40; sequence++) {
      const packet = Buffer.alloc(64);
      packet.writeUInt32LE(sequence);
      const start = performance.now();
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('UDP RTT echo timed out')), 2000);
        env.client.once('message', (packet, remote) => {
          clearTimeout(timer);
          if (remote.port !== env.relay.clientAddress.port || remote.address !== '127.0.0.1')
            unexpectedSource++;
          resolve(performance.now() - start);
        });
      });
      env.client.send(packet, env.relay.clientAddress.port, '127.0.0.1');
      samples.push(await reply);
    }
    return {
      requestedRttMs: 10,
      p50: percentile(samples, 0.5),
      p95: percentile(samples, 0.95),
      p99: percentile(samples, 0.99),
      rawRttMs: samples,
      unexpectedSource,
      relay: env.relay.snapshot(),
    };
  } finally {
    env.close();
  }
}
async function throughput(mbps, durationMs = 3000) {
  const env = await setup(mbps);
  const packet = Buffer.alloc(1200, 0xa5);
  let packets = 0,
    bytes = 0,
    first,
    last,
    offeredPackets = 0,
    unexpectedSource = 0;
  env.client.on('message', (packet, remote) => {
    const now = performance.now();
    first ??= now;
    last = now;
    packets++;
    bytes += packet.length;
    if (remote.port !== env.relay.clientAddress.port) unexpectedSource++;
  });
  try {
    const start = performance.now();
    while (performance.now() - start < durationMs) {
      const due = Math.floor(((performance.now() - start) * mbps * 2 * 1000) / 8 / packet.length);
      let sent = 0;
      while (offeredPackets < due && sent++ < 256) {
        env.server.send(packet, env.relay.serverAddress.port, '127.0.0.1');
        offeredPackets++;
      }
      await sleep(1);
    }
    await sleep(250);
    const spanMs = first === undefined ? 0 : last - first;
    return {
      limitMbps: mbps,
      offeredMbps: mbps * 2,
      durationMs,
      packets,
      bytes,
      offeredPackets,
      spanMs,
      receivedPayloadMbps: spanMs ? ((bytes - 1200) * 8) / spanMs / 1000 : null,
      receivedWireMbps: spanMs ? ((bytes - 1200 + (packets - 1) * 28) * 8) / spanMs / 1000 : null,
      unexpectedSource,
      relay: env.relay.snapshot(),
    };
  } finally {
    env.close();
  }
}
const report = {
  kind: 'real-loopback-udp-echo',
  generatedAt: new Date().toISOString(),
  rtt: await rtt(),
  throughput: [await throughput(24), await throughput(48)],
};
const outputIndex = process.argv.indexOf('--output');
const output = resolve(
  outputIndex >= 0
    ? process.argv[outputIndex + 1]
    : fileURLToPath(new URL('../develop/tmp/network-sim-echo.json', import.meta.url)),
);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      output,
      rtt: { p50: report.rtt.p50, p95: report.rtt.p95, p99: report.rtt.p99 },
      throughput: report.throughput.map((result) => ({
        limitMbps: result.limitMbps,
        measuredWireMbps: result.receivedWireMbps,
        drop: result.relay.downlink.droppedPackets,
        maximumQueueBytes: result.relay.downlink.maximumQueueBytes,
        unexpectedSource: result.unexpectedSource,
      })),
    },
    null,
    2,
  ),
);
if (
  report.rtt.p50 < 9 ||
  report.rtt.p95 > 35 ||
  report.rtt.unexpectedSource ||
  report.throughput.some(
    (result) =>
      !result.receivedWireMbps ||
      Math.abs(result.receivedWireMbps / result.limitMbps - 1) > 0.12 ||
      !result.relay.downlink.droppedPackets ||
      result.unexpectedSource ||
      result.relay.downlink.maximumQueueBytes > 300000,
  )
)
  process.exitCode = 1;
