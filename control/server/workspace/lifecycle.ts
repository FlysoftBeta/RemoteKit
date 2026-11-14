import { errorHandling } from '../../shared/error-policy';
import { RetryUnit } from '../../shared/retry-unit';
import { RemoteKitError, toRemoteKitError, wireError, type WireError } from '../../shared/errors';
import { endpointError } from '../endpoint/gateway';
import type { EndpointSnapshot } from '../endpoint/types';
import { log } from '../log';
import { settle } from './operations';

import type { ProductTab, ProductWorkspace } from '../../shared/product';
import { isLocalTab } from '../../shared/product';
import type { DomainContext, DomainServices } from '../application';
import type { NodeLink } from '../cluster/node-link';
import { systemClock, type Clock } from '../util/clock';
import { normalizedUsagePage } from '../navigation-url';
import {
  dwellFactor,
  hardExhaustion,
  keepAliveBlocksStop,
  shouldStopSession,
  tabReclaimDelays,
} from './reclaim-policy';

type StopReason = 'idle' | 'relief' | 'rebalance';
type ReliefState = { waitingAfter?: number; inflight?: Promise<void> };

export class UncertainRecovery {
  private readonly stopRetries = new Map<string, RetryUnit>();
  private readonly ordinaryRetries = new Map<string, RetryUnit>();
  failures() {
    return [
      ...this.stopRetries.values(),
      ...this.ordinaryRetries.values(),
      ...this.recoveryRetries.values(),
      ...this.candidateRetries.values(),
    ]
      .map((unit) => unit.error)
      .filter((error) => error !== undefined);
  }
  private async applyLifecycle(
    tenant: string,
    request: Parameters<DomainContext['endpoint']['lifecycle']>[1],
    generation?: string,
  ) {
    const key = tenant + '/' + request.viewId;
    let unit = this.ordinaryRetries.get(key);
    if (!unit) {
      unit = new RetryUnit({ name: 'lifecycle.view', now: () => this.context.clock.monotonicMs() });
      this.ordinaryRetries.set(key, unit);
    }
    const input = JSON.stringify([this.context.store.buildId, request, generation]);
    if (!unit.ready(input)) return false;
    try {
      const result = await this.context.endpoint.lifecycle(tenant, request);
      if (!result?.accepted)
        throw new RemoteKitError('outcome_unknown', 'Lifecycle admission was not confirmed');
      unit.succeed();
      return true;
    } catch (cause) {
      unit.fail(cause);
      return false;
    }
  }
  private readonly recoveryRetries = new Map<string, RetryUnit>();
  private readonly candidateRetries = new Map<string, RetryUnit>();
  private readonly relief = new Map<string, ReliefState>();
  private readonly stoppingNodes = new Set<string>();
  private readonly sessionEligibility = new Map<
    string,
    { since: number; observedAt: number; absence: number }
  >();

  private nodeFor(tenant: string) {
    const placement = this.context.endpoint.placement.peek(tenant);
    return placement && this.context.endpoint.nodes.get(placement.nodeId);
  }
  private exhausted(node: NodeLink | undefined) {
    return hardExhaustion(node?.metrics.latest()?.value.memory, node?.allocationFailedAt !== undefined);
  }
  wantedVisible(state: ProductWorkspace, tab: ProductTab) {
    const viewer = this.context.tenants.get(state.tenantId).viewer;
    return (
      !isLocalTab(tab) &&
      !!viewer &&
      !viewer.security?.locked &&
      !!viewer.viewport?.windows.some((window) => window.windowId === tab.windowId && window.visible) &&
      state.windows.some((window) => window.id === tab.windowId && window.activeTabId === tab.id) &&
      state.spaces.some((space) => space.id === state.activeSpaceId && space.windowIds.includes(tab.windowId))
    );
  }
  observeWanted(state: ProductWorkspace, presentationReady = true) {
    const visible = new Map<string, string>();
    let changed = false;
    for (const tab of state.tabs) {
      const keepAlive = tab.idleKeepAliveState;
      if (!this.wantedVisible(state, tab)) {
        if (keepAlive && keepAlive.leftAt === undefined) {
          keepAlive.leftAt = this.context.clock.wallMs();
          changed = true;
        }
        continue;
      }
      const pageKey = normalizedUsagePage(tab.url);
      if (pageKey) visible.set(tab.id, pageKey);
      if (!presentationReady) continue;
      if (keepAlive?.leftAt !== undefined && !tab.idleKeepAliveOutcome) {
        tab.idleKeepAliveOutcome = {
          enabledAt: keepAlive.enabledAt,
          eligibleSince: keepAlive.eligibleSince ?? keepAlive.leftAt,
          leftAt: keepAlive.leftAt,
          outcome: 'survived',
          at: this.context.clock.wallMs(),
          reason: 'statistics',
        };
        changed = true;
      }
      if (tab.idleKeepAliveOutcome && tab.idleKeepAliveOutcome.returnedAt === undefined) {
        tab.idleKeepAliveOutcome.returnedAt = this.context.clock.wallMs();
        changed = true;
      }
      if (tab.idleKeepAliveState?.eligibleSince !== undefined) {
        delete tab.idleKeepAliveState.eligibleSince;
        changed = true;
      }
      if (keepAlive?.leftAt !== undefined) {
        delete keepAlive.leftAt;
        changed = true;
      }
    }
    this.context.store.reclaim.observeWanted(state.tenantId, visible);
    if (changed) this.services.operations.saveWorkspace(state);
  }

