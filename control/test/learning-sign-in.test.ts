import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlDatabase } from '../server/persistence/database';
import { LearningAccounts } from '../server/learning/accounts';
import { SignIn, type SignInTabs } from '../server/learning/sign-in';
import { AuthClient, type AccountSession } from '../server/learning/providers/changyan/auth';
import { ZhixueAuthClient } from '../server/learning/providers/changyan/zhixue-auth';
import { XinjiaoyuProvider } from '../server/learning/providers/xinjiaoyu/resources';
import { RemoteKitError } from '../shared/errors';
import { emptyWorkspace } from '../server/persistence/workspaces';
import { openSignInTab, closeSignInTab } from '../server/workspace/sign-in';

const session = (): AccountSession => ({
  sso: { tgt: 'private-tgt', at: 'private-at', userId: 'id' },
  changyan: {
    token: 'private-token',
    userId: 'id',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  },
});
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
async function until(check: () => boolean) {
  for (let index = 0; index < 100; index++) {
    if (check()) return;
    await turn();
  }
  assert.fail('sign-in did not settle');
}

function fixture(timeout = 300_000) {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  const workspace = emptyWorkspace('tenant');
  workspace.windows = [
    { id: 'study', appId: 'study', activeTabId: null, lastActiveAt: 0 },
    { id: 'bank', appId: 'questions', activeTabId: null, lastActiveAt: 0 },
  ];
  let required = true;
  let rejected = false;
  let logins = 0;
  const auth = new AuthClient();
  auth.captchaPolicy = async () => ({
    required,
    captchaId: 'captcha',
    captchaType: 'v4',
    apiServers: ['captcha.example/api', 'second.example/api'],
    staticServers: ['captcha.example/static'],
  });
  auth.login = async (params) => {
    logins++;
    assert.equal(params.password, 'private-password');
    if (required) assert.equal(params.seccode?.captchaOutput, 'output');
    if (rejected) throw new RemoteKitError('rejected', '密码错误');
    return session();
  };
  const zhixue = new ZhixueAuthClient();
  zhixue.renew = async (value) => ({ ...value, displayName: '学习者' });
  const accounts = new LearningAccounts(store, () => {}, auth, zhixue, Buffer.alloc(32, 9));
  const tabs: SignInTabs = {
    validate: (_tenant, provider, windowId) => {
      assert.equal(windowId, provider === 'changyan' ? 'study' : 'bank');
    },
    open: async (_tenant, provider, windowId, url) =>
      openSignInTab(workspace, provider, windowId, url, 'view'),
    close: async (_tenant, id) => {
      closeSignInTab(workspace, id);
    },
  };
  const bank = new XinjiaoyuProvider();
  let subjectsRead = false;
  bank.subjects = async (value) => {
    subjectsRead = true;
    return { session: value, data: [] };
  };
  const synced: string[] = [];
  const signIn = new SignIn(
    accounts,
    tabs,
    () => bank,
    (_tenant, provider) => synced.push(provider),
    timeout,
  );
  return {
    store,
    workspace,
    accounts,
    signIn,
    synced,
    get logins() {
      return logins;
    },
    get subjectsRead() {
      return subjectsRead;
    },
    policy(value: boolean) {
      required = value;
    },
    reject() {
      rejected = true;
    },
    async close() {
      await signIn.stop();
      store.db.close();
    },
  };
}
const captchaEvent = {
  type: 'view.signIn',
  version: 1,
  eventId: 'event',
  webviewId: 'view',
  provider: 'changyan',
  result: { captcha_output: 'output', gen_time: 'time', lot_number: 'lot', pass_token: 'pass' },
};

test('Changyan verification uses a private tab, JSON server lists, sealed session and one completion', async () => {
  const f = fixture();
  try {
    assert.deepEqual(
      f.signIn.start('tenant', {
        provider: 'changyan',
        windowId: 'study',
        username: 'user',
        password: 'private-password',
      }),
      { started: true },
    );
    await until(() => f.workspace.tabs.length === 1);
    const tab = f.workspace.tabs[0];
    assert.equal(tab.signIn, 'changyan');
    assert.equal(f.workspace.windows[0].activeTabId, tab.id);
    const url = new URL(tab.url);
    assert.equal(url.protocol, 'remotekit-signin:');
    assert.equal(url.searchParams.get('captchaId'), 'captcha');
    assert.ok(url.searchParams.get('challenge'));
    assert.deepEqual(JSON.parse(url.searchParams.get('apiServers')!), [
      'captcha.example/api',
      'second.example/api',
    ]);
    assert.ok(!tab.url.includes('private-password'));
    assert.equal(f.signIn.consume('tenant', 'browser', { ...captchaEvent, webviewId: 'other' }), true);
    assert.equal(f.logins, 0);
    f.signIn.consume('tenant', 'browser', captchaEvent);
    f.signIn.consume('tenant', 'browser', captchaEvent);
    await until(() => f.accounts.state('tenant', 'changyan').status === 'signed_in');
    assert.equal(f.logins, 1);
    assert.deepEqual(f.synced, ['changyan']);
    assert.equal(f.workspace.tabs.length, 0);
    assert.deepEqual(f.accounts.state('tenant', 'changyan'), {
      status: 'signed_in',
      displayName: '学习者',
      since: (f.accounts.state('tenant', 'changyan') as any).since,
    });
    const row = f.store.db.prepare('SELECT sealed FROM learning_accounts').get() as { sealed: string };
    assert.ok(!row.sealed.includes('private-token'));
    assert.equal(f.accounts.session('tenant', 'changyan').sso.tgt, 'private-tgt');
    f.store.db.prepare("UPDATE learning_accounts SET tenant='other'").run();
    assert.throws(() => f.accounts.session('other', 'changyan'));
  } finally {
    await f.close();
  }
});

