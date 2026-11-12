import { Suspense, lazy } from 'react';
import type { ProductState } from '../../shared/product';
import { SettingsApp } from './settings-app';
import { SecuritySettings } from '../auth/security-settings';
import type { SessionImportCall } from './session-import';
import { DiagnosticSettings } from './diagnostic-collection-view';
import { diagnosticEnvironment } from '../media/diagnostic-collection';
import type { WorkspaceSnapshot } from '../control/workspace-session';
import type { Action } from './product-dialogs';
import type { WorkspaceCall } from './window-state';
import type { SystemControls } from './system-controls';

// Session import is a one-off migration page; it loads when opened.
const SessionImportSettings = lazy(() =>
  import('./session-import').then((m) => ({ default: m.SessionImportSettings })),
);
export function WorkspaceSettings({
  state,
  viewState,
  onState,
  action,
  call,
  sessionImportCall,
  controls,
  workspaceState,
  auth,
  logout,
}: {
  state: ProductState;
  viewState: Record<string, unknown>;
  onState(state: unknown): void;
  action: Action;
  call: WorkspaceCall;
  sessionImportCall: SessionImportCall;
  controls: Pick<
    SystemControls,
    'authRequest' | 'camera' | 'idle' | 'lock' | 'diagnosticState' | 'diagnostics' | 'shellReady'
  >;
  workspaceState: WorkspaceSnapshot;
  auth: NonNullable<WorkspaceSnapshot['auth']>;
  logout(): void;
}) {
  const { status } = workspaceState;
  const { authRequest, camera, idle, lock, diagnosticState, diagnostics, shellReady } = controls;
  const workspace = state.workspace;
  return (
    <SettingsApp
      state={state}
      viewState={viewState}
      onState={onState}
      action={action}
      call={call}
      online={shellReady}
      logout={logout}
      security={
        <SecuritySettings
          auth={auth}
          online={status === 'online'}
          request={authRequest}
          camera={camera}
          idle={idle}
          lock={lock}
        />
      }
      sessionImport={
        <Suspense fallback={null}>
          <SessionImportSettings
            online={shellReady}
            call={sessionImportCall}
            action={action}
            windowId={
              workspace.windows
                .filter((win) => win.appId === 'browser')
                .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id ?? null
            }
            opened={() => {}}
          />
        </Suspense>
      }
      diagnostics={
        <DiagnosticSettings
          state={diagnosticState}
          online={status === 'online'}
          start={() => {
            void diagnostics.start(diagnosticEnvironment());
          }}
        />
      }
    />
  );
}
