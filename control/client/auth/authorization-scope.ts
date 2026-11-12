import { AuthCameraChannel, type CameraBinding } from './auth-camera-channel';

import { Events } from '../util/store';

import type { EndpointChannel } from '../rtc/endpoint-channel';

export class AuthorizationScope {
  constructor(private readonly ports: { endpoint: Pick<EndpointChannel, 'channel'> }) {}
  readonly authCamera = new AuthCameraChannel(() => this.notify());

  get authCameraReady() {
    return this.authCamera.ready;
  }

  setAuthCamera(stream?: MediaStream, binding?: CameraBinding) {
    this.authCamera.setSource(stream, binding);
  }

  recentAuthCameraFrame(challengeId: string) {
    return this.authCamera.hasRecentFrame(challengeId);
  }

  private locked = true;
  get productLocked() {
    return this.locked;
  }

  private epoch: number | undefined = 0;
  get peerAuthEpoch() {
    return this.epoch;
  }

  get browserReady() {
    return (
      !this.productLocked &&
      (this.peerAuthEpoch ?? 0) > 0 &&
      this.ports.endpoint.channel?.readyState === 'open'
    );
  }

  observePeerAuthorization(epoch: number) {
    if (epoch === this.peerAuthEpoch) return;
    this.epoch = epoch;
    this.token++;
    this.resets.emit(this.token);
    this.transitions.emit({ locked: this.locked, token: this.token, epoch });
    this.notify();
  }

  setProductLocked(locked: boolean, force = false) {
    if (!force && locked === this.productLocked) return;
    this.locked = locked;
    if (locked) {
      this.token++;
      this.authCamera.setSource(undefined);
      this.resets.emit(this.token);
    }
    this.transitions.emit({ locked, token: this.token, epoch: this.peerAuthEpoch });
    this.notify();
  }

  token = 0;

  readonly resets = new Events<number>();
  readonly transitions = new Events<{ locked: boolean; token: number; epoch?: number }>();

  notify() {
    this.snapshot = Object.freeze({
      locked: this.productLocked,
      peerEpoch: this.peerAuthEpoch,
      token: this.token,
      browserReady: this.browserReady,
    });
    this.listeners.forEach((listener) => listener());
  }

  private readonly listeners = new Set<() => void>();

  private snapshot: { locked: boolean; peerEpoch?: number; token: number; browserReady: boolean } = {
    locked: true,
    peerEpoch: 0,
    token: 0,
    browserReady: false,
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;
  onChannel = (event: import('../rtc/endpoint-channel').ChannelEvent) => {
    if (event.type !== 'writable') this.notify();
  };
  onRtc = (event: import('../rtc/rtc-session').RtcEvent) => {
    if (event.type === 'closed') {
      this.observePeerAuthorization(0);
    }
  };
  serviceAuthEpoch = 0;
  onServiceRtc = (event: import('../rtc/rtc-session').RtcEvent) => {
    if (event.type === 'authChannel') this.authCamera.bind(event.channel);
    if (event.type === 'closed') {
      this.serviceAuthEpoch = 0;
      this.authCamera.bind(undefined);
    }
    this.notify();
  };
}
