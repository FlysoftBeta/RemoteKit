import type { FileUploadResult } from '../shared/product';
import type { Asset, SelectionState } from '../shared/file-library';
import type { DcFileBegin, FileRpc } from './file-upload';
import { operationId } from './product-operations';

export interface PhotoRank {
  selectedAssetId: string;
  uncertain: boolean;
  candidates: { assetId: string; score: number }[];
  reason: string;
}

export interface PhotoBurstDecision {
  selectedFrameId: string;
  keepFrameIds: string[];
  candidates: { frameId: string; score: number }[];
  uncertain: boolean;
  stop: boolean;
  reason: string;
}

export class PhotoBurstBackpressureError extends Error {}

const libraryBinding = { requestId: 'library' };
const maxBufferedBytes = 64 * 1024;
const chunkBytes = 16 * 1024;

type Binding = { channel: RTCDataChannel | null; authEpoch: number | undefined };
type RequestOptions = {
  binding?: Binding;
  signal?: AbortSignal;
  skipWhenBusy?: boolean;
  finishSentRequest?: boolean;
};

function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
}

/** File bytes and transaction commands share the current authenticated RTC peer.
 * A new peer interrupts the transfer; drafts are never silently resumed there. */
export class DcFileClient implements FileRpc {
  private pending = new Map<
    string,
    Binding & { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  private uploads = new Map<string, { requestId: string; channel: RTCDataChannel }>();
  private photoBursts = new Map<string, Binding>();
  private assetChunksInFlight = 0;
  constructor(
    private readonly getChannel: () => RTCDataChannel | null,
    private readonly getAuthEpoch = (): number | undefined => undefined,
  ) {}
  handle(message: any): boolean {
    if (message?.type !== 'files.result') return false;
    if (message.version !== 1 || typeof message.requestId !== 'string') return true;
    const entry = this.pending.get(message.requestId);
    if (!entry || entry.channel !== this.getChannel() || entry.authEpoch !== this.getAuthEpoch()) return true;
    if (message.ok === true) entry.resolve(message.result);
    else entry.reject(new Error(typeof message.error === 'string' ? message.error : '文件发送失败'));
    return true;
  }
  disconnect() {
    for (const entry of this.pending.values()) entry.reject(new Error('连接中断，请重新选择文件'));
    this.uploads.clear();
    this.photoBursts.clear();
  }
  private currentBinding(): Binding {
    return { channel: this.getChannel(), authEpoch: this.getAuthEpoch() };
  }
  private checkBinding({ channel, authEpoch }: Binding, signal?: AbortSignal) {
    if (signal) checkAbort(signal);
    if (
      channel !== this.getChannel() ||
      authEpoch !== this.getAuthEpoch() ||
      channel?.readyState !== 'open'
    ) {
      throw new Error('连接中断，请重新选择文件');
    }
    return channel;
  }
  private request<T>(
    method: string,
    params: Record<string, unknown>,
    options: RequestOptions = {},
  ): { response: Promise<T> } {
    const binding = options.binding ?? this.currentBinding();
    const channel = this.checkBinding(binding, options.signal);
    const { authEpoch } = binding;
    if (this.pending.size >= 8 || channel.bufferedAmount > maxBufferedBytes) {
      if (options.skipWhenBusy) throw new PhotoBurstBackpressureError();
      if (this.pending.size >= 8) throw new Error('文件发送繁忙，请稍后重试');
      throw new Error('文件发送暂时拥塞，请重试');
    }
    const requestId = operationId();
    const encoded = JSON.stringify({
      type: 'files.request',
      version: 1,
      requestId,
      method,
      params,
      authEpoch,
    });
    // Wire byte bound includes multibyte filenames and MIME strings.
    if (
      new TextEncoder().encode(encoded).byteLength >
      (method === 'begin' || method === 'photo.burst.sample' ? 61440 : 24576)
    )
      throw new Error('文件信息过长，请减少文件数量');
    const signal = options.finishSentRequest ? undefined : options.signal;
    const response = new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        signal?.removeEventListener('abort', abort);
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const abort = () => fail(new DOMException('Aborted', 'AbortError'));
      const timer = setTimeout(() => fail(new Error('文件确认超时，请重试确认')), 20000);
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(requestId, {
        channel,
        authEpoch,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: fail,
      });
      try {
        channel.send(encoded);
      } catch {
        fail(new Error('连接中断，请重新选择文件'));
      }
    });
    return { response };
  }
  private async send<T>(
    method: string,
    params: Record<string, unknown>,
    options: RequestOptions = {},
  ): Promise<{ response: Promise<T> }> {
    const binding = options.binding ?? this.currentBinding();
    const deadline = performance.now() + 15000;
    // Leave headroom for input/layout without taking over bufferedamountlow.
    while (!options.skipWhenBusy && (binding.channel?.bufferedAmount ?? 0) > maxBufferedBytes) {
      this.checkBinding(binding, options.signal);
      if (performance.now() > deadline) throw new Error('文件发送暂时拥塞，请重试');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const sent = this.request<T>(method, params, { ...options, binding });
    // Callers can retain the response while sending subsequent ordered chunks.
    void sent.response.catch(() => {});
    return sent;
  }
  private async call<T>(
    method: string,
    params: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<T> {
    return (await this.send<T>(method, params, options)).response;
  }
  async begin(requestId: string, files: File[]): Promise<DcFileBegin> {
    const channel = this.getChannel();
    const authEpoch = this.getAuthEpoch();
    const result = await this.call<DcFileBegin>('begin', {
      requestId,
      files: files.map((file) => ({ name: file.name, type: file.type, size: file.size })),
    });
    if (
      !result ||
      typeof result.uploadId !== 'string' ||
      !Array.isArray(result.offsets) ||
      result.offsets.length !== files.length ||
      result.offsets.some(
        (offset, index) => !Number.isSafeInteger(offset) || offset < 0 || offset > files[index].size,
      )
    )
      throw new Error('文件发送状态无效');
    if (channel !== this.getChannel() || authEpoch !== this.getAuthEpoch() || !channel)
      throw new Error('连接中断，请重新选择文件');
    this.uploads.set(result.uploadId, { requestId, channel });
    return result;
  }
  private binding(uploadId: string) {
    const value = this.uploads.get(uploadId);
    if (!value || value.channel !== this.getChannel()) throw new Error('文件发送已中断，请取消后重新选择');
    return { requestId: value.requestId, uploadId };
  }
  async upload(
    uploadId: string,
    fileIndex: number,
    file: File,
    offset: number,
    signal: AbortSignal,
    progress: (bytes: number) => void,
  ) {
    const binding = this.binding(uploadId);
    const authEpoch = this.getAuthEpoch();
    // One chunk per file is in flight. This also preserves sequential disk
    // offsets; the protocol admits up to four concurrent chunks per client.
    for (let position = offset; position < file.size;) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const bytes = new Uint8Array(await file.slice(position, position + 16384).arrayBuffer());
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (authEpoch !== this.getAuthEpoch() || !this.uploads.has(uploadId))
        throw new Error('连接中断，请重新选择文件');
      let text = '';
      for (const byte of bytes) text += String.fromCharCode(byte);
      const result = await this.call<{ offset: number }>('chunk', {
        ...binding,
        fileIndex,
        offset: position,
        data: btoa(text),
      });
      if (result.offset !== position + bytes.length) throw new Error('文件接收进度不一致，请重试');
      position = result.offset;
      progress(position);
    }
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    progress(file.size);
  }
  async commit(uploadId: string): Promise<FileUploadResult> {
    const result = await this.call<FileUploadResult>('commit', this.binding(uploadId));
    if (result.state === 'selected' || result.state === 'cancelled') this.uploads.delete(uploadId);
    return result;
  }
  async status(uploadId: string): Promise<{ state: string; offsets: number[] }> {
    return this.call('status', this.binding(uploadId));
  }
  async cancel(requestId: string, uploadId?: string): Promise<FileUploadResult> {
    // Binding cancellation works after a lost begin reply or reconnection;
    // an old uploadId must not claim another peer's draft.
    const owned = uploadId ? this.uploads.get(uploadId) : undefined;
    const result = await this.call<FileUploadResult>('cancel', {
      requestId,
      ...(owned?.channel === this.getChannel() ? { uploadId } : {}),
    });
    if (result.state !== 'validating' && uploadId) this.uploads.delete(uploadId);
    return result;
  }
  async uploadAsset(file: File, operationId: string, signal: AbortSignal): Promise<Asset> {
    const binding = this.currentBinding();
    const check = () => this.checkBinding(binding, signal);
    check();
    const { uploadId, offset } = await this.call<{ uploadId: string; offset: number }>(
      'asset.begin',
      {
        ...libraryBinding,
        operationId,
        name: file.name,
        type: file.type,
        size: file.size,
      },
      { binding },
    );
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException('Aborted', 'AbortError'));
    });
    void aborted.catch(() => {});
    signal.addEventListener('abort', abort, { once: true });
    try {
      check();
      if (typeof uploadId !== 'string' || !Number.isSafeInteger(offset) || offset < 0 || offset > file.size)
        throw new Error('文件发送状态无效');
      const window: Promise<void>[] = [];
      for (let position = offset; position < file.size;) {
        if (window.length === 4) await Promise.race([window.shift(), aborted]);
        check();
        const bytes = new Uint8Array(await file.slice(position, position + chunkBytes).arrayBuffer());
        check();
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        while (this.assetChunksInFlight >= 4) {
          check();
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const next = position + bytes.length;
        this.assetChunksInFlight++;
        let response: Promise<{ offset: number }>;
        try {
          ({ response } = await this.send<{ offset: number }>(
            'asset.chunk',
            {
              ...libraryBinding,
              uploadId,
              offset: position,
              data: btoa(binary),
            },
            { binding, signal, finishSentRequest: true },
          ));
        } catch (error) {
          this.assetChunksInFlight--;
          throw error;
        }
        const ack = response
          .then((result) => {
            if (result?.offset !== next) throw new Error('文件接收进度不一致');
          })
          .finally(() => {
            this.assetChunksInFlight--;
          });
        void ack.catch(() => {});
        window.push(ack);
        position = next;
      }
      await Promise.race([Promise.all(window), aborted]);
      check();
      const asset = await this.call<Asset>(
        'asset.seal',
        { ...libraryBinding, uploadId },
        { binding, signal },
      );
      check();
      return asset;
    } catch (error) {
      if (signal.aborted && typeof uploadId === 'string') {
        void this.call('asset.cancel', { ...libraryBinding, uploadId }, { binding }).catch(() => {});
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  async readPhoto(asset: Asset, signal: AbortSignal): Promise<Blob> {
    const binding = this.currentBinding();
    const parts: Uint8Array<ArrayBuffer>[] = [];
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 64 * 1024 * 1024)
      throw new Error('照片预览大小超出限制');
    for (let offset = 0; offset < asset.size;) {
      const part = await this.call<{ data: string; offset: number; total: number }>(
        'asset.read',
        {
          ...libraryBinding,
          assetId: asset.assetId,
          offset,
        },
        { binding, signal },
      );
      const binary = atob(part.data);
      if (
        !binary.length ||
        binary.length > 16384 ||
        part.offset !== offset + binary.length ||
        part.total !== asset.size ||
        part.offset > part.total
      )
        throw new Error('照片预览数据无效');
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      parts.push(bytes);
      offset = part.offset;
    }
    this.checkBinding(binding, signal);
    return new Blob(parts, { type: asset.type });
  }
  async describeAsset(assetId: string, signal: AbortSignal): Promise<Asset> {
    const binding = this.currentBinding();
    const asset = await this.call<Asset>(
      'asset.describe',
      { ...libraryBinding, assetId },
      { binding, signal },
    );
    this.checkBinding(binding, signal);
    if (
      !asset ||
      asset.assetId !== assetId ||
      typeof asset.hash !== 'string' ||
      !asset.hash ||
      typeof asset.type !== 'string' ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 0
    ) {
      throw new Error('文件信息无效');
    }
    return asset;
  }
  async beginPhotoBurst(signal: AbortSignal): Promise<{ burstId: string }> {
    const binding = this.currentBinding();
    const result = await this.call<{ burstId: string }>('photo.burst.begin', libraryBinding, {
      binding,
      signal,
      finishSentRequest: true,
    });
    this.checkBinding(binding);
    if (typeof result?.burstId !== 'string' || !result.burstId) throw new Error('拍照会话无效');
    this.photoBursts.set(result.burstId, binding);
    if (signal.aborted) {
      void this.cancelPhotoBurst(result.burstId).catch(() => {});
      checkAbort(signal);
    }
    return result;
  }
  canSamplePhotoBurst(): boolean {
    const channel = this.getChannel();
    return (
      channel?.readyState === 'open' && channel.bufferedAmount <= maxBufferedBytes && this.pending.size < 8
    );
  }
  async samplePhotoBurst(
    burstId: string,
    frameId: string,
    blob: Blob,
    availableFrameIds: string[],
    signal: AbortSignal,
  ): Promise<PhotoBurstDecision> {
    const binding = this.photoBursts.get(burstId);
    if (!binding) throw new Error('拍照会话已结束');
    this.checkBinding(binding, signal);
    if (blob.type !== 'image/jpeg' || !blob.size || blob.size > 44 * 1024)
      throw new Error('拍照分析图大小或格式无效');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return this.call(
      'photo.burst.sample',
      {
        ...libraryBinding,
        burstId,
        frameId,
        data: btoa(binary),
        availableFrameIds,
      },
      { binding, signal, skipWhenBusy: true },
    );
  }
  async endPhotoBurst(
    burstId: string,
    availableFrameIds: string[],
    signal: AbortSignal,
  ): Promise<PhotoBurstDecision> {
    const binding = this.photoBursts.get(burstId);
    if (!binding) throw new Error('拍照会话已结束');
    const decision = await this.call<PhotoBurstDecision>(
      'photo.burst.end',
      {
        ...libraryBinding,
        burstId,
        availableFrameIds,
      },
      { binding, signal },
    );
    this.photoBursts.delete(burstId);
    return decision;
  }
  async cancelPhotoBurst(burstId: string): Promise<void> {
    const binding = this.photoBursts.get(burstId);
    if (!binding) return;
    this.photoBursts.delete(burstId);
    await this.call('photo.burst.cancel', { ...libraryBinding, burstId }, { binding });
  }
  rankPhotos(assetIds: string[]): Promise<PhotoRank> {
    return this.call('photo.rank', { ...libraryBinding, assetIds });
  }
  async photoThumbnail(assetId: string, signal: AbortSignal): Promise<Blob> {
    const binding = this.currentBinding();
    const asset = await this.call<Asset>(
      'photo.thumbnail',
      { ...libraryBinding, assetId },
      { binding, signal },
    );
    this.checkBinding(binding, signal);
    if (
      asset.type !== 'image/jpeg' ||
      asset.size > 65536 ||
      (asset.width ?? 0) > 320 ||
      (asset.height ?? 0) > 320
    )
      throw new Error('照片缩略图数据无效');
    return this.readPhoto(asset, signal);
  }
  processPhoto(assetId: string, mode: 'rectify' | 'scan', signal?: AbortSignal): Promise<Asset> {
    return this.call('photo.process', { ...libraryBinding, assetId, mode }, { signal });
  }
  commitSelection(
    requestId: string,
    selectionId: string,
  ): Promise<{ state: SelectionState; selectionId: string }> {
    return this.call('selection.commit', { requestId, selectionId });
  }
}
