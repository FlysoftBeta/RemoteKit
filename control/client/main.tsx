import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RemoteTransport } from './transport';
import { keyIdentity, mouseButtonModifiers } from './keys';
import { request, type ControlState, type Device, type Surface, type Tab } from './types';
import './style.css';
import { MarkerTools } from './marker-tools';
import { StatsOverlay } from './stats-overlay';
import { ReceiveSettings } from './receive-settings';
import { clientPointToDip, surfacePixelScale } from './coordinates';

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />, close: <path d="m6 6 12 12M18 6 6 18" />,
    globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c6 5 6 13 0 18-6-5-6-13 0-18Z" /></>,
    split: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M12 4v16" /></>,
    monitor: <><rect x="3" y="3" width="18" height="13" rx="2" /><path d="M8 21h8M12 16v5" /></>,
    tablet: <><rect x="5" y="2" width="14" height="20" rx="3" /><path d="M10 18h4" /></>,
    activity: <path d="M2 12h5l3-8 4 16 3-8h5" />,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
    link: <><path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 0)" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.globe}</svg>;
}

const transport = new RemoteTransport();
Object.assign(window, { remotekitDiagnostics: { transport } });
const modifiers = (event: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }) => Number(event.shiftKey) | (Number(event.ctrlKey) << 1) | (Number(event.altKey) << 2) | (Number(event.metaKey) << 3);

