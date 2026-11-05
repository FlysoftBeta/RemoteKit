import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AuthState } from '../../shared/security';
import type { ViewerSession } from '../viewer-session';
import { AuthCameraSession, type AuthRequest } from './auth-camera-session';
export type { AuthRequest } from './auth-camera-session';
export function useAuthCamera(
  media: ViewerSession,
  request: AuthRequest,
  auth: AuthState | null,
  online: boolean,
  manualLock: boolean,
  allowAutomaticVerification: boolean,
  onDepartureObserved: () => void,
) {
  const [session] = useState(() => new AuthCameraSession(media.authorization, request));
  const ready = media.authorization.authCameraReady;
  useEffect(
    () => session.configure({ auth, online, manualLock, allowAutomaticVerification, onDepartureObserved }),
    [session, auth, online, ready, manualLock, allowAutomaticVerification, onDepartureObserved],
  );
  useEffect(() => () => session.dispose(), [session]);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return { ...snapshot, start: session.start, cancel: session.cancel };
}
export type AuthCamera = ReturnType<typeof useAuthCamera>;
