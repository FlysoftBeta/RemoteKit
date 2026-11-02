import type { Diagnostics, Surface } from './types';
import { useEffect, useRef, useState } from 'react';
const measured = (value: unknown, suffix: string, digits = 1) => typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(digits)} ${suffix}` : '—';
const resolutionReason:Record<string,string>={'none':'无','receiver-level-macroblock-rate':'接收端像素速率','receiver-level-frame-size':'接收端单帧像素','receiver-level-axis-limit':'接收端尺寸上限','encoder-axis-limit':'编码器尺寸上限'};
const backendReasons:Record<string,string>={'single-or-no-eligible-plane':'单平面 / 等待平面','chrome89-compatible-2d':'Chrome89 兼容','webgl2-unavailable':'WebGL2 不可用','duplicate-plane':'平面重复','geometry-budget-or-hidden':'几何 / 像素预算','waiting-for-shared-frame':'等待共享帧','context-lost':'GL 上下文丢失','texture-upload':'GL 上传失败','draw-submit':'GL 绘制失败','source-texture-limit':'纹理尺寸上限','output-canvas-limit':'画布尺寸上限','resource-allocation':'GL 资源分配失败'};
export function StatsOverlay({ diagnostics, surface }: { diagnostics: Diagnostics; surface?: Surface }) {
  const overlay = useRef<HTMLDivElement>(null), [scale, setScale] = useState(1);
  useEffect(() => { const node = overlay.current, parent = node?.parentElement; if (!node || !parent) return; const resize = () => setScale(Math.max(.1, Math.min(1, (parent.clientWidth - 24) / node.offsetWidth, (parent.clientHeight - 24) / node.offsetHeight))); const observer = new ResizeObserver(resize); observer.observe(parent); observer.observe(node); resize(); return () => observer.disconnect(); }, []);
  const endpoint = diagnostics.endpoint;
  const mediaPolicy=endpoint?.mediaPolicy as {requested?:{targetFps?:number};applied?:{targetFps?:number;codecTargetFps?:number;fpsLimitation?:string}}|undefined;
  const sender = endpoint?.senderRtcStats as { selectedPair?: { availableOutgoingBitrate?: number } } | undefined;
  const adaptive=endpoint?.adaptiveFps as {targetRenderFps?:number;actualAppliedRenderFps?:number;reason?:string;effectiveLimit?:number;displayLimit?:number}|undefined;
  return <div ref={overlay} className="stats-overlay" style={{ maxWidth: 'none', transform: `scale(${scale})`, transformOrigin: 'top right' }} aria-label="串流指标叠层"><div className="stats-overlay-title">LIVE STATS <span>{diagnostics.codec ?? '—'}</span></div><dl>
    <dt title={diagnostics.receiveSelection?.reason}>接收档</dt><dd>{diagnostics.receiveSelection?.profile ?? '—'}</dd>
    <dt title={diagnostics.rendering?.backend === 'video' ? '每平面video compositor presentedFrames计数变化；不是rVFC回调数或物理屏幕刷新率' : '每个平面的新帧canvas绘制提交次数；不是物理屏幕刷新率'}>{diagnostics.rendering?.backend === 'video' ? '呈现 FPS' : '绘制 FPS'}</dt><dd>{measured(surface ? diagnostics.paintFpsByView?.[surface.id] : diagnostics.displayFramesPerSecond, 'fps')}</dd>
    <dt>解码 FPS</dt><dd>{measured(diagnostics.decodedFramesPerSecond, 'fps')}</dd>
    <dt>呈现后端</dt><dd title={diagnostics.rendering?.backendReason}>{diagnostics.rendering?.backend ?? '—'}</dd>
    <dt title={diagnostics.rendering?.frameSourceFallbackReason}>取帧 / 可见状态</dt><dd>{diagnostics.rendering?.frameSource??'—'} / {diagnostics.rendering?.visibility??'—'}</dd>
    {diagnostics.rendering?.backend==='canvas-2d'&&<><dt>2D 原因</dt><dd title={diagnostics.rendering.backendReason}>{backendReasons[diagnostics.rendering.backendReason??'']??'GL 初始化失败'}</dd></>}
    <dt title="共享纹理上传 / 2D平面draw累计提交次数">上传 / 2D draw</dt><dd>{diagnostics.rendering ? `${diagnostics.rendering.shared.uploads ?? 0} / ${diagnostics.rendering.plane2dDraws}` : '—'}</dd>
    <dt title="包含FIFO排队与等待RAF；不是单独的DC metadata延迟">读取→授权 p95</dt><dd>{measured(diagnostics.rendering?.scheduling.readToAuthorizeMs.p95, 'ms')}</dd>
    <dt title="读取时metadata尚未匹配 / JS队列丢弃，可能与decode帧窗口不同">Metadata / 队列丢弃</dt><dd>{diagnostics.rendering ? `${diagnostics.rendering.scheduling.metadataMissingAtRead} / ${Object.values(diagnostics.rendering.scheduling.drops).reduce((a,b)=>a+b,0)}` : '—'}</dd>
    <dt>Marker 抽样</dt><dd>{measured(diagnostics.markerSampleHz, 'Hz')}</dd>
    <dt title={diagnostics.marker?.kind === 'input' ? '输入到画面' : '渲染到画面'}>Marker p50 / p95</dt><dd>{diagnostics.marker ? `${measured(diagnostics.marker.p50, 'ms')} / ${measured(diagnostics.marker.p95, 'ms')}` : '—'}</dd>
    <dt title={diagnostics.rendering?.backend === 'video' ? '采集完成到匹配RTP的video compositor回调观察；区别于物理屏幕点亮与Pixel marker' : '采集完成到canvas提交的校准估算，区别于Pixel marker'}>采集→呈现估算 p95</dt><dd>{measured(diagnostics.presentationEstimate?.presentationLatencyMs, 'ms')}</dd>
    <dt>估算不确定度</dt><dd>{measured(diagnostics.presentationEstimate?.clockUncertaintyMs, 'ms')}</dd>
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
    <dt>分辨率限制</dt><dd title={`${endpoint?.resolutionLimitation ?? '—'}；协商level ${endpoint?.negotiatedReceiveLevel ?? '—'}；采样FPS预算 ${endpoint?.samplingFpsBudget ?? '—'}`}>{typeof endpoint?.resolutionLimitation === 'string' ? resolutionReason[endpoint.resolutionLimitation]??endpoint.resolutionLimitation : '—'}</dd>
    <dt title={mediaPolicy?.applied?.fpsLimitation}>编码 FPS 上限</dt><dd>{measured(mediaPolicy?.applied?.codecTargetFps,'fps')}</dd>
    <dt title="产品请求 / 当前自适应生效预算；实际绘制与解码见上方">请求 / 生效 FPS</dt><dd>{mediaPolicy ? `${mediaPolicy.requested?.targetFps??'—'} / ${mediaPolicy.applied?.targetFps??'—'}` : '—'}</dd>
    <dt title="Browser 源渲染预算目标 / 已确认应用，不是客户端绘制FPS">源渲染预算</dt><dd>{adaptive ? `${adaptive.targetRenderFps??'—'} / ${adaptive.actualAppliedRenderFps??'—'}`:'—'}</dd>
    <dt>自适应原因</dt><dd>{adaptive?.reason??'—'}</dd>
    <dt title="前台RAF回调节拍估计，不等于物理刷新率；可能受负载或遮挡影响">反馈 RAF 节拍</dt><dd>{measured(endpoint?.feedbackDisplayHzEstimate,'Hz')} / {typeof endpoint?.feedbackRafSamples==='number'?endpoint.feedbackRafSamples:'—'}</dd>
    <dt title="反馈样本距离Endpoint收到的时间">反馈年龄</dt><dd>{measured(endpoint?.feedbackAgeMs,'ms')}</dd>
    <dt>源帧间隔</dt><dd>{measured(endpoint?.sourceFrameIntervalMs,'ms')}</dd>
  </dl></div>;
}
