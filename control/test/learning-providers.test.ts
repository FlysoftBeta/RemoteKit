import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { RemoteKitError, type ErrorCode } from '../shared/errors.js';
import { HttpClient, serviceError } from '../server/learning/providers/http.js';
import { collectMediaUrls } from '../server/learning/providers/html.js';
import { AuthClient, type AccountSession } from '../server/learning/providers/changyan/auth.js';
import { AUTH_CONFIG } from '../server/learning/providers/changyan/config.js';
import { encryptPassword, gatewaySignatureWithAppId } from '../server/learning/providers/changyan/crypto.js';
import { GatewayClient } from '../server/learning/providers/changyan/gateway.js';
import { StudyClient } from '../server/learning/providers/changyan/study.js';
import { ZhixueAuthClient } from '../server/learning/providers/changyan/zhixue-auth.js';
import { ZhixueClient } from '../server/learning/providers/changyan/zhixue.js';
import { normalizeHomeworkQuestions } from '../server/learning/providers/changyan/zhixue-normalize.js';
import { APIClient, type XinjiaoyuSession } from '../server/learning/providers/xinjiaoyu/client.js';
import {
  AES_KEY,
  createHandshakeEncrypt,
  createRequestEncrypt,
  decryptSafeCode,
} from '../server/learning/providers/xinjiaoyu/crypto.js';
import { normalizeQuestion } from '../server/learning/providers/xinjiaoyu/normalize.js';
import { RateLimiter } from '../server/learning/providers/xinjiaoyu/rate-limiter.js';
import { XinjiaoyuProvider } from '../server/learning/providers/xinjiaoyu/resources.js';

type Fetch = typeof globalThis.fetch;
type Handler = (
  url: URL,
  body: Record<string, unknown>,
  headers: Headers,
) => unknown | Response | Promise<unknown | Response>;

function mockFetch(handler: Handler): Fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const response = await handler(url, body, new Headers(init?.headers));
    return response instanceof Response ? response : Response.json(response);
  };
}

function account(): AccountSession {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  return {
    sso: { tgt: 'test-tgt', at: 'test-at', userId: 'account' },
    changyan: { token: 'test-token', userId: 'account', createdAt, expiresAt },
    zhixue: {
      token: 'test-cas-token',
      accountId: 'account',
      studentId: 'student',
      classId: 'class',
      createdAt,
      expiresAt,
    },
  };
}

function jwt(payload: unknown): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

const xjSession: XinjiaoyuSession = {
  token: jwt({ sub: JSON.stringify({ id: 'account', school: { schoolId: 'school' } }) }),
  accessToken: 'test-access',
  clientSessionId: 'test-client',
  device: 'mobile',
  deviceType: 'Other',
  safeCode: 'test-safe',
};
const rateLimit = { minIntervalMs: 0, jitterMs: 0, maxRetries: 0, retryBaseMs: 0 };
const success = (data: unknown) => ({ code: 200, data });
const zhixueSuccess = (result: unknown) => ({ code: '000000', result });
const rejectsCode = (promise: Promise<unknown>, code: ErrorCode) =>
  assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof RemoteKitError && error.code === code && /[\u4e00-\u9fff]/.test(error.message),
  );

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`./fixtures/learning/${name}.json`, import.meta.url), 'utf8'));
}

function encryptSafeCode(value: string): string {
  const cipher = createCipheriv('aes-256-ecb', Buffer.from(AES_KEY), null);
  return Buffer.concat([cipher.update(value), cipher.final()]).toString('base64');
}

test('reference signing vectors, RSA ciphertext and AES handshake', () => {
  assert.equal(createHandshakeEncrypt('session', 123), 'c5fa75cc69ce004e0ceb18deac9fe3db');
  assert.equal(createRequestEncrypt('safe-code', 'session', 123), 'e950f4083b9a585593fe1076546ac7e7');
  assert.equal(decryptSafeCode(encryptSafeCode('safe-code')), 'safe-code');
  assert.match(encryptPassword('demo-password'), /^[0-9a-f]{256}$/);
  assert.equal(
    gatewaySignatureWithAppId(
      AUTH_CONFIG.gateway.secret,
      AUTH_CONFIG.gateway.appId,
      '/futureclass/msgpush/deviceControl/deviceInfoSet',
      '459f90bd-d26d-448f-9288-ba3b2fb40f8d',
      '1787356548651',
    ),
    'BA1p0AEb26va1EZLy3p0sDHhjDX0nQ/btCvBEsorpws=',
  );
});

