import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { RemoteKitError, toRemoteKitError } from '../../shared/errors';
import type {
  ImportChunk,
  ImportPayload,
  ImportStorage,
  SessionImportState,
} from '../../shared/session-import';
import type { SessionImportConfig } from '../config';
import type { EndpointGateway } from '../endpoint/gateway';
import type { ControlDatabase } from '../persistence/database';
import { systemClock, type Clock } from '../util/clock';
import { envelopeKeyId, ImportLimitError, openEnvelope } from './envelope';
import { ImportMailbox, type MailClientFactory } from './mailbox';
import { buildPairingCode } from './pairing';

const MAX_CHUNK_BYTES = 512 * 1024;
const hashToken = (token: string) =>
  createHash('sha256').update(Buffer.from(token, 'base64url')).digest('hex');
export function* importChunks(payload: ImportPayload): Generator<ImportChunk> {
  let chunk: ImportChunk = { cookies: [], localStorage: [] };
  let size = Buffer.byteLength(JSON.stringify(chunk));
  for (const cookie of payload.cookies) {
    const bytes = Buffer.byteLength(JSON.stringify(cookie)) + (chunk.cookies.length ? 1 : 0);
    if (size + bytes > MAX_CHUNK_BYTES) {
      if (!chunk.cookies.length && !chunk.localStorage.length)
        throw new RemoteKitError('invalid_request', 'Cookie 超过分块大小');
      yield chunk;
      chunk = { cookies: [], localStorage: [] };
      size = Buffer.byteLength(JSON.stringify(chunk));
    }
    chunk.cookies.push(cookie);
    size = Buffer.byteLength(JSON.stringify(chunk));
    if (size > MAX_CHUNK_BYTES) throw new RemoteKitError('invalid_request', 'Cookie 超过分块大小');
  }
  for (const storage of payload.localStorage) {
    for (const item of storage.items) {
      let group: ImportStorage | undefined = chunk.localStorage[chunk.localStorage.length - 1];
      let added = Buffer.byteLength(JSON.stringify(item));
      if (group?.origin === storage.origin) added += group.items.length ? 1 : 0;
      else
        added +=
          Buffer.byteLength(JSON.stringify({ origin: storage.origin, items: [] })) +
          (chunk.localStorage.length ? 1 : 0);
      if (size + added > MAX_CHUNK_BYTES) {
        if (!chunk.cookies.length && !chunk.localStorage.length)
          throw new RemoteKitError('invalid_request', '来源超过分块大小');
        yield chunk;
        chunk = { cookies: [], localStorage: [] };
        size = Buffer.byteLength(JSON.stringify(chunk));
        group = undefined;
      }
      if (group?.origin !== storage.origin) {
        group = { origin: storage.origin, items: [] };
        chunk.localStorage.push(group);
        size += Buffer.byteLength(JSON.stringify(group)) + (chunk.localStorage.length > 1 ? 1 : 0);
      }
      size += Buffer.byteLength(JSON.stringify(item)) + (group.items.length ? 1 : 0);
      group.items.push(item);
      if (size > MAX_CHUNK_BYTES) throw new RemoteKitError('invalid_request', '来源超过分块大小');
    }
  }
  if (chunk.cookies.length || chunk.localStorage.length) yield chunk;
}
type Gateway = Pick<EndpointGateway, 'storageImport' | 'storageImportStatus' | 'identity' | 'placement'>;
export class SessionImporter {
  readonly mailbox: ImportMailbox;
  private keys?: { publicKey: Buffer; privateKey: Buffer; keyId: string };
  private timer?: ReturnType<typeof setInterval>;
  private readonly running = new Map<string, Promise<void>>();
  private readonly requested = new Set<string>();
  private readonly abort = new AbortController();
  constructor(
    private readonly store: ControlDatabase,
    private readonly gateway: Gateway,
    private readonly config?: SessionImportConfig,
    factory?: MailClientFactory,
    private readonly clock: Clock = systemClock,
    private readonly log: (message: string) => void = console.error,
  ) {
    this.mailbox = new ImportMailbox(config, (bytes) => this.receive(bytes), factory, log);
  }
  private keyPair() {
    if (this.keys) return this.keys;
    const saved = this.store.sessionImports.keys();
    if (saved) return (this.keys = saved);
    const pair = generateKeyPairSync('x25519');
    const publicKey = Buffer.from(pair.publicKey.export({ format: 'jwk' }).x!, 'base64url');
    const privateKey = Buffer.from(pair.privateKey.export({ format: 'jwk' }).d!, 'base64url');
    const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
    this.store.sessionImports.saveKeys(publicKey, privateKey, keyId);
    return (this.keys = { publicKey, privateKey, keyId });
  }
  state(tenant: string): SessionImportState {
    const user = this.user(tenant);
    return {
      mailbox: this.mailbox.status(),
      pairing: this.store.sessionImports.pairing(user.id),
      imports: this.store.sessionImports.list(tenant),
    };
  }
  private user(tenant: string) {
    const user = this.store.accounts.userForTenant(tenant);
    if (!user) throw new RemoteKitError('not_found', '用户不存在');
    return user;
  }
  async pair(tenant: string, server: string, authorize: () => void = () => {}) {
    if (!this.config) throw new RemoteKitError('unavailable', '会话导入邮箱未配置');
    if (!server) throw new RemoteKitError('invalid_request', '缺少 HTTP Host');
    const identity = await this.gateway.identity(tenant);
    authorize();
    const user = this.user(tenant);
    const key = this.keyPair();
    const token = randomBytes(32).toString('base64url');
    const createdAt = this.clock.wallMs();
    this.store.sessionImports.pair(user.id, hashToken(token), createdAt);
    return {
      code: buildPairingCode({
        v: 1,
        server,
        user: user.username,
        mailbox: this.config.mailbox,
        key: { id: key.keyId, x25519: key.publicKey.toString('base64url') },
        token,
        browser: { userAgent: identity.userAgent, ...identity.metadata },
      }),
      createdAt,
    };
  }
  unpair(tenant: string) {
    this.store.sessionImports.unpair(this.user(tenant).id);
    return { ok: true };
  }
  delete(tenant: string, id: unknown) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))
      throw new RemoteKitError('invalid_request', '无效的导入 ID');
    this.store.sessionImports.delete(tenant, id.toLowerCase());
    return { ok: true };
  }
  async receive(bytes: Buffer): Promise<'delete' | 'keep'> {
    const key = this.keyPair();
    if (envelopeKeyId(bytes) !== key.keyId) return 'keep';
    let payload: ImportPayload;
    let rejection: string | undefined;
    try {
      payload = openEnvelope(key.privateKey, key.keyId, bytes);
    } catch (error) {
      if (error instanceof ImportLimitError) {
        payload = error.payload;
        rejection = error.message;
      } else {
        this.log('Session import discarded: invalid envelope or payload');
        return 'delete';
      }
    }
    const tenant = this.store.sessionImports.recipient(hashToken(payload.token));
    if (!tenant) {
      this.log('Session import discarded: unknown pairing token');
      return 'delete';
    }
    const id = payload.id.toLowerCase();
    if (this.store.sessionImports.exists(id)) return 'delete';
    const now = this.clock.wallMs();
    if (payload.createdAt < now - 30 * 86400000) rejection = '导入已超过 30 天';
    else if (payload.createdAt > now + 10 * 60000) rejection = '生成时间晚于当前时间 10 分钟';
    this.store.transaction(() => this.store.sessionImports.insert(tenant, payload, now, rejection));
    if (!rejection) void this.applyTenant(tenant);
    return 'delete';
  }
  start() {
    if (!this.config || this.timer || this.abort.signal.aborted) return;
    this.mailbox.start();
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, 15000);
    this.timer.unref();
  }
  async tick() {
    if (this.abort.signal.aborted) return;
    await Promise.all(this.store.sessionImports.pendingTenants().map((tenant) => this.applyTenant(tenant)));
  }
  private applyTenant(tenant: string): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();
    this.requested.add(tenant);
    const current = this.running.get(tenant);
    if (current) return current;
    const run = async () => {
      try {
        do {
          this.requested.delete(tenant);
          await this.applyRecords(tenant);
        } while (!this.abort.signal.aborted && this.requested.has(tenant));
      } catch (error) {
        if (!this.abort.signal.aborted) this.log(`Session import apply: ${toRemoteKitError(error).code}`);
      } finally {
        this.requested.delete(tenant);
        this.running.delete(tenant);
      }
    };
    const pending = run();
    this.running.set(tenant, pending);
    return pending;
  }
  private active(tenant: string, id: string) {
    return (
      !this.abort.signal.aborted &&
      this.store.sessionImports.isPending(tenant, id) &&
      this.gateway.placement.peek(tenant)?.state === 'active'
    );
  }
  private async applyRecords(tenant: string) {
    for (const record of this.store.sessionImports.pending(tenant)) {
      if (!this.active(tenant, record.id)) return;
      try {
        const payload = this.store.sessionImports.payload(tenant, record.id);
        if (!payload) continue;
        let rejected = 0;
        for (const chunk of importChunks(payload)) {
          if (!this.active(tenant, record.id)) return;
          const timeout = new AbortController();
          const signal = AbortSignal.any([timeout.signal, this.abort.signal]);
          const deadline = this.clock.monotonicMs() + 60000;
          try {
            rejected += await Promise.race([
              this.applyChunk(tenant, record.id, chunk, deadline),
              sleep(60000, undefined, { signal }).then(() => {
                throw new RemoteKitError('outcome_unknown', '导入等待超时');
              }),
            ]);
          } finally {
            timeout.abort();
          }
        }
        if (this.active(tenant, record.id))
          this.store.sessionImports.finish(tenant, record.id, 'applied', rejected, null, this.clock.wallMs());
      } catch (error) {
        if (this.abort.signal.aborted) return;
        const failure = toRemoteKitError(error);
        if (failure.code === 'invalid_request' || failure.code === 'rejected') {
          this.store.sessionImports.finish(
            tenant,
            record.id,
            'failed',
            0,
            failure.message,
            this.clock.wallMs(),
          );
        } else {
          this.log(`Session import remains pending: ${failure.code}`);
          return;
        }
      }
    }
  }
  private async applyChunk(
    tenant: string,
    id: string,
    chunk: ImportChunk,
    deadline: number,
  ): Promise<number> {
    const check = () => {
      if (!this.active(tenant, id) || this.clock.monotonicMs() >= deadline)
        throw new RemoteKitError('outcome_unknown', '导入等待中');
    };
    check();
    const job = await this.gateway.storageImport(tenant, chunk);
    for (;;) {
      check();
      await sleep(200, undefined, { signal: this.abort.signal });
      check();
      const status = await this.gateway.storageImportStatus(tenant, {
        job: job.job,
        browserIncarnation: job.browserIncarnation,
      });
      check();
      if (status.state === 'done') return status.cookies.rejected + status.localStorage.rejected;
    }
  }
  async stop() {
    clearInterval(this.timer);
    this.abort.abort();
    await this.mailbox.stop();
    await Promise.allSettled(this.running.values());
  }
}
