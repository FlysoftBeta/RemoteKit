import type { EndpointSnapshot } from '../endpoint/types';
import { RemoteKitError, toRemoteKitError } from '../../shared/errors';
import { settle } from './operations';

import type { ProductTab, ProductWorkspace } from '../../shared/product';
import { isLocalTab } from '../../shared/product';
import type { DomainContext, DomainServices } from '../application';
import { systemClock, type Clock } from '../util/clock';

export class UncertainRecovery {
  // An administrator may hibernate at once; automatic hibernation also needs Memory Saver and idle time.
  hibernationBlocker(tenant: string, snapshot: EndpointSnapshot, immediate: boolean): string | undefined {
    const runtime = this.context.tenants.get(tenant);
    const blockers = snapshot.hibernation;
    if (this.context.endpoint.placement.peek(tenant)?.state !== 'active') return '会话未运行';
    if (runtime.viewer) return '用户在线';
    if (!blockers) return '节点未报告休眠条件';
    if (
      !immediate &&
      (!this.context.store.workspaces.workspace(tenant).settings.browser.memorySaverEnabled ||
        this.context.clock.monotonicMs() - runtime.viewerAbsentSince <
          (this.context.endpoint.placement.underPressure(tenant) ? 120000 : 600000))
    )
      return '未到休眠时间';
    if (
      this.context.store.operations
        .pendingOperations(tenant)
        .some((operation) => operation.receipt.status === 'applying')
    )
      return '有正在执行的操作';
    if (blockers.inFlightUploads !== 0 || blockers.pendingNativeSelections !== 0)
      return '有正在进行的文件传输';
    if (blockers.downloadsInProgress !== 0) return '有正在进行的下载';
    if (blockers.pendingPageRequests !== 0) return '页面有等待处理的请求';
    if (
      blockers.unacknowledgedClosedEvents !== 0 ||
      blockers.rtcConnected !== false ||
      blockers.lifecycleUncertain !== false
    )
      return '会话状态尚未稳定';
  }
  async hibernate(tenant: string, snapshot: EndpointSnapshot, immediate = false): Promise<boolean> {
    const runtime = this.context.tenants.get(tenant);
    const state = this.context.store.workspaces.workspace(tenant);
    const blocker = this.hibernationBlocker(tenant, snapshot, immediate);
    if (blocker) {
      if (immediate) throw new RemoteKitError('conflict', blocker);
      return false;
    }
    await this.context.endpoint.hibernate(tenant);
    runtime.resetEndpoint();
    for (const tab of state.tabs)
      if (!isLocalTab(tab)) {
        tab.residency = 'discarded';
        tab.restoring = false;
      }
    this.services.operations.saveWorkspace(state);
    return true;
  }
  retain(tenant: string, views: Set<string>) {
    this.context.tenants.get(tenant).lifecycle.background.retain(tenant, views);
  }
  forget(tenant: string, key: string) {
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
        await this.context.endpoint.lifecycle(tenant, { viewId: viewId, action: 'restore' });
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
      let reason: string | undefined;
      if (!current) reason = '无法确认原页面实例，请关闭此标签页后重新打开';
      else if (
        !(attempt.phase === 'unloading' && attempt.evidence === 'unloaded') &&
        browserIncarnation === attempt.browserIncarnation &&
        current.lifecycle_generation === expected &&
        current.pending === false &&
        last?.generation === expected &&
        last.succeeded === false &&
        last.action === (attempt.phase === 'unloading' ? 2 : 3)
      )
        reason = this.lifecycleError(last.detail);
      else if (
        (attempt.phase === 'unloading' && attempt.evidence === 'unloaded') ||
        this.context.clock.wallMs() - attempt.submittedAt > 15000
      )
        reason = '无法确认页面恢复结果，请关闭此标签页后重新打开';
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
    if (!saved || ['committed', 'rejected'].includes(saved.receipt.status)) return;
    settle(saved.receipt, { status: 'unknown' });
    saved.receipt.resolved = true;
    saved.receipt.resolution = 'target-retired';
    saved.receipt.error = '原页面实例已结束，导航执行结果未知';
    delete saved.receipt.application;
    this.context.store.operations.saveOperation(state, saved.receipt);
  }
  lifecycleError(error: unknown) {
    const detail = toRemoteKitError(error).message;
    return detail
      ? `页面恢复未确认（${detail.slice(0, 240)}），请关闭此标签页后重新打开`
      : '页面恢复未确认，请关闭此标签页后重新打开';
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
    if (previous?.phase === 'failed') return;
    const action = previous ? 'restore' : 'unload';
    if (
      previous
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
      transitionRecovery(tab, { phase: 'failed', reason: '页面恢复缺少实例标识，请关闭此标签页后重新打开' });
      tab.restoring = false;
      this.services.operations.saveWorkspace(workspace);
      return;
    }
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
      if (result?.accepted !== true) throw new RemoteKitError('rejected', 'Endpoint 未确认请求');
    } catch (error) {
      transitionRecovery(tab, { phase: 'failed', reason: this.lifecycleError(error), attempt });
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
    const action = this.context.tenants
      .get(tenant)
      .lifecycle.background.action(
        key,
        state.settings.browser.memorySaverEnabled,
        visible,
        isLocalTab(tab) ||
          (!!tab.popup && tab.popup.status !== 'adopted') ||
          state.pendingClose?.id === tab.id ||
          state.pendingWindowCloseId === tab.windowId,
        current,
        browserIncarnation,
      );
    if (!action) return;
    const attempt = this.context.tenants.get(tenant).lifecycle.transitions.get(key);
    if (attempt?.action === action && this.context.clock.monotonicMs() - attempt.at <= 12000) return;
    await this.context.endpoint.lifecycle(tenant, {
      viewId: tab.webviewId,
      action,
      requireRunning: true,
    });
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

export interface MemoryObservation {
  enabled: boolean;
  visible: boolean;
  protectedByProduct: boolean;
  current?: BackgroundView;
  browserIncarnation: unknown;
}
type Accounting = { eligibleMs: number; observedAt: number; freezeRequested: boolean; identity: string };
type MemoryAction = 'freeze' | 'discard';
function advanceMemory(
  entry: Accounting | undefined,
  observation: MemoryObservation,
  now: number,
): { entry?: Accounting; action: MemoryAction | null } {
  const { enabled, visible, protectedByProduct, current, browserIncarnation } = observation;
  if (
    !enabled ||
    visible ||
    protectedByProduct ||
    !current ||
    current.visible !== false ||
    current.audible ||
    current.captured ||
    current.pending_close ||
    current.recovery?.pending ||
    current.pageRequests?.pending?.length ||
    current.close_state === 'closing' ||
    (current.actual !== 0 && current.actual !== 1)
  )
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
    action:
      next.eligibleMs >= 120000
        ? 'discard'
        : current.actual === 0 && next.eligibleMs >= 30000
          ? 'freeze'
          : null,
  };
}
export class MemorySaver {
  private accounting?: Accounting;
  constructor(private readonly clock: Clock = systemClock) {}
  next(observation: MemoryObservation, now: number): MemoryAction | null {
    return advanceMemory(this.accounting, observation, now).action;
  }
  observe(observation: MemoryObservation): MemoryAction | null {
    const next = advanceMemory(this.accounting, observation, this.clock.monotonicMs());
    this.accounting = next.entry;
    return next.action;
  }
  freezeRequested() {
    if (this.accounting) this.accounting = { ...this.accounting, freezeRequested: true };
  }
}
export class MemorySaverViews {
  private readonly views = new Map<string, MemorySaver>();
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
  action(
    key: string,
    enabled: boolean,
    visible: boolean,
    protectedByProduct: boolean,
    current: BackgroundView | undefined,
    browserIncarnation: unknown,
  ) {
    let view = this.views.get(key);
    if (!view) {
      view = new MemorySaver(this.clock);
      this.views.set(key, view);
    }
    return view.observe({ enabled, visible, protectedByProduct, current, browserIncarnation });
  }
}

type RecoveryIdentity = { browserIncarnation: string; generation: string; submittedAt: number };
export type RecoveryAttempt =
  | (RecoveryIdentity & { phase: 'unloading'; evidence: 'pending' | 'unloaded' })
  | (RecoveryIdentity & { phase: 'restoring' });
export type UncertainRecoveryState =
  RecoveryAttempt | { phase: 'failed'; reason: string; attempt?: RecoveryAttempt };
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
