import { diagnostics } from './media/diagnostics';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthSocketMethods, AuthState, FacePurpose } from '../shared/security';
import type { ViewerSession } from './viewer-session';

export type AuthRequest = <K extends keyof AuthSocketMethods>(
  method: K,
  params: AuthSocketMethods[K]['params'],
) => Promise<AuthState>;

function stopStream(stream?: MediaStream) {
  stream?.getTracks().forEach((track) => track.stop());
}

function cameraError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return new Error('摄像头访问被阻止，请检查浏览器的网站权限。');
    if (error.name === 'NotFoundError') return new Error('未找到摄像头。');
    if (error.name === 'NotReadableError') return new Error('摄像头暂不可用，请检查设备是否被占用。');
  }
  return error;
}

export function useAuthCamera(
  media: ViewerSession,
  request: AuthRequest,
  auth: AuthState | null,
  online: boolean,
  manualLock: boolean,
  allowAutomaticVerification: boolean,
  onDepartureObserved: () => void,
) {
  const [stream, setStream] = useState<MediaStream>();
  const [explicit, setExplicit] = useState<FacePurpose>();
  const active = useRef<MediaStream | undefined>(undefined);
  const generation = useRef(0);
  const challenge = useRef<string | undefined>(undefined);
  const manualPresence = useRef<string | undefined>(undefined);
  const automaticPending = useRef(false);
  const retryAt = useRef(0);
  const channelReady = media.authorization.authCameraReady;

  const stop = useCallback(() => {
    generation.current++;
    media.authorization.setAuthCamera();
    stopStream(active.current);
    active.current = undefined;
    setStream(undefined);
  }, [media]);

  const cancel = useCallback(() => {
    const id = challenge.current;
    challenge.current = undefined;
    setExplicit(undefined);
    stop();
    if (id)
      void request('auth.face.cancel', { challengeId: id }).catch((error) =>
        diagnostics.record('auth-camera', error),
      );
  }, [request, stop]);

  const open = useCallback(
    async (explicitly: boolean, current: number) => {
      const retained = active.current?.getVideoTracks()[0];
      if (retained?.readyState === 'live') return;
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error('此浏览器或页面不支持摄像头，请通过 HTTPS 使用。');
      if (!explicitly) {
        const permission = await navigator.permissions?.query({ name: 'camera' as PermissionName });
        if (permission?.state !== 'granted') throw new Error('摄像头尚未授权');
      }
      if (current !== generation.current) return;
      const next = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'user' },
          width: { ideal: 320, max: 640 },
          height: { ideal: 240, max: 480 },
          frameRate: { ideal: 5, max: 5 },
        },
        audio: false,
      });
      if (current !== generation.current) {
        stopStream(next);
        return;
      }
      const track = next.getVideoTracks()[0];
      if (!track || track.readyState !== 'live') {
        stopStream(next);
        throw new Error('摄像头没有可用画面');
      }
      stopStream(active.current);
      active.current = next;
      track.addEventListener(
        'ended',
        () => {
          if (active.current !== next) return;
          stop();
        },
        { once: true },
      );
      setStream(next);
    },
    [stop],
  );

  const start = useCallback(
    async (purpose: 'verify' | 'enroll', currentPassword?: string) => {
      if (!channelReady) throw new Error('人脸验证通道尚未就绪，请稍后重试。');
      const current = ++generation.current;
      setExplicit(purpose);
      const old = challenge.current;
      challenge.current = undefined;
      try {
        await open(true, current);
        if (current !== generation.current) return;
        if (old)
          await request('auth.face.cancel', { challengeId: old }).catch((error) =>
            diagnostics.record('auth-camera', error),
          );
        if (current !== generation.current) return;
        const next = await request('auth.face.begin', { purpose, currentPassword });
        if (current !== generation.current) {
          if (next.face.challengeId)
            void request('auth.face.cancel', { challengeId: next.face.challengeId }).catch((error) =>
              diagnostics.record('auth-camera', error),
            );
          return;
        }
        challenge.current = next.face.challengeId;
      } catch (error) {
        if (current !== generation.current) return;
        cancel();
        throw cameraError(error);
      }
    },
    [cancel, channelReady, open, request],
  );

  const locked = auth?.locked;
  const available = auth?.face.available;
  const enabled = auth?.settings.faceEnabled;
  const enrolled = auth?.methods.face;
  const departure = auth?.settings.lockOnDeparture;
  const purpose = auth?.face.purpose;
  const status = auth?.face.status;
  const reason = auth?.face.reason;
  const id = auth?.face.challengeId;
  const epoch = auth?.epoch;
  const peerEpoch = auth?.peerEpoch;
  useEffect(() => {
    if (
      !online ||
      !channelReady ||
      (explicit === 'verify' && locked !== true) ||
      (explicit === 'enroll' && locked !== false)
    )
      cancel();
  }, [cancel, channelReady, explicit, locked, online]);
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) cancel();
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      cancel();
    };
  }, [cancel]);

  useEffect(() => {
    if (
      manualLock &&
      purpose === 'presence' &&
      status === 'absent' &&
      reason === 'no-matching-face' &&
      id &&
      id === manualPresence.current
    ) {
      const track = active.current?.getVideoTracks()[0];
      if (track?.readyState === 'live' && !track.muted && media.authorization.recentAuthCameraFrame(id))
        onDepartureObserved();
    }
  }, [id, manualLock, media, onDepartureObserved, purpose, reason, status]);
  useEffect(() => {
    if (
      !explicit ||
      purpose !== explicit ||
      !['expired', 'failed', 'absent', 'enrolled'].includes(status ?? '')
    )
      return;
    if (active.current) stop();
  }, [explicit, purpose, status, stop]);
  useEffect(() => {
    if (online && channelReady && stream && id && status === 'pending' && peerEpoch && !document.hidden)
      media.authorization.setAuthCamera(stream, { challengeId: id, authEpoch: peerEpoch });
    else media.authorization.setAuthCamera();
  }, [channelReady, id, media, online, peerEpoch, status, stream]);

  useEffect(() => {
    if (explicit || !online || locked === undefined) return;
    const desired =
      available &&
      enabled &&
      enrolled &&
      (locked
        ? allowAutomaticVerification
          ? manualLock
            ? 'presence'
            : 'verify'
          : undefined
        : departure
          ? 'presence'
          : undefined);
    let disposed = false;
    const poll = async () => {
      if (disposed || automaticPending.current || document.hidden) return;
      if (!desired) {
        if (active.current) stop();
        return;
      }
      if (!channelReady || performance.now() < retryAt.current) return;
      if (id && purpose === desired && status === 'pending' && active.current) return;
      automaticPending.current = true;
      const current = generation.current;
      try {
        await open(false, current);
        if (disposed || current !== generation.current) return;
        if (id && status === 'pending')
          await request('auth.face.cancel', { challengeId: id }).catch((error) =>
            diagnostics.record('auth-camera', error),
          );
        if (disposed || current !== generation.current) return;
        const next = await request('auth.face.begin', { purpose: desired });
        if (current !== generation.current) {
          if (next.face.challengeId)
            void request('auth.face.cancel', { challengeId: next.face.challengeId }).catch((error) =>
              diagnostics.record('auth-camera', error),
            );
          return;
        }
        challenge.current = next.face.challengeId;
        if (manualLock && desired === 'presence') manualPresence.current = next.face.challengeId;
      } catch (error) {
        diagnostics.record('auth-camera', error);
      } finally {
        retryAt.current = performance.now() + 2500;
        automaticPending.current = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [
    allowAutomaticVerification,
    available,
    channelReady,
    departure,
    enabled,
    enrolled,
    epoch,
    explicit,
    id,
    locked,
    manualLock,
    online,
    open,
    purpose,
    request,
    status,
    stop,
  ]);

  return { stream, start, cancel, explicit };
}
export type AuthCamera = ReturnType<typeof useAuthCamera>;
