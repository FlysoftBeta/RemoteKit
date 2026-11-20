import { browserAvailability } from './browser-availability';
import { RetryUnit } from '../../shared/retry-unit';
import { endpointError } from '../endpoint/gateway';
import { createHash } from 'node:crypto';
import {
  PENDING_CLOSE_DETAIL,
  parseWireError,
  RemoteKitError,
  toRemoteKitError,
  wireError,
} from '../../shared/errors';
import { SITE_PERMISSIONS, type FileRequest, type PageDialogReply } from '../../shared/product';
import type { DownloadEvent, FileBinding, PageIdentity, PageReplyFields } from '../endpoint/types';
import { log } from '../log';
import { removeWindow } from './model';
import { settle } from './operations';
import { ensureSite, pruneSite, validProtocolHandler, validSiteOrigin } from './site-policy';
export type FileLimits = FileRequest['limits'];
export interface InternalFileRequest extends FileRequest {
  binding: FileBinding;
}

import type {
  FileRequestAnchor,
  PageDialog,
  PendingClose,
  ProductTab,
  ProductWorkspace,
} from '../../shared/product';
import { isLocalTab } from '../../shared/product';
import type { FullscreenBinding } from '../tenants/tenant-runtime';

import type { DomainContext, DomainServices } from '../application';

