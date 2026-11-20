import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Menu,
  MenuItem,
  TextField,
} from '@mui/material';
import { useState } from 'react';
import type { ProductSpace, ProductState } from '../../shared/product';
import type { Action } from './product-dialogs';
import { scaledAnchor } from './ui-scale';

export function SpaceMenu({
  space,
  state,
  anchor,
  close,
  action,
  report,
}: {
  space: ProductSpace;
  state: ProductState;
  anchor: HTMLElement | null;
  close(): void;
  action: Action;
  report(error: unknown): void;
}) {
  const [name, setName] = useState<string>();
  const run = (command: Parameters<Action>[0]) => {
    close();
    void action(command).catch(report);
  };
  const rename = () => {
    if (name === undefined || name.trim().length > 40) return;
    run({ type: 'space.rename', spaceId: space.id, name });
    setName(undefined);
  };
  const ids = state.workspace.spaces.map((group) => group.id);
  return (
    <>
      <Menu open={!!anchor} anchorEl={scaledAnchor(anchor)} onClose={close}>
        <MenuItem
          onClick={() => {
            close();
            setName(space.name ?? '');
          }}
        >
          命名…
        </MenuItem>
        <MenuItem onClick={() => run({ type: 'space.close', spaceIds: [space.id] })}>关闭窗口组</MenuItem>
        <MenuItem onClick={() => run({ type: 'space.close', spaceIds: ids })}>关闭所有窗口组</MenuItem>
        <MenuItem
          disabled={ids.length < 2}
          onClick={() => run({ type: 'space.close', spaceIds: ids.filter((id) => id !== space.id) })}
        >
          关闭其他窗口组
        </MenuItem>
      </Menu>
      <Dialog open={name !== undefined} onClose={() => setName(undefined)} fullWidth maxWidth="xs">
        <DialogTitle>命名窗口组</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label="名称"
            value={name ?? ''}
            error={(name?.trim().length ?? 0) > 40}
            helperText="最多 40 个字符，留空清除名称"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                rename();
              }
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setName(undefined)}>取消</Button>
          <Button disabled={(name?.trim().length ?? 0) > 40} onClick={rename}>
            确定
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
