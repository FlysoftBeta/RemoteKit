import { decodeJson, encodeJson } from './codec';
import * as codecs from './documents';
import type Database from 'better-sqlite3';
import type {
  ControlEvent,
  DeviceEvent,
  ImportChunk,
  ImportRecord,
  PairingClosedReason,
  PairingState,
  TimelineEntry,
  TimelineRequest,
} from '../../shared/session-import';
import type { AtRestKey } from '../auth/crypto';
import type { ImportEvent } from '../session-import/envelope';
import type { MailCursor } from '../session-import/mailbox';

export interface DeviceRow {
  keyId: string;
  tenant: string;
  publicKey: Buffer;
  name: string;
  pairedAt: number;
  inSeq: number;
  outSeq: number;
  ackedSeq: number;
  resentAt: number | null;
}
export interface StoredImport extends ImportRecord {
  tenant: string;
  keyId: string;
  storageJob?: import('../../shared/session-import').StorageImportJob;
  chunkIndex: number;
  applyCounts?: {
    cookies: import('../../shared/session-import').ApplyCounts;
    localStorage: import('../../shared/session-import').ApplyCounts;
  };
  errorCode?: import('../../shared/errors').ErrorCode;
  retryAt?: number;
}
export interface OutgoingEvent {
  rowId: number;
  tenant: string;
  keyId: string;
  event: ControlEvent;
}
type Reply = ControlEvent extends infer E ? (E extends ControlEvent ? Omit<E, 'seq' | 'at'> : never) : never;
function record(row: any): StoredImport {
  return {
    id: row.id,
    tenant: row.tenant,
    keyId: row.key_id,
    sites: decodeJson(row.sites, codecs.sites, `session_imports.sites ${row.id}`),
    state: row.state,
    cookies: Number(row.cookies),
    origins: Number(row.origins),
    rejectedItems: Number(row.rejected_items),
    error: row.error,
    storageJob: row.storage_job
      ? decodeJson(row.storage_job, codecs.storageJob, `session_imports.storage_job ${row.id}`)
      : undefined,
    chunkIndex: Number(row.chunk_index),
    applyCounts: row.apply_counts
      ? decodeJson(row.apply_counts, codecs.applyCounts, `session_imports.apply_counts ${row.id}`)
      : undefined,
    errorCode: row.error_code ?? undefined,
    retryAt: row.retry_at === null ? undefined : Number(row.retry_at),
    receivedAt: Number(row.received_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
  };
}
function visibleRecord({
  tenant,
  keyId,
  storageJob,
  chunkIndex,
  applyCounts,
  errorCode,
  retryAt,
  ...value
}: StoredImport): ImportRecord {
  return value;
}
export class SessionImportsRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly key: AtRestKey,
  ) {}
  saveApplyCounts(id: string, chunkIndex: number, counts: NonNullable<StoredImport['applyCounts']>) {
    this.db
      .prepare(
        'UPDATE session_imports SET chunk_index=?,apply_counts=?,storage_job=NULL,error_code=NULL,retry_at=NULL WHERE id=?',
      )
      .run(chunkIndex, encodeJson(counts, codecs.applyCounts, `session_imports.apply_counts ${id}`), id);
  }
  saveStorageJob(id: string, job: import('../../shared/session-import').StorageImportJob) {
    this.db
      .prepare('UPDATE session_imports SET storage_job=? WHERE id=?')
      .run(encodeJson(job, codecs.storageJob, `session_imports.storage_job ${id}`), id);
  }
  keys(): { publicKey: Buffer; privateKey: Buffer; keyId: string } | undefined {
    const row = this.db.prepare('SELECT * FROM session_import_keys WHERE id=1').get() as any;
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
  mailCursor(now: number): MailCursor {
    this.db.prepare('INSERT OR IGNORE INTO session_import_mailbox VALUES (1,?,NULL,NULL)').run(now);
    const row = this.db.prepare('SELECT * FROM session_import_mailbox WHERE id=1').get() as any;
    return {
      since: Number(row.since),
      uidValidity: row.uid_validity,
      uid: row.uid === null ? null : Number(row.uid),
    };
  }
  saveMailCursor(cursor: MailCursor) {
    this.db
      .prepare('UPDATE session_import_mailbox SET since=?, uid_validity=?, uid=? WHERE id=1')
      .run(cursor.since, cursor.uidValidity, cursor.uid);
  }
  pairing(tenant: string, now: number): PairingState {
    let row = this.db.prepare('SELECT * FROM session_import_pairing WHERE tenant=?').get(tenant) as any;
    if (row?.code && Number(row.expires_at) <= now) {
      this.closePairing(tenant, 'expired');
      row = this.db.prepare('SELECT * FROM session_import_pairing WHERE tenant=?').get(tenant);
    }
    return {
      open: !!row?.code,
      code: row?.code
        ? decodeJson(
            this.key.open('session-import-pairing:' + tenant, row.code).toString('utf8'),
            codecs.pairingCode,
            `session_import_pairing.code ${tenant}`,
          )
        : null,
      expiresAt: row?.code ? Number(row.expires_at) : null,
      failures: Number(row?.failures ?? 0),
      closedReason: row?.closed_reason ?? null,
    };
  }
  openPairing(tenant: string, code: string[], now: number) {
    this.db
      .prepare(
        `INSERT INTO session_import_pairing VALUES (?,?,?,?,0,NULL) ON CONFLICT(tenant) DO UPDATE SET code=excluded.code,opened_at=excluded.opened_at,expires_at=excluded.expires_at,failures=0,closed_reason=NULL`,
      )
      .run(
        tenant,
        this.key.seal(
          'session-import-pairing:' + tenant,
          Buffer.from(encodeJson(code, codecs.pairingCode, `session_import_pairing.code ${tenant}`)),
        ),
        now,
        now + 3 * 86400000,
      );
  }
  closePairing(tenant: string, reason: PairingClosedReason) {
    this.db
      .prepare(
        `INSERT INTO session_import_pairing VALUES (?,NULL,NULL,NULL,0,?) ON CONFLICT(tenant) DO UPDATE SET code=NULL,closed_reason=excluded.closed_reason`,
      )
      .run(tenant, reason);
  }
  pairingFailure(tenant: string) {
    this.db
      .prepare(
        'INSERT INTO session_import_pairing VALUES (?,NULL,NULL,NULL,1,NULL) ON CONFLICT(tenant) DO UPDATE SET failures=failures+1',
      )
      .run(tenant);
    const row = this.db
      .prepare('SELECT code,failures FROM session_import_pairing WHERE tenant=?')
      .get(tenant) as any;
    if (row?.code && Number(row.failures) >= 10) this.closePairing(tenant, 'failures');
  }
  device(keyId: string): DeviceRow | undefined {
    const row = this.db.prepare('SELECT * FROM session_import_devices WHERE key_id=?').get(keyId) as any;
    if (row)
      return {
        keyId,
        tenant: row.tenant,
        publicKey: row.public_key,
        name: row.name,
        pairedAt: Number(row.paired_at),
        inSeq: Number(row.in_seq),
        outSeq: Number(row.out_seq),
        ackedSeq: Number(row.acked_seq),
        resentAt: row.resent_at === null ? null : Number(row.resent_at),
      };
  }
  addDevice(keyId: string, tenant: string, publicKey: Buffer, name: string, now: number) {
    this.db
      .prepare('INSERT INTO session_import_devices VALUES (?,?,?,?,?,0,0,0,NULL)')
      .run(keyId, tenant, publicKey, name, now);
  }
  setInSeq(keyId: string, seq: number) {
    this.db.prepare('UPDATE session_import_devices SET in_seq=? WHERE key_id=?').run(seq, keyId);
  }
  acknowledge(device: DeviceRow, ack: number, now: number) {
    const acknowledged = Math.max(device.ackedSeq, Math.min(ack, device.outSeq));
    this.db
      .prepare('UPDATE session_import_devices SET acked_seq=? WHERE key_id=?')
      .run(acknowledged, device.keyId);
    if (acknowledged < device.outSeq && (device.resentAt === null || now - device.resentAt >= 900000)) {
      const requeued = this.db
        .prepare(
          "UPDATE session_import_events SET mailed_at=NULL WHERE key_id=? AND direction='out' AND seq>? AND mailed_at IS NOT NULL",
        )
        .run(device.keyId, acknowledged);
      if (requeued.changes)
        this.db
          .prepare('UPDATE session_import_devices SET resent_at=? WHERE key_id=?')
          .run(now, device.keyId);
    }
  }
  revoked(keyId: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM session_import_events WHERE key_id=? AND direction='out' AND type='revoked' LIMIT 1",
      )
      .get(keyId);
  }
  removeDevice(keyId: string) {
    this.db.prepare('DELETE FROM session_import_devices WHERE key_id=?').run(keyId);
  }
  incoming(
    tenant: string,
    keyId: string,
    publicKey: Buffer,
    name: string,
    event: DeviceEvent,
    receivedAt: number,
  ) {
    const identity = {
      seq: event.seq,
      at: event.at,
      receivedAt,
      device: name,
      publicKey: publicKey.toString('base64url'),
    };
    const body =
      event.type === 'pair'
        ? { ...identity, type: 'pair' as const, username: event.username }
        : event.type === 'withdraw'
          ? { ...identity, type: 'withdraw' as const, id: event.id.toLowerCase() }
          : {
              ...identity,
              type: 'import' as const,
              id: event.id.toLowerCase(),
              sites: Array.isArray(event.sites)
                ? event.sites
                    .filter((site) => site && typeof site.name === 'string' && typeof site.url === 'string')
                    .map(({ name, url }) => ({ name, url }))
                : [],
              cookies: Array.isArray(event.cookies) ? event.cookies.length : 0,
              origins: Array.isArray(event.localStorage) ? event.localStorage.length : 0,
            };
    this.db
      .prepare("INSERT INTO session_import_events VALUES (?,?,'in',?,?,?,NULL,?,NULL)")
      .run(
        tenant,
        keyId,
        event.seq,
        event.at,
        event.type,
        encodeJson(body, codecs.incomingEvent, `session_import_events.body ${tenant}/${event.seq}`),
      );
  }
  reply(tenant: string, keyId: string, reply: Reply, now: number): ControlEvent {
    const device = this.device(keyId);
    const seq = reply.type === 'pairRejected' ? 0 : (device?.outSeq ?? 0) + 1;
    if (reply.type !== 'pairRejected' && !device) throw new Error('Missing paired device');
    const event = { ...reply, seq, at: now } as ControlEvent;
    this.db
      .prepare("INSERT INTO session_import_events VALUES (?,?,'out',?,?,?,?,?,NULL)")
      .run(
        tenant,
        keyId,
        seq,
        now,
        event.type,
        'ref' in event ? event.ref : null,
        encodeJson(event, codecs.controlEvent, `session_import_events.body ${tenant}/${seq}`),
      );
    if (seq) this.db.prepare('UPDATE session_import_devices SET out_seq=? WHERE key_id=?').run(seq, keyId);
    return event;
  }
  latestRef(keyId: string, id: string): number {
    const row = this.db
      .prepare(
        "SELECT seq FROM session_import_events WHERE key_id=? AND direction='in' AND type='import' AND json_extract(body,'$.id')=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(keyId, id) as any;
    if (row) return Number(row.seq);
    const imported = this.db
      .prepare("SELECT tenant,payload FROM session_imports WHERE key_id=? AND id=? AND state='pending'")
      .get(keyId, id) as any;
    return imported ? (this.payload(imported.tenant, id)?.ref ?? 0) : 0;
  }

  rememberRef(tenant: string, id: string, ref: number) {
    const payload = this.payload(tenant, id);
    if (payload)
      this.db
        .prepare("UPDATE session_imports SET payload=? WHERE tenant=? AND id=? AND state='pending'")
        .run(
          this.key.seal(
            JSON.stringify(['session-import', tenant, id]),
            Buffer.from(
              encodeJson(
                { ...payload, ref },
                codecs.importPayload,
                `session_imports.payload ${tenant}/${id}`,
              ),
            ),
          ),
          tenant,
          id,
        );
  }
  appliedEvent(keyId: string, id: string): Extract<ControlEvent, { type: 'importApplied' }> | undefined {
    const row = this.db
      .prepare(
        "SELECT body FROM session_import_events WHERE key_id=? AND direction='out' AND type='importApplied' AND json_extract(body,'$.id')=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(keyId, id) as any;
    return row
      ? (decodeJson(row.body, codecs.controlEvent, `session_import_events.body ${keyId}/${id}`) as Extract<
          ControlEvent,
          { type: 'importApplied' }
        >)
      : undefined;
  }
  failedRetryable(keyId: string, id: string): boolean {
    const row = this.db
      .prepare(
        "SELECT body FROM session_import_events WHERE key_id=? AND direction='out' AND type='importFailed' AND json_extract(body,'$.id')=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(keyId, id) as any;
    if (!row) return false;
    const event = decodeJson(row.body, codecs.controlEvent, `session_import_events.body ${keyId}/${id}`);
    return event.type === 'importFailed' && event.retryable;
  }
  get(id: string): StoredImport | undefined {
    const row = this.db.prepare('SELECT * FROM session_imports WHERE id=?').get(id) as any;
    return row ? record(row) : undefined;
  }
  saveImport(
    tenant: string,
    keyId: string,
    event: ImportEvent,
    now: number,
    error: string | null,
    errorCode?: import('../../shared/errors').ErrorCode,
  ) {
    const id = event.id.toLowerCase();
    const payload = error
      ? null
      : this.key.seal(
          JSON.stringify(['session-import', tenant, id]),
          Buffer.from(
            encodeJson(
              { cookies: event.cookies, localStorage: event.localStorage, ref: event.seq },
              codecs.importPayload,
              `session_imports.payload ${tenant}/${id}`,
            ),
          ),
        );
    const sites = Array.isArray(event.sites)
      ? event.sites
          .filter((s) => s && typeof s.name === 'string' && typeof s.url === 'string')
          .map(({ name, url }) => ({ name, url }))
      : [];
    this.db
      .prepare(
        `INSERT INTO session_imports(id,tenant,key_id,sites,state,payload,cookies,origins,rejected_items,error,error_code,received_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sites=excluded.sites,state=excluded.state,payload=excluded.payload,cookies=excluded.cookies,origins=excluded.origins,rejected_items=0,error=excluded.error,error_code=excluded.error_code,retry_at=NULL,storage_job=NULL,chunk_index=0,apply_counts=NULL,received_at=excluded.received_at,finished_at=excluded.finished_at`,
      )
      .run(
        id,
        tenant,
        keyId,
        encodeJson(sites, codecs.sites, `session_imports.sites ${id}`),
        error ? 'failed' : 'pending',
        payload,
        Array.isArray(event.cookies) ? event.cookies.length : 0,
        Array.isArray(event.localStorage) ? event.localStorage.length : 0,
        0,
        error,
        error ? (errorCode ?? 'invalid_request') : null,
        now,
        error ? now : null,
      );
  }
  pendingTenants(): string[] {
    return (
      this.db.prepare("SELECT DISTINCT tenant FROM session_imports WHERE state='pending'").all() as {
        tenant: string;
      }[]
    ).map((row) => row.tenant);
  }
  pending(tenant: string): StoredImport[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM session_imports WHERE tenant=? AND state='pending' ORDER BY received_at,rowid",
        )
        .all(tenant) as any[]
    ).map(record);
  }
  payload(tenant: string, id: string): (ImportChunk & { ref: number }) | undefined {
    const row = this.db
      .prepare("SELECT payload FROM session_imports WHERE tenant=? AND id=? AND state='pending'")
      .get(tenant, id) as any;
    if (row)
      return decodeJson(
        this.key.open(JSON.stringify(['session-import', tenant, id]), row.payload).toString('utf8'),
        codecs.importPayload,
        `session_imports.payload ${tenant}/${id}`,
      );
  }
  isPending(tenant: string, id: string) {
    return this.get(id)?.tenant === tenant && this.get(id)?.state === 'pending';
  }
  finish(
    tenant: string,
    id: string,
    state: 'applied' | 'failed' | 'discarded',
    rejectedItems: number,
    error: string | null,
    now: number,
  ) {
    this.db
      .prepare(
        "UPDATE session_imports SET state=?,payload=NULL,rejected_items=?,error=?,finished_at=? WHERE tenant=? AND id=? AND state='pending'",
      )
      .run(state, rejectedItems, error, now, tenant, id);
  }
  devices(tenant: string) {
    return (
      this.db
        .prepare(
          `SELECT d.*, (SELECT MAX(at) FROM session_import_events e WHERE e.key_id=d.key_id AND e.tenant=d.tenant AND direction='in') AS last_request_at FROM session_import_devices d WHERE tenant=? ORDER BY paired_at DESC,rowid DESC`,
        )
        .all(tenant) as any[]
    ).map((row) => ({
      keyId: row.key_id,
      name: row.name,
      pairedAt: Number(row.paired_at),
      lastRequestAt: row.last_request_at === null ? null : Number(row.last_request_at),
    }));
  }
  timeline(tenant: string): TimelineEntry[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM session_import_events WHERE tenant=? AND direction='in' ORDER BY json_extract(body,'$.receivedAt') DESC,rowid DESC LIMIT 200",
      )
      .all(tenant) as any[];
    return rows.map((row) => {
      const body = decodeJson(
        row.body,
        codecs.incomingEvent,
        `session_import_events.body ${tenant}/${row.key_id}/${row.seq}`,
      );
      const device = this.device(row.key_id);
      const replies = (
        this.db
          .prepare(
            "SELECT body FROM session_import_events WHERE tenant=? AND key_id=? AND direction='out' AND ref=? ORDER BY at,rowid",
          )
          .all(tenant, row.key_id, row.seq) as any[]
      ).map((r) =>
        decodeJson(
          r.body,
          codecs.controlEvent,
          `session_import_events.body ${tenant}/${row.key_id}/${row.seq}`,
        ),
      );
      const imported = body.type === 'import' ? this.get(body.id) : undefined;
      const request: TimelineRequest =
        body.type === 'pair'
          ? { type: 'pair', device: body.device }
          : body.type === 'withdraw'
            ? { type: 'withdraw', id: body.id }
            : {
                type: 'import',
                id: body.id,
                sites: body.sites,
                cookies: body.cookies,
                origins: body.origins,
              };
      return {
        keyId: row.key_id,
        device: device?.tenant === tenant ? device.name : body.device,
        paired: device?.tenant === tenant,
        seq: Number(row.seq),
        at: Number(row.at),
        receivedAt: body.receivedAt,
        request,
        record: imported?.tenant === tenant ? visibleRecord(imported) : null,
        replies,
      };
    });
  }
  unacknowledged(keyId: string): ControlEvent[] {
    const device = this.device(keyId)!;
    return (
      this.db
        .prepare(
          "SELECT body FROM session_import_events WHERE key_id=? AND direction='out' AND seq>? ORDER BY seq",
        )
        .all(keyId, device.ackedSeq) as { body: string }[]
    ).map((row) => decodeJson(row.body, codecs.controlEvent, `session_import_events.body ${keyId}`));
  }
  outgoing(): OutgoingEvent[] {
    return (
      this.db
        .prepare(
          "SELECT rowid,* FROM session_import_events WHERE direction='out' AND mailed_at IS NULL ORDER BY key_id,seq,at,rowid",
        )
        .all() as any[]
    ).map((row) => ({
      rowId: Number(row.rowid),
      tenant: row.tenant,
      keyId: row.key_id,
      event: decodeJson(row.body, codecs.controlEvent, `session_import_events.body ${row.key_id}`),
    }));
  }
  lastInSeq(keyId: string): number {
    const row = this.db
      .prepare("SELECT MAX(seq) AS seq FROM session_import_events WHERE key_id=? AND direction='in'")
      .get(keyId) as any;
    return Number(row?.seq ?? 0);
  }
  recipient(keyId: string): Buffer | undefined {
    const device = this.device(keyId);
    if (device) return device.publicKey;
    const row = this.db
      .prepare(
        "SELECT body FROM session_import_events WHERE key_id=? AND direction='in' ORDER BY rowid DESC LIMIT 1",
      )
      .get(keyId) as any;
    return row
      ? Buffer.from(
          decodeJson(row.body, codecs.incomingEvent, `session_import_events.body ${keyId}`).publicKey,
          'base64url',
        )
      : undefined;
  }
  mailed(row: OutgoingEvent, now: number) {
    this.db
      .prepare(
        "UPDATE session_import_events SET mailed_at=? WHERE rowid=? AND tenant=? AND key_id=? AND direction='out' AND body=?",
      )
      .run(
        now,
        row.rowId,
        row.tenant,
        row.keyId,
        encodeJson(row.event, codecs.controlEvent, `session_import_events.body ${row.tenant}/${row.rowId}`),
      );
  }
  retain(now: number) {
    const cutoff = now - 180 * 86400000;
    this.db
      .prepare(
        "DELETE FROM session_import_events WHERE CASE WHEN direction='in' THEN json_extract(body,'$.receivedAt') ELSE at END < ?",
      )
      .run(cutoff);
    this.db.prepare("DELETE FROM session_imports WHERE state!='pending' AND finished_at<?").run(cutoff);
    this.db
      .prepare(
        "UPDATE session_import_pairing SET code=NULL,closed_reason='expired' WHERE code IS NOT NULL AND expires_at<=?",
      )
      .run(now);
  }
  deleteUser(tenant: string) {
    for (const table of [
      'session_import_pairing',
      'session_import_devices',
      'session_import_events',
      'session_imports',
    ])
      this.db.prepare(`DELETE FROM ${table} WHERE tenant=?`).run(tenant);
  }
}
