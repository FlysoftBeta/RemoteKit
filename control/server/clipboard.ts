import { RemoteKitError } from '../shared/errors';
import type { SnippetOrigin } from '../shared/file-library';
import type { DomainContext, DomainServices } from './application';
import type { ClipboardChangedEvent } from './endpoint/types';
import { warnClipboardOversize } from './persistence/clipboards';
import type { ViewerAuthority } from './viewers/viewer-hub';
import { counter } from './endpoint/coordination';

export class ClipboardService {
  constructor(
    private readonly context: DomainContext,
    private readonly services: Pick<DomainServices, 'viewers' | 'library'>,
  ) {}

  private async accept(
    tenant: string,
    text: string,
    html: string,
    origin: SnippetOrigin,
    excludeFromHistory = false,
  ) {
    const user = this.context.store.accounts.userForTenant(tenant);
    if (!user) return;
    const value = this.context.store.clipboards.record(user.id, { text, html });
    if (!value) throw new RemoteKitError('limit_exceeded', '剪贴板文本超过大小限制', { capacity: 'field' });
    if (!excludeFromHistory)
      await this.services.library.recordSnippet(tenant, text, origin, this.context.clock.wallMs());
    this.context.events.emit('clipboard', tenant, { type: 'clipboard', revision: value.revision, text });
    return value;
  }

  changed(event: ClipboardChangedEvent, commit: (disposition: string) => void) {
    return this.context.tenants.serial(event.tenantId, async () => {
      let clipboard: ReturnType<DomainContext['store']['clipboards']['latest']>;
      let library: ReturnType<DomainContext['store']['library']['snapshot']> | undefined;
      this.context.store.transaction(() => {
        const user = this.context.store.accounts.userForTenant(event.tenantId);
        if (!user) {
          commit('account-removed');
          return;
        }
        if (event.oversize === true) {
          warnClipboardOversize(event.textBytes, event.htmlBytes);
          commit('oversize');
          return;
        }
        const workspace = this.context.store.workspaces.workspace(event.tenantId);
        const tab = event.viewId && workspace.tabs.find((tab) => tab.webviewId === event.viewId);
        const app = tab && workspace.windows.find((window) => window.id === tab.windowId)?.appId;
        const origin: SnippetOrigin =
          tab && app
            ? { kind: 'page', app, url: tab.url, ...(tab.title ? { title: tab.title } : {}) }
            : { kind: 'app', app: 'browser' };
        const current = this.context.store.clipboards.latest(user.id)?.revision ?? '0';
        const concurrent = current !== event.baseRevision;
        if (!concurrent)
          clipboard = this.context.store.clipboards.record(user.id, { text: event.text, html: event.html });
        if (!concurrent && !clipboard) {
          commit('oversize');
          return;
        }
        if (concurrent || !event.excludeFromHistory)
          library = this.context.store.library.recordSnippet(
            event.tenantId,
            event.text,
            origin,
            this.context.clock.wallMs(),
            concurrent ? { html: event.html } : undefined,
          );
        commit(concurrent ? 'concurrent-snippet' : 'applied');
      });
      if (clipboard)
        this.context.events.emit('clipboard', event.tenantId, {
          type: 'clipboard',
          revision: clipboard.revision,
          text: clipboard.text,
        });
      if (library) this.context.events.emit('library', event.tenantId, library);
    });
  }
  set(authority: ViewerAuthority, params: { text: string }) {
    return this.context.tenants.serial(authority.tenantId, async () => {
      this.services.viewers.assertProductViewer(authority.tenantId, authority.leaseId, authority.epoch);
      if (typeof params.text !== 'string') throw new RemoteKitError('invalid_request', '无效的剪贴板文本');
      const value = await this.accept(authority.tenantId, params.text, '', { kind: 'device' }, false);
      if (!value) throw new RemoteKitError('not_found', '账号不存在');
      this.context.endpoint.invalidate(authority.tenantId);
      return { revision: value.revision };
    });
  }

  get(authority: ViewerAuthority) {
    this.services.viewers.assertProductViewer(authority.tenantId, authority.leaseId, authority.epoch);
    const user = this.context.store.accounts.userForTenant(authority.tenantId);
    if (!user) throw new RemoteKitError('not_found', '账号不存在');
    const value = this.context.store.clipboards.latest(user.id);
    return { revision: value?.revision ?? '0', text: value?.text ?? '' };
  }

  async applied(authority: ViewerAuthority, params: { revision: string }) {
    if (!counter(params.revision)) throw new RemoteKitError('invalid_request', '无效的剪贴板修订号');
    const tenant = authority.tenantId;
    const assertCurrent = () => {
      this.services.viewers.assertProductViewer(tenant, authority.leaseId, authority.epoch);
      if (this.get(authority).revision !== params.revision)
        throw new RemoteKitError('conflict', '剪贴板内容已改变');
    };
    assertCurrent();
    await this.context.endpoint.published(tenant);
    await this.context.endpoint.waitObserved(
      tenant,
      (value) =>
        value.browser === 'running' && BigInt(value.applied.clipboardRevision) >= BigInt(params.revision),
    );
    assertCurrent();
    return { revision: params.revision };
  }

  copySnippet(authority: ViewerAuthority, entryId: string) {
    return this.context.tenants.serial(authority.tenantId, async () => {
      this.services.viewers.assertProductViewer(authority.tenantId, authority.leaseId, authority.epoch);
      const entry = this.context.store.library
        .snapshot(authority.tenantId)
        .entries.find((entry) => entry.id === entryId);
      if (entry?.kind !== 'snippet') throw new RemoteKitError('not_found', '剪贴片段不存在');
      const { text, html } = this.context.store.library.snippet(authority.tenantId, entry.id);
      const value = await this.accept(authority.tenantId, text, html, entry.origin);
      if (!value) throw new RemoteKitError('not_found', '账号不存在');
      this.context.endpoint.invalidate(authority.tenantId);
      return { revision: value.revision, text };
    });
  }
}
