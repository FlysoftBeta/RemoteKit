import type Database from 'better-sqlite3';
import { RemoteKitError } from '../../shared/errors';
import type { LibraryEntry, LibrarySnapshot, SelectionState } from '../../shared/file-library';
import type { FileBinding } from '../endpoint/types';
import { transaction } from './database';
type TerminalState = Extract<SelectionState, 'selected' | 'cancelled'>;
export interface Selection {
  selectionId: string;
  requestId: string;
  binding: FileBinding;
  entryIds: string[];
  groupId: string | null;
  files: Pick<LibraryEntry, 'assetId' | 'name' | 'type'>[];
  prepared: boolean;
}

export class LibraryRepository {
  constructor(private readonly db: Database.Database) {}
  snapshot(tenant: string): LibrarySnapshot {
    const row = this.db.prepare('SELECT snapshot FROM file_library WHERE tenant=?').get(tenant) as
      { snapshot: string } | undefined;
    return row ? JSON.parse(row.snapshot) : { revision: 0, entries: [], basket: [], groups: [] };
  }
  save(tenant: string, snapshot: LibrarySnapshot) {
    snapshot.revision++;
    this.db.prepare('INSERT OR REPLACE INTO file_library VALUES (?,?)').run(tenant, JSON.stringify(snapshot));
  }
  operation(tenant: string, operationId: string, payload: string) {
    const row = this.db
      .prepare('SELECT payload,selection_id FROM file_library_operations WHERE tenant=? AND id=?')
      .get(tenant, operationId) as { payload: string; selection_id: string | null } | undefined;
    if (row && row.payload !== payload) throw new RemoteKitError('conflict', '同一操作ID不能用于不同内容');
    return row;
  }
  remember(tenant: string, operationId: string, payload: string, selectionId: string | null = null) {
    this.db
      .prepare('INSERT INTO file_library_operations VALUES (?,?,?,?)')
      .run(tenant, operationId, payload, selectionId);
  }
  change(tenant: string, operationId: string, payload: string, apply: (snapshot: LibrarySnapshot) => void) {
    return transaction(this.db, () => {
      const snapshot = this.snapshot(tenant);
      if (this.operation(tenant, operationId, payload)) return snapshot;
      apply(snapshot);
      this.save(tenant, snapshot);
      this.remember(tenant, operationId, payload);
      return snapshot;
    });
  }
  pendingEntries(tenant: string) {
    const ids = new Set<string>();
    const pending = this.db
      .prepare('SELECT manifest FROM file_library_selections WHERE tenant=? AND terminal IS NULL')
      .all(tenant) as { manifest: string }[];
    for (const row of pending) {
      const manifest: Selection = JSON.parse(row.manifest);
      for (const entryId of manifest.entryIds) ids.add(entryId);
    }
    return ids;
  }
  prune(tenant: string, snapshot: LibrarySnapshot) {
    const inUse = this.pendingEntries(tenant);
    for (const entryId of snapshot.basket) inUse.add(entryId);
    const before = snapshot.entries.length;
    snapshot.entries = snapshot.entries.filter((entry) => entry.archived || inUse.has(entry.id));
    return snapshot.entries.length !== before;
  }
  selection(tenant: string, selectionId: string) {
    const row = this.db
      .prepare('SELECT manifest,terminal FROM file_library_selections WHERE tenant=? AND id=?')
      .get(tenant, selectionId) as { manifest: string; terminal: TerminalState | null } | undefined;
    if (!row) throw new RemoteKitError('not_found', '文件选择不存在');
    return { manifest: JSON.parse(row.manifest) as Selection, terminal: row.terminal };
  }
  settle(tenant: string, manifest: Selection, state: SelectionState) {
    transaction(this.db, () => {
      const { selectionId } = manifest;
      if (state === 'selected' || state === 'cancelled') {
        const update = this.db
          .prepare(
            'UPDATE file_library_selections SET terminal=? WHERE tenant=? AND id=? AND terminal IS NULL',
          )
          .run(state, tenant, selectionId);
        if (Number(update.changes)) {
          const snapshot = this.snapshot(tenant),
            selected = new Set(manifest.entryIds);
          if (state === 'selected')
            for (const entry of snapshot.entries)
              if (selected.has(entry.id)) {
                entry.archived = true;
                entry.groupId = manifest.groupId;
              }
          if (state === 'selected')
            snapshot.basket = snapshot.basket.filter((entryId) => !selected.has(entryId));
          const pruned = this.prune(tenant, snapshot);
          if (state === 'selected' || pruned) this.save(tenant, snapshot);
        }
      } else {
        this.db
          .prepare('UPDATE file_library_selections SET checked=? WHERE tenant=? AND id=?')
          .run(Date.now(), tenant, selectionId);
      }
    });
  }
  pending(tenant: string, limit: number): Selection[] {
    return (
      this.db
        .prepare(
          'SELECT manifest FROM file_library_selections WHERE tenant=? AND terminal IS NULL ORDER BY checked,id LIMIT ?',
        )
        .all(tenant, limit) as { manifest: string }[]
    ).map((row) => JSON.parse(row.manifest));
  }
  insertSelection(tenant: string, manifest: Selection, operationId: string, payload: string) {
    transaction(this.db, () => {
      this.db
        .prepare('INSERT INTO file_library_selections (tenant,id,manifest) VALUES (?,?,?)')
        .run(tenant, manifest.selectionId, JSON.stringify(manifest));
      this.remember(tenant, operationId, payload, manifest.selectionId);
    });
  }
  saveSelection(tenant: string, manifest: Selection) {
    this.db
      .prepare('UPDATE file_library_selections SET manifest=? WHERE tenant=? AND id=?')
      .run(JSON.stringify(manifest), tenant, manifest.selectionId);
  }
}
