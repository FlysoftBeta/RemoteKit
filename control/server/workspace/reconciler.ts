import { BackgroundJob } from '../background';
import { RemoteKitError, toRemoteKitError } from '../../shared/errors';
import { wireError } from '../../shared/errors';
import { EndpointSnapshotError, endpointError } from '../endpoint/gateway';
import { log } from '../log';
import { normalizedUsagePage } from '../navigation-url';
import { settle } from './operations';
import { pageUsageIdentity } from './workspace';

import type { ProductTab, ProductWorkspace } from '../../shared/product';
import { isLocalTab } from '../../shared/product';
import type { DomainContext, DomainServices } from '../application';
import { canonical, type SessionObserved } from '../endpoint/coordination';
import { KeyedSerialQueue } from '../util/serial-queue';
import type { NavigationAck } from './navigation';

export class Reconciler {
  private closed = false;
  private readonly pending = new Set<Promise<void>>();
  private readonly requested = new Map<string, { dirty: boolean; work: Promise<void> }>();
  private readonly observations = new WeakMap<object, string>();
  private readonly products = new KeyedSerialQueue();
  private readonly maintenanceWork = new Map<
    string,
    { dirty: boolean; acks: NavigationAck[]; work: Promise<void> }
  >();

  observe(message: SessionObserved) {
    const runtime = this.context.tenants.get(message.tenantId);
    const key = canonical({
      sessionId: message.sessionId,
      placementEpoch: message.placementEpoch,
      connectionEpoch: message.connectionEpoch,
      endpointIncarnation: message.endpointIncarnation,
      observedRevision: message.observedRevision,
      converged: message.converged,
      browser: message.browser,
      browserIncarnation: message.browserIncarnation,
      browserRestart: message.browserRestart,
      applied: message.applied,
      authorization: message.authorization,
      lock: message.lock,
      views: message.views.map(({ compositor, renderer_pids, ...view }) => view),
      pendingPopups: message.pendingPopups,
      recovery: message.recovery,
      documentErrors: message.documentErrors,
      blockers: message.blockers,
      rtc: { active: message.rtc.active, connectionId: message.rtc.connectionId },
      mediaPolicy: message.stats.mediaPolicy,
      allocationPressure: message.stats.allocationPressure,
      lastError: message.lastError,
    });
    if (this.observations.get(runtime) === key) return;
    this.observations.set(runtime, key);
    this.projectPageRequests(message);
    if (!runtime.viewer && !runtime.started && !runtime.pendingRtcCheck) return;
    return this.requestProduct(message.tenantId);
  }

  /**
   * Dialogs and file requests are projected straight from the observation, not through the
   * full reconciliation: that queue may be busy for a second, and the file basket is something
   * the user is waiting for. Only an observation that is still the tenant's current one is
   * projected; the reconciliation repeats the projection from the same data.
   */
  private projectPageRequests(message: SessionObserved) {
    const tenant = message.tenantId;
    if (this.closed || this.context.closed) return;
    const runtime = this.context.tenants.get(tenant);
    const endpoint = this.context.endpoint;
    if (
      !runtime.viewer ||
      endpoint.observation(tenant) !== message ||
      !endpoint.isReady(tenant) ||
      endpoint.sessionFault(tenant)
    )
      return;
    const receivedAt = Date.now();
    const known = new Set((runtime.pageRequests.files ?? []).map((file) => file.id));
    this.services.pageRequests.collectDialogs(
      tenant,
      this.context.store.workspaces.workspace(tenant),
      endpoint.current(tenant),
    );
    const projectedAt = Date.now();
    for (const file of runtime.pageRequests.files ?? [])
      if (!known.has(file.id))
        log.info('page_request.timeline', {
          tenant,
          request: file.binding.request,
          observationSeq: message.seq,
          observationReceivedAt: receivedAt,
          projectedAt,
        });
  }

