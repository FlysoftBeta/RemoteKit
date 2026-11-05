import { diagnostics } from '../media/diagnostics';
import { useEffect } from 'react';

/** Arm once on opening or reactivating the Viewer. A browser may require a gesture. */
export function useAutoFullscreen(enabled: boolean) {
  useEffect(() => {
    const target = document.documentElement;
    if (!enabled || !document.fullscreenEnabled || !target.requestFullscreen) return;
    let armed = false,
      pending = false,
      inactive = true;

    const attempt = async () => {
      if (!armed || pending || inactive || document.fullscreenElement) return;
      pending = true;
      try {
        await target.requestFullscreen();
        armed = false;
      } catch (error) {
        diagnostics.record('use-auto-fullscreen', error);
      } finally {
        pending = false;
      }
    };
    const deactivate = () => {
      inactive = true;
      armed = false;
    };
    const activate = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      if (!inactive) return;
      inactive = false;
      armed = !document.fullscreenElement;
      void attempt();
    };
    const visibility = () => {
      if (document.visibilityState === 'visible') activate();
      else deactivate();
    };
    const gesture = (event: Event) => {
      if (
        event.isTrusted &&
        (event.type !== 'keydown' || (event as KeyboardEvent).key !== 'Escape') &&
        navigator.userActivation?.isActive !== false
      )
        void attempt();
    };
    const fullscreen = () => {
      armed = false;
    };
    window.addEventListener('focus', activate);
    window.addEventListener('blur', deactivate);
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('fullscreenchange', fullscreen);
    window.addEventListener('pointerup', gesture, true);
    window.addEventListener('keydown', gesture, true);
    activate();
    return () => {
      deactivate();
      window.removeEventListener('focus', activate);
      window.removeEventListener('blur', deactivate);
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('fullscreenchange', fullscreen);
      window.removeEventListener('pointerup', gesture, true);
      window.removeEventListener('keydown', gesture, true);
    };
  }, [enabled]);
}
