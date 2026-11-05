import type { Surface } from '../presentation/types';
export interface InputRequest {
  surface: Surface;
  identity: string;
  event: Record<string, unknown>;
}
export interface QueuedInput extends InputRequest {
  epoch: string;
  generation: string;
  requiresTerminalState: boolean;
}
export interface InputResult extends InputRequest {
  sequence: string;
  ok: boolean;
  error?: string;
  touchState?:
    'accepted-pending' | 'processed' | 'terminal-invalidated' | 'terminal-unconfirmed' | 'rejected';
  touchSequenceId?: string;
}
export interface InputDelivery extends InputRequest {
  phase: 'queued' | 'submitted' | 'discarded' | 'unconfirmed';
  sequence?: string;
  reason?: string;
  layoutEpoch?: string;
  authorization?: number;
}
export interface TouchRetireLease {
  surface: Surface;
  identity: string;
  layoutEpoch: string;
  authorization?: number;
}
export interface TerminalInput extends InputRequest {
  requiresTerminalState: boolean;
  pending: boolean;
  retries: number;
  retirement?: boolean;
}
export const terminalQueryDelays = [250, 500, 1000, 2000];
export function tracksTerminal(event: Record<string, unknown>) {
  return (
    event.type === 'touch' &&
    event.gestureMode === 'client-v1' &&
    typeof event.sequenceId === 'string' &&
    (event.action === 'end' || event.action === 'cancel')
  );
}
