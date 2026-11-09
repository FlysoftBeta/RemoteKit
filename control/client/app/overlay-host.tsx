import { RemoteKitError } from '../../shared/errors';
import React, { useEffect, useState } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material';
import {
  isSingletonApp,
  type LauncherItem,
  type ProductState,
  type WindowPlacement,
} from '../../shared/product';
import type { ViewerSession } from '../viewer-session';
import { Launcher } from './launcher';
import { launcherActions, launcherNavigation, launcherPlacement } from './launcher-actions';
import { useFloatingAction } from './floating-actions';
import { useWindowFullscreen } from './window-fullscreen';
import { PageDialogs, type Action } from './product-dialogs';
import { AudioControls } from './audio-controls';
import { SyncStatus } from './sync-status';
import { AnnouncementDialog } from './announcements';
import { waitForWorkspaceRevision, type WorkspaceCall } from './window-state';
import type { WorkspaceStage } from './stage';
import type { SystemControls } from './system-controls';
import type { selectVisibility } from './visibility';

export function useWorkspaceOverlays() {
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
    openLauncher: () => setOverlay({ kind: 'launcher' }),
    closeLauncher: () => setOverlay(undefined),
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
  const singleton =
    !!item.appId && isSingletonApp(item.appId) && workspace.windows.some((win) => win.appId === item.appId);
  if (workspace.windows.length >= 16 && !singleton && !reuseExisting)
    throw new RemoteKitError('limit_exceeded', '窗口已满，请先关闭一些窗口');
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
            launch: { requestId: receipt.operationId, entryId: item.entryId },
          },
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
  readAnnouncement,
}: {
  state: ProductState;
  media: ViewerSession;
  stage: Pick<WorkspaceStage, 'shell' | 'snapshots' | 'call' | 'action' | 'notify'>;
  controls: Pick<SystemControls, 'productReady' | 'lock' | 'audio' | 'sync' | 'browserFullscreen'>;
  overlays: WorkspaceOverlays;
  foreground: ReturnType<typeof selectVisibility>['foreground'];
  readAnnouncement(id: string): Promise<unknown>;
}) {
  const { shell, snapshots, call, action, notify } = stage;
  const { productReady, lock } = controls;
  const workspace = state.workspace;
  const activeSpace = workspace.spaces.find((space) => space.id === workspace.activeSpaceId);
  const pending = workspace.pendingClose;
  const report = media.workspace.report;
  const windowFullscreen = useWindowFullscreen();
  // The Start button stays out of the way of a page or window shown fullscreen; its exit control
  // takes that place.
  useFloatingAction(
    'start',
    state.pageFullscreen || windowFullscreen
      ? null
      : {
          order: 20,
          anchor: 'bottom-left',
          label: '开始',
          icon: 'start',
          run: () => {
            if (shell.current && activeSpace) snapshots.capture(shell.current, activeSpace.windowIds);
            overlays.openLauncher();
          },
        },
  );
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
      {productReady && !overlays.launcherOpen && (
        <AnnouncementDialog announcements={state.announcements} read={readAnnouncement} report={report} />
      )}
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
