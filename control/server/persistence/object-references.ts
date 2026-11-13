import { decodeJson } from './codec';
import { selection } from './documents';
import type Database from 'better-sqlite3';
export const OBJECT_GRACE_MS = 2 * 60 * 60 * 1000;
// Retention asks whether a version is durably replicated, so it counts replicas on every
// configured, non-removed node; whether those nodes are online now is irrelevant.
const checkpointReplicaNodes = new WeakMap<Database.Database, () => string[]>();

export function setCheckpointReplicaNodes(db: Database.Database, replicaNodes: () => string[]) {
  checkpointReplicaNodes.set(db, replicaNodes);
}

// Counts each version's minimum replica count over `nodes`: configured nodes for retention,
// ready nodes for choosing a version to open.
export function checkpointVersions(db: Database.Database, nodes: readonly string[], tenant?: string) {
  const rows = db
    .prepare(
      `SELECT c.tenant,c.id,c.manifest_id AS manifestId,c.created_at AS takenAt,
        CASE WHEN EXISTS (SELECT 1 FROM checkpoint_objects co
          WHERE co.tenant=c.tenant AND co.manifest_id=c.manifest_id AND co.id=c.manifest_id)
        THEN (SELECT min((SELECT count(*) FROM object_replicas r
          WHERE r.id=co.id AND r.node_id IN (SELECT value FROM json_each(@nodes))))
          FROM checkpoint_objects co WHERE co.tenant=c.tenant AND co.manifest_id=c.manifest_id)
        ELSE 0 END AS replicas
      FROM checkpoints c WHERE (@tenant IS NULL OR c.tenant=@tenant)
      ORDER BY c.tenant,c.id DESC`,
    )
    .all({ tenant: tenant ?? null, nodes: JSON.stringify(nodes) }) as {
    tenant: string;
    id: bigint;
    manifestId: string;
    takenAt: bigint;
    replicas: bigint;
  }[];
  return rows.map((row) => ({
    ...row,
    id: Number(row.id),
    takenAt: Number(row.takenAt),
    replicas: Number(row.replicas),
  }));
}

export function retainedCheckpoints(db: Database.Database, tenant?: string) {
  const nodes = checkpointReplicaNodes.get(db)?.() ?? [];
  const target = Math.min(2, nodes.length);
  const retained: ReturnType<typeof checkpointVersions> = [];
  let current: (typeof retained)[number] | undefined;
  let fallback = false;
  for (const version of checkpointVersions(db, nodes, tenant)) {
    if (version.tenant !== current?.tenant) {
      current = version;
      fallback = false;
      retained.push(version);
    } else if (!fallback && current.replicas < target && version.replicas >= 1) {
      retained.push(version);
      fallback = true;
    }
  }
  return retained;
}

export function pruneCheckpoints(db: Database.Database, tenant?: string, now = Date.now()) {
  db.transaction(() => {
    const retained = retainedCheckpoints(db, tenant);
    const kept = JSON.stringify(retained);
    const removed = db
      .prepare(
        `DELETE FROM checkpoint_objects WHERE (@tenant IS NULL OR tenant=@tenant)
        AND NOT EXISTS (SELECT 1 FROM json_each(@kept) k
          WHERE json_extract(k.value,'$.tenant')=checkpoint_objects.tenant
          AND json_extract(k.value,'$.manifestId')=checkpoint_objects.manifest_id)
        RETURNING id`,
      )
      .all({ tenant: tenant ?? null, kept }) as { id: string }[];
    const deleted = db
      .prepare(
        `DELETE FROM checkpoints WHERE (@tenant IS NULL OR tenant=@tenant)
        AND NOT EXISTS (SELECT 1 FROM json_each(@kept) k
          WHERE json_extract(k.value,'$.tenant')=checkpoints.tenant
          AND json_extract(k.value,'$.id')=checkpoints.id)`,
      )
      .run({ tenant: tenant ?? null, kept });
    if (!removed.length && !deleted.changes) return;
    const release = db.prepare(
      `INSERT INTO object_gc VALUES (?,?) ON CONFLICT(id) DO UPDATE
        SET unreferenced_at=excluded.unreferenced_at WHERE unreferenced_at=-1`,
    );
    for (const { id } of removed) release.run(id, now);
    syncObjectReferences(db, now);
  })();
}

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
  for (const row of db.prepare('SELECT DISTINCT tenant,object_id FROM library_entry_objects').all() as {
    tenant: string;
    object_id: string;
  }[])
    add(row.tenant, row.object_id);
  for (const row of db
    .prepare('SELECT tenant,id,manifest FROM file_library_selections WHERE terminal IS NULL')
    .all() as { tenant: string; id: string; manifest: string }[])
    for (const file of decodeJson(
      row.manifest,
      selection,
      `file_library_selections.manifest ${row.tenant}/${row.id}`,
    ).files)
      add(row.tenant, file.assetId);
  for (const row of db
    .prepare(
      `SELECT o.tenant,o.id FROM json_each(?) k JOIN checkpoint_objects o
        ON o.tenant=json_extract(k.value,'$.tenant') AND o.manifest_id=json_extract(k.value,'$.manifestId')`,
    )
    .all(JSON.stringify(retainedCheckpoints(db))) as { tenant: string; id: string }[])
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
