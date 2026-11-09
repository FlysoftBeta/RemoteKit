import { errorHandling, retryDelay } from '../../shared/error-policy';
import { RemoteKitError, parseWireError, toRemoteKitError } from '../../shared/errors';
import type { OperationReceipt, ProductAction, ProductOperation, ProductState } from '../../shared/product';
import { recordedAction, type RecordedAction } from '../../shared/recorded-action';
import { diagnostics } from '../media/diagnostics';
import type { Incoming, Outgoing } from '../rtc/protocol';
import { RequestTracker } from '../util/request-tracker';
import { canonicalJson } from '../util/canonical-json';
import { Store } from '../util/store';
import { operationId, projectOperations, snapshotNewer, type PendingOperation } from './product-operations';

export type OperationPhase = 'unsent' | 'sent' | 'accepted' | 'applying' | 'committed' | 'failed' | 'unknown';
export interface OperationIntent extends Omit<PendingOperation, 'action'> {
  action: RecordedAction;
  phase: OperationPhase;
}
export interface OperationsSnapshot {
  authoritative: ProductState | null;
  state: ProductState | null;
  pending: OperationIntent[];
  error?: RemoteKitError;
}
export interface OperationsPort {
  ready(): boolean;
  send(message: Outgoing): void;
  status(operation: Pick<ProductOperation, 'operationId' | 'operationGeneration'>): Promise<OperationReceipt>;
}

export class OperationsStore extends Store<OperationsSnapshot> {
  private readonly requests = new RequestTracker<OperationReceipt>();
  private timer?: ReturnType<typeof setTimeout>;
  private scope = 0;
  private accepted: ProductState | null = null;
  private acceptedContent?: string;
  private pollingScope?: number;
  private readonly commands = new Map<string, ProductAction>();
  private readonly retries = new Map<string, number>();
  private readonly executing = new Set<string>();
  constructor(private readonly port: OperationsPort) {
    super({ authoritative: null, state: null, pending: [] });
  }

  acceptSnapshot(state: ProductState) {
    const previous = this.getSnapshot();
    if (!snapshotNewer(state, this.accepted)) return;
    this.accepted = state;
    const content = canonicalJson({ ...state, snapshotSequence: undefined });
    if (content === this.acceptedContent) return;
    this.acceptedContent = content;
    const pending = previous.pending
      .map((entry) => {
        const receipt = state.operationReceipts?.find(
          (r) => r.operationId === entry.operationId && r.operationGeneration === entry.operationGeneration,
        );
        if (
          receipt &&
          !this.requests.resolve(entry.operationId, receipt) &&
          this.retryReceipt(entry, receipt)
        )
          return { ...entry, receipt: undefined, phase: 'unsent' as const };
        return receipt ? { ...entry, receipt, phase: receipt.status } : entry;
      })
      .filter((entry) => this.retain(entry, state));
    this.update(pending, state);
  }

  private retain(entry: OperationIntent, state: ProductState | null) {
    return (
      !entry.receipt ||
      (['accepted', 'applying', 'unknown'].includes(entry.phase) && !entry.receipt.resolved) ||
      (entry.phase === 'committed' &&
        (entry.receipt.revision ?? Infinity) > (state?.workspace.revision ?? -1))
    );
  }

  handle(message: Incoming) {
    if (message.type !== 'product.result') return;
    const entry = this.getSnapshot().pending.find(
      (entry) =>
        entry.operationId === message.operationId &&
        entry.operationGeneration === message.operationGeneration,
    );
    if (!entry) return;
    if (this.requests.resolve(entry.operationId, message.result)) {
      if (message.result.status !== 'failed' || retryDelay(message.result.error, 0) === undefined)
        this.receipt(message.result);
      return;
    }
    if (!this.retryReceipt(entry, message.result)) this.receipt(message.result);
  }

