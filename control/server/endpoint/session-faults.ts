import { RemoteKitError } from '../../shared/errors';
import { newErrorId, log } from '../log';
import type { SessionTarget } from './coordination';

interface FaultState {
  target: string;
  attempts: number;
  retryAt: number;
  healthySince?: number;
  error?: RemoteKitError;
}

export class SessionFaults {
  private readonly states = new Map<string, FaultState>();
  constructor(private readonly now = Date.now) {}
  private state(target: SessionTarget) {
    const state = this.states.get(target.tenantId);
    return state?.target === `${target.sessionId}:${target.placementEpoch}` ? state : undefined;
  }
  get(target: SessionTarget) {
    return this.state(target)?.error;
  }
  fault(target: SessionTarget, cause: unknown) {
    let state = this.state(target);
    if (state?.error) return state.error;
    if (!state) {
      state = { target: `${target.sessionId}:${target.placementEpoch}`, attempts: 0, retryAt: 0 };
      this.states.set(target.tenantId, state);
    }
    if (state.healthySince !== undefined && this.now() - state.healthySince >= 600_000) state.attempts = 0;
    state.healthySince = undefined;
    state.retryAt = this.now() + Math.min(1_800_000, 60_000 * 2 ** state.attempts++);
    state.error = new RemoteKitError('unavailable', 'Session data could not be processed', {
      reason: 'browser_unavailable',
      errorId: newErrorId(),
      cause,
    });
    log.error('session.protocol_fault', { ...target, errorId: state.error.errorId, err: cause });
    return state.error;
  }
  attach(target: SessionTarget) {
    const state = this.state(target);
    if (!state?.error || this.now() < state.retryAt) return false;
    state.error = undefined;
    return true;
  }
  observe(target: SessionTarget, running: boolean) {
    const state = this.state(target);
    if (!state || state.error) return;
    if (running) state.healthySince ??= this.now();
    else state.healthySince = undefined;
  }
}
