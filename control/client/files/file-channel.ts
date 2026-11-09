import { retryDelay } from '../../shared/error-policy';
import { RemoteKitError, nativeError } from '../../shared/errors';
import type { Asset, SelectionState } from '../../shared/file-library';
import { operationId } from '../control/product-operations';
import { diagnostics } from '../media/diagnostics';
import type { FileMethod } from '../rtc/protocol';
import type { Incoming } from '../rtc/protocol';
import type { DocumentInfo } from '../documents/document-source';
import { RequestTracker } from '../util/request-tracker';

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
  private photoBursts = new Map<string, Binding>();
  private assetChunksInFlight = 0;
  constructor(
    private readonly getChannel: () => RTCDataChannel | null,
    private readonly getAuthEpoch = (): number | undefined => undefined,
  ) {}
  handle(message: Incoming): boolean {
    if (message.type !== 'files.result') return false;
    this.syncScope();
    if (message.ok) this.pending.resolve(message.requestId, message.result);
    else this.pending.reject(message.requestId, nativeError(message.error));
    return true;
  }
  disconnect() {
    this.pending.clear();
    this.photoBursts.clear();
  }
  private syncScope() {
    const binding = this.currentBinding();
    if (binding.channel !== this.binding?.channel || binding.authEpoch !== this.binding?.authEpoch) {
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
  private request<T>(
    method: FileMethod,
    params: Record<string, unknown>,
    options: RequestOptions = {},
  ): { response: Promise<T> } {
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
      throw new RemoteKitError('limit_exceeded', '文件信息过长，请减少文件数量');
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
      /* The caller observes this rejection after pipelined sends. */
    });
    return sent;
  }
  private async call<T>(
    method: FileMethod,
    params: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await (
          await this.send<T>(method, params, options)
        ).response;
      } catch (error) {
        const delay = error instanceof RemoteKitError ? retryDelay(error, attempt) : undefined;
        if (method === 'document.open' || options?.skipWhenBusy || delay === undefined || attempt >= 3)
          throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
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
      /* The upload races this signal when bytes are in flight. */
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
          /* The upload window awaits every chunk acknowledgment. */
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
  async readPhoto(asset: Asset, signal: AbortSignal): Promise<Blob> {
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0)
      throw new RemoteKitError('invalid_request', '照片大小无效');
    if (asset.size > 64 * 1024 * 1024) throw new RemoteKitError('limit_exceeded', '照片预览大小超出限制');
    return this.readAsset(asset, signal);
  }
  async readAsset(asset: Asset, signal: AbortSignal): Promise<Blob> {
    const binding = this.currentBinding();
    const parts: Uint8Array<ArrayBuffer>[] = [];
    if (!Number.isSafeInteger(asset.size) || asset.size < 0)
      throw new RemoteKitError('invalid_request', '文件大小无效');
    if (asset.size > 256 * 1024 * 1024) throw new RemoteKitError('limit_exceeded', '文件预览大小超出限制');
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
  documentOpen(assetId: string, signal: AbortSignal) {
    return this.call<({ state: 'ready' } & DocumentInfo) | { state: 'converting' }>(
      'document.open',
      { ...libraryBinding, assetId },
      { signal },
    );
  }
  documentResource(documentId: string, contentId: string, offset: number, signal: AbortSignal) {
    return this.call<{ data: string; offset: number; total: number; mime: string }>(
      'document.resource',
      { ...libraryBinding, documentId, contentId, offset },
      { signal },
    );
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
      typeof asset.type !== 'string' ||
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
    if (blob.size > 44 * 1024) throw new RemoteKitError('limit_exceeded', '拍照分析图超出大小限制');
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
  processPhoto(assetId: string, mode: 'rectify' | 'scan', signal?: AbortSignal): Promise<Asset> {
    return this.call('photo.process', { ...libraryBinding, assetId, mode }, { signal });
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
