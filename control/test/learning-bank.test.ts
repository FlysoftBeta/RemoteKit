import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlDatabase } from '../server/persistence/database';
import { LearningAccounts } from '../server/learning/accounts';
import { BankService } from '../server/learning/bank-service';
import { MediaProxy } from '../server/learning/media-proxy';
import { XinjiaoyuProvider } from '../server/learning/providers/xinjiaoyu/resources';
import { createApplication } from '../server/application';
import { registerUser, requestViewer, testGateway } from './server-fixture';
import { RemoteKitError } from '../shared/errors';

test('provider expiry signs out learning while retaining the Viewer session and workspace', async (t) => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  const user = await registerUser(store, 'learning-expiry', 'learning-password123');
  const app = createApplication(store, testGateway({ request: async () => ({}) }));
  t.mock.method(XinjiaoyuProvider.prototype, 'subjects', async () => {
    throw new RemoteKitError('unauthenticated', 'provider expired');
  });
  try {
    await app.viewers.attachViewer(
      user.tenantId,
      'lease',
      () => {},
      { identity: 'control-session', valid: () => true },
      true,
    );
    app.learning.accounts.save(user.tenantId, 'xinjiaoyu', {
      token: 'fixture-token',
      accessToken: 'fixture-access',
      clientSessionId: 'fixture-client',
      device: 'pc',
      deviceType: 'Chrome',
      safeCode: 'fixture-safe',
    });
    await assert.rejects(requestViewer(app, user.tenantId, 'lease', 'bank.subjects', {}), {
      code: 'forbidden',
      message: '学习账号登录已失效，请重新登录',
    });
    assert.equal(app.tenants.get(user.tenantId).viewer?.id, 'lease');
    const state = app.viewers.productState(user.tenantId);
    assert.equal(state.user.username, 'learning-expiry');
    assert.equal(state.learning.accounts.xinjiaoyu.status, 'signed_out');
    assert.deepEqual(await requestViewer(app, user.tenantId, 'lease', 'clipboard.get', {}), {
      revision: '0',
      text: '',
    });
  } finally {
    await app.close();
    store.db.close();
  }
});

test('bank maps every filter, subtype, difficulty, catalog, rich field and media through the provider transport', async () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  const accounts = new LearningAccounts(store, () => {}, undefined, undefined, Buffer.alloc(32));
  accounts.save('tenant', 'xinjiaoyu', {
    token: 'token',
    accessToken: 'access',
    clientSessionId: 'client',
    device: 'pc',
    deviceType: 'Chrome',
    safeCode: 'safe',
  });
  const bodies: { path: string; body: Record<string, unknown> }[] = [];
  const provider = new XinjiaoyuProvider({
    rateLimit: { minIntervalMs: 0, jitterMs: 0, maxRetries: 0 },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      bodies.push({ path: url.pathname, body });
      let data: unknown;
      if (url.pathname.endsWith('/audit/cfg/query'))
        data = {
          unints: [
            { auditGroups: [{ phaseId: '10000', phaseName: '高中', courseId: 'math', course: '数学' }] },
          ],
        };
      else if (url.pathname.endsWith('/byScene'))
        data = [
          {
            questionsTypeList: [
              { id: 'choice', name: '选择题', children: [{ id: 'single', name: '单选题' }] },
            ],
          },
        ];
      else if (url.pathname.endsWith('/textbook/type/list')) data = [{ key: 'edition' }];
      else if (url.pathname.endsWith('/textbook/list'))
        data = [
          {
            id: 'book',
            textBookName: '数学必修一',
            typeName: '人教版',
            gradeName: '高一',
            semesterName: '上',
          },
        ];
      else if (url.pathname.endsWith('/catalogNew/list'))
        data = [{ key: 'catalog', value: '函数', dimensionId: 'dimension', labelId: 'tag' }];
      else
        data = {
          current: 2,
          size: 20,
          total: 25,
          realTotal: 100,
          pages: 2,
          records: [
            {
              id: 'q',
              typeName: '选择题',
              secondTypeName: '单选题',
              difficultyName: '基础题',
              content: '<p>\\(x^2\\)<img src="https://cdn.example/stem.png"></p>',
              optionsList: ['A. 1', 'B. 2'],
              answer: '<img src="https://cdn.example/answer.png">',
              decipherment: '<img src="https://cdn.example/analysis.png">',
              listeningText: '<img src="https://cdn.example/listening.png">',
              chineseText: '<img src="https://cdn.example/translation.png">',
              questionAudio: 'https://cdn.example/audio.mp3',
              questionVideo: 'https://cdn.example/video.mp4',
              childrenQuestions: [{ id: 'child', content: '<img src="https://cdn.example/child.png">' }],
              tagFeatureInfo: [{ tagName: '函数' }],
              sourceFeatureInfo: [{ sourceName: '试卷', sourceFullNote: '期末试卷' }],
            },
          ],
        };
      return Response.json({ code: 200, data });
    },
  });
  const proxy = new MediaProxy();
  const bank = new BankService('tenant', accounts, proxy, provider);
  try {
    const subjects = await bank.subjects();
    assert.equal(subjects.subjects[0].name, '数学');
    assert.ok(subjects.subjects[0].stage);
    const metadata = await bank.subject('math');
    assert.deepEqual(metadata.types[0].children, [{ id: 'single', name: '单选题', children: [] }]);
    assert.deepEqual(
      metadata.difficulties.map((item) => item.id),
      ['10018', '10019', '10020'],
    );
    assert.equal(metadata.textbooks[0].edition, '人教版');
    assert.equal((await bank.catalog('math', 'book')).nodes[0].selectable, true);
    const query = {
      subjectId: 'math',
      textbookId: 'book',
      catalogId: 'catalog',
      typeIds: ['single'],
      difficultyIds: ['10018'],
      search: '函数',
      sort: 'oldest' as const,
      page: 2,
      pageSize: 20,
    };
    const result = await bank.questions(query);
    const mapped = result.items[0];
    assert.equal(result.total, 100);
    assert.equal(result.accessibleTotal, 25);
    assert.equal(mapped.typeName, '单选题');
    assert.equal(mapped.difficulty, '基础题');
    assert.deepEqual(mapped.optionsHtml, ['1', '2']);
    assert.deepEqual(mapped.tags, ['函数']);
    assert.equal(mapped.source, '期末试卷');
    assert.equal(
      proxy.verify('tenant', mapped.audioUrl!.split('/').pop()!).url,
      'https://cdn.example/audio.mp3',
    );
    assert.ok(mapped.stemHtml.includes('<svg'));
    assert.ok(!JSON.stringify(mapped).includes('https://cdn.example'));
    const body = [...bodies].reverse().find((item) => item.path.endsWith('/esDetail'))!.body;
    assert.deepEqual(body.logicTypeIds, ['single']);
    assert.deepEqual(body.difficultyIds, ['10018']);
    assert.deepEqual(body.dimensionTagList, [{ dimensionId: 'dimension', tagId: 'tag' }]);
    assert.equal(body.isDesc, false);
    assert.equal(body.search, '函数');
    const count = bodies.length;
    await bank.questions(query);
    await bank.subject('math');
    await bank.subjects();
    assert.equal(bodies.length, count);
    accounts.delete('tenant', 'xinjiaoyu');
    await assert.rejects(bank.subjects());
  } finally {
    store.db.close();
  }
});

