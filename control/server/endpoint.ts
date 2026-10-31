import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export interface Endpoint { request(method: string, tenantId: string, args?: Record<string, unknown>): Promise<any> }
export class EndpointProcess extends EventEmitter implements Endpoint {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private stopped = false;
  private retry?: NodeJS.Timeout;
  constructor(private command: string, private args: string[] = [], private diagnosticLoopback = false) { super(); }
  start() {
    if (this.child || this.stopped) return;
    const child = spawn(this.command, this.args, { windowsHide: true, stdio: 'pipe', env: this.diagnosticLoopback ? { ...process.env, REMOTEKIT_RTC_LOOPBACK_TEST: '1' } : undefined });
    this.child = child;
    let buffer = '';
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) { child.kill(); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const response = JSON.parse(line); const entry = this.pending.get(response.id);
          if (!entry) continue;
          clearTimeout(entry.timer); this.pending.delete(response.id);
          if (response.ok) entry.resolve(response.result);
          else entry.reject(new Error(typeof response.error === 'string' ? response.error : response.error?.message ?? 'Endpoint 操作失败'));
        } catch { child.kill(); return; }
      }
    });
    let finished = false;
    const failed = (reason: unknown) => {
      if (finished) return; finished = true;
      if (this.child === child) this.child = undefined;
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`Endpoint 不可用: ${reason}`)); }
      this.pending.clear(); this.emit('offline');
      if (!this.stopped) this.retry = setTimeout(() => this.start(), 1500);
    };
    child.on('error', error => failed(error.message)); child.on('exit', code => failed(`exit ${code}`));
    child.once('spawn', () => this.emit('ready'));
  }
  request(method: string, tenantId: string, args: Record<string, unknown> = {}): Promise<any> {
    const child = this.child;
    if (!child || !child.pid || !child.stdin.writable) return Promise.reject(new Error('Endpoint 尚未就绪'));
    const id = randomUUID(); const line = JSON.stringify({ ...args, id, method, tenantId }) + '\n';
    if (Buffer.byteLength(line) > 1024 * 1024) return Promise.reject(new Error('Endpoint 请求过大'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Endpoint ${method} 超时`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(line, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  async stop() {
    this.stopped = true; clearTimeout(this.retry);
    const child = this.child;
    if (!child) return;
    const timer = setTimeout(() => child.kill(), 3000);
    try { await this.request('shutdown', ''); } catch { child.kill(); }
    clearTimeout(timer); child.stdin.end(); child.kill();
  }
}
