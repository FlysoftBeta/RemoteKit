import { ErrorOutline } from '@mui/icons-material';
import { ButtonBase, CircularProgress, Tooltip } from '@mui/material';
import { useState } from 'react';
import type { ClassMaterial, StudyAttachment } from '../../../shared/learning';
import type { LibraryEntry } from '../../../shared/file-library';
import { useLibrary } from '../../files/file-library-state';
import { FileTypeIcon, fileTypeColor } from '../../files/file-thumbnail';
import { formatFileSize } from '../../files/file-format';
import type { LearningCall } from '../queries';
import { time } from '../common';

function SaveIcon({
  attachment,
  busy,
  error,
}: {
  attachment: StudyAttachment;
  busy?: boolean;
  error?: string;
}) {
  if (busy || attachment.save.state === 'downloading')
    return <CircularProgress size={16} aria-label="正在保存" />;
  if (error || attachment.save.state === 'failed')
    return (
      <Tooltip
        title={`${error || (attachment.save.state === 'failed' ? attachment.save.message : '保存失败')} · 点击重试`}
      >
        <ErrorOutline className="learning-error" fontSize="small" />
      </Tooltip>
    );
  return null;
}

function FileRow({
  attachment,
  secondary,
  deadline,
  selected,
  busy,
  error,
  onClick,
  disabled,
}: {
  attachment: StudyAttachment;
  secondary: string;
  deadline?: number;
  selected?: boolean;
  busy?: boolean;
  error?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <ButtonBase
      className={`material-row${selected ? ' selected-card' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="attachment-icon" style={{ color: fileTypeColor('', attachment.name) }}>
        <FileTypeIcon type="" name={attachment.name} />
      </span>
      <span className="attachment-name">
        <strong>{attachment.name}</strong>
        <small>{secondary}</small>
      </span>
      <span className="attachment-trailing">
        {deadline && <small className="learning-attention">截止 {time(deadline)}</small>}
        <SaveIcon attachment={attachment} busy={busy} error={error} />
      </span>
    </ButtonBase>
  );
}

export function MaterialRow({
  item,
  selected,
  onClick,
}: {
  item: ClassMaterial;
  selected: boolean;
  onClick: () => void;
}) {
  const date =
    item.sharedAt === undefined
      ? '日期未知'
      : new Date(item.sharedAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
  return (
    <FileRow
      attachment={{ ...item.attachment, name: item.name }}
      secondary={`${item.sharedBy ?? '教师'} · ${date} · ${formatFileSize(item.sizeBytes ?? 0)}`}
      deadline={item.taskEndsAt}
      selected={selected}
      onClick={onClick}
    />
  );
}

export function AttachmentRow({
  attachment,
  call,
  open,
}: {
  attachment: StudyAttachment;
  call: LearningCall;
  open: (entry: LibraryEntry) => void;
}) {
  const library = useLibrary();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<string>();
  const entryId = saved ?? (attachment.save.state === 'saved' ? attachment.save.entryId : undefined);
  const show = async () => {
    setBusy(true);
    setError('');
    try {
      const id = entryId ?? (await call('study.attachment.save', { key: attachment.key })).entryId;
      setSaved(id);
      const snapshot = await library.refresh();
      const entry = snapshot?.entries.find((item) => item.id === id);
      if (!entry) throw new Error('文件尚未就绪');
      open(entry);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <FileRow
      attachment={saved ? { ...attachment, save: { state: 'saved', entryId: saved } } : attachment}
      secondary={formatFileSize(attachment.sizeBytes ?? 0)}
      busy={busy}
      error={error}
      disabled={!library.online || busy}
      onClick={() => void show()}
    />
  );
}
