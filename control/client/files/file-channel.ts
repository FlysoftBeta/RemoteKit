import { RetryUnit } from '../../shared/retry-unit';
import { isDocumentOpenParams } from '../../../protocol/file_requests';
import { RemoteKitError, nativeError } from '../../shared/errors';
import type { Asset, AssetDescription, SelectionState } from '../../shared/file-library';
import { operationId } from '../control/product-operations';
import type { DocumentInfo } from '../documents/document-source';
import { diagnostics } from '../media/diagnostics';
import type { FileMethod, Incoming } from '../rtc/protocol';
import { RequestTracker } from '../util/request-tracker';

export interface ProcessedPhoto extends Asset {
  type: 'image/webp';
  geometry: 'perspective' | 'deskew' | 'unchanged';
  quarterTurns: 0 | 1 | 2 | 3;
  orientation: 'text' | 'manual' | 'none';
}

export interface PhotoBurstDecision {
  selectedFrameId: string;
  keepFrameIds: string[];
  candidates: { frameId: string; score: number }[];
  uncertain: boolean;
  stop: boolean;
  reason: string;
}

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
  if (signal.aborted) throw new RemoteKitError('canceled', '');
}

/** File bytes and transaction commands share the current authenticated RTC peer.
 * A new peer interrupts the transfer; drafts are never silently resumed there. */
