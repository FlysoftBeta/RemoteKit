import { FileUploadOutlined } from '@mui/icons-material';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { LibraryEntry, LibraryGroup, LibrarySnapshot } from '../../shared/file-library';
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

export function GroupField({
  groups,
  value,
  onChange,
}: {
  groups: LibraryGroup[];
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  return (
    <ScaledSelect
      fullWidth
      label="分组"
      value={value ?? ''}
      onChange={(value) => onChange(value || null)}
      options={[
        { value: '', label: '不分组' },
        ...groups.map((group) => ({ value: group.id, label: group.name })),
      ]}
    />
  );
}

interface GroupChoice {
  groups: LibraryGroup[];
  title: string;
  detail?: string;
  initial?: string | null;
  disabled?: boolean;
  onClose: () => void;
  onChoose: (groupId: string | null) => void;
}

// Inline form, used where the surrounding surface must stay put (the anchored file basket).
export function GroupConfirm({
  groups,
  title,
  detail,
  onClose,
  onChoose,
  initial = null,
  disabled = false,
}: GroupChoice) {
  const [group, setGroup] = useState(initial);
  return (
    <Box sx={{ p: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Box>
        <Typography variant="subtitle2">{title}</Typography>
        {detail && (
          <Typography variant="caption" color="text.secondary">
            {detail}
          </Typography>
        )}
      </Box>
      <GroupField groups={groups} value={group} onChange={setGroup} />
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
        <Button onClick={onClose}>返回</Button>
        <Button variant="contained" disabled={disabled} onClick={() => onChoose(group)}>
          确认
        </Button>
      </Box>
    </Box>
  );
}

export function GroupPicker({
  groups,
  title,
  detail,
  onClose,
  onChoose,
  initial = null,
  disabled = false,
}: GroupChoice) {
  const [group, setGroup] = useState(initial);
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
          <GroupField groups={groups} value={group} onChange={setGroup} />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>取消</Button>
        <Button variant="contained" disabled={disabled} onClick={() => onChoose(group)}>
          确认
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// Uploads from the device into the library or the basket. `pick` opens the system picker,
// `add` takes dropped files; once groups exist every batch asks for its group explicitly.
// `view` renders the hidden input, the group choice and the resume controls.
export function useDeviceImport({
  destination,
  accept,
  disabled,
  afterId,
  initialGroup = null,
  inlineChoice = false,
  onDone,
  onError,
}: {
  destination: 'library' | 'basket';
  accept?: string[];
  disabled: boolean;
  afterId?: string;
  initialGroup?: string | null;
  inlineChoice?: boolean;
  onDone?: () => void;
  onError: (message: string) => void;
}) {
  const { rpc, snapshot, mutate, online, scope } = useLibrary();
  const groups = snapshot?.groups ?? [];
  const input = useRef<HTMLInputElement>(null);
  const [queue] = useState(() => new ImportQueue({ rpc, mutate }, destination));
  const { picking, remaining, busy, error } = useSyncExternalStore(
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
      queue.enqueue(files, snapshot?.basket.length ?? 0, groups.length > 0, afterId);
    } catch (failure) {
      onError(fileError(failure));
    }
  };
  const Choose = inlineChoice ? GroupConfirm : GroupPicker;
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
      {picking && (
        <Choose
          title="上传到哪个分组？"
          detail={`${remaining} 个文件`}
          disabled={disabled}
          groups={groups}
          initial={initialGroup}
          onClose={queue.discard}
          onChoose={queue.choose}
        />
      )}
      {!!remaining && !picking && !busy && !disabled && (
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
