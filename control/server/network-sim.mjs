import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { performance } from 'node:perf_hooks';

export function parseNetworkSimulation(value) {
  if (!value || value === 'off') return undefined;
  const input = JSON.parse(value);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Network simulation requires a JSON object');
  const config = {
    oneWayDelayMs: input.oneWayDelayMs ?? 5,
    downlinkMbps: input.downlinkMbps ?? 24,
    uplinkMbps: input.uplinkMbps ?? 1000,
    maxQueueBytes: input.maxQueueBytes ?? 300000,
    maxQueueDelayMs: input.maxQueueDelayMs ?? 100,
  };
  for (const [key, number] of Object.entries(config))
    if (!Number.isFinite(number) || number <= 0) throw new Error(`Invalid network simulation ${key}`);
  if (
    config.oneWayDelayMs > 1000 ||
    config.downlinkMbps > 1000 ||
    config.uplinkMbps > 1000 ||
    config.maxQueueBytes > 4000000 ||
    config.maxQueueDelayMs > 1000
  )
    throw new Error('Network simulation exceeds bounded loopback limits');
  return config;
}
const locals = () =>
  new Set([
    '127.0.0.1',
    ...Object.values(networkInterfaces())
      .flat()
      .filter(Boolean)
      .filter((info) => info.family === 'IPv4')
      .map((info) => info.address),
  ]);
