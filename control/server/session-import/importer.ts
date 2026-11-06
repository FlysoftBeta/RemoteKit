import { generateKeyPairSync } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { RemoteKitError, toRemoteKitError } from '../../shared/errors';
import type {
  ImportChunk,
  ImportDeployment,
  ImportStorage,
  SessionImportState,
  ControlEvent,
} from '../../shared/session-import';
import type { SessionImportConfig } from '../config';
import type { EndpointGateway } from '../endpoint/gateway';
import type { ControlDatabase } from '../persistence/database';
import type { DeviceRow, StoredImport } from '../persistence/session-imports';
import type { AuthAttempts } from '../auth/crypto';
import { systemClock, type Clock } from '../util/clock';
import { openMessage, parseDeviceMessage, publicKeyId, type EventResult } from './envelope';
import { ImportMailbox, type MailClientFactory, type MailDecision } from './mailbox';
import { ImportOutbox, type TransportFactory } from './outbox';
import { checkPair, confirmPair, newPairingCode, PAIR_REJECTED_REASON, type PairCheck } from './pairing';

const MAX_CHUNK_BYTES = 512 * 1024;
export function* importChunks(payload: ImportChunk): Generator<ImportChunk> {
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
export interface DeletedDeviceMail {
  publicKey: Buffer;
  keyId: string;
  ack: number;
  events: ControlEvent[];
}
type Gateway = Pick<EndpointGateway, 'storageImport' | 'storageImportStatus' | 'identity' | 'placement'>;
export class SessionImporter {
  readonly mailbox: ImportMailbox;
  readonly outbox: ImportOutbox;
  private keys?: { publicKey: Buffer; privateKey: Buffer; keyId: string };
  private timer?: ReturnType<typeof setInterval>;
  private readonly running = new Map<string, Promise<void>>();
  private readonly requested = new Set<string>();
  private readonly abort = new AbortController();
  private readonly revokedKeys = new Set<string>();
  private receiving: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly store: ControlDatabase,
    private readonly gateway: Gateway,
    private readonly authAttempts: AuthAttempts,
    private readonly config?: SessionImportConfig,
    factory?: MailClientFactory,
    private readonly clock: Clock = systemClock,
    private readonly log: (message: string) => void = console.error,
    transportFactory?: TransportFactory,
  ) {
    this.outbox = new ImportOutbox(
      store.sessionImports,
      () => this.keyPair(),
      config,
      transportFactory,
      clock,
      log,
    );
    this.mailbox = new ImportMailbox(
      config,
      () => this.keyPair().keyId,
      (batch) => this.receiveBatch(batch),
      {
        load: (now) => store.sessionImports.mailCursor(now),
        save: (cursor) => store.sessionImports.saveMailCursor(cursor),
      },
      factory,
      log,
      () => this.outbox.status(),
      () => clock.wallMs(),
    );
  }
  private keyPair() {
    if (this.keys) return this.keys;
    const saved = this.store.sessionImports.keys();
    if (saved) return (this.keys = saved);
    const pair = generateKeyPairSync('x25519');
    const publicKey = Buffer.from(pair.publicKey.export({ format: 'jwk' }).x!, 'base64url');
    const privateKey = Buffer.from(pair.privateKey.export({ format: 'jwk' }).d!, 'base64url');
    const keyId = publicKeyId(publicKey);
    this.store.sessionImports.saveKeys(publicKey, privateKey, keyId);
    return (this.keys = { publicKey, privateKey, keyId });
  }
  state(tenant: string): SessionImportState {
    return {
      receiving: !!this.config,
      pairing: this.store.sessionImports.pairing(tenant, this.clock.wallMs()),
      devices: this.store.sessionImports.devices(tenant),
      timeline: this.store.sessionImports.timeline(tenant),
    };
  }
  pairing(tenant: string, open: unknown) {
    if (typeof open !== 'boolean') throw new RemoteKitError('invalid_request', '无效的配对开关');
    if (!this.config) throw new RemoteKitError('unavailable', '会话导入邮箱未配置');
    if (open) this.store.sessionImports.openPairing(tenant, newPairingCode(), this.clock.wallMs());
    else this.store.sessionImports.closePairing(tenant, 'user');
    return this.store.sessionImports.pairing(tenant, this.clock.wallMs());
  }
  async deployment(tenant: string, server: string): Promise<ImportDeployment> {
    if (!this.config) throw new RemoteKitError('unavailable', '会话导入邮箱未配置');
    if (!server) throw new RemoteKitError('invalid_request', '缺少 HTTP Host');
    const identity = await this.gateway.identity(tenant);
    const key = this.keyPair();
    return {
      v: 1,
      server,
      mailbox: this.config.mailbox,
      key: { id: key.keyId, x25519: key.publicKey.toString('base64url') },
      browser: { userAgent: identity.userAgent, ...identity.metadata },
    };
  }
  discard(tenant: string, id: unknown) {
    if (typeof id !== 'string') throw new RemoteKitError('invalid_request', '无效的导入 ID');
    const record = this.store.sessionImports.get(id.toLowerCase());
    if (!record || record.tenant !== tenant || record.state !== 'pending')
      throw new RemoteKitError('invalid_request', '只能放弃待写入的导入');
    this.store.transaction(() => {
      const ref = this.store.sessionImports.latestRef(record.keyId, record.id);
      this.store.sessionImports.finish(tenant, record.id, 'discarded', 0, null, this.clock.wallMs());
      this.recordReply(this.store.sessionImports.get(record.id)!, ref);
    });
    return { ok: true as const };
  }
  removeDevice(tenant: string, keyId: unknown) {
    if (typeof keyId !== 'string' || !/^[0-9a-f]{16}$/.test(keyId))
      throw new RemoteKitError('invalid_request', '无效的设备 ID');
    const device = this.store.sessionImports.device(keyId);
    if (!device || device.tenant !== tenant) throw new RemoteKitError('not_found', '设备不存在');
    this.store.transaction(() => {
      for (const record of this.store.sessionImports.pending(tenant).filter((r) => r.keyId === keyId)) {
        const ref = this.store.sessionImports.latestRef(keyId, record.id);
        this.store.sessionImports.finish(tenant, record.id, 'discarded', 0, null, this.clock.wallMs());
        this.recordReply(this.store.sessionImports.get(record.id)!, ref);
      }
      this.store.sessionImports.reply(tenant, keyId, { type: 'revoked' }, this.clock.wallMs());
      this.store.sessionImports.removeDevice(keyId);
    });
    return { ok: true as const };
  }
  deleteUser(tenant: string): DeletedDeviceMail[] {
    const mail: DeletedDeviceMail[] = [];
    for (const summary of this.store.sessionImports.devices(tenant)) {
      const device = this.store.sessionImports.device(summary.keyId)!;
      this.store.sessionImports.reply(tenant, device.keyId, { type: 'revoked' }, this.clock.wallMs());
      mail.push({
        publicKey: device.publicKey,
        keyId: device.keyId,
        ack: device.inSeq,
        events: this.store.sessionImports.unacknowledged(device.keyId),
      });
    }
    this.store.sessionImports.deleteUser(tenant);
    return mail;
  }
  queueDeletedDevices(mail: DeletedDeviceMail[]) {
    for (const device of mail) {
      this.revokedKeys.add(device.keyId);
      this.outbox.enqueue(device.publicKey, device.ack, device.events);
    }
  }
  receiveBatch(batch: Buffer[]): Promise<MailDecision[]> {
    const pending = this.receiving.then(() => this.processBatch(batch));
    this.receiving = pending.catch(() => {});
    return pending;
  }
  private async processBatch(batch: Buffer[]): Promise<MailDecision[]> {
    const decisions: MailDecision[] = batch.map(() => 'delete');
    const groups = new Map<
      string,
      { index: number; publicKey: Buffer; parsed: ReturnType<typeof parseDeviceMessage> }[]
    >();
    const key = this.keyPair();
    for (const [index, bytes] of batch.entries()) {
      try {
        const opened = openMessage(key.privateKey, key.keyId, bytes);
        const parsed = parseDeviceMessage(opened.message);
        const group = groups.get(opened.senderKeyId) ?? [];
        group.push({ index, publicKey: opened.senderPublic, parsed });
        groups.set(opened.senderKeyId, group);
      } catch {
        this.log('Session import discarded: invalid envelope or message');
      }
    }
    const tenants = new Set<string>();
    for (const [keyId, messages] of groups) {
      messages.sort(
        (a, b) => (a.parsed.message.events[0]?.seq ?? 0) - (b.parsed.message.events[0]?.seq ?? 0),
      );
      for (const item of messages) {
        if (this.revokedKeys.has(keyId) || this.store.sessionImports.revoked(keyId)) continue;
        const device = this.store.sessionImports.device(keyId);
        const { message, results } = item.parsed;
        if (device && message.events.length && message.events[0].seq > device.inSeq + 1) {
          decisions[item.index] = 'keep';
          continue;
        }
        const checks = new Map<number, PairCheck>();
        let pairedTenant = device?.tenant;
        try {
          for (const { event } of results) {
            if (device && event.seq <= device.inSeq) continue;
            if (event.type !== 'pair') continue;
            const check = await checkPair(
              this.store,
              this.authAttempts,
              keyId,
              event,
              this.clock.wallMs(),
              pairedTenant,
            );
            checks.set(event.seq, check);
            if (!check.valid) break;
            pairedTenant = check.tenant!;
          }
        } catch (error) {
          const failure = toRemoteKitError(error);
          if (failure.code === 'rate_limited' || failure.code === 'limit_exceeded') {
            decisions[item.index] = 'keep';
            continue;
          }
          throw error;
        }
        this.store.transaction(() => {
          let trusted = this.store.sessionImports.device(keyId);
          if (trusted) this.store.sessionImports.acknowledge(trusted, message.ack, this.clock.wallMs());
          for (const result of results) {
            const event = result.event;
            if (trusted && event.seq <= (device?.inSeq ?? 0)) continue;
            if (event.type === 'pair') {
              const check = checks.get(event.seq)!;
              if (check.tenant && this.store.accounts.loginUser(check.username)?.tenant !== check.tenant)
                check.tenant = null;
              if (check.tenant)
                this.store.sessionImports.incoming(
                  check.tenant,
                  keyId,
                  item.publicKey,
                  event.device,
                  event,
                  this.clock.wallMs(),
                );
              if (!confirmPair(this.store, keyId, check, this.clock.wallMs())) {
                const rejected: Extract<ControlEvent, { type: 'pairRejected' }> = {
                  seq: 0,
                  at: this.clock.wallMs(),
                  type: 'pairRejected',
                  ref: event.seq,
                  reason: PAIR_REJECTED_REASON,
                };
                if (check.tenant) {
                  this.store.sessionImports.pairingFailure(check.tenant);
                  this.store.sessionImports.reply(check.tenant, keyId, rejected, this.clock.wallMs());
                } else this.outbox.reject(item.publicKey, rejected);
                if (trusted) this.store.sessionImports.setInSeq(keyId, event.seq);
                break;
              }
              if (!trusted) {
                this.store.sessionImports.addDevice(
                  keyId,
                  check.tenant!,
                  item.publicKey,
                  event.device,
                  this.clock.wallMs(),
                );
                this.store.sessionImports.closePairing(check.tenant!, 'paired');
                trusted = this.store.sessionImports.device(keyId)!;
              }
              this.store.sessionImports.reply(
                check.tenant!,
                keyId,
                { type: 'paired', ref: event.seq, username: check.username },
                this.clock.wallMs(),
              );
            } else if (trusted) {
              this.store.sessionImports.incoming(
                trusted.tenant,
                keyId,
                item.publicKey,
                trusted.name,
                event,
                this.clock.wallMs(),
              );
              this.processEvent(trusted, result);
            }
            if (trusted) {
              this.store.sessionImports.setInSeq(keyId, event.seq);
              tenants.add(trusted.tenant);
            }
          }
        });
      }
    }
    for (const tenant of tenants) void this.applyTenant(tenant);
    return decisions;
  }
  private processEvent(device: DeviceRow, { event, error }: EventResult) {
    if (event.type === 'pair') return;
    const id = event.id.toLowerCase();
    const existing = this.store.sessionImports.get(id);
    const now = this.clock.wallMs();
    if (existing && existing.keyId !== device.keyId) {
      this.store.sessionImports.reply(
        device.tenant,
        device.keyId,
        { type: 'importFailed', ref: event.seq, id, reason: '导入 ID 冲突', retryable: false },
        now,
      );
      return;
    }
    if (event.type === 'withdraw') {
      if (!existing) return;
      if (existing.state === 'pending')
        this.store.sessionImports.finish(device.tenant, id, 'discarded', 0, null, now);
      this.recordReply(this.store.sessionImports.get(id)!, event.seq);
      return;
    }
    if (event.at < now - 30 * 86400000) error = '导入已超过 30 天';
    if (error) {
      if (!existing || existing.state === 'failed' || existing.state === 'discarded')
        this.store.sessionImports.saveImport(device.tenant, device.keyId, event, now, error);
      this.store.sessionImports.reply(
        device.tenant,
        device.keyId,
        { type: 'importFailed', ref: event.seq, id, reason: error, retryable: false },
        now,
      );
    } else if (existing && (existing.state === 'pending' || existing.state === 'applied')) {
      if (existing.state === 'pending') this.store.sessionImports.rememberRef(device.tenant, id, event.seq);
      this.recordReply(existing, event.seq);
    } else {
      this.store.sessionImports.saveImport(device.tenant, device.keyId, event, now, null);
      this.store.sessionImports.reply(
        device.tenant,
        device.keyId,
        { type: 'importReceived', ref: event.seq, id },
        now,
      );
    }
  }
  private recordReply(record: StoredImport, ref: number) {
    const { tenant, keyId, id } = record;
    const now = this.clock.wallMs();
    if (record.state === 'applied') {
      const applied = this.store.sessionImports.appliedEvent(keyId, id)!;
      this.store.sessionImports.reply(
        tenant,
        keyId,
        { type: 'importApplied', ref, id, cookies: applied.cookies, localStorage: applied.localStorage },
        now,
      );
    } else if (record.state === 'pending')
      this.store.sessionImports.reply(tenant, keyId, { type: 'importReceived', ref, id }, now);
    else if (record.state === 'discarded')
      this.store.sessionImports.reply(tenant, keyId, { type: 'importDiscarded', ref, id }, now);
    else {
      const retryable = record.error === null ? false : this.store.sessionImports.failedRetryable(keyId, id);
      this.store.sessionImports.reply(
        tenant,
        keyId,
        { type: 'importFailed', ref, id, reason: record.error ?? '导入失败', retryable },
        now,
      );
    }
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
    this.store.sessionImports.retain(this.clock.wallMs());
    await Promise.all([
      this.outbox.flush(),
      ...this.store.sessionImports.pendingTenants().map((tenant) => this.applyTenant(tenant)),
    ]);
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
  private active(tenant: string, id: string, ref?: number) {
    return (
      !this.abort.signal.aborted &&
      this.store.sessionImports.isPending(tenant, id) &&
      (ref === undefined ||
        this.store.sessionImports.latestRef(this.store.sessionImports.get(id)!.keyId, id) === ref) &&
      this.gateway.placement.peek(tenant)?.state === 'active'
    );
  }
  private async applyRecords(tenant: string) {
    for (const record of this.store.sessionImports.pending(tenant)) {
      const ref = this.store.sessionImports.latestRef(record.keyId, record.id);
      if (!this.active(tenant, record.id)) return;
      try {
        const payload = this.store.sessionImports.payload(tenant, record.id);
        if (!payload) continue;
        const counts = { cookies: { applied: 0, rejected: 0 }, localStorage: { applied: 0, rejected: 0 } };
        for (const chunk of importChunks(payload)) {
          if (!this.active(tenant, record.id, ref)) return;
          const timeout = new AbortController();
          const signal = AbortSignal.any([timeout.signal, this.abort.signal]);
          const deadline = this.clock.monotonicMs() + 60000;
          try {
            const result = await Promise.race([
              this.applyChunk(tenant, record.id, ref, chunk, deadline),
              sleep(60000, undefined, { signal }).then(() => {
                throw new RemoteKitError('outcome_unknown', '导入等待超时');
              }),
            ]);
            for (const field of ['cookies', 'localStorage'] as const) {
              counts[field].applied += result[field].applied;
              counts[field].rejected += result[field].rejected;
            }
          } finally {
            timeout.abort();
          }
        }
        if (this.active(tenant, record.id, ref))
          this.store.transaction(() => {
            this.store.sessionImports.finish(
              tenant,
              record.id,
              'applied',
              counts.cookies.rejected + counts.localStorage.rejected,
              null,
              this.clock.wallMs(),
            );
            this.store.sessionImports.reply(
              tenant,
              record.keyId,
              { type: 'importApplied', ref, id: record.id, ...counts },
              this.clock.wallMs(),
            );
          });
      } catch (error) {
        if (this.abort.signal.aborted) return;
        const failure = toRemoteKitError(error);
        if (failure.code === 'invalid_request' || failure.code === 'rejected') {
          if (this.active(tenant, record.id, ref))
            this.store.transaction(() => {
              this.store.sessionImports.finish(
                tenant,
                record.id,
                'failed',
                0,
                failure.message,
                this.clock.wallMs(),
              );
              this.store.sessionImports.reply(
                tenant,
                record.keyId,
                {
                  type: 'importFailed',
                  ref,
                  id: record.id,
                  reason: failure.message,
                  retryable: true,
                },
                this.clock.wallMs(),
              );
            });
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
    ref: number,
    chunk: ImportChunk,
    deadline: number,
  ): Promise<Extract<import('../../shared/session-import').StorageImportStatus, { state: 'done' }>> {
    const check = () => {
      if (!this.active(tenant, id, ref) || this.clock.monotonicMs() >= deadline)
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
      if (status.state === 'done') return status;
    }
  }
  async stop() {
    clearInterval(this.timer);
    this.abort.abort();
    await this.mailbox.stop();
    await this.receiving;
    await this.outbox.stop();
    await Promise.allSettled(this.running.values());
  }
}
