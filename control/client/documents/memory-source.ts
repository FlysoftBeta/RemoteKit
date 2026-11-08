import { RemoteKitError } from '../../shared/errors';
import type { DocumentInfo, DocumentResource, DocumentSource } from './document-source';

export class MemoryDocumentSource implements DocumentSource {
  constructor(
    private readonly info: DocumentInfo,
    private readonly resources: ReadonlyMap<string, DocumentResource>,
  ) {}

  async open(signal: AbortSignal): Promise<DocumentInfo> {
    if (signal.aborted) throw new DOMException('请求已取消', 'AbortError');
    return this.info;
  }

  async resource(contentId: string, signal: AbortSignal): Promise<DocumentResource> {
    if (signal.aborted) throw new DOMException('请求已取消', 'AbortError');
    const resource = this.resources.get(contentId);
    if (!resource) throw new RemoteKitError('not_found', '文档资源不存在');
    return resource;
  }
}
