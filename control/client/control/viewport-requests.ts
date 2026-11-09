import { retryDelay } from '../../shared/error-policy';
import { RemoteKitError } from '../../shared/errors';
import type { ProductState, ViewerViewport } from '../../shared/product';
import { formatError } from '../util/format-error';
import { diagnostics } from '../media/diagnostics';
import { canonicalJson } from '../util/canonical-json';
import { Store } from '../util/store';
import { selectVisibility } from '../app/visibility';
import { currentWindowFullscreen } from '../app/window-fullscreen';

export class ViewportRequests extends Store<string> {
  private readonly geometry = new Map<string, { width: number; height: number }>();
  private timer?: ReturnType<typeof setTimeout>;
  private serial = 0;
  private acknowledged?: string;
  private pending?: string;
  private attempts = 0;
  private failedKey?: string;
  private retry?: { key: string; at: number };
  private attemptKey?: string;
  private state: ProductState | null = null;
  private bounds = { width: 0, height: 0 };
  private dpr = 1;
  private visible = true;
  private available = false;
  constructor(private readonly request: (params: ViewerViewport) => Promise<unknown>) {
    super('');
  }
  observe(state: ProductState | null, available: boolean) {
    if (this.state === state && this.available === available) return;
    this.state = state;
    this.available = available;
    this.schedule();
  }
  measure(width: number, height: number, dpr: number, visible: boolean) {
    this.bounds = { width, height };
    this.dpr = dpr;
    this.visible = visible;
    this.schedule();
  }
  setGeometry = (id: string, width: number, height: number) => {
    const previous = this.geometry.get(id);
    if (previous?.width === width && previous.height === height) return;
    this.geometry.set(id, { width, height });
    this.schedule();
  };
  reset() {
    this.serial++;
    this.acknowledged = undefined;
    this.pending = undefined;
    this.failedKey = undefined;
    this.attempts = 0;
    this.retry = undefined;
    this.attemptKey = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.state = null;
    this.geometry.clear();
    this.publish('');
  }
  dismissNotice() {
    this.publish('');
  }
  private schedule() {
    clearTimeout(this.timer);
    if (!this.state || !this.available || this.bounds.width <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const state = this.state;
      if (!state || !this.available) return;
      const visibility = selectVisibility(state, this.bounds.width, currentWindowFullscreen());
      const params: ViewerViewport = {
        devicePixelRatio: this.dpr,
        windows: state.workspace.windows.map((window) => ({
          windowId: window.id,
          width: this.geometry.get(window.id)?.width ?? Math.max(1, Math.round(this.bounds.width)),
          height: this.geometry.get(window.id)?.height ?? Math.max(1, Math.round(this.bounds.height) - 88),
          visible:
            this.visible &&
            visibility.visibleWindowIds.includes(window.id) &&
            state.workspace.tabs.some((tab) => tab.id === window.activeTabId && tab.kind === 'remote'),
        })),
      };
      const key = canonicalJson(params);
      if (
        key === this.failedKey ||
        key === this.pending ||
        (this.pending === undefined && key === this.acknowledged)
      )
        return;
      if (this.attemptKey !== key) {
        this.attempts = 0;
        this.retry = undefined;
        this.attemptKey = key;
      }
      if (this.retry?.key === key && this.retry.at > Date.now()) {
        this.timer = setTimeout(() => this.schedule(), this.retry.at - Date.now());
        return;
      }
      this.pending = key;
      const serial = ++this.serial;
      void this.request(params)
        .then(() => {
          if (serial === this.serial) {
            this.pending = undefined;
            this.acknowledged = key;
            this.publish('');
            this.attempts = 0;
            this.retry = undefined;
            this.failedKey = undefined;
            this.schedule();
          }
        })
        .catch((error) => {
          if (serial === this.serial) {
            this.pending = undefined;
            this.acknowledged = undefined;
          }
          diagnostics.record('viewport', error);
          if (serial !== this.serial) return;
          const failure =
            error instanceof RemoteKitError ? error : new RemoteKitError('internal', '画面尺寸更新失败');
          const delay = retryDelay(failure, this.attempts++);
          if (delay !== undefined && this.attempts <= 4) {
            this.retry = { key, at: Date.now() + delay };
            this.timer = setTimeout(() => {
              this.timer = undefined;
              this.schedule();
            }, delay);
            return;
          }
          this.failedKey = key;
          if (serial === this.serial && this.available)
            this.publish(
              formatError(
                error instanceof RemoteKitError ? error : new RemoteKitError('internal', '画面尺寸更新失败'),
              ),
            );
        });
    }, 100);
  }
}
