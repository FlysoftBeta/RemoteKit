import { createHash, randomUUID } from 'node:crypto';
import { RemoteKitError } from '../../shared/errors';
import type {
  AppInspectResult,
  LauncherItem,
  ProductAction,
  ProductTab,
  ProductWorkspace,
} from '../../shared/product';
import { isSingletonApp } from '../../shared/product';
import type { DomainContext, DomainServices } from '../application';
import { normalizedUsagePage } from '../navigation-url';
import { launcherItems } from './launcher-items';
import { findTab, findWindow } from './model';

export function pageUsageIdentity(tab: ProductTab, current: any, browser: unknown): string | undefined {
  return typeof browser === 'string' && current.instance && current.document
    ? JSON.stringify([browser, current.instance, current.document, normalizedUsagePage(tab.url)])
    : undefined;
}

export class Workspace {
  private readonly icons = new Map<string, { tenant: string; png: Buffer; expires: number }>();

  constructor(
    private readonly context: DomainContext,
    private readonly services: Pick<DomainServices, 'library'>,
  ) {}

  fileSourceForRequest(tenant: string, requestId: string): { app: string; channel: string } | null {
    const request = this.context.tenants.get(tenant).pageRequests.files?.find((r) => r.id === requestId);
    if (!request) return null;
    const state = this.context.store.workspaces.workspace(tenant);
    const tab = state.tabs.find((tab) => tab.id === request.tabId);
    const window = state.windows.find((window) => window.id === tab?.windowId);
    if (!tab || !window || tab.signIn) return null;
    if (window.appId.startsWith('web:')) return { app: window.appId, channel: '' };
    if (window.appId !== 'browser') return null;
    try {
      return { app: 'browser', channel: new URL(tab.url).hostname };
    } catch {
      return null;
    }
  }

  async inspect(tenant: string, tabId: string): Promise<AppInspectResult> {
    const tab = findTab(this.context.store.workspaces.workspace(tenant), tabId);
    if (tab.kind !== 'remote' || tab.signIn) throw new RemoteKitError('unavailable', '页面尚未运行');
    const info = await this.context.endpoint.appInfo(tenant, { viewId: tab.webviewId });
    const page = new URL(info.url);
    if (!['http:', 'https:'].includes(page.protocol))
      throw new RemoteKitError('invalid_request', '仅可安装 HTTP(S) 页面');
    const webUrl = (value: string | undefined, fallback: string) => {
      if (value) {
        try {
          const url = new URL(value, page);
          if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
        } catch {}
      }
      return fallback;
    };
    const startUrl = webUrl(info.manifest?.startUrl, page.href);
    const scope = webUrl(info.manifest?.scope, new URL('.', startUrl).href);
    const suggestions: AppInspectResult = {
      name: (info.manifest?.name || info.manifest?.shortName || info.title || page.hostname).slice(0, 120),
      startUrl,
      scope,
      display: info.manifest?.display === 'browser' ? 'browser' : 'standalone',
      ...(/^#[0-9a-f]{6}$/i.test(info.manifest?.themeColor ?? '')
        ? { themeColor: info.manifest!.themeColor }
        : {}),
    };
    this.pruneIcons();
    if (info.icon) {
      const png = Buffer.from(info.icon.png, 'base64');
      if (
        png.length > 0 &&
        png.length <= 65536 &&
        png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      ) {
        const token = randomUUID();
        this.icons.set(token, { tenant, png, expires: this.context.clock.wallMs() + 600000 });
        suggestions.iconToken = token;
        suggestions.iconDataUrl = `data:image/png;base64,${png.toString('base64')}`;
      }
    }
    return suggestions;
  }

  private pruneIcons() {
    const now = this.context.clock.wallMs();
    for (const [token, icon] of this.icons) if (icon.expires <= now) this.icons.delete(token);
  }

  appIcon(tenant: string, token?: string): { png: Buffer; hash: string } | undefined {
    if (token === undefined) return undefined;
    this.pruneIcons();
    const icon = this.icons.get(token);
    if (!icon || icon.tenant !== tenant) throw new RemoteKitError('not_found', '图标已过期，请重新检查页面');
    return { png: icon.png, hash: createHash('sha256').update(icon.png).digest('hex') };
  }

