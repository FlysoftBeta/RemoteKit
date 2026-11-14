import { RemoteKitError } from '../../shared/errors';
import type { ProductState, ViewerViewport } from '../../shared/product';
import { RetryUnit } from '../../shared/retry-unit';

import { selectVisibility } from '../app/visibility';
import { currentWindowFullscreen } from '../app/window-fullscreen';
import { diagnostics } from '../media/diagnostics';
import { canonicalJson } from '../util/canonical-json';
import { Store } from '../util/store';

export class ViewportRequests extends Store<RemoteKitError | undefined> {
  private readonly geometry = new Map<string, { width: number; height: number }>();
  private occlusion = { viewId: '', bottom: 0 };
  private readonly revisions = new Map<string, { key: string; revision: string }>();
  private revision = BigInt(Date.now()) * 1000n;
  setOcclusion(viewId: string, bottom: number) {
    if (this.occlusion.viewId === viewId && this.occlusion.bottom === bottom) return;
    this.occlusion = { viewId, bottom };
    this.schedule();
  }
  private timer?: ReturnType<typeof setTimeout>;
  private serial = 0;
  private acknowledged?: string;
  private pending?: string;
  private unit = new RetryUnit({
    failed: (error) => diagnostics.record('viewport_failed', error),
    recovered: () => diagnostics.record('viewport_recovered', {}),
  });
  private state: ProductState | null = null;
  private bounds = { width: 0, height: 0 };
  private dpr = 1;
  private visible = true;
  private available = false;
  constructor(private readonly request: (params: ViewerViewport) => Promise<unknown>) {
    super(undefined);
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
    this.unit.close();
    this.unit = new RetryUnit({
      failed: (error) => diagnostics.record('viewport_failed', error),
      recovered: () => diagnostics.record('viewport_recovered', {}),
    });
    clearTimeout(this.timer);
    this.timer = undefined;
    this.state = null;
    this.geometry.clear();
    this.publish(undefined);
  }
  dismissNotice() {
    this.publish(undefined);
  }
  private schedule(delay = 100) {
    clearTimeout(this.timer);
    if (!this.state || !this.available || this.bounds.width <= 0) return;
    const publish = () => {
      this.timer = undefined;
      const state = this.state;
      if (!state || !this.available) return;
      const visibility = selectVisibility(state, this.bounds.width, currentWindowFullscreen());
      const params: ViewerViewport = {
        devicePixelRatio: this.dpr,
        windows: state.workspace.windows.map((window) => {
          const width = this.geometry.get(window.id)?.width ?? Math.max(1, Math.round(this.bounds.width));
          const height =
            this.geometry.get(window.id)?.height ?? Math.max(1, Math.round(this.bounds.height) - 88);
          const visible =
            this.visible &&
            visibility.visibleWindowIds.includes(window.id) &&
            state.workspace.tabs.some((tab) => tab.id === window.activeTabId && tab.kind === 'remote');
          const ownsKeyboard = state.workspace.tabs.some(
            (tab) => tab.id === window.activeTabId && tab.webviewId === this.occlusion.viewId,
          );
          const occludedBottom =
            visible && ownsKeyboard ? Math.min(height, Math.max(0, Math.round(this.occlusion.bottom))) : 0;
          const key = canonicalJson([width, height, visible, occludedBottom]);
          let revision = this.revisions.get(window.id);
          if (revision?.key !== key) {
            revision = { key, revision: String(++this.revision) };
            this.revisions.set(window.id, revision);
          }
          return {
            windowId: window.id,
            width,
            height,
            visible,
            occludedBottom,
            occlusionRevision: revision.revision,
          };
        }),
      };
      const key = canonicalJson(params);
      if (key === this.pending || (this.pending === undefined && key === this.acknowledged)) return;
      if (!this.unit.ready(key)) {
        this.unit.schedule(() => this.schedule(0));
        return;
      }
      this.pending = key;
      const serial = ++this.serial;
      void this.request(params)
        .then(() => {
          if (serial === this.serial) {
            this.pending = undefined;
            this.acknowledged = key;
            this.publish(undefined);
            this.unit.succeed();
            this.schedule();
          }
        })
        .catch((error) => {
          if (serial === this.serial) {
            this.pending = undefined;
            this.acknowledged = undefined;
          }
          if (serial !== this.serial) return;
          const failure =
            error instanceof RemoteKitError ? error : new RemoteKitError('internal', '画面尺寸更新失败');
          this.unit.fail(failure);
          this.unit.schedule(() => this.schedule(0));
          if (serial === this.serial && this.available) this.publish(failure);
        });
    };
    if (delay === 0) publish();
    else this.timer = setTimeout(publish, delay);
  }
}
