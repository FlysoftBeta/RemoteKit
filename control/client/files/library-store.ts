import { diagnostics } from '../media/diagnostics';
import { Store } from '../util/store';
import { RemoteKitError } from '../../shared/errors';
import type { LibraryMethods, LibrarySnapshot, SelectionState } from '../../shared/file-library';
import type { SocketMethods } from '../../shared/product';
import { operationId } from '../control/product-operations';
import { FileThumbnails } from './file-thumbnails';
import type { FileChannel } from './file-channel';
import { PhotoJobStore } from './photo-job-store';

type ClientMethods = LibraryMethods & Pick<SocketMethods, 'usage.record'>;
export type LibraryRequest = <K extends keyof ClientMethods>(
  method: K,
  params: ClientMethods[K]['params'],
) => Promise<ClientMethods[K]['result']>;
interface Checkout {
  operationId: string;
  entryIds: string[];
  selectionId?: string;
  state: SelectionState;
  active: boolean;
  nextCheck: number;
  followUntil: number;
}

export interface LibraryState {
  snapshot?: LibrarySnapshot;
  checkouts: Readonly<Record<string, Readonly<Checkout>>>;
  online: boolean;
  scope?: string;
  cancellations: Readonly<Record<string, SelectionState>>;
}
type FilePort = Pick<
  FileChannel,
  'photoThumbnail' | 'uploadAsset' | 'processPhoto' | 'commitSelection' | 'cancelSelection'
