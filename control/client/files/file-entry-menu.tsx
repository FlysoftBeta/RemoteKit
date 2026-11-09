import { useState } from 'react';
import {
  CheckBoxOutlined,
  ContentCopyOutlined,
  DeleteOutline,
  DriveFileMoveOutlined,
  ShoppingBasketOutlined,
  TuneOutlined,
  VisibilityOutlined,
} from '@mui/icons-material';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Typography,
  Snackbar,
} from '@mui/material';
import type { LibraryEntry } from '../../shared/file-library';
import { scaledAnchor } from '../app/ui-scale';
import { operationId } from '../control/product-operations';
import { useLibrary } from './file-library-state';
import { basketEntries, fileError, PartitionPicker } from './file-library-controls';
import { dayLabel, formatFileSize, formatTime } from './file-format';
import { canPreviewFile } from './file-image-preview';
import './file-entry-menu.css';

export function FileEntryMenu({
  entry,
  anchor,
  windowId,
  onClose,
  onOpen,
  onSelect,
  onDeleted,
}: {
  entry?: LibraryEntry;
  anchor?: HTMLElement;
  windowId: string;
  onClose(): void;
  onOpen?(entry: LibraryEntry): void;
  onSelect?(entry: LibraryEntry): void;
  onDeleted?(): void;
}) {
  const { snapshot, online, mutate, copySnippet } = useLibrary();
  const [copied, setCopied] = useState(false);
  const [move, setMove] = useState<LibraryEntry>();
  const [deletion, setDeletion] = useState<{ entry: LibraryEntry; operationId: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const basket = basketEntries(snapshot);
  const inBasket = basket.some((item) => item.id === entry?.id);
  const disabled = !online || busy || !snapshot;
  async function run(action: () => Promise<unknown>) {
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
  const choose = (action: (entry: LibraryEntry) => void) => {
    if (!entry) return;
    action(entry);
    onClose();
  };
  return (
    <>
      <Menu
        anchorEl={scaledAnchor(anchor)}
        open={!!anchor && !!entry}
        onClose={onClose}
        slotProps={{ list: { dense: true } }}
      >
        {entry?.kind === 'file' && (
          <Box className="file-entry-menu-heading">
            <Typography variant="subtitle2">{entry.name}</Typography>
            <Typography variant="caption" color="text.secondary">
              {dayLabel(entry.createdAt)} {formatTime(entry.createdAt)} · {formatFileSize(entry.size)}
              {entry.partitionId &&
                ` · ${snapshot?.partitions.find((partition) => partition.id === entry.partitionId)?.name ?? ''}`}
            </Typography>
          </Box>
        )}
        {entry?.kind === 'file' && <Divider />}
        {entry?.kind === 'snippet' && (
          <MenuItem
            disabled={disabled}
            onClick={() =>
              choose(
                (item) =>
                  void run(async () => {
                    await copySnippet(item.id);
                    setCopied(true);
                  }),
              )
            }
          >
            <ListItemIcon>
              <ContentCopyOutlined fontSize="small" />
            </ListItemIcon>
            <ListItemText>复制</ListItemText>
          </MenuItem>
        )}
        {onOpen && (
          <MenuItem disabled={disabled} onClick={() => choose(onOpen)}>
            <ListItemIcon>
              <VisibilityOutlined fontSize="small" />
            </ListItemIcon>
            <ListItemText>
              {entry?.kind === 'snippet' ? '查看全文' : entry && canPreviewFile(entry) ? '查看大图' : '预览'}
            </ListItemText>
          </MenuItem>
        )}
        {onOpen && entry?.photo && (
          <MenuItem disabled={disabled} onClick={() => choose(onOpen)}>
            <ListItemIcon>
              <TuneOutlined fontSize="small" />
            </ListItemIcon>
            <ListItemText>照片详情</ListItemText>
          </MenuItem>
        )}
        {entry?.kind === 'file' && (
          <MenuItem
            disabled={disabled || (!inBasket && basket.length >= 64)}
            onClick={() =>
              choose(
                (item) =>
                  void run(async () => {
                    if (!snapshot) return;
                    await mutate(
                      'library.basket',
                      {
                        operationId: operationId(),
                        ids: inBasket
                          ? basket.filter((value) => value.id !== item.id).map((value) => value.id)
                          : [...basket.map((value) => value.id), item.id],
                        expectedRevision: snapshot.revision,
                      },
                      windowId,
                    );
                  }),
              )
            }
          >
            <ListItemIcon>
              <ShoppingBasketOutlined fontSize="small" />
            </ListItemIcon>
            <ListItemText>{inBasket ? '从文件篮移除' : '加入文件篮'}</ListItemText>
          </MenuItem>
        )}
        <MenuItem disabled={disabled} onClick={() => choose(setMove)}>
          <ListItemIcon>
            <DriveFileMoveOutlined fontSize="small" />
          </ListItemIcon>
          <ListItemText>移到分区…</ListItemText>
        </MenuItem>
        {entry && entry.partitionId !== null && (
          <MenuItem
            disabled={disabled}
            onClick={() =>
              choose(
                (item) =>
                  void run(() =>
                    mutate('library.move', { operationId: operationId(), ids: [item.id], partitionId: null }),
                  ),
              )
            }
          >
            移出分区
          </MenuItem>
        )}
        {onSelect && (
          <MenuItem disabled={disabled} onClick={() => choose(onSelect)}>
            <ListItemIcon>
              <CheckBoxOutlined fontSize="small" />
            </ListItemIcon>
            <ListItemText>选择多个</ListItemText>
          </MenuItem>
        )}
        <Divider />
        <MenuItem
          disabled={disabled}
          sx={{ color: 'error.main' }}
          onClick={() => choose((item) => setDeletion({ entry: item, operationId: operationId() }))}
        >
          <ListItemIcon sx={{ color: 'inherit' }}>
            <DeleteOutline fontSize="small" />
          </ListItemIcon>
          <ListItemText>{entry?.kind === 'snippet' ? '删除' : '删除文件'}</ListItemText>
        </MenuItem>
      </Menu>
      <Snackbar open={copied} autoHideDuration={1600} onClose={() => setCopied(false)} message="已复制" />
      {error && !deletion && (
        <Dialog open onClose={() => setError('')}>
          <DialogTitle>操作失败</DialogTitle>
          <DialogContent>
            <Alert severity="error">{error}</Alert>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setError('')}>关闭</Button>
          </DialogActions>
        </Dialog>
      )}
      {move && (
        <PartitionPicker
          title="移动文件"
          partitions={snapshot?.partitions ?? []}
          initial={move.partitionId}
          onClose={() => setMove(undefined)}
          onChoose={(partitionId) => {
            const id = move.id;
            setMove(undefined);
            void run(() => mutate('library.move', { operationId: operationId(), ids: [id], partitionId }));
          }}
        />
      )}
      {deletion && (
        <Dialog
          open
          fullWidth
          maxWidth="xs"
          onClose={busy ? undefined : () => setDeletion(undefined)}
          aria-labelledby="file-entry-delete-title"
        >
          <DialogTitle id="file-entry-delete-title">删除文件？</DialogTitle>
          <DialogContent>
            <Typography sx={{ overflowWrap: 'anywhere' }}>{deletion.entry.name}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              将从我的文件和文件篮删除。页面已接收的副本会保留。
            </Typography>
            {error && <Alert severity="warning">{error}</Alert>}
          </DialogContent>
          <DialogActions>
            <Button disabled={busy} onClick={() => setDeletion(undefined)}>
              取消
            </Button>
            <Button
              color="error"
              variant="contained"
              disabled={disabled}
              onClick={() =>
                void run(async () => {
                  await mutate('library.delete', {
                    operationId: deletion.operationId,
                    ids: [deletion.entry.id],
                  });
                  setDeletion(undefined);
                  onDeleted?.();
                })
              }
            >
              删除文件
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </>
  );
}
