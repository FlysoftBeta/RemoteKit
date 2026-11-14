import { ButtonBase, CircularProgress } from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { RemoteKitError } from '../../../shared/errors';
import type { LibraryEntry } from '../../../shared/file-library';
import type { ClassMaterial, StudyAttachment } from '../../../shared/learning';
import { failureError, FailureNote } from '../../failures';
import { recover, recoverRead } from '../../failures/recovery';
import { formatFileSize } from '../../files/file-format';
import { useLibrary } from '../../files/file-library-state';
import { fileTypeColor, FileTypeIcon } from '../../files/file-thumbnail';
import { time } from '../common';
import type { LearningCall } from '../queries';

function SaveIcon({ attachment, busy }: { attachment: StudyAttachment; busy?: boolean }) {
  if (busy || attachment.save.state === 'downloading')
    return <CircularProgress size={16} aria-label="正在保存" />;
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
  error?: RemoteKitError;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <div>
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
          <SaveIcon attachment={attachment} busy={busy && !error} />
        </span>
      </ButtonBase>
      <FailureNote
        error={
          error ??
          (attachment.save.state === 'failed' || attachment.save.state === 'unknown'
            ? attachment.save.error
            : undefined)
        }
        context={{ operation: '保存附件', scope: 'item', credential: 'changyan', targetId: attachment.key }}
      />
    </div>
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
  const abort = useRef(new AbortController());
  useEffect(() => () => abort.current.abort(), []);
  const [error, setError] = useState<RemoteKitError | undefined>();
  const [saved, setSaved] = useState<string>();
  const entryId = saved ?? (attachment.save.state === 'saved' ? attachment.save.entryId : undefined);

  const show = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const id =
        entryId ??
        (
          await recover(
            () => call('study.attachment.save', { key: attachment.key }),
            abort.current.signal,
            setError,
          )
        ).entryId;
      setSaved(id);
      const entry = await recoverRead(
        async () => {
          const snapshot = await library.refresh();
          const entry = snapshot.entries.find((item) => item.id === id);
          if (!entry) throw new RemoteKitError('unavailable', '文件尚未就绪');
          return entry;
        },
        abort.current.signal,
        setError,
      );
      open(entry);
    } catch (failure) {
      setError(failureError(failure));
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