test('Changyan no-captcha policy finishes without opening a tab and preserves provider rejection', async () => {
  const f = fixture();
  try {
    f.policy(false);
    f.reject();
    f.signIn.start('tenant', {
      provider: 'changyan',
      windowId: 'study',
      username: 'user',
      password: 'private-password',
    });
    await until(() => f.accounts.state('tenant', 'changyan').status === 'failed');
    assert.deepEqual(f.accounts.state('tenant', 'changyan'), { status: 'failed', message: '密码错误' });
    assert.equal(f.workspace.tabs.length, 0);
  } finally {
    await f.close();
  }
});

test('Xinjiaoyu captures identity headers and validates subjects before saving', async () => {
  const f = fixture();
  try {
    f.signIn.start('tenant', { provider: 'xinjiaoyu', windowId: 'bank' });
    await until(() => f.workspace.tabs.length === 1);
    assert.equal(f.workspace.tabs[0].url, 'https://www.xinjiaoyu.com/auth/login');
    f.signIn.consume('tenant', 'browser', {
      type: 'view.signIn',
      version: 1,
      eventId: 'xj',
      webviewId: 'view',
      provider: 'xinjiaoyu',
      result: {
        authorization: 'JBY token',
        accesstoken: 'access',
        clientsession: 'page-client',
        device: 'mobile',
        devicetype: 'Other',
        'user-agent': 'Browser',
        'accept-language': 'zh-CN',
        'sec-ch-ua': 'Chromium',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': 'Windows',
      },
    });
    await until(() => f.accounts.state('tenant', 'xinjiaoyu').status === 'signed_in');
    assert.equal(f.subjectsRead, true);
    assert.equal(f.accounts.session('tenant', 'xinjiaoyu').token, 'token');
    assert.equal(f.accounts.session('tenant', 'xinjiaoyu').userAgent, 'Browser');
    assert.equal(f.accounts.session('tenant', 'xinjiaoyu').clientSessionId, 'page-client');
    assert.equal(f.accounts.session('tenant', 'xinjiaoyu').device, 'mobile');
    assert.equal(f.accounts.session('tenant', 'xinjiaoyu').deviceType, 'Other');
    assert.equal(f.workspace.tabs.length, 0);
  } finally {
    await f.close();
  }
});

test('Xinjiaoyu requires the captured client session before validation', async () => {
  const f = fixture();
  try {
    f.signIn.start('tenant', { provider: 'xinjiaoyu', windowId: 'bank' });
    await until(() => f.workspace.tabs.length === 1);
    f.signIn.consume('tenant', 'browser', {
      type: 'view.signIn',
      version: 1,
      eventId: 'xj',
      webviewId: 'view',
      provider: 'xinjiaoyu',
      result: { authorization: 'JBY token', accesstoken: 'access' },
    });
    await until(() => f.accounts.state('tenant', 'xinjiaoyu').status === 'failed');
    assert.equal(f.subjectsRead, false);
    assert.equal(f.workspace.tabs.length, 0);
    assert.equal(f.store.db.prepare('SELECT * FROM learning_accounts').all().length, 0);
  } finally {
    await f.close();
  }
});

for (const provider of ['changyan', 'xinjiaoyu'] as const) {
  for (const reason of ['cancel', 'timeout', 'window-close', 'browser-restart'] as const) {
    test(`${provider} ${reason} retires the flow and rejects a late result`, async () => {
      const f = fixture(reason === 'timeout' ? 25 : 300_000);
      try {
        f.signIn.start(
          'tenant',
          provider === 'changyan'
            ? { provider, windowId: 'study', username: 'user', password: 'private-password' }
            : { provider, windowId: 'bank' },
        );
        await until(() => f.workspace.tabs.length === 1);
        if (reason === 'cancel')
          assert.deepEqual(await f.signIn.cancel('tenant', provider), { cancelled: true });
        if (reason === 'window-close') {
          f.workspace.windows = [];
          f.signIn.reconcile(f.workspace, 'browser');
        }
        if (reason === 'browser-restart') {
          f.signIn.reconcile(f.workspace, 'first');
          f.signIn.reconcile(f.workspace, 'second');
        }
        await until(() => f.accounts.state('tenant', provider).status !== 'signing_in');
        assert.equal(f.workspace.tabs.length, 0);
        f.signIn.consume('tenant', 'browser', captchaEvent);
        await turn();
        assert.equal(f.logins, 0);
        assert.equal(f.store.db.prepare('SELECT * FROM learning_accounts').all().length, 0);
      } finally {
        await f.close();
      }
    });
  }
}

test('internal tab command rejects the wrong app and closes only sign-in tabs', () => {
  const state = emptyWorkspace('tenant');
  state.windows = [{ id: 'window', appId: 'browser', activeTabId: null, lastActiveAt: 0 }];
  assert.throws(() => openSignInTab(state, 'changyan', 'window', 'about:blank', '1'));
});
