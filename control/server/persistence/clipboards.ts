import type Database from 'better-sqlite3';
import { systemClock, type Clock } from '../util/clock';

export interface ClipboardValue {
  revision: string;
  text: string;
  html: string;
}

export const clipboardLimits = { text: 1024 * 1024, html: 2 * 1024 * 1024 } as const;

export function warnClipboardOversize(textBytes: number, htmlBytes: number) {
  console.warn('Clipboard write exceeds limits', { textBytes, htmlBytes });
}

export class ClipboardsRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock = systemClock,
  ) {}

  latest(user: string): ClipboardValue | undefined {
    const row = this.db.prepare('SELECT revision,text,html FROM clipboards WHERE user_id=?').get(user) as
      { revision: bigint; text: string; html: string } | undefined;
    return row && { ...row, revision: String(row.revision) };
  }

  record(user: string, value: Pick<ClipboardValue, 'text' | 'html'>): ClipboardValue | undefined {
    const textBytes = Buffer.byteLength(value.text, 'utf8');
    const htmlBytes = Buffer.byteLength(value.html, 'utf8');
    if (textBytes > clipboardLimits.text || htmlBytes > clipboardLimits.html) {
      warnClipboardOversize(textBytes, htmlBytes);
      return;
    }
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
