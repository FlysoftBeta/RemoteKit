// UDP relay that sits on the media path between schedlab.exe and the receiver page. Both SDPs are
// rewritten so each side's only remote candidate is a relay socket; SRTP/SRTCP from the sender is
// then shaped by a timed schedule of bottleneck rate and random loss. STUN and DTLS always pass, so
// ICE and the handshake are unaffected and only media sees the impairment.
import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

// "0:rate=48000,loss=0;20:rate=1500,loss=2" — seconds from t0, rate in kbit/s (0 = unlimited),
// loss in percent, optional queue in ms (bottleneck buffer before tail drop).
export function parseSchedule(text) {
  const steps = text.split(';').map((part) => {
    const match = /^(\d+(?:\.\d+)?):(.*)$/.exec(part.trim());
    if (!match) throw Error(`Invalid network step: ${part}`);
    const step = { at: Number(match[1]), rate: 0, loss: 0, queue: 200 };
    for (const field of match[2].split(',').filter(Boolean)) {
      const [key, value] = field.split('=');
      if (!['rate', 'loss', 'queue'].includes(key) || !Number.isFinite(Number(value)) || Number(value) < 0)
        throw Error(`Invalid network field: ${field}`);
      step[key] = Number(value);
    }
    if (step.loss > 100) throw Error(`Invalid loss: ${step.loss}`);
    return step;
  });
  if (!steps.length || steps[0].at !== 0 || steps.some((s, i) => i && s.at <= steps[i - 1].at))
    throw Error('Network schedule must start at 0 and increase');
  return steps;
}

function lanAddress() {
  for (const entries of Object.values(networkInterfaces()))
    for (const entry of entries ?? []) if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  throw Error('No non-loopback IPv4 address for the relay');
}

const media = (packet) => packet.length > 0 && packet[0] >= 128 && packet[0] <= 191;

function rewriteCandidates(sdp, address, port) {
  let replaced = false;
  const lines = sdp.split(/\r\n/).flatMap((line) => {
    if (!line.startsWith('a=candidate:')) return [line];
    if (replaced) return [];
    replaced = true;
    return [`a=candidate:1 1 udp 2130706431 ${address} ${port} typ host generation 0`];
  });
  if (!replaced) throw Error('SDP has no candidate to relay');
  return lines.join('\r\n');
}

function senderCandidates(sdp) {
  return sdp
    .split(/\r\n/)
    .filter((line) => line.startsWith('a=candidate:'))
    .map((line) => line.split(' '))
    .filter((parts) => parts[2]?.toLowerCase() === 'udp' && /^\d+\.\d+\.\d+\.\d+$/.test(parts[4]))
    .map((parts) => ({ address: parts[4], port: Number(parts[5]) }));
}

export class Relay {
  constructor(schedule, log) {
    this.schedule = schedule;
    this.log = log;
    this.address = lanAddress();
    this.toSender = createSocket('udp4');
    this.toReceiver = createSocket('udp4');
    this.queue = [];
    this.queuedBytes = 0;
    this.nextFree = 0;
    this.counters = { forwarded: 0, lost: 0, tailDropped: 0, bytes: 0 };
    this.start = Date.now();
    this.toSender.on('message', (packet, from) => {
      this.sender = { address: from.address, port: from.port };
      if (this.receiver) this.fromSender(packet);
    });
    this.toReceiver.on('message', (packet, from) => {
      this.receiver = { address: from.address, port: from.port };
      const target = this.sender ?? this.senderCandidates?.[0];
      if (target) this.toSender.send(packet, target.port, target.address);
    });
    this.timer = setInterval(() => this.drain(), 1);
    this.report = setInterval(() => this.emit(), 1000);
  }
  async listen() {
    await Promise.all(
      [this.toSender, this.toReceiver].map(
        (socket) => new Promise((done) => socket.bind(0, '0.0.0.0', done)),
      ),
    );
  }
  offer(sdp) {
    return rewriteCandidates(sdp, this.address, this.toSender.address().port);
  }
  answer(sdp) {
    this.senderCandidates = senderCandidates(sdp);
    if (!this.senderCandidates.length) throw Error('Sender answer has no IPv4 UDP candidate');
    return rewriteCandidates(sdp, this.address, this.toReceiver.address().port);
  }
  begin(t0) {
    this.start = t0;
  }
  step() {
    const elapsed = (Date.now() - this.start) / 1000;
    let current = this.schedule[0];
    for (const step of this.schedule) if (step.at <= elapsed) current = step;
    return current;
  }
  fromSender(packet) {
    const step = this.step();
    if (!media(packet)) return this.deliver(packet);
    if (step.loss && Math.random() * 100 < step.loss) return void ++this.counters.lost;
    if (!step.rate) return this.deliver(packet);
    const limit = (step.rate * 1000 * step.queue) / 8000;
    if (this.queuedBytes + packet.length > limit) return void ++this.counters.tailDropped;
    this.queue.push(packet);
    this.queuedBytes += packet.length;
    this.drain();
  }
  drain() {
    const step = this.step();
    const now = performance.now();
    while (this.queue.length) {
      if (step.rate && this.nextFree > now) return;
      const packet = this.queue.shift();
      this.queuedBytes -= packet.length;
      this.nextFree = Math.max(this.nextFree, now) + (step.rate ? (packet.length * 8) / step.rate : 0);
      this.deliver(packet);
    }
  }
  deliver(packet) {
    ++this.counters.forwarded;
    this.counters.bytes += packet.length;
    this.toReceiver.send(packet, this.receiver.port, this.receiver.address);
  }
  emit() {
    this.log({
      type: 'relay',
      epochMs: Date.now(),
      step: this.step(),
      queuedBytes: this.queuedBytes,
      ...this.counters,
    });
  }
  close() {
    clearInterval(this.timer);
    clearInterval(this.report);
    this.emit();
    this.toSender.close();
    this.toReceiver.close();
  }
}
