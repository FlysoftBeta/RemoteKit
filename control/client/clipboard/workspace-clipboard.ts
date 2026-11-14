import { useEffect } from 'react';
import type { ControlSession } from '../control/control-session';
import { failureError, notices, presentFailure } from '../failures';
import { recoverRead } from '../failures/recovery';
import { appClipboard } from './app-clipboard';

export function useWorkspaceClipboard(scope: string | undefined, control: Pick<ControlSession, 'request'>) {
  useEffect(() => {
    const set = (text: string) => control.request('clipboard.set', { text });
    appClipboard.configure(scope, set);
    let active = true;
    const abort = new AbortController();
    const failed = (error: unknown) => {
      if (active)
        notices.post(
          'clipboard:initial',
          presentFailure(failureError(error), { operation: '同步共享剪贴板', scope: 'global' }),
        );
    };
    if (scope)
      void recoverRead(() => control.request('clipboard.get', {}), abort.signal, failed).then((value) => {
        if (active) {
          appClipboard.receive(value);
          notices.resolve('clipboard:initial');
        }
      }, failed);
    return () => {
      active = false;
      abort.abort();
      appClipboard.configure(undefined, set);
    };
  }, [scope, control]);
}