export function validatePageReply(value: any): asserts value is PageDialogReply {
  const invalid = () => {
    throw new RemoteKitError('invalid_request', '无效的页面对话回复');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  let keys: string[];
  switch (value.kind) {
    case 'permission':
      keys = ['kind', 'decision'];
      if (!['allow', 'allow_once', 'block', 'dismiss'].includes(value.decision)) return invalid();
      break;
    case 'dialog':
      keys = ['kind', 'accept', 'text'];
      if (
        value.text !== undefined &&
        (typeof value.text !== 'string' || Buffer.byteLength(value.text, 'utf8') > 16384)
      )
        return invalid();
      break;
    case 'http_auth':
      keys = value.accept === true ? ['kind', 'accept', 'username', 'password'] : ['kind', 'accept'];
      if (
        value.accept === true &&
        ![value.username, value.password].every(
          (text) => typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= 1024,
        )
      )
        return invalid();
      break;
    case 'repost':
      keys = ['kind', 'accept'];
      break;
    case 'protocol_handler':
      keys = ['kind', 'accept', 'remember'];
      if (typeof value.remember !== 'boolean' || (value.accept && !value.remember)) return invalid();
      break;
    default:
      return invalid();
  }
  if (
    (value.kind !== 'permission' && typeof value.accept !== 'boolean') ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    invalid();
}
type PageRequestFields<T = PageDialog> = T extends PageDialog ? Omit<T, 'id' | 'tabId' | 'windowId'> : never;
export function projectPageRequest(request: any): PageRequestFields | undefined {
  if (
    !request ||
    typeof request !== 'object' ||
    typeof request.request !== 'string' ||
    !request.request ||
    request.request.length > 2048 ||
    (request.origin !== undefined && typeof request.origin !== 'string')
  )
    return;
  const origin = (request.origin ?? '').slice(0, 2048);
  switch (request.kind) {
    case 'alert':
    case 'confirm':
    case 'prompt':
    case 'beforeunload':
      if (
        (request.message !== undefined && typeof request.message !== 'string') ||
        (request.default_prompt !== undefined && typeof request.default_prompt !== 'string') ||
        (request.is_reload !== undefined && typeof request.is_reload !== 'boolean')
      )
        return;
      return {
        kind: request.kind,
        origin,
        message: (request.message ?? '').slice(0, 16384),
        defaultPrompt: (request.default_prompt ?? '').slice(0, 16384),
        ...(request.is_reload === undefined ? {} : { isReload: request.is_reload }),
      };
    case 'permission':
      if (
        !validSiteOrigin(request.origin) ||
        !validSiteOrigin(request.embedding_origin) ||
        !Array.isArray(request.permissions) ||
        !request.permissions.length ||
        request.permissions.length > SITE_PERMISSIONS.length ||
        !request.permissions.every((p: any) => SITE_PERMISSIONS.includes(p)) ||
        new Set(request.permissions).size !== request.permissions.length
      )
        return;
      return {
        kind: 'permission',
        origin,
        embeddingOrigin: request.embedding_origin,
        permissions: [...request.permissions],
      };
    case 'http_auth':
      if (
        typeof request.proxy !== 'boolean' ||
        typeof request.realm !== 'string' ||
        !['basic', 'digest', 'ntlm', 'negotiate'].includes(request.scheme) ||
        typeof request.url !== 'string'
      )
        return;
      if (
        request.proxy
          ? !/^(?:\[[0-9a-fA-F:]+\]|[^\s/:]+):[0-9]{1,5}$/.test(request.origin)
          : !validSiteOrigin(request.origin)
      )
        return;
      try {
        const url = new URL(request.url);
        if (!['http:', 'https:'].includes(url.protocol)) return;
      } catch {
        return;
      }
      return {
        kind: 'http_auth',
        origin,
        realm: request.realm.slice(0, 2048),
        scheme: request.scheme,
        proxy: request.proxy,
        url: request.url.slice(0, 2048),
      };
    case 'repost':
      if (!validSiteOrigin(request.origin)) return;
      return { kind: 'repost', origin };
    case 'protocol_handler':
      if (!validProtocolHandler(request.origin, request.protocol, request.url)) return;
      return { kind: 'protocol_handler', origin, protocol: request.protocol, url: request.url };
  }
}
function fileRequestAnchor(value: any, instance: string, document: string): FileRequestAnchor | undefined {
  if (
    !value ||
    value.instance !== instance ||
    value.document !== document ||
    typeof value.layoutGeneration !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(value.layoutGeneration)
  )
    return;
  const { x, y, width, height, viewportWidth, viewportHeight, deviceScaleFactor, layoutGeneration } = value;
  if (
    ![x, y, width, height, viewportWidth, viewportHeight, deviceScaleFactor].every(Number.isFinite) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    deviceScaleFactor <= 0 ||
    x + width > viewportWidth + 0.001 ||
    y + height > viewportHeight + 0.001
  )
    return;
  return {
    x,
    y,
    width,
    height,
    viewportWidth,
    viewportHeight,
    deviceScaleFactor,
    instance,
    document,
    layoutGeneration,
  };
}

export class PageRequests {
  private readonly closeRetries = new Map<string, RetryUnit>();
  failures() {
    return [...this.closeRetries.values()].map((unit) => unit.error).filter((error) => error !== undefined);
  }
  clearFullscreen(tenant: string) {
    delete this.context.tenants.get(tenant).pageRequests.fullscreen;
  }
  clearTransient(tenant: string) {
    const requests = this.context.tenants.get(tenant).pageRequests;
    delete requests.dialogs;
    delete requests.files;
  }
  clear(tenant: string) {
    this.context.tenants.get(tenant).pageRequests = {};
  }

  constructor(
    private readonly context: DomainContext,
    private readonly services: Pick<
      DomainServices,
      'lifecycle' | 'operations' | 'viewers' | 'policy' | 'library' | 'learning'
    >,
  ) {}
  fullscreenTabs(workspace: ProductWorkspace) {
    return workspace.tabs.filter(
      (tab) =>
        !isLocalTab(tab) &&
        workspace.windows.some((window) => window.id === tab.windowId && window.activeTabId === tab.id) &&
        workspace.spaces.some(
          (space) => space.id === workspace.activeSpaceId && space.windowIds.includes(tab.windowId),
        ),
    );
  }
  fullscreenBinding(workspace: ProductWorkspace) {
    const viewer = this.context.tenants.get(workspace.tenantId).viewer,
      binding = this.context.tenants.get(workspace.tenantId).pageRequests.fullscreen;
    if (
      viewer &&
      !viewer.security?.locked &&
      binding &&
      this.fullscreenTabs(workspace).some(
        (tab) =>
          tab.id === binding.page.tabId &&
          tab.webviewId === binding.viewId &&
          tab.windowId === binding.page.windowId,
      )
    )
      return binding;
  }
  observeFullscreen(workspace: ProductWorkspace, snapshot: any, views: any[]) {
    const tenant = workspace.tenantId,
      viewer = this.context.tenants.get(tenant).viewer,
      previous = this.context.tenants.get(tenant).pageRequests.fullscreen;
    const browserIncarnation = snapshot.browserIncarnation;
    let next: FullscreenBinding | undefined;
    if (
      viewer &&
      !viewer.security?.locked &&
      snapshot.running !== false &&
      typeof browserIncarnation === 'string' &&
      browserIncarnation
    ) {
      const tabs = this.fullscreenTabs(workspace).sort((a, b) => {
        const priority = (tab: ProductTab) =>
          tab.id === previous?.page.tabId
            ? 2
            : Number(
                tab.windowId ===
                  workspace.spaces.find((space) => space.id === workspace.activeSpaceId)?.focusedWindowId,
              );
        return priority(b) - priority(a);
      });
      for (const tab of tabs) {
        const view = views.find((view) => view.viewId === tab.webviewId);
        if (
          view?.fullscreen !== true ||
          view.close_state === 'closed' ||
          (view.visible !== true &&
            tab.windowId !==
              workspace.spaces.find((space) => space.id === workspace.activeSpaceId)?.focusedWindowId &&
            tab.id !== previous?.page.tabId) ||
          ![view.instance, view.document].every(
            (id) => typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id),
          )
        )
          continue;
        const { instance, document } = view;
        const target = createHash('sha256')
          .update(JSON.stringify([browserIncarnation, tab.webviewId, instance, document]))
          .digest('hex');
        next = {
          page: { tabId: tab.id, windowId: tab.windowId, target },
          viewId: tab.webviewId,
          browserIncarnation,
          instance,
          document,
        };
        break;
      }
    }
    if (next) this.context.tenants.get(tenant).pageRequests.fullscreen = next;
    else delete this.context.tenants.get(tenant).pageRequests.fullscreen;
    return next?.page.target !== previous?.page.target || next?.page.windowId !== previous?.page.windowId;
  }
  removeProductTab(state: ProductWorkspace, tab: ProductTab) {
    state.tabs = state.tabs.filter((t) => t.id !== tab.id);
    const w = state.windows.find((w) => w.id === tab.windowId);
    if (w?.activeTabId === tab.id) w.activeTabId = state.tabs.find((t) => t.windowId === w.id)?.id ?? null;
    if (w?.appId.startsWith('web:')) removeWindow(state, w.id);
    if (state.pendingClose?.id === tab.id) state.pendingClose = null;
    this.services.lifecycle.remove(state.tenantId, tab.webviewId);
  }
  pendingClose(tab: ProductTab, result: any, timing: CloseTiming): PendingClose {
    const { id, windowId } = tab;
    if (
      typeof result.browserIncarnation !== 'string' ||
      !result.browserIncarnation ||
      result.instance === undefined ||
      result.document === undefined
    )
      throw new RemoteKitError('conflict', 'Endpoint关闭请求缺少页面身份');
    const identity: PageIdentity = {
      viewId: tab.webviewId,
      browserIncarnation: result.browserIncarnation,
      instance: String(result.instance),
      document: String(result.document),
    };
    const nativeRequestId = result.requestId === undefined ? undefined : String(result.requestId);
    const flow: TabCloseFlow = nativeRequestId
      ? {
          phase: 'awaitingUser',
          tabId: id,
          identity,
          ...timing,
          enteredAt: this.context.clock.wallMs(),
          windowId,
          nativeRequestId,
          requestId: this.closeToken(
            identity.browserIncarnation,
            id,
            identity.instance,
            identity.document,
            nativeRequestId,
          ),
        }
      : {
          phase: 'awaitingPrompt',
          tabId: id,
          identity,
          windowId,
          ...timing,
          enteredAt: this.context.clock.wallMs(),
        };
    return projectClose(flow)!;
  }
  closeToken(browser: string, tab: string, instance: string, document: string, request: string) {
    return createHash('sha256')
      .update(JSON.stringify([browser, tab, instance, document, request]))
      .digest('hex');
  }
  private closeTiming(tenant: string) {
    const observation = this.context.endpoint.observation(tenant);
    return {
      enteredAt: this.context.clock.wallMs(),
      observationEpoch: observation
        ? `${observation.endpointIncarnation}:${observation.connectionEpoch}`
        : '',
      observationSequence: observation?.seq ?? '0',
    };
  }
  private closeOperations(state: ProductWorkspace, target?: ProductTab) {
    const tabId = state.pendingClose?.id ?? target?.id;
    const windows = new Set([
      state.pendingWindowCloseId,
      ...(state.pendingWindowCloseIds ?? []),
      state.pendingClose?.windowId,
      target?.windowId,
    ]);
    return this.context.store.operations.pendingOperations(state.tenantId).filter(({ action, receipt }) => {
      if (receipt.resolved) return false;
      return (
        (action.type === 'tab.close' && action.tabId === tabId) ||
        (action.type === 'window.close' && windows.has(action.windowId)) ||
        (state.pendingWindowCloseId && action.type === 'space.close') ||
        (action.type === 'app.uninstall' && action.appId === `web:${state.pendingAppUninstallId}`)
      );
    });
  }
  private logClose(
    state: ProductWorkspace,
    before: ProductWorkspace,
    event: 'close.phase_changed' | 'close.completed' | 'close.failed',
    reason: string,
    operationIds: string[],
    target?: ProductTab,
    failure?: RemoteKitError,
  ) {
    const previous = before.pendingClose;
    const tab = target ?? before.tabs.find((tab) => tab.id === previous?.id);
    const oldPhase = readClose(previous, tab?.webviewId ?? '').phase;
    const newPhase = failure
      ? failure.code === 'outcome_unknown'
        ? 'unknown'
        : failure.code === 'canceled'
          ? 'canceled'
          : 'failed'
      : event === 'close.completed'
        ? 'completed'
        : readClose(state.pendingClose, tab?.webviewId ?? '').phase;
    for (const operationId of operationIds.length ? operationIds : [null]) {
      const fields = {
        tenant: state.tenantId,
        operationId,
        windowId: previous?.windowId ?? tab?.windowId ?? before.pendingWindowCloseId ?? null,
        tabId: previous?.id ?? tab?.id ?? null,
        viewId: tab?.webviewId ?? null,
        oldPhase,
        newPhase,
        reason,
        ...(failure ? { code: failure.code } : {}),
      };
      if (event === 'close.failed') log.warn(event, fields);
      else log.info(event, fields);
    }
  }
  private saveCloseChange(
    state: ProductWorkspace,
    change: () => void,
    reason: string,
    failure?: RemoteKitError,
    excludeOperationId?: string,
    target?: ProductTab,
  ) {
    const before = structuredClone(state);
    const related = this.closeOperations(state, target).filter(
      ({ receipt }) => receipt.operationId !== excludeOperationId,
    );
    try {
      this.context.store.transaction(() => {
        change();
        if (failure) {
          state.pendingClose = null;
          state.pendingWindowCloseId = null;
          delete state.pendingWindowCloseIds;
          delete state.pendingAppUninstallId;
        }
        for (const pending of this.context.store.operations.pendingOperations(state.tenantId)) {
          if (pending.receipt.resolved) continue;
          const a = pending.action;
          const completed =
            (a.type === 'tab.close' && !a.cancel && !state.tabs.some((tab) => tab.id === a.tabId)) ||
            (a.type === 'window.close' && !state.windows.some((win) => win.id === a.windowId)) ||
            (a.type === 'space.close' && !state.spaces.some((space) => a.spaceIds.includes(space.id))) ||
            (a.type === 'app.uninstall' && !state.apps.some((app) => `web:${app.id}` === a.appId));
          if (failure && related.some(({ receipt }) => receipt.operationId === pending.receipt.operationId)) {
            settle(pending.receipt, {
              status: failure.code === 'outcome_unknown' ? 'unknown' : 'failed',
              error: wireError(failure),
              ...(failure.code === 'outcome_unknown' ? { resolved: true } : {}),
            });
          } else if (completed) settle(pending.receipt, { status: 'committed' });
          else continue;
          this.context.store.operations.saveOperation(state, pending.receipt);
        }
        this.context.store.workspaces.saveWorkspace(state);
      });
    } catch (error) {
      for (const key of Object.keys(state)) delete (state as unknown as Record<string, unknown>)[key];
      Object.assign(state, before);
      throw error;
    }
    this.logClose(
      state,
      before,
      failure ? 'close.failed' : state.pendingClose ? 'close.phase_changed' : 'close.completed',
      reason,
      related.map(({ receipt }) => receipt.operationId),
      target,
      failure,
    );
    this.context.endpoint.invalidate(state.tenantId);
    this.services.viewers.push(state.tenantId);
  }
  private completeTabClose(state: ProductWorkspace, tab: ProductTab, reason: string) {
    this.saveCloseChange(state, () => this.removeProductTab(state, tab), reason, undefined, undefined, tab);
  }
  observePendingClose(state: ProductWorkspace) {
    if (!state.pendingClose) return;
    const tab = state.tabs.find((tab) => tab.id === state.pendingClose!.id);
    if (!tab) {
      this.saveCloseChange(
        state,
        () => {
          state.pendingClose = null;
        },
        'tab_missing',
      );
      return;
    }
    const flow = readClose(state.pendingClose, tab.webviewId);
    if (flow.phase === 'none') {
      this.saveCloseChange(
        state,
        () => {},
        'invalid_identity',
        new RemoteKitError('outcome_unknown', '关闭请求缺少页面身份', { detail: 'close_identity_missing' }),
      );
      return;
    }
    const observed = this.context.endpoint.observation(state.tenantId);
    const view = observed?.views.find((view) => view.viewId === tab.webviewId);
    const currentEpoch = observed ? `${observed.endpointIncarnation}:${observed.connectionEpoch}` : '';
    const fresh =
      !!observed &&
      (currentEpoch !== flow.observationEpoch || BigInt(observed.seq) > BigInt(flow.observationSequence));
    const revision = this.context.store.coordination.desiredRevision(state.tenantId);
    const complete =
      !!observed &&
      fresh &&
      observed.browser === 'running' &&
      observed.converged &&
      !observed.lastError &&
      revision !== undefined &&
      BigInt(observed.observedRevision) >= BigInt(revision) &&
      BigInt(observed.applied.viewsRevision) >= BigInt(revision);
    if (
      observed &&
      (observed.browser === 'stopped' ||
        (observed.browserIncarnation && observed.browserIncarnation !== flow.identity.browserIncarnation) ||
        (fresh &&
          view &&
          (view.instance !== flow.identity.instance || view.document !== flow.identity.document)))
    ) {
      this.saveCloseChange(
        state,
        () => {},
        'target_retired',
        new RemoteKitError('outcome_unknown', '原页面实例已结束，关闭结果未知'),
      );
      return;
    }
    if (observed?.browserIncarnation === flow.identity.browserIncarnation) {
      if ((complete && !view) || (fresh && view?.close_state === 'closed')) {
        this.completeTabClose(state, tab, 'view_missing_or_closed');
        return;
      }
      const request = view?.pending_close?.requestId;
      if (
        complete &&
        flow.phase === 'awaitingUser' &&
        view?.close_state === 'open' &&
        String(request) !== flow.nativeRequestId &&
        !view.pageRequests?.pending.some((pending) => String(pending.request) === flow.nativeRequestId)
      ) {
        this.saveCloseChange(
          state,
          () => {},
          'request_disappeared',
          new RemoteKitError('canceled', '页面关闭确认已失效', { detail: 'close_request_disappeared' }),
        );
        return;
      }
      if (
        fresh &&
        request !== undefined &&
        flow.phase !== 'awaitingCloseEvidence' &&
        (flow.phase !== 'awaitingUser' || flow.nativeRequestId !== String(request))
      ) {
        const nativeRequestId = String(request);
        this.saveCloseChange(
          state,
          () => {
            state.pendingClose = projectClose({
              ...flow,
              ...this.closeTiming(state.tenantId),
              phase: 'awaitingUser',
              nativeRequestId,
              requestId: this.closeToken(
                flow.identity.browserIncarnation,
                tab.id,
                flow.identity.instance,
                flow.identity.document,
                nativeRequestId,
              ),
            });
          },
          'prompt_observed',
        );
        return;
      }
    }
    if (flow.phase !== 'awaitingUser' && this.context.clock.wallMs() - flow.enteredAt >= 10_000) {
      this.saveCloseChange(
        state,
        () => {},
        'phase_timeout',
        new RemoteKitError('outcome_unknown', '页面关闭结果未能在期限内确认', {
          detail: 'close_phase_timeout',
        }),
      );
    }
  }
  async replyClose(tenant: string, viewId: string, pending: PendingClose, accept: boolean) {
    const flow = readClose(pending, viewId);
    if (flow.phase !== 'awaitingUser') throw new RemoteKitError('conflict', '关闭请求已失效');
    const result = await this.context.endpoint.replyClose(tenant, {
      viewId,
      browserIncarnation: flow.identity.browserIncarnation,
      instance: flow.identity.instance,
      document: flow.identity.document,
      requestId: flow.nativeRequestId,
      accept,
    });
    if (result?.accepted !== true || result?.browser?.ok !== true)
      throw new RemoteKitError('conflict', 'Endpoint未确认关闭请求回复');
    return result;
  }
  async closeProductTab(state: ProductWorkspace, tab: ProductTab) {
    if (!state.tabs.some((current) => current.id === tab.id)) return;
    if (
      state.pendingClose?.id === tab.id &&
      readClose(state.pendingClose, tab.webviewId).phase === 'awaitingUser'
    )
      return;
    if (browserAvailability(this.context, state.tenantId).state !== 'available') {
      this.completeTabClose(state, tab, 'browser_unavailable');
      return;
    }
    if (tab.signIn) {
      this.removeProductTab(state, tab);
      void this.services.learning.signIn.cancel(state.tenantId, tab.signIn);
      await this.context.endpoint
        .closeView(state.tenantId, { viewId: tab.webviewId, force: true })
        .catch((err) =>
          log.warn('page.close_view_failed', { tenant: state.tenantId, viewId: tab.webviewId, err }),
        );
      return;
    }
    if (state.pendingClose && state.pendingClose.id !== tab.id)
      throw new RemoteKitError('conflict', '请先处理当前关闭请求', { detail: PENDING_CLOSE_DETAIL });
    if (isLocalTab(tab) || (tab.popup && tab.popup.status !== 'adopted')) {
      this.completeTabClose(state, tab, 'local_target');
      return;
    }
    const browserIncarnation = this.context.endpoint.observation(state.tenantId)?.browserIncarnation;
    const timing = this.closeTiming(state.tenantId);
    try {
      const result = await this.context.endpoint.closeView(state.tenantId, {
        viewId: tab.webviewId,
        browserIncarnation,
        force: false,
      });
      if (result.closed === true) this.completeTabClose(state, tab, 'native_completed');
      else if (result.accepted || result.pending)
        this.saveCloseChange(
          state,
          () => {
            state.pendingClose = this.pendingClose(tab, result, timing);
          },
          'native_accepted',
          undefined,
          undefined,
          tab,
        );
      else throw new RemoteKitError('outcome_unknown', 'Endpoint 尚未确认页面关闭');
    } catch (error) {
      const failure = toRemoteKitError(error);
      if (failure.code === 'outcome_unknown') {
        this.saveCloseChange(state, () => {}, 'native_outcome_unknown', failure, undefined, tab);
        throw error;
      }
      if (
        failure.code !== 'not_found' ||
        failure.detail !== 'view_not_in_session' ||
        !browserIncarnation ||
        this.context.endpoint.observation(state.tenantId)?.browserIncarnation !== browserIncarnation
      )
        throw error;
      this.completeTabClose(state, tab, 'view_not_in_session');
    }
  }
  async continueWindowClose(state: ProductWorkspace) {
    if (!state.pendingWindowCloseId) return;
    let unit = this.closeRetries.get(state.tenantId);
    if (!unit) {
      unit = new RetryUnit({ name: 'page.close_batch' });
      this.closeRetries.set(state.tenantId, unit);
    }
    const input = () =>
      JSON.stringify([
        state.pendingWindowCloseId,
        state.pendingWindowCloseIds,
        state.pendingAppUninstallId,
        this.context.tenants.get(state.tenantId).browserIncarnation,
        this.context.store.operations
          .pendingOperations(state.tenantId)
          .map((operation) => operation.receipt.operationId),
      ]);
    if (!unit.ready(input())) return;
    try {
      await this.advanceWindowClose(state);
      unit.succeed();
    } catch (error) {
      const failure = toRemoteKitError(error);
      // An earlier window can finish before a later one fails; retries belong to the remaining queue.
      unit.ready(input());
      const { delay } = unit.fail(failure);
      if (delay === undefined && failure.code !== 'outcome_unknown') {
        this.saveCloseChange(state, () => {}, 'batch_failed', failure);
      }
      throw error;
    }
  }
  private async advanceWindowClose(state: ProductWorkspace) {
    if (state.pendingClose && browserAvailability(this.context, state.tenantId).state === 'available') return;
    if (state.pendingClose)
      this.saveCloseChange(
        state,
        () => {
          state.pendingClose = null;
        },
        'browser_unavailable',
      );
    while (state.pendingWindowCloseId) {
      const id = state.pendingWindowCloseId;
      for (const tab of state.tabs.filter((t) => t.windowId === id)) {
        await this.closeProductTab(state, tab);
        if (state.pendingClose) return;
      }
      this.saveCloseChange(
        state,
        () => {
          removeWindow(state, id);
          state.pendingWindowCloseId = state.pendingWindowCloseIds?.shift() ?? null;
        },
        'window_completed',
      );
    }
    this.saveCloseChange(
      state,
      () => {
        delete state.pendingWindowCloseIds;
        if (state.pendingAppUninstallId) {
          state.apps = state.apps.filter((app) => app.id !== state.pendingAppUninstallId);
          delete state.pendingAppUninstallId;
        }
      },
      'batch_completed',
    );
  }
  collectDialogs(tenant: string, state: ProductWorkspace, snapshot: any) {
    const runtime = this.context.tenants.get(tenant);
    const found: (PageDialog & PageIdentity & { requestId: string })[] = [];
    const files: InternalFileRequest[] = [];
    for (const view of Array.isArray(snapshot.views) ? snapshot.views : []) {
      if (!view || typeof view !== 'object') continue;
      const viewId = view.viewId,
        tab = state.tabs.find((t) => t.webviewId === viewId);
      if (
        !tab ||
        isLocalTab(tab) ||
        snapshot.running === false ||
        typeof snapshot.browserIncarnation !== 'string' ||
        !snapshot.browserIncarnation ||
        ![view.instance, view.document].every((id) => typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id))
      )
        continue;
      const instance = String(view.instance),
        document = String(view.document);
      for (const request of Array.isArray(view.pageRequests?.pending) ? view.pageRequests.pending : []) {
        if (!request || typeof request !== 'object') continue;
        if (request.kind === 'file_chooser' && typeof request.request === 'string') {
          const id = createHash('sha256')
            .update(
              JSON.stringify([
                tenant,
                snapshot.browserIncarnation,
                viewId,
                instance,
                document,
                request.request,
              ]),
            )
            .digest('hex');
          const anchor = fileRequestAnchor(request.input_anchor, instance, document);
          files.push({
            id,
            ...(anchor ? { anchor } : {}),
            tabId: tab.id,
            windowId: tab.windowId,
            origin: String(request.origin ?? ''),
            multiple: request.multiple === true,
            acceptTypesOmitted: request.accept_types_omitted === true,
            accept: Array.isArray(request.accept_types)
              ? request.accept_types
                  .filter((type: unknown): type is string => typeof type === 'string')
                  .slice(0, 64)
              : [],
            state: request.state === 'validating' ? 'validating' : 'pending',
            limits: { ...this.context.fileLimits },
            binding: {
              browserIncarnation: snapshot.browserIncarnation,
              view: viewId,
              instance,
              document,
              request: request.request,
            },
          });
        }
        const projected = projectPageRequest(request);
        if (!projected || (state.pendingClose?.id === tab.id && request.kind === 'beforeunload')) continue;
        // Browser replacement may restart its local token/request counters.
        const id = createHash('sha256')
          .update(
            JSON.stringify([
              tenant,
              snapshot.browserIncarnation,
              viewId,
              instance,
              document,
              request.request,
            ]),
          )
          .digest('hex');
        found.push({
          ...projected,
          id,
          tabId: tab.id,
          windowId: tab.windowId,
          viewId,
          browserIncarnation: snapshot.browserIncarnation,
          instance,
          document,
          requestId: request.request,
        } as PageDialog & PageIdentity & { requestId: string });
      }
    }
    const changed =
      JSON.stringify(found) !== JSON.stringify(runtime.pageRequests.dialogs ?? []) ||
      JSON.stringify(files) !== JSON.stringify(runtime.pageRequests.files ?? []);
    runtime.pageRequests.dialogs = found;
    runtime.pageRequests.files = files;
    this.context.endpoint.invalidate(tenant);
    if (changed) this.services.viewers.push(tenant);
  }
  async replyDialog(state: ProductWorkspace, action: { dialogId: string; reply: PageDialogReply }) {
    validatePageReply(action.reply);
    const tenant = state.tenantId,
      runtime = this.context.tenants.get(tenant);
    const latest = await this.context.endpoint.snapshot(tenant);
    this.collectDialogs(tenant, state, latest);
    const dialog = runtime.pageRequests.dialogs?.find((d) => d.id === action.dialogId);
    if (!dialog || !state.tabs.some((t) => t.id === dialog.tabId && t.webviewId === dialog.viewId))
      throw new RemoteKitError('conflict', '页面对话已过期');
    const reply = action.reply;
    const kind = ['alert', 'confirm', 'prompt', 'beforeunload'].includes(dialog.kind)
      ? 'dialog'
      : dialog.kind;
    if (kind !== reply.kind) throw new RemoteKitError('conflict', '回复类型与页面请求不匹配');
    if (dialog.kind === 'alert' && reply.kind === 'dialog' && !reply.accept)
      throw new RemoteKitError('invalid_request', '提示对话仅支持确认');
    let changed = false;
    if (
      dialog.kind === 'permission' &&
      reply.kind === 'permission' &&
      ['allow', 'block'].includes(reply.decision)
    ) {
      const site = ensureSite(state, dialog.origin);
      site.permissions ??= {};
      for (const permission of dialog.permissions)
        site.permissions[permission] = reply.decision as 'allow' | 'block';
      changed = true;
    }
    if (dialog.kind === 'protocol_handler' && reply.kind === 'protocol_handler' && reply.remember) {
      const site = ensureSite(state, dialog.origin);
      const handlers = (site.protocolHandlers ?? []).filter(
        (handler) => handler.protocol !== dialog.protocol,
      );
      if (handlers.length >= 32)
        throw new RemoteKitError('limit_exceeded', '协议处理程序已达上限', { capacity: 'site-settings' });
      if (reply.accept)
        for (const [origin, other] of Object.entries(state.sites)) {
          if (origin === dialog.origin) continue;
          other.protocolHandlers = other.protocolHandlers?.filter(
            (handler) => handler.protocol !== dialog.protocol,
          );
          pruneSite(state, origin);
        }
      site.protocolHandlers = [
        ...handlers,
        { protocol: dialog.protocol, url: dialog.url, allowed: reply.accept },
      ];
      changed = true;
    }
    if (changed) {
      this.services.operations.saveWorkspace(state);
      const desired = await this.context.endpoint.published(tenant);
      const applied = await this.context.endpoint.waitObserved(
        tenant,
        (value) =>
          BigInt(value.observedRevision) >= BigInt(desired.revision) &&
          (BigInt(value.applied.sitePreferencesRevision) >= BigInt(desired.revision) ||
            value.lastError !== null),
      );
      if (applied.lastError) throw endpointError(applied.lastError);
    }
    let fields: PageReplyFields;
    switch (reply.kind) {
      case 'permission':
        fields = { decision: reply.decision };
        break;
      case 'http_auth':
        fields = reply.accept
          ? { accept: true, username: reply.username, password: reply.password }
          : { accept: false };
        break;
      case 'dialog':
        fields = { accept: reply.accept, ...(reply.text === undefined ? {} : { text: reply.text }) };
        break;
      default:
        fields = { accept: reply.accept };
    }
    const args = {
      viewId: dialog.viewId,
      requestId: dialog.requestId,
      browserIncarnation: dialog.browserIncarnation,
      instance: dialog.instance,
      document: dialog.document,
      ...fields,
    };
    const result = await this.context.endpoint.replyPage(tenant, args).catch((error) => {
      if (reply.kind === 'http_auth') {
        const failure = toRemoteKitError(error);
        throw new RemoteKitError(failure.code, '页面登录请求未能完成', {
          reason: failure.reason,
          retryAfterMs: failure.retryAfterMs,
          errorId: failure.errorId,
          detail: failure.detail,
          cause: error,
        });
      }
      throw error;
    });
    if (result?.accepted !== true || result?.browser?.ok !== true)
      throw new RemoteKitError('outcome_unknown', 'Endpoint未确认页面对话回复');
    runtime.pageRequests.dialogs = (runtime.pageRequests.dialogs ?? []).filter((d) => d.id !== dialog.id);
    this.services.viewers.push(tenant);
  }
  async exitFullscreen(state: ProductWorkspace, action: { target: string }) {
    const tenant = state.tenantId,
      runtime = this.context.tenants.get(tenant);
    const binding = this.fullscreenBinding(state);
    if (!binding || action.target !== binding.page.target)
      throw new RemoteKitError('conflict', '网页全屏已结束或页面已更换');
    const { viewId, browserIncarnation, instance, document } = binding;
    await this.context.endpoint.exitFullscreen(tenant, {
      viewId,
      browserIncarnation,
      instance,
      document,
    });
    delete runtime.pageRequests.fullscreen;
  }
  async confirmClose(state: ProductWorkspace, tabId: string, accept: boolean, operationId?: string) {
    const tab = state.tabs.find((t) => t.id === tabId)!;
    const pending = state.pendingClose!;
    const timing = this.closeTiming(state.tenantId);
    try {
      await this.replyClose(state.tenantId, tab.webviewId, pending, accept);
    } catch (error) {
      const failure = toRemoteKitError(error);
      if (failure.code === 'outcome_unknown')
        this.saveCloseChange(state, () => {}, 'reply_outcome_unknown', failure);
      throw error;
    }
    if (accept) {
      const flow = readClose(pending, tab.webviewId);
      if (flow.phase !== 'awaitingUser') throw new RemoteKitError('conflict', '关闭请求已失效');
      this.saveCloseChange(
        state,
        () => {
          state.pendingClose = projectClose({
            ...flow,
            ...timing,
            enteredAt: this.context.clock.wallMs(),
            phase: 'awaitingCloseEvidence',
          });
        },
        'user_accepted',
      );
    } else {
      this.saveCloseChange(
        state,
        () => {},
        'user_canceled',
        new RemoteKitError('canceled', '用户取消关闭'),
        operationId,
      );
    }
  }
}

