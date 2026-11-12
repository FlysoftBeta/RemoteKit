import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { RemoteKitError } from '../../shared/errors';
import type { AtRestKey } from '../auth/crypto';
import { canonical, type SessionDesired, type SessionEvent } from '../endpoint/coordination';
import { encodeJson } from './codec';
import { sessionEventPayload } from './documents';

export class CoordinationRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly key: AtRestKey,
  ) {}
  revision(desired: Omit<SessionDesired, 'revision'>): string {
    const { connectionEpoch, ...content } = desired;
    const fingerprint = createHash('sha256').update(canonical(content)).digest('hex');
    return this.db.transaction(() => {
      const previous = this.db
        .prepare('SELECT session_id,placement_epoch,revision,fingerprint FROM session_desired WHERE tenant=?')
        .get(desired.tenantId) as
        { session_id: string; placement_epoch: bigint; revision: string; fingerprint: string } | undefined;
      if (
        previous &&
        previous.session_id === desired.sessionId &&
        Number(previous.placement_epoch) === desired.placementEpoch &&
        previous.fingerprint === fingerprint
      )
        return previous.revision;
      const revision = String(BigInt(previous?.revision ?? '0') + 1n);
      if (BigInt(revision) > 18446744073709551615n)
        throw new RemoteKitError('limit_exceeded', 'Desired revision exhausted');
      this.db
        .prepare(
          `INSERT INTO session_desired VALUES (?,?,?,?,?) ON CONFLICT(tenant) DO UPDATE SET session_id=excluded.session_id,placement_epoch=excluded.placement_epoch,revision=excluded.revision,fingerprint=excluded.fingerprint`,
        )
        .run(desired.tenantId, desired.sessionId, desired.placementEpoch, revision, fingerprint);
      return revision;
    })();
  }
  cursor(event: SessionEvent): string {
    const row = this.db
      .prepare('SELECT up_to FROM session_event_cursors WHERE tenant=? AND session_id=? AND stream_id=?')
      .get(event.tenantId, event.sessionId, event.streamId) as { up_to: string } | undefined;
    return row?.up_to ?? '0';
  }
  receive(event: SessionEvent): string | null {
    const payload = encodeJson<unknown>(
      {
        type: event.type,
        browserIncarnation: event.browserIncarnation,
        body: event.body,
      },
      sessionEventPayload,
      'session_event_inbox.payload',
    );
    const fingerprint = createHash('sha256')
      .update(canonical(JSON.parse(payload)))
      .digest('hex');
    const previous = this.db
      .prepare(
        'SELECT fingerprint,disposition FROM session_event_inbox WHERE tenant=? AND session_id=? AND event_id=?',
      )
      .get(event.tenantId, event.sessionId, event.eventId) as
      { fingerprint: string; disposition: string | null } | undefined;
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new RemoteKitError('conflict', 'Event identity payload conflicts');
      return previous.disposition;
    }
    const aad = canonical(['session-event', event.tenantId, event.sessionId, event.eventId]);
    const sealed = this.key.seal(aad, Buffer.from(payload));
    this.db
      .prepare('INSERT INTO session_event_inbox VALUES (?,?,?,?,?,?,NULL)')
      .run(event.tenantId, event.sessionId, event.eventId, event.type, fingerprint, sealed);
    return null;
  }
  settle(event: SessionEvent, disposition: string) {
    this.db
      .prepare('UPDATE session_event_inbox SET disposition=? WHERE tenant=? AND session_id=? AND event_id=?')
      .run(disposition, event.tenantId, event.sessionId, event.eventId);
  }
  advance(event: SessionEvent) {
    const previous = BigInt(this.cursor(event));
    const next = BigInt(event.seq);
    if (next <= previous) return;
    if (next !== previous + 1n) throw new RemoteKitError('conflict', 'Event sequence has a gap');
    this.db
      .prepare(
        `INSERT INTO session_event_cursors VALUES (?,?,?,?) ON CONFLICT(tenant,session_id,stream_id) DO UPDATE SET up_to=excluded.up_to`,
      )
      .run(event.tenantId, event.sessionId, event.streamId, event.seq);
  }
  deleteTenant(tenant: string) {
    for (const table of ['session_desired', 'session_event_inbox', 'session_event_cursors'])
      this.db.prepare(`DELETE FROM ${table} WHERE tenant=?`).run(tenant);
  }
  cancelInterruptedSignIns() {
    this.db
      .prepare(
        "UPDATE session_event_inbox SET disposition='canceled' WHERE type='view.signIn' AND (disposition IS NULL OR disposition='queued')",
      )
      .run();
  }
}
