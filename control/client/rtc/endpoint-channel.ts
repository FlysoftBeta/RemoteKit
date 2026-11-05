import { RemoteKitError } from '../../shared/errors';
import { diagnostics } from '../media/diagnostics';
import { decodeIncoming, encodeOutgoing, type Incoming, type Outgoing } from '../rtc/protocol';
import { Events } from '../util/store';

import type { AuthorizationScope } from '../auth/authorization-scope';

export type ChannelEvent = { type: 'bound' | 'open' | 'closed' | 'writable' };
export class EndpointChannel {
  constructor(
    private readonly ports: { authorization: Pick<AuthorizationScope, 'peerAuthEpoch' | 'productLocked'> },
  ) {}
  sendChannel(channel: RTCDataChannel, message: Outgoing) {
    if (this.ports.authorization.peerAuthEpoch === 0) return;
    channel.send(
      encodeOutgoing(
        this.ports.authorization.peerAuthEpoch === undefined
          ? message
          : { ...message, authEpoch: this.ports.authorization.peerAuthEpoch },
      ),
    );
  }

  channel: RTCDataChannel | null = null;

  bindChannel(channel: RTCDataChannel) {
    const previous = this.channel;
    if (previous && previous !== channel) {
      previous.onopen =
        previous.onclose =
        previous.onerror =
        previous.onmessage =
        previous.onbufferedamountlow =
          null;
      previous.close();
    }
    this.channel = channel;
    this.events.emit({ type: 'bound' });
    channel.bufferedAmountLowThreshold = 64 * 1024;
    channel.onbufferedamountlow = () => {
      if (this.channel === channel) this.events.emit({ type: 'writable' });
    };
    channel.onopen = () => {
      if (this.channel === channel) this.events.emit({ type: 'open' });
    };
    channel.onclose = channel.onerror = () => {
      if (this.channel === channel) this.events.emit({ type: 'closed' });
    };
    channel.onmessage = (event) => {
      if (this.channel !== channel) return;
      const message = decodeIncoming(event.data);
      if (message.type === 'decode-error') {
        diagnostics.record('malformed-message', message.reason);
        return;
      }
      if (
        this.ports.authorization.peerAuthEpoch !== undefined &&
        (this.ports.authorization.peerAuthEpoch === 0 ||
          message.authEpoch !== this.ports.authorization.peerAuthEpoch)
      )
        return;
      if (this.ports.authorization.productLocked && message.type !== 'clock.pong') return;
      this.messages.emit(message);
    };
    if (channel.readyState === 'open') channel.onopen(new Event('open'));
  }

  readonly messages = new Events<Incoming>();

  readonly events = new Events<ChannelEvent>();

  send(message: Outgoing) {
    if (this.channel?.readyState !== 'open') throw new RemoteKitError('unavailable', '数据通道未连接');
    this.sendChannel(this.channel, message);
  }

  close() {
    const channel = this.channel;
    this.channel = null;
    if (channel) {
      channel.onopen =
        channel.onclose =
        channel.onerror =
        channel.onmessage =
        channel.onbufferedamountlow =
          null;
      channel.close();
    }
  }

  onRtc = (event: import('./rtc-session').RtcEvent) => {
    if (event.type === 'channel') this.bindChannel(event.channel);
    else if (event.type === 'closed') this.close();
  };
}
