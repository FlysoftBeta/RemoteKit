import { randomUUID } from 'node:crypto';
import { filesState } from '../../shared/persisted-window-state';
import type { ProductTab, ProductWorkspace } from '../../shared/product';
import type { DomainContext, DomainServices } from '../application';
import { PDF_VIEWER_URL } from '../endpoint/coordination';
import { WORKSPACE_LIMITS } from './model';

export interface FilesOwnerEnvironment {
  /** The current asset of a readable PDF entry, if the entry is one. */
  readablePdf(entryId: string): string | undefined;
  ids(): { tabId: string; viewId: string };
}

/**
 * Makes the owned remote tabs and the Files windows' active tab agree with the Files window
 * state: one owned tab per compatibility-mode PDF document tab, and a window's active tab is the
 * owned tab of its current Files tab or null. Returns the retired view IDs; `changed` reports
 * whether anything was written.
 */
export function syncFilesOwnership(state: ProductWorkspace, env: FilesOwnerEnvironment) {
  const retired: string[] = [];
  let changed = false;
  const wanted = new Map<string, { filesTabId: string; assetId: string }>();
  const activeOf = new Map<string, string | undefined>();
  for (const window of state.windows) {
    if (window.appId !== 'files') continue;
    const parsed = window.state && 'tabs' in window.state ? filesState.read(window.state, '$') : undefined;
    if (!parsed) {
      activeOf.set(window.id, undefined);
      continue;
    }
    for (const tab of parsed.tabs)
      if (tab.kind === 'document' && tab.compat) {
        const assetId = env.readablePdf(tab.entryId);
        if (assetId) wanted.set(`${window.id}/${tab.id}`, { filesTabId: tab.id, assetId });
      }
    activeOf.set(window.id, parsed.activeTabId);
  }
  const key = (tab: ProductTab) => tab.owner && `${tab.owner.windowId}/${tab.owner.filesTabId}`;
  const keep: ProductTab[] = [];
  for (const tab of state.tabs) {
    if (tab.owner && wanted.get(key(tab)!)?.assetId !== tab.owner.assetId) {
      retired.push(tab.webviewId);
      if (state.pendingClose?.id === tab.id) state.pendingClose = null;
      changed = true;
    } else keep.push(tab);
  }
  state.tabs = keep;
  for (const [id, { filesTabId, assetId }] of wanted) {
    if (state.tabs.some((tab) => key(tab) === id)) continue;
    if (state.tabs.length >= WORKSPACE_LIMITS.tabs) continue;
    const { tabId, viewId } = env.ids();
    state.tabs.push({
      id: tabId,
      idleKeepAlive: false,
      windowId: id.slice(0, id.indexOf('/')),
      webviewId: viewId,
      kind: 'remote',
      title: 'PDF',
      url: PDF_VIEWER_URL,
      owner: { kind: 'files', windowId: id.slice(0, id.indexOf('/')), filesTabId, assetId },
    });
    changed = true;
  }
  for (const window of state.windows) {
    if (!activeOf.has(window.id)) continue;
    const active = activeOf.get(window.id);
    const next =
      state.tabs.find((tab) => tab.owner?.windowId === window.id && tab.owner.filesTabId === active)?.id ??
      null;
    if (window.activeTabId !== next) {
      window.activeTabId = next;
      changed = true;
    }
  }
  return { changed, retired };
}

export class FilesOwner {
  constructor(
    private readonly context: DomainContext,
    private readonly services: Pick<
      DomainServices,
      'operations' | 'lifecycle' | 'library' | 'objects' | 'reconciler'
    >,
  ) {}
  /** Applies the ownership rules to a workspace that is about to be saved. */
  apply(state: ProductWorkspace) {
    const entries = new Map(
      this.context.store.library.snapshot(state.tenantId).entries.map((entry) => [entry.id, entry]),
    );
    const result = syncFilesOwnership(state, {
      readablePdf: (id) => {
        const entry = entries.get(id);
        return entry?.kind === 'file' &&
          entry.type === 'application/pdf' &&
          this.services.objects.available(entry.assetId)
          ? entry.assetId
          : undefined;
      },
      ids: () => ({ tabId: randomUUID(), viewId: this.context.store.workspaces.viewId() }),
    });
    for (const viewId of result.retired) this.services.lifecycle.remove(state.tenantId, viewId);
    return result.changed;
  }
  /** Library changes (deleted, replaced or unreadable entries) retire or recreate owned tabs. */
  resync(tenant: string) {
    return this.context.tenants.serial(tenant, async () => {
      if (!this.context.store.accounts.userForTenant(tenant)) return;
      const state = this.context.store.workspaces.workspace(tenant);
      if (!this.apply(state)) return;
      this.services.operations.saveWorkspace(state);
      this.context.endpoint.invalidate(tenant);
    });
  }
}
