import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { RemoteKitError } from '../../shared/errors';
import type { EndpointLink, EndpointLinkState } from './link';
import { readyTransition } from './link';
import type { ClientActionEvent, RtcSignal } from './types';
export class LocalProcessLink extends EventEmitter implements EndpointLink {
  state: EndpointLinkState = { state: 'offline' };
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }
  >();
  private stopped = false;
  private retry?: NodeJS.Timeout;
  constructor(
    private command: string,
    private args: string[] = [],
  ) {
    super();
  }
  onClientAction(listener: (event: ClientActionEvent) => void) {
    this.on('client.action', listener);
    return () => {
      this.off('client.action', listener);
    };
  }
  onSignal(listener: (event: RtcSignal) => void) {
    this.on('rtc.signal', listener);
    return () => this.off('rtc.signal', listener);
  }
  start() {
    if (this.child || this.stopped) return;
    this.state = { state: 'connecting' };
    const child = spawn(this.command, this.args, {
      windowsHide: true,
      stdio: 'pipe',
    });
    this.child = child;
    let buffer = '';
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) {
        child.kill();
        return;
      }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const response = JSON.parse(line);
          if (response.event === 'client.action') {
            this.emit('client.action', response);
            continue;
          }
          if (response.event === 'rtc.signal') {
            this.emit('rtc.signal', response);
            continue;
          }
          const entry = this.pending.get(response.id);
          if (!entry) continue;
          clearTimeout(entry.timer);
          this.pending.delete(response.id);
          if (response.ok) entry.resolve(response.result);
          else entry.reject(response.error ?? { code: 'rejected', message: 'Endpoint 操作失败' });
        } catch {
          child.kill();
          return;
        }
      }
    });
    let finished = false;
    const failed = (reason: unknown) => {
      if (finished) return;
      finished = true;
      if (this.child === child) this.child = undefined;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new RemoteKitError('outcome_unknown', 'Endpoint 连接已断开', String(reason)));
      }
      this.pending.clear();
      this.state = { state: 'offline' };
      this.emit('offline');
      if (!this.stopped) this.retry = setTimeout(() => this.start(), 1500);
    };
    child.on('error', (error) => failed(error.message));
    child.on('exit', (code) => failed(`exit ${code}`));
    child.once('spawn', () => {
      const transition = readyTransition(undefined, randomUUID(), randomUUID());
      this.state = transition.state;
      this.emit('ready', transition);
    });
  }
  request(method: string, tenantId: string, args: Record<string, unknown> = {}): Promise<any> {
    const child = this.child;
    if (this.state.state !== 'ready' || !child || !child.pid || !child.stdin.writable)
      return Promise.reject(new RemoteKitError('unavailable', 'Endpoint 尚未就绪'));
    const id = randomUUID();
    const line = JSON.stringify({ ...args, id, method, tenantId }) + '\n';
    if (Buffer.byteLength(line) > 1024 * 1024)
      return Promise.reject(new RemoteKitError('limit_exceeded', 'Endpoint 请求过大'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RemoteKitError('outcome_unknown', 'Endpoint 请求超时', method));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(line, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new RemoteKitError('outcome_unknown', 'Endpoint 写入失败', error.message));
        }
      });
    });
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    const child = this.child;
    if (!child) return;
    const timer = setTimeout(() => child.kill(), 3000);
    try {
      await this.request('shutdown', '');
    } catch {
      child.kill();
    }
    clearTimeout(timer);
    child.stdin.end();
    child.kill();
  }
}