test('document progress enforces object ownership, validates offsets and keeps the latest 500', async () => {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  const user = await registerUser(store, 'progress-user', 'progress-password123');
  const app = createApplication(store, testGateway({ request: async () => ({}) }));
  const asset = 'a'.repeat(64);
  store.db.prepare('INSERT INTO objects VALUES (?,1,1,?,?)').run(asset, 'b'.repeat(64), Date.now());
  store.db.prepare('INSERT INTO object_claims VALUES (?,?,?)').run(user.tenantId, asset, Date.now());
  try {
    assert.equal(
      await app.learning.request(user.tenantId, 'document.progress.get', { assetId: asset }),
      null,
    );
    assert.deepEqual(
      await app.learning.request(user.tenantId, 'document.progress.set', {
        assetId: asset,
        page: 4,
        offset: 0.5,
      }),
      { saved: true },
    );
    assert.deepEqual(await app.learning.request(user.tenantId, 'document.progress.get', { assetId: asset }), {
      page: 4,
      offset: 0.5,
    });
    await assert.rejects(app.learning.request('other', 'document.progress.get', { assetId: asset }));
    await assert.rejects(
      app.learning.request(user.tenantId, 'document.progress.set', { assetId: asset, page: -1, offset: 0 }),
    );
    await assert.rejects(
      app.learning.request(user.tenantId, 'document.progress.set', { assetId: asset, page: 0, offset: 2 }),
    );
    const insert = store.db.prepare('INSERT INTO document_progress VALUES (?,?,0,0,?)');
    for (let index = 0; index < 500; index++) insert.run(user.tenantId, 'old-' + index, index);
    await app.learning.request(user.tenantId, 'document.progress.set', {
      assetId: asset,
      page: 5,
      offset: 1,
    });
    assert.equal(
      Number((store.db.prepare('SELECT count(*) AS count FROM document_progress').get() as any).count),
      500,
    );
    assert.equal(store.db.prepare("SELECT * FROM document_progress WHERE asset_id='old-0'").get(), undefined);
    await app.learning.forgetTenant(user.tenantId);
    for (const table of ['learning_accounts', 'learning_settings', 'learning_downloads', 'document_progress'])
      assert.equal(store.db.prepare(`SELECT * FROM ${table} WHERE tenant=?`).all(user.tenantId).length, 0);
  } finally {
    await app.close();
    store.db.close();
  }
});
