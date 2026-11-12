import { RemoteKitError, wireError } from '../../shared/errors';
import type { BankQuery, LearningSocketMethods, LearningState, MaterialType } from '../../shared/learning';
import type { DomainContext, DomainServices } from '../application';
import { log } from '../log';
import { assertWindowMutable, findWindow } from '../workspace/model';
import { closeSignInTab, openSignInTab } from '../workspace/sign-in';
import { LearningAccounts } from './accounts';
import { BankService } from './bank-service';
import { MediaProxy } from './media-proxy';
import { XinjiaoyuProvider } from './providers/xinjiaoyu/resources';
import { SignIn } from './sign-in';
import { StudyService } from './study-service';
import { StudySync } from './study-sync';

export const learningMethods = [
  'learning.signIn',
  'learning.signInCancel',
  'learning.signOut',
  'study.settings',
  'study.sync',
  'study.homework.list',
  'study.homework.detail',
  'study.subjects',
  'study.materials.list',
  'study.attachment.save',
  'bank.subjects',
  'bank.subject',
  'bank.catalog',
  'bank.questions',
  'document.progress.get',
  'document.progress.set',
] as const satisfies readonly (keyof LearningSocketMethods)[];

function string(value: unknown): string {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value))
    throw new RemoteKitError('invalid_request', '无效的学习参数');
  if (value.length > 1024)
    throw new RemoteKitError('limit_exceeded', '学习参数超过长度限制', { capacity: 'field' });
  return value;
}
function page(value: unknown, max = 100_000): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    throw new RemoteKitError('invalid_request', '无效的页码或数量');
  if (value > max)
    throw new RemoteKitError('limit_exceeded', '页码或数量超过限制', { capacity: 'selection' });
  return value;
}
function choice<T extends string>(value: unknown, options: readonly T[]): T {
  if (!options.includes(value as T)) throw new RemoteKitError('invalid_request', '无效的学习选项');
  return value as T;
}
function strings(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new RemoteKitError('invalid_request', '无效筛选条件');
  if (value.length > 100)
    throw new RemoteKitError('limit_exceeded', '筛选条件超过数量限制', { capacity: 'selection' });
  return value.map(string);
}

