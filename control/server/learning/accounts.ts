import {
  learningKey,
  learningKeyInfo,
  openLearningSession,
  sealLearningSession,
} from '../persistence/sealed-documents';
import type { LearningAccount, LearningProvider } from '../../shared/learning';
import { RemoteKitError } from '../../shared/errors';
import type { ControlDatabase } from '../persistence/database';
import { KeyedSerialQueue } from '../util/serial-queue';
import { AuthClient, type AccountSession } from './providers/changyan/auth';
import { ZhixueAuthClient } from './providers/changyan/zhixue-auth';
import type { XinjiaoyuSession } from './providers/xinjiaoyu/client';
import type { ProviderResult } from './providers/models';
import { learningError } from './errors';

export interface Sessions {
  changyan: AccountSession;
  xinjiaoyu: XinjiaoyuSession;
}
type AccountRow = {
  display_name: string;
  username: string;
  updated_at: bigint;
} & ({ status: 'signed_in'; sealed: string } | { status: 'expired'; sealed: string | null });

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
    if (masterKey) {
      this.key = learningKey(masterKey);
    } else {
      store.atRestKey.seal('learning-key-initialization', Buffer.alloc(0));
      this.key = store.atRestKey.derive(learningKeyInfo);
    }
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
    if (!row || row.status !== 'signed_in') throw new RemoteKitError('forbidden', '请先登录学习账号');
    return openLearningSession(this.key, tenant, provider, row.sealed);
  }
  save<P extends LearningProvider>(
    tenant: string,
    provider: P,
    session: Sessions[P],
    displayName?: string,
    username?: string,
  ) {
    const previous = this.row(tenant, provider);
    const sealed = sealLearningSession(this.key, tenant, provider, session);
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
          throw new RemoteKitError('forbidden', '学习账号已退出');
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
          this.delete(tenant, provider);
        }
        throw learningError(error);
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
