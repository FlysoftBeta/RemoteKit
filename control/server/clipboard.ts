import type { SnippetOrigin } from '../shared/file-library';
import { RemoteKitError } from '../shared/errors';
import type { DomainContext, DomainServices } from './application';
import type { ClipboardChangedEvent } from './endpoint/types';
import { clipboardLimits, warnClipboardOversize } from './persistence/clipboards';
import type { ViewerAuthority } from './viewers/viewer-hub';

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
    if (!value) return;
    if (!excludeFromHistory)
      await this.services.library.recordSnippet(tenant, text, origin, this.context.clock.wallMs());
    this.context.events.emit('clipboard', tenant, { type: 'clipboard', revision: value.revision, text });
    return value;
  }

  changed(event: ClipboardChangedEvent) {
    return this.context.tenants.serial(event.tenantId, async () => {
      if (this.context.endpoint.placement.peek(event.tenantId)?.sessionId !== event.sessionId) return;
      if (event.oversize === true) {
        warnClipboardOversize(event.textBytes, event.htmlBytes);
        return;
      }
      const workspace = this.context.store.workspaces.workspace(event.tenantId);
      const tab = event.viewId && workspace.tabs.find((tab) => tab.webviewId === event.viewId);
      const app = tab && workspace.windows.find((window) => window.id === tab.windowId)?.appId;
      const origin: SnippetOrigin =
        tab && app
          ? { kind: 'page', app, url: tab.url, ...(tab.title ? { title: tab.title } : {}) }
          : { kind: 'app', app: 'browser' };
      await this.accept(event.tenantId, event.text, event.html, origin, event.excludeFromHistory);
    });
  }

  set(authority: ViewerAuthority, params: { text: string }) {
    return this.context.tenants.serial(authority.tenantId, async () => {
      this.services.viewers.assertProductViewer(authority.tenantId, authority.leaseId, authority.epoch);
      if (typeof params.text !== 'string') throw new RemoteKitError('invalid_request', '无效的剪贴板文本');
      if (Buffer.byteLength(params.text, 'utf8') > clipboardLimits.text)
        throw new RemoteKitError('limit_exceeded', '剪贴板文本超过大小限制');
      const value = await this.accept(authority.tenantId, params.text, '', { kind: 'device' }, false);
      if (!value) throw new RemoteKitError('not_found', '账号不存在');
      await this.context.endpoint.writeClipboard(authority.tenantId, value);
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

  copySnippet(authority: ViewerAuthority, entryId: string) {
    return this.context.tenants.serial(authority.tenantId, async () => {
      this.services.viewers.assertProductViewer(authority.tenantId, authority.leaseId, authority.epoch);
      const entry = this.context.store.library
        .snapshot(authority.tenantId)
        .entries.find((entry) => entry.id === entryId);
      if (entry?.kind !== 'snippet') throw new RemoteKitError('not_found', '剪贴片段不存在');
      const { text } = this.context.store.library.snippet(authority.tenantId, entry.id);
      const value = await this.accept(authority.tenantId, text, '', entry.origin);
      if (!value) throw new RemoteKitError('not_found', '账号不存在');
      await this.context.endpoint.writeClipboard(authority.tenantId, value);
      return { revision: value.revision, text };
    });
  }
}
