import {
  ArrowBack,
  CameraAltOutlined,
  CameraswitchOutlined,
  CollectionsOutlined,
  PhotoCameraOutlined,
} from '@mui/icons-material';
import { Badge, Box, Dialog, IconButton, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { RemoteKitError } from '../../shared/errors';
import type { LibraryEntry, PhotoMetadata } from '../../shared/file-library';
import { uiScale } from '../app/ui-scale';
import { failureError, FailureNote } from '../failures';
import { recoverRead as recover } from '../failures/recovery';
import { diagnostics } from '../media/diagnostics';
import { capturePhotoBurst } from './camera-capture';
import { useLibrary } from './file-library-state';
import { FileThumbnail } from './file-thumbnail';

const inset = (side: string, px: number) =>
  `calc(var(--remotekit-safe-area-${side}, env(safe-area-inset-${side}, 0px)) + ${px}px)`;
const overlay = {
  position: 'absolute',
  bgcolor: 'rgba(0,0,0,.62)',
  color: 'white',
  '&:hover': { bgcolor: 'rgba(0,0,0,.78)' },
  '&.Mui-disabled': { color: '#adb5c0', bgcolor: '#343e4d' },
} as const;
const icon = { ...overlay, width: 44, height: 44 };
// Layout px of the visual viewport under the app-wide UI scale.
const viewport = () => {
  const visual = window.visualViewport;
  const scale = uiScale();
  return {
    width: (visual?.width ?? window.innerWidth) / scale,
    height: (visual?.height ?? window.innerHeight) / scale,
    left: (visual?.offsetLeft ?? 0) / scale,
    top: (visual?.offsetTop ?? 0) / scale,
  };
};

export function PhotoCapture({
  afterId,
  destination = 'basket',
  partitionId = null,
  requestId,
  windowId,
  replace,
  onClose,
}: {
  afterId?: string;
  destination?: 'basket' | 'library';
  partitionId?: string | null;
  requestId?: string;
  windowId?: string;
  replace?: LibraryEntry;
  onClose: () => void;
}) {
  const { rpc, online, snapshot, photos } = useLibrary();
  const [mode, setMode] = useState<PhotoMetadata['mode']>(replace?.photo?.mode ?? 'photo');
  const [continuous, setContinuous] = useState(true);
  const [deviceId, setDeviceId] = useState<string>();
  const [devices, setDevices] = useState<string[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [sampling, setSampling] = useState(false);
  const [error, setError] = useState<RemoteKitError | undefined>();
  const [view, setView] = useState(viewport);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const stream = useRef<MediaStream | undefined>(undefined);
  const insertion = useRef({ afterId });
  const active = useRef<{ id: string; cancel: () => void } | undefined>(undefined);
  const close = useRef(onClose);
  close.current = onClose;
  const basketCount = snapshot?.basket.length ?? 0;
  const destinationCount = destination === 'basket' ? basketCount : (snapshot?.entries.length ?? 0);
  const pending = photos.jobs.filter((job) => job.destination === destination && !job.replace);
  const latestEntry = snapshot?.entries.find((entry) =>
    destination === 'basket' ? snapshot.basket.includes(entry.id) : true,
  );
  const newest = [...pending].reverse().find((job) => job.preview);
  const basketFull = destination === 'basket' && !replace && basketCount + pending.length >= 64;
  const full = photos.jobs.length >= 2;
  const landscape = view.width > view.height;
  const shutterSize = landscape && view.height < 320 ? 64 : 72;

  useEffect(() => {
    const resize = () => {
      const next = viewport();
      if (
        active.current &&
        (Math.abs(next.width - view.width) > 1 || Math.abs(next.height - view.height) > 1)
      ) {
        active.current.cancel();
        active.current = undefined;
        setSampling(false);
        setError(new RemoteKitError('invalid_request', '取景尺寸已改变，请重新拍摄'));
      }
      setView(next);
    };
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('scroll', resize);
    return () => {
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('scroll', resize);
    };
  }, [view.width, view.height]);

  useEffect(() => {
    const hide = () => {
      if (document.hidden) close.current();
    };
    document.addEventListener('visibilitychange', hide);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      active.current?.cancel();
      active.current = undefined;
    };
  }, []);
  useEffect(() => {
    if (!online) close.current();
  }, [online]);

  useEffect(() => {
    if (!online || !video) return;
    let stopped = false;
    const abort = new AbortController();
    let acquired: MediaStream | undefined;
    const node = video;
    const media = navigator.mediaDevices;
    setReady(false);
    setError(undefined);
    if (!media?.getUserMedia) {
      setError(new RemoteKitError('internal', '当前页面无法使用拍照功能'));
      return;
    }
    void recover(
      () =>
        media
          .getUserMedia({
            audio: false,
            video: {
              ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
              width: { ideal: 3840, max: 3840 },
              height: { ideal: 2160, max: 2160 },
              frameRate: { ideal: 30, max: 30 },
            },
          })
          .catch((error: unknown) => {
            if (error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name))
              throw new RemoteKitError('forbidden', '摄像头尚未获准使用', {
                reason: 'camera_permission',
                cause: error,
              });
            if (error instanceof DOMException && ['NotReadableError', 'AbortError'].includes(error.name))
              throw new RemoteKitError('unavailable', '摄像头暂不可用', { cause: error });
            throw error;
          }),
      abort.signal,
      setError,
    )
      .then(async (next) => {
        acquired = next;
        if (stopped) {
          next.getTracks().forEach((track) => track.stop());
          return;
        }
        stream.current = next;
        node.srcObject = next;
        await node.play();
        if (stopped) return;
        setReady(true);
        setError(undefined);
        const listed = await media.enumerateDevices().catch((error) => {
          diagnostics.record('camera-devices', error);
          return [];
        });
        if (!stopped)
          setDevices(
            listed
              .filter((device) => device.kind === 'videoinput' && device.deviceId)
              .map((device) => device.deviceId),
          );
      })
      .catch((error) => {
        if (stopped) return;
        acquired?.getTracks().forEach((track) => track.stop());
        setError(failureError(error));
      });
    return () => {
      stopped = true;
      abort.abort();
      acquired?.getTracks().forEach((track) => track.stop());
      if (stream.current === acquired) stream.current = undefined;
      node.srcObject = null;
    };
  }, [online, deviceId, attempt, video]);

  function shutter() {
    const node = video;
    if (!node || !ready || active.current || full || basketFull) return;
    const shot = photos.reserve(
      {
        windowId,
        destination,
        insertion: insertion.current,
        origin: requestId
          ? { kind: 'request', requestId }
          : { kind: 'files', channel: 'camera', partitionId },
        replace,
      },
      mode,
    );
    if (!shot) return;
    const { id, signal } = shot;
    active.current = { id, cancel: () => photos.cancel(id) };
    setSampling(true);
    setError(undefined);
    const result = capturePhotoBurst(node, signal, rpc, {
      viewportWidth: view.width,
      viewportHeight: view.height,
      onPreview: (preview) => photos.update(id, { preview }),
      onSamplingEnd: (stats) => {
        if (active.current?.id !== id) return;
        active.current = undefined;
        setSampling(false);
        if (stats.stopReason === 'aborted') return;
        if (stats.stopReason === 'error' || !stats.frameCount) {
          photos.cancel(id);
          setError(new RemoteKitError('invalid_request', '本次没有取得可用照片，文件篮未增加照片'));
          return;
        }
        photos.update(id, { state: 'processing' });
        if (!continuous || replace) close.current();
      },
    });
    photos.capture(id, result);
    void result.catch((failure) => {
      if (active.current?.id === id) {
        active.current = undefined;
        photos.cancel(id);
        setSampling(false);
        setError(failureError(failure));
      }
    });
  }

  return (
    <Dialog
      fullScreen
      open
      onClose={onClose}
      slotProps={{
        paper: {
          'aria-label': '摄像头拍照',
          style: {
            position: 'fixed',
            margin: 0,
            maxHeight: 'none',
            maxWidth: 'none',
            borderRadius: 0,
            ...view,
          },
          sx: { overflow: 'hidden', bgcolor: 'black', color: 'white' },
        },
      }}
    >
      <Box
        component="video"
        ref={setVideo}
        muted
        playsInline
        sx={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          objectPosition: 'center',
        }}
      />
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          pointerEvents: 'none',
          ...(landscape
            ? {
                right: 0,
                top: 0,
                bottom: 0,
                width: inset('right', 112),
                background: 'linear-gradient(to left, #000a, transparent)',
              }
            : {
                bottom: 0,
                left: 0,
                right: 0,
                height: inset('bottom', 164),
                background: 'linear-gradient(to top, #000a, transparent)',
              }),
        }}
      />
      <IconButton
        aria-label={replace ? '取消重拍' : '返回'}
        onClick={onClose}
        sx={{ ...icon, top: inset('top', 8), left: inset('left', 8) }}
      >
        <ArrowBack />
      </IconButton>
      {devices.length > 1 && (
        <IconButton
          aria-label="切换摄像头"
          disabled={sampling}
          onClick={() => {
            const activeDevice = stream.current?.getVideoTracks()[0]?.getSettings().deviceId;
            setDeviceId(devices[(devices.indexOf(activeDevice ?? '') + 1) % devices.length]);
          }}
          sx={{
            ...icon,
            top: inset('top', 8),
            ...(landscape && view.height < 280 ? { left: inset('left', 62) } : { right: inset('right', 8) }),
          }}
        >
          <CameraswitchOutlined />
        </IconButton>
      )}
      {error && (
        <FailureNote
          error={error}
          context={{
            operation: '拍摄照片',
            scope: 'surface',
            input: error.code === 'invalid_request',
            issue: error.reason === 'camera_permission' ? 'permission' : undefined,
            action:
              error.reason === 'camera_permission'
                ? { label: '开启摄像头', run: () => setAttempt((value) => value + 1) }
                : error.code === 'invalid_request'
                  ? { label: '重新拍摄', run: () => setError(undefined) }
                  : undefined,
          }}
        />
      )}
      {!error && (full || basketFull || !ready) && (
        <Typography
          role="status"
          sx={{ ...overlay, top: inset('top', 58), left: inset('left', 8), px: 1, borderRadius: 1 }}
        >
          {basketFull ? '文件篮已满' : full ? '处理中，稍候再拍' : '正在打开摄像头…'}
        </Typography>
      )}
      {replace && !error && (
        <Typography
          sx={{ ...overlay, top: inset('top', 10), left: inset('left', 60), px: 1, borderRadius: 1 }}
        >
          重拍照片
        </Typography>
      )}
      <ToggleButtonGroup
        exclusive
        aria-label="拍摄模式"
        value={mode}
        onChange={(_, next) => {
          if (next) setMode(next);
        }}
        disabled={sampling}
        sx={{
          ...overlay,
          ...(landscape
            ? { left: inset('left', 8), bottom: inset('bottom', 8) }
            : { left: '50%', transform: 'translateX(-50%)', bottom: inset('bottom', 102) }),
          '& .MuiToggleButton-root': {
            color: 'white',
            minHeight: 44,
            whiteSpace: 'nowrap',
            px: 1.5,
            '&.Mui-selected, &.Mui-selected:hover': { color: 'white', bgcolor: 'primary.dark' },
            '&.Mui-disabled': { color: '#c5d0df', borderColor: '#728096' },
            '&.Mui-disabled.Mui-selected': { color: 'white', bgcolor: '#34537f' },
          },
        }}
      >
        <ToggleButton value="photo">普通照片</ToggleButton>
        <ToggleButton value="scan">文档扫描</ToggleButton>
      </ToggleButtonGroup>
      <IconButton
        aria-label="拍照"
        disabled={!ready || sampling || full || basketFull}
        onClick={shutter}
        sx={{
          ...overlay,
          width: shutterSize,
          height: shutterSize,
          border: '3px solid white',
          bgcolor: 'white',
          color: 'primary.dark',
          '&:hover': { bgcolor: 'grey.200' },
          ...(landscape
            ? { top: '50%', transform: 'translateY(-50%)', right: inset('right', 18) }
            : { bottom: inset('bottom', 18), left: '50%', transform: 'translateX(-50%)' }),
        }}
      >
        <CameraAltOutlined />
      </IconButton>
      <IconButton
        aria-label={`连续拍摄${continuous ? '已开启' : '已关闭'}`}
        aria-pressed={continuous}
        onClick={() => setContinuous((value) => !value)}
        disabled={sampling || !!replace}
        sx={{
          ...icon,
          width: 52,
          borderRadius: 2,
          flexDirection: 'column',
          fontSize: 10,
          bgcolor: continuous ? 'primary.dark' : icon.bgcolor,
          ...(landscape
            ? { top: `calc(50% - ${shutterSize / 2 + 60}px)`, right: inset('right', 28) }
            : { bottom: inset('bottom', 30), left: 'calc(50% + 58px)' }),
        }}
      >
        <PhotoCameraOutlined fontSize="small" />
        连续
      </IconButton>
      <IconButton
        aria-label={`返回${destination === 'basket' ? '文件篮' : '我的文件'}，${destinationCount + pending.length} 项`}
        onClick={onClose}
        sx={{
          ...icon,
          width: 48,
          height: 48,
          borderRadius: 2,
          ...(landscape
            ? { top: `calc(50% + ${shutterSize / 2 + 18}px)`, right: inset('right', 30) }
            : { bottom: inset('bottom', 29), right: 'calc(50% + 58px)' }),
        }}
      >
        <Badge badgeContent={destinationCount + pending.length} color="primary">
          {newest?.preview ? (
            <FileThumbnail
              assetId={newest.id}
              type="image/png"
              name="照片"
              size="small"
              blob={newest.preview}
              localOnly
              sx={{ width: 32, height: 32 }}
            />
          ) : latestEntry?.kind === 'file' && latestEntry.type.startsWith('image/') ? (
            <FileThumbnail
              assetId={latestEntry.assetId}
              type={latestEntry.type}
              name={latestEntry.name}
              size="small"
              sx={{ width: 32, height: 32 }}
            />
          ) : (
            <CollectionsOutlined />
          )}
        </Badge>
      </IconButton>
    </Dialog>
  );
}
