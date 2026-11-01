import type { Diagnostics, Surface } from './types';
import { useEffect, useRef, useState } from 'react';
const measured = (value: unknown, suffix: string, digits = 1) => typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(digits)} ${suffix}` : '—';
export function StatsOverlay({ diagnostics, surface }: { diagnostics: Diagnostics; surface?: Surface }) {
  const overlay = useRef<HTMLDivElement>(null), [scale, setScale] = useState(1);
  useEffect(() => { const node = overlay.current, parent = node?.parentElement; if (!node || !parent) return; const resize = () => setScale(Math.max(.1, Math.min(1, (parent.clientWidth - 24) / node.offsetWidth, (parent.clientHeight - 24) / node.offsetHeight))); const observer = new ResizeObserver(resize); observer.observe(parent); observer.observe(node); resize(); return () => observer.disconnect(); }, []);
  const endpoint = diagnostics.endpoint;
  const sender = endpoint?.senderRtcStats as { selectedPair?: { availableOutgoingBitrate?: number } } | undefined;
  return <div ref={overlay} className="stats-overlay" style={{ maxWidth: 'none', transform: `scale(${scale})`, transformOrigin: 'top right' }} aria-label="串流指标叠层"><div className="stats-overlay-title">LIVE STATS <span>{diagnostics.codec ?? '—'}</span></div><dl>
    <dt>显示 FPS</dt><dd>{measured(surface ? diagnostics.paintFpsByView?.[surface.id] : diagnostics.displayFramesPerSecond, 'fps')}</dd>
    <dt>解码 FPS</dt><dd>{measured(diagnostics.decodedFramesPerSecond, 'fps')}</dd>
    <dt>Marker 抽样</dt><dd>{measured(diagnostics.markerSampleHz, 'Hz')}</dd>
    <dt title={diagnostics.marker?.kind === 'input' ? '输入到画面' : '渲染到画面'}>Marker p50 / p95</dt><dd>{diagnostics.marker ? `${measured(diagnostics.marker.p50, 'ms')} / ${measured(diagnostics.marker.p95, 'ms')}` : '—'}</dd>
    <dt>RTT</dt><dd>{measured(diagnostics.roundTripTime === undefined ? undefined : diagnostics.roundTripTime * 1000, 'ms')}</dd>
    <dt title="从捕获完成时刻计算，不包含捕获本身耗时">捕获完成→纹理就绪</dt><dd>{measured(endpoint?.captureToReadyMs, 'ms')}</dd>
    <dt>GPU copy</dt><dd>{measured(endpoint?.lastGpuCopyMs, 'ms')}</dd>
    <dt>Encode</dt><dd>{measured(endpoint?.lastEncodeMs, 'ms')}</dd>
    <dt>接收码率</dt><dd>{measured(diagnostics.receiveBitrateBps === undefined ? undefined : diagnostics.receiveBitrateBps / 1000000, 'Mbps', 2)}</dd>
    <dt>下行带宽估计</dt><dd>{measured(sender?.selectedPair?.availableOutgoingBitrate === undefined ? undefined : sender.selectedPair.availableOutgoingBitrate / 1000000, 'Mbps', 2)}</dd>
    <dt>编码器</dt><dd>{typeof endpoint?.encoder === 'string' && endpoint.encoder ? endpoint.encoder : '—'}</dd>
    <dt>Source</dt><dd>{typeof endpoint?.sourceWidth === 'number' && typeof endpoint?.sourceHeight === 'number' ? `${endpoint.sourceWidth}×${endpoint.sourceHeight}` : '—'}</dd>
    <dt>Encoded</dt><dd>{diagnostics.videoWidth && diagnostics.videoHeight ? `${diagnostics.videoWidth}×${diagnostics.videoHeight}` : '—'}</dd>
    <dt>媒体采样</dt><dd>{measured(surface ? surface.mediaScale ?? 1 : endpoint?.mediaScale, '×', 3)}</dd>
  </dl></div>;
}
