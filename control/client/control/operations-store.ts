import { errorHandling } from '../../shared/error-policy';
import { RetryUnit } from '../../shared/retry-unit';
import {
  PENDING_CLOSE_DETAIL,
  RemoteKitError,
  STALE_GENERATION_DETAIL,
  parseWireError,
  toRemoteKitError,
  wireError,
} from '../../shared/errors';
import type { OperationReceipt, ProductAction, ProductOperation, ProductState } from '../../shared/product';
import { recordedAction, type RecordedAction } from '../../shared/recorded-action';
import { operationFailure, resolvedFailure } from '../failures/operations';
import { waitForRecovery } from '../failures/recovery';
import { diagnostics } from '../media/diagnostics';
import { canonicalJson } from '../util/canonical-json';
import { shareStructure } from '../util/share-structure';
import { RequestTracker } from '../util/request-tracker';
import { Store } from '../util/store';
import {
  createdIds,
  targetIds,
  operationId,
  operationStanding,
  projectOperations,
  snapshotNewer,
  type PendingOperation,
} from './product-operations';

interface Acknowledgment {
  receipt?: OperationReceipt;
}

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

function isStaleGeneration(receipt: OperationReceipt) {
  const failure = receipt.status === 'failed' ? parseWireError(receipt.error) : undefined;
  return failure?.code === 'conflict' && failure.detail === STALE_GENERATION_DETAIL;
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
  private readonly dependencyUnits = new Map<string, RetryUnit>();
  private readonly acknowledgments = new Map<string, Acknowledgment>();
  /** Operations whose submission may have executed before their receipt generation went stale. */
  private readonly maybeExecuted = new Set<string>();
  private readonly generationWaiters = new Set<{
    generation: string;
    resolve(state: ProductState): void;
    reject(error: RemoteKitError): void;
  }>();
  private unit(units: Map<string, RetryUnit>, id: string) {
    let unit = units.get(id);
    if (!unit) {
      const kind =
        units === this.submissionUnits ? 'submission' : units === this.queryUnits ? 'query' : 'dependency';
      unit = new RetryUnit({
        failed: (error) =>
          diagnostics.record(`operation_${kind}_failed`, {
            id,
            code: error.code,
            errorId: error.errorId,
          }),
        recovered: () => diagnostics.record(`operation_${kind}_recovered`, { id }),
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
    let error = previous.error;
    const pending = previous.pending
      .map((entry) => {
        const receipt = state.operationReceipts?.find(
          (r) => r.operationId === entry.operationId && r.operationGeneration === entry.operationGeneration,
        );
        if (
          receipt &&
          (['accepted', 'applying', 'committed'].includes(receipt.status) ||
            (receipt.status === 'unknown' && receipt.resolved))
        )
          this.acknowledge(receipt);
        if (
          receipt &&
          !this.requests.resolve(entry.operationId, receipt) &&
          this.retryReceipt(entry, receipt)
        )
          return { ...entry, receipt: undefined, phase: 'unsent' as const };
        if (receipt?.status === 'failed' && !this.executing.has(entry.operationId)) this.acknowledge(receipt);
        if (
          receipt &&
          !this.executing.has(entry.operationId) &&
          (receipt.status === 'failed' || (receipt.status === 'unknown' && receipt.resolved))
        ) {
          const failure = parseWireError(receipt.error);
          if (
            failure &&
            failure.code !== 'canceled' &&
            !(failure.code === 'conflict' && failure.detail === PENDING_CLOSE_DETAIL)
          ) {
            if (receipt.resolved) resolvedFailure(failure);
            error = operationFailure(failure, entry.action.type, this.commands.get(entry.operationId));
          }
        }
        return receipt ? { ...entry, receipt, phase: receipt.status } : entry;
      })
      .filter((entry) => this.retain(entry, state));
    this.update(pending, shareStructure(previous.authoritative, state), error);
    for (const waiter of [...this.generationWaiters])
      if (state.operationGeneration && state.operationGeneration !== waiter.generation) {
        this.generationWaiters.delete(waiter);
        waiter.resolve(state);
      }
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
    const targets = new Set(targetIds(command));
    const dependencies = current.pending
      .filter((entry) => createdIds(entry.action).some((id) => targets.has(id) || targets.has(`web:${id}`)))
      .map((entry) => this.acknowledgments.get(entry.operationId)!)
      .filter((entry) => !!entry);
    const operation: OperationIntent = {
      operationId: operationId(),
      operationGeneration: source.operationGeneration!,
      action: recordedAction(command),
      at: Date.now(),
      phase: 'unsent',
    };
    this.commands.set(operation.operationId, command);
    this.acknowledgments.set(operation.operationId, {});
    this.update([...current.pending, operation]);
    return this.execute(operation, command, 0, dependencies);
  };

  private async waitForCreators(operation: OperationIntent, dependencies: Acknowledgment[], scope: number) {
    if (!dependencies.length) return;
    const unit = this.unit(this.dependencyUnits, operation.operationId);
    for (;;) {
      const failure = dependencies.find(
        (entry) =>
          entry.receipt?.status === 'failed' ||
          (entry.receipt?.status === 'unknown' && entry.receipt.resolved),
      )?.receipt;
      if (failure) {
        const error =
          parseWireError(failure.error) ??
          new RemoteKitError('outcome_unknown', 'Creating operation outcome is unknown');
        const command = this.commands.get(operation.operationId);
        this.receipt({ ...operation, status: 'failed', error: wireError(error) });
        throw operationFailure(error, operation.action.type, command);
      }
      if (
        dependencies.every(
          (entry) => entry.receipt && ['accepted', 'applying', 'committed'].includes(entry.receipt.status),
        )
      ) {
        unit.succeed();
        return;
      }
      const { delay } = unit.fail(
        new RemoteKitError('unavailable', 'Waiting for creating operation receipt', { retryAfterMs: 100 }),
      );
      await this.wait(delay!, scope);
    }
  }

  private async execute(
    operation: OperationIntent,
    command: ProductAction,
    initialDelay = 0,
    dependencies: Acknowledgment[] = [],
  ): Promise<OperationReceipt> {
    const scope = this.scope;
    this.executing.add(operation.operationId);
    try {
      if (initialDelay) await this.wait(initialDelay, scope);
      if (dependencies.length) await this.waitForCreators(operation, dependencies, scope);
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
        if (receipt.status !== 'failed') this.maybeExecuted.add(operation.operationId);
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
        if (isStaleGeneration(receipt)) return await this.supersede(operation, command);
        if (
          receipt.status === 'failed' &&
          failure?.code === 'conflict' &&
          failure.detail === PENDING_CLOSE_DETAIL
        ) {
          this.receipt(receipt);
          return receipt;
        }
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
    } catch (cause) {
      if (scope === this.scope)
        this.acknowledge({ ...operation, status: 'failed', error: wireError(toRemoteKitError(cause)) });
      throw cause;
    } finally {
      this.executing.delete(operation.operationId);
      this.cleanCommands();
    }
  }

  private retryReceipt(entry: OperationIntent, receipt: OperationReceipt) {
    if (receipt.error?.code === 'conflict' && receipt.error.detail === PENDING_CLOSE_DETAIL) return false;
    if (this.executing.has(entry.operationId) || receipt.status !== 'failed') return false;
    if (isStaleGeneration(receipt)) return false;
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

  private supersedeInBackground(entry: OperationIntent, command: ProductAction) {
    if (this.executing.has(entry.operationId)) return;
    this.executing.add(entry.operationId);
    void this.supersede(entry, command)
      .catch((error: unknown) => {
        const failure = toRemoteKitError(error);
        diagnostics.record('product-retry', failure);
        if (errorHandling(failure.code) !== 'canceled')
          this.publish({ ...this.getSnapshot(), error: failure });
      })
      .finally(() => {
        this.executing.delete(entry.operationId);
        this.cleanCommands();
      });
  }

  /**
   * A submission carrying a retired generation can never be accepted. It ends here and the
   * operation is judged against the first state of the new generation: a reached target completes,
   * one that provably never executed is reissued under a new identity, anything else fails.
   */
  private async supersede(operation: OperationIntent, command: ProductAction): Promise<OperationReceipt> {
    const scope = this.scope;
    const authoritative = this.getSnapshot().authoritative;
    const state =
      authoritative?.operationGeneration &&
      authoritative.operationGeneration !== operation.operationGeneration
        ? authoritative
        : await new Promise<ProductState>((resolve, reject) => {
            this.generationWaiters.add({ generation: operation.operationGeneration, resolve, reject });
          });
    if (scope !== this.scope) throw new RemoteKitError('canceled', '');
    const standing = operationStanding(state, command);
    if (standing === 'reached') {
      const receipt: OperationReceipt = {
        ...operation,
        status: 'committed',
        revision: state.workspace.revision,
      };
      this.receipt(receipt);
      return receipt;
    }
    if (this.maybeExecuted.has(operation.operationId)) {
      const error = new RemoteKitError('outcome_unknown', '操作结果无法确认，请核对当前工作区');
      const receipt: OperationReceipt = {
        ...operation,
        status: 'unknown',
        resolved: true,
        error: wireError(error),
      };
      this.receipt(receipt);
      return receipt;
    }
    if (standing === 'void')
      throw operationFailure(new RemoteKitError('not_found', '操作目标已不存在'), command.type, command);
    const next: OperationIntent = {
      operationId: operationId(),
      operationGeneration: state.operationGeneration!,
      action: operation.action,
      at: operation.at,
      phase: 'unsent',
    };
    const acknowledgment = this.acknowledgments.get(operation.operationId) ?? {};
    this.acknowledgments.set(next.operationId, acknowledgment);
    this.acknowledgments.delete(operation.operationId);
    this.commands.delete(operation.operationId);
    this.commands.set(next.operationId, command);
    this.update(
      this.getSnapshot().pending.map((entry) => (entry.operationId === operation.operationId ? next : entry)),
    );
    return this.execute(next, command);
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
    this.dependencyUnits.clear();
    this.acknowledgments.clear();
    this.maybeExecuted.clear();
    this.executing.clear();
    for (const waiter of this.generationWaiters) waiter.reject(new RemoteKitError('canceled', ''));
    this.generationWaiters.clear();
    this.publish({ authoritative: null, state: null, pending: [] });
  }

  private receipt(receipt: OperationReceipt) {
    this.acknowledge(receipt);
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
      receipt.status === 'failed' &&
      handling !== 'canceled' &&
      !(failure?.code === 'conflict' && failure.detail === PENDING_CLOSE_DETAIL)
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

  private acknowledge(receipt: OperationReceipt) {
    const entry = this.acknowledgments.get(receipt.operationId);
    if (entry) entry.receipt = receipt;
  }

  private update(
    pending: OperationIntent[],
    authoritative = this.getSnapshot().authoritative,
    error = this.getSnapshot().error,
  ) {
    const projections = pending.filter(
      (entry): entry is OperationIntent & PendingOperation => entry.action.type !== 'page.reply',
    );
    // Unchanged parts keep their references, so a projection the authoritative state confirms
    // renders nothing again.
    const state = shareStructure(this.getSnapshot().state, projectOperations(authoritative, projections));
    this.publish({ authoritative, pending, state, error });
    this.cleanCommands();
    this.schedule();
  }

  private cleanCommands() {
    const pending = new Set(this.getSnapshot().pending.map((entry) => entry.operationId));
    for (const id of this.commands.keys())
      if (!pending.has(id) && !this.executing.has(id)) {
        this.commands.delete(id);
      }
    for (const id of this.acknowledgments.keys())
      if (!pending.has(id) && !this.executing.has(id)) this.acknowledgments.delete(id);
    for (const id of this.maybeExecuted)
      if (!pending.has(id) && !this.executing.has(id)) this.maybeExecuted.delete(id);
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
              const command = this.commands.get(entry.operationId);
              if (isStaleGeneration(receipt) && command) this.supersedeInBackground(entry, command);
              else if (!this.retryReceipt(entry, receipt)) this.receipt(receipt);
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
