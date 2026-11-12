import { Button, LinearProgress } from '@mui/material';
import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { RemoteKitError } from '../../shared/errors';
import type { LibraryEntry, LibraryFileEntry } from '../../shared/file-library';
import { ChannelDocumentSource } from '../documents/channel-source';
import type { DocumentProgress } from '../documents/document-source';
import { failureError, FailureNote, SurfaceState } from '../failures';
import { recover } from '../failures/recovery';
import type { LearningCall } from '../learning/queries';
import { canonicalJson } from '../util/canonical-json';
import type { FileChannel } from './file-channel';
import { fileKind, formatFileSize } from './file-format';
import { FileImagePreview } from './file-image-preview';
import { useLibrary } from './file-library-state';
import './file-preview.css';
import { FileTypeIcon } from './file-thumbnail';
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
  const [error, setError] = useState<RemoteKitError | undefined>();
  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    let objectUrl = '';
    setError(undefined);
    setUrl('');
    void recover(() => rpc.readAsset(entry, controller.signal), controller.signal, setError).then(
      (blob) => {
        if (controller.signal.aborted) return;
        setError(undefined);
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      },
      (failure) => {
        if (!controller.signal.aborted) setError(failureError(failure));
      },
    );
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [rpc, online, entry.assetId]);
  return (
    <div className="file-media-preview">
      {!online ? (
        <FailureNote
          error={new RemoteKitError('unavailable', '')}
          context={{ operation: '读取媒体文件', scope: 'surface' }}
        />
      ) : error ? (
        <FailureNote error={error} context={{ operation: '读取媒体文件', scope: 'surface' }} />
      ) : url ? (
        fileKind(entry.type, entry.name) === 'video' ? (
          <video
            src={url}
            controls
            aria-label={entry.name}
            onError={() =>
              setError(new RemoteKitError('rejected', '此文件无法播放', { reason: 'document_unsupported' }))
            }
          />
        ) : (
          <audio
            src={url}
            controls
            aria-label={entry.name}
            onError={() =>
              setError(new RemoteKitError('rejected', '此文件无法播放', { reason: 'document_unsupported' }))
            }
          />
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
  if (!props.entry.available)
    return (
      <div className="file-plain-preview" role="status">
        文件暂不可用，恢复后自动继续
      </div>
    );
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
    const source = useMemo(
      () => new ChannelDocumentSource(rpc, entry.assetId, entry.type),
      [rpc, entry.assetId, entry.type],
    );
    const [progress, setProgress] = useState<DocumentProgress | null | undefined>();
    const [progressError, setProgressError] = useState<RemoteKitError | undefined>();
    const pendingProgress = useRef<DocumentProgress>(undefined);
    const document = isDocumentFile(entry);
    useEffect(() => {
      setProgress(undefined);
      setProgressError(undefined);
      pendingProgress.current = undefined;
      let active = true;
      const abort = new AbortController();
      if (!document || !call || !online) return;
      void recover(
        () => call('document.progress.get', { assetId: entry.assetId }),
        abort.signal,
        setProgressError,
      ).then(
        (value) => {
          if (active) {
            setProgress(value);
            setProgressError(undefined);
          }
        },
        (error) => {
          if (active) {
            setProgressError(failureError(error));
            setProgress(null);
          }
        },
      );
      return () => {
        active = false;
        abort.abort();
      };
    }, [entry.assetId, call, document, online]);
    const progressAbort = useRef<AbortController | undefined>(undefined);
    useEffect(() => () => progressAbort.current?.abort(), []);
    const saveProgress = (value: DocumentProgress) => {
      if (!call) return;
      pendingProgress.current = value;
      progressAbort.current?.abort();
      progressAbort.current = new AbortController();
      void recover(
        () => call('document.progress.set', { assetId: entry.assetId, ...pendingProgress.current! }),
        progressAbort.current.signal,
        setProgressError,
      ).then(
        () => setProgressError(undefined),
        (error) => setProgressError(failureError(error)),
      );
    };
    if (!online)
      return (
        <FailureNote
          error={new RemoteKitError('unavailable', '')}
          context={{ operation: '打开文档', scope: 'surface' }}
        />
      );
    if (document)
      return (
        <div className="file-document-preview">
          {progressError && (
            <SurfaceState
              live
              error={progressError}
              context={{ operation: '读取阅读位置', scope: 'surface' }}
            />
          )}
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
