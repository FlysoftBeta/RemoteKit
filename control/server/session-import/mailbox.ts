import { ImapFlow } from 'imapflow';
import type { Readable } from 'node:stream';
import type { SessionImportConfig } from '../config';
import type { MailboxStatus } from '../../shared/session-import';
import { MAX_ENVELOPE_BYTES, envelopeKeyId } from './envelope';

export interface MailPart {
  part?: string;
  parameters?: Record<string, string>;
  dispositionParameters?: Record<string, string>;
  childNodes?: MailPart[];
}
export interface MailClient {
  connect(): Promise<void>;
  mailboxOpen(folder: string): Promise<{ uidValidity: bigint; uidNext?: number }>;
  search(query: { since: Date }, options: { uid: true }): Promise<number[] | false | undefined>;
  fetch(
    range: string,
    query: { envelope: true; internalDate: true; bodyStructure: true },
    options: { uid: true },
  ): AsyncIterable<{
    uid: number;
    envelope?: { subject?: string };
    internalDate?: Date | string;
    bodyStructure?: MailPart;
  }>;
  download(
    uid: number,
    part: string,
    options: { uid: true; maxBytes: number },
  ): Promise<{ content?: Readable }>;
  messageDelete(uid: number, options: { uid: true }): Promise<unknown>;
  logout(): Promise<unknown>;
  close(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
}
export type MailClientFactory = (config: SessionImportConfig) => MailClient;
export const createMailClient: MailClientFactory = (config) =>
  new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: true,
    auth: { user: config.imap.user, pass: config.imap.password },
    logger: false,
    disableAutoIdle: true,
    // ImapFlow sends ID during connect, when advertised, before mailboxOpen/SELECT.
    clientInfo: { name: 'RemoteKit', version: '1' },
  });
