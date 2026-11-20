import { ChevronRight, FolderOutlined } from '@mui/icons-material';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  TextField,
} from '@mui/material';
import { useState } from 'react';
import { RemoteKitError } from '../../shared/errors';
import { scaledAnchor } from '../app/ui-scale';
import { operationId } from '../control/product-operations';
import { useAutoFocus } from '../editing/local-autofocus';
import { failureError, FailureNote } from '../failures';
import { useLibrary } from './file-library-state';

export function BasketPartitionMenu({ disabled, ids }: { disabled: boolean; ids?: string[] }) {
  const autoFocusRef = useAutoFocus<HTMLInputElement>();
  const { snapshot, mutate, createPartition } = useLibrary();
  const [anchor, setAnchor] = useState<HTMLElement>();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<RemoteKitError | undefined>();
  async function choose(partitionId: string | null) {
    setAnchor(undefined);
    if (ids) await mutate('library.move', { operationId: operationId(), ids, partitionId });
    else await mutate('library.basketPartition', { operationId: operationId(), partitionId });
  }
  async function run(action: () => Promise<void>) {
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      setError(failureError(failure));
    }
  }
  return (
    <>
      <MenuItem disabled={disabled} onClick={(event) => setAnchor(event.currentTarget)} aria-haspopup="menu">
        <ListItemIcon>
          <FolderOutlined fontSize="small" />
        </ListItemIcon>
        <ListItemText>{ids ? '整理到分区' : '发送后整理到'}</ListItemText>
        <ChevronRight fontSize="small" />
      </MenuItem>
      <Menu
        anchorEl={scaledAnchor(anchor)}
        open={!!anchor}
        onClose={() => setAnchor(undefined)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      >
        <MenuItem
          selected={!ids && snapshot?.basketPartitionId === null}
          onClick={() => void run(() => choose(null))}
        >
          {ids ? '移出分区' : '不整理'}
        </MenuItem>
        {snapshot?.partitions.map((partition) => (
          <MenuItem
            key={partition.id}
            selected={!ids && snapshot.basketPartitionId === partition.id}
            onClick={() => void run(() => choose(partition.id))}
          >
            {partition.name}
          </MenuItem>
        ))}
        <MenuItem
          onClick={() => {
            setCreating(true);
            setName('');
            setError(undefined);
          }}
        >
          新建分区
        </MenuItem>
      </Menu>
      {error && <FailureNote error={error} context={{ operation: '选择分区', scope: 'surface' }} />}
      {creating && (
        <Dialog open fullWidth maxWidth="xs" onClose={() => setCreating(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim()) return;
              setCreating(false);
              setAnchor(undefined);
              void run(async () => {
                await createPartition(name.trim(), ids);
              });
            }}
          >
            <DialogTitle>新建分区</DialogTitle>
            <DialogContent>
              <TextField
                label="分区名称"
                inputRef={autoFocusRef}
                fullWidth
                value={name}
                onChange={(event) => setName(event.target.value)}
                slotProps={{ htmlInput: { maxLength: 120 } }}
                sx={{ mt: 1 }}
              />
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setCreating(false)}>取消</Button>
              <Button type="submit" disabled={!name.trim()}>
                创建并选择
              </Button>
            </DialogActions>
          </form>
        </Dialog>
      )}
    </>
  );
}
