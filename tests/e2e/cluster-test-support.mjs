import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = fileURLToPath(new URL('../../', import.meta.url));
export const requireControl = createRequire(join(repository, 'control/package.json'));
export const pause = (ms) => new Promise((done) => setTimeout(done, ms));
export async function until(label, probe, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await pause(100);
  }
  throw Error('Timed out: ' + label);
}
export async function buildHarness(runtime) {
  // Run the harness from source; shared product artifacts remain read-only.
  await mkdir(runtime, { recursive: true });
  return join(repository, 'tests/e2e/cluster-harness.mts');
}
export function startControl(server, configPath, evidence) {
  const child = spawn(process.execPath, ['--import', './control/node_modules/tsx/dist/loader.mjs', server], {
    cwd: repository,
    env: { ...process.env, REMOTEKIT_CONTROL_CONFIG: configPath },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  for (const stream of ['stdout', 'stderr'])
    child[stream].on('data', (bytes) => void appendFile(join(evidence, 'control.' + stream + '.log'), bytes));
  const pending = new Map();
  const events = [];
  child.on('message', (message) => {
    if (message.event) {
      events.push(message);
      void appendFile(join(evidence, 'control-events.jsonl'), JSON.stringify(message) + '\n');
    }
    pending.get(message.id)?.(message);
  });
  const stopped = new Promise((done) => child.once('exit', done));
  return {
    child,
    events,
    async call(method, params = {}, timeoutMs = 60000) {
      const id = randomUUID();
      return new Promise((done, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error('Harness timeout: ' + method));
        }, timeoutMs);
        pending.set(id, (message) => {
          clearTimeout(timer);
          pending.delete(id);
          if (message.error) reject(Error(message.error));
          else done(message.result);
        });
        child.send({ id, method, ...params });
      });
    },
    async stop() {
      if (child.connected) child.disconnect();
      await stopped;
    },
  };
}
export async function instrumentViewer(context, evidence, name) {
  await context.addInitScript(() => {
    const qa = (window.clusterQA = { peers: [], pending: new Map(), channels: [], fileWire: [] });
    const receive = ({ data }) => {
      if (typeof data !== 'string') return;
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message.type === 'state') qa.state = message.state;
      if (message.type === 'layout') qa.layout = message;
      if (message.type === 'auth') qa.auth = message.auth;
      if (message.type === 'files.result') {
        const { data, ...result } = message.result ?? {};
        qa.fileWire.push({
          at: performance.now(),
          direction: 'in',
          ...message,
          result: { ...result, ...(data ? { dataBytes: data.length } : {}) },
        });
      }
      qa.pending.get(message.id ?? message.requestId)?.(message);
    };
    window.WebSocket = class extends WebSocket {
      constructor(...args) {
        super(...args);
        qa.socket = this;
        this.addEventListener('message', receive);
      }
    };
    window.RTCPeerConnection = class extends RTCPeerConnection {
      constructor(...args) {
        super(...args);
        qa.peers.push(this);
      }
      createDataChannel(...args) {
        const channel = super.createDataChannel(...args);
        const send = channel.send.bind(channel);
        channel.send = (raw) => {
          if (typeof raw === 'string') {
            const message = JSON.parse(raw);
            if (message.type === 'files.request') {
              const { data, ...params } = message.params;
              qa.fileWire.push({
                at: performance.now(),
                direction: 'out',
                ...message,
                params: { ...params, ...(data ? { dataBytes: data.length } : {}) },
              });
            }
          }
          return send(raw);
        };
        qa.channels.push(channel);
        if (channel.label === 'remotekit') {
          const role = this.getTransceivers().length ? 'browser' : 'service';
          qa[role] = { peer: this, channel };
          if (role === 'browser') qa.channel = channel;
        }
        channel.addEventListener('message', receive);
        return channel;
      }
    };
    qa.call = (method, params, rtc, id) =>
      new Promise((done, reject) => {
        const timer = setTimeout(() => {
          qa.pending.delete(id);
          reject(Error('Viewer RPC timeout: ' + method));
        }, 20000);
        qa.pending.set(id, (message) => {
          clearTimeout(timer);
          qa.pending.delete(id);
          done(message);
        });
        const message = rtc
          ? {
              type: 'files.request',
              version: 1,
              requestId: id,
              method,
              params,
              authEpoch: method.startsWith('selection.') ? qa.auth.peerEpoch : qa.auth.serviceEpoch,
            }
          : { id, method, params };
        (rtc ? qa[method.startsWith('selection.') ? 'browser' : 'service'].channel : qa.socket).send(
          JSON.stringify(message),
        );
      });
  });
  const page = await context.newPage();
  page.on(
    'console',
    (message) =>
      void appendFile(
        join(evidence, name + '-console.jsonl'),
        JSON.stringify({ type: message.type(), text: message.text() }) + '\n',
      ),
  );
  page.on(
    'pageerror',
    (error) =>
      void appendFile(join(evidence, name + '-console.jsonl'), JSON.stringify({ error: error.stack }) + '\n'),
  );
  const call = async (method, params = {}, rtc = false) => {
    if (rtc)
      await page.waitForFunction((selection) => {
        const role = selection ? 'browser' : 'service';
        const epoch = selection ? clusterQA.auth?.peerEpoch : clusterQA.auth?.serviceEpoch;
        return clusterQA[role]?.channel.readyState === 'open' && epoch > 0;
      }, method.startsWith('selection.'));
    const reply = await page.evaluate(
      ({ method, params, rtc, id }) => clusterQA.call(method, params, rtc, id),
      { method, params, rtc, id: randomUUID() },
    );
    assert(
      !reply.error && reply.ok !== false && Object.hasOwn(reply, 'result'),
      method + ': ' + JSON.stringify(reply),
    );
    return reply.result;
  };
  return {
    context,
    page,
    call,
    state: () => page.evaluate(() => clusterQA.state),
    async action(action) {
      const operationId = randomUUID();
      const { operationGeneration } = await this.state();
      const receipt = await call('operation.submit', { operationId, operationGeneration, action });
      assert(receipt.status !== 'failed', JSON.stringify(receipt));
      if (receipt.status === 'committed') return;
      await until('action ' + action.type, async () => {
        const receipt = await call('operation.status', { operationId, operationGeneration });
        assert(receipt.status !== 'failed', JSON.stringify(receipt));
        return receipt.status === 'committed';
      });
    },
    async ready(timeout = 45000) {
      await page.waitForFunction(
        () =>
          clusterQA.socket?.readyState === WebSocket.OPEN &&
          clusterQA.state &&
          clusterQA.auth?.locked === false,
        undefined,
        { timeout },
      );
    },
    async media() {
      return until('H264 decoded', () =>
        page.evaluate(async () => {
          const peer = clusterQA.browser?.peer;
          if (peer?.connectionState !== 'connected') return false;
          const stats = await peer.getStats();
          const video = [...stats.values()].find(
            (s) => s.type === 'inbound-rtp' && s.kind === 'video' && s.framesDecoded > 0,
          );
          return (
            video &&
            /h264/i.test(stats.get(video.codecId)?.mimeType) && {
              framesDecoded: video.framesDecoded,
              codec: stats.get(video.codecId).mimeType,
              stats: [...stats.values()],
            }
          );
        }),
      );
    },
  };
}