test('Changyan pre-solved captcha, canonical token rotation and JSON sessions', async () => {
  const forms: URLSearchParams[] = [];
  const fetch: Fetch = async (_url, init) => {
    const form = new URLSearchParams(String(init?.body));
    forms.push(form);
    assert.equal(new Headers(init?.headers).get('user-agent'), AUTH_CONFIG.sso.httpUserAgent);
    if (form.get('method') === 'sso.get.captcha.type') {
      return Response.json({
        code: 'success',
        data: { captchaConf: JSON.stringify({ gt: 'test', captchaType: 'third', notCheckCaptcha: 'false' }) },
      });
    }
    return Response.json({
      code: 'success',
      data: {
        tgt: 'test-tgt',
        at: form.get('method') === 'sso.create.token' ? 'renewed-at' : 'login-at',
        userId: 'account',
        token: 'renewed-token',
        expireIn: 3600,
      },
    });
  };
  const auth = new AuthClient({ fetch });
  await rejectsCode(auth.login({ username: 'test', password: 'test' }), 'rejected');
  assert.equal(forms.length, 1);
  const session = await auth.login({
    username: 'test',
    password: 'test',
    seccode: { captchaOutput: 'output', genTime: '123', lotNumber: 'lot', passToken: 'pass' },
  });
  assert.equal(session.sso.at, 'renewed-at');
  assert.equal(session.changyan.token, 'renewed-token');
  assert.deepEqual(JSON.parse(JSON.stringify(session)), session);
  const login = forms.find((form) => form.get('method') === 'sso.login.account.v2')!;
  assert.match(login.get('password')!, /^[0-9a-f]{256}$/);
  assert.equal(login.get('encodeType'), 'R2/P');
  assert.deepEqual(JSON.parse(login.get('thirdCaptchaParam')!), {
    captcha_output: 'output',
    gen_time: '123',
    lot_number: 'lot',
    pass_token: 'pass',
  });
  const callsBefore = forms.length;
  assert.equal(await auth.ensureFresh(session), session);
  assert.equal(forms.length, callsBefore);
  const expiring = {
    ...session,
    changyan: { ...session.changyan, expiresAt: new Date(Date.now() + 60_000).toISOString() },
  };
  await auth.ensureFresh(expiring);
  assert.equal(forms.length, callsBefore + 1);
});

test('Zhixue renewal extends the shared TGT before CAS and retains rotated cookies', async () => {
  const current = account();
  current.zhixue!.expiresAt = new Date(0).toISOString();
  current.zhixue!.cookies = { prior: 'test-old' };
  const calls: string[] = [];
  const token = jwt({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
  const fetch: Fetch = async (input, init) => {
    const url = String(input);
    const form = new URLSearchParams(String(init?.body));
    calls.push(url);
    if (url.includes('/sso/')) {
      assert.equal(form.get('method'), 'sso.extend.tgt');
      assert.equal(form.get('appId'), 'zhixue_parent');
      assert.equal(form.has('mac'), false);
      return Response.json({ code: 'success', data: { at: 'extended-at' } });
    }
    assert.equal(form.get('at'), 'extended-at');
    assert.equal(new Headers(init?.headers).get('cookie'), 'prior=test-old');
    return Response.json(
      {
        errorCode: 0,
        result: {
          token,
          id: 'account',
          childrens: [{ id: 'other' }, { id: 'student', isChange: true, clazzInfo: { id: 'class' } }],
        },
      },
      { headers: { 'set-cookie': 'next=test-new; Path=/; HttpOnly' } },
    );
  };
  const auth = new ZhixueAuthClient({ fetch });
  const renewed = await auth.ensureFresh(current);
  assert.equal(calls.length, 2);
  assert.equal(renewed.sso.at, 'extended-at');
  assert.equal(renewed.zhixue!.studentId, 'student');
  assert.deepEqual(renewed.zhixue!.cookies, { prior: 'test-old', next: 'test-new' });
  assert.equal(current.sso.at, 'test-at');
  assert.equal(await auth.ensureFresh(renewed), renewed);
});

test('Gateway signs the encoded query and uses a renewed session', async () => {
  const session = account();
  session.changyan.expiresAt = new Date(0).toISOString();
  const fetch: Fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/sso/v1/api') {
      return Response.json({
        code: 'success',
        data: { at: 'rotated-at', token: 'rotated-token', expireIn: 3600 },
      });
    }
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('s-auth-token'), 'rotated-token');
    assert.equal(
      headers.get('s-auth-signature'),
      gatewaySignatureWithAppId(
        AUTH_CONFIG.gateway.secret,
        AUTH_CONFIG.gateway.appId,
        `${url.pathname}${url.search}`,
        'nonce',
        '123',
      ),
    );
    assert.equal(url.searchParams.get('name'), '中文 +');
    return Response.json(success({ done: true }));
  };
  const result = await new GatewayClient({ fetch, now: () => 123, nonce: () => 'nonce' }).gateway(session, {
    path: '/read',
    groupId: 'group',
    query: { name: '中文 +' },
  });
  assert.equal(result.session.sso.at, 'rotated-at');
  assert.deepEqual(result.data, { done: true });
});

