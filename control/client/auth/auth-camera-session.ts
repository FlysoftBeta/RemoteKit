import { RemoteKitError } from '../../shared/errors';
import type { AuthSocketMethods, AuthState, FacePurpose } from '../../shared/security';
import { diagnostics } from '../media/diagnostics';
import { Store } from '../util/store';
import type { AuthorizationScope } from './authorization-scope';

export type AuthRequest = <K extends keyof AuthSocketMethods>(
  method: K,
  params: AuthSocketMethods[K]['params'],
) => Promise<AuthState>;
interface CameraState {
  stream?: MediaStream;
  explicit?: FacePurpose;
}
export interface CameraOptions {
  auth: AuthState | null;
  online: boolean;
  manualLock: boolean;
  allowAutomaticVerification: boolean;
  onDepartureObserved(): void;
}
export interface CameraEnvironment {
  open(): Promise<MediaStream>;
  permission(): Promise<PermissionState | undefined>;
  hidden(): boolean;
  watchVisibility(listener: () => void): () => void;
  now(): number;
}
const browserCamera: CameraEnvironment = {
  open: () => {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new RemoteKitError('unavailable', 'Camera capture requires HTTPS and browser support');
    return navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'user' },
        width: { ideal: 480, max: 640 },
        height: { ideal: 360, max: 480 },
        frameRate: { ideal: 5, max: 5 },
      },
      audio: false,
    });
  },
  permission: async () => {
    try {
      const state = (await navigator.permissions?.query({ name: 'camera' as PermissionName }))?.state;
      if (state === 'granted' || state === 'denied') return state;
    } catch (error) {
      diagnostics.record('auth-camera-permission', error);
    }
    // Some browsers cannot query the camera permission, or report 'prompt' while this page still
    // holds a grant. Device labels are exposed once the page holds a camera grant.
    const devices = await navigator.mediaDevices?.enumerateDevices?.();
    return devices?.some((device) => device.kind === 'videoinput' && device.label) ? 'granted' : 'prompt';
  },
  hidden: () => document.hidden,
  watchVisibility: (listener) => {
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
  now: () => performance.now(),
};
function stopStream(stream?: MediaStream) {
  stream?.getTracks().forEach((track) => track.stop());
}
function cameraError(error: unknown) {
  if (error instanceof RemoteKitError) return error;
  const code =
    error instanceof DOMException && error.name === 'NotAllowedError' ? 'forbidden' : 'unavailable';
  return new RemoteKitError(code, 'Camera capture failed', String(error));
}
type CameraPort = Pick<AuthorizationScope, 'authCameraReady' | 'setAuthCamera' | 'recentAuthCameraFrame'>;

export class AuthCameraSession extends Store<CameraState> {
  private options?: CameraOptions;
  private active?: MediaStream;
  private explicit?: FacePurpose;
  private generation = 0;
  private challenge?: string;
  private manualPresence?: string;
  private departureReported?: string;
  private automaticPending = false;
  private retryAt = 0;
  private timer?: ReturnType<typeof setInterval>;
  private unwatch?: () => void;
  constructor(
    private readonly port: CameraPort,
    private readonly request: AuthRequest,
    private readonly environment: CameraEnvironment = browserCamera,
  ) {
    super({});
  }

