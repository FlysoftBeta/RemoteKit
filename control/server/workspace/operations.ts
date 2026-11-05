import { randomUUID } from 'node:crypto';
import { RemoteKitError, toRemoteKitError } from '../../shared/errors';
import type { ViewerAuthority } from '../viewers/viewer-hub';
import { applyCommand } from './commands';

import type {
  OperationReceipt,
  ProductAction,
  ProductActionResult,
  ProductOperation,
  ProductWorkspace,
} from '../../shared/product';
import { isLocalTab } from '../../shared/product';
import type { DomainContext, DomainServices } from '../application';
function operationPayload(value: unknown): string {
  const canonical = (input: any): any =>
    Array.isArray(input)
      ? input.map(canonical)
      : input && typeof input === 'object'
        ? Object.fromEntries(
            Object.keys(input)
              .sort()
              .map((key) => [key, canonical(input[key])]),
          )
        : input;
  return JSON.stringify(canonical(value));
}

export class OperationPipeline {
  constructor(
    private readonly context: DomainContext,
    private readonly services: Pick<
      DomainServices,
      'navigation' | 'pageRequests' | 'policy' | 'reconciler' | 'viewers'
    >,
  ) {}

  saveWorkspace(state: ProductWorkspace, receipt?: OperationReceipt) {
    if (receipt) this.context.store.operations.saveOperation(state, receipt);
    else this.context.store.workspaces.saveWorkspace(state);
    this.services.viewers.push(state.tenantId);
  }
  run(ctx: ExecutionContext, action: ProductAction) {
    const receipt = this.context.store.operations.operation(ctx.tenantId, ctx.operationId)!.receipt;
    this.services.viewers.assertProductViewer(ctx.tenantId, ctx.authority.leaseId, ctx.authority.epoch);
    return this.applyProductAction(ctx.tenantId, action, ctx, receipt);
  }
  operationStatus(
    tenant: string,
    operation: { operationId: string; operationGeneration: string },
  ): OperationReceipt {
    if (operation.operationGeneration !== this.context.store.operations.operationGeneration(tenant))
      return { ...operation, status: 'expired', error: '操作收据代次已过期，请核对当前工作区' };
    return (
      this.context.store.operations.operation(tenant, operation.operationId)?.receipt ?? {
        ...operation,
        status: 'unknown',
        error: '尚无操作收据',
      }
    );
  }
  async handleEndpointAction(
    event: ProductOperation & { tenantId: string; connectionId: string; authEpoch?: number },
  ) {
    if (this.context.closed) return;
    const { tenantId: tenant, connectionId } = event,
      lease = this.context.tenants.forConnection(connectionId)?.connectionLease;
    if (!lease || this.context.tenants.get(tenant).connectionId !== connectionId) return;
    const security = this.context.tenants.get(tenant).viewer?.security;
    if (
      security &&
      (!this.services.viewers.productAllowed(tenant, lease) ||
        !event.authEpoch ||
        event.authEpoch !== security.peer?.appliedEpoch)
    )
      return;
    let receipt: OperationReceipt;
    try {
      receipt = await this.submitOperation(tenant, event, lease, connectionId);
    } catch (error) {
      receipt = {
        operationId: event.operationId,
        operationGeneration: event.operationGeneration,
        status: 'rejected',
        error: toRemoteKitError(error).message,
      };
    }
    // A replaced peer never receives a late result from an accepted old operation.
    if (
      this.context.tenants.get(tenant).connectionId !== connectionId ||
      !this.services.viewers.productAllowed(tenant, lease) ||
      (security && event.authEpoch !== security.peer?.appliedEpoch)
    )
      return;
    await this.context.endpoint
      .actionResult(tenant, {
        connectionId,
        ...(event.authEpoch !== undefined ? { authEpoch: event.authEpoch } : {}),
        operationId: event.operationId,
        operationGeneration: event.operationGeneration,
        ok: !['rejected', 'expired'].includes(receipt.status),
        result: receipt,
      })
      .catch(() => {});
  }
  async submitOperation(
    tenant: string,
    operation: ProductOperation,
    lease: string,
    connectionId?: string,
  ): Promise<OperationReceipt> {
    const runtime = this.context.tenants.get(tenant);
    const epoch = runtime.viewer?.security?.epoch;
    return this.context.tenants.serial(tenant, async () => {
      this.services.viewers.assertProductViewer(tenant, lease, epoch);
      if (connectionId && runtime.connectionId !== connectionId)
        throw new RemoteKitError('conflict', 'RTC连接已被替换');
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          operation.operationId,
        ) ||
        !operation.action ||
        JSON.stringify(operation.action).length > 32768
      )
        throw new RemoteKitError('invalid_request', '无效产品操作');
      if (operation.operationGeneration !== this.context.store.operations.operationGeneration(tenant))
        return {
          operationId: operation.operationId,
          operationGeneration: operation.operationGeneration,
          status: 'expired',
          error: '操作收据代次已过期',
        };
      const payload = operationPayload(operation.action),
        existing = this.context.store.operations.operation(tenant, operation.operationId);
      if (existing) {
        if (existing.payload !== payload) throw new RemoteKitError('conflict', '同一操作ID不能用于不同内容');
        return existing.receipt;
      }
      const receipt: OperationReceipt = {
        operationId: operation.operationId,
        operationGeneration: operation.operationGeneration,
        status: 'accepted',
        ...([
          'tab.navigate',
          'tab.command',
          'tab.close',
          'window.close',
          'page.reply',
          'page.exitFullscreen',
        ].includes(operation.action.type)
          ? { browserIncarnation: runtime.browserIncarnation }
          : {}),
      };
      if (!this.context.store.operations.reserveOperation(tenant, payload, receipt)) {
        this.services.viewers.push(tenant);
        return { ...receipt, status: 'expired', error: '操作收据已轮换，请核对工作区' };
      }
      settle(receipt, { status: 'applying' });
      this.context.store.operations.saveOperation(this.context.store.workspaces.workspace(tenant), receipt);

      try {
        const ctx: ExecutionContext = {
          tenantId: tenant,
          authority: { tenantId: tenant, leaseId: lease, epoch: epoch! },
          operationId: receipt.operationId,
          operationGeneration: receipt.operationGeneration,
          operationSequence: receipt.operationSequence!,
        };
        const result = await this.run(ctx, operation.action);
        const observed = this.context.store.operations.operation(tenant, receipt.operationId)?.receipt;
        if (observed && ['committed', 'rejected'].includes(observed.status)) settle(receipt, observed);
        if (!['committed', 'rejected'].includes(receipt.status)) {
          settle(receipt, {
            status:
              ['tab.navigate', 'tab.command'].includes(operation.action.type) && result.application
                ? 'applying'
                : 'committed',
          });
          if (result.application) receipt.application = result.application;
          const current = this.context.store.workspaces.workspace(tenant),
            a = operation.action;
          if (
            (a.type === 'tab.close' && !a.cancel && current.tabs.some((tab) => tab.id === a.tabId)) ||
            (a.type === 'window.close' && current.windows.some((window) => window.id === a.windowId))
          ) {
            settle(receipt, { status: 'applying' });
            receipt.application = { status: 'pending', reason: '关闭已受理，等待页面确认' };
          }
        }
      } catch (error) {
        const durable = this.context.store.operations.operation(tenant, operation.operationId)?.receipt;
        if (durable && ['committed', 'rejected'].includes(durable.status)) {
          settle(receipt, durable);
        } else {
          settle(receipt, {
            status: toRemoteKitError(error).code === 'outcome_unknown' ? 'unknown' : 'rejected',
          });
          receipt.error = toRemoteKitError(error).message;
          const workspace = this.context.store.workspaces.workspace(tenant);
          for (const tab of workspace.tabs)
            if (tab.navigation?.operationId === operation.operationId) {
              tab.navigation.status = receipt.status === 'rejected' ? 'rejected' : 'unknown';
              if (receipt.status === 'rejected') {
                tab.kind = tab.navigation.previousKind;
                tab.url = tab.navigation.previousUrl;
                if (isLocalTab(tab)) tab.loading = false;
                delete tab.pendingUrl;
              }
            }
          this.context.store.operations.saveOperation(workspace, receipt);
        }
      } finally {
        this.context.store.operations.saveOperation(this.context.store.workspaces.workspace(tenant), receipt);
        this.services.viewers.push(tenant);
      }
      return receipt;
    });
  }
  async productAction(tenant: string, body: ProductAction, lease?: string): Promise<ProductActionResult> {
    const epoch = this.context.tenants.get(tenant).viewer?.security?.epoch;
    return this.context.tenants.serial(tenant, async () => {
      if (lease) this.services.viewers.assertProductViewer(tenant, lease, epoch);
      return this.applyProductAction(tenant, body).catch((error) => {
        throw toRemoteKitError(error);
      });
    });
  }

  async applyProductAction(
    tenant: string,
    body: ProductAction,
    execution?: ExecutionContext,
    receipt?: OperationReceipt,
  ): Promise<ProductActionResult> {
    const runtime = this.context.tenants.get(tenant);
    const plan = applyCommand(this.context.store.workspaces.workspace(tenant), body, {
      execution,
      browserIncarnation: runtime.browserIncarnation,
      ids: [randomUUID(), randomUUID()],
      viewId: ['window.create', 'tab.create', 'tab.files'].includes(body.type)
        ? this.context.store.workspaces.viewId()
        : '',
    });
    const state = plan.workspace;
    let application = plan.application;
    if (receipt && plan.effects.length === 0) settle(receipt, { status: 'committed', application });
    this.saveWorkspace(state, receipt);
    for (const effect of plan.effects) {
      switch (effect.kind) {
        case 'navigate':
          await this.services.navigation.navigate(state, effect);
          break;
        case 'command':
          await this.services.navigation.command(state, effect);
          break;
        case 'closeWindow':
          await this.services.pageRequests.continueWindowClose(state);
          break;
        case 'closeTab':
          await this.services.pageRequests.closeProductTab(
            state,
            state.tabs.find((t) => t.id === effect.tabId)!,
          );
          break;
        case 'replyClose':
          await this.services.pageRequests.confirmClose(
            state,
            effect.tabId,
            effect.accept,
            execution?.operationId,
          );
          break;
        case 'replyPage':
          await this.services.pageRequests.replyDialog(state, effect);
          break;
        case 'exitFullscreen':
          await this.services.pageRequests.exitFullscreen(state, effect);
          break;
      }
    }
    const action = body as any;
    const closePending =
      (action.type === 'tab.close' && !action.cancel && state.tabs.some((t) => t.id === action.tabId)) ||
      (action.type === 'window.close' && state.windows.some((w) => w.id === action.windowId));
    if (receipt && !['tab.navigate', 'tab.command'].includes(action.type) && !closePending)
      settle(receipt, { status: 'committed', application });
    this.saveWorkspace(state, receipt);
    if (action.type !== 'site.set' || plan.siteUaChanged)
      await this.services.reconciler.reconcileProduct(tenant).catch(() => {});
    if (plan.siteUaChanged) {
      const latest = this.context.store.workspaces.workspace(tenant);
      if (
        runtime.policy.site?.applied &&
        (!action.tabId || !latest.tabs.find((t) => t.id === action.tabId)?.pendingUaReloadOrigin)
      )
        application = undefined;
      else
        application = { status: 'pending', reason: '设置已保存，应用成功后刷新当前页；其他页面下次加载生效' };
    }
    this.services.viewers.push(tenant);
    return { state: this.services.viewers.productState(tenant), ...(application ? { application } : {}) };
  }
}

export interface ExecutionContext {
  tenantId: string;
  authority: ViewerAuthority;
  operationId: string;
  operationGeneration: string;
  operationSequence: string;
}
export type ReceiptOutcome = Pick<
  OperationReceipt,
  'status' | 'application' | 'error' | 'resolved' | 'resolution'
>;
export function settle(receipt: OperationReceipt, outcome: ReceiptOutcome): OperationReceipt {
  receipt.status = outcome.status;
  if (['committed', 'rejected', 'expired'].includes(outcome.status) || outcome.resolved)
    delete receipt.application;
  for (const [key, value] of Object.entries(outcome)) {
    if (value === undefined) delete (receipt as unknown as Record<string, unknown>)[key];
    else (receipt as unknown as Record<string, unknown>)[key] = value;
  }
  return receipt;
}