  observeReclaimed(tab: ProductTab, current: BackgroundView | undefined) {
    const record = tab.idleKeepAliveOutcome;
    if (
      !record ||
      record.outcome === 'stopped' ||
      record.returnedAt !== undefined ||
      (current?.actual !== 1 && current?.actual !== 2)
    )
      return false;
    const outcome = current.actual === 1 ? 'frozen' : 'discarded';
    if (record.outcome === outcome) return false;
    record.outcome = outcome;
    record.at = this.context.clock.wallMs();
    return true;
  }

  private automaticStopEligible(tenant: string, state: ProductWorkspace, immediate: boolean) {
    const runtime = this.context.tenants.get(tenant);
    const node = this.nodeFor(tenant);
    const now = this.context.clock.wallMs();
    const eligible = state.tabs
      .filter((tab) => tab.idleKeepAlive)
      .map((tab) =>
        tab.idleKeepAliveState?.eligibleSince === undefined
          ? undefined
          : Math.min(
              Math.max(0, now - tab.idleKeepAliveState.eligibleSince),
              this.context.clock.monotonicMs() -
                (this.sessionEligibility.get(tenant)?.since ?? this.context.clock.monotonicMs()),
            ),
      );
    if (immediate) return !eligible.some((duration) => keepAliveBlocksStop(duration, this.exhausted(node)));
    return shouldStopSession(
      this.context.store.reclaim.absences(tenant),
      this.context.clock.monotonicMs() - runtime.viewerAbsentSince,
      node?.metrics.underPressure() ?? false,
      eligible,
      this.exhausted(node),
    );
  }