function attachments(node?: MailPart): string[] {
  if (!node) return [];
  const name = node.dispositionParameters?.filename ?? node.parameters?.name;
  const own = name?.toLowerCase().endsWith('.rksi') && node.part ? [node.part] : [];
  return own.concat((node.childNodes ?? []).flatMap(attachments));
}
export type MailDecision = 'delete' | 'keep';
/** Where the next poll resumes: the UID watermark within one UIDVALIDITY, else a date scan. */
export interface MailCursor {
  since: number;
  uidValidity: string | null;
  uid: number | null;
}
export interface MailCursorStore {
  /** Returns the saved cursor, creating one that starts at `now` on first use. */
  load(now: number): MailCursor;
  save(cursor: MailCursor): void;
}
// Tolerates clock skew between this host and the mail server's INTERNALDATE.
const CLOCK_MARGIN_MS = 10 * 60 * 1000;
export class ImportMailbox {
  private readonly skipped = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private client?: MailClient;
  private stopped = false;
  private snapshot: Omit<MailboxStatus, 'outbox'>;
  constructor(
    private readonly config: SessionImportConfig | undefined,
    private readonly keyId: () => string,
    private readonly receive: (batch: Buffer[]) => Promise<MailDecision[]>,
    private readonly cursor: MailCursorStore,
    private readonly factory: MailClientFactory = createMailClient,
    private readonly log: (message: string) => void = console.error,
    private readonly outboxStatus: () => MailboxStatus['outbox'] = () => ({
      pending: 0,
      lastErrorAt: null,
      lastError: null,
    }),
    private readonly now: () => number = Date.now,
  ) {
    this.snapshot = { configured: !!config, lastSuccessAt: null, lastErrorAt: null, lastError: null };
  }
  status(): MailboxStatus {
    return { ...this.snapshot, outbox: this.outboxStatus() };
  }
  start() {
    if (!this.config || this.running || this.timer || this.stopped) return;
    const next = async () => {
      await this.poll();
      if (!this.stopped) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void next();
        }, this.config!.pollSeconds * 1000);
        this.timer.unref();
      }
    };
    void next();
  }
  poll(): Promise<void> {
    if (!this.config || this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.round().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async round() {
    const config = this.config!;
    let client: MailClient | undefined;
    try {
      client = this.factory(config);
      this.client = client;
      let connectionError: Error | undefined;
      client.on('error', (error) => {
        connectionError = error;
      });
      await client.connect();
      if (this.stopped) return;
      const startedAt = this.now();
      const cursor = this.cursor.load(startedAt);
      const mailbox = await client.mailboxOpen(config.folder);
      const validity = String(mailbox.uidValidity);
      const resume = cursor.uidValidity === validity && cursor.uid !== null;
      // Within one UIDVALIDITY only UIDs above the watermark are new. Otherwise (first poll, or the
      // server renumbered) scan by date from the cursor time; SUBJECT/HEADER searches are not
      // used because some providers (NetEase) answer them with nothing.
      let range: string | undefined;
      if (resume) range = `${cursor.uid! + 1}:*`;
      else {
        const uids = await client.search({ since: new Date(cursor.since - CLOCK_MARGIN_MS) }, { uid: true });
        if (uids && uids.length) range = uids.join(',');
      }
      const subject = 'RemoteKit session import to ' + this.keyId();
      let highest = resume ? cursor.uid! : (mailbox.uidNext ?? 1) - 1;
      // Finish FETCH before issuing download or delete commands on the same connection.
      const messages: { uid: number; internalDate: number; bodyStructure?: MailPart }[] = [];
      if (range) {
        for await (const message of client.fetch(
          range,
          { envelope: true, internalDate: true, bodyStructure: true },
          { uid: true },
        )) {
          // `n:*` also returns the newest message when nothing is above n.
          if (resume && message.uid <= cursor.uid!) continue;
          highest = Math.max(highest, message.uid);
          const internalDate = new Date(message.internalDate ?? 0).getTime();
          if (!resume && internalDate < cursor.since - CLOCK_MARGIN_MS) continue;
          if (this.skipped.has(`${validity}:${message.uid}`)) continue;
          if (message.envelope?.subject === subject)
            messages.push({ uid: message.uid, internalDate, bodyStructure: message.bodyStructure });
        }
      }
      // Messages left in the mailbox (a gap in a device stream, an unreadable part) hold the
      // watermark below them so that later polls see them again.
      const kept = new Map<number, number>();
      const batch: { uid: number; bytes: Buffer }[] = [];
      for (const message of messages) {
        if (this.stopped) return;
        const parts = attachments(message.bodyStructure);
        if (!parts.length) {
          await client.messageDelete(message.uid, { uid: true });
          continue;
        }
        let addressed = false;
        let missingContent = false;
        for (const part of parts) {
          const { content } = await client.download(message.uid, part, {
            uid: true,
            maxBytes: MAX_ENVELOPE_BYTES + 1,
          });
          if (!content) {
            missingContent = true;
            continue;
          }
          const buffers: Buffer[] = [];
          let size = 0;
          for await (const data of content) {
            const bytes = Buffer.from(data);
            size += bytes.length;
            buffers.push(bytes);
          }
          const bytes = Buffer.concat(buffers, size);
          const recipient = envelopeKeyId(bytes);
          if (
            (recipient !== undefined && recipient !== this.keyId()) ||
            (bytes.length >= 5 && bytes.subarray(0, 4).toString() === 'RKSI' && bytes[4] !== 2)
          )
            continue;
          addressed = true;
          batch.push({ uid: message.uid, bytes });
        }
        if (missingContent) kept.set(message.uid, message.internalDate);
        else if (!addressed) this.skipped.add(`${validity}:${message.uid}`);
      }
      const decisions = await this.receive(batch.map((m) => m.bytes));
      for (const uid of new Set(batch.map((m) => m.uid))) {
        if (batch.every((m, i) => m.uid !== uid || decisions[i] === 'delete'))
          await client.messageDelete(uid, { uid: true });
        else kept.set(uid, messages.find((m) => m.uid === uid)!.internalDate);
      }
      if (connectionError) throw connectionError;
      await client.logout();
      this.cursor.save({
        since: Math.min(startedAt, ...kept.values()),
        uidValidity: validity,
        uid: kept.size ? Math.min(...kept.keys()) - 1 : highest,
      });
      this.snapshot.lastSuccessAt = this.now();
      this.snapshot.lastError = null;
    } catch (error) {
      if (!this.stopped) {
        const message = error instanceof Error ? error.message : String(error);
        this.snapshot.lastErrorAt = this.now();
        this.snapshot.lastError = message;
        this.log(`Session import mailbox: ${message}`);
      }
    } finally {
      client?.close();
      this.client = undefined;
    }
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.client?.close();
    await this.running;
  }
}
