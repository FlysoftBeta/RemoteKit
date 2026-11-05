import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AuthState } from '../../shared/security';
import { IdlePolicy } from './idle-policy';
export function useAutoLock(auth: AuthState | null, lock: (reason: string) => void) {
  const [policy] = useState(() => new IdlePolicy(lock));
  useEffect(() => policy.configure(auth), [policy, auth]);
  useEffect(() => () => policy.dispose(), [policy]);
  const state = useSyncExternalStore(policy.subscribe, policy.getSnapshot, policy.getSnapshot);
  return { ...state, requestSystem: policy.requestSystem };
}
