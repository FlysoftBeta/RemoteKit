import { RetryUnit } from '../../shared/retry-unit';
import { operationFailure } from '../failures/operations';
import { errorHandling } from '../../shared/error-policy';
import { RemoteKitError, toRemoteKitError } from '../../shared/errors';
import type { LibraryMethods, LibrarySnapshot, SelectionState } from '../../shared/file-library';
import type { SocketMethods } from '../../shared/product';
import { operationId } from '../control/product-operations';
import { recover, recoverRead } from '../failures/recovery';
import { diagnostics } from '../media/diagnostics';
import { Store } from '../util/store';
import type { FileChannel } from './file-channel';
import { FileThumbnails } from './file-thumbnails';
import { ImportQueue } from './import-queue';
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
  retry: RetryUnit;
  error?: RemoteKitError;
}

export interface LibraryState {
  snapshot?: LibrarySnapshot;
  error?: RemoteKitError;
  checkouts: Readonly<Record<string, Readonly<Checkout>>>;
  online: boolean;
  scope?: string;
  cancellations: Readonly<Record<string, SelectionState>>;
}
export type FilePort = Pick<
  FileChannel,
  'photoThumbnail' | 'uploadAsset' | 'processPhoto' | 'commitSelection' | 'cancelSelection'
>;
export class LibraryStore extends Store<LibraryState> {
  readonly thumbnails: FileThumbnails;
  readonly photos: PhotoJobStore;
  private loadError?: RemoteKitError;
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
  private imports = new Map<string, ImportQueue>();
  private taskAbort = new AbortController();
  private loadAbort?: AbortController;
  importQueue = (destination: 'library' | 'basket', windowId?: string) => {
    const key = destination + ':' + (windowId ?? '');
    let queue = this.imports.get(key);
    if (!queue) {
      queue = new ImportQueue(
        { rpc: this.rpc, mutate: (method, params) => this.mutate(method, params, windowId) },
        destination,
      );
      queue.configure(this.online && this.enabled, this.identity);
      this.imports.set(key, queue);
    }
    return queue;
  };
  configure(online: boolean, enabled: boolean, identity: string | undefined, requestIds: string[]) {
    this.requestIds = [...requestIds];
    let outcomesChanged = false;
    for (const id of this.cancellations.keys()) {
      if (!requestIds.includes(id) && !this.checkouts.has(id)) {
        this.cancellations.delete(id);
        outcomesChanged = true;
      }
    }
    const scopeChanged = this.identity !== identity;
    const connectionChanged = this.online !== online || this.enabled !== enabled;
    if (scopeChanged) {
      this.taskAbort.abort();
      this.taskAbort = new AbortController();
      this.loadError = undefined;
      this.epoch++;
      this.librarySnapshot = undefined;
      this.checkouts.clear();
      this.cancellations.clear();
      this.thumbnails.clear();
    }
    this.online = online;
    if (!enabled) this.librarySnapshot = undefined;
    this.enabled = enabled;
    this.identity = identity;
    this.imports.forEach((queue) => queue.configure(online && enabled, identity));
    this.photos.configure(online && enabled && !!identity, identity);
    if (!scopeChanged && !connectionChanged) {
      if (outcomesChanged) this.emit();
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
    this.emit();
    if (online && enabled && identity) {
      this.loadAbort?.abort();
      this.loadAbort = new AbortController();
      void recoverRead(this.refresh, this.loadAbort.signal).catch((error) =>
        diagnostics.record('library-refresh', error),
      );
      this.timer = setInterval(this.reconcile, 1500);
    }
  }
  dispose = () => {
    this.taskAbort.abort();
    this.loadAbort?.abort();
    this.imports.forEach((queue) => queue.dispose());
    this.imports.clear();
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
      error: this.loadError,
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
      const released =
        this.librarySnapshot &&
        (next.entries.length < this.librarySnapshot.entries.length ||
          next.basket.length < this.librarySnapshot.basket.length);
      this.librarySnapshot = next;
      if (released) this.imports.forEach((queue) => queue.capacityChanged());
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
      const next =
        method === 'library.import' || method === 'library.replace'
          ? await this.request(method, params)
          : await recover(
              () => this.request(method, params),
              this.taskAbort.signal,
              (error) => {
                if (this.current(epoch)) {
                  this.loadError = operationFailure(error, method, params);
                  this.emit();
                }
              },
              {
                identity: params.operationId,
                recompute: async () => {
                  await this.refresh();
                },
              },
            );
      this.loadError = undefined;
      this.accept(next, epoch);
      if (this.current(epoch)) this.emit();
      if (windowId && this.current(epoch) && (method === 'library.import' || method === 'library.basket')) {
        for (const id of next.basket.filter((id) => !before.has(id))) {
          void this.recordUsage(id, windowId).catch((error) => diagnostics.record('file-usage', error));
        }
      }
      return next;
    } catch (error) {
      this.loadError = toRemoteKitError(error);
      this.emit();
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

  snippet = (id: string) => this.request('library.snippet', { id });
  copySnippet = (id: string) => this.request('library.copySnippet', { id });

  refresh = async () => {
    const epoch = this.epoch;
    try {
      const snapshot = await this.request('library.get', {});
      this.loadError = undefined;
      this.accept(snapshot, epoch);
      if (this.current(epoch)) this.emit();
      return snapshot;
    } catch (value) {
      if (this.current(epoch)) {
        this.loadError = toRemoteKitError(value);
        this.emit();
      }
      throw value;
    }
  };
  private async confirm(requestId: string, transaction: Checkout, submit: boolean) {
    if (transaction.active || !transaction.retry.ready(JSON.stringify([this.epoch, transaction.operationId])))
      return;
    const epoch = this.epoch;
    transaction.active = true;

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
            ['final', 'refresh', 'drop', 'canceled'].includes(errorHandling(error.code)) &&
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
      transaction.error = undefined;
      transaction.retry.succeed();
      this.accept(result.snapshot, epoch);
    } catch (value) {
      transaction.error = toRemoteKitError(value);
      transaction.retry.fail(transaction.error);
      throw value;
    } finally {
      transaction.active = false;
      transaction.nextCheck =
        transaction.retry.state.phase === 'waiting'
          ? transaction.retry.state.until
          : transaction.retry.state.phase === 'idle'
            ? Date.now() + 1500
            : Infinity;
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
        retry: new RetryUnit({ name: 'library.checkout' }),
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
      if (!live && !checkout.active && (terminal || !checkout.selectionId)) {
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
