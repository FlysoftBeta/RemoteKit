import { FileUploadOutlined } from '@mui/icons-material';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Typography,
} from '@mui/material';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RemoteKitError } from '../../shared/errors';
import type { LibraryFileEntry, LibraryPartition, LibrarySnapshot } from '../../shared/file-library';
import { ScaledSelect } from '../app/scaled-select';
import { failureError, FailureNote } from '../failures';
import { useLibrary } from './file-library-state';
import type { ImportControls } from './import-queue';
import './upload-queue.css';

export function basketEntries(snapshot?: LibrarySnapshot): LibraryFileEntry[] {
  if (!snapshot) return [];
  const entries = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  return snapshot.basket.flatMap((id) => {
    const entry = entries.get(id);
    return entry?.kind === 'file' ? [entry] : [];
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
  uploads: queue,
  accept,
  disabled,
  afterId,
  partitionId = null,
  requestId,
  onDone,
  onError,
}: {
  uploads: ImportControls;
  accept?: string[];
  disabled: boolean;
  afterId?: string;
  partitionId?: string | null;
  requestId?: string;
  onDone?: () => void;
  onError: (error: RemoteKitError | undefined) => void;
}) {
  const { snapshot } = useLibrary();
  const input = useRef<HTMLInputElement>(null);
  const { remaining, busy, jobs } = useSyncExternalStore(
    queue.subscribe,
    queue.getSnapshot,
    queue.getSnapshot,
  );
  const previousRemaining = useRef(remaining);
  useEffect(() => {
    if (previousRemaining.current && !remaining) onDone?.();
    previousRemaining.current = remaining;
  }, [remaining, onDone]);
  const add = (files: File[]) => {
    if (disabled || !files.length) return;
    try {
      const accepted = queue.enqueue(
        files,
        snapshot?.basket.length ?? 0,
        requestId ? { kind: 'request', requestId } : { kind: 'files', channel: 'upload', partitionId },
        afterId,
      );
      if (accepted) onError(undefined);
    } catch (failure) {
      onError(failureError(failure));
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
      <UploadQueueView jobs={jobs} busy={busy} onDiscard={!disabled ? queue.discard : undefined} />
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

type UploadJob = { id: string; name: string; error?: RemoteKitError };

export function UploadQueueView({
  jobs,
  busy,
  onDiscard,
}: {
  jobs: UploadJob[];
  busy: boolean;
  onDiscard?: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const failed = jobs.find((job) => job.error);
  return (
    <div data-upload-queue className="upload-queue">
      {!!jobs.length && (
        <>
          <div className="upload-queue-toolbar">
            <span>上传队列 · {jobs.length} 个文件</span>
            <Button size="small" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              {expanded ? '收起上传队列' : '展开上传队列'}
            </Button>
            {!busy && onDiscard && (
              <Button size="small" onClick={onDiscard}>
                放弃上传
              </Button>
            )}
          </div>
          {expanded ? (
            <div className="upload-jobs">
              {jobs.map((job, index) => (
                <UploadJobNote key={job.id} job={job} busy={busy && index === 0} />
              ))}
            </div>
          ) : failed ? (
            <FailureNote
              error={failed.error}
              context={{
                operation: '导入文件',
                scope: 'surface',
                targetId: failed.id,
                itemName: failed.name,
              }}
            />
          ) : busy ? (
            <LinearProgress aria-label="正在上传文件" />
          ) : null}
        </>
      )}
    </div>
  );
}

export function UploadJobNote({ job, busy = false }: { job: UploadJob; busy?: boolean }) {
  return (
    <div data-upload-job={job.id}>
      {!job.error && (
        <span>
          {job.name}
          {!busy && ' · 等待上传'}
        </span>
      )}
      {busy && !job.error && <LinearProgress aria-label={`正在上传 ${job.name}`} />}
      <FailureNote
        error={job.error}
        context={{ operation: '导入文件', scope: 'item', targetId: job.id, itemName: job.name }}
      />
    </div>
  );
}
