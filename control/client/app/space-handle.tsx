import { ViewWeekOutlined } from '@mui/icons-material';
import { IconButton } from '@mui/material';
import type { ProductSpace, ProductState } from '../../shared/product';
import { useHandleActivation } from './handle-activation';
import type { Action } from './product-dialogs';
import { SpaceMenu } from './space-menu';

export function SpaceHandle({
  space,
  state,
  online,
  action,
  report,
}: {
  space: ProductSpace;
  state: ProductState;
  online: boolean;
  action: Action;
  report(error: unknown): void;
}) {
  const activation = useHandleActivation({
    disabled: !online,
    onMenu: () => {},
    onDouble: () => void action({ type: 'space.close', spaceIds: [space.id] }).catch(report),
  });
  return (
    <>
      <IconButton
        {...activation.buttonProps}
        aria-label="窗口组把手"
        title={space.name ?? undefined}
        disabled={!online}
        className="space-handle"
        sx={{ width: 28, height: 28, padding: '4px', flexShrink: 0 }}
      >
        <ViewWeekOutlined fontSize="small" />
      </IconButton>
      <SpaceMenu
        space={space}
        state={state}
        action={action}
        report={report}
        anchor={activation.menuAnchor}
        close={activation.closeMenu}
      />
    </>
  );
}