function Viewport({ tab, device, secondary = false, overlay = false }: { tab: Tab; device: Device; secondary?: boolean; overlay?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const compositionCommit = useRef<string | null>(null);
  const surface = transport.layout?.views.find(view => view.id === tab.webviewId);
  const [frameReady, setFrameReady] = useState(false);
  useEffect(() => {
    setFrameReady(false);
    if (!surface) return;
    const draw = () => {
      const node = canvas.current; const frame = transport.displayFrame;
      if (node && transport.displayReady && frame.width > 0 && surface.x + surface.width <= frame.width && surface.y + surface.height <= frame.height) {
        const start = performance.now();
        if (node.width !== surface.width || node.height !== surface.height) { node.width = surface.width; node.height = surface.height; }
        node.getContext('2d')?.drawImage(frame, surface.x, surface.y, surface.width, surface.height, 0, 0, node.width, node.height);
        transport.recordPresentationCost('viewportDraw', start, performance.now() - start, surface.id);
        node.classList.remove('no-frame');
        const presented = transport.presentedFrame;
        if (presented?.rtpTimestamp !== undefined) transport.reportPresented(surface.id, presented.rtpTimestamp, performance.now(), Date.now());
        setFrameReady(true);
      } else setFrameReady(false);
    };
    const unsubscribe = transport.subscribePaint(draw);
    const observer = new ResizeObserver(draw); if (canvas.current) observer.observe(canvas.current);
    draw(); return () => { unsubscribe(); observer.disconnect(); };
  }, [surface]);
  const send = (event: Record<string, unknown>) => { if (surface) transport.sendInput(surface, event); };
  const point = (event: { clientX: number; clientY: number }) => {
    const rect = canvas.current!.getBoundingClientRect();
    return clientPointToDip(surface!, rect, event.clientX, event.clientY);
  };
  const pointer = (event: React.PointerEvent<HTMLCanvasElement>, action: string) => {
    if (!surface || !frameReady) return;
    if (action === 'down') { event.preventDefault(); editor.current?.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId); }
    const position = point(event);
    if (event.pointerType === 'touch') send({ type: 'touch', action: ({ down: 'start', up: 'end', move: 'move', cancel: 'cancel' } as Record<string, string>)[action], points: [{ id: event.pointerId, ...position, pressure: event.pressure }] });
    else if (action !== 'cancel') send({ type: 'mouse', action, ...position, button: (action === 'move' || action === 'leave') ? 0 : [1, 2, 3, 4, 5][event.button] ?? 0, modifiers: modifiers(event) | mouseButtonModifiers(event.buttons), click_count: (action === 'move' || action === 'leave') ? 0 : Math.min(3, Math.max(1, event.detail)) });
    if ((action === 'up' || action === 'cancel') && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const key = (event: React.KeyboardEvent<HTMLTextAreaElement>, action: string) => {
    if (composing.current || event.nativeEvent.isComposing) return;
    if (event.key === 'Tab' || event.ctrlKey || event.metaKey || event.key.startsWith('Arrow')) event.preventDefault();
    send({ type: 'key', action, ...keyIdentity(event.code, event.key), windows_key_code: event.keyCode, modifiers: modifiers(event), repeat: event.repeat, text: '', unmodified_text: '' });
  };
  return <section className={`view-pane ${device.mode === 'tablet' ? 'tablet-view' : ''}`} aria-label={secondary ? '分屏页面' : '主页面'}>
    <div className="view-label"><span className="view-dot" /><span>{tab.title || '新标签页'}</span><span className="view-dimensions">{surface ? `${Math.round(surface.width / surfacePixelScale(surface))} × ${Math.round(surface.height / surfacePixelScale(surface))}` : `${device.width} × ${device.height}`} DIP</span></div>
    <div className="viewport-stage"><div className={`remote-surface ${device.mode}`} style={{ aspectRatio: `${surface?.width ?? device.width} / ${surface?.height ?? device.height}` }}>
      <canvas ref={canvas} aria-label={`${tab.title || '远程页面'}画面`} className={frameReady ? '' : 'no-frame'} onPointerDown={event => pointer(event, 'down')} onPointerMove={event => pointer(event, 'move')} onPointerUp={event => pointer(event, 'up')} onPointerCancel={event => pointer(event, 'cancel')} onPointerLeave={event => { if (event.pointerType !== 'touch') pointer(event, 'leave'); }} onContextMenu={event => event.preventDefault()} onWheel={event => { if (surface && frameReady) { const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? surface.height / surfacePixelScale(surface) : 1; send({ type: 'wheel', ...point(event), dx: -event.deltaX * unit, dy: -event.deltaY * unit, modifiers: modifiers(event) }); } }} />
      <textarea ref={editor} className="remote-input" aria-label="远程页面键盘输入" autoCapitalize="off" autoComplete="off" spellCheck={false} onFocus={() => surface && transport.focus(surface, true)} onBlur={() => { if (surface) transport.focus(surface, false); }} onKeyDown={event => key(event, 'down')} onKeyUp={event => key(event, 'up')} onCompositionStart={() => { composing.current = true; }} onCompositionUpdate={event => send({ type: 'ime_set', text: event.data, selection_start: event.data.length, selection_end: event.data.length })} onCompositionEnd={event => { composing.current = false; compositionCommit.current = event.data; setTimeout(() => { compositionCommit.current = null; }, 0); send({ type: 'ime_commit', text: event.data }); if (editor.current) editor.current.value = ''; }} onInput={event => { if (!composing.current) { const native = event.nativeEvent as InputEvent; if (native.inputType !== 'insertCompositionText' && native.inputType !== 'insertFromComposition' && native.data && native.data !== compositionCommit.current) send({ type: 'ime_commit', text: native.data }); event.currentTarget.value = ''; } }} />
      {!frameReady && <div className="empty-view"><div className="empty-icon"><Icon name={device.mode === 'tablet' ? 'tablet' : 'monitor'} size={30} /></div><h2>{transport.diagnostics.connection === '已连接' ? '等待页面画面' : '远程页面尚未连接'}</h2><p>{transport.diagnostics.connection === '已连接' ? '连接已建立，等待 Endpoint 的布局与视频。' : '连接 Endpoint 后，页面将在这里呈现。'}</p><span className="empty-url">{tab.url || 'about:blank'}</span></div>}
      {overlay && <StatsOverlay diagnostics={transport.diagnostics} surface={surface} />}
    </div></div>
  </section>;
}

function App() {
  const [state, setState] = useState<ControlState | null>(null);
  const [error, setError] = useState(''); const [pending, setPending] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const [address, setAddress] = useState(''); const [panel, setPanel] = useState<'device' | 'diagnostics' | null>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const [draftDevice, setDraftDevice] = useState<Device>({ mode: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1 });
  const [, render] = useState(0);
  useEffect(() => transport.subscribe(() => render(value => value + 1)), []);
  useEffect(() => { const shortcut = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'l') { event.preventDefault(); event.stopPropagation(); addressInput.current?.focus(); addressInput.current?.select(); } }; document.addEventListener('keydown', shortcut, true); return () => document.removeEventListener('keydown', shortcut, true); }, []);
  const refresh = async () => { try { const next = await request<ControlState>('/api/state'); transport.observeEndpointGeneration(next.endpointGeneration); setState(next); setError(''); } catch (e) { setError(String(e instanceof Error ? e.message : e)); } };
  useEffect(() => { void refresh(); return () => transport.disconnect(); }, []);
  useEffect(() => { const timer = setInterval(() => { if (!pending) void refresh(); }, 2000); return () => clearInterval(timer); }, [pending]);
  useEffect(() => { if (!state?.pendingClose?.awaiting) return; const timer = setInterval(() => void refresh(), 1000); return () => clearInterval(timer); }, [state?.pendingClose?.awaiting]);
  const active = state?.tabs.find(tab => tab.id === state.activeTabId);
  useEffect(() => { transport.selectedViewId = active?.webviewId ?? undefined; }, [active?.webviewId]);
  const split = state?.tabs.find(tab => tab.id === state.splitTabId && tab.id !== active?.id);
  useEffect(() => setAddress(active?.url ?? ''), [active?.id, active?.url]);
  useEffect(() => { if (state) setDraftDevice(state.device); }, [state?.device.mode, state?.device.width, state?.device.height, state?.device.deviceScaleFactor]);
  const action = async (body: Record<string, unknown>) => {
    if (pending) return; setPending(true); setError('');
    try { setState(await request<ControlState>('/api/actions', body)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setPending(false); }
  };
  const diagnostics = transport.diagnostics;
  const connected = diagnostics.connection === '已连接';
  const connecting = diagnostics.connection === '正在连接';
  const metric = (value: number | undefined, unit: string, digits = 0) => value === undefined ? '—' : `${value.toFixed(digits)} ${unit}`;
  return <div className="app-shell">
    <header className="app-header"><a className="brand" href="/" aria-label="RemoteKit 首页"><span className="brand-mark">r<span>k</span></span><span>RemoteKit<span className="brand-caption">浏览器工作台</span></span></a><div className="header-right"><span className="demo-badge">DEMO</span><span className="tenant-label">{state ? `Tenant · ${state.tenantId}` : '控制面'}</span><button className={`connection-button ${connected ? 'connected' : ''}`} disabled={connecting || !state} onClick={() => connected ? transport.disconnect() : void transport.connect()}><i />{connecting ? '正在连接…' : connected ? '断开连接' : '连接 Endpoint'}<Icon name="link" size={15} /></button></div></header>
    <div className="workspace-header"><div><span className="eyebrow">WORKSPACE</span><h1>我的浏览器</h1></div><div className="workspace-tools"><div className="mode-switch" aria-label="布局模式"><button title="切换模式将刷新页面" className={state?.device.mode === 'desktop' ? 'selected' : ''} disabled={!state || pending} onClick={() => state && void action({ type: 'device.set', device: { ...state.device, mode: 'desktop' } })}><Icon name="monitor" />桌面</button><button title="切换模式将刷新页面" className={state?.device.mode === 'tablet' ? 'selected' : ''} disabled={!state || pending} onClick={() => state && void action({ type: 'device.set', device: { ...state.device, mode: 'tablet', width: 820, height: 1180, deviceScaleFactor: 2 } })}><Icon name="tablet" />平板</button></div><button className={`tool-button ${panel === 'device' ? 'selected' : ''}`} disabled={!state} onClick={() => setPanel(panel === 'device' ? null : 'device')}><Icon name="tablet" /><span>设备配置</span></button><button className={`tool-button ${panel === 'diagnostics' ? 'selected' : ''}`} onClick={() => setPanel(panel === 'diagnostics' ? null : 'diagnostics')}><Icon name="activity" /><span>诊断</span></button></div></div>
    {(error || diagnostics.error || state?.endpointError) && <div className="error-banner" role="alert"><span>{error || diagnostics.error || state?.endpointError}</span>{!state && <button onClick={() => void refresh()}>重试</button>}<button aria-label="关闭提示" onClick={() => { setError(''); transport.diagnostics.error = undefined; if (state) setState({ ...state, endpointError: null }); render(value => value + 1); }}><Icon name="close" size={15} /></button></div>}
    {state?.pendingClose && <div className="error-banner" role="alert"><span>{state.pendingClose.awaiting ? '正在等待页面关闭…' : '此页面要求确认离开，是否关闭？'}</span>{!state.pendingClose.awaiting && <><button disabled={pending} onClick={() => void action({ type: 'tab.close', id: state.pendingClose!.id, requestId: state.pendingClose!.requestId, confirm: true })}>关闭页面</button><button disabled={pending} onClick={() => void action({ type: 'tab.close', id: state.pendingClose!.id, requestId: state.pendingClose!.requestId, cancel: true })}>保留页面</button></>}</div>}
    <main className={`workspace ${panel ? 'with-panel' : ''}`}><div className="browser-window"><div className="tab-bar"><div className="tabs" role="tablist" aria-label="浏览器标签页">{state?.tabs.map(tab => <div key={tab.id} className={`tab ${active?.id === tab.id ? 'active' : ''}`}><button role="tab" aria-selected={active?.id === tab.id} disabled={pending} onClick={() => void action({ type: 'tab.activate', id: tab.id })}><Icon name="globe" size={14} /><span>{tab.title || '新标签页'}</span>{state.splitTabId === tab.id && <Icon name="split" size={12} />}</button><button className="tab-close" disabled={pending} aria-label={`关闭 ${tab.title || '标签页'}`} onClick={() => void action({ type: 'tab.close', id: tab.id })}><Icon name="close" size={12} /></button></div>)}</div><button className="icon-button add-tab" title="新建标签页" aria-label="新建标签页" disabled={!state || pending} onClick={() => void action({ type: 'tab.create', url: 'about:blank', title: '新标签页' })}><Icon name="plus" /></button></div>
      <div className="address-row"><div className="navigation-controls"><button className="icon-button navigation-back" aria-label="后退" title="后退" disabled={!active || pending || active.canGoBack === false} onClick={() => active && void action({ type: 'tab.command', id: active.id, command: 'back' })}><Icon name="arrow" size={16} /></button><button className="icon-button" aria-label="前进" title="前进" disabled={!active || pending || active.canGoForward === false} onClick={() => active && void action({ type: 'tab.command', id: active.id, command: 'forward' })}><Icon name="arrow" size={16} /></button><button className="icon-button" aria-label={active?.loading ? '停止加载' : '刷新'} title={active?.loading ? '停止加载' : '刷新'} disabled={!active || pending} onClick={() => active && void action({ type: 'tab.command', id: active.id, command: active.loading ? 'stop' : 'reload' })}><Icon name={active?.loading ? 'stop' : 'refresh'} size={16} /></button></div><span className="address-icon"><Icon name="globe" /></span><form onSubmit={event => { event.preventDefault(); if (active && address.trim()) void action({ type: 'tab.navigate', id: active.id, url: address.trim() }); }}><input ref={addressInput} aria-label="网址" placeholder="输入网址，按 Enter 访问" value={address} disabled={!active || pending} onChange={event => setAddress(event.target.value)} autoComplete="off" spellCheck={false} /><button className="icon-button" aria-label="访问网址" disabled={!active || pending}><Icon name="arrow" size={17} /></button></form><div className="split-control"><Icon name="split" /><select aria-label="选择分屏标签页" disabled={!state || pending || state.tabs.length < 2} value={state?.splitTabId ?? ''} onChange={event => void action({ type: 'split.set', id: event.target.value || null })}><option value="">单页视图</option>{state?.tabs.filter(tab => tab.id !== active?.id).map(tab => <option value={tab.id} key={tab.id}>分屏 · {tab.title || '新标签页'}</option>)}</select></div></div>
      <div className={`view-grid ${split ? 'is-split' : ''}`}>{active && state ? <><Viewport key={active.id} tab={active} device={state.device} overlay={overlay} />{split && <Viewport key={split.id} tab={split} device={state.device} secondary overlay={overlay} />}</> : <div className="no-tabs"><Icon name="plus" size={30} /><h2>{state ? '从一个新标签页开始' : '正在加载工作台'}</h2><p>{state ? '创建标签页，然后连接远程浏览器。' : '正在读取控制面中的标签页与设备配置。'}</p>{state && <button className="primary-button" disabled={pending} onClick={() => void action({ type: 'tab.create', url: 'about:blank', title: '新标签页' })}>新建标签页</button>}</div>}</div>
      <footer className="browser-status"><span><i className={connected ? 'status-dot online' : 'status-dot'} />{diagnostics.connection}</span><span>{state?.tabs.length ?? 0} 个标签页<span className="status-divider">/</span>{split ? '双页分屏' : '单页视图'}</span><span className="status-end">{state?.device.mode === 'tablet' ? '平板' : '桌面'}<span className="status-divider">·</span>WebRTC</span></footer>
    </div>
    {panel && <aside className="side-panel"><div className="panel-heading"><h2>{panel === 'device' ? '设备配置' : '开发诊断'}</h2><button className="icon-button" aria-label="关闭侧栏" onClick={() => setPanel(null)}><Icon name="close" size={16} /></button></div>{panel === 'device' ? <form className="device-form" onSubmit={event => { event.preventDefault(); void action({ type: 'device.set', device: draftDevice }); }}><p className="panel-copy">设置远程页面的视口与像素密度。尺寸以 DIP 为单位。</p><label>设备预设<select value="" onChange={event => { const presets: Record<string, Device> = { desktop: { mode: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1 }, tablet: { mode: 'tablet', width: 820, height: 1180, deviceScaleFactor: 2 }, compact: { mode: 'tablet', width: 768, height: 1024, deviceScaleFactor: 2 } }; if (presets[event.target.value]) setDraftDevice(presets[event.target.value]); }}><option value="" disabled>选择预设</option><option value="desktop">桌面 · 1440 × 900</option><option value="tablet">平板 · 820 × 1180</option><option value="compact">小尺寸平板 · 768 × 1024</option></select></label><div className="field-pair"><label>宽度<input required type="number" min="320" max="4096" value={draftDevice.width} onChange={event => setDraftDevice({ ...draftDevice, width: Number(event.target.value) })} /></label><label>高度<input required type="number" min="240" max="4096" value={draftDevice.height} onChange={event => setDraftDevice({ ...draftDevice, height: Number(event.target.value) })} /></label></div><label>像素密度<input required type="number" min="0.5" max="4" step="0.25" value={draftDevice.deviceScaleFactor} onChange={event => setDraftDevice({ ...draftDevice, deviceScaleFactor: Number(event.target.value) })} /></label><button type="button" className="secondary-button" onClick={() => setDraftDevice({ ...draftDevice, width: draftDevice.height, height: draftDevice.width })}><Icon name="refresh" size={15} />旋转方向</button><div className="device-preview"><div style={{ aspectRatio: `${draftDevice.width || 1} / ${draftDevice.height || 1}` }}><Icon name={draftDevice.mode === 'tablet' ? 'tablet' : 'monitor'} size={28} /></div><span>{draftDevice.width} × {draftDevice.height} · {draftDevice.deviceScaleFactor}×</span></div><button className="primary-button" disabled={pending}>{state && draftDevice.mode !== state.device.mode ? '应用并刷新' : '应用配置'}</button></form> : <div className="diagnostics"><label className="overlay-toggle"><input type="checkbox" checked={overlay} onChange={event => setOverlay(event.target.checked)} /> 显示画面指标叠层</label><p className="panel-copy">来自当前连接的实时观测。未收到的数据显示为「—」。</p><div className="diagnostic-section"><h3>连接</h3><dl><dt>媒体连接</dt><dd>{diagnostics.connection}</dd><dt>输入通道</dt><dd>{diagnostics.channel}</dd><dt>往返延迟</dt><dd>{metric(diagnostics.roundTripTime === undefined ? undefined : diagnostics.roundTripTime * 1000, 'ms')}</dd><dt>视频编码</dt><dd>{diagnostics.codec ?? '—'}</dd></dl></div><div className="diagnostic-section"><h3>视频与布局</h3><dl><dt>显示 FPS</dt><dd>{metric(active?.webviewId ? diagnostics.paintFpsByView?.[active.webviewId] : undefined, 'fps')}</dd><dt>解码 FPS</dt><dd>{metric(diagnostics.decodedFramesPerSecond, 'fps')}</dd><dt>Marker 抽样</dt><dd>{metric(diagnostics.markerSampleHz, 'Hz', 1)}</dd><dt>已解码帧</dt><dd>{diagnostics.framesDecoded ?? '—'}</dd><dt>接收数据</dt><dd>{metric(diagnostics.bytesReceived === undefined ? undefined : diagnostics.bytesReceived / 1048576, 'MB', 2)}</dd><dt>视频尺寸</dt><dd>{diagnostics.videoWidth ? `${diagnostics.videoWidth} × ${diagnostics.videoHeight}` : '—'}</dd><dt>Atlas 代次</dt><dd>{transport.layout?.generation ?? '—'}</dd><dt>布局页面数</dt><dd>{transport.layout?.views.length ?? '—'}</dd></dl></div><ReceiveSettings transport={transport} connected={connected || connecting} /><MarkerTools transport={transport} viewId={active?.webviewId} /><details><summary>Endpoint 原始指标</summary><pre>{diagnostics.endpoint ? JSON.stringify(diagnostics.endpoint, null, 2) : '尚未收到指标'}</pre></details><details><summary>网络实验与候选</summary><pre>{JSON.stringify({ networkSimulation: diagnostics.networkSimulation, selectedCandidates: diagnostics.selectedCandidates }, null, 2)}</pre></details><details><summary>当前布局</summary><pre>{transport.layout ? JSON.stringify(transport.layout, null, 2) : '尚未收到布局'}</pre></details><button className="secondary-button" disabled={connecting || !state} onClick={() => void transport.connect()}><Icon name="refresh" size={15} />重新连接</button></div>}</aside>}
    </main><footer className="app-footer"><span>RemoteKit<span className="footer-separator">/</span>独立的远程浏览体验</span><span>控制与会话分离 · 页面由 Endpoint 运行</span></footer>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
