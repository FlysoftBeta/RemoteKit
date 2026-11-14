import { errorHandling } from '../../shared/error-policy';
import { RetryUnit } from '../../shared/retry-unit';
import { RemoteKitError, parseWireError, toRemoteKitError, wireError } from '../../shared/errors';
import type { OperationReceipt, ProductAction, ProductOperation, ProductState } from '../../shared/product';
import { recordedAction, type RecordedAction } from '../../shared/recorded-action';
import { operationFailure, resolvedFailure } from '../failures/operations';
import { waitForRecovery } from '../failures/recovery';
import { diagnostics } from '../media/diagnostics';
import { canonicalJson } from '../util/canonical-json';
import { RequestTracker } from '../util/request-tracker';
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
  submit(operation: ProductOperation): Promise<OperationReceipt>;
  status(operation: Pick<ProductOperation, 'operationId' | 'operationGeneration'>): Promise<OperationReceipt>;
}

export class OperationsStore extends Store<OperationsSnapshot> {
  private readonly requests = new RequestTracker<OperationReceipt>();
  private timer?: ReturnType<typeof setTimeout>;
  private scopeAbort = new AbortController();
  private pollingAttempts = 0;
  private scope = 0;
  private accepted: ProductState | null = null;
  private acceptedContent?: string;
  private pollingScope?: number;
  private readonly commands = new Map<string, ProductAction>();
  private readonly submissionUnits = new Map<string, RetryUnit>();
  private readonly queryUnits = new Map<string, RetryUnit>();
  private unit(units: Map<string, RetryUnit>, id: string) {
    let unit = units.get(id);
    if (!unit) {
      unit = new RetryUnit({
        failed: (error) =>
          diagnostics.record(`operation_${units === this.submissionUnits ? 'submission' : 'query'}_failed`, {
            id,
            code: error.code,
            errorId: error.errorId,
          }),
        recovered: () =>
          diagnostics.record(
            `operation_${units === this.submissionUnits ? 'submission' : 'query'}_recovered`,
            { id },
          ),
      });
      units.set(id, unit);
    }
    unit.ready(`${this.scope}:${id}`);
    return unit;
  }
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