export class FileChannel {
  private readonly pending = new RequestTracker<unknown>();
  private binding?: Binding;
  private scope = new AbortController();
  private photoBursts = new Map<string, Binding>();
  private assetChunksInFlight = 0;
  constructor(
    private readonly getChannel: () => RTCDataChannel | null,
    private readonly getAuthEpoch = (): number | undefined => undefined,
    private readonly role: 'objects' | 'page' = 'objects',
  ) {}
  handle(message: Incoming): boolean {
    if (message.type !== 'files.result') return false;
    this.syncScope();
    if (message.ok) this.pending.resolve(message.requestId, message.result);
    else this.pending.reject(message.requestId, nativeError(message.error));
    return true;
  }
  disconnect() {
    this.scope.abort();
    this.scope = new AbortController();
    this.pending.clear();
    this.photoBursts.clear();
  }
  private syncScope() {
    const binding = this.currentBinding();
    if (binding.channel !== this.binding?.channel || binding.authEpoch !== this.binding?.authEpoch) {
      this.scope.abort();
      this.scope = new AbortController();
      this.binding = binding;
      this.pending.setScope(binding);
    }
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
      throw new RemoteKitError('unavailable', '连接中断，请重新选择文件');
    }
    return channel;
  }
  private bindingCurrent({ channel, authEpoch }: Binding) {
    return (
      channel === this.getChannel() && authEpoch === this.getAuthEpoch() && channel?.readyState === 'open'
    );
  }
  private request<T>(
    method: FileMethod,
    params: Record<string, unknown>,
    options: RequestOptions = {},
  ): { response: Promise<T> } {
    const native = method === 'selection.commit' || method === 'selection.cancel';
    if (native !== (this.role === 'page')) throw new RemoteKitError('invalid_request', '文件操作通道错误');
    this.syncScope();
    const binding = options.binding ?? this.currentBinding();
    const channel = this.checkBinding(binding, options.signal);
    const { authEpoch } = binding;
    if (this.pending.size >= 8 || channel.bufferedAmount > maxBufferedBytes) {
      if (options.skipWhenBusy) throw new RemoteKitError('busy', '照片分析通道繁忙');
      if (this.pending.size >= 8) throw new RemoteKitError('busy', '文件发送繁忙，请稍后重试');
      throw new RemoteKitError('busy', '文件发送暂时拥塞，请重试');
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
    if (new TextEncoder().encode(encoded).byteLength > (method === 'photo.burst.sample' ? 61440 : 24576))
      throw new RemoteKitError('limit_exceeded', '文件信息过长，请减少文件数量', { capacity: 'selection' });
    const signal = options.finishSentRequest ? undefined : options.signal;
    const response = this.pending.request(
      requestId,
      20000,
      () => channel.send(encoded),
      signal,
    ) as Promise<T>;
    return { response };
  }
  private async send<T>(
    method: FileMethod,
    params: Record<string, unknown>,
    options: RequestOptions = {},
  ): Promise<{ response: Promise<T> }> {
    const binding = options.binding ?? this.currentBinding();
    const deadline = performance.now() + 15000;
    // Leave headroom for input/layout without taking over bufferedamountlow.
    while (!options.skipWhenBusy && (binding.channel?.bufferedAmount ?? 0) > maxBufferedBytes) {
      this.checkBinding(binding, options.signal);
      if (performance.now() > deadline) throw new RemoteKitError('busy', '文件发送暂时拥塞，请重试');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const sent = this.request<T>(method, params, { ...options, binding });
    // Callers can retain the response while sending subsequent ordered chunks.
    void sent.response.catch(() => {
      /* error-guard: pipelined-response; the caller awaits the original response after its ordered sends. */
    });
    return sent;
  }
  private async call<T>(
    method: FileMethod,
    params: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<T> {
    this.syncScope();
    const scope = this.scope.signal;
    const binding = options?.binding ?? this.currentBinding();
    this.checkBinding(binding, options?.signal);
    options = {
      ...options,
      binding,
      signal: AbortSignal.any([scope, ...(options?.signal ? [options.signal] : [])]),
    };
    const unit = new RetryUnit({ name: 'file_request' });
    const repeatable =
      ['asset.describe', 'asset.read', 'document.page', 'document.resource', 'photo.thumbnail'].includes(
        method,
      ) ||
      typeof params.operationId === 'string' ||
      typeof params.uploadId === 'string' ||
      typeof params.burstId === 'string' ||
      method === 'selection.commit' ||
      method === 'selection.cancel';
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await (await this.send<T>(method, params, options)).response;
        unit.succeed();
        return result;
      } catch (error) {
        if (scope.aborted || !this.bindingCurrent(binding)) throw error;
        const failure = unit.fail(error);
        if (
          method === 'document.open' ||
          options?.skipWhenBusy ||
          failure.delay === undefined ||
          (failure.error.code === 'outcome_unknown' && !repeatable) ||
          (failure.error.code === 'conflict' && !repeatable)
        )
          throw error;
        try {
          await unit.wait(options.signal);
        } catch (waitingError) {
          if (scope.aborted) throw error;
          throw waitingError;
        }
        if (options?.signal) checkAbort(options.signal);
      }
    }
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
      abort = () => reject(new RemoteKitError('canceled', ''));
    });
    void aborted.catch(() => {
      /* error-guard: upload-abort; the upload awaits this rejection through its in-flight race. */
    });
    signal.addEventListener('abort', abort, { once: true });
    try {
      check();
      if (typeof uploadId !== 'string' || !Number.isSafeInteger(offset) || offset < 0 || offset > file.size)
        throw new RemoteKitError('outcome_unknown', '文件发送状态无效');
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
            if (result?.offset !== next) throw new RemoteKitError('outcome_unknown', '文件接收进度不一致');
          })
          .finally(() => {
            this.assetChunksInFlight--;
          });
        void ack.catch(() => {
          /* error-guard: chunk-ack; the upload window awaits every original acknowledgment. */
        });
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
        void this.call('asset.cancel', { ...libraryBinding, uploadId }, { binding }).catch((failure) =>
          diagnostics.record('asset-cancel', failure),
        );
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  async readPhoto(asset: AssetDescription, signal: AbortSignal): Promise<Blob> {
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0)
      throw new RemoteKitError('invalid_request', '照片大小无效');
    if (asset.size > 64 * 1024 * 1024)
      throw new RemoteKitError('limit_exceeded', '照片预览大小超出限制', { capacity: 'file' });
    return this.readAsset(asset, signal);
  }
  async readAsset(asset: AssetDescription, signal: AbortSignal): Promise<Blob> {
    const binding = this.currentBinding();
    const parts: Uint8Array<ArrayBuffer>[] = [];
    if (!Number.isSafeInteger(asset.size) || asset.size < 0)
      throw new RemoteKitError('invalid_request', '文件大小无效');
    if (asset.size > 256 * 1024 * 1024)
      throw new RemoteKitError('limit_exceeded', '文件预览大小超出限制', { capacity: 'file' });
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
        throw new RemoteKitError('internal', '文件预览数据无效');
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      parts.push(bytes);
      offset = part.offset;
    }
    this.checkBinding(binding, signal);
    return new Blob(parts, { type: asset.type });
  }
  documentOpen(assetId: string, type: string, signal: AbortSignal) {
    const params = { ...libraryBinding, assetId, type };
    if (!isDocumentOpenParams(params))
      throw new RemoteKitError('invalid_request', 'Invalid document open request');
    return this.call<({ state: 'ready' } & DocumentInfo) | { state: 'converting' }>('document.open', params, {
      signal,
    });
  }
  documentResource(documentId: string, contentId: string, offset: number, signal: AbortSignal) {
    return this.call<{ data: string; offset: number; total: number; mime: string }>(
      'document.resource',
      { ...libraryBinding, documentId, contentId, offset },
      { signal },
    );
  }
  async describeAsset(assetId: string, signal: AbortSignal): Promise<AssetDescription> {
    const binding = this.currentBinding();
    const asset = await this.call<AssetDescription>(
      'asset.describe',
      { ...libraryBinding, assetId },
      { binding, signal },
    );
    this.checkBinding(binding, signal);
    if (
      !asset ||
      asset.assetId !== assetId ||
      (asset.type !== undefined && typeof asset.type !== 'string') ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 0
    ) {
      throw new RemoteKitError('internal', '文件信息无效');
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
    if (typeof result?.burstId !== 'string' || !result.burstId)
      throw new RemoteKitError('outcome_unknown', '拍照会话无效');
    this.photoBursts.set(result.burstId, binding);
    if (signal.aborted) {
      void this.cancelPhotoBurst(result.burstId).catch((failure) =>
        diagnostics.record('photo-cancel', failure),
      );
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
    if (!binding) throw new RemoteKitError('not_found', '拍照会话已结束');
    this.checkBinding(binding, signal);
    if (blob.type !== 'image/jpeg' || !blob.size)
      throw new RemoteKitError('invalid_request', '拍照分析图格式无效');
    if (blob.size > 44 * 1024)
      throw new RemoteKitError('limit_exceeded', '拍照分析图超出大小限制', { capacity: 'file' });
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
    if (!binding) throw new RemoteKitError('not_found', '拍照会话已结束');
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
      throw new RemoteKitError('internal', '照片缩略图数据无效');
    return this.readPhoto(asset, signal);
  }
  processPhoto(
    assetId: string,
    mode: 'photo' | 'scan',
    quarterTurns?: 0 | 1 | 2 | 3,
    signal?: AbortSignal,
  ): Promise<ProcessedPhoto> {
    return this.call(
      'photo.process',
      { ...libraryBinding, assetId, mode, ...(quarterTurns !== undefined ? { quarterTurns } : {}) },
      { signal },
    );
  }
  cancelSelection(requestId: string): Promise<{ state: SelectionState }> {
    return this.call('selection.cancel', { requestId });
  }
  commitSelection(
    requestId: string,
    selectionId: string,
  ): Promise<{ state: SelectionState; selectionId: string }> {
    return this.call('selection.commit', { requestId, selectionId });
  }
  onChannel = (event: import('../rtc/endpoint-channel').ChannelEvent) => {
    if (event.type === 'bound' || event.type === 'closed') this.disconnect();
  };
}
