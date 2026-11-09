import { RemoteKitError } from '../../shared/errors';
import type { FileChannel } from '../files/file-channel';
import type { DocumentInfo, DocumentOpenOptions, DocumentSource } from './document-source';

export class ChannelDocumentSource implements DocumentSource {
  private info?: DocumentInfo;
  private activeResources = 0;
  private readonly waiting = new Set<() => void>();
  constructor(
    private readonly channel: Pick<FileChannel, 'documentOpen' | 'documentResource'>,
    private readonly assetId: string,
  ) {}

  async open(signal: AbortSignal, options?: DocumentOpenOptions): Promise<DocumentInfo> {
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      if (signal.aborted) throw new DOMException('请求已取消', 'AbortError');
      if (Date.now() >= deadline) throw new RemoteKitError('rejected', '文档转换超时');
      const result = await this.channel.documentOpen(this.assetId, signal);
      if (signal.aborted) throw new DOMException('请求已取消', 'AbortError');
      if (result.state === 'ready') {
        options?.onStatus?.('ready');
        this.info = result;
        return result;
      }
      options?.onStatus?.('converting');
      if (Date.now() >= deadline) throw new RemoteKitError('rejected', '文档转换超时');
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new DOMException('请求已取消', 'AbortError'));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        }, 1500);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
  }

  async resource(contentId: string, signal: AbortSignal) {
    while (this.activeResources >= 4) {
      await new Promise<void>((resolve, reject) => {
        const resume = () => {
          signal.removeEventListener('abort', abort);
          this.waiting.delete(resume);
          resolve();
        };
        const abort = () => {
          this.waiting.delete(resume);
          reject(new DOMException('请求已取消', 'AbortError'));
        };
        if (signal.aborted) return abort();
        this.waiting.add(resume);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    if (signal.aborted) throw new DOMException('请求已取消', 'AbortError');
    this.activeResources++;
    try {
      return await this.readResource(contentId, signal);
    } finally {
      this.activeResources--;
      this.waiting.values().next().value?.();
    }
  }

  private async readResource(contentId: string, signal: AbortSignal) {
    if (!this.info) throw new Error('请先打开文档');
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let offset = 0;
    let total: number | undefined;
    let mime = '';
    do {
      const part = await this.channel.documentResource(this.info.documentId, contentId, offset, signal);
      if (signal.aborted) throw new DOMException('请求已取消', 'AbortError');
      const bytes = Uint8Array.from(atob(part.data), (char) => char.charCodeAt(0));
      if (
        !Number.isSafeInteger(part.total) ||
        part.total < 0 ||
        part.offset !== offset + bytes.length ||
        part.offset > part.total ||
        (total !== undefined && total !== part.total) ||
        (!bytes.length && part.total !== 0) ||
        bytes.length > 16384 ||
        (mime && mime !== part.mime)
      ) {
        throw new RemoteKitError('rejected', '文档资源数据无效');
      }
      total = part.total;
      mime = part.mime;
      parts.push(bytes);
      offset = part.offset;
    } while (offset !== total);
    return { mime, data: new Blob(parts, { type: mime }) };
  }
}
