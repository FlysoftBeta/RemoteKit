import type Database from 'better-sqlite3';
export const OBJECT_GRACE_MS = 2 * 60 * 60 * 1000;
export function tenantObjects(db: Database.Database, claims = true, now = Date.now()) {
  const refs = new Map<string, Set<string>>();
  const add = (tenant: string, id: string | undefined) => {
    if (!id) return;
    let ids = refs.get(tenant);
    if (!ids) {
      ids = new Set();
      refs.set(tenant, ids);
    }
    ids.add(id);
  };
  for (const row of db.prepare('SELECT tenant,snapshot FROM file_library').all() as {
    tenant: string;
    snapshot: string;
  }[])
    for (const entry of JSON.parse(row.snapshot).entries) {
      add(row.tenant, entry.assetId);
      add(row.tenant, entry.originalAssetId);
      for (const id of entry.photo?.candidateAssetIds ?? []) add(row.tenant, id);
    }
  for (const row of db
    .prepare('SELECT tenant,manifest FROM file_library_selections WHERE terminal IS NULL')
    .all() as { tenant: string; manifest: string }[])
    for (const file of JSON.parse(row.manifest).files) add(row.tenant, file.assetId);
  for (const row of db
    .prepare(
      `SELECT o.tenant,o.id FROM checkpoint_objects o WHERE o.manifest_id IN
    (SELECT c.manifest_id FROM checkpoints c WHERE c.tenant=o.tenant ORDER BY c.id DESC LIMIT 2)`,
    )
    .all() as { tenant: string; id: string }[])
    add(row.tenant, row.id);
  if (claims)
    for (const row of db
      .prepare('SELECT tenant,id FROM object_claims WHERE claimed_at>=?')
      .all(now - OBJECT_GRACE_MS) as { tenant: string; id: string }[])
      add(row.tenant, row.id);
  const derivatives = db.prepare('SELECT id,source_id FROM object_derivations').all() as {
    id: string;
    source_id: string;
  }[];
  for (const ids of refs.values()) {
    let changed: boolean;
    do {
      changed = false;
      for (const row of derivatives)
        if (ids.has(row.source_id) && !ids.has(row.id)) {
          ids.add(row.id);
          changed = true;
        }
    } while (changed);
  }
  return refs;
}

// A live durable reference uses -1; releasing the last one starts a fresh grace period.
export function syncObjectReferences(db: Database.Database, now = Date.now()) {
  const referenced = new Set([...tenantObjects(db, false, now).values()].flatMap((ids) => [...ids]));
  const pin = db.prepare(
    'INSERT INTO object_gc VALUES (?,-1) ON CONFLICT(id) DO UPDATE SET unreferenced_at=-1',
  );
  const release = db.prepare('UPDATE object_gc SET unreferenced_at=? WHERE id=? AND unreferenced_at=-1');
  for (const row of db.prepare('SELECT id FROM objects').all() as { id: string }[]) {
    if (referenced.has(row.id)) pin.run(row.id);
    else release.run(now, row.id);
  }
}