  private needsRelief(node: NodeLink) {
    const sample = node.metrics.latest();
    if (!sample || node.state.state !== 'ready' || this.context.endpoint.nodes.isRemoved(node.nodeId))
      return false;
    if (node.reliefRequestedAt !== undefined && sample.at > node.reliefRequestedAt)
      node.reliefRequestedAt = undefined;
    return !node.metrics.relieved() || node.reliefRequestedAt !== undefined || this.exhausted(node);
  }
  relieve(): Promise<void> {
    const jobs: Promise<void>[] = [];
    const nodes = this.context.endpoint.nodes;
    for (const node of nodes.all()) {
      if (node.state.state !== 'ready' || nodes.isRemoved(node.nodeId)) {
        this.relief.delete(node.nodeId);
        continue;
      }
      const sample = node.metrics.latest();
      if (!sample) continue;
      const needed = this.needsRelief(node);
      let state = this.relief.get(node.nodeId);
      if (state?.inflight) {
        jobs.push(state.inflight);
        continue;
      }
      if (state?.waitingAfter !== undefined && sample.at <= state.waitingAfter) continue;
      if (!needed) {
        this.relief.delete(node.nodeId);
        continue;
      }
      if (
        !state &&
        !node.metrics.underPressure() &&
        node.reliefRequestedAt === undefined &&
        !this.exhausted(node)
      )
        continue;
      if (!state) {
        state = {};
        this.relief.set(node.nodeId, state);
      }
      const reason: StopReason =
        node.metrics.underPressure() &&
        nodes
          .all()
          .some(
            (other) =>
              other !== node &&
              other.state.state === 'ready' &&
              !nodes.isRemoved(other.nodeId) &&
              (other.metrics.predicted() ?? Infinity) < 0.7,
          )
          ? 'rebalance'
          : 'relief';
      const tracking = state;
      tracking.inflight = this.relieveNode(node, tracking, reason)
        .catch((error) => log.warn('stop.relief_failed', { nodeId: node.nodeId, err: error }))
        .finally(() => {
          tracking.inflight = undefined;
        });
      jobs.push(tracking.inflight);
    }
    return Promise.all(jobs).then(() => {});
  }
  private async relieveNode(node: NodeLink, state: ReliefState, reason: StopReason) {
    const candidates = this.context.endpoint.placement
      .activeTenants(node.nodeId)
      .map((tenant) => this.context.tenants.get(tenant))
      .filter(
        (runtime) => !runtime.viewer && this.context.clock.monotonicMs() - runtime.viewerAbsentSince >= 60000,
      )
      .sort((a, b) => a.viewerAbsentSince - b.viewerAbsentSince || a.tenantId.localeCompare(b.tenantId));
    for (const runtime of candidates) {
      if (!this.needsRelief(node)) return;
      let unit = this.candidateRetries.get(runtime.tenantId);
      if (!unit) {
        unit = new RetryUnit({
          now: () => this.context.clock.monotonicMs(),
          failed: (error) => log.warn('stop.candidate_failed', { tenant: runtime.tenantId, err: error }),
          recovered: () => log.info('stop.candidate_recovered', { tenant: runtime.tenantId }),
        });
        this.candidateRetries.set(runtime.tenantId, unit);
      }
      if (
        !unit.ready(
          JSON.stringify([
            node.state,
            this.context.endpoint.placement.peek(runtime.tenantId),
            runtime.viewer?.id,
          ]),
        )
      )
        continue;
      const stopped = await this.context.tenants
        .serial(runtime.tenantId, async () => {
          if (!this.context.endpoint.isPlacedOn(runtime.tenantId, node.nodeId)) return false;
          const snapshot = await this.context.endpoint.snapshot(runtime.tenantId);
          if (!this.needsRelief(node)) return false;
          return this.stop(runtime.tenantId, snapshot, false, reason);
        })
        .catch((err) => {
          unit.fail(err);
          return false;
        });
      if (stopped) {
        unit.succeed();
        state.waitingAfter = Date.now();
        return;
      }
    }
  }
  private nativeStopBlocker(tenant: string, snapshot: EndpointSnapshot): string | undefined {
    const runtime = this.context.tenants.get(tenant);
    const blockers = snapshot.stopBlockers;
    const state = this.context.store.workspaces.workspace(tenant);
    if (this.context.endpoint.placement.peek(tenant)?.runState !== 'running') return '会话未运行';
    if (runtime.viewer) return '用户在线';
    if (state.tabs.some((tab) => tab.signIn)) return '正在登录学习账号';
    if (!blockers) return '节点未报告停止条件';
    if (
      this.context.store.operations
        .pendingOperations(tenant)
        .some((operation) => operation.receipt.status === 'applying')
    )
      return '有正在执行的操作';
    if (blockers.inFlightUploads !== 0 || blockers.pendingNativeSelections !== 0)
      return '有正在进行的文件传输';
    if (blockers.downloadsInProgress !== 0 || blockers.pendingDownloadImports !== 0)
      return '有正在进行的下载';
    if (blockers.pendingPageRequests !== 0) return '页面有等待处理的请求';
    if (
      blockers.unacknowledgedEvents !== 0 ||
      blockers.rtcConnected !== false ||
      blockers.lifecycleUncertain !== false
    )
      return '会话状态尚未稳定';
  }
  stopBlocker(tenant: string, snapshot: EndpointSnapshot, immediate: boolean): string | undefined {
    const blocker = this.nativeStopBlocker(tenant, snapshot);
    if (blocker) {
      this.sessionEligibility.delete(tenant);
      return blocker;
    }
    const runtime = this.context.tenants.get(tenant);
    const now = this.context.clock.monotonicMs();
    const previous = this.sessionEligibility.get(tenant);
    const since =
      previous && previous.absence === runtime.viewerAbsentSince && now - previous.observedAt <= 15000
        ? previous.since
        : now;
    this.sessionEligibility.set(tenant, { since, observedAt: now, absence: runtime.viewerAbsentSince });
    if (!this.automaticStopEligible(tenant, this.context.store.workspaces.workspace(tenant), immediate))
      return '未到停止时间';
  }
  async stop(
    tenant: string,
    snapshot: EndpointSnapshot,
    immediate = false,
    reason: StopReason = 'idle',
  ): Promise<boolean> {
    let unit = this.stopRetries.get(tenant);
    if (!unit) {
      unit = new RetryUnit({ name: 'stop.session', now: () => this.context.clock.monotonicMs() });
      this.stopRetries.set(tenant, unit);
    }
    const placement = this.context.endpoint.placement.peek(tenant);
    if (!unit.ready(JSON.stringify([this.context.store.buildId, placement, this.nodeFor(tenant)?.state]))) {
      if (immediate) throw unit.error;
      return false;
    }
    try {
      const stopped = await this.stopOnce(tenant, snapshot, immediate, reason);
      if (stopped) unit.succeed();
      return stopped;
    } catch (cause) {
      unit.fail(cause);
      if (immediate) throw cause;
      return false;
    }
  }
  private async stopOnce(
    tenant: string,
    snapshot: EndpointSnapshot,
    immediate: boolean,
    reason: StopReason,
  ): Promise<boolean> {
    const relief = reason !== 'idle';
    const placement = this.context.endpoint.placement.peek(tenant);
    const node = placement && this.context.endpoint.nodes.get(placement.nodeId);
    const blocker = this.stopBlocker(tenant, snapshot, immediate);
    if (blocker) {
      if (immediate) throw new RemoteKitError('conflict', blocker);
      return false;
    }
    if (
      node &&
      !immediate &&
      !relief &&
      !this.exhausted(node) &&
      (this.relief.has(node.nodeId) || node.reliefRequestedAt !== undefined || node.metrics.underPressure())
    )
      return false;
    if (placement && this.stoppingNodes.has(placement.nodeId)) {
      if (immediate) throw new RemoteKitError('conflict', '节点正在停止其他会话');
      return false;
    }
    const exhaustion = this.exhausted(node);
    const sample = node?.metrics.latest();
    const predicted = node?.metrics.predicted();
    this.stoppingNodes.add(placement!.nodeId);
    try {
      await this.context.endpoint.stop(tenant);
    } finally {
      this.stoppingNodes.delete(placement!.nodeId);
    }
    if (node) delete node.allocationFailedAt;
    const state = this.context.store.workspaces.workspace(tenant);
    for (const tab of state.tabs) {
      if (!tab.idleKeepAlive || !tab.idleKeepAliveState) continue;
      tab.idleKeepAliveOutcome = {
        enabledAt: tab.idleKeepAliveState.enabledAt,
        eligibleSince: tab.idleKeepAliveState.eligibleSince ?? this.context.clock.wallMs(),
        leftAt:
          tab.idleKeepAliveState.leftAt ??
          tab.idleKeepAliveState.eligibleSince ??
          this.context.clock.wallMs(),
        outcome: 'stopped',
        at: this.context.clock.wallMs(),
        reason: exhaustion
          ? 'exhaustion'
          : relief || node?.metrics.underPressure()
            ? 'pressure'
            : 'statistics',
      };
    }
    this.services.operations.saveWorkspace(state);
    log.info('stop.auto', {
      tenant,
      node: placement!.nodeId,
      reason,
      pressure: sample?.pressure ?? null,
      predicted: predicted ?? null,
    });
    this.finishStop(tenant);
    return true;
  }
  finishStop(tenant: string) {
    const runtime = this.context.tenants.get(tenant);
    const state = this.context.store.workspaces.workspace(tenant);
    runtime.resetEndpoint();
    for (const tab of state.tabs)
      if (!isLocalTab(tab)) {
        if (tab.idleKeepAliveState && tab.idleKeepAliveOutcome?.outcome !== 'stopped') {
          tab.idleKeepAliveOutcome = {
            enabledAt: tab.idleKeepAliveState.enabledAt,
            eligibleSince: tab.idleKeepAliveState.eligibleSince ?? this.context.clock.wallMs(),
            leftAt:
              tab.idleKeepAliveState.leftAt ??
              tab.idleKeepAliveState.eligibleSince ??
              this.context.clock.wallMs(),
            outcome: 'stopped',
            at: this.context.clock.wallMs(),
            reason: this.exhausted(this.nodeFor(tenant))
              ? 'exhaustion'
              : this.nodeFor(tenant)?.metrics.underPressure()
                ? 'pressure'
                : 'statistics',
          };
        }
        tab.residency = 'discarded';
        tab.restoring = false;
      }
    this.services.operations.saveWorkspace(state);
  }
  retain(tenant: string, views: Set<string>) {
    for (const key of this.recoveryRetries.keys())
      if (key.startsWith(tenant + '/') && !views.has(key.slice(tenant.length + 1)))
        this.recoveryRetries.delete(key);
    this.context.tenants.get(tenant).lifecycle.background.retain(tenant, views);
  }
  forget(tenant: string, key: string) {
    this.recoveryRetries.delete(key);
    this.context.tenants.get(tenant).lifecycle.background.forget(key);
  }
  remove(tenant: string, viewId: string) {
    const key = tenant + '/' + viewId;
    this.forget(tenant, key);
    this.context.tenants.get(tenant).lifecycle.transitions.delete(key);
  }
  async prepareVisible(
    tenant: string,
    viewId: string,
    visible: boolean,
    current: any,
    lifecycleBlocked: boolean,
  ) {
    const runtime = this.context.tenants.get(tenant).lifecycle,
      key = tenant + '/' + viewId,
      actualState = current?.actual ?? 0;
    let readyToShow = !lifecycleBlocked && actualState === 0 && !current?.pending;
    if (!lifecycleBlocked && visible && actualState !== 0 && !current?.pending) {
      const attempt = runtime.transitions.get(key);
      if (!attempt || attempt.action !== 'restore' || this.context.clock.monotonicMs() - attempt.at > 12000) {
        const applied = await this.applyLifecycle(
          tenant,
          {
            viewId: viewId,
            action: 'restore',
            requireRunning: true,
          },
          current.lifecycle_generation,
        );
        if (!applied) return false;
        runtime.transitions.set(key, {
          action: 'restore',
          at: this.context.clock.monotonicMs(),
        });
      }
      readyToShow = false;
    } else if (readyToShow && runtime.transitions.get(key)?.action === 'restore')
      runtime.transitions.delete(key);

    return readyToShow;
  }