  recordAction(before: ProductWorkspace, state: ProductWorkspace, action: ProductAction) {
    const windows = new Set<string>();
    if (action.type === 'window.open') {
      const opened = state.windows.find((window) => !before.windows.some((old) => old.id === window.id));
      if (opened) windows.add(opened.id);
      else if (isSingletonApp(action.appId)) {
        const singleton = state.windows.find((window) => window.appId === action.appId);
        if (singleton) windows.add(singleton.id);
      }
    } else if (action.type === 'window.focus') windows.add(action.windowId);
    else if (action.type === 'space.activate') {
      const space = state.spaces.find((space) => space.id === action.spaceId);
      if (space?.focusedWindowId) windows.add(space.focusedWindowId);
    }
    const focused = state.spaces.find((space) => space.id === state.activeSpaceId)?.focusedWindowId;
    const previousFocus = before.spaces.find((space) => space.id === before.activeSpaceId)?.focusedWindowId;
    if (focused && focused !== previousFocus) windows.add(focused);
    const source = 'source' in action ? action.source : undefined;
    for (const id of windows) {
      const window = findWindow(state, id);
      this.context.store.workspaces.items.recordUsage(
        state.tenantId,
        { item: 'app:' + window.appId, windowId: id, source },
        this.context.clock.wallMs(),
      );
    }
    if (source === 'launcher') {
      if (action.type === 'tab.navigate') findTab(state, action.tabId).usageSource = source;
      if (action.type === 'window.open' || action.type === 'tab.create') {
        for (const tab of state.tabs)
          if (!before.tabs.some((old) => old.id === tab.id)) tab.usageSource = source;
      }
    }
  }

  recordPage(state: ProductWorkspace, tab: ProductTab, current: any, browser: unknown, source?: 'launcher') {
    if (tab.signIn) return;
    const url = normalizedUsagePage(tab.url);
    if (current.isErrorPage === true) return;
    if (!url) return;
    this.context.store.workspaces.items.recordUsage(
      state.tenantId,
      {
        item: 'page:' + url,
        windowId: tab.windowId,
        tabId: tab.id,
        title: typeof current.title === 'string' ? current.title.slice(0, 120) : tab.title,
        source: source ?? tab.usageSource,
      },
      this.context.clock.wallMs(),
    );
    delete tab.usageSource;
    tab.usageDocument = pageUsageIdentity(tab, current, browser);
  }

  recordFile(tenant: string, params: { item: string; windowId: string; source?: 'launcher' }) {
    if (
      typeof params.item !== 'string' ||
      !params.item.startsWith('file:') ||
      (params.source !== undefined && params.source !== 'launcher')
    )
      throw new RemoteKitError('invalid_request', '需要有效的文件使用记录');
    const state = this.context.store.workspaces.workspace(tenant);
    findWindow(state, params.windowId);
    if (!this.services.library.entryExists(tenant, params.item.slice(5)))
      throw new RemoteKitError('not_found', '文件不存在');
    this.context.store.workspaces.items.recordUsage(tenant, params, this.context.clock.wallMs());
    return { recorded: true };
  }

  savePreview(tenant: string, params: { url: string; image: string }) {
    if (
      typeof params.url !== 'string' ||
      typeof params.image !== 'string' ||
      !/^data:image\/jpeg;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        params.image,
      )
    )
      throw new RemoteKitError('invalid_request', '需要 JPEG 页面预览');
    if (params.image.length > 'data:image/jpeg;base64,'.length + 32768)
      throw new RemoteKitError('limit_exceeded', '页面预览超过大小限制');
    const image = Buffer.from(params.image.slice('data:image/jpeg;base64,'.length), 'base64');
    if (!image.length || image.length > 24 * 1024 || image[0] !== 0xff || image[1] !== 0xd8)
      throw new RemoteKitError(
        image.length > 24 * 1024 ? 'limit_exceeded' : 'invalid_request',
        '页面预览必须为不超过 24 KiB 的 JPEG',
      );
    const url = normalizedUsagePage(params.url);
    if (!url) return { saved: false };
    if (
      this.context.store.workspaces
        .workspace(tenant)
        .tabs.some((tab) => tab.signIn && normalizedUsagePage(tab.url) === url)
    )
      return { saved: false };
    this.context.store.workspaces.items.savePreview(
      tenant,
      'page:' + url,
      image,
      this.context.clock.wallMs(),
    );
    return { saved: true };
  }

  clearUsage(tenant: string, scope: 'all' | 'pages') {
    if (scope !== 'all' && scope !== 'pages') throw new RemoteKitError('invalid_request', '无效的清除范围');
    this.context.store.workspaces.items.clearUsage(tenant, scope);
    return { cleared: true };
  }

  launcher(tenant: string, query?: string): { items: LauncherItem[] } {
    if (query !== undefined && (typeof query !== 'string' || query.length > 8192))
      throw new RemoteKitError('invalid_request', '无效的搜索内容');
    const state = this.context.store.workspaces.workspace(tenant);
    const events = this.context.store.workspaces.items.usage(tenant, this.context.clock.wallMs());
    const library = this.context.store.library.snapshot(tenant);
    const hidden = this.services.library.hiddenEntryIds(tenant);
    return {
      items: launcherItems({
        events,
        now: this.context.clock.wallMs(),
        query,
        favorites: state.favorites,
        apps: state.apps,
        admin: !!this.context.store.accounts.userForTenant(tenant)?.isAdmin,
        files: library.entries.map((entry) => ({
          id: entry.id,
          name: entry.name,
          organized: entry.partitionId !== null,
          hidden: hidden.has(entry.id),
        })),
        previews: this.context.store.workspaces.items.previewHashes(tenant),
      }),
    };
  }
}
