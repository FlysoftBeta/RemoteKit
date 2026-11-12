import {
  ArticleOutlined,
  AudioFileOutlined,
  DescriptionOutlined,
  FolderZipOutlined,
  ImageOutlined,
  InsertDriveFileOutlined,
  PictureAsPdfOutlined,
  SlideshowOutlined,
  TableChartOutlined,
  VideoFileOutlined,
} from '@mui/icons-material';
import { Box, Skeleton, Typography, type SxProps, type Theme } from '@mui/material';
import React, { useEffect, useRef, useState } from 'react';
import { RemoteKitError } from '../../shared/errors';
import { FailureNote } from '../failures';
import { fileExtension, fileKind, type FileKind } from './file-format';
import { useLibrary } from './file-library-state';
import type { Preview } from './file-thumbnails';
import { RotatedImage } from './rotated-image';

const KINDS: Record<FileKind, { icon: React.ElementType; color: string; background: string }> = {
  image: { icon: ImageOutlined, color: '#1967d2', background: '#e8f0fe' },
  pdf: { icon: PictureAsPdfOutlined, color: '#c5221f', background: '#fce8e6' },
  document: { icon: DescriptionOutlined, color: '#1a73e8', background: '#e8f0fe' },
  sheet: { icon: TableChartOutlined, color: '#188038', background: '#e6f4ea' },
  slides: { icon: SlideshowOutlined, color: '#c26401', background: '#fef3e0' },
  archive: { icon: FolderZipOutlined, color: '#795548', background: '#f3ece8' },
  audio: { icon: AudioFileOutlined, color: '#8430ce', background: '#f3e8fd' },
  video: { icon: VideoFileOutlined, color: '#b3261e', background: '#fce8e6' },
  text: { icon: ArticleOutlined, color: '#4b5563', background: '#eef1f4' },
  other: { icon: InsertDriveFileOutlined, color: '#4b5563', background: '#eef1f4' },
};

export function FileTypeIcon({ type, name }: { type: string; name: string }) {
  const Icon = KINDS[fileKind(type, name)].icon;
  return <Icon fontSize="inherit" />;
}

export function fileTypeColor(type: string, name: string): string {
  return KINDS[fileKind(type, name)].color;
}

// A file's visual: the cached thumbnail for decodable images (cropped to fill unless `fit` says
// otherwise), or a tinted icon for its kind with the extension underneath when there is room.
export function FileThumbnail({
  entryId,
  assetId,
  type,
  name,
  blob,
  sx,
  size = 'large',
  fit = 'cover',
  localOnly = false,
}: {
  entryId?: string;
  assetId: string;
  type: string;
  name: string;
  blob?: Blob;
  sx?: SxProps<Theme>;
  size?: 'small' | 'large';
  fit?: 'cover' | 'contain';
  localOnly?: boolean;
}) {
  const { online, thumbnails, photos } = useLibrary();
  const rotationTurns =
    photos.jobs.find((job) => job.replace?.id === entryId && job.replace?.assetId === assetId)
      ?.rotationTurns ?? 0;
  const decodable = /^image\/(jpeg|png|webp)$/i.test(type);
  const kind = KINDS[fileKind(type, name)];
  const Icon = kind.icon;
  const extension = fileExtension(name).slice(0, 6).toUpperCase();
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [imageUrl, setImageUrl] = useState<{ assetId: string; value: string }>();
  const url = imageUrl?.assetId === assetId ? imageUrl.value : undefined;
  const [failure, setFailure] = useState<RemoteKitError>();
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
    const display = (preview: Preview) => {
      const value = preview.blob;
      setFailure(preview.error?.code === 'not_found' ? undefined : preview.error);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = value && URL.createObjectURL(value);
      setImageUrl(objectUrl ? { assetId, value: objectUrl } : undefined);
      setLoading(false);
    };
    let release: (() => void) | undefined;
    if (!visible) display({});
    else if (blob) display({ blob });
    else if (!localOnly && online && decodable) {
      setLoading(true);
      release = thumbnails.subscribe(assetId, display);
    } else display({ blob: thumbnails.get(assetId) });
    return () => {
      release?.();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId, blob, decodable, localOnly, online, thumbnails, visible]);

  const shown = visible && url;
  return (
    <Box
      ref={host}
      sx={[
        {
          position: 'relative',
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 0.25,
          overflow: 'hidden',
          bgcolor: shown ? '#eef1f4' : kind.background,
          color: kind.color,
        },
        ...(Array.isArray(sx) ? sx : [sx ?? {}]),
      ]}
    >
      <FailureNote
        error={failure}
        context={{ operation: '读取缩略图', scope: 'item', targetId: assetId, consequence: '文件仍可打开' }}
      />
      {shown ? (
        <RotatedImage
          src={url}
          alt=""
          turns={rotationTurns}
          fit={fit}
          onError={() => {
            setImageUrl(undefined);
            setFailure(new RemoteKitError('internal', '缩略图解码失败'));
          }}
        />
      ) : visible && loading ? (
        <Skeleton variant="rectangular" sx={{ position: 'absolute', inset: 0, height: '100%' }} />
      ) : (
        <>
          <Icon sx={{ fontSize: size === 'small' ? 20 : 34 }} />
          {size === 'large' && extension && (
            <Typography variant="caption" sx={{ fontWeight: 600, letterSpacing: 0.4, lineHeight: 1 }}>
              {extension}
            </Typography>
          )}
        </>
      )}
    </Box>
  );
}