  constructor(
    private readonly context: DomainContext,
    private readonly services: Pick<DomainServices, 'operations'>,
  ) {}
  observeLifecycleRecovery(
    workspace: ProductWorkspace,
    tab: ProductTab,
    current: any,
    browserIncarnation: unknown,
  ) {
    const state = readRecovery(tab);
    const attempt = state?.phase === 'failed' ? state.attempt : state;
    if (
      attempt &&
      typeof browserIncarnation === 'string' &&
      browserIncarnation &&
      attempt.browserIncarnation !== browserIncarnation
    ) {
      transitionRecovery(tab, undefined);
      delete tab.pendingUrl;
      tab.restoring = false;
      return current?.lifecycle_uncertain === true;
    }
    if (!attempt) {
      if (
        state?.phase === 'failed' &&
        current?.lifecycle_uncertain === false &&
        current.actual === 0 &&
        current.pending === false
      ) {
        transitionRecovery(tab, undefined);
        delete tab.pendingUrl;
      }
      return current?.lifecycle_uncertain === true || !!tab.lifecycleRecoveryError;
    }
    const last = current?.last_lifecycle;
    const expected = (BigInt(attempt.generation) + 1n).toString();
    const completed = (generation: string, action: number, actual: number) =>
      browserIncarnation === attempt.browserIncarnation &&
      current?.lifecycle_generation === generation &&
      current.pending === false &&
      current.lifecycle_uncertain === false &&
      last?.generation === generation &&
      last.succeeded === true &&
      last.action === action &&
      current.actual === actual;
    if (attempt.phase === 'unloading' && attempt.evidence === 'pending' && completed(expected, 2, 3))
      transitionRecovery(tab, { ...attempt, generation: expected, evidence: 'unloaded' });
    else if (
      attempt.phase === 'unloading' &&
      attempt.evidence === 'unloaded' &&
      completed(attempt.generation, 2, 3)
    )
      transitionRecovery(tab, attempt);
    else if (attempt.phase === 'restoring' && completed(expected, 3, 0)) {
      transitionRecovery(tab, undefined);
      return false;
    } else if (state?.phase !== 'failed') {
      let reason: WireError | undefined;
      if (!current) reason = wireError(new RemoteKitError('internal', '原页面实例已结束'));
      else if (
        !(attempt.phase === 'unloading' && attempt.evidence === 'unloaded') &&
        browserIncarnation === attempt.browserIncarnation &&
        current.lifecycle_generation === expected &&
        current.pending === false &&
        last?.generation === expected &&
        last.succeeded === false &&
        last.action === (attempt.phase === 'unloading' ? 2 : 3)
      )
        reason = this.lifecycleError(
          last.error
            ? endpointError(last.error)
            : new RemoteKitError('internal', '页面生命周期结果缺少错误码'),
        );
      else if (attempt.phase === 'unloading' && attempt.evidence === 'unloaded')
        reason = wireError(new RemoteKitError('internal', '页面恢复结果未确认'));
      if (reason) transitionRecovery(tab, { phase: 'failed', reason, attempt });
    }
    const next = readRecovery(tab);
    if (
      next?.phase === 'unloading' &&
      next.evidence === 'unloaded' &&
      this.context.tenants.get(workspace.tenantId).viewer
    )
      this.retireLifecycleNavigation(workspace, tab);
    return true;
  }
  retireLifecycleNavigation(state: ProductWorkspace, tab: ProductTab) {
    const nav = tab.navigation;
    delete tab.pendingUrl;
    if (!nav || nav.resolved || !['applying', 'unknown'].includes(nav.status)) return;
    nav.status = 'unknown';
    nav.resolved = true;
    tab.kind = nav.previousKind;
    tab.url = nav.previousUrl;
    if (isLocalTab(tab)) tab.loading = false;
    const saved = this.context.store.operations.operation(state.tenantId, nav.operationId);
    if (!saved || ['committed', 'failed'].includes(saved.receipt.status)) return;
    settle(saved.receipt, { status: 'unknown' });
    saved.receipt.resolved = true;
    saved.receipt.resolution = 'target-retired';
    saved.receipt.error = { code: 'outcome_unknown', message: '原页面实例已结束，导航执行结果未知' };
    delete saved.receipt.application;
    this.context.store.operations.saveOperation(state, saved.receipt);
  }
  lifecycleError(error: unknown) {
    return wireError(toRemoteKitError(error));
  }
  async advanceLifecycleRecovery(
    workspace: ProductWorkspace,
    tab: ProductTab,
    current: any,
    browserIncarnation: unknown,
    visible: boolean,
  ) {
    if (
      !current ||
      current.pending !== false ||
      current.recovery?.pending === true ||
      current.close_state === 'closing' ||
      current.close_state === 'closed' ||
      isLocalTab(tab) ||
      workspace.pendingClose?.id === tab.id ||
      workspace.pendingWindowCloseId === tab.windowId
    )
      return;
    const previous = readRecovery(tab);
    const retryKey = workspace.tenantId + '/' + tab.webviewId;
    const retained = this.recoveryRetries.get(retryKey);
    const changed =
      previous &&
      'attempt' in previous &&
      previous.attempt &&
      (previous.attempt.browserIncarnation !== browserIncarnation ||
        previous.attempt.generation !== current.lifecycle_generation);
    if (previous?.phase === 'failed' && !changed) return;
    const resending =
      retained?.error?.code === 'outcome_unknown' &&
      (previous?.phase === 'restoring' ||
        (previous?.phase === 'unloading' && previous.evidence === 'pending'));
    const action = resending
      ? previous.phase === 'restoring'
        ? 'restore'
        : 'unload'
      : previous && !changed
        ? 'restore'
        : 'unload';
    if (
      previous && !changed && !resending
        ? previous.phase !== 'unloading' ||
          previous.evidence !== 'unloaded' ||
          !visible ||
          previous.browserIncarnation !== browserIncarnation ||
          previous.generation !== current.lifecycle_generation ||
          current.actual !== 3 ||
          current.lifecycle_uncertain !== false
        : current.lifecycle_uncertain !== true
    )
      return;
    const generation = current.lifecycle_generation;
    if (
      typeof browserIncarnation !== 'string' ||
      !browserIncarnation ||
      typeof generation !== 'string' ||
      !/^\d{1,20}$/.test(generation)
    ) {
      transitionRecovery(tab, {
        phase: 'failed',
        reason: wireError(new RemoteKitError('internal', '页面恢复缺少实例标识')),
      });
      tab.restoring = false;
      this.services.operations.saveWorkspace(workspace);
      return;
    }
    const identity = JSON.stringify([browserIncarnation, generation, action]);
    let retry = this.recoveryRetries.get(retryKey);
    if (!retry) {
      retry = new RetryUnit({
        now: () => this.context.clock.monotonicMs(),
        failed: (error) =>
          log.warn('lifecycle.recovery_failed', {
            tenant: workspace.tenantId,
            viewId: tab.webviewId,
            err: error,
          }),
        recovered: () =>
          log.info('lifecycle.recovery_recovered', { tenant: workspace.tenantId, viewId: tab.webviewId }),
      });
      this.recoveryRetries.set(retryKey, retry);
    }
    if (!retry.ready(identity)) return;
    const attempt: RecoveryAttempt =
      action === 'unload'
        ? {
            phase: 'unloading',
            evidence: 'pending',
            browserIncarnation,
            generation,
            submittedAt: this.context.clock.wallMs(),
          }
        : { phase: 'restoring', browserIncarnation, generation, submittedAt: this.context.clock.wallMs() };
    transitionRecovery(tab, attempt);
    tab.restoring = true;
    this.services.operations.saveWorkspace(workspace);
    try {
      const result = await this.context.endpoint.lifecycle(workspace.tenantId, {
        viewId: tab.webviewId,
        action,
        requireRunning: true,
        browserIncarnation,
        lifecycleGeneration: generation,
      });
      if (result?.accepted !== true) throw new RemoteKitError('outcome_unknown', 'Endpoint 未确认请求');
      retry.succeed();
      this.recoveryRetries.delete(retryKey);
    } catch (error) {
      const failure = toRemoteKitError(error);
      const { delay } = retry.fail(failure);
      if (delay !== undefined && failure.code !== 'outcome_unknown') {
        transitionRecovery(tab, previous);
        tab.restoring = false;
        this.services.operations.saveWorkspace(workspace);
        return;
      }
      if (errorHandling(failure.code) === 'reconcile') return;
      transitionRecovery(tab, { phase: 'failed', reason: this.lifecycleError(failure), attempt });
      tab.restoring = false;
      this.services.operations.saveWorkspace(workspace);
    }
  }
  async maintainBackgroundTab(
    state: ProductWorkspace,
    tab: ProductTab,
    current: any,
    visible: boolean,
    browserIncarnation: unknown,
  ) {
    const tenant = state.tenantId,
      key = tenant + '/' + tab.webviewId;
    const node = this.nodeFor(tenant);
    const exhaustion = this.exhausted(node);
    const protectedByProduct =
      isLocalTab(tab) ||
      !!tab.signIn ||
      (!!tab.popup && tab.popup.status !== 'adopted') ||
      state.pendingClose?.id === tab.id ||
      state.pendingWindowCloseId === tab.windowId;
    const observation: ReclaimObservation = {
      visible,
      protectedByProduct,
      current,
      browserIncarnation,
      underPressure: node?.metrics.underPressure(),
      dwellFactor: dwellFactor(normalizedUsagePage(tab.url), this.context.store.reclaim.dwell(tenant)),
      idleKeepAlive: tab.idleKeepAlive,
      exhaustion,
    };
    if (tab.idleKeepAliveState) {
      const record = tab.idleKeepAliveState;
      const eligible = backgroundEligible(observation);
      let changed = false;
      if (eligible && record.eligibleSince === undefined) {
        record.eligibleSince = this.context.clock.wallMs();
        tab.idleKeepAliveOutcome = {
          enabledAt: record.enabledAt,
          eligibleSince: record.eligibleSince,
          leftAt: record.leftAt ?? record.eligibleSince,
          outcome: 'survived',
          at: record.eligibleSince,
          reason: 'statistics',
        };
        changed = true;
      } else if (
        !eligible &&
        !visible &&
        record.eligibleSince !== undefined &&
        current?.actual !== 1 &&
        current?.actual !== 2
      ) {
        delete record.eligibleSince;
        changed = true;
      }
      if (!visible && this.observeReclaimed(tab, current)) changed = true;
      if (changed) this.services.operations.saveWorkspace(state);
    }
    const action = this.context.tenants.get(tenant).lifecycle.background.action(key, observation);
    if (!action) return;
    const attempt = this.context.tenants.get(tenant).lifecycle.transitions.get(key);
    if (attempt?.action === action && this.context.clock.monotonicMs() - attempt.at <= 12000) return;
    const applied = await this.applyLifecycle(
      tenant,
      {
        viewId: tab.webviewId,
        action,
        requireRunning: true,
        browserIncarnation: typeof browserIncarnation === 'string' ? browserIncarnation : undefined,
      },
      current.lifecycle_generation,
    );
    if (!applied) return;
    if (tab.idleKeepAliveOutcome && exhaustion) {
      tab.idleKeepAliveOutcome.reason = 'exhaustion';
      this.services.operations.saveWorkspace(state);
    }
    this.context.tenants
      .get(tenant)
      .lifecycle.transitions.set(key, { action, at: this.context.clock.monotonicMs() });
    if (action === 'freeze') this.context.tenants.get(tenant).lifecycle.background.freezeRequested(key);
  }
}