  action = async (command: ProductAction): Promise<OperationReceipt> => {
    const current = this.getSnapshot();
    const source = current.authoritative;
    if (!source?.operationGeneration || !this.port.ready())
      throw new RemoteKitError('unavailable', '正在连接浏览器');
    const targets = Object.entries(command)
      .filter(([key]) => key === 'id' || key.endsWith('Id'))
      .map(([, value]) => value);
    if ('placement' in command && command.placement.mode === 'split')
      targets.push(command.placement.besideWindowId);
    if (targets.some((value) => typeof value === 'string' && /^(web:)?pending-/.test(value)))
      throw new RemoteKitError('conflict', '操作正在等待确认');
    if (current.pending.length >= 64) throw new RemoteKitError('busy', '待确认操作过多');
    const operation: OperationIntent = {
      operationId: operationId(),
      operationGeneration: source.operationGeneration,
      action: recordedAction(command),
      phase: 'unsent',
    };
    this.commands.set(operation.operationId, command);
    this.update([...current.pending, operation]);
    return this.execute(operation, command);
  };

  private async execute(
    operation: OperationIntent,
    command: ProductAction,
    initialDelay = 0,
  ): Promise<OperationReceipt> {
    const scope = this.scope;
    this.executing.add(operation.operationId);
    try {
      if (initialDelay) await this.wait(initialDelay, scope);
      for (;;) {
        const attempt = this.retries.get(operation.operationId) ?? 0;
        let receipt: OperationReceipt;
        try {
          receipt = await this.requests.request(operation.operationId, 20000, () => {
            this.port.send({
              type: 'product.action',
              version: 1,
              operationId: operation.operationId,
              operationGeneration: operation.operationGeneration,
              action: command,
            });
            this.update(
              this.getSnapshot().pending.map((entry) =>
                entry.operationId === operation.operationId ? { ...entry, phase: 'sent' } : entry,
              ),
            );
          });
        } catch (error) {
          if (scope !== this.scope) throw error;
          const failure = toRemoteKitError(error);
          diagnostics.record('product-action', failure);
          if (errorHandling(failure.code) === 'reconcile')
            receipt = { ...operation, status: 'unknown', error: failure };
          else receipt = { ...operation, status: 'failed', error: failure };
        }
        if (scope !== this.scope) throw new RemoteKitError('locked', '授权已改变');
        if (receipt.status === 'unknown' && !receipt.resolved) receipt = await this.query(operation);
        const failure = parseWireError(receipt.error);
        const delay = failure && retryDelay(failure, attempt);
        if (receipt.status === 'failed' && delay !== undefined && attempt < 4) {
          this.retries.set(operation.operationId, attempt + 1);
          await this.wait(delay, scope);
          this.update([
            ...this.getSnapshot().pending.filter((entry) => entry.operationId !== operation.operationId),
            { ...operation, phase: 'unsent' },
          ]);
          continue;
        }
        this.receipt(receipt);
        if (receipt.status === 'failed') {
          const error = failure ?? new RemoteKitError('internal', '操作收据缺少错误码');
          const handling = errorHandling(error.code);
          if (handling === 'refresh' || handling === 'drop' || handling === 'canceled') return receipt;
          throw error;
        }
        return receipt;
      }
    } finally {
      this.executing.delete(operation.operationId);
      this.cleanCommands();
    }
  }

  private retryReceipt(entry: OperationIntent, receipt: OperationReceipt) {
    if (this.executing.has(entry.operationId) || receipt.status !== 'failed') return false;
    const delay = retryDelay(receipt.error, this.retries.get(entry.operationId) ?? 0);
    const command = this.commands.get(entry.operationId);
    const attempt = this.retries.get(entry.operationId) ?? 0;
    if (delay === undefined || !command || attempt >= 4) return false;
    this.retries.set(entry.operationId, attempt + 1);
    void this.execute(entry, command, delay).catch((error: unknown) => {
      const failure = toRemoteKitError(error);
      diagnostics.record('product-retry', failure);
      if (errorHandling(failure.code) !== 'canceled') this.publish({ ...this.getSnapshot(), error: failure });
    });
    return true;
  }

