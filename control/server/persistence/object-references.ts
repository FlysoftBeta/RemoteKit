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

export function configuredReplicaNodes(db: Database.Database) {
  return checkpointReplicaNodes.get(db)?.() ?? [];
}

const statements = new WeakMap<Database.Database, Map<string, Database.Statement>>();
// Hot lookups run per request; preparing (and strict-wrapping) them each time costs more than the query.
function statement(db: Database.Database, sql: string) {
  let cache = statements.get(db);
  if (!cache) statements.set(db, (cache = new Map()));
  let prepared = cache.get(sql);
  if (!prepared) cache.set(sql, (prepared = db.prepare(sql)));
  return prepared;
}

type CheckpointVersion = {
  tenant: string;
  id: number;
  manifestId: string;
  takenAt: number;
  replicas: number;
};
const versionCache = new WeakMap<
  Database.Database,
  { stamp: string; versions: Map<string, CheckpointVersion[]> }
>();
// Any write by this connection (total_changes) or a commit by another one (data_version)
// can change versions or replica counts, so either invalidates the cache.
function databaseStamp(db: Database.Database) {
  const row = statement(db, 'SELECT total_changes() AS changes').get() as { changes: bigint };
  return `${row.changes}:${db.pragma('data_version', { simple: true })}`;
}

// Counts each version's minimum replica count over `nodes`: configured nodes for retention,
// ready nodes for choosing a version to open.
export function checkpointVersions(
  db: Database.Database,
  nodes: readonly string[],
  tenant?: string,
): CheckpointVersion[] {
  const stamp = databaseStamp(db);
  let cache = versionCache.get(db);
  if (cache?.stamp !== stamp) versionCache.set(db, (cache = { stamp, versions: new Map() }));
  const key = JSON.stringify([nodes, tenant ?? null]);
  const cached = cache.versions.get(key);
  if (cached) return cached.slice();
  const rows = statement(
    db,
    `SELECT c.tenant,c.id,c.manifest_id AS manifestId,c.created_at AS takenAt,
      CASE WHEN EXISTS (SELECT 1 FROM checkpoint_objects m
        WHERE m.tenant=c.tenant AND m.manifest_id=c.manifest_id AND m.id=c.manifest_id)
      THEN (SELECT min((SELECT count(*) FROM object_replicas r
          WHERE r.id=co.id AND r.node_id IN (SELECT value FROM json_each(@nodes))))
        FROM checkpoint_objects co WHERE co.tenant=c.tenant AND co.manifest_id=c.manifest_id)
      ELSE 0 END AS replicas
    FROM checkpoints c WHERE (@tenant IS NULL OR c.tenant=@tenant)
    ORDER BY c.tenant,c.id DESC`,
  ).all({ tenant: tenant ?? null, nodes: JSON.stringify(nodes) }) as {
    tenant: string;
    id: bigint;
    manifestId: string;
    takenAt: bigint;
    replicas: bigint | null;
  }[];
  const versions = rows.map((row) => ({
    tenant: row.tenant,
    id: Number(row.id),
    manifestId: row.manifestId,
    takenAt: Number(row.takenAt),
    replicas: Number(row.replicas ?? 0),
  }));
  cache.versions.set(key, versions);
  return versions.slice();
}

