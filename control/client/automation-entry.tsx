import { useEffect, useState } from 'react';
import { MarkerMeasurement } from './marker';
import { createRoot } from 'react-dom/client';
import { RemoteTransport } from './transport';
import { RemoteViewport } from './remote-viewport';
import { request, type ControlState } from './types';
import type { ReceiveProfile } from './receive-profile';
import './automation.css';

/** Explicit per-run settings. No browser persistence or product quality policy. */
export interface AutomationConfiguration {
  receiveProfile?: ReceiveProfile;
}

export function mountAutomation(element: HTMLElement, options: { diagnostics?: boolean } = {}) {
  const transport = new RemoteTransport();
  transport.enableDiagnosticHttp();
  const root = createRoot(element);
  let current: ControlState | undefined;
  const listeners = new Set<() => void>();
  let read: Promise<ControlState> | undefined;
  const refresh = (): Promise<ControlState> => {
    if (read) return read;
    read = request<ControlState>('/api/state').then(state => {
      current = state;
      transport.selectedViewId = state.tabs.find(tab => tab.id === state.activeTabId)?.webviewId ?? undefined;
      transport.observeEndpointGeneration(state.endpointGeneration);
      listeners.forEach(listener => listener());
      return state;
    }).finally(() => { read = undefined; });
    return read;
  };
  const configure = (configuration: AutomationConfiguration) => {
    if ('callbackRegistration' in configuration) throw new Error('callbackRegistration is archived; video uses after-work');
    if (transport.diagnostics.connection !== '未连接') throw new Error('请先断开媒体连接再设置实验配置');
    if (configuration.receiveProfile !== undefined) transport.receiveProfile = configuration.receiveProfile;
  };
  const action = async (body: Record<string, unknown>) => {
    const state = await request<ControlState>('/api/actions', body);
    // A previously started poll must finish before publishing this newer state.
    await read?.catch(() => {});
    current = state;
    transport.selectedViewId = state.tabs.find(tab => tab.id === state.activeTabId)?.webviewId ?? undefined;
    listeners.forEach(listener => listener());
    return state;
  };
  const api = { transport, MarkerMeasurement, configure, refresh, action, get state() { return current; }, automaticQualityPolicy: false as const };
  // Kept for existing marker/profile drivers, confined to explicit test routes.
  Object.assign(window, { remotekitDiagnostics: api });
  function Harness() {
    const [, render] = useState(0);
    const [error, setError] = useState('');
    useEffect(() => {
      const changed = () => render(value => value + 1);
      listeners.add(changed);
      const unsubscribe = transport.subscribe(changed);
      const poll = () => void refresh().then(() => setError(''), error => setError(String(error)));
      poll();
      const timer = setInterval(poll, 1000);
      return () => { clearInterval(timer); listeners.delete(changed); unsubscribe(); transport.disconnect(); };
    }, []);
    const visible = current?.tabs.filter(tab => tab.id === current?.activeTabId || tab.id === current?.splitTabId) ?? [];
    return <div className="automation-shell">
      {error && <p role="alert">{error}</p>}
      <main className="automation-views">{visible.map(tab => tab.webviewId && <RemoteViewport key={tab.id} transport={transport} viewId={tab.webviewId} overlay={options.diagnostics} />)}</main>
      {options.diagnostics && <aside className="automation-diagnostics">
        <h1>RemoteKit 诊断</h1><p>实验配置仅作用于当前页面；自动画质策略关闭。</p>
        <pre>{JSON.stringify({ state: current, media: transport.diagnostics, presentation: transport.presentationDiagnostics }, null, 2)}</pre>
      </aside>}
    </div>;
  }
  root.render(<Harness />);
  return () => { root.unmount(); transport.disconnect(); if ((window as unknown as { remotekitDiagnostics?: unknown }).remotekitDiagnostics === api) Reflect.deleteProperty(window, 'remotekitDiagnostics'); };
}
