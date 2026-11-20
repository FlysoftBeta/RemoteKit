import './group-list.css';
import { Add } from '@mui/icons-material';
import { ButtonBase, Typography } from '@mui/material';
import type React from 'react';
import type { ProductSpace, ProductState } from '../../shared/product';
import { AppIcon, appName } from './app-icon';
import { SnapshotImage, type SpaceSnapshots } from './space-snapshots';
import { useDropTarget, useDropRegistration, useWindowDragging } from './window-drag';
type CardInteractions = Pick<
  React.HTMLAttributes<HTMLButtonElement>,
  | 'onClick'
  | 'onContextMenu'
  | 'onKeyDown'
  | 'onPointerDown'
  | 'onPointerMove'
  | 'onPointerUp'
  | 'onPointerCancel'
>;
export function GroupList({
  state,
  snapshots,
  online,
  newTarget,
  targetNew,
  cardProps,
  children,
}: {
  state: ProductState;
  snapshots: SpaceSnapshots;
  online: boolean;
  newTarget: boolean;
  targetNew?(): void;
  cardProps?(space: ProductSpace): CardInteractions;
  children?: React.ReactNode;
}) {
  const workspace = state.workspace;
  const spaces = [...workspace.spaces].sort(
    (a, b) =>
      Number(b.id === workspace.activeSpaceId) - Number(a.id === workspace.activeSpaceId) ||
      b.lastActiveAt - a.lastActiveAt,
  );
  const panel = useDropRegistration('panel', undefined);
  return (
    <aside ref={panel.ref} className="launcher-spaces" aria-label="窗口组栏">
      <NewGroupTarget newTarget={newTarget} online={online} targetNew={targetNew} />
      {spaces.map((space) => (
        <GroupCard
          key={space.id}
          space={space}
          workspace={workspace}
          snapshots={snapshots}
          online={online}
          newTarget={newTarget}
          interactions={cardProps?.(space)}
        />
      ))}
      {children}
    </aside>
  );
}
function NewGroupTarget({
  newTarget,
  online,
  targetNew,
}: {
  newTarget: boolean;
  online: boolean;
  targetNew?: () => void;
}) {
  const drop = useDropTarget('new', undefined);
  return (
    <ButtonBase
      className={`launcher-space-new${newTarget ? ' target-space' : ''}`}
      data-new-group
      ref={drop.ref}
      data-window-drop-hover={drop.hovered ? 'true' : undefined}
      aria-label="新窗口组"
      aria-pressed={newTarget}
      onClick={targetNew}
      disabled={!online}
    >
      <Add />
      <span>新窗口组</span>
    </ButtonBase>
  );
}

function GroupCard({
  space,
  workspace,
  snapshots,
  online,
  newTarget,
  interactions,
}: {
  space: ProductSpace;
  workspace: ProductState['workspace'];
  snapshots: SpaceSnapshots;
  online: boolean;
  newTarget: boolean;
  interactions?: CardInteractions;
}) {
  const drop = useDropTarget('group', space.id);
  const dragging = useWindowDragging();
  return (
    <ButtonBase
      {...interactions}
      ref={drop.ref}
      data-window-drop-hover={drop.hovered ? 'true' : undefined}
      className={`launcher-space-card${!newTarget && space.id === workspace.activeSpaceId ? ' target-space' : ''}${dragging && space.windowIds.length >= 3 ? ' drop-disabled' : ''}`}
      data-space-card={space.id}
      aria-label={
        space.id === workspace.activeSpaceId
          ? '当前窗口组'
          : (space.name ??
            space.windowIds
              .map((id) =>
                appName(
                  workspace,
                  workspace.windows.find((win) => win.id === id)!,
                ),
              )
              .join(' · '))
      }
      aria-current={space.id === workspace.activeSpaceId ? 'true' : undefined}
      disabled={!online}
    >
      {space.id === workspace.activeSpaceId && <span className="launcher-space-badge">当前</span>}
      <span className="launcher-space-title">
        {space.name ??
          space.windowIds
            .map((id) =>
              appName(
                workspace,
                workspace.windows.find((win) => win.id === id)!,
              ),
            )
            .join(' · ')}
      </span>
      <span className="launcher-space-preview">
        {space.windowIds.map((id, index) => {
          const win = workspace.windows.find((win) => win.id === id)!;
          const app = workspace.apps.find((app) => `web:${app.id}` === win.appId);
          const image = snapshots.get(id);
          return (
            <span key={id} className="launcher-window-preview" style={{ flexGrow: space.weights[index] }}>
              {image ? (
                <SnapshotImage source={image} />
              ) : (
                <AppIcon appId={win.appId} iconUrl={app?.iconUrl} />
              )}
              <Typography component="span" noWrap>
                {appName(workspace, win)}
              </Typography>
            </span>
          );
        })}
      </span>
    </ButtonBase>
  );
}
