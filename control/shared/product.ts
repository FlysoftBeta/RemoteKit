/** Persistent product state belongs to Control; clients keep only an HttpOnly token. */
export interface ProductUser { id: string; username: string }
export interface ProductSettings { qualityPreference: 'quality' | 'auto' | 'smooth'; clientScaleOverride: number | null; memorySaverEnabled: boolean; showStats: boolean }
export interface ProductTab { id: string; windowId: string; webviewId: string; title: string; url: string; pendingUrl?: string; canGoBack?: boolean; canGoForward?: boolean; loading?: boolean; residency?: 'live' | 'frozen' | 'discarded' | 'unloaded'; restoring?: boolean; pendingUaReloadOrigin?: string; popup?: { provisionalId: string; status: 'pending' | 'adopted' | 'failed'; error?: string } }
export interface ProductWindow { id: string; activeTabId: string | null; weight: number }
/** Browser-local request IDs are never exposed as the user confirmation token. */
export interface PendingClose { id: string; windowId?: string; requestId?: string; nativeRequestId?: string; browserIncarnation?: string; instance?: string; document?: string; awaiting?: boolean }
export interface ProductWorkspace { schemaVersion: 2; tenantId: string; revision: number; tabs: ProductTab[]; windows: ProductWindow[]; activeWindowId: string | null; layoutMode: 'side-by-side' | 'focused'; settings: ProductSettings; sites: Record<string, { tabletUa: boolean }>; pendingClose?: PendingClose | null; pendingWindowCloseId?: string | null }
export interface PageDialog { id: string; tabId: string; windowId: string; kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string; defaultPrompt: string; origin: string; isReload?: boolean }
export interface MediaPolicy { targetFps: number; bitrateKbps: number; maxBitrateKbps: number; adaptive: boolean }
export interface AppliedMediaPolicy { targetFps: number | null; bitrateKbps: number | null; maxBitrateKbps: number | null; adaptive: boolean }
export interface ProductFeedback { sequence: number; sourceCaptureId: string; sampledAtServerMs: number; visible: boolean; presentationLatencyMs: number; latencySource: 'capture-end-to-paint'; clockUncertaintyMs: number; sampleCount: number; windowMs: number; displayHzEstimate?: number }
export interface ProductQuality { resourceLimitation: string | null; mode: 'product' | 'manual'; preference: ProductSettings['qualityPreference']; clientScale: number; baseResolutionFactor: number; adaptiveResolutionFactor: number; effectiveDpr: number; pixelBudget: number; targetFps: number; requested: MediaPolicy; applied: AppliedMediaPolicy | null; estimatedLatencyMs: number | null; clockUncertaintyMs: number | null; feedbackStatus: 'unknown' | 'valid' | 'stale'; reason: string }
export interface ProductState { user: ProductUser; workspace: ProductWorkspace; pageDialogs: PageDialog[]; quality: ProductQuality; endpointGeneration: number; endpointError: string | null; viewer: { connected: boolean }; integrations: { siteUa: boolean; lifecycle: boolean; popupAdoption: boolean }; constraints: { clientScaleMin: number; clientScaleMax: number } }
export type ProductAction =
  | { type: 'window.create'; url?: string; title?: string }
  | { type: 'window.activate' | 'window.close'; windowId: string }
  | { type: 'window.layout'; mode: 'side-by-side' | 'focused'; weights?: { windowId: string; weight: number }[] }
  | { type: 'tab.create'; windowId: string; url?: string; title?: string }
  | { type: 'tab.activate' | 'tab.close'; tabId: string; requestId?: string; confirm?: boolean; cancel?: boolean }
  | { type: 'tab.move'; tabId: string; windowId: string }
  | { type: 'tab.navigate'; tabId: string; url: string }
  | { type: 'tab.command'; tabId: string; command: 'back' | 'forward' | 'reload' | 'stop' }
  | { type: 'settings.update'; settings: Partial<ProductSettings> }
  | { type: 'page.reply'; dialogId: string; accept: boolean; text?: string }
  | { type: 'site.set'; origin: string; tabletUa: boolean; tabId?: string };
export interface ViewerViewport { devicePixelRatio: number; refreshHz?: number; windows: { windowId: string; width: number; height: number; visible: boolean }[] }
export interface ProductActionResult { state: ProductState; application?: { status: 'pending'; reason: string } }
export interface SocketMethods {
  action: { params: ProductAction; result: ProductActionResult };
  viewport: { params: ViewerViewport; result: ProductState };
  feedback: { params: ProductFeedback; result: { accepted: boolean } };
  'rtc.offer': { params: { type: 'offer'; sdp: string }; result: { type: 'answer'; sdp: string; connectionId: string; endpointGeneration: number } };
  'rtc.ice': { params: { connectionId: string; candidate: unknown }; result: unknown };
  'rtc.close': { params: { connectionId: string }; result: { closed: boolean } };
  'clock.ping': { params: { clientTime?: number }; result: { serverTime: number; clientTime?: number } };
}
export type SocketRequest = { [K in keyof SocketMethods]: { id: string; method: K; params: SocketMethods[K]['params'] } }[keyof SocketMethods];
export type SocketMessage = { type: 'state'; revision: number; state: ProductState } | { type: 'result'; id: string; result: unknown } | { type: 'error'; id: string; error: { code: number; message: string } } | { type: 'lease'; status: 'revoked'; reason: 'another-viewer' | 'logout' };
