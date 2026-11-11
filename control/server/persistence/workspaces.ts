import { decodeJson, encodeJson } from './codec';
import * as codecs from './documents';
import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import { RemoteKitError } from '../../shared/errors';
import type { ProductWorkspace } from '../../shared/product';
import { transaction } from './database';
import { WorkspaceItemsRepository } from './workspace-items';
export const defaultSettings = () => ({
  workspace: {
    qualityPreference: 'auto' as const,
    uiScale: 1,
    topDeadZone: 'off' as const,
    showStats: false,
    autoFullscreen: false,
    autoKeyboard: false,
    clipboardSync: true,
    avSync: false,
    audioChannels: { left: true, right: true },
  },
  browser: { searchEngine: 'google' as const, memorySaverEnabled: true },
});
export function emptyWorkspace(tenantId: string): ProductWorkspace {
  return {
    tenantId,
    revision: 0,
    tabs: [],
    windows: [],
    spaces: [],
    activeSpaceId: null,
    apps: [],
    favorites: [],
    settings: defaultSettings(),
    sites: {},
    pendingClose: null,
    pendingWindowCloseId: null,
  };
}

export class WorkspacesRepository {
  readonly items: WorkspaceItemsRepository;
  constructor(private readonly db: Database.Database) {
    this.items = new WorkspaceItemsRepository(db);
  }
  workspace(tenant: string): ProductWorkspace {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE tenant=?').get(tenant) as
      | {
          revision: bigint;
          active_space: string | null;
          pending: string;
        }
      | undefined;
    if (!row) throw new RemoteKitError('not_found', '工作区不存在');
    const settings = this.db.prepare('SELECT data FROM user_settings WHERE tenant=?').get(tenant) as {
      data: string;
    };
    const productSettings = decodeJson(settings.data, codecs.settings, `user_settings.data ${tenant}`);
    return {
      tenantId: tenant,
      revision: Number(row.revision),
      activeSpaceId: row.active_space,
      ...decodeJson(row.pending, codecs.pending, `workspaces.pending ${tenant}`),
      settings: productSettings,
      windows: (
        this.db
          .prepare(
            'SELECT id,app_id,active_tab,state,last_active_at FROM workspace_windows WHERE tenant=? ORDER BY position',
          )
          .all(tenant) as {
          id: string;
          app_id: string;
          active_tab: string | null;
          state: string | null;
          last_active_at: bigint;
        }[]
      ).map((w) => ({
        id: w.id,
        appId: w.app_id,
        activeTabId: w.active_tab,
        lastActiveAt: Number(w.last_active_at),
        ...(w.state === null
          ? {}
          : { state: decodeJson(w.state, codecs.windowState, `workspace_windows.state ${tenant}/${w.id}`) }),
      })),
      spaces: (
        this.db
          .prepare('SELECT id,data FROM workspace_spaces WHERE tenant=? ORDER BY position')
          .all(tenant) as {
          id: string;
          data: string;
        }[]
      ).map((space) => decodeJson(space.data, codecs.space, `workspace_spaces.data ${tenant}/${space.id}`)),
      apps: this.items.apps(tenant),
      favorites: this.items.favorites(tenant),
      tabs: (
        this.db
          .prepare('SELECT id,data FROM workspace_tabs WHERE tenant=? ORDER BY position')
          .all(tenant) as {
          id: string;
          data: string;
        }[]
      ).map((t) => decodeJson(t.data, codecs.tab, `workspace_tabs.data ${tenant}/${t.id}`)),
      sites: Object.fromEntries(
        (
          this.db.prepare('SELECT origin,data FROM site_preferences WHERE tenant=?').all(tenant) as {
            origin: string;
            data: string;
          }[]
        ).map((s) => [
          s.origin,
          decodeJson(s.data, codecs.site, `site_preferences.data ${tenant}/${s.origin}`),
        ]),
      ),
    };
  }
  saveWorkspace(state: ProductWorkspace) {
    const windows = new Set(state.windows.map((w) => w.id)),
      tabs = new Set(state.tabs.map((t) => t.id)),
      spaces = new Set(state.spaces.map((space) => space.id)),
      placedWindows = state.spaces.flatMap((space) => space.windowIds);
    if (
      windows.size !== state.windows.length ||
      tabs.size !== state.tabs.length ||
      state.tabs.some((t) => !windows.has(t.windowId)) ||
      state.windows.some(
        (w) =>
          w.activeTabId !== null && !state.tabs.some((t) => t.id === w.activeTabId && t.windowId === w.id),
      ) ||
      spaces.size !== state.spaces.length ||
      placedWindows.length !== windows.size ||
      new Set(placedWindows).size !== placedWindows.length ||
      placedWindows.some((id) => !windows.has(id)) ||
      state.spaces.some(
        (space) =>
          space.windowIds.length < 1 ||
          space.windowIds.length > 3 ||
          space.weights.length !== space.windowIds.length ||
          space.weights.some((weight) => !Number.isFinite(weight) || weight <= 0) ||
          space.focusedWindowId === null ||
          !space.windowIds.includes(space.focusedWindowId),
      ) ||
      (state.activeSpaceId !== null && !spaces.has(state.activeSpaceId))
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
    this.db.prepare('INSERT OR REPLACE INTO workspaces VALUES (?,?,?,?)').run(
      state.tenantId,
      state.revision,
      state.activeSpaceId,
      encodeJson(
        {
          pendingClose: state.pendingClose ?? null,
          pendingWindowCloseId: state.pendingWindowCloseId ?? null,
          ...(state.pendingWindowCloseIds === undefined
            ? {}
            : { pendingWindowCloseIds: state.pendingWindowCloseIds }),
          ...(state.pendingAppUninstallId === undefined
            ? {}
            : { pendingAppUninstallId: state.pendingAppUninstallId }),
        },
        codecs.pending,
        `workspaces.pending ${state.tenantId}`,
      ),
    );
    for (const table of ['workspace_windows', 'workspace_tabs', 'workspace_spaces', 'site_preferences'])
      this.db.prepare(`DELETE FROM ${table} WHERE tenant=?`).run(state.tenantId);
    state.windows.forEach((w, i) =>
      this.db
        .prepare('INSERT INTO workspace_windows VALUES (?,?,?,?,?,?,?)')
        .run(
          w.id,
          state.tenantId,
          i,
          w.appId,
          w.activeTabId,
          w.state === undefined
            ? null
            : encodeJson(w.state, codecs.windowState, `workspace_windows.state ${state.tenantId}/${w.id}`),
          w.lastActiveAt,
        ),
    );
    state.spaces.forEach((space, i) =>
      this.db
        .prepare('INSERT INTO workspace_spaces VALUES (?,?,?,?)')
        .run(
          space.id,
          state.tenantId,
          i,
          encodeJson(space, codecs.space, `workspace_spaces.data ${state.tenantId}/${space.id}`),
        ),
    );
    this.items.save(state.tenantId, state.apps, state.favorites);
    state.tabs.forEach((t, i) =>
      this.db
        .prepare('INSERT INTO workspace_tabs VALUES (?,?,?,?,?)')
        .run(
          t.id,
          state.tenantId,
          t.windowId,
          i,
          encodeJson(t, codecs.tab, `workspace_tabs.data ${state.tenantId}/${t.id}`),
        ),
    );
    this.db
      .prepare('INSERT OR REPLACE INTO user_settings VALUES (?,?)')
      .run(
        state.tenantId,
        encodeJson(state.settings, codecs.settings, `user_settings.data ${state.tenantId}`),
      );
    for (const [origin, data] of Object.entries(state.sites))
      this.db
        .prepare('INSERT INTO site_preferences VALUES (?,?,?)')
        .run(
          state.tenantId,
          origin,
          encodeJson(data, codecs.site, `site_preferences.data ${state.tenantId}/${origin}`),
        );
  }
  all(): string[] {
    return (this.db.prepare('SELECT tenant FROM workspaces').all() as { tenant: string }[]).map(
      (row) => row.tenant,
    );
  }
  viewId(): string {
    return String(this.db.prepare('INSERT INTO view_ids DEFAULT VALUES').run().lastInsertRowid);
  }
  deleteTenant(tenant: string) {
    this.db.prepare('DELETE FROM workspaces WHERE tenant=?').run(tenant);
    this.db.prepare('DELETE FROM workspace_windows WHERE tenant=?').run(tenant);
    this.db.prepare('DELETE FROM workspace_tabs WHERE tenant=?').run(tenant);
    this.db.prepare('DELETE FROM workspace_spaces WHERE tenant=?').run(tenant);
    this.db.prepare('DELETE FROM user_settings WHERE tenant=?').run(tenant);
    this.db.prepare('DELETE FROM site_preferences WHERE tenant=?').run(tenant);
    this.items.deleteTenant(tenant);
  }
}
