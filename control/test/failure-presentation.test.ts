import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteKitError, isErrorId, parseWireError, wireError } from '../shared/errors';
import { presentFailure } from '../client/failures/present';
import { failureText } from '../client/failures/text';
import { Notices } from '../client/failures/notices';
import { recoveryTiming } from '../client/failures/thresholds';
import { ViewerErrorReports } from '../client/failures/reporting';
import { ViewerErrors } from '../server/diagnostics/viewer-errors';
import { configureLog } from '../server/log';
import { findError } from '../server/diagnostics/error-search';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const context = { operation: '导入文件', scope: 'item' as const };

test('an offline dirty-copy owner is an A state with automatic continuation', () => {
  const presentation = presentFailure(
    new RemoteKitError('unavailable', '', {
      reason: 'session_data_on_offline_node',
    }),
    { operation: '连接浏览器', scope: 'surface' },
  );
  assert.equal(presentation.class, 'A');
  assert.equal(presentation.text, '会话数据所在节点离线，恢复后自动继续');
  assert.equal(presentation.action, undefined);
});

test('failure wording names the affected file without inventing batch success', () => {
  const presentation = presentFailure(new RemoteKitError('internal', ''), {
    ...context,
    itemName: '课程资料.pdf',
  });
  assert.equal(presentation.text, '课程资料.pdf 未能导入');
  assert.equal(
    presentFailure(new RemoteKitError('internal', ''), {
      operation: '下载到我的文件',
      scope: 'global',
    }).text,
    '下载的文件未能存入我的文件，网页上的下载不受影响',
  );
  assert.equal(
    presentFailure(new RemoteKitError('limit_exceeded', '', { capacity: 'windows' }), context).text,
    '窗口已满，未能打开',
  );
  assert.doesNotMatch(JSON.stringify(failureText), /仍已|尚未完成/);
});

test('recoverable codes remain A without a manual action', () => {
  for (const code of ['busy', 'rate_limited', 'unavailable', 'outcome_unknown'] as const) {
    const presentation = presentFailure(new RemoteKitError(code, 'technical detail'), context);
    assert.equal(presentation.class, 'A');
    assert.equal(presentation.action, undefined);
    assert.match(presentation.longText!, /恢复后自动继续/);
  }
});

test('user authentication has one concrete B action', () => {
  const presentation = presentFailure(new RemoteKitError('unauthenticated', ''), context);
  assert.equal(presentation.class, 'B');
  assert.equal(presentation.action?.label, '登录');
});

test('final failure gets an immediately searchable Viewer ID', () => {
  const error = new RemoteKitError('internal', 'diagnosis');
  const presentation = presentFailure(error, context);
  assert.equal(presentation.class, 'C');
  assert.match(presentation.text, /未能/);
  assert.match(presentation.errorId!, /^v-[0-9a-f]{10}$/);
  assert.equal(presentation.action, undefined);
  assert.equal(presentFailure(error, context).errorId, presentation.errorId);
});

test('canceled is silent', () => {
  assert.deepEqual(presentFailure(new RemoteKitError('canceled', ''), context), {
    class: 'silent',
    text: '',
  });
});

test('ordinary conflicts show the server message and reserve changed-content wording for revisions', () => {
  for (const message of ['用户名已存在', '在线节点不能移除', '不能转让给已停用的账户']) {
    const presentation = presentFailure(new RemoteKitError('conflict', message), {
      ...context,
      text: 'Generic failure',
    });
    assert.equal(presentation.class, 'B');
    assert.equal(presentation.text, message);
    assert.equal(presentation.action, undefined);
  }
  const revision = presentFailure(new RemoteKitError('conflict', 'Revision differs'), {
    ...context,
    issue: 'revision',
  });
  assert.equal(revision.text, failureText.changed);
  assert.equal(revision.action?.label, '查看当前内容');
});

test('capacity context selects the corrective action', () => {
  const error = new RemoteKitError('limit_exceeded', '');
  for (const [capacity, label] of [
    ['windows', '管理窗口'],
    ['tabs', '管理标签页'],
    ['site-settings', '管理网站设置'],
    ['field', '修改内容'],
    ['selection', '调整所选内容'],
    ['file', '换一个文件'],
    ['storage', '打开我的文件'],
    ['basket', '打开我的文件'],
  ] as const) {
    const presentation = presentFailure(error, { ...context, capacity });
    assert.equal(presentation.class, 'B');
    assert.equal(presentation.action?.label, label);
  }
});

