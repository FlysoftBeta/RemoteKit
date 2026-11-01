export interface Tab { id: string; title: string; url: string; webviewId: string | null; pendingUrl?: string; canGoBack?: boolean; canGoForward?: boolean; loading?: boolean }
export interface Device { mode: 'desktop' | 'tablet'; width: number; height: number; deviceScaleFactor: number }
export interface ControlState { tenantId: string; tabs: Tab[]; activeTabId: string | null; splitTabId: string | null; device: Device; endpointGeneration?: number; endpointError?: string | null; pendingClose?: { id: string; requestId?: string; awaiting?: boolean } | null }
export interface Surface { id: string; session: string; instance: string; document: string; focus: string; x: number; y: number; width: number; height: number; deviceScaleFactor: number; mediaScale?: number; stale?: boolean }
export interface Layout { type: 'layout'; generation: string; epoch: string; width: number; height: number; views: Surface[] }
export interface CanvasPresentation { viewId: string; rtpTimestamp: number; layoutEpoch: string; paintedAt: number; paintedWallTime: number; authorizedAt: number }
export interface Diagnostics { receiveSelection?: { profile: string; reason: string }; presentationEstimate?: { presentationLatencyMs: number; clockUncertaintyMs: number; sampleCount: number }; connection: string; channel: string; framesDecoded?: number; framesPerSecond?: number; displayFramesPerSecond?: number; decodedFramesPerSecond?: number; paintFpsByView?: Record<string, number | undefined>; markerSampleHz?: number; bytesReceived?: number; receiveBitrateBps?: number; roundTripTime?: number; codec?: string; videoWidth?: number; videoHeight?: number; endpoint?: Record<string, unknown>; error?: string; networkSimulation?: Record<string, unknown>; selectedCandidates?: unknown; connectionId?: string; marker?: { kind: 'input' | 'render'; p50: number; p95: number; samples: number } }
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(value?.error?.message ?? value?.error ?? `请求失败 (${response.status})`);
  return value as T;
}
