import { Alert, Button, LinearProgress } from '@mui/material';
import { Suspense, lazy, memo, useEffect, useMemo, useRef, useState } from 'react';
import { canonicalJson } from '../util/canonical-json';
import { formatError } from '../util/format-error';
import type { FileChannel } from './file-channel';
import type { LibraryEntry, LibraryFileEntry } from '../../shared/file-library';
import { ChannelDocumentSource } from '../documents/channel-source';
import type { DocumentProgress } from '../documents/document-source';
import type { LearningCall } from '../learning/queries';
import { FileImagePreview } from './file-image-preview';
import { useLibrary } from './file-library-state';
import { FileTypeIcon } from './file-thumbnail';
import { formatFileSize, fileKind } from './file-format';
import './file-preview.css';
const DocumentViewer = lazy(() =>
  import('../documents/document-viewer').then((module) => ({ default: module.DocumentViewer })),
);

export const isDocumentFile = (entry: Pick<LibraryEntry, 'name' | 'type'>) =>
  /\.(pdf|docx?|pptx?|xlsx?|odt|odp|ods|rtf|txt|wps|et|dps)$/i.test(entry.name) ||
  /^(application\/pdf|text\/plain|application\/vnd\.(?:openxmlformats|ms-|oasis)|application\/msword|application\/rtf)/i.test(
    entry.type,
  );

function MediaPreview({ entry }: { entry: LibraryFileEntry }) {
  const { rpc, online } = useLibrary();
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    let objectUrl = '';
    setError('');
    setUrl('');
    void rpc.readAsset(entry, controller.signal).then(
      (blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      },
      (failure) => {
        if (!controller.signal.aborted) setError(formatError(failure));
      },
    );
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [rpc, online, entry.assetId, attempt]);
  return (
    <div className="file-media-preview">
      {!online ? (
        <Alert severity="info">连接已断开</Alert>
      ) : error ? (
        <Alert severity="error" action={<Button onClick={() => setAttempt(attempt + 1)}>重试</Button>}>
          {error}
        </Alert>
      ) : url ? (
        fileKind(entry.type, entry.name) === 'video' ? (
          <video src={url} controls aria-label={entry.name} onError={() => setError('无法播放此文件')} />
        ) : (
          <audio src={url} controls aria-label={entry.name} onError={() => setError('无法播放此文件')} />
        )
      ) : (
        <LinearProgress aria-label="正在读取文件" />
      )}
    </div>
  );
}

export function FilePreview(
  props: Omit<React.ComponentProps<typeof PreviewContent>, 'rpc' | 'online' | 'entry'> & {
    entry: LibraryEntry;
  },
) {
  const { rpc, online } = useLibrary();
  return props.entry.kind === 'file' ? (
    <PreviewContent {...props} entry={props.entry} rpc={rpc} online={online} />
  ) : null;
}

const PreviewContent = memo(
  function PreviewContent({
    entry,
    call,
    onBasket,
    onFiles,
    rpc,
    online,
  }: {
    entry: LibraryFileEntry;
    rpc: FileChannel;
    online: boolean;
    call?: LearningCall;
    onBasket?: () => void;
    onFiles?: () => void;
  }) {
    const source = useMemo(() => new ChannelDocumentSource(rpc, entry.assetId), [rpc, entry.assetId]);
    const [progress, setProgress] = useState<DocumentProgress | null | undefined>();
    const [progressError, setProgressError] = useState('');
    const pendingProgress = useRef<DocumentProgress>(undefined);
    const [attempt, setAttempt] = useState(0);
    const document = isDocumentFile(entry);
    useEffect(() => {
      setProgress(undefined);
      setProgressError('');
      pendingProgress.current = undefined;
      let active = true;
      if (!document || !call || !online) return;
      void call('document.progress.get', { assetId: entry.assetId }).then(
        (value) => {
          if (active) setProgress(value);
        },
        (error) => {
          if (active) setProgressError(formatError(error));
        },
      );
      return () => {
        active = false;
      };
    }, [entry.assetId, call, document, online, attempt]);
    const saveProgress = (value: DocumentProgress) => {
      if (!call) return;
      pendingProgress.current = value;
      void call('document.progress.set', { assetId: entry.assetId, ...value }).then(
        () => setProgressError(''),
        (error) => setProgressError(formatError(error)),
      );
    };
    if (!online) return <Alert severity="info">连接已断开，恢复后继续预览</Alert>;
    if (document)
      return (
        <div className="file-document-preview">
          {progressError && (
            <Alert
              severity="error"
              action={
                <Button
                  onClick={() =>
                    pendingProgress.current ? saveProgress(pendingProgress.current) : setAttempt(attempt + 1)
                  }
                >
                  重试
                </Button>
              }
            >
              {progressError}
            </Alert>
          )}
          {call && progress === undefined ? (
            !progressError && <LinearProgress aria-label="正在读取阅读进度" />
          ) : (
            <Suspense fallback={<LinearProgress aria-label="正在打开文档" />}>
              <DocumentViewer
                source={source}
                title={entry.name}
                type={entry.type}
                hideTitle
                initialProgress={progress ?? undefined}
                onProgress={saveProgress}
              />
            </Suspense>
          )}
        </div>
      );
    if (entry.type.startsWith('image/'))
      return (
        <div className="file-image-content">
          <FileImagePreview entry={entry} inline onClose={() => {}} hideBack fullSize />
        </div>
      );
    if (['audio', 'video'].includes(fileKind(entry.type, entry.name))) return <MediaPreview entry={entry} />;
    return (
      <div className="file-plain-preview">
        <span className="file-plain-icon">
          <FileTypeIcon name={entry.name} type={entry.type} />
        </span>
        <strong>{entry.name}</strong>
        <span>{formatFileSize(entry.size)}</span>
        <p>此类型暂不支持内容预览</p>
        {onBasket && (
          <Button variant="outlined" onClick={onBasket}>
            加入文件篮
          </Button>
        )}
        {onFiles && <Button onClick={onFiles}>在我的文件中查看</Button>}
      </div>
    );
  },
  (previous, next) =>
    previous.rpc === next.rpc &&
    previous.online === next.online &&
    previous.call === next.call &&
    previous.onBasket === next.onBasket &&
    previous.onFiles === next.onFiles &&
    canonicalJson(previous.entry) === canonicalJson(next.entry),
);
