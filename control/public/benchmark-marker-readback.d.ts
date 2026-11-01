export interface MarkerReadbackRect { x: number; y: number; width: number; height: number }
export interface MarkerReadbackResult {
  id: number; identity: Record<string, unknown>; sourceRect: MarkerReadbackRect;
  marker: { frameId: number; timestamp: number; stimulus: number } | null;
  costs: Record<string, number>;
}
export class BenchmarkMarkerReadback {
  constructor(options?: { maxPending?: number; timeoutMs?: number; api?: typeof globalThis });
  pending: Map<number, unknown>;
  stats: Record<string, number>;
  start(): Promise<this>;
  submit(image: unknown, rect: MarkerReadbackRect, identity: Record<string, unknown>): Promise<MarkerReadbackResult>;
  close(reason?: string): void;
}
