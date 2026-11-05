import { ImageOutlined, InsertDriveFileOutlined } from '@mui/icons-material';
import { Box, Skeleton, Typography, type SxProps, type Theme } from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { useLibrary } from './file-library-state';

export function FileThumbnail({
  assetId,
  type,
  blob,
  extension,
  sx,
  localOnly = false,
}: {
  assetId: string;
  type: string;
  blob?: Blob;
  extension?: string;
  sx?: SxProps<Theme>;
  localOnly?: boolean;
}) {
  const { online, thumbnails } = useLibrary();
  const image = type.toLowerCase().startsWith('image/');
  const decodable = /^(image\/jpeg|image\/png)$/i.test(type);
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [imageUrl, setImageUrl] = useState<{ assetId: string; value: string }>();
  const url = imageUrl?.assetId === assetId ? imageUrl.value : undefined;
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!host.current || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let objectUrl: string | undefined;
    const display = (value: Blob | undefined) => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = value && URL.createObjectURL(value);
      setImageUrl(objectUrl ? { assetId, value: objectUrl } : undefined);
      setLoading(false);
    };
    let release: (() => void) | undefined;
    if (!visible) display(undefined);
    else if (blob) display(blob);
    else if (!localOnly && online && decodable) {
      setLoading(true);
      release = thumbnails.subscribe(assetId, display);
    } else display(thumbnails.get(assetId));
    return () => {
      release?.();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId, blob, decodable, localOnly, online, thumbnails, visible]);

  return (
    <Box
      ref={host}
      aria-hidden="true"
      sx={[
        {
          position: 'relative',
          minWidth: 0,
          display: 'grid',
          placeItems: 'center',
          overflow: 'hidden',
          bgcolor: 'action.hover',
          color: 'text.secondary',
        },
        ...(Array.isArray(sx) ? sx : [sx ?? {}]),
      ]}
    >
      {visible && url ? (
        <Box
          component="img"
          src={url}
          alt=""
          draggable={false}
          onError={() => setImageUrl(undefined)}
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'block',
            width: '100%',
            height: '100%',
            objectFit: 'contain',
          }}
        />
      ) : visible && loading ? (
        <Skeleton variant="rectangular" width="100%" height="100%" />
      ) : (
        <Box sx={{ textAlign: 'center' }}>
          {image ? (
            <ImageOutlined sx={{ fontSize: 36 }} />
          ) : (
            <InsertDriveFileOutlined sx={{ fontSize: 36 }} />
          )}
          {(image || extension) && (
            <Typography variant="caption" display="block">
              {image ? '预览不可用' : extension?.toUpperCase()}
            </Typography>
          )}
        </Box>
      )}
    </Box>
  );
}
