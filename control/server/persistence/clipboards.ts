import type Database from 'better-sqlite3';
import limits from '../../../protocol/limits.json';
import { log } from '../log';
import { systemClock, type Clock } from '../util/clock';
import { managementDocumentBytes } from '../endpoint/coordination';

export interface ClipboardValue {
  revision: string;
  text: string;
  html: string;
}

export const clipboardLimits = { text: limits.textBytes, html: limits.htmlBytes } as const;

export function warnClipboardOversize(textBytes: number, htmlBytes: number, encodedBytes?: number) {
  log.warn('clipboard.write_exceeds_limits', {
    textBytes,
    htmlBytes,
    ...(encodedBytes === undefined ? {} : { encodedBytes }),
  });
}

export function clipboardDocumentBytes(value: Pick<ClipboardValue, 'text' | 'html'>): number {
  return managementDocumentBytes({
    method: 'session.clipboard',
    tenantId: '\u0000'.repeat(limits.identityBytes),
    sessionId: 'f'.repeat(32),
    placementEpoch: Number.MAX_SAFE_INTEGER,
    connectionEpoch: '\u0000'.repeat(limits.identityBytes),
    revision: '18446744073709551615',
    value: { text: value.text, html: value.html },
  });
}

function clipboardFits(value: Pick<ClipboardValue, 'text' | 'html'>): boolean {
  const textBytes = Buffer.byteLength(value.text);
  const htmlBytes = Buffer.byteLength(value.html);
  const encodedBytes = clipboardDocumentBytes(value);
  if (
    textBytes > clipboardLimits.text ||
    htmlBytes > clipboardLimits.html ||
    encodedBytes + limits.managementEnvelopeBytes > limits.documentBytes
  ) {
    warnClipboardOversize(textBytes, htmlBytes, encodedBytes);
    return false;
  }
  return true;
}

export class ClipboardsRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock = systemClock,
  ) {}

  revision(user: string): string | undefined {
    const row = this.db.prepare('SELECT revision FROM clipboards WHERE user_id=?').get(user) as
      { revision: bigint } | undefined;
    return row && String(row.revision);
  }

  latest(user: string): ClipboardValue | undefined {
    const row = this.db.prepare('SELECT revision,text,html FROM clipboards WHERE user_id=?').get(user) as
      { revision: bigint; text: string; html: string } | undefined;
    return row && { ...row, revision: String(row.revision) };
  }

  record(user: string, value: Pick<ClipboardValue, 'text' | 'html'>): ClipboardValue | undefined {
    if (!clipboardFits(value)) return;
    const row = this.db
      .prepare(
        `INSERT INTO clipboards(user_id,revision,text,html,updated_at) VALUES (?,1,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET revision=clipboards.revision+1,
        text=excluded.text,html=excluded.html,updated_at=excluded.updated_at
        RETURNING revision`,
      )
      .get(user, value.text, value.html, this.clock.wallMs()) as { revision: bigint };
    return { revision: String(row.revision), text: value.text, html: value.html };
  }

  clear(user: string) {
    this.db.prepare('DELETE FROM clipboards WHERE user_id=?').run(user);
  }
}