test('class materials normalize state, dates and resId file endpoints', async () => {
  const raw = {
    resourceId: 'file',
    resourceName: '示例',
    extension: 'pdf',
    resourceLength: 0,
    resourceMd5: 'abc',
    subjectCode: '02',
    subjectName: '数学',
    sharePersonId: 'teacher',
    sharePersonName: '示例教师',
    shareTime: 100,
    learnState: 1,
    learnPhase: 2,
    taskEndTime: 200,
  };
  const fetch = mockFetch((url) => {
    if (url.pathname.endsWith('taskSubjectList'))
      return success({ data: [{ subjectCode: '02', subjectName: '数学' }] });
    if (url.pathname.endsWith('taskListOrderByState')) {
      assert.equal(url.searchParams.get('learnState'), '1');
      assert.equal(url.searchParams.get('extension'), '1');
      assert.equal(url.searchParams.get('startTime'), '2026-01-01');
      return success({ total: 16, data: [raw] });
    }
    if (url.pathname.endsWith('learnTaskByResId')) return success({ data: [raw] });
    assert.equal(url.searchParams.get('resId'), 'file');
    assert.equal(url.searchParams.has('resourceId'), false);
    if (url.pathname.endsWith('/md5')) return success([{ resId: 'file', md5: 'abc' }]);
    return success({ fileUrl: 'https://cdn.example/file.pdf' });
  });
  const study = new StudyClient({ fetch });
  assert.deepEqual((await study.subjects(account())).data, [{ code: '02', name: '数学' }]);
  const page = (
    await study.materialPage(account(), '02', { state: 'learned', type: 'document', startDate: '2026-01-01' })
  ).data;
  assert.equal(page.pageCount, 2);
  assert.equal(page.items[0].learningState, 'learned');
  assert.equal(page.items[0].phase, 'after-class');
  assert.equal(page.items[0].sizeBytes, 0);
  assert.equal((await study.material(account(), 'file')).data.taskEndsAt, 200);
  assert.equal((await study.remoteMd5(account(), 'file')).data, 'abc');
  assert.equal((await study.downloadUrl(account(), 'file')).data, 'https://cdn.example/file.pdf');
});

test('Zhixue subjects, both list buckets, report normalization and read-only submission', async () => {
  const data = (await fixture('zhixue')) as Record<string, Record<string, unknown>>;
  const calls: string[] = [];
  const fetch = mockFetch((url, body, headers) => {
    calls.push(url.pathname);
    const params = body.params as Record<string, unknown>;
    if (url.pathname.endsWith('/subjects')) return zhixueSuccess([{ code: '02', name: '数学' }]);
    if (url.pathname.endsWith('/stuHwList')) {
      assert.equal(headers.get('user-agent'), AUTH_CONFIG.zhixue.httpUserAgent);
      return zhixueSuccess({
        totalPages: 1,
        totalElements: 1,
        page: 1,
        size: 10,
        content: [{ ...data.definition, commit: params.status === 1 }],
      });
    }
    assert.equal(headers.get('authorization'), 'test-cas-token');
    assert.equal(params.studentId, 'student');
    if (url.pathname.endsWith('/detail')) return zhixueSuccess(data.definition);
    if (url.pathname.endsWith('/stuhomework/get')) return zhixueSuccess(data.submission);
    if (url.pathname.endsWith('/attachment/list')) return zhixueSuccess([]);
    if (url.pathname.endsWith('/studentReport')) return zhixueSuccess(data.report);
    if (url.pathname.endsWith('/getStuReportDetail')) return zhixueSuccess(data.reportDetails);
    throw new Error(`Unexpected read ${url.pathname}`);
  });
  const client = new ZhixueClient({ fetch });
  assert.deepEqual((await client.subjects(account())).data, [{ code: '02', name: '数学' }]);
  for (const bucket of ['active', 'completed'] as const) {
    const page = (await client.homeworkPage(account(), { bucket })).data;
    assert.equal(page.items[0].state.bucket, bucket);
    assert.equal(page.items[0].state.submitted, bucket === 'completed');
  }
  const detail = (await client.details(account(), 'homework')).data;
  assert.equal(detail.description, '<p>报告说明</p>');
  assert.equal(detail.submission?.score, 8);
  assert.equal(detail.report?.scoreRate, 0.8);
  assert.equal(detail.attachments[0].name, '示例.pdf');
  const question = detail.questions[0].children[0];
  assert.equal(question.answerHtml, '\\(\\frac{1}{2}\\) 或 \\(0.5\\)');
  assert.equal(question.studentAnswerHtml, '\\(\\frac{1}{2}\\)');
  assert.equal(question.score, 8);
  assert.deepEqual(question.mediaUrls, [
    'https://cdn.example/equation.svg',
    'https://cdn.example/comment.mp3',
    'https://cdn.example/work.png',
  ]);
  assert.equal(
    calls.some((path) => /submit|revise/.test(path)),
    false,
  );
});

