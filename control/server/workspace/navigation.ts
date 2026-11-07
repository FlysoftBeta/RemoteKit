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
    if (isLocalTab({ kind: previousKind })) {
      const snapshot = await this.context.endpoint.snapshot(tenant),
        exists = (snapshot.views ?? []).some((view: any) => view.viewId === t.webviewId);
      const region = runtime.viewer?.viewport?.windows.find((w) => w.windowId === t.windowId);
      if (exists)
        await this.context.endpoint.navigate(tenant, {
          viewId: t.webviewId,
          url: address,
          ...metadata,
        });
      else
        await this.context.endpoint.ensureView(tenant, {
          viewId: t.webviewId,
          url: address,
          width: region?.width ?? 1440,
          height: region?.height ?? 900,
          device: {
            mode: 'desktop',
            deviceScaleFactor: this.services.policy.qualityFor(tenant, state).effectiveDpr,
          },
          visible: false,
          ...metadata,
        });
    } else
      await this.context.endpoint.navigate(tenant, {
        viewId: t.webviewId,
        url: address,
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
        if (saved && !['committed', 'rejected'].includes(saved.receipt.status)) {
          settle(saved.receipt, { status: 'unknown' });
          saved.receipt.resolved = true;
          saved.receipt.resolution = 'target-retired';
          saved.receipt.error = '原页面实例已结束，导航执行结果未知';
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
          settle(operation.receipt, { status: committed ? 'committed' : 'rejected' });
          delete operation.receipt.application;
          if (!committed)
            operation.receipt.error =
              terminal.state === 'cancelled' ? '导航已取消' : '导航未完成：' + terminal.state;
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
        const action = JSON.parse(saved.payload);
        if (!['tab.navigate', 'tab.command'].includes(action.type) || action.tabId !== t.id) continue;
        if (!['committed', 'rejected'].includes(saved.receipt.status)) {
          settle(saved.receipt, { status: terminal.state === 'committed' ? 'committed' : 'rejected' });
          delete saved.receipt.application;
          if (saved.receipt.status === 'rejected')
            saved.receipt.error = terminal.error ?? '导航未完成：' + terminal.state;
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
