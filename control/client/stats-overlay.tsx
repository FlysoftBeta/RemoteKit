import type { Diagnostics, Surface } from './types';
import { useEffect, useRef, useState } from 'react';
const measured = (value: unknown, suffix: string, digits = 1) => typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(digits)} ${suffix}` : '—';
const row = (label: string, value: unknown, suffix: string, title?: string, digits = 1) =>
  typeof value === 'number' && Number.isFinite(value) ? <><dt title={title}>{label}</dt><dd>{measured(value, suffix, digits)}</dd></> : null;
const resolutionReason:Record<string,string>={'none':'无','receiver-level-macroblock-rate':'接收端像素速率','receiver-level-frame-size':'接收端单帧像素','receiver-level-axis-limit':'接收端尺寸上限','encoder-axis-limit':'编码器尺寸上限'};
const presentationReasons:Record<string,string>={'video-capability-unavailable':'Video 能力不可用','presentation-protocol-unavailable':'呈现协议协商超时','video-playback-failed':'Video 播放失败','video-rtp-metadata-unavailable':'Video RTP 元数据不可用','invalid-presentation-mode':'呈现模式无效','invalid-presentation-barrier':'呈现布局屏障无效'};
export function StatsOverlay({ diagnostics, surface }: { diagnostics: Diagnostics; surface?: Surface }) {
  const overlay = useRef<HTMLDivElement>(null), [scale, setScale] = useState(1);
  useEffect(() => { const node = overlay.current, parent = node?.parentElement; if (!node || !parent || typeof ResizeObserver !== 'function') return; const resize = () => setScale(Math.max(.1, Math.min(1, (parent.clientWidth - 24) / node.offsetWidth, (parent.clientHeight - 24) / node.offsetHeight))); const observer = new ResizeObserver(resize); observer.observe(parent); observer.observe(node); resize(); return () => observer.disconnect(); }, []);
  const endpoint = diagnostics.endpoint;
  const videoTiming = surface ? diagnostics.videoTimingByView?.[surface.id] : undefined;
  const receiverTiming = diagnostics.receiverVideoTiming;
  const playoutExtension = diagnostics.receiverVideoPlayoutExtensionNegotiated;
  const requestedPlayout = endpoint?.rtcPlayoutDelayRequested as { maxMs?: number } | undefined;
  const requestedCap = requestedPlayout?.maxMs;
  const mediaPolicy=endpoint?.mediaPolicy as {requested?:{maxFps?:number;degradationPreference?:string};applied?:{maxFps?:number;degradationPreference?:string}}|undefined;
  const sender = endpoint?.senderRtcStats as { selectedPair?: { availableOutgoingBitrate?: number } } | undefined;
  return <div ref={overlay} className="stats-overlay" style={{ maxWidth: 'none', transform: `scale(${scale})`, transformOrigin: 'top right' }} aria-label="串流指标叠层">
    <div className="stats-overlay-title">LIVE STATS <span>{diagnostics.codec ?? '—'}</span></div>
    <dl>
    <dt title={diagnostics.receiveSelection?.reason}>接收档</dt><dd>{diagnostics.receiveSelection?.profile ?? '—'}</dd>
    <dt title="同轮采样的每平面 video compositor presentedFrames 增量，表示视频帧提交">Video 提交 FPS</dt><dd>{measured(surface ? diagnostics.paintFpsByView?.[surface.id] : diagnostics.displayFramesPerSecond, 'fps')}</dd>
    <dt title="相邻 WebRTC 入站统计采样的解码帧增量">解码 FPS</dt><dd>{measured(diagnostics.decodedFramesPerSecond, 'fps')}</dd>
    {row('Video 元素收帧 FPS', videoTiming?.videoElementFps, 'fps', '每个 Video 元素的 totalVideoFrames 增量')}
    {row('Video 元素丢帧', videoTiming?.videoElementDrops, '帧', '同轮采样中该 Video 元素的 droppedVideoFrames 增量', 0)}
    {row('rVFC 回调 FPS', videoTiming?.callbackFps, 'fps', '每平面的 JS 回调频率，单次回调可能跨过多个 Video 提交')}
    <dt>呈现后端</dt><dd title={diagnostics.rendering?.backendReason}>{diagnostics.rendering?.backend ?? '—'}</dd>
    <dt>页面可见状态</dt><dd>{diagnostics.rendering?.visibility ?? '—'}</dd>
    {diagnostics.rendering?.backendReason && <><dt>呈现错误</dt><dd title={diagnostics.rendering.backendReason}>{presentationReasons[diagnostics.rendering.backendReason] ?? diagnostics.rendering.backendReason}</dd></>}
    {row('Marker 抽样', diagnostics.markerSampleHz, 'Hz')}
    {diagnostics.marker && <><dt title={diagnostics.marker.kind === 'input' ? '输入到像素观察' : '渲染到像素观察'}>Marker p50 / p95</dt><dd>{measured(diagnostics.marker.p50, 'ms')} / {measured(diagnostics.marker.p95, 'ms')}</dd></>}
    {row('末包→Video 提交 p95', videoTiming?.receiveToSubmit?.p95, 'ms', '浏览器为同一视频帧提供的末包接收和 compositor 提交时间差')}
    {row('Video 提交→回调 p95', videoTiming?.submitToCallback?.p95, 'ms', 'Compositor 提交至主线程开始处理 rVFC 的时间差')}
    {row('rVFC 晚于预计显示 p95', videoTiming?.expectedDisplayLateness?.p95, 'ms', '回调晚于浏览器预计显示时间的时长，提前执行记为 0')}
    {row('接收缓冲均值', receiverTiming?.jitterBufferMeanMs, 'ms', '同轮采样新增缓冲时间 / 已出缓冲帧数')}
    {row('接收缓冲目标均值', receiverTiming?.jitterBufferTargetMeanMs, 'ms', '同轮采样中浏览器内部的目标缓冲时间均值')}
    {row('接收缓冲最小均值', receiverTiming?.jitterBufferMinimumMeanMs, 'ms', '浏览器估算的最低缓冲目标在本轮采样内的均值')}
    {row('帧组装耗时均值', receiverTiming?.assemblyMeanMs, 'ms', '同轮采样中已解码的多包视频帧从首包到末包的平均耗时')}
    {row('接收处理耗时均值', receiverTiming?.processingMeanMs, 'ms', '同轮采样中视频帧从首包到解码完成的时间均值')}
    {row('解码耗时均值', receiverTiming?.decodeMeanMs, 'ms', '同轮采样新增解码时间 / 已解码帧数')}
    {receiverTiming?.decoderImplementation && <><dt>解码器</dt><dd style={{ overflowWrap: 'anywhere', maxWidth: 135 }}>{receiverTiming.decoderImplementation}</dd></>}
    {row('接收侧丢帧', receiverTiming?.droppedFrames, '帧', '同轮采样 RTC framesDropped 增量', 0)}
    {row('接收重传包占比', receiverTiming?.receivedPacketRetransmitRatio === undefined ? undefined : receiverTiming.receivedPacketRetransmitRatio * 100, '%', '同轮采样新增重传包数 / 新增接收包数', 2)}
    <dt>RTT</dt><dd>{measured(diagnostics.roundTripTime === undefined ? undefined : diagnostics.roundTripTime * 1000, 'ms')}</dd>
    {row('最近编码耗时', endpoint?.lastEncodeMs, 'ms')}
    <dt>接收码率</dt><dd>{measured(diagnostics.receiveBitrateBps === undefined ? undefined : diagnostics.receiveBitrateBps / 1000000, 'Mbps', 2)}</dd>
    {row('下行带宽估计', sender?.selectedPair?.availableOutgoingBitrate === undefined ? undefined : sender.selectedPair.availableOutgoingBitrate / 1000000, 'Mbps', undefined, 2)}
    <dt>编码器</dt><dd>{typeof endpoint?.encoder === 'string' && endpoint.encoder ? endpoint.encoder : '—'}</dd>
    <dt>源 Atlas</dt><dd>{typeof endpoint?.sourceAtlasWidth === 'number' && typeof endpoint?.sourceAtlasHeight === 'number' ? `${endpoint.sourceAtlasWidth}×${endpoint.sourceAtlasHeight}` : '—'}</dd>
    <dt>Encoded</dt><dd>{diagnostics.videoWidth && diagnostics.videoHeight ? `${diagnostics.videoWidth}×${diagnostics.videoHeight}` : '—'}</dd>
    <dt>媒体采样 X / Y</dt><dd>{measured(surface ? surface.mediaScaleX ?? surface.mediaScale ?? 1 : endpoint?.mediaScaleX ?? endpoint?.mediaScale, '×', 3)} / {measured(surface ? surface.mediaScaleY ?? surface.mediaScale ?? 1 : endpoint?.mediaScaleY ?? endpoint?.mediaScale, '×', 3)}</dd>
    <dt>分辨率限制</dt><dd title={`${endpoint?.resolutionLimitation ?? '—'}；协商level ${endpoint?.negotiatedReceiveLevel ?? '—'}；采样FPS预算 ${endpoint?.samplingFpsBudget ?? '—'}`}>{typeof endpoint?.resolutionLimitation === 'string' ? resolutionReason[endpoint.resolutionLimitation]??endpoint.resolutionLimitation : '—'}</dd>
    <dt title="WebRTC拥塞控制给编码器的目标帧率；不是硬件时基或实际输出FPS">GCC 目标 FPS</dt><dd>{measured(endpoint?.gccTargetFps,'fps')}</dd>
    <dt>GCC 目标码率</dt><dd>{measured(typeof endpoint?.gccTargetBitrate === 'number' ? endpoint.gccTargetBitrate / 1000000 : undefined, 'Mbps', 2)}</dd>
    <dt>编码队列满丢帧</dt><dd>{typeof endpoint?.queueFullDrops === 'number' ? endpoint.queueFullDrops : '—'}</dd>
    <dt title="客户端显示上限 / Endpoint应用上限；实际绘制与解码见上方">请求 / 生效 FPS 上限</dt><dd>{mediaPolicy ? `${mediaPolicy.requested?.maxFps??'—'} / ${mediaPolicy.applied?.maxFps??'—'}` : '—'}</dd>
    <dt>WebRTC 降级偏好</dt><dd>{mediaPolicy?.applied?.degradationPreference??mediaPolicy?.requested?.degradationPreference??'—'}</dd>
    <dt title="标准jitterBufferTarget；Chrome89仅支持兼容hint时单独标识">视频接收缓冲目标</dt><dd>{diagnostics.receiverPlayout?.video?.jitterBufferTarget===0 ? '0 ms' : diagnostics.receiverPlayout?.video?.playoutDelayHint===0 ? '兼容 hint 0 s' : '不可用'}</dd>
    {playoutExtension !== undefined && <><dt title="RTP playout-delay 扩展协商与发送方请求上限">RTP 播放延迟</dt><dd>{playoutExtension ? '已协商' : '未协商'}{typeof requestedCap === 'number' && Number.isFinite(requestedCap) && requestedCap >= 0 ? ` / 请求 ${measured(requestedCap, 'ms', 0)}` : ''}</dd></>}
    <dt title="前台RAF回调节拍估计，不等于物理刷新率；可能受负载或遮挡影响">反馈 RAF 节拍</dt><dd>{measured(endpoint?.feedbackDisplayHzEstimate,'Hz')} / {typeof endpoint?.feedbackRafSamples==='number'?endpoint.feedbackRafSamples:'—'}</dd>
    {row('反馈年龄', endpoint?.feedbackAgeMs, 'ms', '反馈样本距离 Endpoint 收到的时间')}
    {row('源帧间隔', endpoint?.sourceFrameIntervalMs, 'ms')}
  </dl></div>;
}
