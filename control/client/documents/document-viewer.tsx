import { useAutoFocus } from '../editing/local-autofocus';
import { FailureNote, SurfaceState, failureError } from '../failures';
import { recover } from '../failures/recovery';
// Page layout and controls adapted from FlysoftBeta/talos-ng packages/client/src/features/reader/view/viewer.tsx.
import { ZoomInOutlined, ZoomOutOutlined } from '@mui/icons-material';
import { Button, IconButton, LinearProgress, Skeleton, Tooltip } from '@mui/material';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { RemoteKitError } from '../../shared/errors';
import { FileTypeIcon, fileTypeColor } from '../files/file-thumbnail';
import { VirtualScroller, type VirtualViewport } from '../ui/virtual-list';
import { SizeIndex } from '../ui/virtual-scroll';
import type { DocumentInfo, DocumentPage, DocumentProgress, DocumentSource } from './document-source';
import './document-viewer.css';
import { mountPage } from './page-content';
import { ResourceCache, type ResourceLease } from './resource-cache';
import { PAGE_GAP, normalizeProgress, progressAt, progressTop } from './virtual-scroll';

export interface DocumentViewerProps {
  source: DocumentSource;
  title: string;
  type?: string;
  initialProgress?: DocumentProgress;
  onProgress?: (progress: DocumentProgress) => void;
  hideTitle?: boolean;
}

