import { SessionFaults } from '../server/endpoint/session-faults';
import type { OwnerFactory } from './retry-loop-boundary';

export const driveSessionAdmission: OwnerFactory = (boundary) => {
  const owner = new SessionFaults(() => Date.now());
  const target = { tenantId: 'tenant', sessionId: 'session', placementEpoch: 1 };
  const endpoint = async () => {
    try {
      await boundary.call(target, undefined);
      owner.observe(target, true);
    } catch (cause) {
      owner.fault(target, cause);
    }
  };
  const attach = () => {
    if (owner.attach(target)) return endpoint();
  };
  return {
    start: endpoint,
    drive: attach,
    changeInput: () => {
      owner.disconnected();
      return attach();
    },
    error: () => owner.get(target),
    dispose: () => {},
  };
};
