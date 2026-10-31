export const MARKER_WIDTH: number, MARKER_HEIGHT: number, CELL: number;
export function markerBytes(frameId: number, timestamp: number, stimulus: number): Uint8Array;
export function drawMarker(ctx: CanvasRenderingContext2D, frameId: number, timestamp: number, stimulus: number): void;
export function decodeMarker(image: ImageData): { frameId: number; timestamp: number; stimulus: number } | null;
export function percentiles(values: number[]): { p50: number | null; p95: number | null; p99: number | null };
