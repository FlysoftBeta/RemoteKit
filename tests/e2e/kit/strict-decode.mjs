import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

// Observe protocol rejections without changing requests, replies or input delivery.
export async function recordStrictDecodeRejections(context, run) {
  await context.exposeBinding('__rkRecordStrictDecodeRejection', ({ page }, record) => {
    appendFileSync(
      join(run, 'strict-decode-rejections.jsonl'),
      JSON.stringify({ page: page.url(), ...record }) + '\n',
    );
  });
  await context.addInitScript(() => {
    const histories = new WeakMap();
    const history = (transport) => {
      if (!histories.has(transport)) histories.set(transport, []);
      return histories.get(transport);
    };
    const parse = (raw) => {
      if (typeof raw !== 'string') return;
      try {
        return JSON.parse(raw);
      } catch {}
    };
    const sent = (transport, raw) => {
      const message = parse(raw);
      if (!message) return;
      const messages = history(transport);
      messages.push(message);
      if (messages.length > 200) messages.shift();
    };
    const scrub = (value, key = '') => {
      if (/password|token|secret|credential/i.test(key)) return '[redacted]';
      if (typeof value === 'string' && value.length > 2048) return value.slice(0, 2048) + '…';
      if (Array.isArray(value)) return value.slice(0, 200).map((item) => scrub(item));
      if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, scrub(item, name)]));
      return value;
    };
    const received = (transport, raw, channel) => {
      const reply = parse(raw);
      if (reply?.error?.code !== 'invalid_request') return;
      const request = history(transport).findLast((message) =>
        reply.focusRequestId
          ? message.focusRequestId === reply.focusRequestId
          : reply.clientSequence
            ? message.sequence === reply.clientSequence
            : reply.id
              ? message.id === reply.id
              : reply.requestId
                ? message.requestId === reply.requestId
                : false,
      );
      void window
        .__rkRecordStrictDecodeRejection({
          channel,
          method: request?.method ?? (request?.type === 'editing.dismiss' ? 'input' : request?.type),
          request: scrub(request),
          reply: scrub(reply),
        })
        .catch(() => {});
    };
    const NativeSocket = WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', (event) => received(this, event.data, 'websocket'));
      }
      send(raw) {
        sent(this, raw);
        return super.send(raw);
      }
    };
    const observed = new WeakSet();
    const observe = (channel) => {
      if (observed.has(channel)) return channel;
      observed.add(channel);
      channel.addEventListener('message', (event) => received(channel, event.data, 'datachannel'));
      return channel;
    };
    const nativeSend = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (raw) {
      sent(this, raw);
      return nativeSend.call(this, raw);
    };
    const NativePeer = RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(...args) {
        super(...args);
        this.addEventListener('datachannel', (event) => observe(event.channel));
      }
      createDataChannel(...args) {
        return observe(super.createDataChannel(...args));
      }
    };
  });
}
