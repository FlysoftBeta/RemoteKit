import { randomUUID } from 'node:crypto';
import { errorHandling } from '../../shared/error-policy';
import { RetryUnit } from '../../shared/retry-unit';
import { requireBrowser } from './browser-availability';
import { RemoteKitError } from '../../shared/errors';
import { endpointError } from '../endpoint/gateway';
import { log, reportError } from '../log';
import { wireError } from '../../shared/errors';
import {
  isLocalTab,
  type OperationReceipt,
  type ProductTab,
  type ProductWorkspace,
} from '../../shared/product';
import type { DomainContext, DomainServices } from '../application';
import type { CommandEffect } from './commands';
import { settle } from './operations';
import { pageUsageIdentity } from './workspace';
export interface NavigationAck {
  browserIncarnation: string;
  viewId: string;
  operationId: string;
  operationGeneration: string;
}
export interface SiteReloadStep {
  tenant: string;
  tabId: string;
  /** The tab's reload marker as this step wrote it; a different marker means the tab moved on. */
  identity: NonNullable<ProductTab['pendingUaReloadIdentity']>;
  receipt: OperationReceipt;
  request: Parameters<DomainContext['endpoint']['command']>[1];
}
export class Navigation {
  private readonly acknowledgments = new Map<string, RetryUnit>();
  failures() {
    return [...this.acknowledgments.values()]
      .map((unit) => unit.error)
      .filter((error) => error !== undefined);
  }

  constructor(
    private readonly context: DomainContext,
    private readonly services: Pick<DomainServices, 'policy' | 'viewers' | 'workspace'>,
  ) {}
  async navigate(state: ProductWorkspace, effect: Extract<CommandEffect, { kind: 'navigate' }>) {
    requireBrowser(this.context, state.tenantId, true);
    const tenant = state.tenantId,
      runtime = this.context.tenants.get(tenant),
      t = state.tabs.find((t) => t.id === effect.tabId)!,
      address = effect.url,
      previousKind = effect.previousKind,
      operation = effect.ctx;
    const metadata = operation
      ? {
          operationId: operation.operationId,
          operationGeneration: operation.operationGeneration,
          operationSequence: operation.operationSequence,
        }
      : {};
    const browser = t.navigation?.browserIncarnation ?? runtime.browserIncarnation;
    t.kind = 'remote';
    this.context.store.workspaces.saveWorkspace(state);
    this.context.endpoint.invalidate(tenant);
    const observed = await this.context.endpoint.waitObserved(
      tenant,
      (value) => value.browser === 'running' && value.views.some((view) => view.viewId === t.webviewId),
    );
    if (browser && observed.browserIncarnation !== browser)
      throw new RemoteKitError('outcome_unknown', 'Original navigation Browser was retired');
    if (t.navigation) {
      t.navigation.viewPrepared = true;
      this.context.store.workspaces.saveWorkspace(state);
    }
    await this.context.endpoint.navigate(tenant, {
      viewId: t.webviewId,
      url: address,
      browserIncarnation: browser ?? observed.browserIncarnation ?? undefined,
      ...metadata,
    });
    t.kind = 'remote';
    if (!operation) t.url = address;
    t.pendingUrl = address;
  }
  async command(state: ProductWorkspace, effect: Extract<CommandEffect, { kind: 'command' }>) {
    const t = state.tabs.find((t) => t.id === effect.tabId)!;
    await this.context.endpoint.command(state.tenantId, {
      viewId: t.webviewId,
      command: effect.command,
      browserIncarnation:
        t.navigation?.browserIncarnation ?? this.context.tenants.get(state.tenantId).browserIncarnation,
      ...(effect.ctx
        ? {
            operationId: effect.ctx.operationId,
            operationGeneration: effect.ctx.operationGeneration,
            operationSequence: effect.ctx.operationSequence,
          }
        : {}),
    });
  }

