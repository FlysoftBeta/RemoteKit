import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  AuthCameraSession,
  type AuthRequest,
  type CameraEnvironment,
  type CameraOptions,
} from '../client/auth/auth-camera-session';
import type { AuthState } from '../shared/security';
import { RemoteKitError } from '../shared/errors';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function auth(): AuthState {
  return {
    user: { id: 'user', username: 'viewer', isAdmin: false },
    locked: true,
    epoch: 1,
    peerEpoch: 2,
    methods: { password: true, pin: false, face: true },
    settings: {
      lockOnHidden: true,
      lockOnIdle: false,
      idleSeconds: 300,
      lockOnDeparture: true,
      faceEnabled: true,
    },
    face: { available: true, enrolled: true },
    endpointGeneration: 1,
  };
}
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let hidden = false;
  let visibility!: () => void;
  let stopped = 0;
  const track = Object.assign(new EventTarget(), { readyState: 'live', muted: false, stop: () => stopped++ });
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  const calls: { method: string; params: any }[] = [];
  let begin: () => Promise<AuthState> = async () => ({
    ...auth(),
    face: { ...auth().face, challengeId: 'challenge', purpose: 'verify', status: 'pending' },
  });
  const request = (async (method: string, params: object) => {
    calls.push({ method, params });
    return method === 'auth.face.begin' ? begin() : auth();
  }) as AuthRequest;
  let opens = 0;
  let permission: PermissionState = 'granted';
  const environment: CameraEnvironment = {
    open: async () => {
      opens++;
      return stream;
    },
    permission: async () => permission,
    hidden: () => hidden,
    now: () => 0,
    watchVisibility: (listener) => {
      visibility = listener;
      return () => {
        visibility = () => {};
      };
    },
  };
  const sources: { stream?: MediaStream; binding?: { challengeId: string; authEpoch: number } }[] = [];
  const port = {
    authCameraReady: true,
    setAuthCamera: (source?: MediaStream, binding?: { challengeId: string; authEpoch: number }) =>
      sources.push({ stream: source, binding }),
    recentAuthCameraFrame: () => true,
  };
  const session = new AuthCameraSession(port, request, environment);
  t.after(session.dispose);
  const options: CameraOptions = {
    auth: auth(),
    online: true,
    manualLock: false,
    allowAutomaticVerification: false,
    onDepartureObserved() {},
  };
  return {
    session,
    options,
    port,
    track,
    stream,
    calls,
    sources,
    setBegin: (next: () => Promise<AuthState>) => {
      begin = next;
    },
    setPermission: (next: PermissionState) => {
      permission = next;
    },
    hide: () => {
      hidden = true;
      visibility();
    },
    stopped: () => stopped,
    opens: () => opens,
  };
}

