import {
  ArrowBack,
  ChevronLeft,
  ChevronRight,
  InfoOutlined,
  MoreVert,
  RotateRight,
  ShoppingBasketOutlined,
  Close,
} from '@mui/icons-material';
import { Button, IconButton } from '@mui/material';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { LibraryFileEntry } from '../../shared/file-library';
import { operationId } from '../control/product-operations';
import { failureError, FailureNote } from '../failures';
import { recoverRead } from '../failures/recovery';
import type { RemoteKitError } from '../../shared/errors';
import { diagnostics } from '../media/diagnostics';
import { useReduceMotion } from '../app/motion-preference';
import { uiScale } from '../app/ui-scale';
import { FileEntryMenu } from './file-entry-menu';
import { formatFileSize } from './file-format';
import { useLibrary } from './file-library-state';
import { FileThumbnail } from './file-thumbnail';
import { nextPhotoIndex, sourceAppName, sourceChannelName } from './files-app-state';
import { PhotoCapture } from './photo-library-capture';
import { PhotoOptions } from './photo-options';
import { PhotoPreviewCache, type PhotoLayer } from './photo-preview-cache';
import './photo-viewer.css';

type Point = { x: number; y: number };
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const distance = (points: Point[]) => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
const middle = (points: Point[]) => ({
  x: (points[0].x + points[1].x) / 2,
  y: (points[0].y + points[1].y) / 2,
});