test('habit attachments include preview and conversion images; spoken reports use their own endpoint', async () => {
  const fetch = mockFetch((url) => {
    if (url.pathname.endsWith('/detail'))
      return zhixueSuccess({ hwId: 'habit', stuHwId: 'student-homework', hwType: 107, classId: 'class' });
    if (url.pathname.endsWith('/attachment/list')) return zhixueSuccess([]);
    if (url.pathname.endsWith('/answer/preview'))
      return zhixueSuccess({
        hwTopicAttachments: [
          { id: 'file', path: 'https://cdn.example/file.docx', convertedId: 'conversion' },
        ],
      });
    if (url.pathname.endsWith('/convert/query'))
      return zhixueSuccess({ convertedPaths: ['https://cdn.example/page.png'] });
    throw new Error('Unexpected read');
  });
  const files = (await new ZhixueClient({ fetch }).attachments(account(), 'habit')).data;
  assert.deepEqual(files[0].previewImageUrls, ['https://cdn.example/page.png']);
  assert.equal(files[0].extension, 'docx');
  let spokenCalls = 0;
  const spoken = new ZhixueClient({
    fetch: mockFetch((url, _body, headers) => {
      if (url.pathname.endsWith('/detail'))
        return zhixueSuccess({ hwId: 'spoken', stuHwId: 'student-homework', hwType: 110 });
      spokenCalls += 1;
      assert.equal(url.pathname, '/hwreport/spoken/stuReportOverView');
      assert.equal(headers.get('user-agent'), AUTH_CONFIG.zhixue.httpUserAgent);
      return zhixueSuccess({ stuOverView: { stuScore: 0, totalScore: 100 }, answerQuestionTypeList: [] });
    }),
  });
  assert.equal((await spoken.report(account(), 'spoken')).data.score, 0);
  assert.equal((await spoken.reportDetails(account(), 'spoken')).data, undefined);
  assert.equal(spokenCalls, 1);
});

test('homework question groups preserve recursive content, answers, options and embedded media', () => {
  const [root] = normalizeHomeworkQuestions([
    {
      id: 'root',
      content: '<p>Passage</p>',
      childrenQuestions: [
        {
          id: 'child',
          optionsList: ['A. <b>Yes</b>', 'B、No'],
          answer: 'A',
          analysis: '<video src="https://cdn.example/video.mp4"></video>',
          studentAnswer: '<p>A</p>',
          score: 0,
          totalScore: 2,
        },
      ],
    },
  ]);
  assert.equal(root.stemHtml, '<p>Passage</p>');
  assert.deepEqual(root.children[0].optionsHtml, ['<b>Yes</b>', 'No']);
  assert.equal(root.children[0].studentAnswerHtml, '<p>A</p>');
  assert.deepEqual(root.mediaUrls, ['https://cdn.example/video.mp4']);
});

test('Zhixue definition wrappers expose child answers and option counts from attached answer sheets', async () => {
  const data = (await fixture('zhixue')) as { definition: { questions: unknown[] } };
  const [question] = normalizeHomeworkQuestions(data.definition.questions);
  assert.equal(question.id, 'definition-question');
  assert.equal(question.typeName, '选择题');
  assert.equal(question.totalScore, 10);
  assert.equal(question.score, undefined);
  const child = question.children[0];
  assert.equal(child.id, 'definition-child');
  assert.equal(child.typeName, '选择题');
  assert.deepEqual(child.optionsHtml, ['', '', '', '']);
  assert.equal(child.studentAnswerHtml, '\\(B\\)');
  assert.deepEqual(child.mediaUrls, ['https://cdn.example/answer.png']);
});

