import { Alert, Box, Button, ButtonBase, CircularProgress, Typography } from '@mui/material';
import { useState } from 'react';
import type { LibraryEntry } from '../shared/file-library';
import { FileImagePreview } from './file-image-preview';
import { useLibrary } from './file-library-state';
import { FileThumbnail } from './file-thumbnail';
import type { PhotoDestination, PhotoJob } from './photo-jobs';

export function PhotoOptions({
  entry,
  job,
  destination,
  disabled,
}: {
  entry: LibraryEntry;
  job?: PhotoJob;
  destination: PhotoDestination['destination'];
  disabled: boolean;
}) {
  const { photos } = useLibrary();
  const [chosen, setChosen] = useState<string>();
  const [preview, setPreview] = useState<string>();
  const candidates = job?.candidates ?? entry.photo?.candidateAssetIds ?? [];
  const pending = job ? job.state : entry.photo?.pending;
  const selected = chosen && candidates.includes(chosen) ? chosen : candidates[0];
  const original = job?.originalId ?? entry.assetId;
  if (pending === 'processing' || pending === 'committing' || pending === 'sampling') {
    return (
      <Typography variant="caption" role="status">
        <CircularProgress size={12} sx={{ mr: 0.75 }} />
        处理中
      </Typography>
    );
  }
  if (preview)
    return (
      <FileImagePreview
        key={preview}
        entry={{ assetId: preview, name: '照片原图' }}
        inline
        onClose={() => setPreview(undefined)}
      />
    );
  if (pending === 'choice' && selected)
    return (
      <>
        <ButtonBase
          aria-label="查看候选大图"
          disabled={disabled}
          onClick={() => setPreview(selected)}
          sx={{ display: 'block', width: '100%' }}
        >
          <FileThumbnail
            assetId={selected}
            type="image/png"
            sx={{ height: 'min(26vh, 180px)', borderRadius: 1 }}
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
              <FileThumbnail assetId={id} type="image/png" sx={{ width: '100%', height: '100%' }} />
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
  if (pending === 'scan-error')
    return (
      <>
        <Alert severity="warning">文档扫描未完成。{job?.error ?? entry.photo?.warning}</Alert>
        <Button
          disabled={disabled}
          onClick={() => photos.resolve(entry, destination, original, true, job?.id)}
        >
          使用原图
        </Button>
        <Button
          disabled={disabled}
          onClick={() => photos.resolve(entry, destination, original, false, job?.id)}
        >
          重试扫描
        </Button>
      </>
    );
  if (pending === 'error') return <Alert severity="warning">{job?.error}</Alert>;
  return (
    <>
      {entry.photo?.warning && <Alert severity="warning">{entry.photo.warning}</Alert>}
      {entry.originalAssetId && (
        <Button disabled={disabled} onClick={() => setPreview(entry.originalAssetId)}>
          查看原图
        </Button>
      )}
    </>
  );
}