export function PhotoViewer({
  entries,
  entryId,
  windowId,
  destination = 'library',
  initialDetails = false,
  initialAssetId,
  decisionJob,
  requestId,
  onEntry,
  onClose,
}: {
  entries: readonly LibraryFileEntry[];
  entryId: string;
  windowId: string;
  destination?: 'library' | 'basket';
  initialDetails?: boolean;
  initialAssetId?: string;
  decisionJob?: import('./photo-job-store').PhotoJob;
  requestId?: string;
  onEntry(id: string): void;
  onClose(): void;
}) {
  const { rpc, thumbnails, snapshot, photos, online, mutate, apps } = useLibrary();
  const cache = useMemo(() => new PhotoPreviewCache(rpc), [rpc]);
  useEffect(() => () => cache.dispose(), [cache]);
  const previousIndex = useRef(0);
  const index = nextPhotoIndex(entries, entryId, previousIndex.current);
  const entry = entries[index];
  useEffect(() => {
    if (!snapshot) return;
    if (!entry) onClose();
    else {
      previousIndex.current = index;
      if (entry.id !== entryId) onEntry(entry.id);
    }
  }, [entry?.id, entryId, index, snapshot]);
  const host = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const film = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [camera, setCamera] = useState(false);
  const [details, setDetails] = useState(initialDetails);
  const [original, setOriginal] = useState(false);
  const [candidate, setCandidate] = useState(initialAssetId);
  const [controls, setControls] = useState(true);
  const [menu, setMenu] = useState<HTMLElement>();
  const [error, setError] = useState<RemoteKitError>();
  const [image, setImage] = useState<{
    source: string;
    url: string;
    width: number;
    height: number;
    layer: PhotoLayer;
    sourceWidth?: number;
    sourceHeight?: number;
  }>();
  const [thumb, setThumb] = useState<{ source: string; url: string }>();
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const currentTransform = useRef(transform);
  currentTransform.current = transform;
  const [rotation, setRotation] = useState(0);
  const [swipe, setSwipe] = useState(0);
  const [animating, setAnimating] = useState(false);
  const reduced = useReduceMotion();
  const job = decisionJob ?? photos.jobs.find((job) => job.replace?.id === entry?.id);
  const decision = !!decisionJob || !!entry?.photo?.pending;
  const source =
    candidate ?? (original ? entry?.originalAssetId : undefined) ?? job?.originalId ?? entry?.assetId;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const animationTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reveal = () => {
    setControls(true);
    clearTimeout(timer.current);
    if (window.matchMedia('(pointer: fine)').matches)
      timer.current = setTimeout(() => {
        if (!menu && !host.current?.querySelector(':focus-visible')) setControls(false);
      }, 2500);
  };
  useEffect(() => {
    reveal();
    return () => {
      clearTimeout(timer.current);
      clearTimeout(animationTimer.current);
    };
  }, []);
  useLayoutEffect(() => {
    const root = host.current;
    const node = viewport.current;
    if (!root || !node) return;
    const observer = new ResizeObserver(() => {
      setWide(root.clientWidth >= 720);
      setSize({ width: node.clientWidth, height: node.clientHeight });
    });
    observer.observe(root);
    observer.observe(node);
    return () => observer.disconnect();
  }, [!!entry]);
  useEffect(() => {
    setTransform({ scale: 1, x: 0, y: 0 });
    setRotation(0);
    setOriginal(false);
    setCandidate(initialAssetId);
    setError(undefined);
    film.current
      ?.querySelector(`[data-photo-index="${index}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: reduced ? 'auto' : 'smooth' });
    reveal();
  }, [entry?.id]);
  useEffect(() => {
    if (!source) return;
    let url: string | undefined;
    const display = (blob?: Blob) => {
      if (url) URL.revokeObjectURL(url);
      url = blob && URL.createObjectURL(blob);
      setThumb(url ? { source, url } : undefined);
    };
    if (job?.preview && !candidate && !original) {
      display(job.preview);
      return () => {
        if (url) URL.revokeObjectURL(url);
      };
    }
    const release = thumbnails.subscribe(source, (value) => display(value.blob));
    return () => {
      release();
      if (url) URL.revokeObjectURL(url);
    };
  }, [source, thumbnails, job?.preview, candidate, original]);
  const pixels = Math.max(size.width, size.height) * window.devicePixelRatio * uiScale() * transform.scale;
  const layer: PhotoLayer = pixels <= 1280 ? 1280 : pixels <= 2560 ? 2560 : 'original';
  // Original bytes are requested only after zooming beyond the 2560 preview.
  const requestedLayer: PhotoLayer = !/^image\/(jpeg|png|webp)$/i.test(entry?.type ?? '')
    ? 'original'
    : transform.scale === 1 && layer === 'original'
      ? 2560
      : layer;
  useEffect(() => {
    if (!source || !online || size.width <= 1 || (decisionJob && !decisionJob.originalId && !candidate))
      return;
    let active = true;
    const controller = new AbortController();
    let url: string | undefined;
    void recoverRead(
      () => cache.get(source, requestedLayer),
      controller.signal,
      (failure) => {
        if (active) setError(failure);
      },
    )
      .then((value) => {
        if (!active) return;
        url = URL.createObjectURL(value.blob);
        setImage({
          source,
          url,
          width: value.asset.width ?? 1,
          height: value.asset.height ?? 1,
          layer: requestedLayer,
          sourceWidth: value.source.width,
          sourceHeight: value.source.height,
        });
        setError(undefined);
      })
      .catch((failure) => {
        if (active) setError(failureError(failure));
      });
    return () => {
      active = false;
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [cache, source, requestedLayer, online, size.width > 1]);
  useEffect(() => {
    if (!online) return;
    const previewLayer =
      Math.max(size.width, size.height) * window.devicePixelRatio * uiScale() > 1280 ? 2560 : 1280;
    for (const neighbor of [entries[index - 1], entries[index + 1]])
      if (neighbor)
        void cache
          .get(neighbor.assetId, previewLayer)
          .catch((failure) => diagnostics.record('photo-prefetch', failure));
  }, [cache, index, entries[index - 1]?.assetId, entries[index + 1]?.assetId, online, size]);
  const shown = image?.source === source ? image : undefined;
  const dimensions = shown ?? { width: 4, height: 3 };
  const effectiveRotation = entry?.photo
    ? job?.replace?.assetId === entry.assetId
      ? (job.rotationTurns ?? 0)
      : 0
    : rotation;
  const turned = effectiveRotation % 2 !== 0;
  const imageWidth = turned ? dimensions.height : dimensions.width;
  const imageHeight = turned ? dimensions.width : dimensions.height;
  const fit = Math.min(size.width / imageWidth, size.height / imageHeight);
  const bounds = (value: typeof transform) => ({
    scale: clamp(value.scale, 1, 8),
    x: clamp(
      value.x,
      -Math.max(0, imageWidth * fit * value.scale - size.width) / 2,
      Math.max(0, imageWidth * fit * value.scale - size.width) / 2,
    ),
    y: clamp(
      value.y,
      -Math.max(0, imageHeight * fit * value.scale - size.height) / 2,
      Math.max(0, imageHeight * fit * value.scale - size.height) / 2,
    ),
  });
  useEffect(() => setTransform((value) => bounds(value)), [size, imageWidth, imageHeight]);
  const point = (client: Point) => {
    const rect = viewport.current!.getBoundingClientRect();
    return {
      x: (client.x - rect.left) / uiScale() - size.width / 2,
      y: (client.y - rect.top) / uiScale() - size.height / 2,
    };
  };
  const zoomAt = (scale: number, anchor: Point) => {
    const old = currentTransform.current;
    const next = clamp(scale, 1, 8);
    setTransform(
      bounds({
        scale: next,
        x: anchor.x - ((anchor.x - old.x) * next) / old.scale,
        y: anchor.y - ((anchor.y - old.y) * next) / old.scale,
      }),
    );
  };
  const zoom = useRef(zoomAt);
  zoom.current = zoomAt;
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      reveal();
      const rect = node.getBoundingClientRect();
      zoom.current(currentTransform.current.scale * Math.exp(-event.deltaY * 0.005), {
        x: (event.clientX - rect.left) / uiScale() - node.clientWidth / 2,
        y: (event.clientY - rect.top) / uiScale() - node.clientHeight / 2,
      });
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [!!entry]);
  const go = (target: number, animate = true) => {
    if (!entry || animating) return;
    const next = clamp(target, 0, entries.length - 1);
    if (reduced || !animate || next === index) {
      setSwipe(0);
      if (next !== index) onEntry(entries[next].id);
      return;
    }
    setAnimating(true);
    setSwipe(next > index ? -size.width : size.width);
    animationTimer.current = setTimeout(() => {
      setAnimating(false);
      setSwipe(0);
      onEntry(entries[next].id);
    }, 250);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        (event.target as HTMLElement)?.closest(
          'input,textarea,[role="menu"],[role="dialog"]:not([data-photo-overlay])',
        )
      )
        return;
      const target = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: entries.length - 1 }[
        event.key
      ];
      if (target !== undefined) {
        event.preventDefault();
        go(target);
        reveal();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    host.current?.addEventListener('keydown', key);
    return () => host.current?.removeEventListener('keydown', key);
  });
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (host.current?.closest('.window-frame')?.classList.contains('focused-window'))
        host.current.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [!!entry]);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{
    start: Point;
    at: number;
    last: Point;
    moved: boolean;
    scale: number;
    pan: Point;
    distance?: number;
    center?: Point;
    multi?: boolean;
  }>(undefined);
  const lastTap = useRef(0);
  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (animating || pointers.current.size >= 2) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, p);
    const points = [...pointers.current.values()];
    gesture.current = {
      start: p,
      last: p,
      moved: false,
      at: performance.now(),
      scale: transform.scale,
      pan: { x: transform.x, y: transform.y },
      ...(points.length === 2
        ? { distance: distance(points), center: point(middle(points)), multi: true }
        : {}),
    };
    clearTimeout(timer.current);
    if (event.pointerType === 'mouse') reveal();
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse') reveal();
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    const p = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, p);
    const g = gesture.current;
    g.last = p;
    if (!g.multi && Math.hypot(p.x - g.start.x, p.y - g.start.y) > 5) g.moved = true;
    const points = [...pointers.current.values()];
    if (points.length === 2 && g.distance && g.center) {
      const scale = clamp((g.scale * distance(points)) / g.distance, 1, 8);
      const center = point(middle(points));
      if (
        Math.abs(distance(points) - g.distance) > 5 ||
        Math.hypot(center.x - g.center.x, center.y - g.center.y) > 5
      )
        g.moved = true;
      setTransform(
        bounds({
          scale,
          x: center.x - ((g.center.x - g.pan.x) * scale) / g.scale,
          y: center.y - ((g.center.y - g.pan.y) * scale) / g.scale,
        }),
      );
    } else if (!g.multi && transform.scale > 1) {
      setTransform(
        bounds({
          scale: transform.scale,
          x: g.pan.x + (p.x - g.start.x) / uiScale(),
          y: g.pan.y + (p.y - g.start.y) / uiScale(),
        }),
      );
    } else if (!g.multi) {
      const offset = (p.x - g.start.x) / uiScale();
      setSwipe(
        (index === 0 && offset > 0) || (index === entries.length - 1 && offset < 0) ? offset / 3 : offset,
      );
    }
  };
  const up = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const g = gesture.current;
    pointers.current.delete(event.pointerId);
    if (!g) return;
    if (event.type === 'pointercancel') {
      pointers.current.clear();
      gesture.current = undefined;
      setSwipe(0);
      return;
    }
    if (g.multi) {
      if (!g.moved && performance.now() - g.at < 300 && g.center)
        zoomAt(transform.scale === 1 ? 2 : 1, g.center);
      g.moved = true;
      if (!pointers.current.size) gesture.current = undefined;
      return;
    }
    gesture.current = undefined;
    if (g.moved && transform.scale === 1) {
      const delta = (g.last.x - g.start.x) / uiScale();
      const velocity = Math.abs(delta) / Math.max(1, performance.now() - g.at);
      if (Math.abs(delta) > size.width * 0.2 || (Math.abs(delta) > 20 && velocity > 0.35))
        go(index + (delta < 0 ? 1 : -1));
      else {
        setAnimating(true);
        setSwipe(0);
        animationTimer.current = setTimeout(() => setAnimating(false), reduced ? 0 : 250);
      }
    } else if (!g.moved && event.pointerType !== 'mouse') {
      const now = performance.now();
      if (now - lastTap.current < 280) {
        zoomAt(transform.scale === 1 ? 2 : 1, point(g.last));
        lastTap.current = 0;
      } else {
        lastTap.current = now;
        setControls((value) => !value);
      }
    }
  };
  async function basket() {
    if (!snapshot || !entry) return;
    try {
      const ids = snapshot.basket.includes(entry.id)
        ? snapshot.basket.filter((id) => id !== entry.id)
        : [...snapshot.basket, entry.id];
      await mutate(
        'library.basket',
        { operationId: operationId(), expectedRevision: snapshot.revision, ids },
        windowId,
      );
    } catch (failure) {
      setError(failureError(failure));
    }
  }
  const drawerStart = useRef<number>(undefined);
  if (!entry) return <div className="photo-viewer" ref={host} />;
  return (
    <div
      ref={host}
      className={`photo-viewer ${wide ? 'photo-wide' : 'photo-narrow'}${size.width < 440 ? ' photo-compact' : ''}${size.width < 300 ? ' photo-tiny' : ''}`}
      tabIndex={-1}
      aria-label="照片查看器"
      onPointerDownCapture={(event) => {
        if (!(event.target as HTMLElement).closest('button,input,textarea'))
          host.current?.focus({ preventScroll: true });
      }}
      onPointerMove={(event) => {
        if (event.pointerType === 'mouse') reveal();
      }}
    >
      <div className="photo-viewport" ref={viewport}>
        <div
          className="photo-gesture"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onDoubleClick={(event) =>
            zoomAt(transform.scale === 1 ? 2 : 1, point({ x: event.clientX, y: event.clientY }))
          }
        >
          <div
            className="photo-rail"
            style={{
              transform: `translateX(${swipe}px)`,
              transition: animating && !reduced ? 'transform 250ms ease-out' : 'none',
            }}
          >
            {[entries[index - 1], entries[index + 1]].map(
              (neighbor, i) =>
                neighbor && (
                  <div key={i} className="photo-neighbor" style={{ left: i === 0 ? '-100%' : '100%' }}>
                    <FileThumbnail
                      assetId={neighbor.assetId}
                      type={neighbor.type}
                      name={neighbor.name}
                      fit="contain"
                      sx={{ width: '100%', height: '100%', bgcolor: '#000' }}
                    />
                  </div>
                ),
            )}
            <div
              className="photo-transform"
              style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
            >
              {(shown || thumb?.source === source) && (
                <img
                  draggable={false}
                  onLoad={(event) => {
                    const node = event.currentTarget;
                    if (shown && (shown.width <= 1 || shown.height <= 1))
                      setImage((value) =>
                        value?.url === node.src
                          ? { ...value, width: node.naturalWidth, height: node.naturalHeight }
                          : value,
                      );
                  }}
                  alt={entry.name}
                  src={shown?.url ?? thumb?.url}
                  className={!shown ? 'photo-placeholder' : undefined}
                  style={{
                    width: dimensions.width * fit,
                    height: dimensions.height * fit,
                    transform: `rotate(${effectiveRotation * 90}deg)`,
                  }}
                />
              )}
            </div>
          </div>
        </div>
        <div className={`photo-top photo-overlay ${controls || menu ? '' : 'photo-hidden'}`} onFocus={reveal}>
          <IconButton aria-label="返回" onClick={onClose}>
            <ArrowBack />
          </IconButton>
          <div className="photo-title">
            <span>{entry.name}</span>
            {!decision && (
              <small>
                {index + 1} / {entries.length}
              </small>
            )}
          </div>
          <IconButton
            aria-label="向右旋转"
            disabled={
              !online ||
              !!entry.photo?.pending ||
              (!!job && (job.rotationTurns === undefined || job.state === 'committing'))
            }
            onClick={() =>
              entry.photo ? photos.rotate(entry, destination) : setRotation((value) => (value + 1) % 4)
            }
          >
            <RotateRight />
          </IconButton>
          <IconButton
            aria-label={snapshot?.basket.includes(entry.id) ? '从文件篮移除' : '加入文件篮'}
            onClick={() => void basket()}
            disabled={!online}
          >
            <ShoppingBasketOutlined />
          </IconButton>
          <IconButton
            aria-label="照片详情"
            aria-pressed={details}
            onClick={() => setDetails((value) => !value)}
          >
            <InfoOutlined />
          </IconButton>
          <IconButton aria-label="更多操作" onClick={(event) => setMenu(event.currentTarget)}>
            <MoreVert />
          </IconButton>
        </div>
        <button
          className="photo-edge photo-previous"
          aria-label="上一张"
          disabled={index <= 0}
          onClick={() => go(index - 1)}
        >
          <ChevronLeft />
        </button>
        <button
          className="photo-edge photo-next"
          aria-label="下一张"
          disabled={index >= entries.length - 1}
          onClick={() => go(index + 1)}
        >
          <ChevronRight />
        </button>
        {error && (
          <div className="photo-error">
            <FailureNote
              error={error}
              context={{ operation: '打开照片', scope: 'surface', requestId, ownerKey: windowId }}
            />
          </div>
        )}
        {!decision && (
          <div
            ref={film}
            onFocus={reveal}
            className={`photo-film photo-overlay ${controls ? '' : 'photo-hidden'}`}
            aria-label="照片胶片条"
          >
            {entries.map((item, at) => (
              <button
                key={item.id}
                data-photo-index={at}
                aria-label={`查看 ${item.name}`}
                aria-current={at === index ? 'true' : undefined}
                onClick={() => go(at, false)}
              >
                <FileThumbnail
                  assetId={item.assetId}
                  type={item.type}
                  name=""
                  size="small"
                  sx={{ width: 64, height: 48 }}
                />
              </button>
            ))}
          </div>
        )}
      </div>
      {details && (
        <aside className="photo-details" aria-label="照片详情面板">
          {!wide && (
            <div
              className="photo-drawer-handle"
              onPointerDown={(event) => {
                drawerStart.current = event.clientY;
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerUp={(event) => {
                if (drawerStart.current !== undefined && event.clientY - drawerStart.current > 45 * uiScale())
                  setDetails(false);
                drawerStart.current = undefined;
              }}
            />
          )}
          <div className="photo-details-heading">
            <strong>照片详情</strong>
            <IconButton aria-label="收起详情" onClick={() => setDetails(false)}>
              <Close />
            </IconButton>
          </div>
          {(!decisionJob || decisionJob.replace) && (
            <dl>
              <dt>名称</dt>
              <dd>{entry.name}</dd>
              <dt>类型</dt>
              <dd>{entry.type}</dd>
              <dt>尺寸</dt>
              <dd>
                {shown
                  ? `${shown.sourceWidth ?? shown.width} × ${shown.sourceHeight ?? shown.height}`
                  : '正在读取…'}
              </dd>
              <dt>大小</dt>
              <dd>{formatFileSize(entry.size)}</dd>
              <dt>加入于</dt>
              <dd>{new Date(entry.createdAt).toLocaleString()}</dd>
              <dt>来源 › 渠道</dt>
              <dd>
                {entry.source
                  ? [sourceAppName(entry.source.app, apps), sourceChannelName(entry.source)]
                      .filter(Boolean)
                      .join(' › ')
                  : '已整理'}
              </dd>
              <dt>分区</dt>
              <dd>
                {snapshot?.partitions.find((partition) => partition.id === entry.partitionId)?.name ??
                  '未分区'}{' '}
                <Button size="small" onClick={(event) => setMenu(event.currentTarget)}>
                  移动
                </Button>
              </dd>
              {entry.photo && (
                <>
                  <dt>拍照模式</dt>
                  <dd>{entry.photo.mode === 'scan' ? '文档扫描' : '普通照片'}</dd>
                  <dt>处理结果</dt>
                  <dd>
                    {entry.photo.orientation
                      ? { confident: '已转正', uncertain: '方向不确定', none: '未转正' }[
                          entry.photo.orientation.state
                        ]
                      : '未记录方向'}
                    <br />
                    {entry.photo.geometry
                      ? { perspective: '透视矫正', deskew: '纠斜', unchanged: '未矫正' }[
                          entry.photo.geometry.kind
                        ]
                      : '未记录矫正'}{' '}
                    ·{' '}
                    {entry.photo.geometry
                      ? entry.photo.geometry.cropped
                        ? '已裁边'
                        : '未裁边'
                      : '裁边未记录'}
                  </dd>
                </>
              )}
            </dl>
          )}
          {entry.originalAssetId && (
            <Button
              onClick={() => {
                setCandidate(undefined);
                setOriginal((value) => !value);
              }}
            >
              {original ? '查看成品' : '查看原图'}
            </Button>
          )}
          {(entry.photo || decisionJob) && (
            <PhotoOptions
              key={entry.id}
              requestId={requestId}
              windowId={windowId}
              entry={entry}
              job={job}
              destination={destination}
              disabled={!online}
              onPreview={(id) => {
                setCandidate(id);
                setOriginal(false);
              }}
            />
          )}
          {job && (
            <Button
              disabled={job.state === 'committing'}
              onClick={() => {
                photos.cancel(job.id);
                if (decisionJob) onClose();
              }}
            >
              取消照片任务
            </Button>
          )}
          {!!entry.photo && !job && (
            <Button disabled={!online} onClick={() => setCamera(true)}>
              重拍
            </Button>
          )}
        </aside>
      )}
      {camera && (
        <PhotoCapture
          windowId={windowId}
          requestId={requestId}
          destination={destination}
          replace={entry}
          partitionId={entry.partitionId}
          onClose={() => setCamera(false)}
        />
      )}
      <FileEntryMenu entry={entry} anchor={menu} windowId={windowId} onClose={() => setMenu(undefined)} />
    </div>
  );
}

export function PhotoDecisionViewer({
  entry,
  initialAssetId,
  job,
  windowId,
  destination = 'library',
  requestId,
  onClose,
}: {
  entry?: LibraryFileEntry;
  initialAssetId?: string;
  job?: import('./photo-job-store').PhotoJob;
  windowId: string;
  destination?: 'library' | 'basket';
  requestId?: string;
  onClose(): void;
}) {
  const temporary = useMemo<LibraryFileEntry | undefined>(
    () =>
      job
        ? {
            kind: 'file',
            id: job.id,
            assetId: job.originalId ?? job.id,
            originalAssetId: job.originalId,
            available: true,
            name: '照片',
            type: 'image/jpeg',
            size: job.preview?.size ?? 0,
            createdAt: Date.now(),
            source: job.origin.kind === 'files' ? { app: 'files', channel: 'camera' } : null,
            partitionId: job.origin.kind === 'files' ? job.origin.partitionId : null,
            collected: false,
          }
        : undefined,
    [job?.id, job?.originalId],
  );
  const shown = entry ?? temporary;
  if (!shown) return null;
  return (
    <PhotoViewer
      entries={[shown]}
      entryId={shown.id}
      windowId={windowId}
      requestId={requestId}
      destination={destination}
      initialDetails
      initialAssetId={initialAssetId}
      decisionJob={job}
      onEntry={() => {}}
      onClose={onClose}
    />
  );
}