test('Xinjiaoyu handshake signing and caller-owned session carry safeCode forward', async () => {
  let handshakeCount = 0;
  const client = new APIClient({
    rateLimit,
    fetch: mockFetch((url, _body, headers) => {
      assert.equal(headers.get('referer'), 'https://www.xinjiaoyu.com/teacher/question_base_paper/selectNew');
      if (url.pathname.endsWith('/system/code')) {
        handshakeCount += 1;
        assert.equal(url.searchParams.get('clientSessionId'), xjSession.clientSessionId);
        assert.equal(headers.get('clientsession'), xjSession.clientSessionId);
        assert.equal(headers.get('device'), xjSession.device);
        assert.equal(headers.get('devicetype'), xjSession.deviceType);
        assert.equal(headers.get('authorization'), `JBY ${xjSession.token}`);
        assert.equal(headers.get('accesstoken'), xjSession.accessToken);
        assert.equal(headers.get('encrypt'), '');
        assert.equal(
          url.searchParams.get('encrypt'),
          createHandshakeEncrypt(url.searchParams.get('clientSessionId')!, Number(url.searchParams.get('t'))),
        );
        return success(encryptSafeCode('safe-code'));
      }
      assert.equal(headers.get('authorization'), `JBY ${xjSession.token}`);
      assert.equal(headers.get('accesstoken'), 'test-access');
      assert.equal(headers.get('clientsession'), xjSession.clientSessionId);
      assert.equal(
        headers.get('encrypt'),
        createRequestEncrypt('safe-code', headers.get('clientsession')!, Number(headers.get('t'))),
      );
      return success([]);
    }),
  });
  const { safeCode: _safeCode, ...input } = xjSession;
  const result = await client.get(input, '/read');
  assert.equal(result.session.safeCode, 'safe-code');
  assert.equal('safeCode' in input, false);
  await client.get(result.session, '/read');
  assert.equal(handshakeCount, 1);
  await client.get(input, '/read');
  assert.equal(handshakeCount, 2);
  await rejectsCode(client.get({ ...input, clientSessionId: '' }, '/read'), 'unauthenticated');
  assert.equal(handshakeCount, 2);
});

test('Xinjiaoyu subjects, all textbook editions and recursive scene question types', async () => {
  const editions: string[] = [];
  const provider = new XinjiaoyuProvider({
    rateLimit,
    fetch: mockFetch((url, body) => {
      if (url.pathname.endsWith('/audit/cfg/query'))
        return success({
          unints: [
            {
              auditGroups: [
                { courseId: '2', course: '数学', phaseId: '10000' },
                { courseId: '1', course: '语文', phaseId: '10000' },
                { courseId: '3', course: '初中科目', phaseId: 'other' },
              ],
            },
          ],
        });
      if (url.pathname.endsWith('/byScene'))
        return success([
          {
            questionsTypeList: [
              { id: 'reading', name: '阅读', isSubjective: false, children: [{ id: 'cloze', name: '完形' }] },
            ],
          },
          { questionsTypeList: [{ id: 'listen', name: '听力', isSubjective: false }] },
        ]);
      if (url.pathname.endsWith('/textbook/type/list'))
        return success({ rows: [{ key: 'edition1' }, { key: 'edition2' }] });
      editions.push(String(body.textBookTypeId));
      return success({ records: [{ id: body.textBookTypeId, textBookName: '示例教材' }] });
    }),
  });
  assert.deepEqual(
    (await provider.subjects(xjSession)).data.map((subject) => subject.code),
    ['1', '2'],
  );
  const types = (await provider.types(xjSession, '1')).data;
  assert.equal(types[0].children[0].id, 'cloze');
  assert.equal(types[1].id, 'listen');
  assert.equal((await provider.books(xjSession, '1')).data.length, 2);
  assert.deepEqual(editions, ['edition1', 'edition2']);
});

test('provider rejections log service, path, code and message with request identities redacted', async (t) => {
  const warnings = t.mock.method(console, 'warn', () => {});
  const client = new APIClient({
    rateLimit,
    fetch: mockFetch(() => ({
      code: 416,
      msg: `登录会话不匹配 JBY ${xjSession.token} test-access test-client`,
    })),
  });
  await rejectsCode(client.get(xjSession, '/api/v3/read'), 'unauthenticated');
  assert.deepEqual(warnings.mock.calls[0].arguments, [
    'Learning provider rejected',
    {
      provider: 'xinjiaoyu',
      path: '/api/v3/read',
      code: 416,
      message: '登录会话不匹配 [redacted] [redacted] [redacted]',
    },
  ]);
  const auth = new AuthClient({
    fetch: async () => Response.json({ code: '401', message: '登录被拒绝' }),
  });
  await rejectsCode(auth.captchaPolicy(), 'unauthenticated');
  assert.equal(warnings.mock.calls[warnings.mock.calls.length - 1].arguments[1].provider, 'changyan');
  const http = new HttpClient(
    {
      maxRetries: 0,
      fetch: async () => Response.json({ message: '禁止访问 private-user private-cookie' }, { status: 403 }),
    },
    'zhixue',
  );
  await rejectsCode(
    http.json('https://www.zhixue.com/read?account=private-user', {
      headers: { cookie: 'session=private-cookie' },
    }),
    'unauthenticated',
  );
  assert.deepEqual(warnings.mock.calls[warnings.mock.calls.length - 1].arguments[1], {
    provider: 'zhixue',
    path: '/read',
    code: 403,
    message: '禁止访问 [redacted] [redacted]',
  });
  const identities = ['private-name', 'private-id', 'private-query', 'private-body'];
  const rejection = new HttpClient(
    { fetch: async () => Response.json({ code: 416, msg: `拒绝 ${identities.join(' ')}` }) },
    'xinjiaoyu',
  );
  await rejection.json('https://www.xinjiaoyu.com/read?search=private-query', {
    method: 'POST',
    headers: {
      authorization: `JBY ${jwt({ sub: JSON.stringify({ name: identities[0], id: identities[1] }) })}`,
    },
    body: JSON.stringify({ nested: { value: identities[3] } }),
  });
  assert.deepEqual(warnings.mock.calls[warnings.mock.calls.length - 1].arguments[1], {
    provider: 'xinjiaoyu',
    path: '/read',
    code: 416,
    message: '拒绝 [redacted] [redacted] [redacted] [redacted]',
  });
});

