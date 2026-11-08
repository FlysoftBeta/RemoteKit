import React, { Suspense, lazy, useEffect, useState } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material';
import type { LauncherItem, ProductState, WindowPlacement } from '../../shared/product';
import type { ViewerSession } from '../viewer-session';
import type { WorkspaceSnapshot } from '../control/workspace-session';
import type { AdminCall } from './admin/shared';
import { Launcher } from './launcher';
import { launcherActions, launcherNavigation, launcherPlacement } from './launcher-actions';
import { HomeBar } from './home-bar';
import { PageDialogs, type Action } from './product-dialogs';
import { AudioControls } from './audio-controls';
import { SyncStatus } from './sync-status';
import { waitForWorkspaceRevision, type WorkspaceCall } from './window-state';
import type { WorkspaceStage } from './stage';
import type { SystemControls } from './system-controls';
import type { selectVisibility } from './visibility';

// Only administrator sessions download the console.
const AdminConsole = lazy(() => import('./admin/console').then((m) => ({ default: m.AdminConsole })));
export function useWorkspaceOverlays(isAdmin: boolean) {
  const [overlay, setOverlay] = useState<{ kind: 'launcher' }>();
  const [visibleLauncher, setVisibleLauncher] = useState<typeof overlay>();
  useEffect(() => {
    if (overlay?.kind === 'launcher') {
      setVisibleLauncher(overlay);
      return;
    }
    const timer = setTimeout(() => setVisibleLauncher(undefined), overlay ? 0 : 160);
    return () => clearTimeout(timer);
  }, [overlay]);
  const [adminRequested, setAdmin] = useState(false);
  const admin = adminRequested && isAdmin;
  useEffect(() => {
    if (!overlay) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOverlay(undefined);
      }
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [overlay]);
  return {
    launcherOpen: overlay?.kind === 'launcher',
    launcherVisible: visibleLauncher?.kind === 'launcher',
    admin,
    openLauncher: () => setOverlay({ kind: 'launcher' }),
    closeLauncher: () => setOverlay(undefined),
    openAdmin: () => setAdmin(true),
    closeAdmin: () => setAdmin(false),
  };
}
export type WorkspaceOverlays = ReturnType<typeof useWorkspaceOverlays>;
export async function openLauncherItem({
  item,
  placement,
  reuseExisting,
  state,
  action,
  call,
  media,
  notify,
}: {
  item: LauncherItem;
  placement?: WindowPlacement;
  reuseExisting?: boolean;
  state: ProductState;
  action: Action;
  call: WorkspaceCall;
  media: ViewerSession;
  notify(message: string): void;
}) {
  const workspace = state.workspace;
  const activeSpace = workspace.spaces.find((space) => space.id === workspace.activeSpaceId);
  const singleton = item.appId === 'settings' && workspace.windows.some((win) => win.appId === 'settings');
  if (workspace.windows.length >= 16 && !singleton && !reuseExisting)
    throw new Error('窗口已满，请先关闭一些窗口');
  const wasFull =
    !placement && !reuseExisting && !singleton && activeSpace && activeSpace.windowIds.length >= 3;
  const commands = launcherActions(workspace, item, placement, reuseExisting);
  for (const command of commands) {
    const receipt = await action(command);
    if (item.kind === 'file' && item.entryId) {
      const authoritative = await waitForWorkspaceRevision(media, receipt.revision ?? workspace.revision);
      const win = [...authoritative.windows]
        .filter((win) => win.appId === 'files')
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
      if (win) {
        await call('window.state', {
          windowId: win.id,
          state: {
            ...win.state,
            previewEntryId: item.entryId,
            previewRequestId: receipt.operationId,
          },
        });
        await call('usage.record', {
          item: `file:${item.entryId}`,
          windowId: win.id,
          source: 'launcher',
        });
      }
    }
  }
  if (wasFull) notify('当前窗口组已满，已在新窗口组打开');
}
export function OverlayHost({
  state,
  media,
  stage,
  controls,
  overlays,
  foreground,
  adminCall,
  status,
}: {
  state: ProductState;
  media: ViewerSession;
  stage: Pick<WorkspaceStage, 'shell' | 'snapshots' | 'call' | 'action' | 'notify'>;
  controls: Pick<SystemControls, 'productReady' | 'lock' | 'audio' | 'sync' | 'browserFullscreen'>;
  overlays: WorkspaceOverlays;
  foreground: ReturnType<typeof selectVisibility>['foreground'];
  adminCall: AdminCall;
  status: WorkspaceSnapshot['status'];
}) {
  const { shell, snapshots, call, action, notify } = stage;
  const { productReady, lock } = controls;
  const workspace = state.workspace;
  const activeSpace = workspace.spaces.find((space) => space.id === workspace.activeSpaceId);
  const pending = workspace.pendingClose;
  const report = media.workspace.report;
  const activate = (item: LauncherItem, placement?: WindowPlacement, reuseExisting?: boolean) =>
    openLauncherItem({ item, placement, reuseExisting, state, action, call, media, notify });
  return (
    <>
      {productReady && (
        <PageDialogs
          state={state}
          action={action}
          activeId={foreground?.kind === 'page' ? foreground.id : null}
        />
      )}
      {state.user.isAdmin && (
        <Suspense fallback={null}>
          <AdminConsole
            open={overlays.admin}
            online={status === 'online'}
            self={state.user.username}
            call={adminCall}
            onClose={() => overlays.closeAdmin()}
          />
        </Suspense>
      )}
      <HomeBar
        launcher={() => {
          if (shell.current && activeSpace) snapshots.capture(shell.current, activeSpace.windowIds);
          overlays.openLauncher();
        }}
        previous={() => {
          const previous = [...workspace.spaces]
            .filter((space) => space.id !== workspace.activeSpaceId)
            .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
          if (previous) void action({ type: 'space.activate', spaceId: previous.id }).catch(report);
        }}
      />
      {overlays.launcherVisible && (
        <Launcher
          state={state}
          audio={controls.audio && <AudioControls {...controls.audio} />}
          sync={<SyncStatus {...controls.sync} />}
          lock={lock}
          fullscreen={controls.browserFullscreen.active}
          toggleFullscreen={controls.browserFullscreen.toggle}
          snapshots={snapshots}
          action={action}
          report={report}
          call={call}
          exiting={!overlays.launcherOpen}
          online={productReady}
          close={() => overlays.closeLauncher()}
          navigate={async (value, placement) => {
            await action(launcherNavigation(value, placement ?? launcherPlacement(workspace)));
            if (!placement && activeSpace && activeSpace.windowIds.length >= 3)
              notify('当前窗口组已满，已在新窗口组打开');
          }}
          activate={activate}
        />
      )}
      <Dialog
        open={productReady && !!pending && !pending.awaiting}
        onClose={() =>
          productReady &&
          pending &&
          void action({
            type: 'tab.close',
            tabId: pending.id,
            requestId: pending.requestId,
            cancel: true,
          }).catch(report)
        }
      >
        <DialogTitle>离开此页面？</DialogTitle>
        <DialogContent>此页面可能有未保存的内容。</DialogContent>
        <DialogActions>
          <Button
            autoFocus
            onClick={() =>
              pending &&
              void action({
                type: 'tab.close',
                tabId: pending.id,
                requestId: pending.requestId,
                cancel: true,
              }).catch(report)
            }
          >
            保留页面
          </Button>
          <Button
            onClick={() =>
              pending &&
              void action({
                type: 'tab.close',
                tabId: pending.id,
                requestId: pending.requestId,
                confirm: true,
              }).catch(report)
            }
          >
            离开
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
