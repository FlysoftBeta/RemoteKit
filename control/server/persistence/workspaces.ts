import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import { RemoteKitError } from '../../shared/errors';
import type { ProductWorkspace } from '../../shared/product';
import { transaction } from './database';
export const defaultSettings = () => ({
  searchEngine: 'google' as const,
  qualityPreference: 'auto' as const,
  clientScaleOverride: null,
  memorySaverEnabled: true,
  showStats: false,
  autoFullscreen: false,
  avSync: false,
  audioChannels: { left: true, right: true },
});
export function emptyWorkspace(tenantId: string): ProductWorkspace {
  return {
    tenantId,
    revision: 0,
    tabs: [],
    windows: [],
    activeWindowId: null,
    layoutMode: 'side-by-side',
    settings: defaultSettings(),
    sites: {},
    pendingClose: null,
    pendingWindowCloseId: null,
  };
}

export class WorkspacesRepository {
  constructor(private readonly db: Database.Database) {}
  workspace(tenant: string): ProductWorkspace {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE tenant=?').get(tenant) as
      | {
          revision: bigint;
          active_window: string | null;
          layout_mode: ProductWorkspace['layoutMode'];
          pending: string;
        }
      | undefined;
    if (!row) throw new RemoteKitError('not_found', '工作区不存在');
    const settings = this.db.prepare('SELECT data FROM user_settings WHERE tenant=?').get(tenant) as {
      data: string;
    };
    return {
      tenantId: tenant,
      revision: Number(row.revision),
      activeWindowId: row.active_window,
      layoutMode: row.layout_mode,
      ...JSON.parse(row.pending ?? '{}'),
      settings: { ...defaultSettings(), ...JSON.parse(settings.data) },
      windows: (
        this.db
          .prepare('SELECT id,active_tab,weight FROM workspace_windows WHERE tenant=? ORDER BY position')
          .all(tenant) as { id: string; active_tab: string | null; weight: number }[]
      ).map((w) => ({ id: w.id, activeTabId: w.active_tab, weight: w.weight })),
      tabs: (
        this.db.prepare('SELECT data FROM workspace_tabs WHERE tenant=? ORDER BY position').all(tenant) as {
          data: string;
        }[]
      ).map((t) => JSON.parse(t.data)),
      sites: Object.fromEntries(
        (
          this.db.prepare('SELECT origin,data FROM site_preferences WHERE tenant=?').all(tenant) as {
            origin: string;
            data: string;
          }[]
        ).map((s) => [s.origin, JSON.parse(s.data)]),
      ),
    };
  }
  saveWorkspace(state: ProductWorkspace) {
    const windows = new Set(state.windows.map((w) => w.id)),
      tabs = new Set(state.tabs.map((t) => t.id));
    if (
      windows.size !== state.windows.length ||
      tabs.size !== state.tabs.length ||
      state.tabs.some((t) => !windows.has(t.windowId)) ||
      state.windows.some(
        (w) =>
          w.activeTabId !== null && !state.tabs.some((t) => t.id === w.activeTabId && t.windowId === w.id),
      ) ||
      (state.activeWindowId !== null && !windows.has(state.activeWindowId))
    )
      throw new RemoteKitError('internal', '工作区窗口/标签归属不一致');
    const previous = this.workspace(state.tenantId);
    if (
      isDeepStrictEqual(
        {
          ...state,
          revision: 0,
          pendingClose: state.pendingClose ?? null,
          pendingWindowCloseId: state.pendingWindowCloseId ?? null,
        },
        { ...previous, revision: 0 },
      )
    ) {
      state.revision = previous.revision;
      return false;
    }
    state.revision = previous.revision + 1;
    transaction(this.db, () => this.writeWorkspace(state));
    return true;
  }
  writeWorkspace(state: ProductWorkspace) {
    this.db.prepare('INSERT OR REPLACE INTO workspaces VALUES (?,?,?,?,?)').run(
      state.tenantId,
      state.revision,
      state.activeWindowId,
      state.layoutMode,
      JSON.stringify({
        pendingClose: state.pendingClose ?? null,
        pendingWindowCloseId: state.pendingWindowCloseId ?? null,
      }),
    );
    for (const table of ['workspace_windows', 'workspace_tabs', 'site_preferences'])
      this.db.prepare(`DELETE FROM ${table} WHERE tenant=?`).run(state.tenantId);
    state.windows.forEach((w, i) =>
      this.db
        .prepare('INSERT INTO workspace_windows VALUES (?,?,?,?,?)')
        .run(w.id, state.tenantId, i, w.activeTabId, w.weight),
    );
    state.tabs.forEach((t, i) =>
      this.db
        .prepare('INSERT INTO workspace_tabs VALUES (?,?,?,?,?)')
        .run(t.id, state.tenantId, t.windowId, i, JSON.stringify(t)),
    );
    this.db
      .prepare('INSERT OR REPLACE INTO user_settings VALUES (?,?)')
      .run(state.tenantId, JSON.stringify(state.settings));
    for (const [origin, data] of Object.entries(state.sites))
      this.db
        .prepare('INSERT INTO site_preferences VALUES (?,?,?)')
        .run(state.tenantId, origin, JSON.stringify(data));
  }
  all(): string[] {
    return (this.db.prepare('SELECT tenant FROM workspaces').all() as { tenant: string }[]).map(
      (row) => row.tenant,
    );
  }
  viewId(): string {
    return String(this.db.prepare('INSERT INTO view_ids DEFAULT VALUES').run().lastInsertRowid);
  }
}