type CloseTiming = Pick<PendingClose, 'enteredAt' | 'observationEpoch' | 'observationSequence'>;
type CloseTarget = { tabId: string; identity: PageIdentity; windowId?: string } & CloseTiming;
export type TabCloseFlow =
  | { phase: 'none' }
  | (CloseTarget & { phase: 'awaitingPrompt' })
  | (CloseTarget & { phase: 'awaitingUser'; requestId: string; nativeRequestId: string })
  | (CloseTarget & { phase: 'awaitingCloseEvidence'; requestId: string; nativeRequestId: string });
export function readClose(pending: PendingClose | null | undefined, viewId: string): TabCloseFlow {
  if (!pending || !pending.browserIncarnation || !pending.instance || !pending.document)
    return { phase: 'none' };
  const target = {
    tabId: pending.id,
    enteredAt: pending.enteredAt,
    observationEpoch: pending.observationEpoch,
    observationSequence: pending.observationSequence,
    identity: {
      viewId,
      browserIncarnation: pending.browserIncarnation,
      instance: pending.instance,
      document: pending.document,
    },
    windowId: pending.windowId,
  };
  if (!pending.requestId || !pending.nativeRequestId) return { ...target, phase: 'awaitingPrompt' };
  return {
    ...target,
    phase: pending.awaiting ? 'awaitingCloseEvidence' : 'awaitingUser',
    requestId: pending.requestId,
    nativeRequestId: pending.nativeRequestId,
  };
}
function projectClose(flow: TabCloseFlow): PendingClose | null {
  if (flow.phase === 'none') return null;
  const { identity, windowId } = flow;
  return {
    id: flow.tabId,
    enteredAt: flow.enteredAt,
    observationEpoch: flow.observationEpoch,
    observationSequence: flow.observationSequence,
    windowId,
    browserIncarnation: identity.browserIncarnation,
    instance: identity.instance,
    document: identity.document,
    awaiting: flow.phase !== 'awaitingUser',
    ...(flow.phase === 'awaitingUser' || flow.phase === 'awaitingCloseEvidence'
      ? { requestId: flow.requestId, nativeRequestId: flow.nativeRequestId }
      : {}),
  };
}
