import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { until } from './cluster-test-support.mjs';

export async function shellViewer(context, evidence, name) {
  await context.addInitScript(() => {
    const qa = (window.shellQA = { peers: [], pending: new Map(), authFrames: 0, authGrants: 0 });
    const receive = ({ data }) => {
      if (typeof data !== 'string') return;
      const message = JSON.parse(data);
      if (message.type === 'state') qa.state = message.state;
      if (message.type === 'auth') qa.auth = message.auth;
      if (message.type === 'library') qa.library = message.snapshot;
      if (message.type === 'layout') qa.layout = message;
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
        const role = this.getTransceivers().length ? 'browser' : 'service';
        if (channel.label === 'remotekit') qa[role] = { peer: this, channel };
        channel.addEventListener('message', receive);
        if (channel.label === 'remotekit-auth') {
          const send = channel.send.bind(channel);
          channel.send = (bytes) => {
            if (bytes instanceof ArrayBuffer && bytes.byteLength >= 68) {
              const header = new DataView(bytes);
              if (header.getUint32(20, true) + bytes.byteLength - 68 === header.getUint32(24, true))
                qa.authFrames++;
            }
            return send(bytes);
          };
          channel.addEventListener('message', ({ data }) => {
            if (typeof data === 'string' && JSON.parse(data).type === 'auth.camera.frame') qa.authGrants++;
          });
        }
        return channel;
      }
    };
    qa.call = (method, params, files, id) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          qa.pending.delete(id);
          reject(Error('RPC timeout: ' + method));
        }, 25000);
        qa.pending.set(id, (message) => {
          clearTimeout(timer);
          qa.pending.delete(id);
          if (message.type === 'error' || message.ok === false) reject(Error(JSON.stringify(message.error)));
          else resolve(message.result);
        });
        (files
          ? method.startsWith('selection.')
            ? qa.browser.channel
            : qa.service.channel
          : qa.socket
        ).send(
          JSON.stringify(
            files
              ? {
                  type: 'files.request',
                  version: 1,
                  requestId: id,
                  method,
                  params,
                  authEpoch: method.startsWith('selection.') ? qa.auth.peerEpoch : qa.auth.serviceEpoch,
                }
              : { id, method, params },
          ),
        );
      });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => void appendFile(join(evidence, name + '-errors.log'), error.stack + '\n'));
  const call = (method, params = {}, files = false) =>
    page.evaluate(({ method, params, files, id }) => shellQA.call(method, params, files, id), {
      method,
      params,
      files,
      id: randomUUID(),
    });
  return {
    page,
    context,
    call,
    state: () => page.evaluate(() => shellQA.state),
    ready: () => page.waitForFunction(() => shellQA.state && shellQA.auth?.locked === false),
    service: () =>
      page.waitForFunction(
        () => shellQA.service?.channel.readyState === 'open' && shellQA.auth?.serviceEpoch > 0,
      ),
    action: async (action) => {
      const operationId = randomUUID();
      const { operationGeneration } = await page.evaluate(() => shellQA.state);
      let receipt = await call('operation.submit', { operationId, operationGeneration, action });
      if (receipt.status !== 'committed')
        receipt = await until('operation ' + action.type, async () => {
          const current = await call('operation.status', { operationId, operationGeneration });
          assert(current.status !== 'failed', JSON.stringify(current));
          return current.status === 'committed' && current;
        });
      assert.equal(receipt.status, 'committed', JSON.stringify(receipt));
      return receipt;
    },
    media: () =>
      until('browser resumes H264', () =>
        page.evaluate(async () => {
          const peer = shellQA.browser?.peer;
          if (!peer || peer.connectionState !== 'connected') return false;
          const stats = await peer.getStats();
          const video = [...stats.values()].find(
            (entry) => entry.type === 'inbound-rtp' && entry.kind === 'video' && entry.framesDecoded > 0,
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
      ),
  };
}
