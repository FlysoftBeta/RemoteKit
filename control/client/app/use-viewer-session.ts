import { useSyncExternalStore } from 'react';
import type { ViewerSession } from '../viewer-session';
export function useViewerSession(session: ViewerSession) {
  const presentation = useSyncExternalStore(session.presentation.subscribe, session.presentation.getSnapshot);
  const editing = useSyncExternalStore(session.editing.subscribe, session.editing.getSnapshot);
  const authorization = useSyncExternalStore(
    session.authorization.subscribe,
    session.authorization.getSnapshot,
  );
  const observations = useSyncExternalStore(session.observations.subscribe, session.observations.getSnapshot);
  const rtc = useSyncExternalStore(session.rtc.subscribe, session.rtc.getSnapshot);
  return { presentation, editing, authorization, observations, rtc };
}
