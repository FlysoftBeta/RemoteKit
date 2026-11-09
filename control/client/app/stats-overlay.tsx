import './stats-overlay.css';
import { useEffect, useRef, useState } from 'react';
import { statsViewModel } from '../media/stats-view-model';
import type { Diagnostics } from '../media/types';
import type { Surface } from '../presentation/types';
const measured = (value: unknown, suffix: string, digits = 1) =>
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(digits)} ${suffix}` : '—';
const row = (label: string, value: unknown, suffix: string, digits = 1) =>
  typeof value === 'number' && Number.isFinite(value) ? (
    <>
      <dt>{label}</dt>
      <dd>{measured(value, suffix, digits)}</dd>
    </>
  ) : null;
const levelLabel = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value === 9
      ? '1b'
      : `${Math.floor(value / 10)}.${value % 10}`
    : '—';
// The overlay ignores pointer events, so explanations must be visible text.
const note = (text: string) => (
  <dd
    style={{
      gridColumn: '1 / -1',
      textAlign: 'left',
      fontSize: '0.85em',
      overflowWrap: 'anywhere',
      whiteSpace: 'normal',
    }}
  >
    {text}
  </dd>
);
const resolutionReason: Record<string, string> = {
  none: '无',
  'receiver-level-macroblock-rate': '接收端像素速率',
  'receiver-level-frame-size': '接收端单帧像素',
  'receiver-level-axis-limit': '接收端尺寸上限',
  'encoder-axis-limit': '编码器尺寸上限',
};
export function StatsOverlay({ diagnostics, surface }: { diagnostics: Diagnostics; surface?: Surface }) {
  const overlay = useRef<HTMLDivElement>(null),
    [scale, setScale] = useState(1);
  useEffect(() => {
    const node = overlay.current,
      parent = node?.parentElement;
    if (!node || !parent || typeof ResizeObserver !== 'function') return;
    const resize = () =>
      setScale(
        Math.max(
          0.1,
          Math.min(
            1,
            (parent.clientWidth - 24) / node.offsetWidth,
            (parent.clientHeight - 24) / node.offsetHeight,
          ),
        ),
      );
    const observer = new ResizeObserver(resize);
    observer.observe(parent);
    observer.observe(node);
    resize();
    return () => observer.disconnect();
  }, []);
  const endpoint = diagnostics.endpoint;
  const model = statsViewModel(diagnostics, surface?.id);
  const videoTiming = model.videoTiming;
  const receiverTiming = model.receiverTiming;
  const playoutExtension = diagnostics.receiverVideoPlayoutExtensionNegotiated;
  const requestedPlayout = endpoint?.rtcPlayoutDelayRequested as { maxMs?: number } | undefined;
  const requestedCap = requestedPlayout?.maxMs;
  const mediaPolicy = endpoint?.mediaPolicy as
    | {
        requested?: { maxFps?: number; degradationPreference?: string };
        applied?: { maxFps?: number; degradationPreference?: string };
      }
    | undefined;
  const comp = endpoint?.comp as { codecMaxFps?: unknown; officialMaxFps?: unknown } | undefined;
  const sender = endpoint?.senderRtcStats as
    { selectedPair?: { availableOutgoingBitrate?: number } } | undefined;
  return (
    <div
      ref={overlay}
      className="stats-overlay"
      style={{ maxWidth: 'none', transform: `scale(${scale})`, transformOrigin: 'top right' }}
      aria-label="串流指标叠层"
    >
      <div className="stats-overlay-title">
        LIVE STATS <span>{diagnostics.codec ?? '—'}</span>
      </div>
      <dl>
        <dt>接收档</dt>
        <dd>{diagnostics.receiveSelection?.profile ?? '—'}</dd>
        {diagnostics.receiveSelection?.reason && note(diagnostics.receiveSelection.reason)}
        <dt>Video 提交 FPS</dt>
        <dd>{measured(model.presentationFps, 'fps')}</dd>
        <dt>解码 FPS</dt>
        <dd>{measured(diagnostics.decodedFramesPerSecond, 'fps')}</dd>
        {row('Video 元素收帧 FPS', videoTiming?.videoElementFps, 'fps')}
        {row('Video 元素丢帧', videoTiming?.videoElementDrops, '帧', 0)}
        {row('rVFC 回调 FPS', videoTiming?.callbackFps, 'fps')}
        <dt>呈现后端</dt>
        <dd>{diagnostics.rendering?.backend ?? '—'}</dd>
        <dt>页面可见状态</dt>
        <dd>{diagnostics.rendering?.visibility ?? '—'}</dd>
        {diagnostics.rendering?.backendReason && (
          <>
            <dt>呈现错误</dt>
            <dd>{diagnostics.rendering.backendReason}</dd>
          </>
        )}
        {row('Marker 抽样', diagnostics.markerSampleHz, 'Hz')}
        {diagnostics.marker && (
          <>
            <dt>Marker p50 / p95</dt>
            <dd>
              {measured(diagnostics.marker.p50, 'ms')} / {measured(diagnostics.marker.p95, 'ms')}
            </dd>
          </>
        )}
        {row('末包→Video 提交 p95', videoTiming?.receiveToSubmit?.p95, 'ms')}
        {row('Video 提交→回调 p95', videoTiming?.submitToCallback?.p95, 'ms')}
        {row('rVFC 晚于预计显示 p95', videoTiming?.expectedDisplayLateness?.p95, 'ms')}
        {row('接收缓冲均值', receiverTiming?.jitterBufferMeanMs, 'ms')}
        {row('接收缓冲目标均值', receiverTiming?.jitterBufferTargetMeanMs, 'ms')}
        {row('接收缓冲最小均值', receiverTiming?.jitterBufferMinimumMeanMs, 'ms')}
        {row('帧组装耗时均值', receiverTiming?.assemblyMeanMs, 'ms')}
        {row('接收处理耗时均值', receiverTiming?.processingMeanMs, 'ms')}
        {row('解码耗时均值', receiverTiming?.decodeMeanMs, 'ms')}
        {receiverTiming?.decoderImplementation && (
          <>
            <dt>解码器</dt>
            <dd style={{ overflowWrap: 'anywhere', maxWidth: 135 }}>
              {receiverTiming.decoderImplementation}
            </dd>
          </>
        )}
        {row('接收侧丢帧', receiverTiming?.droppedFrames, '帧', 0)}
        {row(
          '接收重传包占比',
          receiverTiming?.receivedPacketRetransmitRatio === undefined
            ? undefined
            : receiverTiming.receivedPacketRetransmitRatio * 100,
          '%',
          2,
        )}
        <dt>RTT</dt>
        <dd>
          {measured(
            diagnostics.roundTripTime === undefined ? undefined : diagnostics.roundTripTime * 1000,
            'ms',
          )}
        </dd>
        {row('最近编码耗时', endpoint?.lastEncodeMs, 'ms')}
        <dt>接收码率</dt>
        <dd>
          {measured(
            diagnostics.receiveBitrateBps === undefined ? undefined : diagnostics.receiveBitrateBps / 1000000,
            'Mbps',
            2,
          )}
        </dd>
        {row(
          '下行带宽估计',
          sender?.selectedPair?.availableOutgoingBitrate === undefined
            ? undefined
            : sender.selectedPair.availableOutgoingBitrate / 1000000,
          'Mbps',
          2,
        )}
        <dt>编码器</dt>
        <dd>{typeof endpoint?.encoder === 'string' && endpoint.encoder ? endpoint.encoder : '—'}</dd>
        <dt>源 Atlas</dt>
        <dd>
          {typeof endpoint?.sourceAtlasWidth === 'number' && typeof endpoint?.sourceAtlasHeight === 'number'
            ? `${endpoint.sourceAtlasWidth}×${endpoint.sourceAtlasHeight}`
            : '—'}
        </dd>
        <dt>Encoded</dt>
        <dd>
          {diagnostics.videoWidth && diagnostics.videoHeight
            ? `${diagnostics.videoWidth}×${diagnostics.videoHeight}`
            : '—'}
        </dd>
        <dt>媒体采样 X / Y</dt>
        <dd>
          {measured(
            surface
              ? (surface.mediaScaleX ?? surface.mediaScale ?? 1)
              : (endpoint?.mediaScaleX ?? endpoint?.mediaScale),
            '×',
            3,
          )}{' '}
          /{' '}
          {measured(
            surface
              ? (surface.mediaScaleY ?? surface.mediaScale ?? 1)
              : (endpoint?.mediaScaleY ?? endpoint?.mediaScale),
            '×',
            3,
          )}
        </dd>
        <dt>分辨率限制</dt>
        <dd>
          {typeof endpoint?.resolutionLimitation === 'string'
            ? (resolutionReason[endpoint.resolutionLimitation] ?? endpoint.resolutionLimitation)
            : '—'}
        </dd>
        <dt>协商 H264 level</dt>
        <dd>{levelLabel(endpoint?.negotiatedReceiveLevel)}</dd>
        <dt>FPS 上限 level / WebRTC</dt>
        <dd>
          {typeof comp?.codecMaxFps === 'number' ? comp.codecMaxFps : '—'} /{' '}
          {typeof comp?.officialMaxFps === 'number' ? comp.officialMaxFps : '—'}
        </dd>
        <dt>输入 FPS 估计</dt>
        <dd>{measured(model.inputFps, 'fps')}</dd>
        <dt>GCC 目标码率</dt>
        <dd>
          {measured(
            typeof model.targetBitrate === 'number' ? model.targetBitrate / 1000000 : undefined,
            'Mbps',
            2,
          )}
        </dd>
        <dt>编码队列满丢帧</dt>
        <dd>{typeof endpoint?.queueFullDrops === 'number' ? endpoint.queueFullDrops : '—'}</dd>
        <dt>请求 / 生效 FPS 上限</dt>
        <dd>
          {mediaPolicy
            ? `${mediaPolicy.requested?.maxFps ?? '—'} / ${mediaPolicy.applied?.maxFps ?? '—'}`
            : '—'}
        </dd>
        <dt>WebRTC 降级偏好</dt>
        <dd>
          {mediaPolicy?.applied?.degradationPreference ??
            mediaPolicy?.requested?.degradationPreference ??
            '—'}
        </dd>
        <dt>视频接收缓冲目标</dt>
        <dd>
          {diagnostics.receiverPlayout?.video?.jitterBufferTarget === 0
            ? '0 ms'
            : diagnostics.receiverPlayout?.video?.playoutDelayHint === 0
              ? '兼容 hint 0 s'
              : '不可用'}
        </dd>
        {playoutExtension !== undefined && (
          <>
            <dt>RTP 播放延迟</dt>
            <dd>
              {playoutExtension ? '已协商' : '未协商'}
              {typeof requestedCap === 'number' && Number.isFinite(requestedCap) && requestedCap >= 0
                ? ` / 请求 ${measured(requestedCap, 'ms', 0)}`
                : ''}
            </dd>
          </>
        )}
        <dt>反馈 RAF 节拍</dt>
        <dd>
          {measured(endpoint?.feedbackDisplayHzEstimate, 'Hz')} /{' '}
          {typeof endpoint?.feedbackRafSamples === 'number' ? endpoint.feedbackRafSamples : '—'}
        </dd>
        {row('反馈年龄', endpoint?.feedbackAgeMs, 'ms')}
        {row('源帧间隔', endpoint?.sourceFrameIntervalMs, 'ms')}
      </dl>
    </div>
  );
}
