import type Database from 'better-sqlite3';
import type { ImportPayload, ImportRecord, StoredImportPayload } from '../../shared/session-import';
import type { AtRestKey } from '../auth/crypto';

interface ImportRow {
  id: string;
  tenant: string;
  sites: string;
  device: string;
  created_at: bigint;
  received_at: bigint;
  state: ImportRecord['state'];
  cookies: bigint;
  origins: bigint;
  rejected_items: bigint;
  error: string | null;
  finished_at: bigint | null;
}
const columns =
  'id,tenant,sites,device,created_at,received_at,state,cookies,origins,rejected_items,error,finished_at';
function record(row: ImportRow): ImportRecord {
  return {
    id: row.id,
    sites: JSON.parse(row.sites),
    device: row.device,
    createdAt: Number(row.created_at),
    receivedAt: Number(row.received_at),
    state: row.state,
    cookies: Number(row.cookies),
    origins: Number(row.origins),
    rejectedItems: Number(row.rejected_items),
    error: row.error,
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
  };
}
export class SessionImportsRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly key: AtRestKey,
  ) {}
  keys(): { publicKey: Buffer; privateKey: Buffer; keyId: string } | undefined {
    const row = this.db
      .prepare('SELECT public_key, private_key, key_id FROM session_import_keys WHERE id=1')
      .get() as { public_key: Buffer; private_key: string; key_id: string } | undefined;
    if (row)
      return {
        publicKey: row.public_key,
        privateKey: this.key.open('session-import-key:' + row.key_id, row.private_key),
        keyId: row.key_id,
      };
  }
  saveKeys(publicKey: Buffer, privateKey: Buffer, keyId: string) {
    this.db
      .prepare('INSERT INTO session_import_keys VALUES (1,?,?,?)')
      .run(publicKey, this.key.seal('session-import-key:' + keyId, privateKey), keyId);
  }
  exists(id: string) {
    return !!this.db.prepare('SELECT 1 FROM session_imports WHERE id=?').get(id);
  }
  insert(tenant: string, payload: ImportPayload, receivedAt: number, rejection?: string) {
    const session: StoredImportPayload = {
      v: payload.v,
      id: payload.id,
      createdAt: payload.createdAt,
      device: payload.device,
      sites: payload.sites,
      cookies: payload.cookies,
      localStorage: payload.localStorage,
    };
    this.db
      .prepare(`INSERT INTO session_imports (${columns},payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        payload.id.toLowerCase(),
        tenant,
        JSON.stringify(payload.sites.map(({ name, url }) => ({ name, url }))),
        payload.device,
        payload.createdAt,
        receivedAt,
        rejection ? 'rejected' : 'pending',
        payload.cookies.length,
        payload.localStorage.length,
        0,
        rejection ?? null,
        rejection ? receivedAt : null,
        rejection
          ? null
          : this.key.seal(
              JSON.stringify(['session-import', tenant, payload.id.toLowerCase()]),
              Buffer.from(JSON.stringify(session)),
            ),
      );
  }
  list(tenant: string): ImportRecord[] {
    return (
      this.db
        .prepare(`SELECT ${columns} FROM session_imports WHERE tenant=? ORDER BY received_at DESC,id`)
        .all(tenant) as ImportRow[]
    ).map(record);
  }
  pendingTenants(): string[] {
    return (
      this.db.prepare("SELECT DISTINCT tenant FROM session_imports WHERE state='pending'").all() as {
        tenant: string;
      }[]
    ).map((row) => row.tenant);
  }
  pending(tenant: string): ImportRecord[] {
    return (
      this.db
        .prepare(
          `SELECT ${columns} FROM session_imports WHERE tenant=? AND state='pending' ORDER BY received_at,id`,
        )
        .all(tenant) as ImportRow[]
    ).map(record);
  }
  payload(tenant: string, id: string): StoredImportPayload | undefined {
    const row = this.db
      .prepare("SELECT payload FROM session_imports WHERE tenant=? AND id=? AND state='pending'")
      .get(tenant, id) as { payload: string } | undefined;
    if (row)
      return JSON.parse(
        this.key.open(JSON.stringify(['session-import', tenant, id]), row.payload).toString('utf8'),
      );
  }
  isPending(tenant: string, id: string) {
    return !!this.db
      .prepare("SELECT 1 FROM session_imports WHERE tenant=? AND id=? AND state='pending'")
      .get(tenant, id);
  }
  finish(
    tenant: string,
    id: string,
    state: 'applied' | 'failed',
    rejectedItems: number,
    error: string | null,
    at: number,
  ) {
    this.db
      .prepare(
        "UPDATE session_imports SET state=?,payload=NULL,rejected_items=?,error=?,finished_at=? WHERE tenant=? AND id=? AND state='pending'",
      )
      .run(state, rejectedItems, error, at, tenant, id);
  }
  delete(tenant: string, id: string) {
    this.db.prepare('DELETE FROM session_imports WHERE tenant=? AND id=?').run(tenant, id);
  }
  deleteUser(tenant: string) {
    this.db.prepare('DELETE FROM session_imports WHERE tenant=?').run(tenant);
  }
}