test('410 means unauthenticated only for Xinjiaoyu', () => {
  for (const [service, code] of [
    ['新教育', 'unauthenticated'],
    ['畅言', 'rejected'],
    ['智学', 'rejected'],
  ]) {
    assert.throws(
      () => serviceError(410, service),
      (error: unknown) => error instanceof RemoteKitError && error.code === code,
    );
  }
});

test('Xinjiaoyu no textbook type, no books and empty catalog still permit querying', async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let types: unknown[] = [];
  const provider = new XinjiaoyuProvider({
    rateLimit,
    fetch: mockFetch((url, body) => {
      requests.push({ path: url.pathname, body });
      if (url.pathname.endsWith('/textbook/type/list')) return success(types);
      if (url.pathname.endsWith('/textbook/list') || url.pathname.endsWith('/catalogNew/list'))
        return success([]);
      return success({ current: '1', size: '10', pages: '0', total: '0', realTotal: '0', records: [] });
    }),
  });
  assert.deepEqual((await provider.books(xjSession, 'subject')).data, []);
  types = [{ key: 'edition' }];
  assert.deepEqual((await provider.books(xjSession, 'subject')).data, []);
  assert.deepEqual((await provider.catalog(xjSession)).data, []);
  await provider.questions(xjSession, 'subject', { pageSize: 1 });
  const all = requests[requests.length - 1].body;
  assert.equal(all.size, 10);
  assert.equal('textBookId' in all, false);
  assert.equal(all.isAllBook, true);
  assert.deepEqual(all.dimensionTagList, []);
  await provider.questions(xjSession, 'subject', { textbookId: 'empty-book' });
  const empty = requests[requests.length - 1].body;
  assert.equal(empty.textBookId, 'empty-book');
  assert.equal(empty.isAllBook, true);
  assert.deepEqual(empty.dimensionTagList, []);
});

test('Xinjiaoyu explicit null represents an empty resource or empty search result', async () => {
  const provider = new XinjiaoyuProvider({ rateLimit, fetch: mockFetch(() => success(null)) });
  assert.deepEqual((await provider.books(xjSession, 'subject')).data, []);
  assert.deepEqual((await provider.catalog(xjSession, 'book')).data, []);
  assert.deepEqual((await provider.questions(xjSession, 'subject', { textbookId: 'book' })).data, {
    page: 1,
    pageSize: 20,
    pageCount: 0,
    total: 0,
    accessibleTotal: 0,
    items: [],
  });
});

