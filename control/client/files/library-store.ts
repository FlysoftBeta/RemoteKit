import { RetryUnit } from '../../shared/retry-unit';
import { operationFailure } from '../failures/operations';
import { errorHandling } from '../../shared/error-policy';
import { RemoteKitError, toRemoteKitError } from '../../shared/errors';
import type {
  LibraryFileEntry,
  LibraryMethods,
  LibrarySnapshot,
  SelectionState,
} from '../../shared/file-library';
import type { SocketMethods } from '../../shared/product';
import { operationId } from '../control/product-operations';
import { recover, recoverRead } from '../failures/recovery';
import { diagnostics } from '../media/diagnostics';
import { Store } from '../util/store';
import { randomUuid } from '../../shared/random-uuid';
import { SelectionCommitFailure, type FileChannel } from './file-channel';
import { FileThumbnails } from './file-thumbnails';
import { ImportQueue } from './import-queue';
import { PhotoJobStore } from './photo-job-store';
import {
  projectBasket,
  projectLibrary,
  type LibraryChange,
  type LibraryMutationMethod,
  type PendingLibraryChange,
} from './library-operations';

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
  commit?: 'retry' | 'query';
  active: boolean;
  nextCheck: number;
  retry: RetryUnit;
  error?: RemoteKitError;
}
interface PendingMutation extends PendingLibraryChange {
  completion?: Promise<LibrarySnapshot>;
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
  'photoThumbnail' | 'uploadAsset' | 'processPhoto' | 'commitSelection' | 'cancelSelection' | 'readAsset'
>;
export class LibraryStore extends Store<LibraryState> {
  readonly thumbnails: FileThumbnails;
  readonly photos: PhotoJobStore;
  private loadError?: RemoteKitError;
  private librarySnapshot?: LibrarySnapshot;
  private pending: PendingMutation[] = [];
  private mutationTail: Promise<unknown> = Promise.resolve();
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
        windowId,
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
    if (scopeChanged || (this.enabled && !enabled)) {
      this.taskAbort.abort();
      this.taskAbort = new AbortController();
      this.loadError = undefined;
      this.epoch++;
      this.librarySnapshot = undefined;
      this.pending = [];
      this.mutationTail = Promise.resolve();
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
    this.pending = [];
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
      snapshot: projectLibrary(
        this.librarySnapshot,
        this.pending,
        [...this.checkouts.values()].flatMap((checkout) =>
          checkout.state === 'selected' || checkout.state === 'cancelled' ? [] : checkout.entryIds,
        ),
      ),
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
  mutate = <K extends LibraryMutationMethod>(
    method: K,
    params: LibraryMethods[K]['params'],
    windowId?: string,
  ): Promise<LibrarySnapshot> => {
    const epoch = this.epoch;
    const signal = this.taskAbort.signal;
    const change = { method, params: JSON.parse(JSON.stringify(params)) } as LibraryChange;
    const partitionId =
      (change.method === 'library.partition' && !change.params.create) ||
      change.method === 'library.partitionDelete'
        ? change.params.id
        : change.method === 'library.move' || change.method === 'library.basketPartition'
          ? change.params.partitionId
          : change.method === 'library.import' && change.params.origin.kind === 'files'
            ? change.params.origin.partitionId
            : null;
    const prerequisite = this.pending.find(
      (item) =>
        item.change.method === 'library.partition' &&
        item.change.params.create &&
        item.change.params.id === partitionId,
    );
    const pending: PendingMutation = {
      change,
      basketBefore: [...(this.getSnapshot().snapshot?.basket ?? [])],
    };
    const before = new Set(this.getSnapshot().snapshot?.basket);
    this.pending.push(pending);
    this.emit();
    const execute = async () => {
      if (prerequisite) await prerequisite.completion;
      if (!this.current(epoch)) throw new RemoteKitError('canceled', '');
      // Basket requests are serialized against the last accepted revision, while every edit is projected.
      if (change.method === 'library.basket' || change.method === 'library.replace')
        change.params.expectedRevision = this.librarySnapshot?.revision ?? change.params.expectedRevision;
      const requestChange = JSON.parse(JSON.stringify(change)) as LibraryChange;
      const rebaseBasket = () => {
        if (requestChange.method === 'library.basket' && this.librarySnapshot) {
          requestChange.params.expectedRevision = this.librarySnapshot.revision;
          requestChange.params.ids = projectBasket(
            this.librarySnapshot.basket,
            (change.params as LibraryMethods['library.basket']['params']).ids,
            pending.basketBefore!,
          );
        }
      };
      rebaseBasket();
      const request = () => {
        pending.visible = true;
        this.emit();
        return this.request(requestChange.method, requestChange.params);
      };
      const next =
        method === 'library.import' || method === 'library.replace'
          ? await request()
          : await recover(
              request,
              signal,
              (error) => {
                if (this.current(epoch)) {
                  pending.visible = false;
                  this.loadError = operationFailure(error, method, params);
                  this.emit();
                }
              },
              {
                identity: params.operationId,
                recompute:
                  change.method === 'library.partition' && change.params.create
                    ? undefined
                    : async () => {
                        await this.refresh();
                        rebaseBasket();
                      },
              },
            );
      if (!this.current(epoch)) return next;
      this.pending = this.pending.filter((item) => item !== pending);
      this.loadError = undefined;
      this.accept(next, epoch);
      this.emit();
      if (windowId && (method === 'library.import' || method === 'library.basket')) {
        for (const id of next.basket.filter((id) => !before.has(id)))
          void this.recordUsage(id, windowId).catch((error) => diagnostics.record('file-usage', error));
      }
      return next;
    };
    const result = this.mutationTail.then(execute).catch(async (error) => {
      if (this.current(epoch)) {
        this.pending = this.pending.filter((item) => item !== pending);
        this.loadError = operationFailure(error, method, params);
        this.emit();
        await this.refresh().catch((failure) => diagnostics.record('file-library-state', failure));
        if (this.current(epoch)) {
          this.loadError = operationFailure(error, method, params);
          this.emit();
        }
      }
      throw error;
    });
    pending.completion = result;
    this.mutationTail = result.catch((error) => diagnostics.record('library-mutation', error));
    return result;
  };

  createPartition = (name: string, ids?: string[]) => {
    const partitionId = randomUuid();
    const create = this.mutate('library.partition', {
      operationId: operationId(),
      id: partitionId,
      name,
      create: true,
    });
    const choose = ids
      ? this.mutate('library.move', { operationId: operationId(), ids, partitionId })
      : this.mutate('library.basketPartition', { operationId: operationId(), partitionId });
    return Promise.all([create, choose]);
  };

  recordUsage = (entryId: string, windowId: string) =>
    this.request('usage.record', { item: `file:${entryId}`, windowId });

  // File bytes come over the viewer's WebRTC file channel, like previews; Control serves no file route.
  // A failed save is reported on the button and repeated only by the user.
  download = async (entry: LibraryFileEntry, signal = new AbortController().signal) => {
    const blob = await this.rpc.readAsset(entry, signal);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = entry.name;
    document.body.append(link);
    link.click();
    link.remove();
    // Revoking during click cancels the save on some mobile browsers.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
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
          else transaction.commit = 'retry';
          throw error;
        }
      }
      if (!this.current(epoch)) return;
      if (submit && transaction.commit !== 'query') {
        try {
          await this.rpc.commitSelection(requestId, transaction.selectionId);
          transaction.commit = 'query';
        } catch (failure) {
          transaction.commit = failure instanceof SelectionCommitFailure ? failure.disposition : 'query';
          if (transaction.commit === 'query') transaction.state = 'unknown';
          diagnostics.record('selection.commit', failure);
          throw operationFailure(failure, 'selection.commit', {
            requestId,
            selectionId: transaction.selectionId,
          });
        }
      }
      if (!this.current(epoch)) return;
      const result = await this.request('library.finish', { selectionId: transaction.selectionId });
      if (!this.current(epoch)) return;
      transaction.state = result.state;
      if (result.state !== 'pending' && result.state !== 'unknown') transaction.error = undefined;
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
    if (transaction.commit === 'retry' && !transaction.active) transaction.retry.succeed();
    await this.confirm(requestId, transaction, true);
    return transaction.state;
  };

  cancelSelection = async (requestId: string) => {
    const epoch = this.epoch;
    const transaction = this.checkouts.get(requestId);
    if (transaction) transaction.commit = 'query';
    const result = await this.rpc.cancelSelection(requestId);
    if (!this.current(epoch)) return result.state;
    this.cancellations.set(requestId, result.state);
    this.emit();
    if (transaction) {
      // Finish even a selected checkout to reconcile its library entries.

      transaction.retry.succeed();
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
      } else if (
        !terminal &&
        checkout.selectionId &&
        (checkout.commit !== 'retry' || !live) &&
        !checkout.active &&
        Date.now() >= checkout.nextCheck
      ) {
        void this.confirm(id, checkout, false).catch((error) =>
          diagnostics.record('library-reconcile', error),
        );
        break;
      }
    }
    if (changed) this.emit();
  };
}
