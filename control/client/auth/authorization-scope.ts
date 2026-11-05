import { AuthCameraChannel, type CameraBinding } from './auth-camera-channel';

import { Events } from '../util/store';

import type { EndpointChannel } from '../rtc/endpoint-channel';
import type { RtcSession } from '../rtc/rtc-session';

export class AuthorizationScope {
  constructor(
    private readonly ports: { rtc: Pick<RtcSession, 'attempt'>; endpoint: Pick<EndpointChannel, 'channel'> },
  ) {}
  readonly authCamera = new AuthCameraChannel(() => this.notify());

  get authCameraReady() {
    return this.authCamera.ready;
  }

  get cameraDiagnostics() {
    return { peerAttempt: this.ports.rtc.attempt, ...this.authCamera.diagnostics };
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

  get productReady() {
    return (
      !this.productLocked &&
      (this.peerAuthEpoch ?? 0) > 0 &&
      this.ports.endpoint.channel?.readyState === 'open'
    );
  }

  observePeerAuthorization(epoch: number) {
    if (epoch === this.peerAuthEpoch) return;
    this.epoch = epoch;
    this.setProductLocked(true, true);
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
      ready: this.productReady,
    });
    this.listeners.forEach((listener) => listener());
  }

  private readonly listeners = new Set<() => void>();

  private snapshot: { locked: boolean; peerEpoch?: number; token: number; ready: boolean } = {
    locked: true,
    peerEpoch: 0,
    token: 0,
    ready: false,
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
    if (event.type === 'authChannel') this.authCamera.bind(event.channel);
    else if (event.type === 'closed') {
      this.observePeerAuthorization(0);
      this.authCamera.bind(undefined);
    }
  };
}
