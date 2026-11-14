import { matrixDom } from './retry-loop-dom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useAdminResource } from '../client/app/admin/shared';
import { useQuery } from '../client/learning/queries';
import { useBackgroundNotices } from '../client/failures/background';
import { notices } from '../client/failures/notices';
import { useIdentitySession } from '../client/auth/identity-session';
import { httpStatus, wireError } from '../shared/errors';
import { useWorkspaceClipboard } from '../client/clipboard/workspace-clipboard';
import { type OwnerFactory, settle } from './retry-loop-boundary';

export function driveReact(
  path: 'admin' | 'query' | 'background' | 'identity' | 'logout' | 'clipboard',
): OwnerFactory {
  return async (boundary, t) => {
    const dom = matrixDom();
    const restore: (() => void)[] = [];
    for (const [name, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
      fetch: async (url: string, init?: RequestInit) => {
        try {
          if (path === 'identity' || url.endsWith('/logout'))
            await boundary.call({ url, body: init?.body }, undefined);
          return new Response(JSON.stringify({ user: { id: 'user', username: 'viewer', isAdmin: false } }));
        } catch (error) {
          return new Response(JSON.stringify({ error: wireError(error as never) }), {
            status: httpStatus[boundary.code!],
          });
        }
      },
    })) {
      const previous = Object.getOwnPropertyDescriptor(globalThis, name);
      Object.defineProperty(globalThis, name, { configurable: true, value });
      restore.push(() => {
        if (previous) Object.defineProperty(globalThis, name, previous);
        else Reflect.deleteProperty(globalThis, name);
      });
    }
    const wakeups: (() => void)[] = [];
    const interval = globalThis.setInterval;
    t.mock.method(globalThis, 'setInterval', ((callback: () => void, ms: number) => {
      wakeups.push(callback);
      return interval(callback, ms);
    }) as typeof setInterval);
    const root = createRoot(dom.window.document.getElementById('root')!);
    let online = true;
    let current: {
      error?: unknown;
      refresh?: (manual?: boolean) => Promise<void>;
      user?: unknown;
      connectionError?: unknown;
      notice?: unknown;
      logout?: () => void;
      retry?: () => void;
    } = {};
    const load = () => boundary.call({ key: boundary.version }, { ready: true });
    const call = (() => boundary.call({ method: 'sessionImport.state' }, { timeline: [] })) as never;
    const control = {
      request: (method: string, params: unknown) =>
        boundary.call({ method, params }, { revision: '1', text: 'clipboard' }),
    };
    function Probe() {
      if (path === 'admin') current = useAdminResource(online, load);
      else if (path === 'query') current = useQuery(String(boundary.version), load, online);
      else if (path === 'background') useBackgroundNotices(null, online, call);
      else if (path === 'clipboard') useWorkspaceClipboard(String(boundary.version), control as never);
      else current = useIdentitySession();
      return null;
    }
    const render = () =>
      act(async () => {
        root.render(createElement(Probe));
        await settle();
      });
    const wake = () =>
      act(async () => {
        if (path === 'admin') await current.refresh?.(false);
        else if (path === 'background') for (const callback of wakeups) callback();
        await settle();
      });
    return {
      advance: (milliseconds) =>
        act(async () => {
          t.mock.timers.tick(milliseconds);
          await settle();
        }),
      start: async () => {
        await render();
        if (path === 'logout')
          await act(async () => {
            current.logout?.();
            await settle();
          });
      },
      drive: wake,
      changeInput: async () => {
        boundary.version++;
        if (path === 'identity' || path === 'logout') {
          await act(async () => {
            if (path === 'identity') current.retry?.();
            else current.logout?.();
            await settle();
          });
          return;
        }
        if (path === 'admin') {
          await act(async () => {
            await current.refresh?.();
          });
          return;
        }
        if (path === 'background') {
          online = false;
          await render();
          online = true;
        }
        await render();
      },
      error: () =>
        path === 'identity'
          ? (current.connectionError ?? (current.user === null ? 'signed_out' : undefined))
          : path === 'logout'
            ? current.notice
            : path === 'background' || path === 'clipboard'
              ? notices
                  .getSnapshot()
                  .find(
                    (notice) =>
                      notice.key === (path === 'clipboard' ? 'clipboard:initial' : 'poll:session-import'),
                  )?.presentation
              : current.error,
      dispose: async () => {
        await act(async () => {
          root.unmount();
          notices.clear();
          await settle();
        });
        for (const reset of restore) reset();
      },
    };
  };
}