test('reason survives ordinary wire transport and Viewer IDs validate', () => {
  const error = new RemoteKitError('unavailable', '', {
    reason: 'browser_restarting',
    errorId: 'v-0123456789',
  });
  assert.equal(parseWireError(wireError(error))?.reason, 'browser_restarting');
  assert.equal(isErrorId('v-0123456789'), true);
  assert.equal(isErrorId('v-invalid'), false);
  assert.equal(parseWireError({ code: 'internal', message: '', reason: 'unrecognized' })?.reason, undefined);
});

test('notice keys deduplicate, resolve and expire info after four seconds', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const notices = new Notices();
  t.after(() => notices.clear());
  notices.post('a', { class: 'A', text: '正在连接…' });
  notices.post('a', { class: 'A', text: '正在恢复…' });
  assert.equal(notices.getSnapshot().length, 1);
  notices.post('b', { class: 'C', text: '未能完成', errorId: 'v-0123456789' });
  notices.post('c', { class: 'B', text: '已完成' });
  t.mock.timers.tick(3999);
  assert.equal(notices.getSnapshot().length, 3);
  t.mock.timers.tick(1);
  assert.deepEqual(
    notices.getSnapshot().map((item) => item.key),
    ['b', 'a'],
  );
  notices.resolve('b');
  assert.deepEqual(
    notices.getSnapshot().map((item) => item.key),
    ['a'],
  );
});

test('thresholds suppress short recovery and switch to calm wording at 20 or 30 seconds', () => {
  assert.deepEqual(recoveryTiming(0, 1499), { visible: false, long: false, calm: false });
  assert.deepEqual(recoveryTiming(0, 1500), { visible: true, long: false, calm: false });
  assert.equal(recoveryTiming(0, 20000).calm, true);
  assert.equal(recoveryTiming(0, 20000, true).long, true);
  assert.equal(recoveryTiming(0, 29999, true).calm, false);
  assert.equal(recoveryTiming(0, 30000, true).calm, true);
});

test('client.error queue keeps the newest fifty and flushes when online', () => {
  const reports = new ViewerErrorReports();
  const ids: string[] = [];
  for (let index = 0; index < 55; index++) {
    const error = new RemoteKitError('internal', String(index));
    reports.identify(error, context);
    ids.push(error.errorId!);
  }
  assert.equal(reports.queued, 50);
  const sent: string[] = [];
  reports.connect((report) => sent.push(report.errorId));
  assert.deepEqual(sent, ids.slice(5));
  assert.equal(reports.queued, 0);
  reports.connect(() => assert.fail('report was sent twice'));
});

test('Control logs client.error once with tenant and lease', () => {
  const records: string[] = [];
  configureLog({ write: (line) => records.push(line) });
  const receiver = new ViewerErrors();
  const report = { errorId: 'v-0123456789', context, error: { name: 'Error', message: 'detail' } };
  assert.equal(receiver.receive(report, 'tenant', 'lease'), true);
  assert.equal(receiver.receive(report, 'tenant', 'lease'), true);
  assert.equal(records.length, 1);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(JSON.parse(records[0])).filter(([key]) =>
        ['ev', 'lvl', 'tenant', 'lease', 'errorId'].includes(key),
      ),
    ),
    { lvl: 'error', ev: 'viewer.error', tenant: 'tenant', lease: 'lease', errorId: report.errorId },
  );
  assert.equal(receiver.receive({ ...report, errorId: 'c-0123456789' }, 'tenant', 'lease'), false);
});

test('v- lookup searches Control logs without querying Endpoint nodes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remotekit-v-error-'));
  try {
    await writeFile(
      join(directory, 'control.jsonl'),
      JSON.stringify({ errorId: 'v-0123456789', ev: 'viewer.error' }) + '\n',
    );
    const result = await findError('v-0123456789', directory, {
      all: () => {
        throw new Error('must search Control');
      },
    });
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].source, 'control');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrective action notices stay until their source resolves and lease takeover is B', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const notices = new Notices();
  const presentation = presentFailure(new RemoteKitError('unavailable', ''), { ...context, issue: 'lease' });
  assert.equal(presentation.class, 'B');
  notices.post('lease', presentation);
  t.mock.timers.tick(60000);
  assert.equal(notices.getSnapshot()[0].kind, 'failure');
  notices.resolve('lease');
  assert.equal(notices.getSnapshot().length, 0);
});
