import { DEFAULT_IDLE_SECONDS, type AuthState } from '../../shared/security';
import { diagnostics } from '../media/diagnostics';
import { Store } from '../util/store';

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
interface IdleState {
  systemSupported: boolean;
  system: boolean;
  blocked: boolean;
  permission?: PermissionState;
}

export class IdlePolicy extends Store<IdleState> {
  private enabled = false;
  private locked = true;
  private lockOnHidden = false;
  private idleSeconds = DEFAULT_IDLE_SECONDS;
  private lastActivity = 0;
  private controller?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private permissionStatus?: PermissionStatus;
  private generation = 0;
  private started = false;
  private removeMonitor?: () => void;
  private readonly events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'input'] as const;

  constructor(private readonly lock: (reason: string) => void) {
    super({ systemSupported: !!IdleDetector, system: false, blocked: false });
  }
  configure(auth: AuthState | null) {
    const enabled = auth?.settings.lockOnIdle === true;
    const locked = auth?.locked !== false;
    const idleSeconds = auth?.settings.idleSeconds ?? DEFAULT_IDLE_SECONDS;
    const monitorChanged = enabled !== this.enabled || idleSeconds !== this.idleSeconds;
    const activityChanged = monitorChanged || locked !== this.locked;
    this.enabled = enabled;
    this.locked = locked;
    this.idleSeconds = idleSeconds;
    this.lockOnHidden = auth?.settings.lockOnHidden === true;
    if (!this.started) {
      this.started = true;
      document.addEventListener('visibilitychange', this.hidden);
      for (const event of this.events)
        window.addEventListener(event, this.activity, { capture: true, passive: true });
      this.timer = setInterval(this.poll, 1000);
      this.lastActivity = performance.now();
      const generation = this.generation;
      if (IdleDetector)
        void navigator.permissions
          ?.query({ name: 'idle-detection' as PermissionName })
          .then((status) => {
            if (!this.started || generation !== this.generation) return;
            this.permissionStatus = status;
            status.addEventListener('change', this.permissionChanged);
            this.permissionChanged();
          })
          .catch((error) => diagnostics.record('idle-permission', error));
    }
    if (monitorChanged) this.startMonitor();
    if (activityChanged) this.activity();
    this.hidden();
  }
  requestSystem = async () => {
    if (!IdleDetector) return;
    const generation = this.generation;
    const permission = await IdleDetector.requestPermission();
    if (generation !== this.generation || !this.started) return;
    this.publish({ ...this.getSnapshot(), permission });
    this.startMonitor();
  };
  private permissionChanged = () => {
    this.publish({ ...this.getSnapshot(), permission: this.permissionStatus?.state });
    this.startMonitor();
  };
  private startMonitor() {
    this.controller?.abort();
    this.removeMonitor?.();
    this.removeMonitor = undefined;
    this.publish({ ...this.getSnapshot(), system: false, blocked: false });
    this.activity();
    if (!IdleDetector || !this.enabled || this.getSnapshot().permission !== 'granted') return;
    const controller = new AbortController();
    this.controller = controller;
    const monitor = new IdleDetector();
    const change = () => {
      if (controller.signal.aborted) return;
      const blocked = monitor.screenState === 'locked' || monitor.userState === 'idle';
      this.publish({ ...this.getSnapshot(), blocked });
      if (blocked) this.lock(monitor.screenState === 'locked' ? 'system' : 'idle');
    };
    monitor.addEventListener('change', change);
    this.removeMonitor = () => monitor.removeEventListener('change', change);
    void monitor
      .start({ threshold: Math.max(60, this.idleSeconds) * 1000, signal: controller.signal })
      .then(() => {
        if (controller.signal.aborted) return;
        this.publish({ ...this.getSnapshot(), system: true });
        change();
      })
      .catch((error) => {
        if (!controller.signal.aborted) diagnostics.record('idle-monitor', error);
      });
  }
  private activity = () => {
    this.lastActivity = performance.now();
  };
  private poll = () => {
    if (this.locked || !this.enabled || (this.getSnapshot().system && this.idleSeconds >= 60)) return;
    if (performance.now() - this.lastActivity >= this.idleSeconds * 1000) this.lock('idle');
  };
  private hidden = () => {
    if (!this.locked && this.lockOnHidden && document.hidden) this.lock('hidden');
  };
  dispose = () => {
    this.generation++;
    this.started = false;
    clearInterval(this.timer);
    this.controller?.abort();
    this.removeMonitor?.();
    this.permissionStatus?.removeEventListener('change', this.permissionChanged);
    this.permissionStatus = undefined;
    document.removeEventListener('visibilitychange', this.hidden);
    for (const event of this.events) window.removeEventListener(event, this.activity, true);
    this.publish({ ...this.getSnapshot(), system: false, blocked: false });
  };
}