  /**
   * Reloads a tab after its site's UA changed, in three parts for the reconciler: the plan, under
   * the tenant lock, validates and reserves the receipt-backed tab.command; the Browser call runs
   * outside the lock; the commit settles the result under it. The reload's Browser navigation
   * record has a sequence and is settled and acknowledged by `observe`. Only retryable failures
   * are rethrown; anything else ends the reload, never the tenant.
   */
  async reloadForSiteIdentity(state: ProductWorkspace, t: ProductTab, current: unknown, browser: string) {
    const step = this.planSiteIdentityReload(state, t, current, browser);
    if (step) this.commitSiteIdentityReload(state, t, step, await this.callSiteIdentityReload(step));
  }
  planSiteIdentityReload(
    state: ProductWorkspace,
    t: ProductTab,
    current: unknown,
    browser: string,
  ): SiteReloadStep | undefined {
    const tenant = state.tenantId;
    const operations = this.context.store.operations;
    // A replacement Browser creates its views with the current site identity already applied.
    if (
      !current ||
      !URL.canParse(t.url) ||
      new URL(t.url).origin !== t.pendingUaReloadOrigin ||
      (t.pendingUaReloadIdentity && t.pendingUaReloadIdentity.browserIncarnation !== browser)
    )
      return this.finishSiteIdentityReload(state, t);
    let receipt = t.pendingUaReloadIdentity
      ? operations.operation(tenant, t.pendingUaReloadIdentity.operationId)?.receipt
      : undefined;
    if (
      !receipt ||
      receipt.operationGeneration !== t.pendingUaReloadIdentity!.operationGeneration ||
      !receipt.operationSequence
    ) {
      const minted: OperationReceipt = {
        operationId: randomUUID(),
        operationGeneration: operations.operationGeneration(tenant),
        status: 'accepted',
        browserIncarnation: browser,
      };
      try {
        if (
          !operations.reserveOperation(
            tenant,
            { type: 'tab.command', tabId: t.id, command: 'reload' },
            minted,
          )
        )
          return this.finishSiteIdentityReload(state, t, new RemoteKitError('conflict', '操作收据已轮换'));
      } catch (cause) {
        return this.finishSiteIdentityReload(state, t, cause);
      }
      settle(minted, { status: 'applying' });
      t.pendingUaReloadIdentity = {
        operationId: minted.operationId,
        operationGeneration: minted.operationGeneration,
        browserIncarnation: browser,
      };
      operations.saveOperation(state, minted);
      receipt = minted;
    }
    return {
      tenant,
      tabId: t.id,
      identity: t.pendingUaReloadIdentity!,
      receipt,
      request: {
        viewId: t.webviewId,
        command: 'reload',
        browserIncarnation: browser,
        operationId: receipt.operationId,
        operationGeneration: receipt.operationGeneration,
        operationSequence: receipt.operationSequence,
      },
    };
  }
  /** The Browser call of a reload. Needs no product state, so it runs outside the tenant lock. */
  async callSiteIdentityReload(step: SiteReloadStep): Promise<{ failure?: unknown }> {
    try {
      await this.context.endpoint.command(step.tenant, step.request);
      return {};
    } catch (failure) {
      return { failure };
    }
  }
  /**
   * Settles a reload under the tenant lock. The tab's reload marker is cleared only while it is
   * still the one this step sent; the receipt is settled either way.
   */
  commitSiteIdentityReload(
    state: ProductWorkspace,
    t: ProductTab | undefined,
    step: SiteReloadStep,
    outcome: { failure?: unknown },
  ) {
    const owned = !!t && t.pendingUaReloadIdentity?.operationId === step.identity.operationId;
    if (outcome.failure === undefined) {
      if (owned) this.finishSiteIdentityReload(state, t);
      return;
    }
    const error = endpointError(outcome.failure);
    if (['retry-soon', 'retry-after', 'backoff', 'reconcile'].includes(errorHandling(error.code)))
      throw error;
    settle(step.receipt, { status: 'failed', error: wireError(error) });
    this.context.store.operations.saveOperation(state, step.receipt);
    if (owned) this.finishSiteIdentityReload(state, t, error);
  }
  private finishSiteIdentityReload(state: ProductWorkspace, t: ProductTab, cause?: unknown): undefined {
    delete t.pendingUaReloadOrigin;
    delete t.pendingUaReloadIdentity;
    const error = cause === undefined ? undefined : endpointError(cause);
    if (error && error.code !== 'canceled')
      reportError(error, 'site.ua_reload_failed', { tenant: state.tenantId, tab: t.id });
    this.context.store.workspaces.saveWorkspace(state);
    this.services.viewers.push(state.tenantId);
  }