test('Xinjiaoyu subtree filtering excludes siblings and hidden tags, preserves filters and accessible totals', async () => {
  const bodies: Record<string, unknown>[] = [];
  const tree = [
    {
      key: 'root',
      value: '章',
      dimensionId: 'd',
      labelId: 'root-tag',
      children: [
        {
          key: 'selected',
          value: '节',
          dimensionId: 'd',
          labelId: 'selected-tag',
          children: [
            {
              key: 'hidden',
              value: '隐藏',
              labelStatus: 2,
              dimensionId: 'd',
              labelId: 'hidden-tag',
              children: [{ key: 'visible', value: '可见子节点', dimensionId: 'd', labelId: 'leaf-tag' }],
            },
          ],
        },
        { key: 'sibling', value: '其他节', dimensionId: 'd', labelId: 'sibling-tag' },
      ],
    },
  ];
  const provider = new XinjiaoyuProvider({
    rateLimit,
    fetch: mockFetch((url, body) => {
      if (url.pathname.endsWith('/catalogNew/list')) return success(tree);
      bodies.push(body);
      return success({ current: 2, size: 10, pages: 999, total: 25, realTotal: 1000, records: [] });
    }),
  });
  const page = (
    await provider.questions(xjSession, 'subject', {
      textbookId: 'book',
      catalogId: 'selected',
      page: 2,
      pageSize: 5,
      logicTypeIds: ['cloze-subtype'],
      difficultyIds: ['medium'],
      search: '测试',
      sortOrder: 'oldest',
    })
  ).data;
  assert.equal(page.total, 1000);
  assert.equal(page.accessibleTotal, 25);
  assert.equal(page.pageCount, 3);
  assert.deepEqual(bodies[0].dimensionTagList, [
    { dimensionId: 'd', tagId: 'selected-tag' },
    { dimensionId: 'd', tagId: 'leaf-tag' },
  ]);
  assert.equal(bodies[0].isAllBook, false);
  assert.equal(bodies[0].textBookCatalogId, 'selected');
  assert.deepEqual(bodies[0].logicTypeIds, ['cloze-subtype']);
  assert.deepEqual(bodies[0].difficultyIds, ['medium']);
  assert.equal(bodies[0].search, '测试');
  assert.equal(bodies[0].isDesc, false);
  assert.equal(bodies[0].userId, 'account');
  assert.equal(bodies[0].filterOutUserSchoolId, 'school');
  await provider.questions(xjSession, 'subject', { textbookId: 'book' });
  assert.equal(bodies[1].isAllBook, true);
  assert.equal((bodies[1].dimensionTagList as unknown[]).length, 4);
  await rejectsCode(provider.questions(xjSession, 'subject', { catalogId: 'selected' }), 'invalid_request');
  await rejectsCode(
    provider.questions(xjSession, 'subject', { textbookId: 'book', catalogId: 'missing' }),
    'invalid_request',
  );
});

test('Xinjiaoyu composites, listening, translation and formulas preserve HTML without duplicated labels', async () => {
  const raw = (await fixture('questions')) as Array<Record<string, unknown>>;
  const [english, chinese, formulas] = raw.map(normalizeQuestion);
  assert.equal(english.audioUrl, 'https://cdn.example/listening.mp3');
  assert.equal(english.videoUrl, 'https://cdn.example/lesson.mp4');
  assert.equal(english.listeningTextHtml, '<p>Listening transcript</p>');
  assert.deepEqual(english.children[0].optionsHtml, [
    '<p><span></span> First</p>',
    "<img src='https://cdn.example/option.svg'>",
  ]);
  assert.equal(english.children[0].answerHtml, 'B');
  assert.equal(english.children[0].tags[0].category, '知识');
  assert.equal(english.children[0].sources[0].note, '示例来源');
  assert.equal(english.mediaUrls.includes('https://cdn.example/passage.png?a=1&b=2'), true);
  assert.equal(english.mediaUrls.includes('https://cdn.example/explanation.pdf'), true);
  assert.equal(chinese.translationHtml, '<p>现代汉语译文</p>');
  assert.equal(chinese.answerHtml, '<p>参考答案</p>');
  assert.equal(formulas.stemHtml, raw[2].content);
  assert.equal(formulas.answerHtml, raw[2].answer);
  assert.equal(formulas.analysisHtml, raw[2].decipherment);
  assert.equal(formulas.optionsHtml[0], '<math><mi>F</mi><mo>=</mo><mi>ma</mi></math>');
});

test('media collection includes unquoted attributes, srcset, CSS and nested file URLs', () => {
  assert.deepEqual(
    collectMediaUrls([
      '<img src=https://cdn.example/a.png srcset="https://cdn.example/b.png 2x, https://cdn.example/c.png 3x">',
      '<video poster="https://cdn.example/poster.png"><source src="https://cdn.example/v.mp4"></video>',
      '<div style="background:url(https://cdn.example/style.png)"></div>',
      { path: 'https://cdn.example/file.pdf' },
      '<a href="javascript:alert(1)">ignored</a>',
    ]),
    [
      'https://cdn.example/a.png',
      'https://cdn.example/b.png',
      'https://cdn.example/c.png',
      'https://cdn.example/poster.png',
      'https://cdn.example/v.mp4',
      'https://cdn.example/style.png',
      'https://cdn.example/file.pdf',
    ],
  );
});