  configure(options: CameraOptions) {
    const previous = this.options;
    this.options = options;
    if (!this.unwatch) {
      this.unwatch = this.environment.watchVisibility(() => {
        if (this.environment.hidden()) this.cancel();
        else void this.poll();
      });
      this.timer = setInterval(() => void this.poll(), 1000);
    }
    if (
      !options.online ||
      !this.port.authCameraReady ||
      this.environment.hidden() ||
      (previous && previous.auth?.epoch !== options.auth?.epoch) ||
      (previous && previous.auth?.peerEpoch !== options.auth?.peerEpoch) ||
      (this.explicit === 'verify' && options.auth?.locked !== true) ||
      (this.explicit === 'enroll' && options.auth?.locked !== false)
    )
      this.cancel();
    if (previous && !this.explicit && this.desired(previous) !== this.desired(options)) this.cancel();
    const face = options.auth?.face;
    if (
      options.manualLock &&
      face?.purpose === 'presence' &&
      face.status === 'absent' &&
      face.reason === 'no-matching-face' &&
      face.challengeId &&
      face.challengeId === this.manualPresence &&
      this.departureReported !== face.challengeId
    ) {
      const track = this.active?.getVideoTracks()[0];
      if (track?.readyState === 'live' && !track.muted && this.port.recentAuthCameraFrame(face.challengeId)) {
        this.departureReported = face.challengeId;
        options.onDepartureObserved();
      }
    }
    if (
      this.explicit &&
      face?.purpose === this.explicit &&
      ['expired', 'failed', 'absent', 'enrolled'].includes(face.status ?? '') &&
      this.active
    )
      this.stop();
    this.syncSource();
    void this.poll();
  }
  private emit() {
    const previous = this.getSnapshot();
    if (previous.stream !== this.active || previous.explicit !== this.explicit)
      this.publish({ stream: this.active, explicit: this.explicit });
  }
  private stop() {
    this.generation++;
    this.port.setAuthCamera();
    stopStream(this.active);
    this.active = undefined;
    this.emit();
  }
  private cancelChallenge(id?: string) {
    if (id)
      void this.request('auth.face.cancel', { challengeId: id }).catch((error) =>
        diagnostics.record('auth-camera-cancel', error),
      );
  }
  cancel = () => {
    const id = this.challenge;
    this.challenge = undefined;
    this.explicit = undefined;
    this.stop();
    this.cancelChallenge(id);
  };
  dispose = () => {
    clearInterval(this.timer);
    this.timer = undefined;
    this.unwatch?.();
    this.unwatch = undefined;
    this.options = undefined;
    this.cancel();
  };
  private async open(explicitly: boolean, current: number) {
    if (this.active?.getVideoTracks()[0]?.readyState === 'live') return;
    if (!explicitly && (await this.environment.permission()) !== 'granted')
      throw new RemoteKitError('forbidden', 'Camera permission has not been granted');
    if (current !== this.generation) return;
    const next = await this.environment.open();
    if (current !== this.generation) {
      stopStream(next);
      return;
    }
    const track = next.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') {
      stopStream(next);
      throw new RemoteKitError('unavailable', 'Camera has no live video track');
    }
    stopStream(this.active);
    this.active = next;
    track.addEventListener(
      'ended',
      () => {
        if (this.active === next) this.stop();
      },
      { once: true },
    );
    this.emit();
    this.syncSource();
  }
  start = async (purpose: 'verify' | 'enroll', currentPassword?: string) => {
    if (!this.options?.online || !this.port.authCameraReady)
      throw new RemoteKitError('unavailable', 'Face verification channel is not ready');
    const current = ++this.generation;
    const old = this.challenge;
    this.challenge = undefined;
    this.explicit = purpose;
    this.port.setAuthCamera();
    this.emit();
    try {
      await this.open(true, current);
      if (current !== this.generation) return;
      if (old)
        await this.request('auth.face.cancel', { challengeId: old }).catch((error) =>
          diagnostics.record('auth-camera-cancel', error),
        );
      if (current !== this.generation) return;
      const next = await this.request('auth.face.begin', { purpose, currentPassword });
      if (current !== this.generation) {
        this.cancelChallenge(next.face.challengeId);
        return;
      }
      this.challenge = next.face.challengeId;
      this.syncSource();
    } catch (error) {
      if (current !== this.generation) return;
      this.cancel();
      throw cameraError(error);
    }
  };
  private desired(options = this.options): FacePurpose | undefined {
    const auth = options?.auth;
    if (!options?.online || !auth || !auth.face.available || !auth.settings.faceEnabled || !auth.methods.face)
      return;
    if (auth.locked)
      return options.allowAutomaticVerification ? (options.manualLock ? 'presence' : 'verify') : undefined;
    return auth.settings.lockOnDeparture ? 'presence' : undefined;
  }
  private syncSource() {
    const options = this.options,
      face = options?.auth?.face,
      peerEpoch = options?.auth?.peerEpoch;
    if (
      options?.online &&
      this.port.authCameraReady &&
      this.active &&
      face?.challengeId &&
      face.challengeId === this.challenge &&
      face.status === 'pending' &&
      peerEpoch &&
      !this.environment.hidden()
    )
      this.port.setAuthCamera(this.active, { challengeId: face.challengeId, authEpoch: peerEpoch });
    else this.port.setAuthCamera();
  }
  private poll = async () => {
    if (!this.options?.online || this.explicit || this.automaticPending || this.environment.hidden()) return;
    const desired = this.desired();
    if (!desired) {
      if (this.active) this.stop();
      return;
    }
    if (!this.port.authCameraReady || this.environment.now() < this.retryAt) return;
    const face = this.options.auth?.face;
    if (face?.challengeId && face.purpose === desired && face.status === 'pending' && this.active) return;
    this.automaticPending = true;
    const current = this.generation;
    try {
      await this.open(false, current);
      if (current !== this.generation || desired !== this.desired()) return;
      if (face?.challengeId && face.status === 'pending')
        await this.request('auth.face.cancel', { challengeId: face.challengeId }).catch((error) =>
          diagnostics.record('auth-camera-cancel', error),
        );
      if (current !== this.generation || desired !== this.desired()) return;
      const next = await this.request('auth.face.begin', { purpose: desired });
      if (current !== this.generation || desired !== this.desired()) {
        this.cancelChallenge(next.face.challengeId);
        return;
      }
      this.challenge = next.face.challengeId;
      if (this.options?.manualLock && desired === 'presence') this.manualPresence = next.face.challengeId;
      this.syncSource();
    } catch (error) {
      diagnostics.record('auth-camera', cameraError(error));
    } finally {
      this.retryAt = this.environment.now() + 2500;
      this.automaticPending = false;
    }
  };
}
