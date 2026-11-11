import { log as structuredLog } from '../log';
import { mailError } from './mail-error';
import { errorHandling, retryDelay } from '../../shared/error-policy';
import nodemailer from 'nodemailer';
import type { SendMailOptions } from 'nodemailer';
import type { ControlEvent, ImportMessage, MailboxStatus } from '../../shared/session-import';
import type { SessionImportConfig } from '../config';
import type { SessionImportsRepository, OutgoingEvent } from '../persistence/session-imports';
import { systemClock, type Clock } from '../util/clock';
import { sealMessage, publicKeyId } from './envelope';

export interface MailTransport {
  sendMail(mail: SendMailOptions): Promise<unknown>;
  close?(): void;
}
export type TransportFactory = (config: SessionImportConfig) => MailTransport;
export const createTransport: TransportFactory = (config) =>
  nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    requireTLS: config.smtp.port === 587,
    auth: { user: config.smtp.user, pass: config.smtp.password },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });
type Keys = { privateKey: Buffer; publicKey: Buffer };
interface QueuedEvent {
  publicKey: Buffer;
  event: ControlEvent;
  ack: number;
}
export interface MailEnvelope {
  events: ControlEvent[];
  bytes: Buffer;
}
export function splitMessages(
  keys: Keys,
  recipient: Buffer,
  ack: number,
  events: ControlEvent[],
  seal = sealMessage,
): MailEnvelope[] {
  const result: MailEnvelope[] = [];
  const split = (range: ControlEvent[]) => {
    try {
      const message: ImportMessage<ControlEvent> = { v: 2, ack, events: range };
      result.push({ events: range, bytes: seal(keys.privateKey, keys.publicKey, recipient, message) });
    } catch (error) {
      if (range.length <= 1) throw error;
      const middle = Math.floor(range.length / 2);
      split(range.slice(0, middle));
      split(range.slice(middle));
    }
  };
  let range: ControlEvent[] = [];
  for (const event of events) {
    if (
      range.length &&
      (event.seq === 0 || range[range.length - 1].seq === 0 || event.seq !== range[range.length - 1].seq + 1)
    ) {
      split(range);
      range = [];
    }
    range.push(event);
  }
  if (range.length) split(range);
  return result;
}
export class ImportOutbox {
  private transport?: MailTransport;
  private running?: Promise<void>;
  private stopped = false;
  private blocked = false;
  private errorCode?: import('../../shared/errors').ErrorCode;
  private failures = new Map<string, { attempts: number; retryAt: number }>();
  private volatile: QueuedEvent[] = [];
  private lastErrorAt: number | null = null;
  private lastError: string | null = null;
  constructor(
    private readonly store: SessionImportsRepository,
    private readonly keys: () => Keys,
    private readonly config?: SessionImportConfig,
    private readonly factory: TransportFactory = createTransport,
    private readonly clock: Clock = systemClock,
    private readonly log: (message: string) => void = (message) =>
      structuredLog.warn('session_import.outbox_failed', { message }),
  ) {}
  reject(publicKey: Buffer, event: Extract<ControlEvent, { type: 'pairRejected' }>) {
    this.enqueue(publicKey, 0, [event]);
  }
  enqueue(publicKey: Buffer, ack: number, events: ControlEvent[]) {
    this.volatile.push(...events.map((event) => ({ publicKey, ack, event })));
  }
  status(): MailboxStatus['outbox'] {
    return {
      pending: this.store.outgoing().length + this.volatile.length,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
      errorCode: this.errorCode,
    };
  }
  flush(): Promise<void> {
    if (!this.config || this.stopped || this.blocked) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.send().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async send() {
    const groups = new Map<string, { publicKey: Buffer; stored: OutgoingEvent[]; memory: QueuedEvent[] }>();
    for (const row of this.store.outgoing()) {
      let group = groups.get(row.keyId);
      if (!group) {
        const publicKey = this.store.recipient(row.keyId);
        if (!publicKey) continue;
        group = { publicKey, stored: [], memory: [] };
        groups.set(row.keyId, group);
      }
      group.stored.push(row);
    }
    for (const item of this.volatile) {
      const keyId = publicKeyId(item.publicKey);
      if (!groups.has(keyId)) groups.set(keyId, { publicKey: item.publicKey, stored: [], memory: [] });
      groups.get(keyId)!.memory.push(item);
    }
    for (const [keyId, group] of groups) {
      if (this.stopped) return;
      const events = [...group.stored.map((r) => r.event), ...group.memory.map((r) => r.event)];
      const now = this.clock.wallMs();
      const oldest = Math.min(...events.map((e) => e.at)),
        newest = Math.max(...events.map((e) => e.at));
      if (now - newest < this.config!.replyWindowSeconds * 1000 && now - oldest < 300000) continue;
      if ((this.failures.get(keyId)?.retryAt ?? 0) > now) continue;
      try {
        this.transport ??= this.factory(this.config!);
        const device = this.store.device(keyId);
        // A removed device's final reply still acknowledges its committed request range.
        const ack =
          device?.inSeq ?? Math.max(this.store.lastInSeq(keyId), ...group.memory.map((item) => item.ack));
        for (const envelope of splitMessages(this.keys(), group.publicKey, ack, events)) {
          if (this.stopped) return;
          await this.transport.sendMail({
            from: this.config!.mailbox,
            to: this.config!.appMailbox,
            subject: 'RemoteKit session import to ' + keyId,
            headers: { 'X-RemoteKit-Import': '2' },
            text: 'RemoteKit session import events. Open this message with the RemoteKit app.',
            attachments: [
              {
                filename: 'message.rksi',
                content: envelope.bytes,
                contentType: 'application/octet-stream',
                contentTransferEncoding: 'base64',
              },
            ],
          });
          const sentAt = this.clock.wallMs();
          for (const row of group.stored)
            if (envelope.events.includes(row.event)) this.store.mailed(row, sentAt);
          const sent = new Set(group.memory.filter((r) => envelope.events.includes(r.event)));
          this.volatile = this.volatile.filter((r) => !sent.has(r));
        }
        this.failures.delete(keyId);
        if (!this.failures.size) this.lastError = null;
      } catch (error) {
        const attempts = (this.failures.get(keyId)?.attempts ?? 0) + 1;
        const failure = mailError(error, true);
        this.errorCode = failure.code;
        const wait = retryDelay(failure, attempts - 1);
        this.blocked = wait === undefined && errorHandling(failure.code) !== 'reconcile';
        this.failures.set(keyId, { attempts, retryAt: now + (wait ?? 60_000) });
        this.lastErrorAt = this.clock.wallMs();
        this.lastError = failure.message;
        this.log('Session import outbox: ' + this.lastError);
      }
    }
  }
  async stop() {
    this.stopped = true;
    this.transport?.close?.();
    await this.running;
  }
}
