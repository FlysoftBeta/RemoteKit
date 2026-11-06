import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import type { BrowserIdentity, ImportPayload } from '../shared/session-import';
import type { SessionImportConfig } from '../server/config';
import type { MailClient, MailPart } from '../server/session-import/mailbox';
import { hpkeSeal } from '../server/session-import/hpke';

export const importConfig: SessionImportConfig = {
  mailbox: 'import@example.com',
  imap: { host: 'imap.example.com', port: 993, user: 'user', password: 'secret' },
  folder: 'INBOX',
  pollSeconds: 60,
};
export const browserIdentity: BrowserIdentity = {
  userAgent: 'RemoteKit Test UA',
  metadata: {
    platform: 'Windows',
    platformVersion: '19.0.0',
    architecture: 'x86',
    bitness: '64',
    wow64: false,
    model: '',
    mobile: false,
    brands: [{ brand: 'Chromium', version: '157' }],
    fullVersionList: [{ brand: 'Chromium', version: '157.0.0.0' }],
  },
};
export function importPayload(overrides: Partial<ImportPayload> = {}): ImportPayload {
  return {
    v: 1,
    id: randomUUID(),
    createdAt: Date.now(),
    username: 'import-user',
    password: 'import-password',
    device: '测试手机',
    sites: [
      { name: '测试站点', url: 'https://example.com/account' },
      { name: '测试论坛', url: 'https://forum.example.org/' },
    ],
    cookies: [
      {
        name: 'SID',
        value: 'secret',
        domain: '.example.com',
        path: '/',
        hostOnly: false,
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        expires: null,
      },
    ],
    localStorage: [{ origin: 'https://example.com', items: [['key', 'value']] }],
    ...overrides,
  };
}
export function uncheckedEnvelope(publicKey: Buffer, keyId: string, payload: unknown) {
  const header = Buffer.concat([Buffer.from('RKSI'), Buffer.from([1]), Buffer.from(keyId, 'hex')]);
  const result = hpkeSeal(
    publicKey,
    Buffer.from('RemoteKit session import v1'),
    header,
    gzipSync(Buffer.from(JSON.stringify(payload))),
  );
  return Buffer.concat([header, result.enc, result.ciphertext]);
}
export class FakeMailClient implements MailClient {
  readonly calls: string[] = [];
  readonly deleted: number[] = [];
  uidValidity = 1n;
  failure?: Error;
  messages = new Map<number, { bytes: Buffer; bodyStructure?: MailPart }>();
  errorListener?: (error: Error) => void;
  add(uid: number, bytes: Buffer) {
    this.messages.set(uid, {
      bytes,
      bodyStructure: {
        childNodes: [
          { part: '1', dispositionParameters: { filename: 'plain.txt' } },
          { childNodes: [{ part: '2.1', dispositionParameters: { filename: 'import.rksi' } }] },
        ],
      },
    });
  }
  async connect() {
    this.calls.push('connect');
    if (this.failure) throw this.failure;
  }
  async mailboxOpen(folder: string) {
    this.calls.push('select:' + folder);
    return { uidValidity: this.uidValidity };
  }
  async search(query: { subject: string }, options: { uid: true }) {
    this.calls.push('search:' + query.subject + ':' + options.uid);
    return [...this.messages.keys()];
  }
  async *fetch(uids: number[], _query: { bodyStructure: true }, options: { uid: true }) {
    this.calls.push('fetch:' + options.uid);
    for (const uid of uids) {
      this.calls.push('fetch:' + uid);
      yield { uid, bodyStructure: this.messages.get(uid)!.bodyStructure };
    }
    this.calls.push('fetch:done');
  }
  async download(uid: number, part: string, options: { uid: true; maxBytes: number }) {
    this.calls.push(`download:${uid}:${part}:${options.uid}`);
    return { content: Readable.from([this.messages.get(uid)!.bytes.subarray(0, options.maxBytes)]) };
  }
  async messageDelete(uid: number, options: { uid: true }) {
    this.calls.push('delete:' + uid + ':' + options.uid);
    this.deleted.push(uid);
    this.messages.delete(uid);
  }
  async logout() {
    this.calls.push('logout');
  }
  close() {
    this.calls.push('close');
  }
  on(_event: 'error', listener: (error: Error) => void) {
    this.errorListener = listener;
  }
}
