import { browserAvailability } from './browser-availability';
import { RetryUnit } from '../../shared/retry-unit';
import { endpointError } from '../endpoint/gateway';
import { createHash } from 'node:crypto';
import { parseWireError, RemoteKitError, toRemoteKitError, wireError } from '../../shared/errors';
import { SITE_PERMISSIONS, type FileRequest, type PageDialogReply } from '../../shared/product';
import type { DownloadEvent, FileBinding, PageIdentity, PageReplyFields } from '../endpoint/types';
import { log, reportError } from '../log';
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
  pendingClose(tab: ProductTab, result: any): PendingClose {
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
      : { phase: 'awaitingPrompt', tabId: id, identity, windowId };
    return projectClose(flow)!;
  }
  closeToken(browser: string, tab: string, instance: string, document: string, request: string) {
    return createHash('sha256')
      .update(JSON.stringify([browser, tab, instance, document, request]))
      .digest('hex');
  }
  observePendingClose(state: ProductWorkspace, snapshot: any, view: any) {
    const tab = state.tabs.find((tab) => tab.id === state.pendingClose?.id);
    const flow = readClose(state.pendingClose, tab?.webviewId ?? '');
    if (flow.phase === 'none') return;
    const { identity } = flow;
    if (
      snapshot.running === false ||
      snapshot.browserIncarnation !== identity.browserIncarnation ||
      (view && (String(view.instance) !== identity.instance || String(view.document) !== identity.document))
    ) {
      state.pendingClose = null;
      state.pendingWindowCloseId = null;
      delete state.pendingWindowCloseIds;
      delete state.pendingAppUninstallId;
      return;
    }
    const request = view?.pending_close?.requestId;
    if (request !== undefined && flow.phase !== 'awaitingCloseEvidence') {
      const nativeRequestId = String(request);
      state.pendingClose = projectClose({
        phase: 'awaitingUser',
        tabId: flow.tabId,
        identity,
        windowId: flow.windowId,
        nativeRequestId,
        requestId: this.closeToken(
          identity.browserIncarnation,
          flow.tabId,
          identity.instance,
          identity.document,
          nativeRequestId,
        ),
      });
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
    if (browserAvailability(this.context, state.tenantId).state !== 'available') {
      this.removeProductTab(state, tab);
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
      throw new RemoteKitError('conflict', '请先处理当前关闭请求');
    if (isLocalTab(tab) || (tab.popup && tab.popup.status !== 'adopted')) {
      this.removeProductTab(state, tab);
      return;
    }
    const result = await this.context.endpoint.closeView(state.tenantId, {
      viewId: tab.webviewId,
      force: false,
    });
    if (result.closed === true) this.removeProductTab(state, tab);
    else if (result.accepted || result.pending) state.pendingClose = this.pendingClose(tab, result);
    else throw new RemoteKitError('outcome_unknown', 'Endpoint 尚未确认页面关闭');
  }
  async continueWindowClose(state: ProductWorkspace) {
    if (!state.pendingWindowCloseId) return;
    let unit = this.closeRetries.get(state.tenantId);
    if (!unit) {
      unit = new RetryUnit({ name: 'page.close_batch' });
      this.closeRetries.set(state.tenantId, unit);
    }
    const input = JSON.stringify([
      state.pendingWindowCloseId,
      state.pendingWindowCloseIds,
      state.pendingAppUninstallId,
      this.context.tenants.get(state.tenantId).browserIncarnation,
      this.context.store.operations
        .pendingOperations(state.tenantId)
        .map((operation) => operation.receipt.operationId),
    ]);
    if (!unit.ready(input)) return;
    const windowIds = new Set([state.pendingWindowCloseId, ...(state.pendingWindowCloseIds ?? [])]);
    const spaceIds = new Set(
      state.spaces
        .filter((space) => space.windowIds.some((id) => windowIds.has(id)))
        .map((space) => space.id),
    );
    const appId = state.pendingAppUninstallId;
    try {
      await this.advanceWindowClose(state);
      unit.succeed();
    } catch (error) {
      const failure = toRemoteKitError(error);
      const { delay } = unit.fail(failure);
      if (delay === undefined && failure.code !== 'outcome_unknown') {
        state.pendingWindowCloseId = null;
        delete state.pendingWindowCloseIds;
        delete state.pendingAppUninstallId;
        for (const pending of this.context.store.operations.pendingOperations(state.tenantId)) {
          const action = pending.action;
          if (
            (action.type === 'window.close' && windowIds.has(action.windowId)) ||
            (action.type === 'space.close' && spaceIds.has(action.spaceId)) ||
            (action.type === 'app.uninstall' && action.appId === 'web:' + appId)
          ) {
            settle(pending.receipt, {
              status: 'failed',
              error: wireError(
                reportError(failure, 'page.close_failed', {
                  tenant: state.tenantId,
                  operation: pending.receipt.operationId,
                }),
              ),
            });
            this.context.store.operations.saveOperation(state, pending.receipt);
          }
        }
        this.services.operations.saveWorkspace(state);
      }
      throw error;
    }
  }
  private async advanceWindowClose(state: ProductWorkspace) {
    if (state.pendingClose && browserAvailability(this.context, state.tenantId).state === 'available') return;
    state.pendingClose = null;
    while (state.pendingWindowCloseId) {
      const id = state.pendingWindowCloseId;
      for (const tab of state.tabs.filter((t) => t.windowId === id)) {
        await this.closeProductTab(state, tab);
        this.services.operations.saveWorkspace(state);
        if (state.pendingClose) return;
      }
      removeWindow(state, id);
      state.pendingWindowCloseId = state.pendingWindowCloseIds?.shift() ?? null;
    }
    delete state.pendingWindowCloseIds;
    if (state.pendingAppUninstallId) {
      state.apps = state.apps.filter((app) => app.id !== state.pendingAppUninstallId);
      delete state.pendingAppUninstallId;
    }
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
    await this.replyClose(state.tenantId, tab.webviewId, pending, accept);
    if (accept) {
      const flow = readClose(pending, tab.webviewId);
      if (flow.phase !== 'awaitingUser') throw new RemoteKitError('conflict', '关闭请求已失效');
      state.pendingClose = projectClose({ ...flow, phase: 'awaitingCloseEvidence' });
    } else {
      const windowId = state.pendingWindowCloseId;
      state.pendingClose = null;
      state.pendingWindowCloseId = null;
      delete state.pendingWindowCloseIds;
      delete state.pendingAppUninstallId;
      for (const saved of this.context.store.operations.pendingOperations(state.tenantId)) {
        if (saved.receipt.operationId === operationId) continue;
        if (
          (saved.action.type === 'tab.close' && saved.action.tabId === tabId) ||
          (saved.action.type === 'window.close' && saved.action.windowId === windowId) ||
          ['space.close', 'app.uninstall'].includes(saved.action.type)
        ) {
          settle(saved.receipt, { status: 'failed', error: { code: 'canceled', message: '用户取消关闭' } });
          this.context.store.operations.saveOperation(state, saved.receipt);
        }
      }
    }
  }
}

type CloseTarget = { tabId: string; identity: PageIdentity; windowId?: string };
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