export function selectLocalCandidate(sdp, { requireLoopback = false } = {}) {
  const allowed = locals();
  const choices = [];
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith('a=candidate:')) continue;
    const fields = line.slice(12).trim().split(/\s+/);
    if (
      fields[1] !== '1' ||
      fields[2]?.toLowerCase() !== 'udp' ||
      fields[6] !== 'typ' ||
      fields[7] !== 'host' ||
      !allowed.has(fields[4]) ||
      (requireLoopback && fields[4] !== '127.0.0.1')
    )
      continue;
    const port = Number(fields[5]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) continue;
    choices.push({ address: fields[4], port, priority: Number(fields[3]) });
  }
  choices.sort(
    (a, b) =>
      Number(b.address === '127.0.0.1') - Number(a.address === '127.0.0.1') || b.priority - a.priority,
  );
  if (!choices.length)
    throw new Error(
      requireLoopback
        ? 'Native endpoint simulation requires a real gathered 127.0.0.1 UDP host candidate; enable diagnostic loopback ICE in the endpoint'
        : 'Simulation requires a gathered raw IPv4 UDP host candidate belonging to this machine; disable mDNS in the dedicated test Chrome',
    );
  return choices[0];
}
export function rewriteSdp(sdp, relay) {
  if (!/^a=group:BUNDLE /m.test(sdp)) throw new Error('Simulation requires BUNDLE');
  if (/^m=video /m.test(sdp) && !sdp.split(/\r?\n/).includes('a=rtcp-mux'))
    throw new Error('Simulation requires rtcp-mux');
  const lines = sdp.split(/\r?\n/);
  let inserted = false;
  const output = [];
  for (const line of lines) {
    if (line.startsWith('m=')) {
      inserted = false;
      const parts = line.split(' ');
      if (parts[1] !== '0') parts[1] = String(relay.port);
      output.push(parts.join(' '));
      continue;
    }
    if (line.startsWith('c=IN ')) {
      output.push('c=IN IP4 127.0.0.1');
      continue;
    }
    if (line.startsWith('a=rtcp:')) {
      output.push(`a=rtcp:${relay.port} IN IP4 127.0.0.1`);
      continue;
    }
    if (line.startsWith('a=remote-candidates:') || line.startsWith('a=ice-options:trickle')) continue;
    if (line.startsWith('a=candidate:')) {
      if (!inserted) {
        output.push(`a=candidate:rkrelay 1 udp 2130706431 127.0.0.1 ${relay.port} typ host`);
        inserted = true;
      }
      continue;
    }
    if (line) output.push(line);
  }
  return output.join('\r\n') + '\r\n';
}
class Direction {
  queue = [];
  queuedBytes = 0;
  tail = 0;
  timer;
  closed = false;
  stats = {
    receivedPackets: 0,
    receivedBytes: 0,
    forwardedPackets: 0,
    forwardedBytes: 0,
    wireBytes: 0,
    droppedPackets: 0,
    droppedBytes: 0,
    sendErrors: 0,
    maximumQueueBytes: 0,
    maximumSchedulerLateMs: 0,
  };
  constructor(config, mbps, send) {
    this.config = config;
    this.mbps = mbps;
    this.send = send;
  }
  receive(packet) {
    this.stats.receivedPackets++;
    this.stats.receivedBytes += packet.length;
    const now = performance.now();
    const transmissionMs = ((packet.length + 28) * 8) / (this.mbps * 1000);
    const finish = Math.max(now, this.tail) + transmissionMs;
    if (
      this.closed ||
      this.queuedBytes + packet.length > this.config.maxQueueBytes ||
      finish - now > this.config.maxQueueDelayMs ||
      this.queue.length >= 4096
    ) {
      this.stats.droppedPackets++;
      this.stats.droppedBytes += packet.length;
      return;
    }
    this.tail = finish;
    this.queue.push({ packet: Buffer.from(packet), due: finish + this.config.oneWayDelayMs });
    this.queuedBytes += packet.length;
    this.stats.maximumQueueBytes = Math.max(this.stats.maximumQueueBytes, this.queuedBytes);
    this.arm();
  }
  // Windows Node timers may round 5ms up to a system tick. During queued experimental
  // traffic, setImmediate polls the monotonic deadline; there is no idle busy loop.
  arm() {
    if (this.timer || !this.queue.length || this.closed) return;
    this.timer = setImmediate(() => {
      this.timer = undefined;
      this.flush();
    });
  }
  flush() {
    const now = performance.now();
    while (this.queue.length && this.queue[0].due <= now) {
      const { packet, due } = this.queue.shift();
      this.queuedBytes -= packet.length;
      this.stats.maximumSchedulerLateMs = Math.max(this.stats.maximumSchedulerLateMs, now - due);
      this.send(packet, (error) => {
        if (error) this.stats.sendErrors++;
        else {
          this.stats.forwardedPackets++;
          this.stats.forwardedBytes += packet.length;
          this.stats.wireBytes += packet.length + 28;
        }
      });
    }
    this.arm();
  }
  snapshot() {
    return { ...this.stats, queuedBytes: this.queuedBytes, queuedPackets: this.queue.length };
  }
  close() {
    this.closed = true;
    clearImmediate(this.timer);
    this.stats.droppedPackets += this.queue.length;
    this.stats.droppedBytes += this.queuedBytes;
    this.queue = [];
    this.queuedBytes = 0;
  }
}
export class LoopbackRelay {
  clientSocket = dgram.createSocket('udp4');
  serverSocket = dgram.createSocket('udp4');
  clientTarget;
  serverTarget;
  rejectedPackets = 0;
  rejectedSources = new Map();
  socketErrors = 0;
  closed = false;
  constructor(config, clientTarget) {
    this.cpuStart = process.cpuUsage();
    this.createdAt = performance.now();
    this.config = config;
    this.checkTarget(clientTarget);
    this.clientOfferedTarget = clientTarget;
    this.clientTarget = { address: '127.0.0.1', port: clientTarget.port };
    this.uplink = new Direction(config, config.uplinkMbps, (packet, done) =>
      this.serverSocket.send(packet, this.serverTarget.port, this.serverTarget.address, done),
    );
    this.downlink = new Direction(config, config.downlinkMbps, (packet, done) =>
      this.clientSocket.send(packet, this.clientTarget.port, this.clientTarget.address, done),
    );
    const reject = (direction, remote) => {
      this.rejectedPackets++;
      const key = direction + ':' + remote.address + ':' + remote.port;
      if (this.rejectedSources.size < 16 || this.rejectedSources.has(key))
        this.rejectedSources.set(key, (this.rejectedSources.get(key) ?? 0) + 1);
    };
    this.clientSocket.on('message', (packet, remote) => {
      if (
        !this.serverTarget ||
        remote.address !== this.clientTarget.address ||
        remote.port !== this.clientTarget.port
      ) {
        reject('uplink', remote);
        return;
      }
      this.uplink.receive(packet);
    });
    this.serverSocket.on('message', (packet, remote) => {
      if (
        !this.serverTarget ||
        remote.address !== this.serverTarget.address ||
        remote.port !== this.serverTarget.port
      ) {
        reject('downlink', remote);
        return;
      }
      this.downlink.receive(packet);
    });
    for (const socket of [this.clientSocket, this.serverSocket])
      socket.on('error', () => this.socketErrors++);
  }
  checkTarget(target) {
    if (
      !locals().has(target.address) ||
      !Number.isInteger(target.port) ||
      target.port < 1024 ||
      target.port > 65535
    )
      throw new Error('Relay targets must be explicit high-port UDP endpoints on this machine');
  }
  async bind() {
    try {
      await Promise.all(
        [this.clientSocket, this.serverSocket].map(
          (socket) =>
            new Promise((resolve, reject) => {
              const error = (err) => reject(err);
              socket.once('error', error);
              socket.bind(0, '127.0.0.1', () => {
                socket.removeListener('error', error);
                resolve();
              });
            }),
        ),
      );
      return this;
    } catch (error) {
      this.close();
      throw error;
    }
  }
  setServer(target) {
    this.checkTarget(target);
    this.serverOfferedTarget = target;
    this.serverTarget = { address: '127.0.0.1', port: target.port };
  }
  get clientAddress() {
    const address = this.clientSocket.address();
    return { address: address.address, port: address.port };
  }
  get serverAddress() {
    const address = this.serverSocket.address();
    return { address: address.address, port: address.port };
  }
  snapshot() {
    const cpu = process.cpuUsage(this.cpuStart),
      elapsedMs = performance.now() - this.createdAt;
    return {
      enabled: true,
      config: this.config,
      clientRelay: this.clientAddress,
      serverRelay: this.serverAddress,
      clientOfferedTarget: this.clientOfferedTarget,
      serverOfferedTarget: this.serverOfferedTarget,
      clientTarget: this.clientTarget,
      serverTarget: this.serverTarget,
      uplink: this.uplink.snapshot(),
      downlink: this.downlink.snapshot(),
      rejectedPackets: this.rejectedPackets,
      rejectedSources: Object.fromEntries(this.rejectedSources),
      socketErrors: this.socketErrors,
      processCpuSinceRelayCreation: {
        pid: process.pid,
        elapsedMs,
        userMs: cpu.user / 1000,
        systemMs: cpu.system / 1000,
        averageCores: (cpu.user + cpu.system) / 1000 / elapsedMs,
      },
    };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.uplink.close();
    this.downlink.close();
    for (const socket of [this.clientSocket, this.serverSocket]) {
      try {
        socket.close();
      } catch {}
    }
  }
}
