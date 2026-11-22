import type Database from 'better-sqlite3';
import {
  OBJECT_GRACE_MS,
  REFERENCES,
  referenceRoots,
  retainedCheckpoints,
  tenantObjects,
} from '../persistence/object-references';

export interface IndexedObject {
  id: string;
  size: bigint;
  stored_size: bigint;
  stored_sha256: string;
  created_at: bigint;
}

export interface ExpiredObjectsInput {
  now: number;
  replicaNodes: string[];
  /** Tenants whose claims stay live regardless of age (a checkpoint is being committed). */
  protectedTenants: string[];
  limit: number;
}

/** Unreferenced objects whose grace period has ended: the GC deletion candidates. */
function expiredObjects(db: Database.Database, input: ExpiredObjectsInput) {
  const cutoff = input.now - OBJECT_GRACE_MS;
  return db
    .prepare(
      `WITH RECURSIVE ${REFERENCES}
      SELECT o.* FROM objects o JOIN object_gc g ON g.id=o.id
      WHERE g.unreferenced_at>=0 AND g.unreferenced_at<@since
        AND o.id NOT IN (SELECT id FROM refs)
        AND NOT EXISTS (SELECT 1 FROM object_claims c WHERE c.id=o.id
          AND (c.claimed_at>=@since OR c.tenant IN (SELECT value FROM json_each(@protected))))
      ORDER BY o.created_at,o.id LIMIT @limit`,
    )
    .all({
      ...referenceRoots(db, undefined, input.replicaNodes),
      tenant: null,
      since: cutoff,
      protected: JSON.stringify(input.protectedTenants),
      limit: input.limit,
    }) as IndexedObject[];
}

export interface ReferenceDiffInput {
  now: number;
  replicaNodes: string[];
  protectedTenants: string[];
}

/**
 * Where `object_gc` disagrees with the durable references (`pin`: referenced but not marked
 * live; `release`: marked live but unreferenced), and claims past their grace that back no
 * durable reference of their tenant.
 */
function referenceDiff(db: Database.Database, input: ReferenceDiffInput) {
  const params = { ...referenceRoots(db, undefined, input.replicaNodes), tenant: null, since: null };
  const pin: string[] = [];
  const release: string[] = [];
  for (const row of db
    .prepare(
      `WITH RECURSIVE ${REFERENCES},
        durable AS MATERIALIZED (SELECT DISTINCT id FROM refs)
      SELECT o.id, d.id IS NOT NULL AS referenced
      FROM objects o LEFT JOIN durable d ON d.id=o.id LEFT JOIN object_gc g ON g.id=o.id
      WHERE (d.id IS NOT NULL AND g.unreferenced_at IS NOT -1) OR (d.id IS NULL AND g.unreferenced_at=-1)`,
    )
    .all(params) as { id: string; referenced: bigint }[])
    (row.referenced ? pin : release).push(row.id);
  const staleClaims = (
    db
      .prepare(
        `WITH RECURSIVE ${REFERENCES}
        SELECT c.tenant, c.id FROM object_claims c
        WHERE c.claimed_at<@cutoff AND c.tenant NOT IN (SELECT value FROM json_each(@protected))
          AND NOT EXISTS (SELECT 1 FROM refs WHERE refs.tenant=c.tenant AND refs.id=c.id)`,
      )
      .all({
        ...params,
        cutoff: input.now - OBJECT_GRACE_MS,
        protected: JSON.stringify(input.protectedTenants),
      }) as { tenant: string; id: string }[]
  ).map((row) => [row.tenant, row.id] as [string, string]);
  return { pin, release, staleClaims };
}

export interface UnderReplicatedInput {
  now: number;
  replicaNodes: string[];
  readyNodes: string[];
  target: number;
  limit: number;
}

/**
 * Referenced objects that have a readable copy but fewer than `target` on ready nodes; objects
 * of each tenant's current version first, then newest.
 */
function underReplicated(db: Database.Database, input: UnderReplicatedInput) {
  const retained = retainedCheckpoints(db, undefined, input.replicaNodes);
  const current = retained
    .filter((version, index) => version.tenant !== retained[index - 1]?.tenant)
    .map((version) => [version.tenant, version.manifestId]);
  return db
    .prepare(
      `WITH RECURSIVE ${REFERENCES},
        cur(tenant, manifest) AS (
          SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]') FROM json_each(@current)),
        counts AS MATERIALIZED (SELECT id, count(*) AS n FROM object_replicas
          WHERE node_id IN (SELECT value FROM json_each(@ready)) GROUP BY id)
      SELECT o.* FROM objects o JOIN counts ON counts.id=o.id
      WHERE counts.n<@target AND o.id IN (SELECT id FROM refs)
      ORDER BY EXISTS (SELECT 1 FROM cur JOIN checkpoint_objects co
          ON co.tenant=cur.tenant AND co.manifest_id=cur.manifest WHERE co.id=o.id) DESC,
        o.created_at DESC,o.id
      LIMIT @limit`,
    )
    .all({
      ...referenceRoots(db, undefined, input.replicaNodes),
      tenant: null,
      since: input.now - OBJECT_GRACE_MS,
      current: JSON.stringify(current),
      ready: JSON.stringify(input.readyNodes),
      target: input.target,
      limit: input.limit,
    }) as IndexedObject[];
}

export interface StorageInput {
  now: number;
  replicaNodes: string[];
  target: number;
  perTenant: boolean;
}

/** Whole-index totals for the admin storage page, with each tenant's referenced objects and bytes. */
function storage(db: Database.Database, input: StorageInput) {
  const totals = db
    .prepare(
      'SELECT count(*) AS count, coalesce(sum(size),0) AS bytes, coalesce(sum(stored_size),0) AS stored FROM objects',
    )
    .get() as { count: bigint; bytes: bigint; stored: bigint };
  const under = db
    .prepare(
      `SELECT count(*) AS count FROM objects o WHERE
        (SELECT count(*) FROM object_replicas r WHERE r.id=o.id) < ?`,
    )
    .get(input.target) as { count: bigint };
  const orphans = db.prepare('SELECT count(*) AS count FROM object_inventory_orphans').get() as {
    count: bigint;
  };
  const tenants: Record<string, { objects: number; bytes: number }> = {};
  const result = {
    objects: Number(totals.count),
    bytes: Number(totals.bytes),
    storedBytes: Number(totals.stored),
    underReplicated: Number(under.count),
    orphans: Number(orphans.count),
    tenants,
  };
  if (!input.perTenant) return result;
  const sizes = new Map(
    (db.prepare('SELECT id,size FROM objects').all() as { id: string; size: bigint }[]).map((row) => [
      row.id,
      Number(row.size),
    ]),
  );
  for (const [tenant, ids] of tenantObjects(db, true, input.now, input.replicaNodes)) {
    let bytes = 0;
    for (const id of ids) bytes += sizes.get(id) ?? 0;
    tenants[tenant] = { objects: ids.size, bytes };
  }
  return result;
}

export const readTasks = {
  'objects.referenceDiff': referenceDiff,
  'objects.expired': expiredObjects,
  'objects.underReplicated': underReplicated,
  'objects.storage': storage,
};
export type ReadTaskName = keyof typeof readTasks;
export type ReadTaskInput<K extends ReadTaskName> = Parameters<(typeof readTasks)[K]>[1];
export type ReadTaskOutput<K extends ReadTaskName> = ReturnType<(typeof readTasks)[K]>;
