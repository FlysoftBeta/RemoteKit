import { diagnostics } from './media/diagnostics';
import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_IDLE_SECONDS, type AuthState } from '../shared/security';

interface IdleMonitor extends EventTarget {
  userState: 'active' | 'idle' | null;
  screenState: 'locked' | 'unlocked' | null;
  start(options: { threshold: number; signal: AbortSignal }): Promise<void>;
}
const IdleDetector = (
  globalThis as typeof globalThis & {
    IdleDetector?: { new (): IdleMonitor; requestPermission(): Promise<PermissionState> };
  }
).IdleDetector;

export function useAutoLock(auth: AuthState | null, lock: (reason: string) => void) {
  const [permission, setPermission] = useState<PermissionState>();
  const [blocked, setBlocked] = useState(false);
  const [system, setSystem] = useState(false);
  const requestSystem = useCallback(async () => {
    if (IdleDetector) setPermission(await IdleDetector.requestPermission());
  }, []);
  const enabled = auth?.settings.lockOnIdle === true;
  const lockOnHidden = auth?.settings.lockOnHidden === true;
  const locked = auth?.locked !== false;
  const idleSeconds = auth?.settings.idleSeconds ?? DEFAULT_IDLE_SECONDS;

  useEffect(() => {
    if (!IdleDetector) return;
    let live = true;
    let watched: PermissionStatus | undefined;
    const update = () => {
      if (live) setPermission(watched?.state);
    };
    void navigator.permissions
      ?.query({ name: 'idle-detection' as PermissionName })
      .then((result) => {
        if (!live) return;
        watched = result;
        result.addEventListener('change', update);
        update();
      })
      .catch((error) => diagnostics.record('auth-idle', error));
    return () => {
      live = false;
      watched?.removeEventListener('change', update);
    };
  }, []);

  useEffect(() => {
    if (!IdleDetector || permission !== 'granted' || !enabled) return;
    const controller = new AbortController();
    const monitor = new IdleDetector();
    const change = () => {
      const away = monitor.screenState === 'locked' || monitor.userState === 'idle';
      setBlocked(away);
      if (away) lock(monitor.screenState === 'locked' ? 'system' : 'idle');
    };
    monitor.addEventListener('change', change);
    void monitor
      .start({ threshold: Math.max(60, idleSeconds) * 1000, signal: controller.signal })
      .then(() => {
        if (!controller.signal.aborted) {
          setSystem(true);
          change();
        }
      })
      .catch((error) => diagnostics.record('auth-idle', error));
    return () => {
      controller.abort();
      monitor.removeEventListener('change', change);
      setSystem(false);
      setBlocked(false);
    };
  }, [enabled, idleSeconds, lock, permission]);

  useEffect(() => {
    if (locked || !enabled || (system && idleSeconds >= 60)) return;
    let lastActivity = performance.now();
    const activity = () => {
      lastActivity = performance.now();
    };
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'input'] as const;
    for (const event of events) window.addEventListener(event, activity, { capture: true, passive: true });
    const timer = setInterval(() => {
      if (performance.now() - lastActivity >= idleSeconds * 1000) lock('idle');
    }, 1000);
    return () => {
      clearInterval(timer);
      for (const event of events) window.removeEventListener(event, activity, true);
    };
  }, [enabled, idleSeconds, lock, locked, system]);

  useEffect(() => {
    if (locked || !lockOnHidden) return;
    const hidden = () => {
      if (document.hidden) lock('hidden');
    };
    document.addEventListener('visibilitychange', hidden);
    hidden();
    return () => document.removeEventListener('visibilitychange', hidden);
  }, [lock, lockOnHidden, locked]);

  return { systemSupported: !!IdleDetector, system, requestSystem, blocked };
}
