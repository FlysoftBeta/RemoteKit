import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { networkInterfaces } from 'node:os';
import { LoopbackRelay, parseNetworkSimulation, rewriteSdp, selectLocalCandidate } from '../server/network-sim.mjs';
test('simulation opt-in and SDP restrict to one loopback relay candidate', () => {
  assert.equal(parseNetworkSimulation(undefined), undefined);
  assert.throws(() => parseNetworkSimulation('{"maxQueueBytes":9000000}'));
  const sdp = 'v=0\r\na=group:BUNDLE 0 1\r\nm=video 12345 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 127.0.0.1\r\na=rtcp-mux\r\na=candidate:1 1 udp 100 127.0.0.1 12345 typ host\r\na=candidate:2 1 tcp 90 127.0.0.1 12346 typ host tcptype passive\r\na=candidate:3 1 udp 80 203.0.113.1 12347 typ srflx\r\n';
  assert.deepEqual(selectLocalCandidate(sdp), { address: '127.0.0.1', port: 12345, priority: 100 });
  assert.deepEqual(selectLocalCandidate(sdp, { requireLoopback: true }), { address: '127.0.0.1', port: 12345, priority: 100 });
  const local = Object.values(networkInterfaces()).flat().find(info => info?.family === 'IPv4' && !info.internal)?.address;
  if (local) { const boundSdp = sdp.split('127.0.0.1').join(local); assert.equal(selectLocalCandidate(boundSdp).address, local); assert.throws(() => selectLocalCandidate(boundSdp, { requireLoopback: true }), /real gathered 127/); }
  const changed = rewriteSdp(sdp, { address: '127.0.0.1', port: 22222 });
  assert.equal(changed.split('a=candidate:').length - 1, 1); assert.match(changed, /127.0.0.1 22222 typ host/); assert.doesNotMatch(changed, /203.0.113|tcp /);
  assert.throws(() => selectLocalCandidate(sdp.split('127.0.0.1').join('not-a-host.local')));
});
test('UDP directions preserve opposite socket source and bound queue/drop', async () => {
  const client = dgram.createSocket('udp4'), server = dgram.createSocket('udp4'); client.bind(0, '127.0.0.1'); server.bind(0, '127.0.0.1'); await Promise.all([once(client, 'listening'), once(server, 'listening')]);
  const clientAddress = client.address(), serverAddress = server.address(); if (typeof clientAddress === 'string' || typeof serverAddress === 'string') throw new Error();
  const relay = await new LoopbackRelay(parseNetworkSimulation('{"downlinkMbps":24,"maxQueueBytes":2400}')!, { address: '127.0.0.1', port: clientAddress.port }).bind(); relay.setServer({ address: '127.0.0.1', port: serverAddress.port });
  try {
    const received = once(server, 'message'); client.send(Buffer.from('ping'), relay.clientAddress.port, '127.0.0.1'); const [packet, remote] = await received;
    assert.equal(packet.toString(), 'ping'); assert.equal(remote.port, relay.serverAddress.port);
    const reply = once(client, 'message'); server.send(packet, remote.port, remote.address); const [pong, source] = await reply; assert.equal(pong.toString(), 'ping'); assert.equal(source.port, relay.clientAddress.port);
    for (let i = 0; i < 80; i++) server.send(Buffer.alloc(1200), relay.serverAddress.port, '127.0.0.1');
    await new Promise(resolve => setTimeout(resolve, 100)); const stats = relay.snapshot(); assert.ok(stats.downlink.droppedPackets > 0); assert.ok(stats.downlink.maximumQueueBytes <= 2400); assert.equal(stats.socketErrors, 0);
  } finally { relay.close(); client.close(); server.close(); }
});