  publishDesired(tenant: string) {
    this.context.endpoint.invalidate(tenant);
    void this.requestProduct(tenant);
  }

  requestProduct(tenant: string): Promise<void> {
    if (this.closed || this.context.closed) return Promise.resolve();
    const existing = this.requested.get(tenant);
    if (existing) {
      existing.dirty = true;
      return existing.work;
    }
    const request = { dirty: true, work: Promise.resolve() };
    const tracking = this.context.tenants.get(tenant).reconciliation;
    request.work = Promise.resolve().then(async () => {
      try {
        while (request.dirty && !this.closed && !this.context.closed) {
          try {
            await this.context.tenants.serial(tenant, async () => {
              request.dirty = false;
              if (this.context.tenants.get(tenant).pendingRtcCheck)
                await this.services.rtc.checkReconnectedRtc(tenant);
              if (!this.closed && !this.context.closed) await this.reconcileProduct(tenant);
            });
          } catch (err) {
            this.context.tenants.get(tenant).lastError = toRemoteKitError(err);
          }
        }
      } finally {
        this.requested.delete(tenant);
      }
      // Maintenance runs outside the tenant lock and the request queue: a new request starts its
      // projection while it is still going. Waiting here only lets callers see its result.
      await this.maintenanceWork.get(tenant)?.work;
      if (tracking.inflight === request.work) delete tracking.inflight;
    });
    this.requested.set(tenant, request);
    tracking.inflight = request.work;
    return request.work;
  }
  async close() {
    this.closed = true;
    await this.reclaim.close();
    await Promise.allSettled(this.pending);
    await Promise.allSettled(
      this.context.tenants
        .values()
        .flatMap((runtime) => (runtime.reconciliation.inflight ? [runtime.reconciliation.inflight] : [])),
    );
    await this.products.drain();
  }
  get backgroundFailure() {
    return this.reclaim.retry.error;
  }
  private readonly reclaim = new BackgroundJob('reclaim.statistics', {});
  private readonly writtenTitles = new WeakMap<object, Map<string, { page: string; title: string }>>();

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
      | 'workspace'
      | 'learning'
    >,
  ) {}
  tick(): Promise<void> {
    if (this.closed || this.context.closed) return Promise.resolve();
    const work = this.runTick();
    this.pending.add(work);
    const release = () => this.pending.delete(work);
    void work.then(release, release);
    return work;
  }
  private async runTick() {
    const reclaim = this.reclaim.run(
      async () => this.context.store.reclaim.tick(),
      this.context.store.buildId,
    );
    const relief = this.services.lifecycle.relieve();
    const active = this.context.store.db
      .prepare(
        "SELECT tenant FROM session_placements WHERE run_state='running' OR pending_commit IS NOT NULL",
      )
      .all() as { tenant: string }[];
    for (const { tenant } of active) this.context.tenants.get(tenant).started = true;
    const work = this.context.tenants.activeTenants().map((tenant) => {
      return this.requestProduct(tenant);
    });
    await Promise.all([...work, relief, reclaim]);
  }
  private runtimesForNode(nodeId?: string) {
    return this.context.tenants.values().filter((runtime) => {
      const placement = this.context.endpoint.placement.peek(runtime.tenantId);
      return !nodeId || !placement || placement.nodeId === nodeId;
    });
  }
  async endpointReady(identity?: { processChanged: boolean; nodeId?: string }) {
    if (this.closed || this.context.closed) return;
    if (identity?.processChanged !== false) return this.reconcileAll(identity?.nodeId);
    const runtimes = this.runtimesForNode(identity.nodeId);
    for (const runtime of runtimes) {
      this.services.policy.reset(runtime.tenantId);
      runtime.reconciliation.retry.ready(
        JSON.stringify(['reconnected', this.context.endpoint.observation(runtime.tenantId)?.connectionEpoch]),
      );
      if (runtime.connectionId || runtime.rtc.disconnectedPeer) runtime.pendingRtcCheck = true;
    }
    for (const runtime of runtimes.filter((runtime) => runtime.viewer || runtime.started)) {
      const tenant = runtime.tenantId;
      await this.services.rtc.checkReconnectedRtc(tenant).catch((error) => {
        runtime.lastError = toRemoteKitError(error);
      });
      await this.context.tenants.serial(tenant, async () => {
        try {
          await this.reconcileProduct(tenant);
        } catch (error) {
          this.context.tenants.get(tenant).lastError = toRemoteKitError(error);
        }
        this.services.viewers.push(tenant);
      });
    }
  }
  async reconcileAll(nodeId?: string) {
    if (this.closed || this.context.closed) return;
    const runtimes = this.runtimesForNode(nodeId);
    for (const runtime of runtimes) {
      this.resetTenantEndpoint(runtime.tenantId);
    }
    for (const runtime of runtimes.filter((runtime) => runtime.viewer)) {
      const tenant = runtime.tenantId;
      await this.context.tenants
        .serial(tenant, async () => {
          await this.resumeTenant(tenant);
        })
        .catch((err) => log.warn('reconciler.product_failed', { tenant, err }));
    }
  }
  resetTenantEndpoint(tenant: string, generation = this.context.tenants.mediaGeneration(tenant) + 1) {
    const runtime = this.context.tenants.get(tenant);
    if (runtime.viewer) this.services.security.forgetPeer(tenant, runtime.viewer.security);
    runtime.resetEndpoint();
    runtime.mediaGeneration = generation;
  }
  async resumeTenant(tenant: string) {
    const viewer = this.context.tenants.get(tenant).viewer;
    if (viewer) {
      this.context.events.emit(
        'auth',
        tenant,
        viewer.id,
        this.services.viewers.authState(tenant, viewer.security),
      );
      void this.services.security.capabilities(tenant, viewer.security);
      await this.reconcileProduct(tenant);
    }
    this.services.viewers.push(tenant);
  }
  reconcileProduct(tenant: string): Promise<void> {
    return this.products.run(tenant, () => this.reconcileLatest(tenant));
  }
  private async reconcileLatest(tenant: string) {
    if (this.closed || this.context.closed) return;
    const runtime = this.context.tenants.get(tenant);
    this.services.pageRequests.observePendingClose(this.context.store.workspaces.workspace(tenant));
    this.context.endpoint.invalidate(tenant);
    if (!this.context.endpoint.isReady(tenant) || this.context.endpoint.sessionFault(tenant)) {
      this.services.viewers.push(tenant);
      return;
    }
    this.services.lifecycle.observeWanted(this.context.store.workspaces.workspace(tenant), false);
    if (this.context.endpoint.placement.peek(tenant)?.pendingCommit) {
      this.context.endpoint.invalidate(tenant);
      runtime.lastErrorKey = 'stopping';
      runtime.lastError = undefined;
      this.services.viewers.push(tenant);
      return;
    }
    if (runtime.viewer && this.context.endpoint.placement.peek(tenant)?.runState !== 'running') {
      if (!this.services.viewers.productAllowed(tenant, runtime.viewer.id)) {
        this.services.viewers.push(tenant);
        return;
      }
      try {
        this.context.endpoint.placement.resolve(tenant);
      } catch (error) {
        runtime.lastError = toRemoteKitError(error);
        this.services.viewers.push(tenant);
        throw error;
      }
    }
    if (!(runtime.viewer !== undefined) && !runtime.started) return;
    const tracking = runtime.reconciliation;
    const observation = this.observations.get(runtime);
    const desiredKey = this.productInput(tenant, observation);
    if (!tracking.retry.ready(desiredKey)) return;
    try {
      if (!(runtime.viewer !== undefined)) {
        await this.observeOffline(tenant);
        tracking.retry.succeed();
        return;
      }
      const desired = this.context.store.workspaces.workspace(tenant);
      const observed = this.context.endpoint.observation(tenant);
      if (observed) await this.services.popups.observePopups(desired, observed);
      let resourceLimitation = this.services.policy.qualityFor(tenant, desired).resourceLimitation;
      const sent = await this.context.endpoint.published(tenant);
      const latest = this.context.endpoint.observation(tenant);
      if (
        sent.run === 'running' &&
        (!latest || latest.browser === 'starting' || BigInt(latest.observedRevision) < BigInt(sent.revision))
      ) {
        this.services.viewers.push(tenant);
        return;
      }
      runtime.started = true;
      const snapshot = this.context.endpoint.current(tenant),
        state = this.context.store.workspaces.workspace(tenant),
        actual: any[] = Array.isArray(snapshot?.views) ? snapshot.views : [];
      this.services.learning.signIn.reconcile(state, snapshot.browserIncarnation, snapshot.running !== false);
      this.services.lifecycle.retain(
        tenant,
        new Set(
          snapshot.running === false || resourceLimitation
            ? []
            : actual.filter((v) => state.tabs.some((t) => t.webviewId === v.viewId)).map((v) => v.viewId),
        ),
      );
      runtime.browserRestart = snapshot.browserRestart;
      if (typeof snapshot.browserIncarnation === 'string')
        runtime.browserIncarnation = snapshot.browserIncarnation;
      this.services.navigation.observeRetired(state, snapshot);
      this.services.policy.observeMedia(tenant, snapshot.stats?.mediaPolicy?.applied);
      if (!(runtime.viewer !== undefined)) {
        await this.observeOffline(tenant);
        return;
      }
      await this.services.popups.observePopups(state, snapshot);
      this.context.store.operations.prunePopupReceipts(tenant);
      this.services.pageRequests.observePendingClose(state);
      let writtenTitles = this.writtenTitles.get(runtime);
      if (!writtenTitles) this.writtenTitles.set(runtime, (writtenTitles = new Map()));
      const tabIds = new Set(state.tabs.map((tab) => tab.id));
      for (const id of writtenTitles.keys()) if (!tabIds.has(id)) writtenTitles.delete(id);
      const documentErrors = (snapshot.documentErrors ?? {}) as Record<string, unknown>;
      for (const t of state.tabs) {
        if (!t.owner) continue;
        const failed = documentErrors[t.webviewId];
        if (failed) t.documentError = wireError(endpointError(failed));
        else delete t.documentError;
      }
      const acks: NavigationAck[] = [];
      for (const t of [...state.tabs]) {
        const current = actual.find((v) => v.viewId === t.webviewId);
        if (!current) {
          if (t.signIn) continue;
          this.services.lifecycle.observeLifecycleRecovery(state, t, current, snapshot.browserIncarnation);
          continue;
        }
        if (t.signIn) {
          if (current.close_state === 'closed') this.services.pageRequests.removeProductTab(state, t);
          continue;
        }
        acks.push(...this.services.navigation.observe(state, t, current, snapshot));
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
        // The failure is terminal for this Browser instance; convert (and log) it once.
        if (current.recovery?.phase === 'failed' && current.recovery.error && !t.lifecycleRecoveryError) {
          t.lifecycleRecoveryError = this.services.lifecycle.lifecycleError(
            endpointError(current.recovery.error),
          );
        }
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
          const document = pageUsageIdentity(t, current, snapshot.browserIncarnation);
          if (
            document &&
            document !== t.usageDocument &&
            typeof current.url === 'string' &&
            normalizedUsagePage(current.url) === normalizedUsagePage(t.url) &&
            !t.pendingUrl &&
            (!t.navigation || t.navigation.resolved || !['applying', 'unknown'].includes(t.navigation.status))
          ) {
            if (!t.restoring)
              this.services.workspace.recordPage(state, t, current, snapshot.browserIncarnation);
            t.usageDocument = document;
          }
          const page = normalizedUsagePage(t.url);
          if (!page) writtenTitles.delete(t.id);
          else if (typeof current.title === 'string') {
            const title = current.title.slice(0, 120);
            const written = writtenTitles.get(t.id);
            if (written?.page !== page || written.title !== title) {
              this.context.store.workspaces.items.updateUsageTitle(tenant, 'page:' + page, title);
              writtenTitles.set(t.id, { page, title });
            }
          }
        }
        if (Number.isInteger(current.actual) && current.actual >= 0 && current.actual <= 3)
          t.residency = (['live', 'frozen', 'discarded', 'unloaded'] as const)[current.actual];
        this.services.lifecycle.observeReclaimed(t, current);
        t.restoring =
          !t.lifecycleRecoveryError && (recovering || (!!current.pending && current.desired === 0));
      }
      const settlePending = () => {
        for (const pending of this.context.store.operations.pendingOperations(tenant)) {
          if (pending.receipt.resolved) continue;
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
            pending.receipt.error = {
              code: 'outcome_unknown',
              message: '原页面实例已结束，操作执行结果未知',
            };
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
            pending.receipt.error = {
              code: 'outcome_unknown',
              message: '页面已关闭，之前的导航结果无法确认',
            };
            delete pending.receipt.application;
            this.context.store.operations.saveOperation(state, pending.receipt);
          }
          const removed =
            (a.type === 'tab.close' && !state.tabs.some((tab) => tab.id === a.tabId)) ||
            (a.type === 'window.close' && !state.windows.some((window) => window.id === a.windowId)) ||
            (a.type === 'space.close' && !state.spaces.some((space) => a.spaceIds.includes(space.id))) ||
            (a.type === 'app.uninstall' && !state.apps.some((app) => 'web:' + app.id === a.appId));
          if (removed) {
            settle(pending.receipt, { status: 'committed' });
            delete pending.receipt.application;
            this.context.store.operations.saveOperation(state, pending.receipt);
          }
        }
      };
      settlePending();
      const fullscreenChanged = this.services.pageRequests.observeFullscreen(state, snapshot, actual);
      this.services.operations.saveWorkspace(state);
      this.services.pageRequests.collectDialogs(tenant, state, snapshot);
      if (fullscreenChanged) this.services.viewers.push(tenant);
      await this.services.pageRequests.continueWindowClose(state);
      settlePending();
      resourceLimitation = this.services.policy.qualityFor(tenant, state).resourceLimitation;
      if (snapshot.status)
        throw new EndpointSnapshotError(endpointError(snapshot.status), snapshot.browserRestart);
      if (snapshot.running === false && !resourceLimitation)
        throw new RemoteKitError('unavailable', 'Browser已离线，页面保留并等待恢复');
      this.services.lifecycle.observeWanted(state);
      this.context.endpoint.invalidate(tenant);
      if (resourceLimitation) {
        const changed = runtime.lastErrorKey !== 'resource_limit';
        runtime.lastErrorKey = 'resource_limit';
        runtime.lastError = new RemoteKitError('limit_exceeded', resourceLimitation, { capacity: 'windows' });
        if (changed) this.services.viewers.push(tenant);
      } else {
        // The reconciliation succeeds when its maintenance does; failures share this tenant's retry.
        this.requestMaintenance(tenant, acks);
      }
    } catch (error) {
      this.services.pageRequests.clear(tenant);
      const failure = toRemoteKitError(error);
      if (error instanceof EndpointSnapshotError) runtime.browserRestart = error.browserRestart;
      tracking.retry.ready(this.productInput(tenant, observation));
      tracking.retry.fail(failure);
      runtime.lastErrorKey = 'endpoint';
      runtime.lastError = failure;
      this.services.viewers.push(tenant);
      throw error;
    }
  }
  /** Maintenance is the Browser calls that follow a projection; the latest request wins. */
  private requestMaintenance(tenant: string, acks: NavigationAck[]) {
    if (this.closed || this.context.closed) return;
    const existing = this.maintenanceWork.get(tenant);
    if (existing) {
      existing.dirty = true;
      existing.acks.push(...acks);
      return;
    }
    const entry = { dirty: true, acks: [...acks], work: Promise.resolve() };
    entry.work = Promise.resolve().then(async () => {
      try {
        while (entry.dirty && !this.closed && !this.context.closed) {
          entry.dirty = false;
          await this.maintain(tenant, entry.acks.splice(0));
        }
      } finally {
        this.maintenanceWork.delete(tenant);
      }
    });
    this.maintenanceWork.set(tenant, entry);
    this.pending.add(entry.work);
    const release = () => this.pending.delete(entry.work);
    void entry.work.then(release, release);
  }
  private async maintain(tenant: string, acks: NavigationAck[]) {
    const runtime = this.context.tenants.get(tenant);
    const tracking = runtime.reconciliation;
    try {
      await this.maintainTabs(tenant, runtime, acks);
      tracking.retry.succeed();
      const previousError = runtime.clearError();
      if (previousError) this.services.viewers.push(tenant);
    } catch (error) {
      const failure = toRemoteKitError(error);
      tracking.retry.ready(this.productInput(tenant, this.observations.get(runtime)));
      tracking.retry.fail(failure);
      runtime.lastErrorKey = 'endpoint';
      runtime.lastError = failure;
      this.services.viewers.push(tenant);
    }
  }
  /** Resolves when the tenant has no reconciliation or maintenance in flight. */
  async settled(tenant: string) {
    for (;;) {
      const work = this.requested.get(tenant)?.work ?? this.maintenanceWork.get(tenant)?.work;
      if (!work) return;
      await work;
    }
  }
  /** Runs one step with the tenant's current product state, under the lock. */
  private withTab(
    tenant: string,
    tabId: string,
    work: (state: ProductWorkspace, tab: ProductTab) => Promise<void>,
  ) {
    return this.context.tenants.serial(tenant, async () => {
      if (this.closed || this.context.closed) return;
      const state = this.context.store.workspaces.workspace(tenant);
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      if (tab) await work(state, tab);
    });
  }
  private async maintainTabs(
    tenant: string,
    runtime: ReturnType<DomainContext['tenants']['get']>,
    acks: NavigationAck[],
  ) {
    const message = this.context.endpoint.observation(tenant);
    if (!message || !runtime.viewer || !this.context.endpoint.isReady(tenant)) return;
    const snapshot = this.context.endpoint.current(tenant);
    if (acks.length) await this.services.navigation.acknowledge(tenant, acks);
    if (snapshot.running === false || snapshot.status) return;
    const state = this.context.store.workspaces.workspace(tenant);
    if (this.services.policy.qualityFor(tenant, state).resourceLimitation) return;
    const actual: any[] = Array.isArray(snapshot.views) ? snapshot.views : [];
    const viewer = runtime.viewer,
      viewportKey = JSON.stringify(viewer.viewport ?? runtime.lastViewport);
    // A viewport change ends this pass and starts another. The observation is not rechecked: a
    // newer one has its own projection, and the Endpoint rejects lifecycle requests for a view
    // generation that moved on. Product revisions are not checked either; an operation requests
    // its own reconciliation.
    const superseded = () => {
      if (JSON.stringify(runtime.viewer?.viewport ?? runtime.lastViewport) === viewportKey) return false;
      this.requestMaintenance(tenant, []);
      return true;
    };
    const wanted = (tab: ProductTab) => this.services.lifecycle.wantedVisible(state, tab);
    const ordered = [...state.tabs]
      .filter((t) => !isLocalTab(t))
      .sort((a, b) => Number(wanted(a)) - Number(wanted(b)));
    for (const t of ordered) {
      if (superseded() || !runtime.viewer) return;
      const current = actual.find((v) => v.viewId === t.webviewId),
        key = tenant + '/' + t.webviewId,
        visible = wanted(t);
      if (t.popup?.status === 'failed') continue;
      if (visible) this.services.lifecycle.forget(tenant, key);
      const lifecycleBlocked =
        current?.lifecycle_uncertain === true || !!t.lifecycleRecovery || !!t.lifecycleRecoveryError;
      // No product state is read after this call starts, so the Browser call runs outside the lock.
      const readyToShow = await this.services.lifecycle.prepareVisible(
        tenant,
        t.webviewId,
        visible,
        current,
        lifecycleBlocked,
      );
      if (superseded()) return;
      if (lifecycleBlocked) {
        await this.withTab(tenant, t.id, (fresh, tab) =>
          this.services.lifecycle.advanceLifecycleRecovery(
            fresh,
            tab,
            current,
            snapshot.browserIncarnation,
            visible && viewer === runtime.viewer && !viewer.security?.locked,
          ),
        );
        continue;
      }
      if (t.pendingUaReloadOrigin && readyToShow)
        await this.withTab(tenant, t.id, (fresh, tab) =>
          this.services.navigation.reloadForSiteIdentity(fresh, tab, current, snapshot.browserIncarnation!),
        );
      await this.withTab(tenant, t.id, (fresh, tab) =>
        this.services.lifecycle.maintainBackgroundTab(
          fresh,
          tab,
          current,
          visible,
          snapshot.browserIncarnation,
        ),
      );
    }
  }
  private productInput(tenant: string, observation: string | undefined) {
    const runtime = this.context.tenants.get(tenant);
    return JSON.stringify([
      this.context.store.workspaces.workspace(tenant).revision,
      runtime.viewer?.id,
      runtime.viewer?.viewport,
      runtime.browserIncarnation,
      observation,
    ]);
  }
  async observeOffline(tenant: string) {
    const runtime = this.context.tenants.get(tenant);
    this.services.pageRequests.observePendingClose(this.context.store.workspaces.workspace(tenant));
    this.context.endpoint.invalidate(tenant);
    if (!this.context.endpoint.isReady(tenant) || this.context.endpoint.sessionFault(tenant)) {
      this.services.viewers.push(tenant);
      return;
    }
    this.services.lifecycle.observeWanted(this.context.store.workspaces.workspace(tenant), false);
    if (this.context.endpoint.placement.peek(tenant)?.pendingCommit) {
      this.context.endpoint.invalidate(tenant);
      return;
    }
    if (this.context.endpoint.placement.peek(tenant)?.runState === 'stopped') {
      runtime.started = false;
      return;
    }
    this.context.endpoint.invalidate(tenant);
    const snapshot = this.context.endpoint.current(tenant),
      state = this.context.store.workspaces.workspace(tenant);
    this.services.learning.signIn.reconcile(state, snapshot.browserIncarnation, snapshot.running !== false);
    this.context.store.workspaces.saveWorkspace(state);
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
    this.services.pageRequests.clearTransient(tenant);
    if (state.pendingClose) {
      this.services.pageRequests.observePendingClose(state);
      this.services.operations.saveWorkspace(state);
    }
    if (snapshot.status)
      throw new EndpointSnapshotError(endpointError(snapshot.status), snapshot.browserRestart);
    if (await this.services.lifecycle.stop(tenant, snapshot)) return;
    if (snapshot.running === false) {
      runtime.started = false;
      this.services.policy.reset(tenant);
      this.services.viewers.push(tenant);
      return;
    }
    for (const tab of state.tabs) {
      if (tab.signIn) continue;
      const current = (snapshot.views ?? []).find((view: any) => view.viewId === tab.webviewId);
      const lifecycleBlocked = this.services.lifecycle.observeLifecycleRecovery(
        state,
        tab,
        current,
        snapshot.browserIncarnation,
      );
      if (!current) continue;
      const key = tenant + '/' + tab.webviewId;
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
