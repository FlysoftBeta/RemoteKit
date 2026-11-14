import { ClockDomain, ClockProbe } from '../client/media/clock-domain';
import { MediaObservations } from '../client/media/observations';
import type { OwnerFactory } from './retry-loop-boundary';

export const driveClockProbe: OwnerFactory = (boundary) => {
  const owner = new ClockProbe(new ClockDomain());
  const run = () => {
    const ping = owner.begin(Date.now(), Date.now());
    if (ping)
      void boundary.call(ping, undefined).then(
        () => owner.complete(ping.requestId, Date.now(), Date.now(), Date.now(), Date.now()),
        (error: unknown) => owner.fail(ping.requestId, error),
      );
  };
  return {
    start: run,
    drive: run,
    changeInput: () => {
      owner.reset();
      run();
    },
    error: () => owner.failure,
    dispose: () => owner.reset(),
  };
};

export const driveMediaStats: OwnerFactory = (boundary) => {
  const makePeer = () =>
    ({
      getStats: () => boundary.call({ sample: 'rtc' }, new Map()),
      getReceivers: () => [],
    }) as unknown as RTCPeerConnection;
  const ports = {
    rtc: { peer: makePeer(), attempt: 0 },
    authorization: { productLocked: false, peerAuthEpoch: 1 },
    presentation: {
      sampleVideoWindows: () => [],
      currentVideoWindows: () => [],
      getRenderingDiagnostics: () => ({}),
      layout: null,
    },
    endpoint: { channel: null },
    input: { inputTrace: [], inputResults: [] },
  };
  const owner = new MediaObservations(ports as unknown as ConstructorParameters<typeof MediaObservations>[0]);
  const run = () => owner.readStats(ports.rtc.peer);
  return {
    start: run,
    drive: run,
    changeInput: () => {
      ports.rtc.peer = makePeer();
      ports.rtc.attempt++;
      owner.reset();
      return run();
    },
    error: () => owner.failures()[0],
    dispose: () => owner.reset(),
  };
};

export const driveMediaFeedback: OwnerFactory = (boundary, t) => {
  t.mock.method(performance, 'now', () => Date.now());
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { visibilityState: 'visible' },
  });
  const makePeer = () =>
    ({ getStats: async () => new Map(), getReceivers: () => [] }) as unknown as RTCPeerConnection;
  const ports = {
    rtc: {
      peer: makePeer(),
      attempt: 0,
      controlRpc: (method: string, params: unknown) =>
        method === 'feedback' ? boundary.call(params, {}) : Promise.resolve({ serverTime: Date.now() }),
    },
    authorization: { productLocked: false, peerAuthEpoch: 1 },
    presentation: {
      sampleVideoWindows: () => [],
      currentVideoWindows: () => [],
      getRenderingDiagnostics: () => ({}),
      layout: null,
    },
    endpoint: { channel: null },
    input: { inputTrace: [], inputResults: [] },
  };
  const owner = new MediaObservations(ports as unknown as ConstructorParameters<typeof MediaObservations>[0]);
  let frame = 0;
  const produce = () => {
    const now = Date.now();
    owner.handle({
      type: 'frame',
      rtpTimestamp: ++frame,
      layoutEpoch: '1',
      captureWallTimeMs: now - 100,
      captureMonotonicMs: now - 100,
      captureClockUncertaintyMs: 1,
      sourceCaptureId: String(frame),
    } as never);
    owner.onPresentation({ rtp: frame, epoch: '1', at: now, wall: now });
  };
  const run = () => {
    produce();
    return owner.readStats(ports.rtc.peer);
  };
  let timer: ReturnType<typeof setTimeout>;
  const begin = () => {
    const now = Date.now();
    owner.latency.calibrate(now, now, now, now, now, now);
    owner.controlClock.calibrate(now, now, now, now, now, now);
    produce();
    timer = setTimeout(() => {
      void run();
    }, 2500);
  };
  return {
    start: begin,
    drive: run,
    changeInput: () => {
      ports.rtc.peer = makePeer();
      ports.rtc.attempt++;
      owner.reset();
      begin();
    },
    error: () => owner.failures()[0],
    dispose: () => {
      clearTimeout(timer);
      owner.reset();
      if (previous) Object.defineProperty(globalThis, 'document', previous);
      else Reflect.deleteProperty(globalThis, 'document');
    },
  };
};
