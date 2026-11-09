import { useAutoFocus } from '../editing/local-autofocus';
import { ChevronRight, FolderOutlined } from '@mui/icons-material';
import {
  Alert,
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
import { useRef, useState } from 'react';
import { scaledAnchor } from '../app/ui-scale';
import { operationId } from '../control/product-operations';
import { fileError } from './file-library-controls';
import { useLibrary } from './file-library-state';

export function BasketPartitionMenu({ disabled, ids }: { disabled: boolean; ids?: string[] }) {
  const autoFocusRef = useAutoFocus<HTMLInputElement>();
  const { snapshot, mutate } = useLibrary();
  const [anchor, setAnchor] = useState<HTMLElement>();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const creation = useRef<
    { operationId: string; name: string; before: Set<string>; partitionId?: string } | undefined
  >(undefined);
  async function choose(partitionId: string | null) {
    if (ids) await mutate('library.move', { operationId: operationId(), ids, partitionId });
    else await mutate('library.basketPartition', { operationId: operationId(), partitionId });
    setAnchor(undefined);
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(fileError(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <MenuItem
        disabled={disabled || busy}
        onClick={(event) => setAnchor(event.currentTarget)}
        aria-haspopup="menu"
      >
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
          disabled={busy}
          selected={!ids && snapshot?.basketPartitionId === null}
          onClick={() => void run(() => choose(null))}
        >
          {ids ? '移出分区' : '不整理'}
        </MenuItem>
        {snapshot?.partitions.map((partition) => (
          <MenuItem
            key={partition.id}
            disabled={busy}
            selected={!ids && snapshot.basketPartitionId === partition.id}
            onClick={() => void run(() => choose(partition.id))}
          >
            {partition.name}
          </MenuItem>
        ))}
        <MenuItem
          disabled={busy}
          onClick={() => {
            setCreating(true);
            creation.current = undefined;
            setName('');
            setError('');
          }}
        >
          新建分区
        </MenuItem>
        {error && <Alert severity="warning">{error}</Alert>}
      </Menu>
      {creating && (
        <Dialog open fullWidth maxWidth="xs" onClose={busy ? undefined : () => setCreating(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim() || busy) return;
              void run(async () => {
                const pending = (creation.current ??= {
                  operationId: operationId(),
                  name: name.trim(),
                  before: new Set(snapshot?.partitions.map((partition) => partition.id)),
                });
                if (!pending.partitionId) {
                  const next = await mutate('library.partition', {
                    operationId: pending.operationId,
                    name: pending.name,
                  });
                  pending.partitionId = next.partitions.find(
                    (partition) => !pending.before.has(partition.id) && partition.name === pending.name,
                  )?.id;
                }
                if (pending.partitionId) await choose(pending.partitionId);
                setCreating(false);
              });
            }}
          >
            <DialogTitle>新建分区</DialogTitle>
            <DialogContent>
              <TextField
                label="分区名称"
                inputRef={autoFocusRef}
                fullWidth
                disabled={busy || !!creation.current}
                value={name}
                onChange={(event) => setName(event.target.value)}
                slotProps={{ htmlInput: { maxLength: 120 } }}
                sx={{ mt: 1 }}
              />
              {error && (
                <Alert severity="warning" sx={{ mt: 1 }}>
                  {error}
                </Alert>
              )}
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={() => setCreating(false)}>
                取消
              </Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                创建并选择
              </Button>
            </DialogActions>
          </form>
        </Dialog>
      )}
    </>
  );
}
