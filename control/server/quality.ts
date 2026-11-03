import { feasibleDpr } from './atlas-plan';
import type { AppliedMediaPolicy, DegradationPreference, ProductFeedback, ProductQuality, ProductWorkspace, ViewerViewport } from '../shared/product';
const preferences: Record<ProductWorkspace['settings']['qualityPreference'], DegradationPreference> = { quality: 'maintain-resolution', auto: 'balanced', smooth: 'maintain-framerate' };
/** Product configuration and diagnostic observations; WebRTC owns media adaptation. */
export class QualityState {
  private sequence = 0;
  private source?: string;
  private sampledAt = -Infinity;
  private last?: { wallAt: number; value: ProductFeedback };
  resetFeedback() { this.sequence = 0; this.source = undefined; this.sampledAt = -Infinity; this.last = undefined; }
  observe(value: any, now: number, visible: boolean): boolean {
    const freshSequence = Number.isSafeInteger(value.sequence) && value.sequence > this.sequence;
    if (freshSequence) this.sequence = value.sequence;
    const valid = freshSequence && visible && value.visible === true && value.latencySource === 'capture-end-to-paint' && typeof value.sourceCaptureId === 'string' && /^[1-9][0-9]{0,19}$/.test(value.sourceCaptureId) && value.sourceCaptureId !== this.source && Number.isFinite(value.sampledAtServerMs) && value.sampledAtServerMs - this.sampledAt >= 1500 && value.sampledAtServerMs <= now + 25 && now - value.sampledAtServerMs <= 5000 && Number.isFinite(value.clockUncertaintyMs) && value.clockUncertaintyMs >= 0 && value.clockUncertaintyMs <= 25 && Number.isSafeInteger(value.sampleCount) && value.sampleCount > 0 && value.sampleCount <= 10000 && Number.isFinite(value.windowMs) && value.windowMs >= 1500 && value.windowMs <= 5000 && Number.isFinite(value.presentationLatencyMs) && value.presentationLatencyMs >= 0 && value.presentationLatencyMs <= 60000;
    if (!valid) return false;
    this.source = value.sourceCaptureId; this.sampledAt = value.sampledAtServerMs; this.last = { wallAt: now, value: { ...value } };
    return true;
  }
  snapshot(workspace: ProductWorkspace, viewport?: ViewerViewport, now = Date.now(), manual = false, applied: AppliedMediaPolicy | null = null): ProductQuality {
    const scale = workspace.settings.clientScaleOverride ?? viewport?.devicePixelRatio ?? 1;
    const visible = viewport?.windows.filter(w => w.visible && workspace.windows.some(window => window.id === w.windowId && !!window.activeTabId && !workspace.tabs.some(tab => tab.id === window.activeTabId && tab.kind === 'start')) && (workspace.layoutMode !== 'focused' || w.windowId === workspace.activeWindowId)) ?? [];
    let effectiveDpr = scale, resourceLimitation: string | null = null;
    if (!manual) {
      try { effectiveDpr = feasibleDpr(visible, scale); }
      catch (error) { resourceLimitation = error instanceof Error ? error.message : String(error); effectiveDpr = .5; }
    }
    const valid = !!this.last && now >= this.last.wallAt && now - this.last.wallAt <= 5000;
    const hz = viewport?.refreshHz;
    const maxFps = typeof hz === 'number' && Number.isFinite(hz) && hz >= 1 && hz <= 500 ? Math.min(240, Math.floor(hz)) : 60;
    const requested = { degradationPreference: preferences[workspace.settings.qualityPreference], maxFps };
    return { resourceLimitation, mode: manual ? 'manual' : 'product', preference: workspace.settings.qualityPreference, clientScale: scale, effectiveDpr, requested, applied, estimatedLatencyMs: valid ? this.last!.value.presentationLatencyMs : null, clockUncertaintyMs: valid ? this.last!.value.clockUncertaintyMs : null, feedbackStatus: valid ? 'valid' : this.last ? 'stale' : 'unknown', reason: resourceLimitation ? 'resource-limited' : manual ? 'diagnostic-fixed-configuration' : 'webrtc-congestion-control' };
  }
}
