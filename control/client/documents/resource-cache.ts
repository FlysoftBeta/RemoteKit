import { RemoteKitError } from '../../shared/errors';
import type { DocumentResource, DocumentSource } from './document-source';

type Entry = { resource: DocumentResource; url?: string; users: number };
export interface ResourceLease {
  resource: DocumentResource;
  url?: string;
  release(): void;
}

/** Active pages pin their resources; the idle LRU is bounded by both bytes and count. */
export class ResourceCache {
  private entries = new Map<string, Entry>();
  private closed = false;

  constructor(
    private readonly source: DocumentSource,
    private readonly maxEntries = 64,
    private readonly maxBytes = 32 * 1024 * 1024,
    private readonly urls = { create: URL.createObjectURL, revoke: URL.revokeObjectURL },
  ) {}

  async acquire(id: string, signal: AbortSignal): Promise<ResourceLease> {
    if (signal.aborted || this.closed) throw new RemoteKitError('canceled', '');
    let entry = this.entries.get(id);
    if (!entry) {
      const resource = await this.source.resource(id, signal);
      if (signal.aborted || this.closed) throw new RemoteKitError('canceled', '');
      entry = this.entries.get(id);
      if (!entry) {
        entry = {
          resource,
          users: 0,
          url: /^image\/(webp|png|jpeg|gif)$/.test(resource.mime)
            ? this.urls.create(new Blob([resource.data], { type: resource.mime }))
            : undefined,
        };
      }
    }
    const retained = entry;
    retained.users++;
    this.touch(id, retained);
    this.trim();
    let released = false;
    return {
      resource: retained.resource,
      url: retained.url,
      release: () => {
        if (released || this.closed) return;
        released = true;
        retained.users--;
        this.touch(id, retained);
        this.trim();
      },
    };
  }

  dispose(): void {
    this.closed = true;
    for (const entry of this.entries.values()) this.revoke(entry);
    this.entries.clear();
  }

  private touch(id: string, entry: Entry): void {
    this.entries.delete(id);
    this.entries.set(id, entry);
  }

  private revoke(entry: Entry): void {
    if (entry.url) this.urls.revoke(entry.url);
  }

  private trim(): void {
    let idleCount = 0;
    let idleBytes = 0;
    for (const entry of this.entries.values()) {
      if (!entry.users) {
        idleCount++;
        idleBytes += entry.resource.data.size;
      }
    }
    for (const [id, entry] of this.entries) {
      if (idleCount <= this.maxEntries && idleBytes <= this.maxBytes) break;
      if (entry.users) continue;
      this.entries.delete(id);
      this.revoke(entry);
      idleCount--;
      idleBytes -= entry.resource.data.size;
    }
  }
}