test('provider auth errors are distinct, malformed payloads are internal and failures never expose response text', async () => {
  for (const code of [401, 410, 416, 900004]) {
    const client = new APIClient({
      rateLimit,
      fetch: mockFetch(() => ({ code, msg: 'private-token-must-not-leak' })),
    });
    await rejectsCode(client.get(xjSession, '/read'), 'unauthenticated');
  }
  await rejectsCode(
    new ZhixueClient({ fetch: mockFetch(() => ({ code: '900004' })) }).subjects(account()),
    'unauthenticated',
  );
  await rejectsCode(
    new GatewayClient({ fetch: mockFetch(() => success(null)) }).gateway(account(), {
      path: '/read',
      groupId: 'group',
    }),
    'internal',
  );
  await rejectsCode(
    new APIClient({ rateLimit, fetch: mockFetch(() => ({ data: [] })) }).get(xjSession, '/read'),
    'internal',
  );
  await rejectsCode(
    new HttpClient({ fetch: async () => new Response('private-token-must-not-leak'), maxRetries: 0 }).json(
      'https://example.test',
    ),
    'internal',
  );
  const denied = new APIClient({
    rateLimit,
    fetch: mockFetch(() => ({ code: 400, msg: 'private-token-must-not-leak' })),
  });
  await assert.rejects(
    denied.get(xjSession, '/read'),
    (error: unknown) => error instanceof RemoteKitError && !error.message.includes('private-token'),
  );
});

test('HTTP and business transient failures retry; transport timeouts on reads are unavailable', async () => {
  let calls = 0;
  const client = new APIClient({
    rateLimit: { ...rateLimit, maxRetries: 2 },
    fetch: mockFetch(() => {
      calls += 1;
      return calls === 1 ? new Response('', { status: 503 }) : calls === 2 ? { code: 429 } : success([]);
    }),
  });
  assert.deepEqual((await client.get(xjSession, '/read')).data, []);
  assert.equal(calls, 3);
  await rejectsCode(
    new HttpClient({
      fetch: async () => {
        throw new DOMException('timeout', 'TimeoutError');
      },
      maxRetries: 0,
    }).json('https://example.test'),
    'unavailable',
  );
  await rejectsCode(
    new APIClient({
      rateLimit: { ...rateLimit, maxRetries: 1 },
      fetch: mockFetch(() => ({ code: 503 })),
    }).get(xjSession, '/read'),
    'unavailable',
  );
});

test('fetch injection receives an AbortSignal that times out both headers and streamed bytes', async () => {
  const keepAlive = setTimeout(() => undefined, 1_000);
  try {
    const headersTimeout = new HttpClient({
      timeoutMs: 5,
      maxRetries: 0,
      fetch: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
        }),
    });
    await rejectsCode(headersTimeout.json('https://example.test'), 'unavailable');
    const bodyTimeout = new HttpClient({
      timeoutMs: 5,
      maxRetries: 0,
      fetch: async (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
              init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), {
                once: true,
              });
            },
          }),
        ),
    });
    const download = await bodyTimeout.download('https://example.test');
    await rejectsCode(
      (async () => {
        for await (const _chunk of download.stream) {
          /* consume */
        }
      })(),
      'unavailable',
    );
    assert.equal(download.integrity.complete, false);
    assert.equal(download.integrity.bytes, 1);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('rate limiter caps concurrency across callers and continues after rejection', async () => {
  const limiter = new RateLimiter({ concurrency: 1, ...rateLimit });
  let active = 0;
  let maximum = 0;
  await Promise.allSettled(
    [0, 1, 2].map((index) =>
      limiter.schedule(async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        if (index === 1) throw new Error('test failure');
      }),
    ),
  );
  assert.equal(maximum, 1);
});

test('streaming download meters chunks incrementally, checks integrity and cancels partial reads', async () => {
  let cancelled = false;
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
  const expectedMd5 = createHash('md5').update(chunks[0]).update(chunks[1]).digest('hex');
  const http = new HttpClient({
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            chunks.forEach((chunk) => controller.enqueue(chunk));
            controller.close();
          },
        }),
        { headers: { 'content-length': '4', 'content-type': 'application/octet-stream' } },
      ),
  });
  const download = await http.download('https://cdn.example/file', {}, { size: 4, md5: expectedMd5 });
  assert.equal(download.integrity.bytes, 0);
  assert.equal(download.integrity.md5, undefined);
  assert.equal(download.size, 4);
  let count = 0;
  for await (const chunk of download.stream) {
    count += 1;
    assert.equal(download.integrity.bytes, count * 2);
    assert.equal(chunk.byteLength, 2);
  }
  assert.deepEqual(download.integrity, { bytes: 4, md5: expectedMd5, complete: true });
  const partial = await new HttpClient({
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  }).download('https://cdn.example/file');
  for await (const _chunk of partial.stream) break;
  assert.equal(cancelled, true);
  assert.equal(partial.integrity.complete, false);
  assert.equal(partial.integrity.md5, undefined);
  const mismatch = await http.download('https://cdn.example/file', {}, { size: 0 });
  await rejectsCode(
    (async () => {
      for await (const _chunk of mismatch.stream) {
        /* consume */
      }
    })(),
    'unavailable',
  );
  assert.equal(mismatch.integrity.complete, false);
});
