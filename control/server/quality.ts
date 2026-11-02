import { feasibleDpr } from './atlas-plan';
import type { AppliedMediaPolicy, ProductFeedback, ProductQuality, ProductWorkspace, ViewerViewport } from '../shared/product';
const presets = { quality: { pixels: 16777216, fps: 50, bitrate: 44000, max: 48000 }, auto: { pixels: 1920 * 1080, fps: 52, bitrate: 36000, max: 44000 }, smooth: { pixels: 1600 * 900, fps: 60, bitrate: 24000, max: 36000 } };
export class QualityController {
  private factor = 1;
  private highWindows = 0;
  private healthySince?: number;
  private adjustedAt = -Infinity;
  private sequence = 0;
  private source?: string;
  private sampledAt = -Infinity;
  private last?: { at: number; wallAt: number; value: ProductFeedback };
  private reason = 'waiting-for-feedback';
  private minimumFactor = .5;
  resetFeedback() { this.highWindows = 0; this.healthySince = undefined; this.sequence = 0; this.source = undefined; this.sampledAt = -Infinity; this.last = undefined; this.reason = 'waiting-for-feedback'; }
  resetConnection() { this.factor = 1; this.adjustedAt = -Infinity; this.resetFeedback(); }
  observe(value: any, now: number, visible: boolean, monotonicNow = now): boolean {
    const freshSequence = Number.isSafeInteger(value.sequence) && value.sequence > this.sequence;
    if (freshSequence) this.sequence = value.sequence;
    const valid = freshSequence && visible && value.visible === true && value.latencySource === 'capture-end-to-paint' && typeof value.sourceCaptureId === 'string' && /^[1-9][0-9]{0,19}$/.test(value.sourceCaptureId) && value.sourceCaptureId !== this.source && Number.isFinite(value.sampledAtServerMs) && value.sampledAtServerMs - this.sampledAt >= 1500 && value.sampledAtServerMs <= now + 25 && now - value.sampledAtServerMs <= 5000 && Number.isFinite(value.clockUncertaintyMs) && value.clockUncertaintyMs >= 0 && value.clockUncertaintyMs <= 25 && Number.isSafeInteger(value.sampleCount) && value.sampleCount > 0 && value.sampleCount <= 10000 && Number.isFinite(value.windowMs) && value.windowMs >= 1500 && value.windowMs <= 5000 && Number.isFinite(value.presentationLatencyMs) && value.presentationLatencyMs >= 0 && value.presentationLatencyMs <= 60000;
    if (!valid) { this.highWindows = 0; this.healthySince = undefined; this.reason = 'feedback-not-usable'; return false; }
    if (monotonicNow - (this.last?.at ?? monotonicNow) > 5000) { this.highWindows = 0; this.healthySince = undefined; }
    this.source = value.sourceCaptureId; this.sampledAt = value.sampledAtServerMs; this.last = { at: monotonicNow, wallAt: now, value: { ...value } };
    if (value.presentationLatencyMs > 300) {
      this.healthySince = undefined; this.highWindows++;
      if (this.highWindows >= 3 && monotonicNow - this.adjustedAt >= 5000) { const next = Math.max(this.minimumFactor, this.factor * .8); if (next < this.factor) { this.factor = next; this.adjustedAt = monotonicNow; this.reason = 'sustained-high-presentation-latency'; } else this.reason = 'minimum-dpr'; this.highWindows = 0; }
      else this.reason = 'observing-high-latency';
    } else if (value.presentationLatencyMs < 150) {
      this.highWindows = 0; this.healthySince ??= monotonicNow;
      if (this.factor < 1 && monotonicNow - this.healthySince >= 30000 && monotonicNow - this.adjustedAt >= 5000) { this.factor = Math.min(1, this.factor / .8); this.adjustedAt = monotonicNow; this.healthySince = monotonicNow; this.reason = 'sustained-healthy-presentation-latency'; }
      else this.reason = 'healthy';
    } else { this.highWindows = 0; this.healthySince = undefined; this.reason = 'latency-neutral'; }
    return true;
  }
  snapshot(workspace: ProductWorkspace, viewport?: ViewerViewport, now = Date.now(), manual = false, applied: AppliedMediaPolicy | null = null): ProductQuality {
    const preset = presets[workspace.settings.qualityPreference], scale = workspace.settings.clientScaleOverride ?? viewport?.devicePixelRatio ?? 1;
    const visible = viewport?.windows.filter(w => w.visible && workspace.windows.some(window => window.id === w.windowId && !!window.activeTabId && !workspace.tabs.some(tab => tab.id === window.activeTabId && tab.kind === 'start')) && (workspace.layoutMode !== 'focused' || w.windowId === workspace.activeWindowId)) ?? [];
    const area = visible.reduce((total, w) => total + w.width * w.height, 0), areaBase = workspace.settings.qualityPreference === 'quality' ? 1 : area ? Math.min(1, Math.sqrt(preset.pixels / (area * scale * scale))) : 1;
    let base = areaBase, resourceLimitation: string | null = null;
    if (!manual) {
      try { base = feasibleDpr(visible, scale * areaBase) / scale; }
      catch (error) { resourceLimitation = error instanceof Error ? error.message : String(error); base = .5 / scale; }
    }
    this.minimumFactor = Math.min(1, .5 / (scale * base)); this.factor = Math.max(this.minimumFactor, this.factor);
    const valid = !!this.last && now >= this.last.wallAt && now - this.last.wallAt <= 5000;
    const hz = valid && Number.isFinite(this.last!.value.displayHzEstimate) && this.last!.value.displayHzEstimate! >= 1 && this.last!.value.displayHzEstimate! <= 500 ? this.last!.value.displayHzEstimate! : 60;
    const fps = Math.max(1, Math.min(preset.fps, Math.floor(hz)));
    const requested = { targetFps: fps, bitrateKbps: preset.bitrate, maxBitrateKbps: preset.max, adaptive: true, preferResolution: workspace.settings.qualityPreference === 'quality' };
    return { resourceLimitation, mode: manual ? 'manual' : 'product', preference: workspace.settings.qualityPreference, clientScale: scale, baseResolutionFactor: base, adaptiveResolutionFactor: manual ? 1 : this.factor, effectiveDpr: Math.max(.5, Math.min(4, scale * base * (manual ? 1 : this.factor))), pixelBudget: preset.pixels, targetFps: fps, requested, applied, estimatedLatencyMs: valid ? this.last!.value.presentationLatencyMs : null, clockUncertaintyMs: valid ? this.last!.value.clockUncertaintyMs : null, feedbackStatus: valid ? 'valid' : this.last ? 'stale' : 'unknown', reason: resourceLimitation ? 'resource-limited' : manual ? 'diagnostic-fixed-configuration' : this.reason };
  }
}