  private async wait(delay: number, scope: number) {
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    if (scope !== this.scope) throw new RemoteKitError('canceled', '');
  }

  dismissUnknown() {
    this.update(this.getSnapshot().pending.filter((entry) => entry.phase !== 'unknown'));
  }

  reset(scope = this.scope + 1) {
    this.scope = scope;
    this.accepted = null;
    this.acceptedContent = undefined;
    this.pollingScope = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.requests.setScope(scope);
    this.commands.clear();
    this.retries.clear();
    this.executing.clear();
    this.publish({ authoritative: null, state: null, pending: [] });
  }

  private receipt(receipt: OperationReceipt) {
    const current = this.getSnapshot();
    if (receipt.status === 'committed' || receipt.status === 'failed' || receipt.resolved) {
      this.commands.delete(receipt.operationId);
      this.retries.delete(receipt.operationId);
    }
    const pending = current.pending.map((entry) =>
      entry.operationId === receipt.operationId && entry.operationGeneration === receipt.operationGeneration
        ? { ...entry, receipt, phase: receipt.status }
        : entry,
    );
    const failure = parseWireError(receipt.error);
    const handling = failure && errorHandling(failure.code);
    const error =
      receipt.status === 'failed' && handling !== 'refresh' && handling !== 'drop' && handling !== 'canceled'
        ? failure
        : receipt.status === 'unknown' && receipt.resolved
          ? failure
          : undefined;
    this.update(
      pending.filter((entry) => this.retain(entry, current.authoritative)),
      current.authoritative,
      error,
    );
  }

  private update(
    pending: OperationIntent[],
    authoritative = this.getSnapshot().authoritative,
    error = this.getSnapshot().error,
  ) {
    const projections = pending.filter(
      (entry): entry is OperationIntent & PendingOperation => entry.action.type !== 'page.reply',
    );
    this.publish({ authoritative, pending, state: projectOperations(authoritative, projections), error });
    this.cleanCommands();
    this.schedule();
  }

  private cleanCommands() {
    const pending = new Set(this.getSnapshot().pending.map((entry) => entry.operationId));
    for (const id of this.commands.keys())
      if (!pending.has(id) && !this.executing.has(id)) {
        this.commands.delete(id);
        this.retries.delete(id);
      }
  }

  private async query({
    operationId,
    operationGeneration,
  }: Pick<ProductOperation, 'operationId' | 'operationGeneration'>): Promise<OperationReceipt> {
    const scope = this.scope;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.port.status({ operationId, operationGeneration });
      } catch (error) {
        const failure = toRemoteKitError(error);
        diagnostics.record('operation-status', failure);
        const delay = retryDelay(failure, attempt);
        if (delay !== undefined && attempt < 4) {
          await this.wait(delay, scope);
          continue;
        }
        if (errorHandling(failure.code) === 'reconcile')
          return { operationId, operationGeneration, status: 'unknown', error: failure };
        return { operationId, operationGeneration, status: 'failed', error: failure };
      }
    }
  }

  private schedule() {
    if (!this.getSnapshot().pending.length) {
      clearTimeout(this.timer);
      this.timer = undefined;
      return;
    }
    if (this.timer || this.pollingScope === this.scope) return;
    const scope = this.scope;
    this.timer = setTimeout(async () => {
      this.timer = undefined;
      this.pollingScope = scope;
      try {
        const entries = this.getSnapshot().pending.filter(
          (entry) =>
            !entry.receipt ||
            (['accepted', 'applying', 'unknown'].includes(entry.phase) && !entry.receipt.resolved),
        );
        const receipts = await Promise.all(
          entries
            .filter((entry) => !this.executing.has(entry.operationId))
            .map(async (entry) => ({ entry, receipt: await this.query(entry) })),
        );
        if (scope === this.scope)
          for (const { entry, receipt } of receipts) {
            if (!this.retryReceipt(entry, receipt)) this.receipt(receipt);
          }
      } finally {
        if (this.pollingScope === scope) this.pollingScope = undefined;
        this.schedule();
      }
    }, 2000);
  }
}