function Page({
  page,
  shared,
  cache,
  scale,
}: {
  page: DocumentPage;
  shared: string[];
  cache: ResourceCache;
  scale: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<RemoteKitError | undefined>();
  useEffect(() => {
    const controller = new AbortController();
    const leases: ResourceLease[] = [];
    let dispose: (() => void) | undefined;
    setStatus('loading');
    const load = async () => {
      const ids = Array.from(new Set([page.document, ...shared, ...page.dependencies]));
      const resources = await Promise.all(
        ids.map(async (id) => {
          const lease = await cache.acquire(id, controller.signal);
          if (controller.signal.aborted) {
            lease.release();
            throw new RemoteKitError('canceled', '');
          }
          leases.push(lease);
          return [id, lease] as const;
        }),
      );
      const byId = new Map(resources);
      const html = await byId.get(page.document)!.resource.data.text();
      const styles = resources.filter(([, lease]) => lease.resource.mime === 'text/css');
      if (!styles.length || byId.get(page.document)!.resource.mime !== 'text/html') {
        throw new RemoteKitError('internal', '页面格式错误');
      }
      const css = (await Promise.all(styles.map(([, lease]) => lease.resource.data.text()))).join('\n');
      if (controller.signal.aborted) return;
      const refs = new Map<string, string>();
      for (const [id, lease] of resources) if (lease.url) refs.set(id, lease.url);
      dispose = mountPage(host.current!, html, css, refs);
      setStatus('ready');
    };
    void recover(
      async () => {
        try {
          await load();
        } catch (error) {
          dispose?.();
          leases.splice(0).forEach((lease) => lease.release());
          throw error;
        }
      },
      controller.signal,
      (error) => {
        setError(error);
        setStatus('error');
      },
    ).catch((error) => {
      if (controller.signal.aborted) return;
      controller.abort();
      dispose?.();
      leases.forEach((lease) => lease.release());
      setError(failureError(error));
      setStatus('error');
    });
    return () => {
      controller.abort();
      dispose?.();
      leases.forEach((lease) => lease.release());
    };
  }, [page, shared, cache]);
  return (
    <div className="document-viewer-unit">
      <div
        className="document-viewer-page"
        style={{ width: page.width * scale, height: Math.ceil(page.height * scale) }}
      >
        <div
          ref={host}
          className="document-viewer-page-body"
          role="document"
          aria-label={`文档第 ${page.ordinal + 1} 页`}
          aria-busy={status === 'loading'}
          style={{ width: page.width, height: page.height, transform: `scale(${scale})` }}
        />
        {status !== 'ready' && (
          <div className="document-viewer-page-state" role={status === 'error' ? 'alert' : 'status'}>
            {status === 'error' ? (
              <FailureNote error={error} context={{ operation: '加载此页', scope: 'item' }} />
            ) : (
              <>
                <Skeleton width="50%" height={80} />
                <span>正在加载页面…</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function OpenDocument({
  info,
  cache,
  initialProgress,
  onProgress,
}: {
  info: DocumentInfo;
  cache: ResourceCache;
  initialProgress?: DocumentProgress;
  onProgress?: (progress: DocumentProgress) => void;
}) {
  const autoFocusRef = useAutoFocus<HTMLInputElement>();
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const activity = () => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    if (window.matchMedia('(pointer: fine)').matches)
      idleTimer.current = setTimeout(() => setIdle(true), 2500);
  };
  useEffect(() => {
    const pointer = window.matchMedia('(pointer: fine)');
    pointer.addEventListener('change', activity);
    activity();
    return () => {
      clearTimeout(idleTimer.current);
      pointer.removeEventListener('change', activity);
    };
  }, []);
  const viewport = useRef<VirtualViewport>(null);
  const [width, setWidth] = useState(0);
  const [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [current, setCurrent] = useState(0);
  const [jump, setJump] = useState<string>();
  const progress = useRef(normalizeProgress(initialProgress ?? { page: 0, offset: 0 }, info.pages.length));
  const callback = useRef(onProgress);
  callback.current = onProgress;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const positioned = useRef(false);
  const scales = useMemo(
    () => info.pages.map((page) => (Math.max(1, width - 32) / page.width) * zoom),
    [info, width, zoom],
  );
  const sizes = useMemo(
    () => new SizeIndex(info.pages.map((page, index) => Math.ceil(page.height * scales[index]) + PAGE_GAP)),
    [info, scales],
  );
  const layout = useRef(sizes);
  const zoomValue = useRef(zoom);
  zoomValue.current = zoom;
  const zoomAnchor = useRef<{ x: number; y: number; left: number; ratio: number }>(undefined);
  const changeZoom = (value: number, x?: number, y?: number) => {
    const next = Math.max(0.25, Math.min(4, value));
    const node = viewport.current?.element();
    if (!node || Math.abs(next - zoomValue.current) < 0.0001) return;
    progress.current = progressAt(layout.current, node.scrollTop + (y ?? 0));
    zoomAnchor.current = { x: x ?? 0, y: y ?? 0, left: node.scrollLeft, ratio: next / zoomValue.current };
    zoomValue.current = next;
    setZoom(next);
  };
  const zoomHandler = useRef(changeZoom);
  zoomHandler.current = changeZoom;
  useLayoutEffect(() => {
    if (!width) return;
    layout.current = sizes;
    const anchor = zoomAnchor.current;
    zoomAnchor.current = undefined;
    const node = viewport.current?.element();
    const left = anchor ? (anchor.left + anchor.x) * anchor.ratio - anchor.x : node?.scrollLeft;
    positioned.current = true;
    viewport.current?.scrollTo(progressTop(sizes, progress.current) - (anchor?.y ?? 0), left);
    setReady(true);
  }, [sizes, width]);
  useEffect(() => {
    const node = viewport.current?.element();
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1);
      zoomHandler.current(
        zoomValue.current * Math.exp(-delta * 0.002),
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
    };
    let pinch: { distance: number; zoom: number } | undefined;
    const distance = (touches: TouchList) =>
      Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      event.preventDefault();
      pinch = { distance: distance(event.touches), zoom: zoomValue.current };
    };
    const move = (event: TouchEvent) => {
      if (!pinch || event.touches.length !== 2) return;
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      zoomHandler.current(
        (pinch.zoom * distance(event.touches)) / Math.max(1, pinch.distance),
        (event.touches[0].clientX + event.touches[1].clientX) / 2 - rect.left,
        (event.touches[0].clientY + event.touches[1].clientY) / 2 - rect.top,
      );
    };
    const end = (event: TouchEvent) => {
      if (event.touches.length < 2) pinch = undefined;
    };
    node.addEventListener('wheel', wheel, { passive: false });
    node.addEventListener('touchstart', start, { passive: false });
    node.addEventListener('touchmove', move, { passive: false });
    node.addEventListener('touchend', end);
    node.addEventListener('touchcancel', end);
    return () => {
      node.removeEventListener('wheel', wheel);
      node.removeEventListener('touchstart', start);
      node.removeEventListener('touchmove', move);
      node.removeEventListener('touchend', end);
      node.removeEventListener('touchcancel', end);
    };
  }, []);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (positioned.current) callback.current?.(progress.current);
    },
    [],
  );
  const record = (top: number) => {
    activity();
    if (!positioned.current) return;
    const value = progressAt(layout.current, top);
    progress.current = value;
    setCurrent(value.page);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => callback.current?.(progress.current), 800);
  };
  const go = () => {
    if (jump === undefined || !/^\d+$/.test(jump)) {
      setJump(undefined);
      return;
    }
    const page = normalizeProgress({ page: Number(jump) - 1, offset: 0 }, info.pages.length);
    viewport.current?.scrollTo(progressTop(sizes, page));
    setJump(undefined);
  };
  return (
    <div className="document-viewer-reading" onPointerMove={activity} onPointerDown={activity}>
      <VirtualScroller
        className="document-viewer-scroll"
        label="文档阅读区"
        viewportRef={viewport}
        items={info.pages}
        sizes={sizes}
        enabled={ready}
        contentWidth={info.pages.reduce(
          (maximum, page, index) => Math.max(maximum, page.width * scales[index] + 32),
          0,
        )}
        itemKey={(page) => page.id}
        onWidth={setWidth}
        onScroll={record}
        renderItem={(page, index) => (
          <Page page={page} shared={info.shared} cache={cache} scale={scales[index]} />
        )}
      />
      <div
        className={`document-viewer-controls${idle ? ' document-viewer-controls-idle' : ''}`}
        role="toolbar"
        aria-label="页面控制"
      >
        {jump === undefined ? (
          <Button aria-label="跳转页码" onClick={() => setJump(String(current + 1))}>
            {current + 1} / {info.pages.length}
          </Button>
        ) : (
          <form
            className="document-viewer-jump"
            onSubmit={(event) => {
              event.preventDefault();
              go();
            }}
          >
            <input
              ref={autoFocusRef}
              aria-label="页码"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={jump}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setJump(event.target.value)}
              onBlur={go}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setJump(undefined);
              }}
            />
            <span>/ {info.pages.length}</span>
          </form>
        )}
        <span className="document-viewer-divider" />
        <Tooltip title="缩小">
          <span>
            <IconButton aria-label="缩小" disabled={zoom <= 0.25} onClick={() => changeZoom(zoom / 1.25)}>
              <ZoomOutOutlined fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="适合宽度">
          <Button className="document-viewer-zoom" aria-label="适合宽度" onClick={() => changeZoom(1)}>
            {Math.round(zoom * 100)}%
          </Button>
        </Tooltip>
        <Tooltip title="放大">
          <span>
            <IconButton aria-label="放大" disabled={zoom >= 4} onClick={() => changeZoom(zoom * 1.25)}>
              <ZoomInOutlined fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </div>
    </div>
  );
}