export function retainedCheckpoints(
  db: Database.Database,
  tenant?: string,
  nodes: readonly string[] = configuredReplicaNodes(db),
) {
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

/**
 * The durable reference roots outside plain tables: retained versions and open file
 * selections (whose manifests are strictly decoded here, never in SQL).
 */
export interface ReferenceRoots {
  retained: string;
  selected: string;
}

export function referenceRoots(
  db: Database.Database,
  tenant?: string,
  nodes: readonly string[] = configuredReplicaNodes(db),
): ReferenceRoots {
  const selected: [string, string][] = [];
  for (const row of statement(
    db,
    'SELECT tenant,id,manifest FROM file_library_selections WHERE terminal IS NULL AND (@tenant IS NULL OR tenant=@tenant)',
  ).all({ tenant: tenant ?? null }) as { tenant: string; id: string; manifest: string }[])
    for (const file of decodeJson(
      row.manifest,
      selection,
      `file_library_selections.manifest ${row.tenant}/${row.id}`,
    ).files)
      selected.push([row.tenant, file.assetId]);
  return {
    retained: JSON.stringify(
      retainedCheckpoints(db, tenant, nodes).map((version) => [version.tenant, version.manifestId]),
    ),
    selected: JSON.stringify(selected),
  };
}

// `refs(tenant,id)`: every object a tenant references, including derivatives of referenced
// objects. Claims count only when @since is set. UNION deduplicates, so derivation cycles end.
export const REFERENCES = `
  kept(tenant, manifest) AS (
    SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]') FROM json_each(@retained)),
  refs(tenant, id) AS (
    SELECT tenant, object_id FROM library_entry_objects WHERE @tenant IS NULL OR tenant=@tenant
    UNION SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]') FROM json_each(@selected)
    UNION SELECT co.tenant, co.id FROM kept JOIN checkpoint_objects co
      ON co.tenant=kept.tenant AND co.manifest_id=kept.manifest
    UNION SELECT tenant, id FROM object_claims
      WHERE @since IS NOT NULL AND claimed_at>=@since AND (@tenant IS NULL OR tenant=@tenant)
    UNION SELECT refs.tenant, d.id FROM object_derivations d JOIN refs ON d.source_id=refs.id)`;

function referenceParams(roots: ReferenceRoots, tenant: string | undefined, since: number | null) {
  return { ...roots, tenant: tenant ?? null, since };
}

export function tenantObjects(
  db: Database.Database,
  claims = true,
  now = Date.now(),
  nodes: readonly string[] = configuredReplicaNodes(db),
) {
  const refs = new Map<string, Set<string>>();
  for (const row of db
    .prepare(
      `WITH RECURSIVE ${REFERENCES} SELECT CAST(tenant AS TEXT) AS tenant, CAST(id AS TEXT) AS id FROM refs`,
    )
    .all(
      referenceParams(referenceRoots(db, undefined, nodes), undefined, claims ? now - OBJECT_GRACE_MS : null),
    ) as {
    tenant: string;
    id: string;
  }[]) {
    let ids = refs.get(row.tenant);
    if (!ids) refs.set(row.tenant, (ids = new Set()));
    ids.add(row.id);
  }
  return refs;
}

/** The ids one tenant references, claims included. */
export function tenantReferences(db: Database.Database, tenant: string, now = Date.now()) {
  return new Set(
    (
      db
        .prepare(`WITH RECURSIVE ${REFERENCES} SELECT DISTINCT CAST(id AS TEXT) AS id FROM refs`)
        .all(referenceParams(referenceRoots(db, tenant), tenant, now - OBJECT_GRACE_MS)) as { id: string }[]
    ).map((row) => row.id),
  );
}

export function tenantObjectUsage(db: Database.Database, tenant: string, now = Date.now()) {
  const row = db
    .prepare(
      `WITH RECURSIVE ${REFERENCES}, ids AS (SELECT DISTINCT id FROM refs)
      SELECT count(o.id) AS objects, coalesce(sum(o.size),0) AS bytes FROM ids JOIN objects o ON o.id=ids.id`,
    )
    .get(referenceParams(referenceRoots(db, tenant), tenant, now - OBJECT_GRACE_MS)) as {
    objects: bigint;
    bytes: bigint;
  };
  return { objects: Number(row.objects), bytes: Number(row.bytes) };
}

/**
 * Whether `id` is referenced (by `tenant`, or by anyone): it or a source it derives from is a
 * root. Walks the derivation ancestors of one object instead of computing a whole reference set.
 */
export function objectReferenced(
  db: Database.Database,
  id: string,
  options: { tenant?: string; since: number | null; roots?: ReferenceRoots },
) {
  const roots = options.roots ?? referenceRoots(db, options.tenant);
  return !!statement(
    db,
    `WITH RECURSIVE
        anc(id) AS (SELECT @id UNION SELECT d.source_id FROM object_derivations d JOIN anc ON d.id=anc.id),
        kept(tenant, manifest) AS (
          SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]') FROM json_each(@retained))
      SELECT 1 FROM anc WHERE
        EXISTS (SELECT 1 FROM library_entry_objects l
          WHERE l.object_id=anc.id AND (@tenant IS NULL OR l.tenant=@tenant))
        OR EXISTS (SELECT 1 FROM json_each(@selected) s
          WHERE json_extract(s.value,'$[1]')=anc.id AND (@tenant IS NULL OR json_extract(s.value,'$[0]')=@tenant))
        OR EXISTS (SELECT 1 FROM checkpoint_objects co JOIN kept
          ON co.tenant=kept.tenant AND co.manifest_id=kept.manifest
          WHERE co.id=anc.id AND (@tenant IS NULL OR co.tenant=@tenant))
        OR (@since IS NOT NULL AND EXISTS (SELECT 1 FROM object_claims c
          WHERE c.id=anc.id AND c.claimed_at>=@since AND (@tenant IS NULL OR c.tenant=@tenant)))
      LIMIT 1`,
  ).get({ ...referenceParams(roots, options.tenant, options.since), id });
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

// A live durable reference uses -1; releasing the last one starts a fresh grace period.
// Only rows whose state changes are written.
export function syncObjectReferences(db: Database.Database, now = Date.now()) {
  statement(
    db,
    `WITH RECURSIVE ${REFERENCES},
      durable AS MATERIALIZED (SELECT DISTINCT id FROM refs)
    INSERT INTO object_gc(id,unreferenced_at)
    SELECT o.id, CASE WHEN d.id IS NULL THEN @now ELSE -1 END
    FROM objects o LEFT JOIN durable d ON d.id=o.id LEFT JOIN object_gc g ON g.id=o.id
    WHERE (d.id IS NOT NULL AND g.unreferenced_at IS NOT -1) OR (d.id IS NULL AND g.unreferenced_at=-1)
    ON CONFLICT(id) DO UPDATE SET unreferenced_at=excluded.unreferenced_at`,
  ).run({ ...referenceParams(referenceRoots(db), undefined, null), now });
}
