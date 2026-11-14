import { APIClient } from '../server/learning/providers/xinjiaoyu/client';
import { HttpClient } from '../server/learning/providers/http';
import { LearningAccounts } from '../server/learning/accounts';
import { SignIn } from '../server/learning/sign-in';
import { AuthClient, type AccountSession } from '../server/learning/providers/changyan/auth';
import { ZhixueAuthClient } from '../server/learning/providers/changyan/zhixue-auth';
import { ControlDatabase } from '../server/persistence/database';
import { emptyWorkspace } from '../server/persistence/workspaces';
import { operation, type OwnerFactory } from './retry-loop-boundary';

const session = {
  token: 'token',
  accessToken: 'access',
  clientSessionId: 'session',
  device: 'browser',
  deviceType: 'desktop',
  safeCode: 'safe',
};

export const driveXinjiaoyu: OwnerFactory = (boundary) => {
  const owner = new APIClient({
    rateLimit: { minIntervalMs: 0, jitterMs: 0 },
    fetch: (url, init) =>
      boundary.call(
        { url: String(url), method: init?.method, body: init?.body },
        new Response(JSON.stringify({ code: 200, data: { ready: true } })),
      ),
  });
  const result = operation();
  const run = () => result.run(() => owner.get(session, '/api/read', { query: boundary.version }));
  return {
    start: run,
    drive: () => {},
    changeInput: () => {
      boundary.version++;
      run();
    },
    error: result.error,
    dispose: () => {},
  };
};

export const driveProviderRead: OwnerFactory = (boundary) => {
  const owner = new HttpClient();
  const result = operation();
  const run = () =>
    result.run(() => owner.retry(() => boundary.call({ provider: boundary.version }, { ready: true })));
  return {
    start: run,
    drive: () => {},
    changeInput: () => {
      boundary.version++;
      run();
    },
    error: result.error,
    dispose: () => {},
  };
};

export const driveLearningRead: OwnerFactory = (boundary) => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  store.workspaces.writeWorkspace(emptyWorkspace('tenant'));
  const owner = new LearningAccounts(store, () => {}, undefined, undefined, Buffer.alloc(32));
  owner.save('tenant', 'xinjiaoyu', session);
  const result = operation();
  const run = () =>
    result.run(() =>
      owner.use('tenant', 'xinjiaoyu', (input) =>
        boundary.call({ session: input, query: boundary.version }, { session: input, data: { ready: true } }),
      ),
    );
  return {
    start: run,
    drive: () => {},
    changeInput: () => {
      owner.save('tenant', 'xinjiaoyu', session);
      boundary.version++;
      run();
    },
    error: result.error,
    dispose: () => {
      store.db.close();
    },
  };
};

export function driveSignInStep(stage: 'captcha' | 'login' | 'renew'): OwnerFactory {
  return (boundary) => {
    const store = new ControlDatabase(':memory:', { buildId: 'test' });
    store.workspaces.writeWorkspace(emptyWorkspace('tenant'));
    const auth = new AuthClient();
    const credentials: AccountSession = {
      sso: { tgt: 'tgt', at: 'at', userId: 'user' },
      changyan: {
        token: 'token',
        userId: 'user',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    };
    auth.captchaPolicy = () =>
      stage === 'captcha'
        ? boundary.call(
            { policy: 'changyan' },
            { required: true, captchaId: 'captcha', captchaType: 'v4', apiServers: [], staticServers: [] },
          )
        : Promise.resolve({
            required: false,
            captchaId: 'captcha',
            captchaType: 'v4',
            apiServers: [],
            staticServers: [],
          });
    auth.login = (params) =>
      stage === 'login' ? boundary.call(params, credentials) : Promise.resolve(credentials);
    const zhixue = new ZhixueAuthClient();
    zhixue.renew = (params) =>
      stage === 'renew' ? boundary.call(params, credentials) : Promise.resolve(credentials);
    const accounts = new LearningAccounts(store, () => {}, auth, zhixue, Buffer.alloc(32));
    const owner = new SignIn(
      accounts,
      { validate: () => {}, open: async () => ({ id: 'tab', webviewId: 'view' }), close: async () => {} },
      () => ({}) as never,
      () => {},
      172800000,
    );
    const run = () => {
      owner.start('tenant', {
        provider: 'changyan',
        windowId: 'window',
        username: 'user',
        password: 'password',
      });
    };
    return {
      start: run,
      drive: () => {},
      changeInput: async () => {
        await owner.cancel('tenant', 'changyan');
        run();
      },
      error: () => {
        const state = accounts.state('tenant', 'changyan');
        return 'error' in state ? state.error : undefined;
      },
      dispose: async () => {
        await owner.stop();
        store.db.close();
      },
    };
  };
}
export const driveSignIn = driveSignInStep('captcha');
