import { requireBrowser } from './browser-availability';
import { operationPayload } from '../persistence/operations';
import { reportError } from '../log';
import { randomUUID } from 'node:crypto';
import { RemoteKitError, toRemoteKitError, wireError } from '../../shared/errors';
import { retryDelay } from '../../shared/error-policy';
import { recordedAction } from '../../shared/recorded-action';
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
export class OperationPipeline {
  constructor(
    private readonly context: DomainContext,
    private readonly services: Pick<
      DomainServices,
      'navigation' | 'pageRequests' | 'policy' | 'reconciler' | 'viewers' | 'workspace'
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
      return {
        ...operation,
        status: 'failed',
        error: { code: 'conflict', message: '操作收据代次已过期，请核对当前工作区' },
      };
    return (
      this.context.store.operations.operation(tenant, operation.operationId)?.receipt ?? {
        ...operation,
        status: 'unknown',
        error: { code: 'outcome_unknown', message: '尚无操作收据' },
      }
    );
  }
  async submitOperation(
    tenant: string,
    operation: ProductOperation,
    lease: string,
    epoch = this.context.tenants.get(tenant).viewer?.security?.epoch,
  ): Promise<OperationReceipt> {
    const runtime = this.context.tenants.get(tenant);
    return this.context.tenants.serial(tenant, async () => {
      this.services.viewers.assertProductViewer(tenant, lease, epoch);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          operation.operationId,
        ) ||
        !operation.action
      )
        throw new RemoteKitError('invalid_request', '无效产品操作');
      if (JSON.stringify(operation.action).length > 32768)
        throw new RemoteKitError('limit_exceeded', '产品操作超出大小限制');
      if (operation.operationGeneration !== this.context.store.operations.operationGeneration(tenant))
        return {
          operationId: operation.operationId,
          operationGeneration: operation.operationGeneration,
          status: 'failed',
          error: { code: 'conflict', message: '操作收据代次已过期' },
        };
      const recorded = recordedAction(operation.action);
      let payload: string;
      try {
        payload = operationPayload(recorded, `operation_receipts.payload ${tenant}/${operation.operationId}`);
      } catch (error) {
        if (error instanceof RemoteKitError && error.reason === 'corrupt_record')
          throw new RemoteKitError('invalid_request', '无效产品操作', { detail: error.detail, cause: error });
        throw error;
      }
      const existing = this.context.store.operations.operation(tenant, operation.operationId);
      if (existing) {
        if (existing.payload !== payload) throw new RemoteKitError('conflict', '同一操作ID不能用于不同内容');
        if (
          existing.receipt.status !== 'failed' ||
          !existing.receipt.error ||
          retryDelay(existing.receipt.error, 0) === undefined
        )
          return existing.receipt;
      }
      const receipt: OperationReceipt = {
        ...(existing?.receipt ?? {}),
        operationId: operation.operationId,
        operationGeneration: operation.operationGeneration,
        status: 'accepted',
        ...([
          'tab.navigate',
          'tab.command',
          'tab.close',
          'window.close',
          'space.close',
          'app.uninstall',
          'page.reply',
          'page.exitFullscreen',
        ].includes(operation.action.type)
          ? { browserIncarnation: runtime.browserIncarnation }
          : {}),
      };
      if (!existing && !this.context.store.operations.reserveOperation(tenant, recorded, receipt)) {
        this.services.viewers.push(tenant);
        return {
          ...receipt,
          status: 'failed',
          error: { code: 'conflict', message: '操作收据已轮换，请核对工作区' },
        };
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
        if (observed && ['committed', 'failed'].includes(observed.status)) settle(receipt, observed);
        if (!['committed', 'failed'].includes(receipt.status)) {
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
            (a.type === 'window.close' && current.windows.some((window) => window.id === a.windowId)) ||
            (a.type === 'space.close' && current.spaces.some((space) => space.id === a.spaceId)) ||
            (a.type === 'app.uninstall' && current.apps.some((app) => 'web:' + app.id === a.appId))
          ) {
            settle(receipt, { status: 'applying' });
            receipt.application = { status: 'pending', reason: '关闭已受理，等待页面确认' };
          }
        }
      } catch (error) {
        const durable = this.context.store.operations.operation(tenant, operation.operationId)?.receipt;
        if (durable && ['committed', 'failed'].includes(durable.status)) {
          settle(receipt, durable);
        } else {
          const failure = reportError(toRemoteKitError(error), 'operation.failed', {
            tenant,
            operation: operation.operationId,
          });
          settle(receipt, {
            status: ['outcome_unknown', 'internal'].includes(failure.code) ? 'unknown' : 'failed',
            error: wireError(failure),
          });
          const workspace = this.context.store.workspaces.workspace(tenant);
          for (const tab of workspace.tabs)
            if (tab.navigation?.operationId === operation.operationId) {
              tab.navigation.status = ['outcome_unknown', 'internal'].includes(failure.code)
                ? 'unknown'
                : 'rejected';
              if (!['outcome_unknown', 'internal'].includes(failure.code)) {
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
    if (
      body.type === 'window.open' &&
      body.appId === 'admin' &&
      !this.context.store.accounts.userForTenant(tenant)?.isAdmin
    )
      throw new RemoteKitError('forbidden', '需要管理员权限');
    const runtime = this.context.tenants.get(tenant);
    const before = this.context.store.workspaces.workspace(tenant);
    const icon =
      body.type === 'app.install' || body.type === 'app.update'
        ? this.services.workspace.appIcon(tenant, body.iconToken)
        : undefined;
    const plan = applyCommand(before, body, {
      execution,
      browserIncarnation: runtime.browserIncarnation,
      ids: [randomUUID(), randomUUID(), randomUUID(), randomUUID()],
      now: this.context.clock.wallMs(),
      appIcon: icon,
      viewId: ['window.open', 'tab.create'].includes(body.type) ? this.context.store.workspaces.viewId() : '',
    });
    const state = plan.workspace;
    let application = plan.application;
    if (receipt && plan.effects.length === 0) settle(receipt, { status: 'committed', application });
    this.context.store.transaction(() => {
      this.services.workspace.recordAction(before, state, body);
      if (receipt) this.context.store.operations.saveOperation(state, receipt);
      else this.context.store.workspaces.saveWorkspace(state);
      if (icon) {
        const app =
          body.type === 'app.update'
            ? state.apps.find((app) => 'web:' + app.id === body.appId)
            : state.apps.find((app) => !before.apps.some((old) => old.id === app.id));
        if (app) this.context.store.workspaces.items.setAppIcon(tenant, app.id, icon.png);
      }
    });
    this.services.viewers.push(tenant);
    for (const effect of plan.effects) {
      if (['navigate', 'command', 'replyClose', 'replyPage', 'exitFullscreen'].includes(effect.kind))
        requireBrowser(this.context, tenant, effect.kind === 'navigate');
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
      (action.type === 'window.close' && state.windows.some((w) => w.id === action.windowId)) ||
      (action.type === 'space.close' && state.spaces.some((space) => space.id === action.spaceId)) ||
      (action.type === 'app.uninstall' && state.apps.some((app) => 'web:' + app.id === action.appId));
    if (receipt && !['tab.navigate', 'tab.command'].includes(action.type) && !closePending)
      settle(receipt, { status: 'committed', application });
    this.saveWorkspace(state, receipt);
    this.context.endpoint.invalidate(tenant);
    if (plan.siteUaChanged) {
      const latest = this.context.store.workspaces.workspace(tenant);
      if (
        this.context.endpoint.observation(tenant)?.applied.sitePreferencesRevision ===
          this.context.endpoint.observation(tenant)?.observedRevision &&
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
export type ReceiptOutcome = Pick<OperationReceipt, 'application' | 'resolved' | 'resolution'> &
  (
    | { status: 'failed'; error: NonNullable<OperationReceipt['error']> }
    | { status: Exclude<OperationReceipt['status'], 'failed'>; error?: OperationReceipt['error'] }
  );
export function settle(receipt: OperationReceipt, outcome: ReceiptOutcome): OperationReceipt {
  receipt.status = outcome.status;
  if (outcome.status !== 'failed' && outcome.status !== 'unknown') delete receipt.error;
  if (['committed', 'failed'].includes(outcome.status) || outcome.resolved) delete receipt.application;
  for (const [key, value] of Object.entries(outcome)) {
    if (value === undefined) delete (receipt as unknown as Record<string, unknown>)[key];
    else (receipt as unknown as Record<string, unknown>)[key] = value;
  }
  return receipt;
}