type BackgroundView = {
  actual?: number;
  desired?: number;
  visible?: boolean;
  canDiscard?: boolean;
  instance?: unknown;
  pending?: boolean;
  audible?: boolean;
  captured?: boolean;
  pending_close?: boolean;
  close_state?: string;
  recovery?: { pending?: boolean };
  pageRequests?: { pending?: unknown[] };
};

export interface ReclaimObservation {
  underPressure?: boolean;
  dwellFactor?: number;
  idleKeepAlive?: boolean;
  exhaustion?: boolean;
  visible: boolean;
  protectedByProduct: boolean;
  current?: BackgroundView;
  browserIncarnation: unknown;
}
function backgroundCandidate(observation: ReclaimObservation) {
  const { visible, protectedByProduct, current } = observation;
  return (
    !visible &&
    !protectedByProduct &&
    !!current &&
    current.visible === false &&
    !current.audible &&
    !current.captured &&
    !current.pending_close &&
    !current.recovery?.pending &&
    !current.pageRequests?.pending?.length &&
    current.close_state !== 'closing' &&
    (current.actual === 0 || current.actual === 1)
  );
}
export function backgroundEligible(observation: ReclaimObservation) {
  return (
    backgroundCandidate(observation) &&
    observation.current?.pending !== true &&
    observation.current?.canDiscard === true
  );
}
type Accounting = { eligibleMs: number; observedAt: number; freezeRequested: boolean; identity: string };
type ReclaimAction = 'freeze' | 'discard';
function advanceReclaim(
  entry: Accounting | undefined,
  observation: ReclaimObservation,
  now: number,
): { entry?: Accounting; action: ReclaimAction | null } {
  const { current, browserIncarnation } = observation;
  if (!backgroundCandidate(observation) || !current || (observation.idleKeepAlive && !observation.exhaustion))
    return { action: null };
  const identity = JSON.stringify([browserIncarnation, current.instance]);
  if (entry && (entry.identity !== identity || now - entry.observedAt > 15000)) entry = undefined;
  if (current.pending && entry?.freezeRequested && current.desired === 1)
    return { entry: { ...entry, observedAt: now }, action: null };
  if (current.pending || current.canDiscard !== true) return { action: null };
  const next: Accounting = entry
    ? {
        ...entry,
        eligibleMs: entry.eligibleMs + Math.max(0, now - entry.observedAt),
        observedAt: now,
        freezeRequested: false,
      }
    : { eligibleMs: 0, observedAt: now, freezeRequested: false, identity };
  return {
    entry: next,
    action: observation.exhaustion
      ? 'discard'
      : next.eligibleMs >=
          tabReclaimDelays(observation.dwellFactor ?? 1, !!observation.underPressure).discardMs
        ? 'discard'
        : current.actual === 0 &&
            next.eligibleMs >=
              tabReclaimDelays(observation.dwellFactor ?? 1, !!observation.underPressure).freezeMs
          ? 'freeze'
          : null,
  };
}
export class BackgroundReclaim {
  private accounting?: Accounting;
  constructor(private readonly clock: Clock = systemClock) {}
  next(observation: ReclaimObservation, now: number): ReclaimAction | null {
    return advanceReclaim(this.accounting, observation, now).action;
  }
  observe(observation: ReclaimObservation): ReclaimAction | null {
    const next = advanceReclaim(this.accounting, observation, this.clock.monotonicMs());
    this.accounting = next.entry;
    return next.action;
  }
  freezeRequested() {
    if (this.accounting) this.accounting = { ...this.accounting, freezeRequested: true };
  }
}
export class BackgroundReclaimViews {
  private readonly views = new Map<string, BackgroundReclaim>();
  constructor(private readonly clock: Clock = systemClock) {}
  clear() {
    this.views.clear();
  }
  forget(key: string) {
    this.views.delete(key);
  }
  retain(tenant: string, viewIds: Set<string>) {
    const prefix = tenant + '/';
    for (const key of this.views.keys())
      if (key.startsWith(prefix) && !viewIds.has(key.slice(prefix.length))) this.views.delete(key);
  }
  freezeRequested(key: string) {
    this.views.get(key)?.freezeRequested();
  }
  action(key: string, observation: ReclaimObservation) {
    let view = this.views.get(key);
    if (!view) {
      view = new BackgroundReclaim(this.clock);
      this.views.set(key, view);
    }
    return view.observe(observation);
  }
}

