import { canonicalJson } from '../util/canonical-json';
import type { ViewerSession } from '../viewer-session';
import { useEffect, useRef, useState } from 'react';
import type { ProductWindow, SocketMethods } from '../../shared/product';

export type WorkspaceCall = <K extends keyof SocketMethods>(
  method: K,
  params: SocketMethods[K]['params'],
) => Promise<SocketMethods[K]['result']>;

export function useWindowState(win: ProductWindow, call: WorkspaceCall, report: (error: unknown) => void) {
  const [value, setValue] = useState<Record<string, unknown>>(win.state ?? {});
  const dirty = useRef(false);
  const latest = useRef(value);
  const saved = useRef(canonicalJson(win.state ?? {}));
  useEffect(() => {
    if (!dirty.current) {
      saved.current = canonicalJson(win.state ?? {});
      setValue((current) => {
        const next = win.state ?? {};
        if (canonicalJson(current) === canonicalJson(next)) return current;
        latest.current = next;
        return next;
      });
    }
  }, [win.state]);
  useEffect(() => {
    if (!dirty.current || win.id.startsWith('pending-')) return;
    const timer = setTimeout(() => {
      const state = latest.current;
      const serialized = canonicalJson(state);
      if (serialized === saved.current) {
        dirty.current = false;
        return;
      }
      void call('window.state', { windowId: win.id, state })
        .then(() => {
          saved.current = serialized;
          if (latest.current === state) dirty.current = false;
        })
        .catch(report);
    }, 500);
    return () => clearTimeout(timer);
  }, [value, win.id, call, report]);
  return [
    value,
    (next: unknown) => {
      if (!next || typeof next !== 'object' || Array.isArray(next)) return;
      dirty.current = true;
      latest.current = next as Record<string, unknown>;
      setValue(latest.current);
    },
  ] as const;
}

export async function waitForWorkspaceRevision(media: ViewerSession, revision: number) {
  const current = media.operations.getSnapshot().authoritative!.workspace;
  if (current.revision >= revision) return current;
  return new Promise<typeof current>((resolve, reject) => {
    const timer = setTimeout(() => {
      remove();
      reject(new Error('工作区同步超时'));
    }, 10000);
    const remove = media.operations.subscribe(() => {
      const workspace = media.operations.getSnapshot().authoritative?.workspace;
      if (workspace && workspace.revision >= revision) {
        clearTimeout(timer);
        remove();
        resolve(workspace);
      }
    });
  });
}
