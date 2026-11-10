import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
} from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import type { LibraryEntry, LibraryFileEntry } from '../../shared/file-library';
import { fileError } from './file-library-controls';
import { useLibrary } from './file-library-state';
import { RotatedImage } from './rotated-image';
import { PhotoRotateButton } from './photo-rotate-button';
import type { PhotoDestination } from './photo-job-store';

export function canPreviewFile(entry: Pick<LibraryEntry, 'type' | 'size'>) {
  return (
    /^image\/(jpeg|png|gif|webp|avif|bmp)$/i.test(entry.type) &&
    entry.size > 0 &&
    entry.size <= 64 * 1024 * 1024
  );
}

type ImageSource = { assetId: string; name: string; type?: string; size?: number };

export function FileImagePreview({
  entry,
  onClose,
  inline = false,
  hideBack = false,
  fullSize = false,
  destination = 'library',
  showRotation = true,
  disabled = false,
}: {
  entry: ImageSource | LibraryFileEntry;
  onClose: () => void;
  inline?: boolean;
  hideBack?: boolean;
  fullSize?: boolean;
  destination?: PhotoDestination['destination'];
  showRotation?: boolean;
  disabled?: boolean;
}) {
  const { online, rpc, photos } = useLibrary();
  const entryId = 'id' in entry ? entry.id : undefined;
  const rotationTurns =
    photos.jobs.find((job) => job.replace?.id === entryId && job.replace?.assetId === entry.assetId)
      ?.rotationTurns ?? 0;
  const [dimensions, setDimensions] = useState({ width: 1, height: 1 });
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const close = useRef(onClose);
  close.current = onClose;
  const { assetId, name, type, size } = entry;
  useEffect(() => {
    if (!online) {
      close.current();
      return;
    }
    const abort = new AbortController();
    setError('');
    setUrl(undefined);
    let objectUrl: string | undefined;
    const load = async () => {
      const asset = type && size ? { assetId, type, size } : await rpc.describeAsset(assetId, abort.signal);
      if (!canPreviewFile(asset)) throw new Error('此图片无法预览');
      return rpc.readPhoto(asset, abort.signal);
    };
    void load().then(
      (blob) => {
        if (abort.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      },
      (failure) => {
        if (!abort.signal.aborted) setError(fileError(failure));
      },
    );
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId, type, size, online, rpc, attempt]);
  const content = error ? (
    <Alert severity="warning" action={<Button onClick={() => setAttempt(attempt + 1)}>重试</Button>}>
      {error}
    </Alert>
  ) : url ? (
    <Box
      sx={{
        position: 'relative',
        width: '100%',
        flex: fullSize ? 1 : undefined,
        minHeight: 0,
        aspectRatio:
          rotationTurns % 2
            ? `${dimensions.height} / ${dimensions.width}`
            : `${dimensions.width} / ${dimensions.height}`,
        maxHeight: fullSize
          ? '100%'
          : inline
            ? 'min(calc(var(--layout-vh) * 0.34), 210px)'
            : 'calc(var(--layout-vh) * 0.7)',
      }}
    >
      <RotatedImage
        src={url}
        alt={name}
        turns={rotationTurns}
        onLoad={(image) => setDimensions({ width: image.naturalWidth, height: image.naturalHeight })}
        onError={() => setError('预览不可用')}
      />
    </Box>
  ) : (
    <LinearProgress aria-label="正在加载大图" />
  );
  const rotate = showRotation && 'id' in entry && (
    <PhotoRotateButton entry={entry} destination={destination} disabled={disabled} />
  );
  if (inline)
    return (
      <Box
        sx={
          fullSize
            ? { width: '100%', height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }
            : undefined
        }
      >
        {rotate && <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>{rotate}</Box>}
        {content}
        {!hideBack && <Button onClick={onClose}>返回</Button>}
      </Box>
    );
  return (
    <Dialog open fullWidth maxWidth="md" onClose={onClose}>
      <DialogTitle sx={{ overflowWrap: 'anywhere' }}>{name}</DialogTitle>
      <DialogContent>{content}</DialogContent>
      <DialogActions>
        {rotate}
        <Button onClick={onClose}>返回</Button>
      </DialogActions>
    </Dialog>
  );
}
