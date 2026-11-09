import { useMemo, useRef, useSyncExternalStore } from 'react';
import type { ViewerSession } from '../viewer-session';
interface SessionSource {
  subscribe(listener: () => void): () => void;
}
function sessionSnapshot(session: ViewerSession, observe: (source: SessionSource) => void) {
  return {
    get presentation() {
      observe(session.presentation);
      return session.presentation.getSnapshot();
    },
    get editing() {
      observe(session.editing);
      return session.editing.getSnapshot();
    },
    get authorization() {
      observe(session.authorization);
      return session.authorization.getSnapshot();
    },
    get observations() {
      observe(session.observations);
      return session.observations.getSnapshot();
    },
    get rtc() {
      observe(session.rtc);
      return session.rtc.getSnapshot();
    },
  };
}
export function shallowEqual<T>(left: T, right: T): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        Object.is(left[key as keyof T], right[key as keyof T]),
    )
  );
}
export function useViewerSessionSelector<T>(
  session: ViewerSession,
  select: (snapshot: ReturnType<typeof sessionSnapshot>) => T,
  equal: (left: T, right: T) => boolean = Object.is,
): T {
  const selected = useRef<{ value: T }>(undefined);
  const selection = useMemo(() => {
    let sources = new Set<SessionSource>();
    const getSnapshot = () => {
      const observed = new Set<SessionSource>();
      const next = select(sessionSnapshot(session, (source) => observed.add(source)));
      sources = observed;
      if (!selected.current || !equal(selected.current.value, next)) selected.current = { value: next };
      return selected.current.value;
    };
    const subscribe = (listener: () => void) => {
      const subscriptions = new Map<SessionSource, () => void>();
      const synchronize = () => {
        for (const [source, remove] of subscriptions) {
          if (sources.has(source)) continue;
          remove();
          subscriptions.delete(source);
        }
        for (const source of sources) {
          if (!subscriptions.has(source)) subscriptions.set(source, source.subscribe(changed));
        }
      };
      const changed = () => {
        getSnapshot();
        synchronize();
        listener();
      };
      getSnapshot();
      synchronize();
      return () => subscriptions.forEach((remove) => remove());
    };
    return { getSnapshot, subscribe };
  }, [session, select, equal]);
  return useSyncExternalStore(selection.subscribe, selection.getSnapshot, selection.getSnapshot);
}
