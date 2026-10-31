// Explicit loopback-only diagnostic harness, not a production signaling endpoint.
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoopbackRelay, parseNetworkSimulation, rewriteSdp, selectLocalCandidate } from '../control/server/network-sim.mjs';
const argument = (key, fallback) => { const index = process.argv.indexOf(key); return index < 0 ? fallback : process.argv[index + 1]; };
const port = Number(argument('--port', '3012')); const origin = `http://127.0.0.1:${port}`;
const output = resolve(argument('--output', fileURLToPath(new URL('../develop/tmp/network-sim-webrtc.json', import.meta.url))));
const config = parseNetworkSimulation(JSON.stringify({ downlinkMbps: Number(argument('--downlink', '24')) }));
const token = randomBytes(32).toString('hex'), relays = new Map();
const server = createServer(async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && req.url === '/') {
      let html = await readFile(new URL('../control/test/network-relay-test.html', import.meta.url), 'utf8'); html = html.replace('__RK_TOKEN__', JSON.stringify(token)); res.setHeader('Content-Type', 'text/html'); res.end(html); return;
    }
    if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['x-rk-test-token'] !== token) throw new Error('Only this explicit local experiment page may signal');
    let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 1024 * 1024) throw new Error('Request too large'); }
    const body = JSON.parse(text); let result;
    if (req.url === '/offer') {
      if (relays.size >= 4) throw new Error('Bounded to four local experiment peers');
      const relay = await new LoopbackRelay(config, selectLocalCandidate(body.sdp)).bind(); const id = randomUUID(); relays.set(id, relay); result = { id, sdp: rewriteSdp(body.sdp, relay.serverAddress) };
    } else if (req.url === '/answer') {
      const relay = relays.get(body.id); if (!relay) throw new Error('Unknown test peer'); relay.setServer(selectLocalCandidate(body.sdp)); result = { sdp: rewriteSdp(body.sdp, relay.clientAddress) };
    } else if (req.url === '/results') {
      const relay = relays.get(body.id); if (!relay) throw new Error('Unknown test peer'); const stats = relay.snapshot();
      const candidateMatches = (candidate, address) => candidate?.protocol === 'udp' && (candidate.ip ?? candidate.address) === '127.0.0.1' && candidate.port === address.port;
      const verified = !body.report.error && candidateMatches(body.report.client?.remoteCandidate, stats.clientRelay) && candidateMatches(body.report.endpoint?.remoteCandidate, stats.serverRelay) && body.report.decodedFrames > 0 && stats.downlink.forwardedBytes >= body.report.client.video.bytesReceived && stats.uplink.forwardedBytes > 0 && stats.socketErrors === 0;
      const report = { kind: 'chrome-real-webrtc-loopback-relay', verified, at: new Date().toISOString(), browser: body.report, relay: stats };
      await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2)); result = { output, verified, relay: stats }; console.log(JSON.stringify({ output, verified, decodedFrames: body.report.decodedFrames, downlinkBytes: stats.downlink.forwardedBytes, averageProcessCores: stats.processCpuSinceRelayCreation.averageCores }));
    } else throw new Error('Unknown route');
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  } catch (error) { res.statusCode = 400; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: error.message })); }
});
server.listen(port, '127.0.0.1', () => console.log(`Open ${origin} in dedicated Chrome89 with --disable-features=WebRtcHideLocalIpsWithMdns --autoplay-policy=no-user-gesture-required`));
const timer = setTimeout(close, 180000);
function close() { clearTimeout(timer); for (const relay of relays.values()) relay.close(); server.close(); }
process.on('SIGINT', close); process.on('SIGTERM', close);
