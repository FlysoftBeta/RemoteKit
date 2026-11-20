import { Box, Button, ButtonBase, CircularProgress, Typography } from '@mui/material';
import { useState } from 'react';
import type { LibraryEntry } from '../../shared/file-library';
import { FailureNote } from '../failures';
import { useLibrary } from './file-library-state';
import { FileThumbnail } from './file-thumbnail';
import type { PhotoDestination, PhotoJob } from './photo-job-store';

export function PhotoOptions({
  entry,
  job,
  destination,
  disabled,
  onPreview,
  requestId,
  windowId,
}: {
  entry?: LibraryEntry;
  job?: PhotoJob;
  destination: PhotoDestination['destination'];
  disabled: boolean;
  onPreview?(assetId: string): void;
  requestId?: string;
  windowId?: string;
}) {
  const { photos } = useLibrary();
  const context = {
    requestId: requestId ?? (job?.origin.kind === 'request' ? job.origin.requestId : undefined),
    ownerKey: windowId ?? job?.windowId,
  };
  const [chosen, setChosen] = useState<string>();
  if (entry?.kind === 'snippet') return null;
  const candidates = job?.candidates ?? entry?.photo?.candidateAssetIds ?? [];
  const pending = job ? job.state : entry?.photo?.pending;
  const selected = chosen && candidates.includes(chosen) ? chosen : candidates[0];
  const original = job?.originalId ?? entry?.originalAssetId ?? entry?.assetId;
  if (pending === 'processing' || pending === 'committing' || pending === 'sampling') {
    return (
      <Typography variant="caption" role="status">
        <CircularProgress size={12} sx={{ mr: 0.75 }} />
        处理中
      </Typography>
    );
  }
  if (pending === 'error')
    return (
      <>
        <FailureNote error={job?.error} context={{ ...context, operation: '处理照片', scope: 'surface' }} />
        {job?.canRetry && (
          <Button disabled={disabled} onClick={() => photos.retry(job.id)}>
            重试处理
          </Button>
        )}
      </>
    );
  if (!entry) return null;
  if (pending === 'choice' && selected)
    return (
      <>
        <ButtonBase
          aria-label="查看候选大图"
          disabled={disabled}
          onClick={() => onPreview?.(selected)}
          sx={{ display: 'block', width: '100%' }}
        >
          <FileThumbnail
            assetId={selected}
            type="image/jpeg"
            name="候选照片"
            fit="contain"
            sx={{ height: 'min(calc(var(--layout-vh) * 0.26), 180px)', borderRadius: 1 }}
          />
        </ButtonBase>
        <Box sx={{ display: 'flex', gap: 0.5, my: 0.5 }}>
          {candidates.map((id, index) => (
            <ButtonBase
              key={id}
              disabled={disabled}
              aria-label={`候选 ${index + 1}`}
              aria-pressed={id === selected}
              onClick={() => setChosen(id)}
              sx={{
                width: 56,
                height: 44,
                border: '2px solid',
                borderColor: id === selected ? 'primary.main' : 'divider',
                borderRadius: 1,
              }}
            >
              <FileThumbnail
                assetId={id}
                type="image/jpeg"
                name="候选照片"
                size="small"
                sx={{ width: '100%', height: '100%' }}
              />
            </ButtonBase>
          ))}
          <Button
            disabled={disabled}
            onClick={() => photos.resolve(entry, destination, selected, false, job?.id)}
          >
            使用这张
          </Button>
        </Box>
      </>
    );
  if (pending === 'scan-error' && original)
    return (
      <>
        <FailureNote
          error={job?.error ?? entry?.photo?.processingFailure}
          context={{ ...context, operation: '生成扫描件', scope: 'item' }}
        />
        <Button
          disabled={disabled}
          onClick={() => photos.resolve(entry, destination, original, true, job?.id)}
        >
          使用原图
        </Button>
      </>
    );
  return (
    <>
      {entry.originalAssetId && !job && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap' }}>
          <Button
            disabled={disabled || entry.photo?.mode === 'photo'}
            onClick={() =>
              photos.resolve(entry, destination, entry.originalAssetId!, false, undefined, 'photo')
            }
          >
            普通照片
          </Button>
          <Button
            disabled={disabled || entry.photo?.mode === 'scan'}
            onClick={() =>
              photos.resolve(entry, destination, entry.originalAssetId!, false, undefined, 'scan')
            }
          >
            文档扫描
          </Button>
        </Box>
      )}
      {entry?.photo?.advisory && <p>照片可能不够清晰，原图已保留</p>}
      {entry?.originalAssetId && (
        <>
          {entry.photo?.mode === 'scan' && (
            <Button
              disabled={disabled || !!job}
              onClick={() => photos.resolve(entry, destination, entry.originalAssetId!, true)}
            >
              使用原图
            </Button>
          )}
        </>
      )}
    </>
  );
}
