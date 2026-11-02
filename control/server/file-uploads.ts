import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Readable } from 'node:stream';
import { FILE_LIMITS, type FileRequest, type FileUploadBegin, type FileUploadResult, type UploadFileSpec } from '../shared/product';
import type { Endpoint } from './endpoint';

export type UploadLimits = FileRequest['limits'];
export interface FileBinding { browserIncarnation: string; view: string; instance: string; document: string; request: string }
export interface InternalFileRequest extends FileRequest { binding: FileBinding }
export class FileUploadError extends Error { constructor(readonly status: number, message: string) { super(message); } }
interface Entry {
  tenant: string; lease: string; authentication: string; request: InternalFileRequest;
  id: string; submitted: boolean; result?: FileUploadResult; draftAborted?: boolean; aborted?: Promise<void>;
  files: { ticket: string; path: string; size: number; state: 'pending' | 'writing' | 'complete'; stream?: Readable }[];
}
/** The Endpoint owns filesystem lifetime. Control owns authenticated streaming. */
export class FileUploads {
  private uploads = new Map<string, Entry>();
  private tickets = new Map<string, Entry>();
  constructor(private endpoint: Endpoint,
              private authorize: (tenant: string, lease: string, authentication: string) => void,
              private resolve: (tenant: string, request: string) => InternalFileRequest | undefined,
              readonly limits: UploadLimits = FILE_LIMITS) {}
  async begin(tenant: string, lease: string, authentication: string, params: any): Promise<FileUploadBegin> {
    this.authorize(tenant, lease, authentication);
    if (!params || typeof params.requestId !== 'string' || Object.keys(params).some(k => !['requestId','files'].includes(k))) throw new FileUploadError(400, '无效的文件请求');
    const request = this.resolve(tenant, params.requestId);
    if (!request || request.state !== 'pending') throw new FileUploadError(409, '文件选择请求已失效');
    const specs = this.validateSpecs(params.files, request.multiple);
    const previous = [...this.uploads.values()].find(entry => entry.tenant === tenant && entry.request.id === request.id && !entry.result && !entry.draftAborted);
    if (previous?.submitted) throw new FileUploadError(409, '文件正在确认，请继续等待');
    if (previous) await this.abort(previous);
    const allocated = await this.endpoint.request('session.files.begin', tenant, { binding: request.binding, files: specs });
    try {
      this.authorize(tenant, lease, authentication);
      if (!allocated || typeof allocated.uploadId !== 'string' || !Array.isArray(allocated.files) || allocated.files.length !== specs.length) throw new FileUploadError(502, '文件暂存未就绪');
      const files = allocated.files.map((file: any, index: number) => {
        if (typeof file.ticket !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(file.ticket) || typeof file.path !== 'string' || !isAbsolute(file.path)) throw new FileUploadError(502, '无效的文件暂存目标');
        return { ticket: file.ticket, path: file.path, size: specs[index].size, state: 'pending' as const };
      });
      if (new Set(files.map((file: { ticket: string }) => file.ticket)).size !== files.length) throw new FileUploadError(502, '文件ticket重复');
      const entry: Entry = { tenant, lease, authentication, request, id: allocated.uploadId, submitted: false, files };
      this.uploads.set(entry.id, entry); for (const file of files) this.tickets.set(file.ticket, entry);
      return { uploadId: entry.id, files: files.map((file: { ticket: string }) => ({ ticket: file.ticket, url: `/api/files/${encodeURIComponent(file.ticket)}` })) };
    } catch (error) { if (typeof allocated?.uploadId === 'string') await this.endpoint.request('session.files.cancel', tenant, { uploadId: allocated.uploadId }).catch(() => {}); throw error; }
  }
  private validateSpecs(value: unknown, multiple: boolean): UploadFileSpec[] {
    if (!Array.isArray(value) || !value.length || value.length > this.limits.maxFiles || !multiple && value.length !== 1) throw new FileUploadError(400, '文件数量超出页面限制');
    let bytes = 0;
    return value.map(file => {
      if (!file || typeof file !== 'object' || Object.keys(file).some(k => !['name','size','type'].includes(k)) || typeof file.name !== 'string' || !file.name || file.name.length > 255 || /[\x00-\x1f/\\:]/.test(file.name) || file.name === '.' || file.name === '..' || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.type !== 'string' || file.type.length > 255 || /[\x00-\x1f\x7f]/.test(file.type)) throw new FileUploadError(400, '无效的文件信息');
      bytes += file.size;
      if (file.size > this.limits.maxFileBytes || bytes > this.limits.maxBatchBytes) throw new FileUploadError(413, '文件大小超过限制');
      return { name: file.name, size: file.size, type: file.type };
    });
  }
  async stream(tenant: string, authentication: string, ticket: string, source: Readable, contentLength?: string): Promise<void> {
    const entry = this.tickets.get(ticket), file = entry?.files.find(item => item.ticket === ticket);
    if (!entry || !file || entry.tenant !== tenant || entry.authentication !== authentication) throw new FileUploadError(404, '文件ticket不存在');
    this.authorize(entry.tenant, entry.lease, entry.authentication);
    if (entry.submitted || file.state !== 'pending') throw new FileUploadError(409, '文件ticket已使用');
    if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) !== file.size)) { await this.abort(entry); throw new FileUploadError(413, '文件长度不符'); }
    file.state = 'writing'; file.stream = source;
    const ignoreStreamError = () => {}; source.on('error', ignoreStreamError);
    let handle: Awaited<ReturnType<typeof open>> | undefined, bytes = 0;
    try {
      handle = await open(file.path, 'r+'); const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== 0) throw new FileUploadError(409, '文件暂存状态已改变');
      for await (const chunk of source) {
        this.authorize(entry.tenant, entry.lease, entry.authentication);
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > file.size || bytes > this.limits.maxFileBytes) throw new FileUploadError(413, '文件大小超过限制');
        await handle.writeFile(buffer);
      }
      this.authorize(entry.tenant, entry.lease, entry.authentication);
      if (bytes !== file.size) throw new FileUploadError(400, '文件传输不完整');
      await handle.close(); handle = undefined; file.state = 'complete';
    } catch (error) { await handle?.close().catch(() => {}); await this.abort(entry); throw error; }
    finally { file.stream = undefined; source.off('error', ignoreStreamError); }
  }
  private owned(tenant: string, lease: string, authentication: string, id: unknown) {
    this.authorize(tenant, lease, authentication);
    const entry = typeof id === 'string' ? this.uploads.get(id) : undefined;
    if (!entry || entry.tenant !== tenant || entry.lease !== lease || entry.authentication !== authentication) throw new FileUploadError(404, '文件发送记录不存在');
    return entry;
  }
  async commit(tenant: string, lease: string, authentication: string, params: any): Promise<FileUploadResult> {
    if (!params || Object.keys(params).some(k => k !== 'uploadId')) throw new FileUploadError(400, '无效的文件提交');
    const entry = this.owned(tenant, lease, authentication, params.uploadId);
    if (entry.result) return entry.result;
    if (entry.draftAborted) throw new FileUploadError(409, '文件发送已中止，请重新选择');
    if (!entry.submitted && entry.files.some(file => file.state !== 'complete')) throw new FileUploadError(409, '文件尚未发送完成');
    // Once submission may have reached Browser, failures are uncertain. Query
    // this same opaque batch again, never replay a fresh chooser reply.
    entry.submitted = true;
    const result = await this.endpoint.request('session.files.commit', tenant, { uploadId: entry.id, binding: entry.request.binding });
    this.authorize(tenant, lease, authentication);
    return this.result(entry, result);
  }
  private result(entry: Entry, value: any): FileUploadResult {
    if (value?.state === 'selected' || value?.selected === true) { entry.result = { state: 'selected' }; this.removeTickets(entry); return entry.result; }
    if (value?.state === 'cancelled') { entry.result = { state: 'cancelled' }; this.removeTickets(entry); return entry.result; }
    return { state: 'validating' };
  }
  async cancel(tenant: string, lease: string, authentication: string, params: any): Promise<FileUploadResult> {
    this.authorize(tenant, lease, authentication);
    if (!params || typeof params.requestId !== 'string' || Object.keys(params).some(k => !['requestId','uploadId'].includes(k))) throw new FileUploadError(400, '无效的文件取消');
    const request = this.resolve(tenant, params.requestId);
    const entry = params.uploadId !== undefined ? this.owned(tenant, lease, authentication, params.uploadId) : [...this.uploads.values()].find(item => item.tenant === tenant && item.lease === lease && item.request.id === params.requestId);
    if (entry && entry.request.id !== params.requestId) throw new FileUploadError(409, '文件请求不匹配');
    if (entry?.result) return entry.result;
    if (!request && !entry) throw new FileUploadError(409, '文件选择请求已失效');
    // A failed HTTP stream may already have retired its Endpoint batch. Keep
    // its authenticated binding receipt and cancel the chooser by that identity.
    if (entry && !entry.submitted) await this.abort(entry);
    if (entry) for (const file of entry.files) file.stream?.destroy(new FileUploadError(409, '发送已取消'));
    const result = await this.endpoint.request('session.files.cancel', tenant, { ...(entry && !entry.draftAborted ? { uploadId: entry.id } : {}), binding: (request ?? entry!.request).binding, cancelRequest: true });
    if (entry) return this.result(entry, result);
    return result?.state === 'selected' ? { state: 'selected' } : result?.state === 'cancelled' ? { state: 'cancelled' } : { state: 'validating' };
  }
  private removeTickets(entry: Entry) { for (const file of entry.files) this.tickets.delete(file.ticket); }
  private abort(entry: Entry): Promise<void> {
    this.removeTickets(entry);
    for (const file of entry.files) file.stream?.destroy();
    if (entry.submitted) return Promise.resolve();
    // Retain a bounded, lease/auth-bound receipt: transport failure does not
    // mean the native file chooser was cancelled.
    entry.draftAborted = true;
    if (!entry.aborted) {
      entry.aborted = this.endpoint.request('session.files.cancel', entry.tenant, { uploadId: entry.id }).then(() => {}, () => {
        entry.aborted = undefined; // A later cancel/retry must retry cleanup.
      });
      const retired = [...this.uploads.values()].filter(item => item.tenant === entry.tenant && (item.draftAborted || item.result));
      for (const old of retired.slice(0, Math.max(0, retired.length - 64))) this.uploads.delete(old.id);
    }
    return entry.aborted ?? Promise.resolve();
  }
  async revoke(tenant: string, lease: string) {
    for (const entry of [...this.uploads.values()]) if (entry.tenant === tenant && entry.lease === lease) { await this.abort(entry); this.uploads.delete(entry.id); }
    // Called on Control's Tenant serial queue, before a replacement Viewer can
    // begin uploads. Also clears allocations whose begin reply was lost.
    await this.endpoint.request('session.files.revoke', tenant).catch(() => {});
  }
  retireMissing(tenant: string, valid: Set<string>) {
    for (const entry of [...this.uploads.values()]) if (entry.tenant === tenant && !valid.has(entry.request.id)) {
      // Submitted records retain a bounded final receipt for idempotent commit;
      // storage lifetime remains Endpoint/Browser-owned.
      if (!entry.submitted) void this.abort(entry);
    }
    const retired = [...this.uploads.values()].filter(entry => entry.tenant === tenant && (entry.result || entry.submitted && !valid.has(entry.request.id)));
    for (const entry of retired.slice(0, Math.max(0, retired.length - 64))) { this.removeTickets(entry); this.uploads.delete(entry.id); }
  }
}