export class LearningService {
  readonly accounts: LearningAccounts;
  readonly signIn: SignIn;
  readonly sync: StudySync;
  readonly media: MediaProxy;
  private readonly studies = new Map<string, StudyService>();
  private readonly banks = new Map<string, BankService>();
  private readonly providers = new Map<string, XinjiaoyuProvider>();
  constructor(
    private readonly context: DomainContext,
    private readonly services: Pick<DomainServices, 'viewers' | 'library' | 'objects' | 'operations'>,
  ) {
    const changed = (tenant: string) => {
      if (
        !context.closed &&
        context.tenants.get(tenant).viewer &&
        context.store.accounts.userForTenant(tenant)
      )
        services.viewers.push(tenant);
    };
    this.accounts = new LearningAccounts(context.store, changed, undefined, undefined, undefined, () =>
      context.clock.wallMs(),
    );
    this.media = new MediaProxy(
      undefined,
      () => context.clock.wallMs(),
      (tenant, provider): Record<string, string> => {
        if (provider === 'changyan') return {};
        const session = this.accounts.session(tenant, provider);
        return session.userAgent ? { 'user-agent': session.userAgent } : {};
      },
    );
    this.sync = new StudySync(
      context.store,
      this.accounts,
      services.library,
      services.objects,
      (tenant) => this.study(tenant),
      changed,
      () => context.clock.wallMs(),
    );
    this.signIn = new SignIn(
      this.accounts,
      {
        validate: (tenant, provider, windowId) => {
          const state = context.store.workspaces.workspace(tenant);
          assertWindowMutable(state, windowId);
          if (findWindow(state, windowId).appId !== (provider === 'changyan' ? 'study' : 'questions'))
            throw new RemoteKitError('invalid_request', '请在对应的学习窗口中登录');
        },
        open: (tenant, provider, windowId, url) =>
          context.tenants.serial(tenant, async () => {
            const state = context.store.workspaces.workspace(tenant);
            const tab = openSignInTab(state, provider, windowId, url, context.store.workspaces.viewId());
            services.operations.saveWorkspace(state);
            return tab;
          }),
        close: (tenant, id) =>
          context.tenants.serial(tenant, async () => {
            if (!context.store.accounts.userForTenant(tenant)) return;
            const state = context.store.workspaces.workspace(tenant);
            const tab = closeSignInTab(state, id);
            if (!tab) return;
            services.operations.saveWorkspace(state);
            await context.endpoint
              .closeView(tenant, { viewId: tab.webviewId, force: true })
              .catch((err) => log.warn('learning.close_view_failed', { tenant, viewId: tab.webviewId, err }));
          }),
      },
      (tenant) => this.provider(tenant),
      (tenant, provider) => {
        if (provider === 'changyan') {
          this.studies.delete(tenant);
          this.sync.sync(tenant);
        } else this.banks.delete(tenant);
        changed(tenant);
      },
    );
    services.library.onDeleted = (tenant, ids) => this.sync.dismiss(tenant, ids);
    services.library.onChanged = (tenant, snapshot) => context.events.emit('library', tenant, snapshot);
    // Sign-in views cannot be restored from an interrupted Control process.
    for (const tenant of context.store.workspaces.all()) {
      const state = context.store.workspaces.workspace(tenant);
      for (const tab of [...state.tabs])
        if (tab.signIn) {
          closeSignInTab(state, tab.id);
          this.accounts.setState(tenant, tab.signIn, {
            status: 'failed',
            error: wireError(new RemoteKitError('rejected', '登录已中断')),
          });
        }
      context.store.workspaces.saveWorkspace(state);
    }
  }
  state(tenant: string): LearningState {
    return {
      accounts: {
        changyan: this.accounts.state(tenant, 'changyan'),
        xinjiaoyu: this.accounts.state(tenant, 'xinjiaoyu'),
      },
      study: this.sync.state(tenant),
    };
  }
  private provider(tenant: string) {
    let provider = this.providers.get(tenant);
    if (!provider) {
      provider = new XinjiaoyuProvider();
      this.providers.set(tenant, provider);
    }
    return provider;
  }
  private study(tenant: string) {
    let study = this.studies.get(tenant);
    if (!study) {
      study = new StudyService(tenant, this.accounts, this.media, (key) => this.sync.saved(tenant, key));
      this.studies.set(tenant, study);
    }
    return study;
  }
  private bank(tenant: string) {
    let bank = this.banks.get(tenant);
    if (!bank) {
      bank = new BankService(tenant, this.accounts, this.media, this.provider(tenant));
      this.banks.set(tenant, bank);
    }
    return bank;
  }
  async request(tenant: string, method: string, params: Record<string, any>) {
    switch (method) {
      case 'learning.signIn': {
        const provider = choice(params.provider, ['changyan', 'xinjiaoyu']);
        return this.signIn.start(
          tenant,
          provider === 'changyan'
            ? {
                provider,
                windowId: string(params.windowId),
                username: params.username,
                password: params.password,
              }
            : { provider, windowId: string(params.windowId) },
        );
      }
      case 'learning.signInCancel':
        return this.signIn.cancel(tenant, choice(params.provider, ['changyan', 'xinjiaoyu']));
      case 'learning.signOut': {
        const provider = choice(params.provider, ['changyan', 'xinjiaoyu']);
        await this.signIn.cancel(tenant, provider);
        this.accounts.delete(tenant, provider);
        if (provider === 'changyan') {
          await this.sync.stopTenant(tenant);
          this.studies.delete(tenant);
        } else {
          this.banks.delete(tenant);
          this.providers.delete(tenant);
        }
        return { signedOut: true };
      }
      case 'study.settings':
        return this.sync.settings(tenant, params.retentionDays);
      case 'study.sync':
        return this.sync.sync(tenant);
      case 'study.subjects':
        return this.study(tenant).subjects();
      case 'study.homework.list':
        return this.study(tenant).list({
          bucket: choice(params.bucket, ['active', 'completed']),
          page: page(params.page),
          subjectCode: params.subjectCode === undefined ? undefined : string(params.subjectCode),
        });
      case 'study.homework.detail':
        return this.study(tenant).detail(string(params.id));
      case 'study.materials.list':
        return this.study(tenant).materials({
          subjectCode: string(params.subjectCode),
          state: choice(params.state, ['pending', 'learned']),
          type: choice<MaterialType>(params.type, [
            'all',
            'courseware',
            'document',
            'video',
            'audio',
            'image',
            'other',
          ]),
          page: page(params.page),
        });
      case 'study.attachment.save':
        return this.sync.save(tenant, string(params.key));
      case 'bank.subjects':
        return this.bank(tenant).subjects();
      case 'bank.subject':
        return this.bank(tenant).subject(string(params.subjectId));
      case 'bank.catalog':
        return this.bank(tenant).catalog(string(params.subjectId), string(params.textbookId));
      case 'bank.questions': {
        const query: BankQuery = {
          subjectId: string(params.subjectId),
          page: page(params.page),
          pageSize: page(params.pageSize, 100),
          sort: choice(params.sort, ['newest', 'oldest']),
          typeIds: strings(params.typeIds),
          difficultyIds: strings(params.difficultyIds),
          textbookId: params.textbookId === undefined ? undefined : string(params.textbookId),
          catalogId: params.catalogId === undefined ? undefined : string(params.catalogId),
          search: params.search === undefined ? undefined : string(params.search),
        };
        return this.bank(tenant).questions(query);
      }
      case 'document.progress.get':
      case 'document.progress.set':
        return this.progress(tenant, method, params);
      default:
        throw new RemoteKitError('invalid_request', '未知学习操作');
    }
  }
  private progress(tenant: string, method: string, params: Record<string, any>) {
    const asset = string(params.assetId);
    this.services.objects.require(tenant, asset);
    const db = this.context.store.db;
    if (method === 'document.progress.get') {
      const row = db
        .prepare('SELECT page,offset FROM document_progress WHERE tenant=? AND asset_id=?')
        .get(tenant, asset) as { page: bigint; offset: number } | undefined;
      return row ? { page: Number(row.page), offset: row.offset } : null;
    }
    if (
      !Number.isSafeInteger(params.page) ||
      params.page < 0 ||
      !Number.isFinite(params.offset) ||
      params.offset < 0 ||
      params.offset > 1
    )
      throw new RemoteKitError('invalid_request', '无效阅读位置');
    this.context.store.transaction(() => {
      const row = db
        .prepare('SELECT max(updated_at) AS latest FROM document_progress WHERE tenant=?')
        .get(tenant) as { latest: bigint | null };
      db.prepare(
        'INSERT INTO document_progress VALUES (?,?,?,?,?) ON CONFLICT(tenant,asset_id) DO UPDATE SET page=excluded.page,offset=excluded.offset,updated_at=excluded.updated_at',
      ).run(
        tenant,
        asset,
        params.page,
        params.offset,
        Math.max(this.context.clock.wallMs(), Number(row.latest ?? 0) + 1),
      );
      db.prepare(
        'DELETE FROM document_progress WHERE tenant=? AND asset_id IN (SELECT asset_id FROM document_progress WHERE tenant=? ORDER BY updated_at DESC LIMIT -1 OFFSET 500)',
      ).run(tenant, tenant);
    });
    return { saved: true };
  }
  async forgetTenant(tenant: string) {
    await Promise.all(
      (['changyan', 'xinjiaoyu'] as const).map((provider) => this.signIn.cancel(tenant, provider)),
    );
    this.accounts.delete(tenant, 'changyan');
    this.accounts.delete(tenant, 'xinjiaoyu');
    await this.sync.stopTenant(tenant);
    this.studies.delete(tenant);
    this.banks.delete(tenant);
    this.providers.delete(tenant);
    this.media.forget(tenant);
    for (const table of ['learning_accounts', 'learning_settings', 'learning_downloads', 'document_progress'])
      this.context.store.db.prepare(`DELETE FROM ${table} WHERE tenant=?`).run(tenant);
  }
  start() {
    this.sync.start();
  }
  async stop() {
    await Promise.all([this.signIn.stop(), this.sync.stop()]);
  }
}
