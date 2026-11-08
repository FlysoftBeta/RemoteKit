import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlDatabase } from '../server/persistence/database';
import { LearningAccounts } from '../server/learning/accounts';
import { AuthClient, type AccountSession } from '../server/learning/providers/changyan/auth';
import { ZhixueAuthClient } from '../server/learning/providers/changyan/zhixue-auth';
import { RemoteKitError } from '../shared/errors';

const session = (): AccountSession => ({
  sso: { tgt: 'private-tgt', at: 'private-at', userId: 'id' },
  changyan: {
    token: 'private-token',
    userId: 'id',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  },
});
function fixture() {
  const store = new ControlDatabase(':memory:');
  const auth = new AuthClient();
  const zhixue = new ZhixueAuthClient();
  auth.ensureFresh = async (input) => input;
  zhixue.ensureFresh = async (input) => input;
  let renewed = 0;
  auth.renew = async (input) => {
    renewed++;
    return { ...input, changyan: { ...session().changyan, token: 'renewed-token' } };
  };
  zhixue.renew = async (input) => input;
  const pushes: string[] = [];
  const accounts = new LearningAccounts(
    store,
    (tenant) => pushes.push(tenant),
    auth,
    zhixue,
    Buffer.alloc(32),
  );
  accounts.save('tenant', 'changyan', session(), '学生', 'private-username');
  return {
    store,
    accounts,
    pushes,
    get renewed() {
      return renewed;
    },
  };
}

test('provider unauthenticated renews TGT and CAS once, then persists the rotated session', async () => {
  const f = fixture();
  try {
    let reads = 0;
    const result = await f.accounts.use('tenant', 'changyan', async (input) => {
      if (++reads === 1) throw new RemoteKitError('unauthenticated', '登录已过期');
      assert.equal(input.changyan.token, 'renewed-token');
      return { session: input, data: 'success' };
    });
    assert.equal(result, 'success');
    assert.equal(reads, 2);
    assert.equal(f.renewed, 1);
    assert.equal(f.accounts.session('tenant', 'changyan').changyan.token, 'renewed-token');
  } finally {
    f.store.db.close();
  }
});

test('failed renewal expires the account and pushes only public account state', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.accounts.use('tenant', 'changyan', async () => {
        throw new RemoteKitError('unauthenticated', '登录已过期');
      }),
    );
    assert.deepEqual(f.accounts.state('tenant', 'changyan'), { status: 'expired', displayName: '学生' });
    assert.deepEqual(f.pushes, ['tenant']);
    assert.ok(
      !/token|private-username|private-tgt/.test(JSON.stringify(f.accounts.state('tenant', 'changyan'))),
    );
  } finally {
    f.store.db.close();
  }
});

test('sign-out fences an in-flight read so it cannot resurrect a deleted session', async () => {
  const f = fixture();
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  const waiting = new Promise<void>((resolve) => (release = resolve));
  try {
    const read = f.accounts.use('tenant', 'changyan', async (input) => {
      started();
      await waiting;
      return { session: input, data: 'late' };
    });
    await ready;
    f.accounts.delete('tenant', 'changyan');
    release();
    await assert.rejects(read);
    assert.deepEqual(f.accounts.state('tenant', 'changyan'), { status: 'signed_out' });
    assert.equal(f.store.db.prepare('SELECT * FROM learning_accounts').all().length, 0);
  } finally {
    release?.();
    f.store.db.close();
  }
});