  action = async (command: ProductAction): Promise<OperationReceipt> => {
    const scope = this.scope;
    let current = this.getSnapshot();
    const admission = new RetryUnit();
    for (;;) {
      let error: RemoteKitError;
      try {
        if (current.authoritative?.operationGeneration && this.port.ready() && current.pending.length < 64)
          break;
        error = new RemoteKitError(
          current.pending.length >= 64 ? 'busy' : 'unavailable',
          'Operation admission is not ready',
        );
      } catch (cause) {
        error = toRemoteKitError(cause);
      }
      this.publish({ ...current, error: operationFailure(error, command.type, command) });
      admission.ready(JSON.stringify([current.authoritative?.operationGeneration, current.pending.length]));
      const { delay } = admission.fail(error);
      if (delay === undefined) throw error;
      await this.wait(delay, scope);
      current = this.getSnapshot();
    }
    admission.succeed();
    const source = current.authoritative!;
    const targets = Object.entries(command)
      .filter(([key]) => key === 'id' || key.endsWith('Id'))
      .map(([, value]) => value);
    if ('placement' in command && command.placement.mode === 'split')
      targets.push(command.placement.besideWindowId);
    if (targets.some((value) => typeof value === 'string' && /^(web:)?pending-/.test(value)))
      throw new RemoteKitError('conflict', '操作正在等待确认');
    const operation: OperationIntent = {
      operationId: operationId(),
      operationGeneration: source.operationGeneration!,
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
        let receipt: OperationReceipt;
        try {
          receipt = await this.requests.request(operation.operationId, 20000, () => {
            void this.port
              .submit({
                operationId: operation.operationId,
                operationGeneration: operation.operationGeneration,
                action: command,
              })
              .then(
                (receipt) => this.requests.resolve(operation.operationId, receipt),
                (error) => this.requests.reject(operation.operationId, error),
              );
            this.update(
              this.getSnapshot().pending.map((entry) =>
                entry.operationId === operation.operationId ? { ...entry, phase: 'sent' } : entry,
              ),
            );
          });
        } catch (error) {
          if (scope !== this.scope) throw error;
          const failure = toRemoteKitError(error);
          if (failure.code === 'outcome_unknown') {
            receipt = { ...operation, status: 'unknown', error: wireError(failure) };
          } else if (failure.code === 'internal') {
            this.receipt({ ...operation, status: 'unknown', error: wireError(failure) });
            this.unit(this.submissionUnits, operation.operationId).fail(failure);
            this.publish({ ...this.getSnapshot(), error: operationFailure(failure, command.type, command) });
            throw failure;
          } else receipt = { ...operation, status: 'failed', error: wireError(failure) };
        }
        if (scope !== this.scope) throw new RemoteKitError('locked', '授权已改变');
        if (receipt.status === 'unknown' && !receipt.resolved) {
          this.receipt(receipt);
          const failure = parseWireError(receipt.error);
          if (failure) {
            const unknown = this.unit(this.queryUnits, operation.operationId).fail(failure);
            if (unknown.delay === undefined) {
              this.publish({ ...this.getSnapshot(), error: failure });
              throw failure;
            }
            await this.wait(unknown.delay, scope);
          }
          receipt = await this.query(operation);
        }
        const failure = parseWireError(receipt.error);
        const submission = this.unit(this.submissionUnits, operation.operationId);
        const delay = failure && receipt.status === 'failed' ? submission.fail(failure).delay : undefined;
        if (receipt.status === 'failed' && delay !== undefined) {
          this.publish({ ...this.getSnapshot(), error: operationFailure(failure!, command.type, command) });
          await this.wait(delay, scope);
          this.update([
            ...this.getSnapshot().pending.filter((entry) => entry.operationId !== operation.operationId),
            { ...operation, phase: 'unsent' },
          ]);
          continue;
        }
        this.receipt(receipt);
        if (receipt.status !== 'failed') submission.succeed();
        if (receipt.status === 'failed') {
          const error = failure ?? new RemoteKitError('internal', '操作收据缺少错误码');
          const handling = errorHandling(error.code);
          if (handling === 'canceled') return receipt;
          throw operationFailure(error, command.type, command);
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
    const delay = this.unit(this.submissionUnits, entry.operationId).fail(receipt.error).delay;
    const command = this.commands.get(entry.operationId);
    if (delay === undefined || !command) return false;
    void this.execute(entry, command, delay).catch((error: unknown) => {
      const failure = toRemoteKitError(error);
      diagnostics.record('product-retry', failure);
      if (errorHandling(failure.code) !== 'canceled') this.publish({ ...this.getSnapshot(), error: failure });
    });
    return true;
  }

  private async wait(delay: number, scope: number) {
    await waitForRecovery(delay, this.scopeAbort.signal);
    if (scope !== this.scope) throw new RemoteKitError('canceled', '');
  }

  dismissUnknown() {
    this.update(this.getSnapshot().pending.filter((entry) => entry.phase !== 'unknown'));
  }

  reset(scope = this.scope + 1) {
    this.scopeAbort.abort();
    this.scopeAbort = new AbortController();
    this.pollingAttempts = 0;
    this.scope = scope;
    this.accepted = null;
    this.acceptedContent = undefined;
    this.pollingScope = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.requests.setScope(scope);
    this.commands.clear();
    this.submissionUnits.clear();
    this.queryUnits.clear();
    this.executing.clear();
    this.publish({ authoritative: null, state: null, pending: [] });
  }

  private receipt(receipt: OperationReceipt) {
    const current = this.getSnapshot();
    const command = this.commands.get(receipt.operationId);
    if (receipt.status === 'committed' || receipt.status === 'failed' || receipt.resolved) {
      this.commands.delete(receipt.operationId);
    }
    const pending = current.pending.map((entry) =>
      entry.operationId === receipt.operationId && entry.operationGeneration === receipt.operationGeneration
        ? { ...entry, receipt, phase: receipt.status }
        : entry,
    );
    const failure = parseWireError(receipt.error);
    if (failure && receipt.status === 'unknown' && receipt.resolved) resolvedFailure(failure);
    if (failure && command) operationFailure(failure, command.type, command);
    const handling = failure && errorHandling(failure.code);
    const error =
      receipt.status === 'failed' && handling !== 'canceled'
        ? failure
        : receipt.status === 'unknown' && receipt.resolved
          ? failure
          : undefined;
    this.update(
      pending.filter((entry) => this.retain(entry, current.authoritative)),
      current.authoritative,
      error,
    );
    this.publish({ ...this.getSnapshot(), error });
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
      }
  }

  private async query({
    operationId,
    operationGeneration,
  }: Pick<ProductOperation, 'operationId' | 'operationGeneration'>): Promise<OperationReceipt> {
    const scope = this.scope;
    const submission = this.submissionUnits.get(operationId);
    if (submission && ['faulted', 'dropped'].includes(submission.state.phase)) throw submission.error;
    const unit = this.unit(this.queryUnits, operationId);
    for (;;) {
      if (!unit.ready()) throw unit.error;
      try {
        const receipt = await this.port.status({ operationId, operationGeneration });
        unit.succeed();
        return receipt;
      } catch (error) {
        const failure = toRemoteKitError(error);
        const delay = unit.fail(failure).delay;
        if (delay !== undefined) {
          await this.wait(delay, scope);
          continue;
        }
        this.publish({ ...this.getSnapshot(), error: failure });
        throw failure;
      }
    }
  }

  private schedule() {
    if (!this.getSnapshot().pending.length) {
      this.pollingAttempts = 0;
      clearTimeout(this.timer);
      this.timer = undefined;
      return;
    }
    if (this.timer || this.pollingScope === this.scope) return;
    const scope = this.scope;
    this.timer = setTimeout(
      async () => {
        this.timer = undefined;
        this.pollingScope = scope;
        try {
          const entries = this.getSnapshot().pending.filter(
            (entry) =>
              !entry.receipt ||
              (['accepted', 'applying', 'unknown'].includes(entry.phase) && !entry.receipt.resolved),
          );
          const receipts = await Promise.allSettled(
            entries
              .filter((entry) => !this.executing.has(entry.operationId))
              .map(async (entry) => ({ entry, receipt: await this.query(entry) })),
          );
          if (scope === this.scope)
            for (const result of receipts) {
              if (result.status === 'rejected') {
                this.publish({ ...this.getSnapshot(), error: toRemoteKitError(result.reason) });
                continue;
              }
              const { entry, receipt } = result.value;
              if (!this.retryReceipt(entry, receipt)) this.receipt(receipt);
            }
        } finally {
          if (this.pollingScope === scope) this.pollingScope = undefined;
          this.schedule();
        }
      },
      Math.min(60_000, 2000 * 2 ** Math.max(0, Math.min(5, this.pollingAttempts++ - 4))),
    );
  }
}
