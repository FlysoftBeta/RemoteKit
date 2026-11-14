import { useEffect, useRef, useState } from 'react';
import type { Action } from './product-dialogs';
import type { ProductWindow, SocketMethods } from '../../shared/product';
import { recover } from '../failures/recovery';
import { canonicalJson } from '../util/canonical-json';
import type { ViewerSession } from '../viewer-session';

export type WorkspaceCall = <K extends keyof SocketMethods>(
  method: K,
  params: SocketMethods[K]['params'],
) => Promise<SocketMethods[K]['result']>;

export function useWindowState(win: ProductWindow, action: Action, report: (error: unknown) => void) {
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
    const abort = new AbortController();
    const timer = setTimeout(() => {
      const state = latest.current;
      const serialized = canonicalJson(state);
      if (serialized === saved.current) {
        dirty.current = false;
        return;
      }
      void recover(() => action({ type: 'window.state', windowId: win.id, state }), abort.signal, report)
        .then(() => {
          report(undefined);
          saved.current = serialized;
          if (latest.current === state) dirty.current = false;
        })
        .catch(report);
    }, 500);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [value, win.id, action, report]);
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