test('camera cancellation retires a late challenge and releases its source', async (t) => {
  const f = fixture(t);
  let resolve!: (value: AuthState) => void;
  f.setBegin(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  f.session.configure(f.options);
  const opening = f.session.start('verify');
  await flush();
  assert.equal(f.session.getSnapshot().stream, f.stream);
  f.hide();
  resolve({ ...auth(), face: { ...auth().face, challengeId: 'late-challenge' } });
  await opening;
  assert.equal(f.stopped(), 1);
  assert.equal(f.session.getSnapshot().stream, undefined);
  assert.equal(f.session.getSnapshot().explicit, undefined);
  assert.ok(
    f.calls.some(
      (call) => call.method === 'auth.face.cancel' && call.params.challengeId === 'late-challenge',
    ),
  );
});

test('automatic verification never prompts for camera permission and respects its retry deadline', async (t) => {
  const f = fixture(t);
  f.setPermission('prompt');
  f.session.configure({ ...f.options, allowAutomaticVerification: true });
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(f.opens(), 0);
  assert.equal(f.calls.length, 0);
});

test('camera source uses the current peer epoch and is released on authorization changes', async (t) => {
  const f = fixture(t);
  f.session.configure(f.options);
  await f.session.start('verify');
  const pending = {
    ...auth(),
    face: {
      ...auth().face,
      challengeId: 'challenge',
      purpose: 'verify' as const,
      status: 'pending' as const,
    },
  };
  f.session.configure({ ...f.options, auth: pending });
  assert.deepEqual(f.sources[f.sources.length - 1], {
    stream: f.stream,
    binding: { challengeId: 'challenge', authEpoch: 2 },
  });
  f.session.configure({ ...f.options, auth: { ...pending, peerEpoch: 3 } });
  assert.equal(f.session.getSnapshot().stream, undefined);
  assert.equal(f.stopped(), 1);
  assert.equal(f.sources[f.sources.length - 1]?.stream, undefined);
});

test('manual presence reports departure only with a live unmuted source and recent frame proof', async (t) => {
  const f = fixture(t);
  let departures = 0;
  const options = {
    ...f.options,
    manualLock: true,
    allowAutomaticVerification: true,
    onDepartureObserved: () => departures++,
  };
  f.session.configure(options);
  await flush();
  const absent = {
    ...auth(),
    face: {
      ...auth().face,
      challengeId: 'challenge',
      purpose: 'presence' as const,
      status: 'absent' as const,
      outcome: 'no_matching_face' as const,
    },
  };
  f.track.muted = true;
  f.session.configure({ ...options, auth: absent });
  assert.equal(departures, 0);
  f.track.muted = false;
  f.session.configure({ ...options, auth: absent });
  f.session.configure({ ...options, auth: absent });
  assert.equal(departures, 1);
});

test('explicit camera failures expose typed errors', async (t) => {
  const f = fixture(t);
  f.port.authCameraReady = false;
  f.session.configure(f.options);
  await assert.rejects(
    f.session.start('verify'),
    (error: unknown) => error instanceof RemoteKitError && error.code === 'unavailable',
  );
});

test('browser camera requests 480 by 360 at five fps without audio', async (t) => {
  const track = Object.assign(new EventTarget(), { readyState: 'live', stop() {} });
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  let constraints: MediaStreamConstraints | undefined;
  const document = Object.assign(new EventTarget(), { hidden: false });
  const navigator = {
    mediaDevices: {
      getUserMedia: async (requested: MediaStreamConstraints) => {
        constraints = requested;
        return stream;
      },
    },
  };
  const restoreGlobals: (() => void)[] = [];
  for (const [name, value] of Object.entries({ document, navigator })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    restoreGlobals.push(() =>
      previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name),
    );
  }
  const session = new AuthCameraSession(
    { authCameraReady: true, setAuthCamera() {}, recentAuthCameraFrame: () => false },
    (async () => auth()) as AuthRequest,
  );
  t.after(() => {
    session.dispose();
    for (const restore of restoreGlobals) restore();
  });
  session.configure({
    auth: auth(),
    online: true,
    manualLock: false,
    allowAutomaticVerification: false,
    onDepartureObserved() {},
  });
  await session.start('verify');
  assert.deepEqual(constraints, {
    video: {
      facingMode: { ideal: 'user' },
      width: { ideal: 480, max: 640 },
      height: { ideal: 360, max: 480 },
      frameRate: { ideal: 5, max: 5 },
    },
    audio: false,
  });
});

test('a final face failure stops automatic verification for the same challenge', async (t) => {
  const f = fixture(t);
  const options = { ...f.options, allowAutomaticVerification: true };
  f.session.configure(options);
  await flush();
  const pending: AuthState = {
    ...auth(),
    face: { ...auth().face, challengeId: 'challenge', purpose: 'verify', status: 'pending' },
  };
  f.session.configure({ ...options, auth: pending });
  await flush();
  const attempts = f.calls.filter((call) => call.method === 'auth.face.begin').length;
  f.session.configure({
    ...options,
    auth: {
      ...pending,
      face: { ...pending.face, status: 'failed', error: { code: 'forbidden', message: '无权验证' } },
    },
  });
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(f.calls.filter((call) => call.method === 'auth.face.begin').length, attempts);
});