  observeRetired(state: ProductWorkspace, snapshot: any) {
    const tenant = state.tenantId;
    for (const tab of state.tabs) {
      const nav = tab.navigation;
      if (
        nav &&
        !nav.resolved &&
        ['applying', 'unknown'].includes(nav.status) &&
        nav.browserIncarnation &&
        (snapshot.running === false ||
          (typeof snapshot.browserIncarnation === 'string' &&
            snapshot.browserIncarnation !== nav.browserIncarnation))
      ) {
        nav.status = 'unknown';
        nav.resolved = true;
        tab.kind = nav.previousKind;
        tab.url = nav.previousUrl;
        if (isLocalTab(tab)) tab.loading = false;
        delete tab.pendingUrl;
        const saved = this.context.store.operations.operation(tenant, nav.operationId);
        if (saved && !['committed', 'failed'].includes(saved.receipt.status)) {
          settle(saved.receipt, { status: 'unknown' });
          saved.receipt.resolved = true;
          saved.receipt.resolution = 'target-retired';
          saved.receipt.error = { code: 'outcome_unknown', message: '原页面实例已结束，导航执行结果未知' };
          delete saved.receipt.application;
          this.context.store.operations.saveOperation(state, saved.receipt);
        }
      }
    }
  }
  /** Projects terminal navigation results into the product; returns what the Browser must be told. */
  observe(state: ProductWorkspace, t: ProductTab, current: any, snapshot: any): NavigationAck[] {
    const tenant = state.tenantId;
    const acks: NavigationAck[] = [];
    if (t.navigation && !t.navigation.resolved && ['applying', 'unknown'].includes(t.navigation.status)) {
      const nav = t.navigation,
        terminal = (current.navigationOperations ?? []).find(
          (entry: any) =>
            entry.operationId === nav.operationId &&
            entry.operationGeneration === nav.operationGeneration &&
            ['committed', 'cancelled', 'failed', 'superseded'].includes(entry.state),
        );
      if (terminal) {
        const operation = this.context.store.operations.operation(tenant, nav.operationId),
          committed = terminal.state === 'committed';
        nav.status = committed ? 'committed' : 'rejected';
        // Failure and document commit are independent. A real Chromium
        // error document must remain visible even when its receipt rejects.
        if (committed || terminal.documentCommitted === true) {
          t.kind = 'remote';
          t.url = typeof terminal.url === 'string' ? terminal.url : (t.pendingUrl ?? t.url);
          if (committed && terminal.documentCommitted === true && terminal.isErrorPage !== true)
            this.services.workspace.recordPage(state, t, current, snapshot.browserIncarnation);
          if (!committed) t.usageDocument = pageUsageIdentity(t, current, snapshot.browserIncarnation);
        } else {
          t.kind = nav.previousKind;
          t.url = nav.previousUrl;
          if (isLocalTab(t)) t.loading = false;
        }
        delete t.pendingUrl;
        if (!committed) delete t.usageSource;
        if (operation) {
          settle(
            operation.receipt,
            committed
              ? { status: 'committed' }
              : {
                  status: 'failed',
                  error: terminal.error
                    ? wireError(
                        reportError(endpointError(terminal.error), 'navigation.failed', {
                          tenant,
                          operation: terminal.operationId,
                        }),
                      )
                    : {
                        code: terminal.state === 'cancelled' ? 'canceled' : 'conflict',
                        message: '导航未完成',
                      },
                },
          );
          this.context.store.operations.saveOperation(state, operation.receipt);
        }
      }
    }
    for (const terminal of current.navigationOperations ?? [])
      if (['committed', 'cancelled', 'failed', 'superseded'].includes(terminal.state)) {
        const saved = this.context.store.operations.operation(tenant, terminal.operationId);
        if (
          !saved ||
          saved.receipt.operationGeneration !== terminal.operationGeneration ||
          saved.receipt.resolved ||
          (saved.receipt.browserIncarnation &&
            saved.receipt.browserIncarnation !== snapshot.browserIncarnation)
        )
          continue;
        const action = saved.action;
        if ((action.type !== 'tab.navigate' && action.type !== 'tab.command') || action.tabId !== t.id)
          continue;
        if (!['committed', 'failed'].includes(saved.receipt.status)) {
          settle(
            saved.receipt,
            terminal.state === 'committed'
              ? { status: 'committed' }
              : {
                  status: 'failed',
                  error: terminal.error
                    ? wireError(
                        reportError(endpointError(terminal.error), 'navigation.failed', {
                          tenant,
                          operation: terminal.operationId,
                        }),
                      )
                    : {
                        code: terminal.state === 'cancelled' ? 'canceled' : 'conflict',
                        message: '导航未完成',
                      },
                },
          );
          this.context.store.operations.saveOperation(state, saved.receipt);
        }
        acks.push({
          browserIncarnation: snapshot.browserIncarnation,
          viewId: t.webviewId,
          operationId: terminal.operationId,
          operationGeneration: terminal.operationGeneration,
        });
      }
    return acks;
  }
  /** Sends the acknowledgments `observe` returned; it holds no product state, so it runs outside the tenant lock. */
  async acknowledge(tenant: string, acks: NavigationAck[]) {
    for (const ack of acks) {
      const key = JSON.stringify([tenant, ack.operationGeneration, ack.operationId]);
      let unit = this.acknowledgments.get(key);
      if (!unit) {
        unit = new RetryUnit({
          failed: (error) =>
            reportError(error, 'navigation.ack_failed', { tenant, operation: ack.operationId }),
          recovered: () => log.info('navigation.ack_recovered', { tenant, operation: ack.operationId }),
        });
        this.acknowledgments.set(key, unit);
      }
      if (!unit.ready(ack.browserIncarnation)) continue;
      try {
        await this.context.endpoint.ackNavigation(tenant, ack);
        unit.succeed();
        this.acknowledgments.delete(key);
      } catch (cause) {
        unit.fail(endpointError(cause));
      }
    }
  }
}