type RecoveryIdentity = { browserIncarnation: string; generation: string; submittedAt: number };
export type RecoveryAttempt =
  | (RecoveryIdentity & { phase: 'unloading'; evidence: 'pending' | 'unloaded' })
  | (RecoveryIdentity & { phase: 'restoring' });
export type UncertainRecoveryState =
  RecoveryAttempt | { phase: 'failed'; reason: WireError; attempt?: RecoveryAttempt };
function readRecovery(tab: ProductTab): UncertainRecoveryState | undefined {
  const saved = tab.lifecycleRecovery;
  const attempt: RecoveryAttempt | undefined = saved
    ? saved.phase === 'restore'
      ? { ...saved, phase: 'restoring' }
      : { ...saved, phase: 'unloading', evidence: saved.phase === 'unloaded' ? 'unloaded' : 'pending' }
    : undefined;
  return tab.lifecycleRecoveryError
    ? { phase: 'failed', reason: tab.lifecycleRecoveryError, attempt }
    : attempt;
}
function transitionRecovery(tab: ProductTab, state: UncertainRecoveryState | undefined) {
  const attempt = state?.phase === 'failed' ? state.attempt : state;
  if (state?.phase === 'failed') tab.lifecycleRecoveryError = state.reason;
  else delete tab.lifecycleRecoveryError;
  if (attempt)
    tab.lifecycleRecovery = {
      browserIncarnation: attempt.browserIncarnation,
      generation: attempt.generation,
      submittedAt: attempt.submittedAt,
      phase:
        attempt.phase === 'restoring' ? 'restore' : attempt.evidence === 'unloaded' ? 'unloaded' : 'unload',
    };
  else delete tab.lifecycleRecovery;
}
