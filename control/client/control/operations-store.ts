import { RemoteKitError } from '../../shared/errors';
import type { OperationReceipt, ProductAction, ProductOperation, ProductState } from '../../shared/product';
import { recordedAction, type RecordedAction } from '../../shared/recorded-action';
import { diagnostics } from '../media/diagnostics';
import type { Incoming, Outgoing } from '../rtc/protocol';
import { RequestTracker } from '../util/request-tracker';
import { Store } from '../util/store';
import { operationId, projectOperations, snapshotNewer, type PendingOperation } from './product-operations';

export type OperationPhase =
  'unsent' | 'sent' | 'accepted' | 'applying' | 'committed' | 'rejected' | 'unknown' | 'expired';
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
  private pollingScope?: number;
  constructor(private readonly port: OperationsPort) {
    super({ authoritative: null, state: null, pending: [] });
  }

  acceptSnapshot(state: ProductState) {
    const previous = this.getSnapshot();
    if (!snapshotNewer(state, previous.authoritative)) return;
    const pending = previous.pending
      .map((entry) => {
        const receipt = state.operationReceipts?.find(
          (r) => r.operationId === entry.operationId && r.operationGeneration === entry.operationGeneration,
        );
        if (receipt) this.requests.resolve(entry.operationId, receipt);
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
    if (!message.result) {
      const error = new RemoteKitError(message.error.code, message.error.message);
      this.requests.reject(entry.operationId, error);
      this.update(
        this.getSnapshot().pending.filter((item) => item !== entry),
        undefined,
        error,
      );
      return;
    }
    this.requests.resolve(entry.operationId, message.result);
    this.receipt(message.result);
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
    if (current.pending.length >= 64) throw new RemoteKitError('limit_exceeded', '待确认操作过多');
    const operation: OperationIntent = {
      operationId: operationId(),
      operationGeneration: source.operationGeneration,
      action: recordedAction(command),
      phase: 'unsent',
    };
    const scope = this.scope;
    this.update([...current.pending, operation]);
    let sent = false;
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
        sent = true;
        this.update(
          this.getSnapshot().pending.map((entry) =>
            entry === operation ? { ...entry, phase: 'sent' } : entry,
          ),
        );
      });
    } catch (error) {
      if (scope !== this.scope) throw error;
      diagnostics.record('product-action', error);
      if (!sent || (error instanceof RemoteKitError && error.code !== 'outcome_unknown')) {
        this.update(
          this.getSnapshot().pending.filter((entry) => entry.operationId !== operation.operationId),
        );
        throw error;
      }
      receipt = await this.query(operation);
    }
    if (scope !== this.scope) throw new RemoteKitError('locked', '授权已改变');
    this.receipt(receipt);
    if (receipt.status === 'rejected' || receipt.status === 'expired')
      throw new RemoteKitError('rejected', receipt.error ?? '操作被拒绝');
    return receipt;
  };

  dismissUnknown() {
    this.update(this.getSnapshot().pending.filter((entry) => entry.phase !== 'unknown'));
  }

  reset(scope = this.scope + 1) {
    this.scope = scope;
    this.pollingScope = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.requests.setScope(scope);
    this.publish({ authoritative: null, state: null, pending: [] });
  }

  private receipt(receipt: OperationReceipt) {
    const current = this.getSnapshot();
    const pending = current.pending.map((entry) =>
      entry.operationId === receipt.operationId && entry.operationGeneration === receipt.operationGeneration
        ? { ...entry, receipt, phase: receipt.status }
        : entry,
    );
    const error = ['rejected', 'expired'].includes(receipt.status)
      ? new RemoteKitError('rejected', receipt.error ?? '操作被拒绝')
      : receipt.status === 'unknown' && receipt.resolved
        ? new RemoteKitError('outcome_unknown', receipt.error ?? '操作结果未知')
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
    this.schedule();
  }

  private async query({
    operationId,
    operationGeneration,
  }: Pick<ProductOperation, 'operationId' | 'operationGeneration'>): Promise<OperationReceipt> {
    try {
      return await this.port.status({ operationId, operationGeneration });
    } catch (error) {
      diagnostics.record('operation-status', error);
      return {
        operationId,
        operationGeneration,
        status: 'unknown',
      };
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
        const receipts = await Promise.all(entries.map((entry) => this.query(entry)));
        if (scope === this.scope) for (const receipt of receipts) this.receipt(receipt);
      } finally {
        if (this.pollingScope === scope) this.pollingScope = undefined;
        this.schedule();
      }
    }, 2000);
  }
}
