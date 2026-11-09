import { randomUUID } from 'node:crypto';
import { RemoteKitError } from '../../shared/errors';
import type { LearningProvider, LearningSocketMethods } from '../../shared/learning';
import type { ProductWorkspace } from '../../shared/product';
import { windowClosing } from '../workspace/model';
import { closeSignInTab } from '../workspace/sign-in';
import { LearningAccounts } from './accounts';
import type { CaptchaSeccode } from './providers/changyan/auth';
import type { XinjiaoyuProvider } from './providers/xinjiaoyu/resources';
import { decodeIdentity, type XinjiaoyuSession } from './providers/xinjiaoyu/client';

type Flow = {
  tenant: string;
  provider: LearningProvider;
  windowId: string;
  tabId?: string;
  viewId?: string;
  browser?: string;
  challenge: string;
  username: string;
  password?: string;
  timer: ReturnType<typeof setTimeout>;
  finishing: boolean;
};
export interface SignInTabs {
  validate(tenant: string, provider: LearningProvider, windowId: string): void;
  open(
    tenant: string,
    provider: LearningProvider,
    windowId: string,
    url: string,
  ): Promise<{ id: string; webviewId: string }>;
  close(tenant: string, tabId: string): Promise<void>;
}

export class SignIn {
  private readonly flows = new Map<string, Flow>();
  private readonly jobs = new Set<Promise<unknown>>();
  constructor(
    private readonly accounts: LearningAccounts,
    private readonly tabs: SignInTabs,
    private readonly bank: (tenant: string) => XinjiaoyuProvider,
    private readonly signedIn: (tenant: string, provider: LearningProvider) => void,
    private readonly timeoutMs = 5 * 60_000,
  ) {}
  private key(tenant: string, provider: LearningProvider) {
    return JSON.stringify([tenant, provider]);
  }
  private active(flow: Flow) {
    return this.flows.get(this.key(flow.tenant, flow.provider)) === flow;
  }
  private run(job: Promise<unknown>) {
    this.jobs.add(job);
    void job.catch(() => {}).finally(() => this.jobs.delete(job));
  }
  start(tenant: string, params: LearningSocketMethods['learning.signIn']['params']) {
    this.tabs.validate(tenant, params.provider, params.windowId);
    if (this.flows.has(this.key(tenant, params.provider)))
      throw new RemoteKitError('conflict', '正在登录，请先取消');
    if (
      params.provider === 'changyan' &&
      (typeof params.username !== 'string' ||
        !params.username.trim() ||
        params.username.length > 256 ||
        typeof params.password !== 'string' ||
        !params.password ||
        params.password.length > 1024)
    )
      throw new RemoteKitError('invalid_request', '请输入畅言账号和密码');
    const flow: Flow = {
      tenant,
      provider: params.provider,
      windowId: params.windowId,
      challenge: randomUUID(),
      username: params.provider === 'changyan' ? params.username : '',
      password: params.provider === 'changyan' ? params.password : undefined,
      finishing: false,
      timer: setTimeout(
        () => this.run(this.finish(flow, new RemoteKitError('unavailable', '登录超时，请重试'))),
        this.timeoutMs,
      ),
    };
    flow.timer.unref();
    this.flows.set(this.key(tenant, params.provider), flow);
    this.accounts.setState(tenant, params.provider, {
      status: 'signing_in',
      step: params.provider === 'changyan' ? 'credentials' : 'site',
    });
    this.run(this.begin(flow).catch((error) => this.finish(flow, error)));
    return { started: true as const };
  }
  private async begin(flow: Flow) {
    let url = 'https://www.xinjiaoyu.com/auth/login';
    if (flow.provider === 'changyan') {
      const policy = await this.accounts.auth.captchaPolicy();
      if (!this.active(flow)) return;
      if (!policy.required) return this.loginChangyan(flow);
      const query = new URLSearchParams({
        captchaId: policy.captchaId,
        challenge: flow.challenge,
        apiServers: JSON.stringify(policy.apiServers),
        staticServers: JSON.stringify(policy.staticServers),
      });
      url = `remotekit-signin://changyan/verify?${query}`;
    }
    const tab = await this.tabs.open(flow.tenant, flow.provider, flow.windowId, url);
    if (!this.active(flow)) {
      await this.tabs.close(flow.tenant, tab.id);
      return;
    }
    flow.tabId = tab.id;
    flow.viewId = tab.webviewId;
    this.accounts.setState(flow.tenant, flow.provider, {
      status: 'signing_in',
      step: flow.provider === 'changyan' ? 'verification' : 'site',
      tabId: tab.id,
    });
  }
  private async loginChangyan(flow: Flow, seccode?: CaptchaSeccode) {
    flow.finishing = true;
    this.accounts.setState(flow.tenant, flow.provider, {
      status: 'signing_in',
      step: 'finishing',
      tabId: flow.tabId,
    });
    const password = flow.password!;
    const login = await this.accounts.auth.login({ username: flow.username, password, seccode });
    if ('challenge' in login) {
      flow.finishing = false;
      await this.begin(flow);
      return;
    }
    delete flow.password;
    const session = await this.accounts.zhixueAuth.renew(login);
    if (!this.active(flow)) return;
    this.accounts.save(flow.tenant, 'changyan', session, session.displayName || flow.username, flow.username);
    await this.finish(flow);
    this.signedIn(flow.tenant, flow.provider);
  }
  consume(tenant: string, browser: string, event: unknown): boolean {
    if (!event || typeof event !== 'object') return false;
    const value = event as Record<string, unknown>;
    if (value.type !== 'view.signIn' || value.version !== 1 || typeof value.eventId !== 'string')
      return false;
    const provider = value.provider;
    if (provider !== 'changyan' && provider !== 'xinjiaoyu') return false;
    const flow = this.flows.get(this.key(tenant, provider));
    if (
      !flow ||
      flow.finishing ||
      flow.viewId !== value.webviewId ||
      (flow.browser && flow.browser !== browser)
    )
      return true;
    const result = value.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return true;
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 8192) return true;
    flow.finishing = true;
    this.run(
      (async () => {
        const fields = result as Record<string, unknown>;
        const field = (name: string) => {
          if (typeof fields[name] !== 'string' || !fields[name] || (fields[name] as string).length > 16384)
            throw new RemoteKitError('internal', '登录页面未返回完整验证结果');
          return fields[name] as string;
        };
        if (provider === 'changyan') {
          await this.loginChangyan(flow, {
            captchaOutput: field('captcha_output'),
            genTime: field('gen_time'),
            lotNumber: field('lot_number'),
            passToken: field('pass_token'),
          });
        } else {
          this.accounts.setState(tenant, provider, {
            status: 'signing_in',
            step: 'finishing',
            tabId: flow.tabId,
          });
          const session: XinjiaoyuSession = {
            token: field('authorization').replace(/^JBY\s+/i, ''),
            accessToken: field('accesstoken'),
            clientSessionId: field('clientsession'),
            device: field('device'),
            deviceType: field('devicetype'),
            userAgent: field('user-agent'),
            acceptLanguage: field('accept-language'),
            secChUa: field('sec-ch-ua'),
            secChUaMobile: field('sec-ch-ua-mobile'),
            secChUaPlatform: field('sec-ch-ua-platform'),
          };
          const validated = await this.bank(tenant).subjects(session);
          if (!this.active(flow)) return;
          this.accounts.save(
            tenant,
            provider,
            validated.session,
            decodeIdentity(session.token).displayName || '新教育',
          );
          await this.finish(flow);
          this.signedIn(tenant, provider);
        }
      })().catch((error) => this.finish(flow, error)),
    );
    return true;
  }
  private async finish(flow: Flow, error?: unknown) {
    if (!this.active(flow)) return;
    this.flows.delete(this.key(flow.tenant, flow.provider));
    clearTimeout(flow.timer);
    delete flow.password;
    if (flow.tabId) await this.tabs.close(flow.tenant, flow.tabId).catch(() => {});
    this.accounts.setState(
      flow.tenant,
      flow.provider,
      error
        ? { status: 'failed', message: error instanceof RemoteKitError ? error.message : '登录失败，请重试' }
        : undefined,
    );
  }
  async cancel(tenant: string, provider: LearningProvider) {
    const flow = this.flows.get(this.key(tenant, provider));
    if (flow) await this.finish(flow);
    return { cancelled: !!flow };
  }
  reconcile(state: ProductWorkspace, browser?: string, running = true) {
    for (const provider of ['changyan', 'xinjiaoyu'] as const) {
      const flow = this.flows.get(this.key(state.tenantId, provider));
      if (
        flow &&
        (!state.windows.some((window) => window.id === flow.windowId) ||
          windowClosing(state, flow.windowId) ||
          (flow.tabId && !state.tabs.some((tab) => tab.id === flow.tabId)) ||
          !running ||
          (flow.browser && browser && flow.browser !== browser))
      ) {
        if (flow.tabId) closeSignInTab(state, flow.tabId);
        this.run(
          this.finish(
            flow,
            !running || (flow.browser && browser && flow.browser !== browser)
              ? new RemoteKitError('unavailable', '会话已重启，请重新登录')
              : undefined,
          ),
        );
      } else if (flow && browser && flow.viewId) flow.browser = browser;
    }
    for (const tab of [...state.tabs]) {
      if (tab.signIn && !this.flows.has(this.key(state.tenantId, tab.signIn))) closeSignInTab(state, tab.id);
    }
  }
  async stop() {
    await Promise.all([...this.flows.values()].map((flow) => this.finish(flow)));
    await Promise.allSettled([...this.jobs]);
  }
}