export function DocumentViewer({
  source,
  title,
  type = '',
  initialProgress,
  onProgress,
  hideTitle = false,
}: DocumentViewerProps) {
  const [state, setState] = useState<{
    source: DocumentSource;
    info?: DocumentInfo;
    cache?: ResourceCache;
    error?: RemoteKitError;
  }>();
  const [status, setStatus] = useState<'converting' | 'ready'>();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (status !== 'converting') return;
    const timer = setTimeout(() => setSlow(true), 20_000);
    return () => clearTimeout(timer);
  }, [status]);
  useEffect(() => {
    const controller = new AbortController();
    const cache = new ResourceCache(source);
    setStatus(undefined);
    setState({ source });
    void recover(
      () =>
        source.open(controller.signal, {
          onStatus: (status) => {
            if (!controller.signal.aborted) setStatus(status);
          },
        }),
      controller.signal,
      (error) => setState({ source, error }),
    ).then(
      (info) => {
        if (controller.signal.aborted) return;
        if (!info.pages.length || info.pages.some((page) => !(page.width > 0 && page.height > 0))) {
          setState({ source, error: new RemoteKitError('internal', '文档页面格式错误') });
        } else setState({ source, info, cache });
      },
      (error) => {
        if (controller.signal.aborted) return;
        setStatus(undefined);
        setState({
          source,
          error: failureError(error),
        });
      },
    );
    return () => {
      controller.abort();
      cache.dispose();
    };
  }, [source]);
  const active = state?.source === source ? state : undefined;
  return (
    <section className="document-viewer" aria-label={title}>
      {!hideTitle && (
        <div className="document-viewer-title" title={title}>
          {title}
        </div>
      )}
      {active?.info && active.cache ? (
        <OpenDocument
          key={active.info.documentId}
          info={active.info}
          cache={active.cache}
          initialProgress={initialProgress}
          onProgress={onProgress}
        />
      ) : (
        <div className="document-viewer-state" role={active?.error ? 'alert' : 'status'}>
          {active?.error ? (
            <SurfaceState error={active.error} context={{ operation: '打开文档', scope: 'surface' }} />
          ) : (
            <>
              <div
                className="document-viewer-file-icon"
                style={{
                  color: fileTypeColor(type, title),
                  backgroundColor: `${fileTypeColor(type, title)}18`,
                }}
              >
                <FileTypeIcon type={type} name={title} />
              </div>
              <strong className="document-viewer-opening-title" title={title}>
                {title}
              </strong>
              <LinearProgress className="document-viewer-opening-progress" />
              <span>
                {status === 'converting' ? '正在转换文档，首次打开可能需要一些时间' : '正在打开文档…'}
              </span>
              {status === 'converting' && slow && <span>仍在转换…</span>}
            </>
          )}
        </div>
      )}
    </section>
  );
}