>;
export class LibraryStore extends Store<LibraryState> {
  readonly thumbnails: FileThumbnails;
  readonly photos: PhotoJobStore;
  private librarySnapshot?: LibrarySnapshot;
  private checkouts = new Map<string, Checkout>();
  private cancellations = new Map<string, SelectionState>();
  private epoch = 0;
  private identity?: string;
  private enabled = false;
  private online = false;
  private requestIds: string[] = [];
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly request: LibraryRequest,
    readonly rpc: FilePort,
  ) {
    super({ checkouts: {}, cancellations: {}, online: false });
    this.thumbnails = new FileThumbnails((id, signal) => rpc.photoThumbnail(id, signal));
    this.photos = new PhotoJobStore({ mutate: this.mutate, rpc, latestSnapshot: () => this.librarySnapshot });
  }
  configure(online: boolean, enabled: boolean, identity: string | undefined, requestIds: string[]) {
    this.requestIds = [...requestIds];
    let outcomesChanged = false;
    for (const id of this.cancellations.keys()) {
      if (!requestIds.includes(id) && !this.checkouts.has(id)) {
        this.cancellations.delete(id);
        outcomesChanged = true;
      }
    }
    const scopeChanged = this.identity !== identity || this.enabled !== enabled;
    const connectionChanged = this.online !== online;
    if (scopeChanged) {
      this.epoch++;
      this.librarySnapshot = undefined;
      this.checkouts.clear();
      this.cancellations.clear();
      this.thumbnails.clear();
    }
    this.online = online;
    this.enabled = enabled;
    this.identity = identity;
    this.photos.configure(online && enabled && !!identity, identity);
    if (!scopeChanged && !connectionChanged) {
      if (outcomesChanged) this.emit();
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
    this.emit();
    if (online && enabled && identity) {
      void this.refresh().catch((error) => diagnostics.record('library-refresh', error));
      this.timer = setInterval(this.reconcile, 1500);
    }
  }
  dispose = () => {
    clearInterval(this.timer);
    this.timer = undefined;
    this.epoch++;
    this.enabled = false;
    this.online = false;
    this.librarySnapshot = undefined;
    this.checkouts.clear();
    this.cancellations.clear();
    this.photos.dispose();
    this.thumbnails.clear();
    this.emit();
  };
  private current(epoch: number) {
    return this.enabled && epoch === this.epoch;
  }
  private emit() {
    this.publish({
      cancellations: Object.fromEntries(this.cancellations),
      snapshot: this.librarySnapshot,
      online: this.online && this.enabled,
      scope: this.enabled ? `${this.identity}:${this.epoch}` : undefined,
      checkouts: Object.fromEntries(
        [...this.checkouts].map(([id, checkout]) => [id, { ...checkout, entryIds: [...checkout.entryIds] }]),
      ),
    });
  }
  private accept(next: LibrarySnapshot, epoch: number) {
    if (!this.current(epoch)) return;
    if (!this.librarySnapshot || next.revision > this.librarySnapshot.revision) {
      this.librarySnapshot = next;
      this.emit();
    }
  }
  receive = (next: LibrarySnapshot) => {
    if (this.online) this.accept(next, this.epoch);
  };
  mutate = async <
    K extends
      | 'library.import'
      | 'library.replace'
      | 'library.basket'
      | 'library.partition'
      | 'library.partitionDelete'
      | 'library.source'
      | 'library.sourcePurge'
      | 'library.basketPartition'
      | 'library.move'
      | 'library.delete',
  >(
    method: K,
    params: LibraryMethods[K]['params'],
    windowId?: string,
  ) => {
    const epoch = this.epoch;
    const before = new Set(this.librarySnapshot?.basket);
    try {
      const next = await this.request(method, params);
      this.accept(next, epoch);
      if (windowId && this.current(epoch) && (method === 'library.import' || method === 'library.basket')) {
        for (const id of next.basket.filter((id) => !before.has(id))) {
          void this.recordUsage(id, windowId).catch((error) => diagnostics.record('file-usage', error));
        }
      }
      return next;
    } catch (error) {
      if (
        (method === 'library.basket' || method === 'library.replace') &&
        error instanceof RemoteKitError &&
        error.code === 'conflict'
      ) {
        if (!this.current(epoch)) throw error;
        await this.refresh().catch((error) => diagnostics.record('file-library-state', error));
        throw error;
      }
      throw error;
    }
  };

  recordUsage = (entryId: string, windowId: string) =>
    this.request('usage.record', { item: `file:${entryId}`, windowId });

  refresh = async () => {
    const epoch = this.epoch;
    const snapshot = await this.request('library.get', {});
    this.accept(snapshot, epoch);
    return snapshot;
  };
  private async confirm(requestId: string, transaction: Checkout, submit: boolean) {
    if (transaction.active) return;
    const epoch = this.epoch;
    transaction.active = true;
    if (submit) transaction.followUntil = Date.now() + 150_000;
    this.emit();
    try {
      if (!transaction.selectionId) {
        if (!submit) return;
        try {
          const { selectionId } = await this.request('library.prepare', {
            operationId: transaction.operationId,
            requestId,
            entryIds: transaction.entryIds,
          });
          transaction.selectionId = selectionId;
        } catch (error) {
          if (
            error instanceof RemoteKitError &&
            ['invalid_request', 'not_found', 'conflict', 'limit_exceeded'].includes(error.code) &&
            this.checkouts.get(requestId) === transaction
          )
            this.checkouts.delete(requestId);
          throw error;
        }
      }
      if (!this.current(epoch)) return;
      if (submit) {
        // Even a lost RTC response can correspond to a successful native callback.
        await this.rpc
          .commitSelection(requestId, transaction.selectionId)
          .catch((error) => diagnostics.record('file-library-state', error));
      }
      if (!this.current(epoch)) return;
      const result = await this.request('library.finish', { selectionId: transaction.selectionId });
      if (!this.current(epoch)) return;
      transaction.state = result.state;
      this.accept(result.snapshot, epoch);
    } finally {
      transaction.active = false;
      transaction.nextCheck = Date.now() + (transaction.state === 'unknown' ? 15_000 : 1500);
      if (this.current(epoch)) this.emit();
    }
  }

  select = async (requestId: string, entryIds: string[]) => {
    let transaction = this.checkouts.get(requestId);
    if (!transaction) {
      transaction = {
        operationId: operationId(),
        entryIds: [...entryIds],
        state: 'pending',
        active: false,
        nextCheck: 0,
        followUntil: 0,
      };
      this.checkouts.set(requestId, transaction);
    }
    await this.confirm(requestId, transaction, true);
    return transaction.state;
  };

  cancelSelection = async (requestId: string) => {
    const epoch = this.epoch;
    const result = await this.rpc.cancelSelection(requestId);
    if (!this.current(epoch)) return result.state;
    this.cancellations.set(requestId, result.state);
    this.emit();
    const transaction = this.checkouts.get(requestId);
    if (transaction) {
      // Finish even a selected checkout to reconcile its library entries.
      transaction.followUntil = Date.now() + 150_000;
      transaction.nextCheck = 0;
      if (transaction.selectionId)
        await this.confirm(requestId, transaction, false).catch((error) =>
          diagnostics.record('library-cancel-reconcile', error),
        );
    }
    await this.refresh();
    return result.state;
  };
  private reconcile = () => {
    let changed = false;
    for (const [id, checkout] of this.checkouts) {
      const live = this.requestIds.includes(id);
      const terminal = checkout.state === 'selected' || checkout.state === 'cancelled';
      if (
        !live &&
        !checkout.active &&
        (terminal || !checkout.selectionId || Date.now() >= checkout.followUntil)
      ) {
        this.checkouts.delete(id);
        this.cancellations.delete(id);
        changed = true;
      } else if (!terminal && checkout.selectionId && !checkout.active && Date.now() >= checkout.nextCheck) {
        void this.confirm(id, checkout, false).catch((error) =>
          diagnostics.record('library-reconcile', error),
        );
        break;
      }
    }
    if (changed) this.emit();
  };
}
