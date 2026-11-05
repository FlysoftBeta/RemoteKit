import { Box, Button, Dialog, MenuItem, TextField, Typography } from '@mui/material';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { LibraryEntry, LibraryGroup, LibrarySnapshot } from '../../shared/file-library';
import { ImportQueue } from './import-queue';
import { formatError } from '../util/format-error';
import { useLibrary } from './file-library-state';

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

export const touchButton = { minWidth: 44, minHeight: 44 };
export function GroupField({
  groups,
  value,
  onChange,
  includeAll = false,
}: {
  groups: LibraryGroup[];
  value: string | null;
  onChange: (value: string | null) => void;
  includeAll?: boolean;
}) {
  return (
    <TextField
      select
      size="small"
      fullWidth
      label="分组"
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || null)}
    >
      {includeAll && <MenuItem value="*">全部文件</MenuItem>}
      <MenuItem value="">未分组</MenuItem>
      {groups.map((group) => (
        <MenuItem key={group.id} value={group.id}>
          {group.name}
        </MenuItem>
      ))}
    </TextField>
  );
}

export function GroupConfirm({
  groups,
  title,
  onClose,
  onChoose,
  initial = null,
  disabled = false,
}: {
  groups: LibraryGroup[];
  title: string;
  initial?: string | null;
  disabled?: boolean;
  onClose: () => void;
  onChoose: (groupId: string | null) => void;
}) {
  const [group, setGroup] = useState(initial);
  return (
    <Box sx={{ p: 1, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      <Typography variant="subtitle2">{title}</Typography>
      <GroupField groups={groups} value={group} onChange={setGroup} />
      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button onClick={onClose}>返回</Button>
        <Button variant="contained" disabled={disabled} onClick={() => onChoose(group)}>
          确认
        </Button>
      </Box>
    </Box>
  );
}

export function GroupPicker(props: Parameters<typeof GroupConfirm>[0]) {
  return (
    <Dialog open fullWidth maxWidth="xs" onClose={props.onClose}>
      <GroupConfirm {...props} />
    </Dialog>
  );
}
export function DeviceImport({
  destination,
  accept,
  disabled,
  afterId,
  onDone,
  onError,
  inputRef,
  onBusy,
  inline = false,
}: {
  destination: 'library' | 'basket';
  accept?: string[];
  inline?: boolean;
  disabled: boolean;
  afterId?: string;
  onDone?: () => void;
  onError: (message: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onBusy?: (busy: boolean) => void;
}) {
  const { rpc, snapshot, mutate, online, scope } = useLibrary();
  const groups = snapshot?.groups ?? [];
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
    onBusy?.(busy);
    return () => onBusy?.(false);
  }, [busy, onBusy]);
  useEffect(() => {
    if (error) onError(error);
  }, [error, onError]);
  useEffect(() => {
    if (previousRemaining.current && !remaining) onDone?.();
    previousRemaining.current = remaining;
  }, [remaining, onDone]);
  const discard = queue.discard;
  const ChooseGroup = inline ? GroupConfirm : GroupPicker;
  return (
    <>
      <input
        ref={inputRef}
        hidden
        type="file"
        multiple
        accept={accept?.join(',') || undefined}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          try {
            queue.enqueue(files, snapshot?.basket.length ?? 0, groups.length > 0, afterId);
          } catch (error) {
            onError(fileError(error));
          }
        }}
      />
      {picking && (
        <ChooseGroup
          title="选择上传分组"
          disabled={disabled}
          groups={groups}
          onClose={discard}
          onChoose={queue.choose}
        />
      )}
      {!!remaining && !picking && !disabled && (
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button onClick={() => void queue.upload()}>继续上传（{remaining}）</Button>
          <Button onClick={discard}>放弃剩余上传</Button>
        </Box>
      )}
    </>
  );
}
