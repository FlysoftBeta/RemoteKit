import { ImapFlow } from 'imapflow';
import type { Readable } from 'node:stream';
import type { SessionImportConfig } from '../config';
import type { MailboxStatus } from '../../shared/session-import';
import { MAX_ENVELOPE_BYTES } from './envelope';

export interface MailPart {
  part?: string;
  parameters?: Record<string, string>;
  dispositionParameters?: Record<string, string>;
  childNodes?: MailPart[];
}
export interface MailClient {
  connect(): Promise<void>;
  mailboxOpen(folder: string): Promise<{ uidValidity: bigint }>;
  search(query: { subject: string }, options: { uid: true }): Promise<number[] | false | undefined>;
  fetch(
    uids: number[],
    query: { bodyStructure: true },
    options: { uid: true },
  ): AsyncIterable<{ uid: number; bodyStructure?: MailPart }>;
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
export class ImportMailbox {
  private readonly skipped = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private client?: MailClient;
  private stopped = false;
  private snapshot: MailboxStatus;
  constructor(
    private readonly config: SessionImportConfig | undefined,
    private readonly receive: (bytes: Buffer) => Promise<'delete' | 'keep'>,
    private readonly factory: MailClientFactory = createMailClient,
    private readonly log: (message: string) => void = console.error,
  ) {
    this.snapshot = { configured: !!config, lastSuccessAt: null, lastErrorAt: null, lastError: null };
  }
  status(): MailboxStatus {
    return { ...this.snapshot };
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
      const mailbox = await client.mailboxOpen(config.folder);
      const uids = await client.search({ subject: 'RemoteKit session import' }, { uid: true });
      const remaining = (uids || []).filter((uid) => !this.skipped.has(`${mailbox.uidValidity}:${uid}`));
      // Finish FETCH before issuing download or delete commands on the same connection.
      const messages: { uid: number; bodyStructure?: MailPart }[] = [];
      if (remaining.length) {
        for await (const message of client.fetch(remaining, { bodyStructure: true }, { uid: true }))
          messages.push(message);
      }
      for (const message of messages) {
        if (this.stopped) return;
        const parts = attachments(message.bodyStructure);
        if (parts.length !== 1) continue;
        const { content } = await client.download(message.uid, parts[0], {
          uid: true,
          maxBytes: MAX_ENVELOPE_BYTES + 1,
        });
        if (!content) continue;
        const buffers: Buffer[] = [];
        let size = 0;
        for await (const data of content) {
          const bytes = Buffer.from(data);
          size += bytes.length;
          buffers.push(bytes);
        }
        const decision = await this.receive(Buffer.concat(buffers, size));
        if (decision === 'delete') await client.messageDelete(message.uid, { uid: true });
        else this.skipped.add(`${mailbox.uidValidity}:${message.uid}`);
      }
      if (connectionError) throw connectionError;
      await client.logout();
      this.snapshot.lastSuccessAt = Date.now();
    } catch (error) {
      if (!this.stopped) {
        const message = error instanceof Error ? error.message : String(error);
        this.snapshot.lastErrorAt = Date.now();
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
