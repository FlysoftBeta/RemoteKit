import type { RemoteKitError } from '../../shared/errors';
import type { Surface } from '../presentation/types';
export interface InputRequest {
  surface: Surface;
  identity: string;
  event: Record<string, unknown>;
}
export interface QueuedInput extends InputRequest {
  epoch: string;
  generation: string;
}
export interface InputResult extends InputRequest {
  sequence: string;
  ok: boolean;
  error?: RemoteKitError;
}
export interface InputDelivery extends InputRequest {
  phase: 'queued' | 'submitted' | 'discarded';
  sequence?: string;
  reason?: string;
}
