import { endpointError } from '../../shared/errors';
import { RetryUnit } from '../../shared/retry-unit';
import { identifyError, log } from '../log';
import type { SessionTarget } from './coordination';

interface FaultState {
  target: string;
  unit: RetryUnit;
  input: number;
  admitting: boolean;
}
export class SessionFaults {
  private readonly states = new Map<string, FaultState>();
  constructor(private readonly now = () => performance.now()) {}
  disconnected() {
    for (const state of this.states.values()) state.input++;
  }
  private state(target: SessionTarget) {
    const state = this.states.get(target.tenantId);
    return state?.target === `${target.sessionId}:${target.placementEpoch}` ? state : undefined;
  }
  get(target: SessionTarget) {
    const state = this.state(target);
    return state?.admitting ? undefined : state?.unit.error;
  }
  fault(target: SessionTarget, cause: unknown) {
    let state = this.state(target);
    if (state?.unit.error && !state.admitting) return state.unit.error;
    if (!state) {
      state = {
        target: `${target.sessionId}:${target.placementEpoch}`,
        input: 0,
        admitting: false,
        unit: new RetryUnit({
          now: this.now,
          failed: (error) =>
            log.error('session.protocol_failed', {
              ...target,
              code: error.code,
              errorId: error.errorId,
              err: error,
            }),
          recovered: () => log.info('session.protocol_recovered', { ...target }),
        }),
      };
      this.states.set(target.tenantId, state);
    }
    state.admitting = false;
    state.unit.ready(String(state.input));
    return state.unit.fail(identifyError(endpointError(cause))).error;
  }
  attach(target: SessionTarget) {
    const state = this.state(target);
    if (!state?.unit.error || state.admitting || !state.unit.ready(String(state.input))) return false;
    state.admitting = true;
    return true;
  }
  observe(target: SessionTarget, running: boolean) {
    const state = this.state(target);
    if (state && running && state.admitting) {
      state.admitting = false;
      state.unit.succeed();
    }
  }
}
