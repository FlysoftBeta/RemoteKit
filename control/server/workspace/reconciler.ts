import { RemoteKitError, toRemoteKitError } from '../../shared/errors';
import { settle } from './operations';

import type { ProductTab } from '../../shared/product';
import { isLocalTab } from '../../shared/product';
import type { DomainContext, DomainServices } from '../application';

export class Reconciler {
  constructor(
    private readonly context: DomainContext,
    private readonly services: Pick<
      DomainServices,
      | 'navigation'
      | 'lifecycle'
      | 'operations'
      | 'pageRequests'
      | 'policy'
      | 'popups'
      | 'rtc'
      | 'security'
      | 'viewers'
    >,
  ) {}
  async tick() {
    const active = this.context.store.db
      .prepare("SELECT tenant FROM session_placements WHERE state='active'")
      .all() as { tenant: string }[];
    for (const { tenant } of active) this.context.tenants.get(tenant).started = true;
    const work = this.context.tenants.activeTenants().map((tenant) => {
      const tracking = this.context.tenants.get(tenant).reconciliation;
      const running = tracking.inflight;
      if (running) return running;
      const task = this.context.tenants
        .serial(tenant, async () => {
          if (this.context.tenants.get(tenant).pendingRtcCheck)
            await this.services.rtc.checkReconnectedRtc(tenant);
          await this.reconcileProduct(tenant);
        })
        .catch(() => {})
        .finally(() => delete tracking.inflight);
      tracking.inflight = task;
      return task;
    });
    await Promise.all(work);
  }
  private runtimesForNode(nodeId?: string) {
    return this.context.tenants.values().filter((runtime) => {
      const placement = this.context.endpoint.placement.peek(runtime.tenantId);
      return !nodeId || !placement || placement.nodeId === nodeId;
    });
  }
  async endpointReady(identity?: { processChanged: boolean; nodeId?: string }) {
    if (identity?.processChanged !== false) return this.reconcileAll(identity?.nodeId);
    const runtimes = this.runtimesForNode(identity.nodeId);
    for (const runtime of runtimes) {
      this.services.pageRequests.clearAuthorization(runtime.tenantId);
      this.services.policy.reset(runtime.tenantId);
      if (runtime.connectionId || runtime.rtc.disconnectedPeer) runtime.pendingRtcCheck = true;
    }
    for (const runtime of runtimes.filter((runtime) => runtime.viewer || runtime.started)) {
      const tenant = runtime.tenantId;
      await this.context.tenants.serial(tenant, async () => {
        try {
          await this.services.rtc.checkReconnectedRtc(tenant);
          await this.reconcileProduct(tenant);
        } catch (error) {
          this.context.tenants.get(tenant).lastError = toRemoteKitError(error).message;
        }
        this.services.viewers.push(tenant);
      });
    }
  }
  async reconcileAll(nodeId?: string) {
    const runtimes = this.runtimesForNode(nodeId);
    for (const runtime of runtimes) {
      if (runtime.viewer) this.services.security.forgetPeer(runtime.tenantId, runtime.viewer.security);
      const generation = this.context.tenants.mediaGeneration(runtime.tenantId) + 1;
      runtime.resetEndpoint();
      runtime.mediaGeneration = generation;
    }
    for (const runtime of runtimes.filter((runtime) => runtime.viewer)) {
      const tenant = runtime.tenantId;
      await this.context.tenants
        .serial(tenant, async () => {
          const viewer = this.context.tenants.get(tenant).viewer;
          if (viewer?.security) {
            this.context.events.emit(
              'auth',
              tenant,
              viewer.id,
              this.services.viewers.authState(tenant, viewer.security),
            );
            void this.services.security.capabilities(tenant, viewer.security);
          }
          await this.reconcileProduct(tenant);
          this.services.viewers.push(tenant);
        })
        .catch(() => {});
    }
  }
  async reconcileProduct(tenant: string) {
    const runtime = this.context.tenants.get(tenant);
    if (!(runtime.viewer !== undefined) && !runtime.started) return;
    try {
      if (!(runtime.viewer !== undefined)) {
        await this.observeOffline(tenant);
        return;
      }
      const desired = this.context.store.workspaces.workspace(tenant);
      let resourceLimitation = this.services.policy.qualityFor(tenant, desired).resourceLimitation;
      if (!resourceLimitation) {
        // This operation caches preferences without starting an offline Browser.
        await this.services.policy.applySites(tenant, desired);
        await this.services.policy.applyMedia(tenant);
        if (!(runtime.viewer !== undefined)) {
          if (runtime.started) await this.observeOffline(tenant);
          return;
        }
        const ensured = await this.context.endpoint.ensureSession(tenant);
        runtime.started = true;
        if (!(runtime.viewer !== undefined)) {
          await this.observeOffline(tenant);
          return;
        }
        const applied = runtime.policy.site!;
        if (
          !applied.applied ||
          (ensured.browserPid !== undefined && applied.browserPid !== ensured.browserPid)
        )
          await this.services.policy.applySites(tenant, desired, true, ensured.browserPid);
        if (!runtime.policy.site?.applied)
          throw new RemoteKitError('unavailable', '站点身份尚未应用，等待Endpoint恢复');
        const media = runtime.policy.media!;
        if (!media.applied || (ensured.browserPid !== undefined && media.browserPid !== ensured.browserPid))
          await this.services.policy.applyMedia(tenant, true, ensured.browserPid);
      }
      // Native source/encoder application may finish after views or RTC exist.
      // Accepted policy is cached before their creation; stats retain unknown actuals.
      const snapshot = await this.context.endpoint.snapshot(tenant),
        state = this.context.store.workspaces.workspace(tenant),
        actual: any[] = Array.isArray(snapshot?.views) ? snapshot.views : [];
      this.services.lifecycle.retain(
        tenant,
        new Set(
          snapshot.running === false || resourceLimitation
            ? []
            : actual.filter((v) => state.tabs.some((t) => t.webviewId === v.viewId)).map((v) => v.viewId),
        ),
      );
      if (typeof snapshot.browserIncarnation === 'string')
        runtime.browserIncarnation = snapshot.browserIncarnation;
      this.services.navigation.observeRetired(state, snapshot);
      this.services.policy.observeMedia(tenant, snapshot.stats?.mediaPolicy?.applied);
      const closedViews = await this.services.pageRequests.consumeClosedEvents(state, snapshot);
      if (!(runtime.viewer !== undefined)) {
        await this.observeOffline(tenant);
        return;
      }
      await this.services.popups.observePopups(state, snapshot);
      this.context.store.operations.prunePopupReceipts(tenant);
      if (state.pendingClose)
        this.services.pageRequests.observePendingClose(
          state,
          snapshot,
          actual.find((v) => v.viewId === state.tabs.find((t) => t.id === state.pendingClose?.id)?.webviewId),
        );
      for (const t of [...state.tabs]) {
        const current = actual.find((v) => v.viewId === t.webviewId);
        if (!current) {
          this.services.lifecycle.observeLifecycleRecovery(state, t, current, snapshot.browserIncarnation);
          continue;
        }
        await this.services.navigation.observe(state, t, current, snapshot);
        // A provisional failure restored a local product tab. Do not project
        // the retained Browser view's URL/title over that local product state.
        if (isLocalTab(t)) continue;
        if (t.popup?.status === 'pending')
          t.popup = { provisionalId: t.popup.provisionalId, status: 'adopted' };
        if (current.close_state === 'closed') {
          this.services.pageRequests.removeProductTab(state, t);
          continue;
        }
        // Recovery uses an initial blank WebContents, then imports/restores history.
        // Its intermediate URL/title/history are not a new product navigation.
        const lifecycleBlocked = this.services.lifecycle.observeLifecycleRecovery(
          state,
          t,
          current,
          snapshot.browserIncarnation,
        );
        const recovering = current.recovery?.pending === true || lifecycleBlocked;
        if (!recovering) {
          for (const key of ['title', 'loading', 'canGoBack', 'canGoForward'] as const)
            if (typeof current[key] === (key === 'title' ? 'string' : 'boolean'))
              (t as any)[key] = key === 'title' ? current[key].slice(0, 120) : current[key];
          if (
            (!t.navigation ||
              t.navigation.resolved ||
              !['applying', 'unknown'].includes(t.navigation.status)) &&
            typeof current.url === 'string' &&
            /^(https?:\/\/|about:blank$)/.test(current.url) &&
            (!t.pendingUrl || current.url === t.pendingUrl)
          ) {
            t.url = current.url;
            delete t.pendingUrl;
          }
        }
        if (Number.isInteger(current.actual) && current.actual >= 0 && current.actual <= 3)
          t.residency = (['live', 'frozen', 'discarded', 'unloaded'] as const)[current.actual];
        t.restoring =
          !t.lifecycleRecoveryError && (recovering || (!!current.pending && current.desired === 0));
      }
      await this.services.pageRequests.continueWindowClose(state);
      for (const pending of this.context.store.operations.pendingOperations(tenant)) {
        const a = pending.action;
        if (
          !pending.receipt.resolved &&
          pending.receipt.browserIncarnation &&
          (snapshot.running === false ||
            (typeof snapshot.browserIncarnation === 'string' &&
              snapshot.browserIncarnation !== pending.receipt.browserIncarnation))
        ) {
          settle(pending.receipt, { status: 'unknown' });
          pending.receipt.resolved = true;
          pending.receipt.resolution = 'target-retired';
          pending.receipt.error = '原页面实例已结束，操作执行结果未知';
          delete pending.receipt.application;
          this.context.store.operations.saveOperation(state, pending.receipt);
        }
        if (
          ['tab.navigate', 'tab.command'].includes(a.type) &&
          !state.tabs.some((tab) => tab.id === a.tabId) &&
          !pending.receipt.resolved
        ) {
          settle(pending.receipt, { status: 'unknown' });
          pending.receipt.resolved = true;
          pending.receipt.resolution = 'target-retired';
          pending.receipt.error = '页面已关闭，之前的导航结果无法确认';
          delete pending.receipt.application;
          this.context.store.operations.saveOperation(state, pending.receipt);
        }
        const removed =
          (a.type === 'tab.close' && !state.tabs.some((tab) => tab.id === a.tabId)) ||
          (a.type === 'window.close' && !state.windows.some((window) => window.id === a.windowId));
        if (removed) {
          settle(pending.receipt, { status: 'committed' });
          delete pending.receipt.application;
          this.context.store.operations.saveOperation(state, pending.receipt);
        }
      }
      const fullscreenChanged = this.services.pageRequests.observeFullscreen(state, snapshot, actual);
      this.services.operations.saveWorkspace(state);
      this.services.pageRequests.collectDialogs(tenant, state, snapshot);
      if (fullscreenChanged) this.services.viewers.push(tenant);
      resourceLimitation = this.services.policy.qualityFor(tenant, state).resourceLimitation;
      if (snapshot.running === false && !resourceLimitation)
        throw new RemoteKitError('unavailable', 'Browser已离线，页面保留并等待恢复');
      const viewer = runtime.viewer,
        viewport = viewer?.viewport ?? runtime.lastViewport;
      const wanted = (t: ProductTab) =>
        !isLocalTab(t) &&
        !viewer?.security?.locked &&
        !!viewer?.viewport?.windows.some((w) => w.windowId === t.windowId && w.visible) &&
        state.windows.some((w) => w.id === t.windowId && w.activeTabId === t.id) &&
        (state.layoutMode !== 'focused' || t.windowId === state.activeWindowId);
      const ordered = [...state.tabs]
        .filter((t) => !isLocalTab(t))
        .sort((a, b) => Number(wanted(a)) - Number(wanted(b)));
      // A first navigation can have created/shown a Native view before a
      // provisional failure restores a local product tab. Explicitly remove
      // that existing view from the atlas, including under resource limitation.
      for (const t of state.tabs.filter((tab) => isLocalTab(tab))) {
        const current = actual.find((v) => v.viewId === t.webviewId),
          key = tenant + '/' + t.webviewId;
        if (!current) {
          this.services.policy.invalidateConfiguration(tenant, key);
          continue;
        }
        this.services.lifecycle.forget(tenant, key);
        const config = { viewId: t.webviewId, visible: false, requireRunning: true },
          encoded = JSON.stringify(config);
        if (
          current.visible === true ||
          (current.visible !== false && this.services.policy.configuration(tenant, key) !== encoded)
        ) {
          this.services.policy.invalidateConfiguration(tenant, key);
          await this.context.endpoint.configureView(tenant, config);
        }
        // This hide-only cache deliberately differs from the complete remote
        // config, so the next navigation reapplies bounds/device/visibility.
        this.services.policy.appliedConfiguration(tenant, key, encoded);
      }
      for (const t of resourceLimitation ? [] : ordered) {
        if (!(runtime.viewer !== undefined)) {
          await this.observeOffline(tenant);
          return;
        }
        const current = actual.find((v) => v.viewId === t.webviewId),
          key = tenant + '/' + t.webviewId,
          visible = wanted(t),
          region = viewport?.windows.find((w) => w.windowId === t.windowId),
          dpr = this.services.policy.qualityFor(tenant, state).effectiveDpr;
        if (t.popup?.status === 'failed') continue;
        if (visible) this.services.lifecycle.forget(tenant, key);
        const recovering = current?.recovery?.pending === true;
        const lifecycleBlocked =
          current?.lifecycle_uncertain === true || !!t.lifecycleRecovery || !!t.lifecycleRecoveryError;
        const readyToShow = await this.services.lifecycle.prepareVisible(
          tenant,
          t.webviewId,
          visible,
          current,
          lifecycleBlocked,
        );
        // Endpoint hides the recovering WebContents while retaining this desired
        // visibility for its final recovery step. Do not persist a temporary hide.
        const config = {
          viewId: t.webviewId,
          width: region?.width ?? 1440,
          height: region?.height ?? 900,
          device: { mode: 'desktop', deviceScaleFactor: dpr },
          visible: !lifecycleBlocked && visible && (recovering || readyToShow),
        };
        const encoded = JSON.stringify(config);
        if (!current && t.popup?.status === 'pending') {
          if (await this.services.popups.adopt(state, t, config))
            this.services.policy.appliedConfiguration(tenant, key, encoded);
          continue;
        }
        if (
          !current &&
          (lifecycleBlocked ||
            (t.navigation && !t.navigation.resolved && ['applying', 'unknown'].includes(t.navigation.status)))
        )
          continue;
        if (!current) {
          await this.context.endpoint.ensureView(tenant, { ...config, url: t.pendingUrl ?? t.url });
          this.services.policy.appliedConfiguration(tenant, key, encoded);
        } else if (
          this.services.policy.configuration(tenant, key) !== encoded ||
          (!recovering && current.visible !== undefined && current.visible !== config.visible)
        ) {
          await this.context.endpoint.configureView(
            tenant,
            lifecycleBlocked ? { ...config, requireRunning: true } : config,
          );
          this.services.policy.appliedConfiguration(tenant, key, encoded);
        }
        if (lifecycleBlocked) {
          await this.services.lifecycle.advanceLifecycleRecovery(
            state,
            t,
            current,
            snapshot.browserIncarnation,
            visible && viewer === runtime.viewer && !viewer?.security?.locked,
          );
          continue;
        }
        if (t.pendingUaReloadOrigin && readyToShow) {
          const requestedOrigin = t.pendingUaReloadOrigin;
          if (current && new URL(t.url).origin === requestedOrigin)
            await this.context.endpoint.command(tenant, { viewId: t.webviewId, command: 'reload' });
          delete t.pendingUaReloadOrigin;
          this.services.operations.saveWorkspace(state);
        }
        await this.services.lifecycle.maintainBackgroundTab(
          state,
          t,
          current,
          visible,
          snapshot.browserIncarnation,
        );
      }
      for (const v of actual) {
        const viewId = v.viewId;
        if (!state.tabs.some((t) => t.webviewId === viewId) && !v.provisional && !closedViews.has(viewId))
          await this.context.endpoint.closeView(tenant, { viewId, force: true, orphan: true });
      }
      if (resourceLimitation) {
        const changed = runtime.lastError !== resourceLimitation;
        runtime.lastError = resourceLimitation;
        if (changed) this.services.viewers.push(tenant);
      } else {
        const previousError = runtime.clearError();
        if (previousError) this.services.viewers.push(tenant);
      }
    } catch (error) {
      this.services.pageRequests.clear(tenant);
      runtime.lastError = toRemoteKitError(error).message;
      this.services.viewers.push(tenant);
      throw error;
    }
  }
  async observeOffline(tenant: string) {
    const runtime = this.context.tenants.get(tenant);
    if (this.context.endpoint.placement.peek(tenant)?.state === 'hibernated') {
      runtime.started = false;
      return;
    }
    // Snapshot is read-only. Maintenance must never revive a missing Browser/view.
    const snapshot = await this.context.endpoint.snapshot(tenant),
      state = this.context.store.workspaces.workspace(tenant);
    this.services.lifecycle.retain(
      tenant,
      new Set(
        snapshot.running === false
          ? []
          : (snapshot.views ?? [])
              .filter((v: any) => state.tabs.some((t) => t.webviewId === v.viewId))
              .map((v: any) => v.viewId),
      ),
    );
    await this.services.pageRequests.consumeClosedEvents(state, snapshot);
    this.services.pageRequests.clearTransient(tenant);
    if (state.pendingClose) {
      const tab = state.tabs.find((t) => t.id === state.pendingClose?.id);
      this.services.pageRequests.observePendingClose(
        state,
        snapshot,
        (snapshot.views ?? []).find((v: any) => v.viewId === tab?.webviewId),
      );
      this.services.operations.saveWorkspace(state);
    }
    if (await this.services.lifecycle.hibernate(tenant, snapshot)) return;
    if (snapshot.running === false) {
      runtime.started = false;
      this.services.policy.reset(tenant);
      this.services.viewers.push(tenant);
      return;
    }
    for (const tab of state.tabs) {
      const current = (snapshot.views ?? []).find((view: any) => view.viewId === tab.webviewId);
      const lifecycleBlocked = this.services.lifecycle.observeLifecycleRecovery(
        state,
        tab,
        current,
        snapshot.browserIncarnation,
      );
      if (!current) continue;
      const key = tenant + '/' + tab.webviewId;
      if (current.visible !== false) {
        await this.context.endpoint.configureView(tenant, {
          viewId: tab.webviewId,
          visible: false,
          requireRunning: true,
        });
        this.services.policy.invalidateConfiguration(tenant, key);
      }
      if (lifecycleBlocked)
        await this.services.lifecycle.advanceLifecycleRecovery(
          state,
          tab,
          current,
          snapshot.browserIncarnation,
          false,
        );
      else
        await this.services.lifecycle.maintainBackgroundTab(
          state,
          tab,
          current,
          false,
          snapshot.browserIncarnation,
        );
    }
    this.services.operations.saveWorkspace(state);
    const previousError = runtime.clearError();
    if (previousError) this.services.viewers.push(tenant);
  }
}
