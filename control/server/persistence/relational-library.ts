import type Database from 'better-sqlite3';
import type { LibraryEntry, LibrarySnapshot } from '../../shared/file-library';
import { decodeJson, encodeJson } from './codec';
import { libraryEntry, librarySource, partition } from './documents';

export function entryObjects(entry: LibraryEntry): { id: string; role: string }[] {
  if (entry.kind === 'snippet') return [];
  return [
    { id: entry.assetId, role: 'current' },
    ...(entry.originalAssetId ? [{ id: entry.originalAssetId, role: 'original' }] : []),
    ...[...new Set(entry.photo?.candidateAssetIds)].map((id) => ({ id, role: 'candidate' })),
  ];
}

export function readLibrary(db: Database.Database, tenant: string): LibrarySnapshot {
  const state = db
    .prepare('SELECT revision,basket_partition_id FROM library_state WHERE tenant=?')
    .get(tenant) as { revision: bigint; basket_partition_id: string | null } | undefined;
  const documents = <T>(table: string, codec: import('./codec').Codec<T>, order: string) =>
    (
      db.prepare(`SELECT id,data FROM ${table} WHERE tenant=? ORDER BY ${order}`).all(tenant) as {
        id: string;
        data: string;
      }[]
    ).map((row) => decodeJson(row.data, codec, `${table}.data ${tenant}/${row.id}`));
  return {
    revision: state ? Number(state.revision) : 0,
    basketPartitionId: state?.basket_partition_id ?? null,
    entries: documents('library_entries', libraryEntry, 'created_at DESC,position'),
    partitions: documents('library_partitions', partition, 'position'),
    basket: (
      db.prepare('SELECT entry_id FROM library_basket WHERE tenant=? ORDER BY position').all(tenant) as {
        entry_id: string;
      }[]
    ).map((row) => row.entry_id),
    excludedSources: (
      db
        .prepare('SELECT source FROM library_excluded_sources WHERE tenant=? ORDER BY position')
        .all(tenant) as { source: string }[]
    ).map((row) =>
      decodeJson(row.source, librarySource, `library_excluded_sources.source ${tenant}/${row.source}`),
    ),
    sources: [],
  };
}

export function writeLibrary(db: Database.Database, tenant: string, snapshot: LibrarySnapshot) {
  let referencesChanged = false;
  const existing = new Map(
    (
      db.prepare('SELECT id,data,position FROM library_entries WHERE tenant=?').all(tenant) as {
        id: string;
        data: string;
        position: bigint;
      }[]
    ).map((row) => [row.id, row]),
  );
  const ids = new Set(snapshot.entries.map((entry) => entry.id));
  for (const id of existing.keys())
    if (!ids.has(id)) {
      referencesChanged ||= !!db
        .prepare('SELECT 1 FROM library_entry_objects WHERE tenant=? AND entry_id=? LIMIT 1')
        .get(tenant, id);
      db.prepare('DELETE FROM library_entries WHERE tenant=? AND id=?').run(tenant, id);
    }
  db.prepare(
    `INSERT INTO library_state VALUES (?,?,?) ON CONFLICT(tenant) DO UPDATE SET revision=excluded.revision,basket_partition_id=excluded.basket_partition_id`,
  ).run(tenant, snapshot.revision, snapshot.basketPartitionId);
  const positions = new Map<number, number>();
  for (const entry of snapshot.entries) {
    const position = positions.get(entry.createdAt) ?? 0;
    positions.set(entry.createdAt, position + 1);
    const data = encodeJson(entry, libraryEntry, `library_entries.data ${tenant}/${entry.id}`);
    const beforeEntry = existing.get(entry.id);
    if (beforeEntry?.data === data) {
      if (Number(beforeEntry.position) !== position)
        db.prepare('UPDATE library_entries SET position=? WHERE tenant=? AND id=?').run(
          position,
          tenant,
          entry.id,
        );
      continue;
    }
    db.prepare(
      `INSERT INTO library_entries VALUES (?,?,?,?,?,?,?) ON CONFLICT(tenant,id) DO UPDATE SET created_at=excluded.created_at,kind=excluded.kind,size=excluded.size,data=excluded.data,position=excluded.position`,
    ).run(tenant, entry.id, entry.createdAt, entry.kind, entry.size, data, position);
    const before = new Set(
      (
        db
          .prepare('SELECT object_id,role FROM library_entry_objects WHERE tenant=? AND entry_id=?')
          .all(tenant, entry.id) as { object_id: string; role: string }[]
      ).map((row) => `${row.role}:${row.object_id}`),
    );
    const after = entryObjects(entry);
    for (const key of before) {
      if (after.some((item) => `${item.role}:${item.id}` === key)) continue;
      const at = key.indexOf(':');
      db.prepare(
        'DELETE FROM library_entry_objects WHERE tenant=? AND entry_id=? AND role=? AND object_id=?',
      ).run(tenant, entry.id, key.slice(0, at), key.slice(at + 1));
      referencesChanged = true;
    }
    for (const item of after)
      if (!before.has(`${item.role}:${item.id}`)) {
        db.prepare('INSERT INTO library_entry_objects VALUES (?,?,?,?)').run(
          tenant,
          entry.id,
          item.id,
          item.role,
        );
        referencesChanged = true;
      }
  }
  const prior = readLibraryLists(db, tenant);
  const partitions = snapshot.partitions.map((item) =>
    encodeJson(item, partition, `library_partitions.data ${tenant}/${item.id}`),
  );
  if (JSON.stringify(prior.partitions) !== JSON.stringify(partitions)) {
    db.prepare('DELETE FROM library_partitions WHERE tenant=?').run(tenant);
    snapshot.partitions.forEach((item, position) =>
      db
        .prepare('INSERT INTO library_partitions VALUES (?,?,?,?)')
        .run(tenant, item.id, position, partitions[position]),
    );
  }
  if (JSON.stringify(prior.basket) !== JSON.stringify(snapshot.basket)) {
    db.prepare('DELETE FROM library_basket WHERE tenant=?').run(tenant);
    snapshot.basket.forEach((id, position) =>
      db.prepare('INSERT INTO library_basket VALUES (?,?,?)').run(tenant, position, id),
    );
  }
  const sources = snapshot.excludedSources.map((item) =>
    encodeJson(item, librarySource, `library_excluded_sources.source ${tenant}`),
  );
  if (JSON.stringify(prior.sources) !== JSON.stringify(sources)) {
    db.prepare('DELETE FROM library_excluded_sources WHERE tenant=?').run(tenant);
    sources.forEach((source, position) =>
      db.prepare('INSERT INTO library_excluded_sources VALUES (?,?,?)').run(tenant, source, position),
    );
  }
  return referencesChanged;
}

function readLibraryLists(db: Database.Database, tenant: string) {
  return {
    partitions: (
      db.prepare('SELECT data FROM library_partitions WHERE tenant=? ORDER BY position').all(tenant) as {
        data: string;
      }[]
    ).map((row) => row.data),
    basket: (
      db.prepare('SELECT entry_id FROM library_basket WHERE tenant=? ORDER BY position').all(tenant) as {
        entry_id: string;
      }[]
    ).map((row) => row.entry_id),
    sources: (
      db
        .prepare('SELECT source FROM library_excluded_sources WHERE tenant=? ORDER BY position')
        .all(tenant) as { source: string }[]
    ).map((row) => row.source),
  };
}
