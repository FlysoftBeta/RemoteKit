import React, { useEffect, useRef, useState } from 'react';
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
import type { LibraryEntry } from '../shared/file-library';
import { useLibrary } from './file-library-state';
import { fileError } from './file-library-controls';

export function canPreviewFile(entry: Pick<LibraryEntry, 'type' | 'size'>) {
  return /^(image\/jpeg|image\/png)$/i.test(entry.type) && entry.size > 0 && entry.size <= 64 * 1024 * 1024;
}

type ImageSource = { assetId: string; name: string; type?: string; size?: number };

export function FileImagePreview({
  entry,
  onClose,
  inline = false,
}: {
  entry: ImageSource;
  onClose: () => void;
  inline?: boolean;
}) {
  const { online, rpc } = useLibrary();
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState('');
  const close = useRef(onClose);
  close.current = onClose;
  const { assetId, name, type, size } = entry;
  useEffect(() => {
    if (!online) {
      close.current();
      return;
    }
    const abort = new AbortController();
    let objectUrl: string | undefined;
    const load = async () => {
      const asset =
        type && size ? { assetId, type, size, hash: '' } : await rpc.describeAsset(assetId, abort.signal);
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
  }, [assetId, type, size, online, rpc]);
  const content = error ? (
    <Alert severity="warning">{error}</Alert>
  ) : url ? (
    <Box
      component="img"
      src={url}
      alt={name}
      onError={() => setError('预览不可用')}
      sx={{
        width: '100%',
        display: 'block',
        maxHeight: inline ? 'min(34vh, 210px)' : '70vh',
        objectFit: 'contain',
      }}
    />
  ) : (
    <LinearProgress aria-label="正在加载大图" />
  );
  if (inline)
    return (
      <>
        {content}
        <Button onClick={onClose}>返回</Button>
      </>
    );
  return (
    <Dialog open fullWidth maxWidth="md" onClose={onClose}>
      <DialogTitle sx={{ overflowWrap: 'anywhere' }}>{name}</DialogTitle>
      <DialogContent>{content}</DialogContent>
      <DialogActions>
        <Button onClick={onClose}>返回</Button>
      </DialogActions>
    </Dialog>
  );
}
