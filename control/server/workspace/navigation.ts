import { RemoteKitError } from '../../shared/errors';
import { endpointError } from '../endpoint/gateway';
import { reportError } from '../log';
import { wireError } from '../../shared/errors';
import { isLocalTab, type ProductTab, type ProductWorkspace } from '../../shared/product';
import type { DomainContext, DomainServices } from '../application';
import type { CommandEffect } from './commands';
import { settle } from './operations';
import { pageUsageIdentity } from './workspace';
export class Navigation {
  constructor(
    private readonly context: DomainContext,
    private readonly services: Pick<DomainServices, 'policy' | 'workspace'>,
  ) {}
  async navigate(state: ProductWorkspace, effect: Extract<CommandEffect, { kind: 'navigate' }>) {
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
    await this.context.endpoint.synchronize(tenant);
    const observed = await this.context.endpoint.waitObserved(
      tenant,
      (value) => value.browser === 'running' && value.views.some((view) => view.viewId === t.webviewId),
    );
    if (browser && observed.browserIncarnation !== browser)
      throw new RemoteKitError('outcome_unknown', 'Original navigation Browser was retired');
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
  async observe(state: ProductWorkspace, t: ProductTab, current: any, snapshot: any) {
    const tenant = state.tenantId;
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
        await this.context.endpoint
          .ackNavigation(tenant, {
            browserIncarnation: snapshot.browserIncarnation,
            viewId: t.webviewId,
            operationId: terminal.operationId,
            operationGeneration: terminal.operationGeneration,
          })
          .catch(() => {});
      }
  }
}
