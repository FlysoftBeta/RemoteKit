import { useEffect, useRef, useState } from 'react';
import { MarkerMeasurement } from './marker';
import type { RemoteTransport } from './transport';
import { request } from './types';
export function MarkerTools({ transport, viewId }: { transport: RemoteTransport; viewId?: string | null }) {
  const run = useRef<MarkerMeasurement | null>(null); const sequence = useRef(0);
  const [active, setActive] = useState(false); const [sameClock, setSameClock] = useState(false);
  const [parameters, setParameters] = useState('{"mode":"animation","targetFps":60,"tenants":1}');
  const [status, setStatus] = useState('');
  const [sampleHz, setSampleHz] = useState(10);
  useEffect(() => () => run.current?.stop(), []);
  useEffect(() => { run.current?.stop(); setActive(false); }, [viewId]);
  useEffect(() => { if (!active) return; const timer = setInterval(() => { if (run.current) transport.setMarkerStats(run.current.report()); }, 1000); return () => clearInterval(timer); }, [active, transport]);
  const surface = () => transport.layout?.views.find(view => view.id === viewId);
  const start = () => {
    try {
      if (!surface() || !transport.displayReady || !viewId || !transport.getLastPresentation(viewId)) throw new Error('需要实际接收的视频与已绘制的匹配平面。请先打开 /test-pattern.html。');
      const config = JSON.parse(parameters); if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('实验参数需要 JSON 对象');
      run.current?.stop(); run.current = new MarkerMeasurement(transport.video, surface, { sameMachineClock: sameClock, sampleHz, parameters: { ...config, viewId, layoutGeneration: transport.layout?.generation, layoutEpoch: transport.layout?.epoch, connectionId: transport.diagnostics.connectionId }, decodedFrames: () => transport.diagnostics.framesDecoded, frameSource: frame => frame ? transport.getPaintedFrame(frame.viewId, frame.rtpTimestamp) : undefined, subscribeFrame: listener => transport.subscribePresentedFrames(frame => { if (frame.viewId === viewId) listener(frame); }), recordCost: (name, at, durationMs) => transport.recordPresentationCost(name, at, durationMs) }); run.current.start(); setActive(true); setStatus('正在从实际绘制平面识别 marker（最多 2000 个有效样本）');
    } catch (error) { setStatus(String(error instanceof Error ? error.message : error)); }
  };
  const upload = async () => {
    run.current?.stop(); setActive(false);
    if (!run.current) return;
    const report = { ...run.current.report(), networkSimulation: transport.diagnostics.networkSimulation, selectedCandidates: transport.diagnostics.selectedCandidates, rtc: transport.diagnostics };
    transport.setMarkerStats(report);
    try { await request('/api/metrics', report); setStatus(JSON.stringify(report, (key, value) => key === 'samples' ? `${value.length} raw samples uploaded` : value, 2)); } catch (error) { setStatus(String(error)); }
  };
  const sampling = <label className="receive-profile">Marker 抽样频率<select aria-label="Marker 抽样频率" value={sampleHz} disabled={active} onChange={event => setSampleHz(Number(event.target.value))}><option value="5">5 Hz</option><option value="10">10 Hz</option><option value="30">30 Hz</option><option value="60">每帧（上限 60 Hz）</option></select></label>;
  return <div className="diagnostic-section"><h3>Pixel marker 实验</h3><p className="panel-copy">远程页面打开 /test-pattern.html。只识别实际接收视频；静态场景帧率单独记录。参数填写本次真实实验条件。</p><label><input type="checkbox" checked={sameClock} onChange={event => setSameClock(event.target.checked)} /> 浏览器与 Endpoint 同一台机器时钟</label>{sampling}<textarea aria-label="实验参数 JSON" value={parameters} onChange={event => setParameters(event.target.value)} style={{ width: '100%', minHeight: 80 }} /><button className="secondary-button" disabled={active} onClick={start}>开始测量</button><button className="secondary-button" disabled={!active} onClick={() => { const view = surface(); if (!view || !run.current) return; const id = (++sequence.current) & 65535; transport.focus(view, true); run.current.input(id); transport.sendInput(view, { type: 'ime_commit', text: `RK:${id};` }); }}>发送输入刺激</button><button className="secondary-button" disabled={!active} onClick={() => void upload()}>停止并上传样本</button><pre style={{ whiteSpace: 'pre-wrap' }}>{status}</pre></div>;
}
