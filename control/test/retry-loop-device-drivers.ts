import { PhotoJobStore } from '../client/files/photo-job-store';
import { AuthCameraSession, type CameraOptions } from '../client/auth/auth-camera-session';
import type { AuthState } from '../shared/security';
import type { LibrarySnapshot } from '../shared/file-library';
import type { Surface } from '../client/presentation/types';
import { inputFixture } from './client-fixture';
import { type OwnerFactory } from './retry-loop-boundary';
import { wireError, toRemoteKitError } from '../shared/errors';
import type { CapturedBurst } from '../client/files/camera-capture';

const library: LibrarySnapshot = {
  revision: 1,
  entries: [],
  basket: [],
  partitions: [],
  sources: [],
  excludedSources: [],
  basketPartitionId: null,
};

export function drivePhotoStage(stage: 'upload' | 'commit'): OwnerFactory {
  return (boundary) => {
    const asset = { assetId: 'a'.repeat(64), size: 1, type: 'image/jpeg' };
    const owner = new PhotoJobStore({
      latestSnapshot: () => library,
      rpc: {
        uploadAsset: (file, identity) =>
          stage === 'upload' ? boundary.call({ name: file.name, identity }, asset) : Promise.resolve(asset),
        processPhoto: async () => ({
          ...asset,
          type: 'image/webp',
          geometry: 'unchanged',
          quarterTurns: 0,
          orientation: 'none',
        }),
      },
      mutate: (method, params) =>
        stage === 'commit' ? boundary.call({ method, params }, library) : Promise.resolve(library),
    });
    const burst: CapturedBurst = {
      frames: [
        { frameId: 'frame', blob: new Blob(['image']), preview: new Blob(['preview']), width: 1, height: 1 },
      ],
      decision: {
        selectedFrameId: 'frame',
        keepFrameIds: ['frame'],
        candidates: [],
        uncertain: false,
        stop: true,
        reason: 'quality',
      },
      stats: { samplingMs: 1, frameCount: 1, stopReason: 'quality', sourceWidth: 1, sourceHeight: 1 },
    };
    const run = () => {
      owner.configure(true, 'viewer-' + boundary.version);
      const job = owner.reserve(
        { destination: 'basket', origin: { kind: 'request', requestId: 'chooser' } },
        'photo',
      )!;
      owner.capture(job.id, Promise.resolve(burst));
    };
    return {
      start: run,
      drive: () => {},
      changeInput: () => {
        boundary.version++;
        run();
      },
      error: () => owner.getSnapshot()[0]?.error,
      dispose: owner.dispose,
    };
  };
}

export const drivePhoto: OwnerFactory = (boundary) => {
  const entry = {
    kind: 'file' as const,
    available: true,
    id: 'entry',
    assetId: 'c'.repeat(64),
    originalAssetId: 'a'.repeat(64),
    name: 'photo.webp',
    type: 'image/webp',
    size: 1,
    createdAt: 1,
    source: { app: 'files', channel: 'camera' },
    partitionId: null,
    collected: false,
    photo: { mode: 'photo' as const },
  };
  const snapshot = { ...library, entries: [entry], basket: ['entry'] };
  const owner = new PhotoJobStore({
    latestSnapshot: () => snapshot,
    mutate: async () => snapshot,
    rpc: {
      uploadAsset: async () => ({ assetId: 'a'.repeat(64), type: 'image/jpeg', size: 1 }),
      processPhoto: (asset, mode, turns) =>
        boundary.call(
          { asset, mode, turns },
          {
            assetId: 'b'.repeat(64),
            type: 'image/webp',
            size: 1,
            width: 4,
            height: 3,
            geometry: 'unchanged',
            quarterTurns: turns ?? 0,
            orientation: 'none',
          },
        ),
    },
  });
  owner.configure(true, 'viewer');
  return {
    start: () => owner.rotate(entry, 'basket'),
    drive: () => {},
    changeInput: () => owner.rotate(entry, 'basket'),
    error: () => owner.getSnapshot()[0]?.error,
    dispose: owner.dispose,
  };
};

export const driveCamera: OwnerFactory = (boundary) => {
  const auth: AuthState = {
    user: { id: 'user', username: 'viewer', isAdmin: false },
    locked: true,
    epoch: 1,
    peerEpoch: 1,
    serviceEpoch: 1,
    methods: { password: true, pin: false, face: true },
    settings: {
      lockOnIdle: false,
      lockOnHidden: false,
      idleSeconds: 300,
      lockOnDeparture: true,
      faceEnabled: true,
    },
    face: { available: true, enrolled: true },
    endpointGeneration: 1,
  };
  const track = Object.assign(new EventTarget(), { readyState: 'live', muted: false, stop: () => {} });
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  const owner = new AuthCameraSession(
    { authCameraReady: true, setAuthCamera: () => {}, recentAuthCameraFrame: () => true },
    (method, params) =>
      method === 'auth.face.begin'
        ? boundary.call(
            { method, params },
            {
              ...auth,
              face: { ...auth.face, challengeId: 'challenge', purpose: 'verify', status: 'pending' },
            },
          )
        : Promise.resolve(auth),
    {
      open: async () => stream,
      permission: async () => 'granted',
      hidden: () => false,
      watchVisibility: () => () => {},
      now: () => Date.now(),
    },
  );
  const options: CameraOptions = {
    auth,
    online: true,
    manualLock: false,
    allowAutomaticVerification: true,
    onDepartureObserved: () => {},
  };
  const run = () => owner.configure(options);
  return {
    start: run,
    drive: run,
    changeInput: () => {
      options.auth = { ...auth, epoch: 2 };
      run();
    },
    error: () => owner.failure,
    dispose: owner.dispose,
  };
};

export const driveFocus: OwnerFactory = (boundary) => {
  const fixture = inputFixture();
  const surface: Surface = {
    id: 'view',
    session: 'session',
    instance: 'instance',
    document: 'document',
    focus: '1',
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    deviceScaleFactor: 1,
  };
  fixture.presentation.layout = {
    type: 'layout',
    generation: '1',
    epoch: '1',
    width: 640,
    height: 480,
    views: [surface],
  };
  const channel = {
    readyState: 'open',
    bufferedAmount: 0,
    close: () => {},
    onmessage: undefined as ((event: { data: string }) => void) | undefined,
    send(data: string) {
      const message = JSON.parse(data);
      if (message.type !== 'focus') return;
      void boundary.call(message, undefined).then(
        () =>
          channel.onmessage?.({
            data: JSON.stringify({
              type: 'focus',
              ok: true,
              focusRequestId: message.focusRequestId,
              layoutEpoch: message.layoutEpoch,
              token: {
                view: message.view,
                session: message.session,
                instance: message.instance,
                document: message.document,
                focus: message.focus,
              },
            }),
          }),
        (error: unknown) =>
          channel.onmessage?.({
            data: JSON.stringify({
              type: 'focus',
              ok: false,
              focusRequestId: message.focusRequestId,
              layoutEpoch: message.layoutEpoch,
              error: wireError(toRemoteKitError(error)),
            }),
          }),
      );
    },
  };
  fixture.endpoint.bindChannel(channel as unknown as RTCDataChannel);
  const run = () => fixture.input.focus(surface, true);
  return {
    start: run,
    drive: () => {},
    changeInput: () => {
      surface.focus = '2';
      run();
    },
    error: () => fixture.input.inputResults.slice(-1)[0]?.error,
    dispose: () => fixture.endpoint.close(),
  };
};
