import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { Favorite, InstalledApp } from '../../shared/product';
import type { UsageEvent } from '../workspace/frecency';
import { transaction } from './database';

interface UsageRow {
  at: bigint;
  item: string;
  window_id: string;
  chain: string;
  title: string | null;
}

export interface UsageRecord {
  item: string;
  windowId: string;
  tabId?: string;
  title?: string;
  source?: 'launcher';
}

function usageEvent(row: UsageRow): UsageEvent {
  return {
    at: Number(row.at),
    item: row.item,
    windowId: row.window_id,
    chain: row.chain,
    ...(row.title === null ? {} : { title: row.title }),
  };
}

export class WorkspaceItemsRepository {
  constructor(private readonly db: Database.Database) {}

  apps(tenant: string): InstalledApp[] {
    return (
      this.db.prepare('SELECT data FROM installed_apps WHERE tenant=? ORDER BY position').all(tenant) as {
        data: string;
      }[]
    ).map((row) => JSON.parse(row.data));
  }

  favorites(tenant: string): Favorite[] {
    return (
      this.db.prepare('SELECT data FROM favorites WHERE tenant=? ORDER BY position').all(tenant) as {
        data: string;
      }[]
    ).map((row) => JSON.parse(row.data));
  }

  save(tenant: string, apps: InstalledApp[], favorites: Favorite[]) {
    const retained = new Set(apps.map((app) => app.id));
    const stored = this.db.prepare('SELECT id FROM installed_apps WHERE tenant=?').all(tenant) as {
      id: string;
    }[];
    for (const { id } of stored)
      if (!retained.has(id))
        this.db.prepare('DELETE FROM installed_apps WHERE tenant=? AND id=?').run(tenant, id);
    for (const [position, app] of apps.entries())
      this.db
        .prepare(
          `INSERT INTO installed_apps(tenant,id,position,data,icon_hash) VALUES (?,?,?,?,?)
           ON CONFLICT(tenant,id) DO UPDATE SET position=excluded.position,data=excluded.data,icon_hash=excluded.icon_hash`,
        )
        .run(tenant, app.id, position, JSON.stringify(app), app.iconHash ?? null);
    this.db.prepare('DELETE FROM favorites WHERE tenant=?').run(tenant);
    for (const [position, favorite] of favorites.entries())
      this.db
        .prepare('INSERT INTO favorites(tenant,id,position,data) VALUES (?,?,?,?)')
        .run(tenant, favorite.id, position, JSON.stringify(favorite));
  }

  appIcon(tenant: string, id: string): { png: Buffer; hash: string } | null {
    const row = this.db
      .prepare('SELECT icon,icon_hash FROM installed_apps WHERE tenant=? AND id=?')
      .get(tenant, id) as { icon: Buffer | null; icon_hash: string | null } | undefined;
    return row?.icon && row.icon_hash ? { png: row.icon, hash: row.icon_hash } : null;
  }

  setAppIcon(tenant: string, id: string, png: Buffer | null): string | undefined {
    const hash = png ? createHash('sha256').update(png).digest('hex') : undefined;
    this.db
      .prepare('UPDATE installed_apps SET icon=?,icon_hash=? WHERE tenant=? AND id=?')
      .run(png, hash ?? null, tenant, id);
    return hash;
  }

  usage(tenant: string, now = Date.now()): UsageEvent[] {
    this.pruneUsage(tenant, now);
    return (
      this.db
        .prepare('SELECT at,item,window_id,chain,title FROM usage_events WHERE tenant=? ORDER BY at,id')
        .all(tenant) as UsageRow[]
    ).map(usageEvent);
  }

  recordUsage(tenant: string, event: UsageRecord, at = Date.now()): UsageEvent {
    return transaction(this.db, () => {
      this.pruneUsage(tenant, at);
      const context = event.item.startsWith('page:') ? `tab:${event.tabId}` : 'window';
      const previous = this.db
        .prepare(
          `SELECT at,item,window_id,chain,title FROM usage_events
           WHERE tenant=? AND window_id=? AND context=? ORDER BY at DESC,id DESC LIMIT 1`,
        )
        .get(tenant, event.windowId, context) as UsageRow | undefined;
      if (event.source !== 'launcher' && event.item.startsWith('app:')) {
        const focus = this.db
          .prepare(
            `SELECT at,item,window_id,chain,title FROM usage_events
             WHERE tenant=? AND window_id=? AND item=? ORDER BY at DESC,id DESC LIMIT 1`,
          )
          .get(tenant, event.windowId, event.item) as UsageRow | undefined;
        if (focus && at - Number(focus.at) < 30 * 1000) return usageEvent(focus);
      }
      const chain =
        event.source !== 'launcher' && previous && at - Number(previous.at) < 30 * 60 * 1000
          ? previous.chain
          : randomUUID();
      this.db
        .prepare(
          'INSERT INTO usage_events(tenant,at,item,window_id,context,chain,title) VALUES (?,?,?,?,?,?,?)',
        )
        .run(tenant, at, event.item, event.windowId, context, chain, event.title ?? null);
      this.pruneUsage(tenant, at);
      return {
        at,
        item: event.item,
        windowId: event.windowId,
        chain,
        ...(event.title === undefined ? {} : { title: event.title }),
      };
    });
  }

  clearUsage(tenant: string, scope: 'all' | 'pages') {
    this.db
      .prepare(`DELETE FROM usage_events WHERE tenant=?${scope === 'pages' ? " AND item LIKE 'page:%'" : ''}`)
      .run(tenant);
  }

  updateUsageTitle(tenant: string, item: string, title: string) {
    this.db
      .prepare(
        `UPDATE usage_events SET title=? WHERE id=(
        SELECT id FROM usage_events WHERE tenant=? AND item=? ORDER BY at DESC,id DESC LIMIT 1)`,
      )
      .run(title, tenant, item);
  }

  private pruneUsage(tenant: string, now: number) {
    this.db
      .prepare('DELETE FROM usage_events WHERE tenant=? AND at<?')
      .run(tenant, now - 90 * 24 * 60 * 60 * 1000);
    this.db
      .prepare(
        `DELETE FROM usage_events WHERE tenant=? AND id IN
         (SELECT id FROM usage_events WHERE tenant=? ORDER BY at DESC,id DESC LIMIT -1 OFFSET 20000)`,
      )
      .run(tenant, tenant);
  }

  deleteTenant(tenant: string) {
    for (const table of ['installed_apps', 'favorites', 'usage_events'])
      this.db.prepare(`DELETE FROM ${table} WHERE tenant=?`).run(tenant);
  }
}
