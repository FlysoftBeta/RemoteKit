import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { LearningAccount, LearningProvider } from '../../shared/learning';
import { RemoteKitError } from '../../shared/errors';
import type { ControlDatabase } from '../persistence/database';
import { KeyedSerialQueue } from '../util/serial-queue';
import { AuthClient, type AccountSession } from './providers/changyan/auth';
import { ZhixueAuthClient } from './providers/changyan/zhixue-auth';
import type { XinjiaoyuSession } from './providers/xinjiaoyu/client';
import type { ProviderResult } from './providers/models';

export interface Sessions {
  changyan: AccountSession;
  xinjiaoyu: XinjiaoyuSession;
}
interface AccountRow {
  sealed: string;
  display_name: string;
  username: string;
  status: string;
  updated_at: bigint;
}

export class LearningAccounts {
  private readonly key: Buffer;
  private readonly transient = new Map<string, LearningAccount>();
  private readonly queues = new KeyedSerialQueue();
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly store: ControlDatabase,
    private readonly changed: (tenant: string) => void,
    readonly auth = new AuthClient(),
    readonly zhixueAuth = new ZhixueAuthClient(),
    masterKey?: Buffer,
    private readonly now = Date.now,
  ) {
    // The persistent Control key is also used by FaceVault and session-import keys.
    if (!masterKey && store.db.name && store.db.name !== ':memory:') {
      store.atRestKey.seal('learning-key-initialization', Buffer.alloc(0));
      masterKey = readFileSync(store.db.name + '.key');
    }
    this.key = Buffer.from(
      hkdfSync(
        'sha256',
        masterKey ?? randomBytes(32),
        Buffer.alloc(0),
        'remotekit learning account key 1',
        32,
      ),
    );
  }

  private identity(tenant: string, provider: LearningProvider) {
    return JSON.stringify([tenant, provider]);
  }
  private row(tenant: string, provider: LearningProvider) {
    return this.store.db
      .prepare('SELECT * FROM learning_accounts WHERE tenant=? AND provider=?')
      .get(tenant, provider) as AccountRow | undefined;
  }
  state(tenant: string, provider: LearningProvider): LearningAccount {
    const pending = this.transient.get(this.identity(tenant, provider));
    if (pending) return structuredClone(pending);
    const row = this.row(tenant, provider);
    if (!row) return { status: 'signed_out' };
    if (row.status === 'expired') return { status: 'expired', displayName: row.display_name };
    return { status: 'signed_in', displayName: row.display_name, since: Number(row.updated_at) };
  }
  setState(tenant: string, provider: LearningProvider, state?: LearningAccount) {
    const key = this.identity(tenant, provider);
    if (state) this.transient.set(key, state);
    else this.transient.delete(key);
    this.changed(tenant);
  }
  generation(tenant: string, provider: LearningProvider) {
    return this.generations.get(this.identity(tenant, provider)) ?? 0;
  }
  session<P extends LearningProvider>(tenant: string, provider: P): Sessions[P] {
    const row = this.row(tenant, provider);
    if (!row || row.status !== 'signed_in') throw new RemoteKitError('unauthenticated', '请先登录学习账号');
    const bytes = Buffer.from(row.sealed, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(this.identity(tenant, provider)));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
  }
  save<P extends LearningProvider>(
    tenant: string,
    provider: P,
    session: Sessions[P],
    displayName?: string,
    username?: string,
  ) {
    const previous = this.row(tenant, provider);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(this.identity(tenant, provider)));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(session)), cipher.final()]);
    const sealed = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    this.store.db
      .prepare(
        `INSERT INTO learning_accounts VALUES (?,?,?,?,?,'signed_in',?)
      ON CONFLICT(tenant,provider) DO UPDATE SET sealed=excluded.sealed,
      display_name=excluded.display_name,username=excluded.username,status='signed_in',updated_at=excluded.updated_at`,
      )
      .run(
        tenant,
        provider,
        sealed,
        displayName ?? previous?.display_name ?? '新教育',
        username ?? previous?.username ?? '',
        displayName === undefined && previous ? previous.updated_at : this.now(),
      );
  }
  async use<P extends LearningProvider, T>(
    tenant: string,
    provider: P,
    read: (session: Sessions[P]) => Promise<ProviderResult<T, Sessions[P]>>,
  ): Promise<T> {
    const generation = this.generation(tenant, provider);
    return this.queues.run(this.identity(tenant, provider), async () => {
      let session = this.session(tenant, provider);
      const current = () => {
        if (this.generation(tenant, provider) !== generation)
          throw new RemoteKitError('unauthenticated', '学习账号已退出');
      };
      try {
        let result: ProviderResult<T, Sessions[P]>;
        if (provider === 'changyan') {
          session = (await this.auth.ensureFresh(session as AccountSession)) as Sessions[P];
          session = (await this.zhixueAuth.ensureFresh(session as AccountSession)) as Sessions[P];
        }
        try {
          result = await read(session);
        } catch (error) {
          if (
            !(error instanceof RemoteKitError) ||
            error.code !== 'unauthenticated' ||
            provider !== 'changyan'
          )
            throw error;
          session = (await this.zhixueAuth.renew(
            await this.auth.renew(session as AccountSession),
          )) as Sessions[P];
          result = await read(session);
        }
        current();
        this.save(tenant, provider, result.session);
        return result.data;
      } catch (error) {
        current();
        if (error instanceof RemoteKitError && error.code === 'unauthenticated') {
          this.store.db
            .prepare("UPDATE learning_accounts SET status='expired' WHERE tenant=? AND provider=?")
            .run(tenant, provider);
          this.setState(tenant, provider);
        }
        throw error;
      }
    });
  }
  delete(tenant: string, provider: LearningProvider) {
    const key = this.identity(tenant, provider);
    this.generations.set(key, this.generation(tenant, provider) + 1);
    this.store.db
      .prepare('DELETE FROM learning_accounts WHERE tenant=? AND provider=?')
      .run(tenant, provider);
    this.setState(tenant, provider);
  }
  signedInTenants(): string[] {
    return (
      this.store.db
        .prepare("SELECT tenant FROM learning_accounts WHERE provider='changyan' AND status='signed_in'")
        .all() as { tenant: string }[]
    ).map((row) => row.tenant);
  }
}
