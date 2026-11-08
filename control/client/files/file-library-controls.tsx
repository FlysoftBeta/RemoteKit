import { FileUploadOutlined } from '@mui/icons-material';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { LibraryEntry, LibraryPartition, LibrarySnapshot } from '../../shared/file-library';
import { ScaledSelect } from '../app/scaled-select';
import { formatError } from '../util/format-error';
import { useLibrary } from './file-library-state';
import { ImportQueue } from './import-queue';

export function fileError(error: unknown) {
  return formatError(error);
}

export function basketEntries(snapshot?: LibrarySnapshot): LibraryEntry[] {
  if (!snapshot) return [];
  const entries = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  return snapshot.basket.flatMap((id) => {
    const entry = entries.get(id);
    return entry ? [entry] : [];
  });
}

export function PartitionField({
  partitions,
  value,
  onChange,
}: {
  partitions: LibraryPartition[];
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  return (
    <ScaledSelect
      fullWidth
      label="分区"
      value={value ?? ''}
      onChange={(value) => onChange(value || null)}
      options={[
        { value: '', label: '移出分区' },
        ...partitions.map((partition) => ({ value: partition.id, label: partition.name })),
      ]}
    />
  );
}

interface PartitionChoice {
  partitions: LibraryPartition[];
  title: string;
  detail?: string;
  initial?: string | null;
  disabled?: boolean;
  onClose: () => void;
  onChoose: (partitionId: string | null) => void;
}

export function PartitionPicker({
  partitions,
  title,
  detail,
  onClose,
  onChoose,
  initial = null,
  disabled = false,
}: PartitionChoice) {
  const [partition, setPartition] = useState(initial);
  return (
    <Dialog open fullWidth maxWidth="xs" onClose={onClose}>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {detail && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {detail}
          </Typography>
        )}
        <Box sx={{ pt: detail ? 0 : 1 }}>
          <PartitionField partitions={partitions} value={partition} onChange={setPartition} />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>取消</Button>
        <Button variant="contained" disabled={disabled} onClick={() => onChoose(partition)}>
          确认
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function useDeviceImport({
  destination,
  accept,
  disabled,
  afterId,
  partitionId = null,
  requestId,
  windowId,
  onDone,
  onError,
}: {
  destination: 'library' | 'basket';
  accept?: string[];
  disabled: boolean;
  afterId?: string;
  partitionId?: string | null;
  requestId?: string;
  windowId?: string;
  onDone?: () => void;
  onError: (message: string) => void;
}) {
  const { rpc, snapshot, mutate, online, scope } = useLibrary();
  const input = useRef<HTMLInputElement>(null);
  const [queue] = useState(
    () => new ImportQueue({ rpc, mutate: (method, params) => mutate(method, params, windowId) }, destination),
  );
  const { remaining, busy, error } = useSyncExternalStore(
    queue.subscribe,
    queue.getSnapshot,
    queue.getSnapshot,
  );
  const previousRemaining = useRef(remaining);
  useEffect(() => queue.configure(online, scope), [queue, online, scope]);
  useEffect(() => () => queue.dispose(), [queue]);
  useEffect(() => {
    if (error) onError(error);
  }, [error, onError]);
  useEffect(() => {
    if (previousRemaining.current && !remaining) onDone?.();
    previousRemaining.current = remaining;
  }, [remaining, onDone]);
  const add = (files: File[]) => {
    if (disabled || !files.length) return;
    try {
      queue.enqueue(
        files,
        snapshot?.basket.length ?? 0,
        requestId ? { kind: 'request', requestId } : { kind: 'files', channel: 'upload', partitionId },
        afterId,
      );
    } catch (failure) {
      onError(fileError(failure));
    }
  };
  const view = (
    <>
      <input
        ref={input}
        hidden
        type="file"
        multiple
        accept={accept?.join(',') || undefined}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          add(files);
        }}
      />
      {!!remaining && !busy && !disabled && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ mr: 'auto' }}>
            还有 {remaining} 个文件未上传
          </Typography>
          <Button size="small" onClick={queue.discard}>
            放弃
          </Button>
          <Button size="small" variant="contained" onClick={() => void queue.upload()}>
            继续上传
          </Button>
        </Box>
      )}
    </>
  );
  return { pick: () => !disabled && input.current?.click(), add, view, busy, remaining };
}

const hasFiles = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes('Files');

// Accepts files dragged in from the desktop, with an overlay while they hover.
export function FileDropZone({
  label,
  disabled,
  onFiles,
  children,
  sx,
}: {
  label: string;
  disabled: boolean;
  onFiles: (files: File[]) => void;
  children: React.ReactNode;
  sx?: React.ComponentProps<typeof Box>['sx'];
}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  return (
    <Box
      sx={[{ position: 'relative' }, ...(Array.isArray(sx) ? sx : [sx ?? {}])]}
      onDragEnter={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        depth.current++;
        setOver(true);
      }}
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
      }}
      onDragLeave={(event) => {
        if (!hasFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setOver(false);
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        depth.current = 0;
        setOver(false);
        if (!disabled) onFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {children}
      {over && (
        <Box
          sx={{
            position: 'absolute',
            inset: 4,
            zIndex: 5,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1,
            border: '2px dashed',
            borderColor: disabled ? 'divider' : 'primary.main',
            borderRadius: '12px',
            bgcolor: 'rgb(255 255 255 / 92%)',
            color: disabled ? 'text.secondary' : 'primary.main',
            pointerEvents: 'none',
          }}
        >
          <FileUploadOutlined />
          <Typography variant="body2">{disabled ? '暂时不能添加文件' : label}</Typography>
        </Box>
      )}
    </Box>
  );
}
