import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { ControlDatabase } from '../server/persistence/database';
import { FileLibrary } from '../server/files/library';
import { LearningAccounts } from '../server/learning/accounts';
import { StudyService } from '../server/learning/study-service';
import { StudySync } from '../server/learning/study-sync';
import { StudyClient } from '../server/learning/providers/changyan/study';
import { ZhixueClient } from '../server/learning/providers/changyan/zhixue';
import { HttpClient } from '../server/learning/providers/http';
import { MediaProxy } from '../server/learning/media-proxy';
import { FILE_LIMITS } from '../shared/product';
import type { ClassMaterial, HomeworkDetail } from '../server/learning/providers/models';
import { RemoteKitError } from '../shared/errors';

const DAY = 86400_000;
const page = <T>(items: T[]) => ({
  items,
  page: 1,
  pageSize: 15,
  pageCount: items.length ? 1 : 0,
  total: items.length,
  accessibleTotal: items.length,
});
function fixture() {
  const store = new ControlDatabase(':memory:', { buildId: 'test' });
  let now = Date.now();
  const accounts = new LearningAccounts(store, () => {}, undefined, undefined, Buffer.alloc(32));
  accounts.save(
    'tenant',
    'changyan',
    {
      sso: { tgt: 'tgt', at: 'at', userId: 'user' },
      changyan: {
        token: 'token',
        userId: 'user',
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60 * DAY).toISOString(),
      },
      zhixue: {
        token: 'zhixue-token',
        accountId: 'user',
        studentId: 'student',
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60 * DAY).toISOString(),
      },
    },
    '学生',
  );
  const data = Buffer.from('downloaded document');
  let requests = 0;
  let active = 0;
  let maximum = 0;
  let fail = false;
  const downloads = new Map<string, Buffer>();
  const http = new HttpClient({
    fetch: async (input) => {
      requests++;
      if (fail) return new Response('wrong bytes');
      const bytes = downloads.get(String(input)) ?? data;
      return new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes.length) } });
    },
  });
  const materials: ClassMaterial[] = [
    {
      id: 'material',
      name: '讲义',
      extension: 'pdf',
      sizeBytes: data.length,
      md5: createHash('md5').update(data).digest('hex'),
      subject: { code: 'math', name: '数学' },
      sharedAt: now,
    },
  ];
  const studyProvider = new StudyClient();
  const queries: unknown[] = [];
  studyProvider.subjects = async (session) => ({ session, data: [{ code: 'math', name: '数学' }] });
  studyProvider.materialPage = async (session, subject, query) => {
    queries.push({ subject, ...query });
    return { session, data: page(materials) };
  };
  studyProvider.material = async (session, id) => ({
    session,
    data: materials.find((item) => item.id === id)!,
  });
  studyProvider.download = async (session, material) => ({
    session,
    data: await http.download(
      'https://cdn.example/file',
      {},
      { size: material.sizeBytes, md5: material.md5 },
    ),
  });
  const homeworkProvider = new ZhixueClient();
  homeworkProvider.subjects = async (session) => ({ session, data: [] });
  const buckets: string[] = [];
  const homework: HomeworkDetail = {
    id: 'homework',
    title: '练习',
    startsAt: now,
    subject: { code: 'math', name: '数学' },
    state: { submitted: true },
    description: '<p>说明</p>',
    questions: [],
    attachments: [
      {
        id: 'attachment',
        name: '习题',
        extension: 'txt',
        sizeBytes: data.length,
        url: 'https://cdn.example/homework',
      },
    ],
  };
  homeworkProvider.homeworkPage = async (session, query) => {
    buckets.push(query?.bucket ?? '');
    return { session, data: page([homework]) };
  };
  homeworkProvider.details = async (session) => ({ session, data: homework });
  homeworkProvider.download = async (session, item) => ({
    session,
    data: await http.download(item.url, {}, { size: item.sizeBytes }),
  });
  const rendered: string[] = [];
  const derived = new Map<string, string>();
  let puts = 0;
  const objects = {
    require() {},
    checkQuota() {},
    derived(id: string) {
      return derived.get(id);
    },
    render(id: string) {
      rendered.push(id);
      derived.set(id, 'document-' + id);
    },
    async put(
      _tenant: string,
      chunks: AsyncIterable<Uint8Array>,
      options: { maxBytes: number; signal?: AbortSignal },
    ) {
      active++;
      maximum = Math.max(maximum, active);
      try {
        const parts: Buffer[] = [];
        for await (const chunk of chunks) {
          assert.ok(!options.signal?.aborted);
          parts.push(Buffer.from(chunk));
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        const bytes = Buffer.concat(parts);
        assert.ok(bytes.length <= options.maxBytes);
        const id = createHash('sha256').update(bytes).digest('hex');
        puts++;
        return { id, size: bytes.length };
      } finally {
        active--;
      }
    },
  };
  const library = new FileLibrary(
    store.library,
    {
      describeAsset: async () => {
        throw Error('unexpected');
      },
      prepareSelection: async () => ({ accepted: true }),
      selectionStatus: async () => ({ state: 'pending' }),
    },
    FILE_LIMITS,
    objects,
    () => null,
  );
  let study: StudyService;
  const sync = new StudySync(
    store,
    accounts,
    library,
    objects,
    () => study,
    () => {},
    () => now,
    () => 0.5,
  );
  study = new StudyService(
    'tenant',
    accounts,
    new MediaProxy(),
    (key) => sync.saved('tenant', key),
    studyProvider,
    homeworkProvider,
    () => now,
  );
  library.onDeleted = (tenant, ids) => sync.dismiss(tenant, ids);
  const updates: number[] = [];
  library.onChanged = (_tenant, snapshot) => updates.push(snapshot.revision);
  return {
    store,
    accounts,
    library,
    sync,
    study,
    materials,
    homework,
    homeworkProvider,
    studyProvider,
    objects,
    downloads,
    rendered,
    buckets,
    queries,
    updates,
    get requests() {
      return requests;
    },
    get puts() {
      return puts;
    },
    get maximum() {
      return maximum;
    },
    fail(value: boolean) {
      fail = value;
    },
    advance(days: number) {
      now += days * DAY;
    },
    async close() {
      await sync.stop();
      store.db.close();
    },
  };
}

test('sync collects both homework buckets and material states, imports once and pushes library changes', async () => {
  const f = fixture();
  try {
    assert.equal(f.sync.sync('tenant').syncing, true);
    await f.sync.idle('tenant');
    const entries = f.store.library.snapshot('tenant').entries;
    assert.equal(entries.length, 2);
    assert.deepEqual(new Set(f.buckets), new Set(['active', 'completed']));
    assert.deepEqual(
      new Set((f.queries as { state: string }[]).map((query) => query.state)),
      new Set(['pending', 'learned']),
    );
    assert.deepEqual(entries.map((entry) => entry.name).sort(), ['习题.txt', '讲义.pdf']);
    assert.ok(
      entries.every(
        (entry) => entry.source?.app === 'study' && entry.source.channel === '数学' && entry.collected,
      ),
    );
    assert.deepEqual(new Set(entries.map((entry) => entry.detail)), new Set(['练习', '讲义']));
    assert.ok(f.rendered.length && f.updates.length);
    assert.equal(f.sync.state('tenant').syncing, false);
    assert.ok(f.sync.state('tenant').lastSyncAt);
    assert.equal((await f.study.detail('homework')).attachmentsSaved, 1);
    assert.equal((await f.study.detail('homework')).status, 'submitted');
    f.sync.sync('tenant');
    await f.sync.idle('tenant');
    assert.equal(f.puts, 2);
    assert.equal(f.rendered.length, 1);
    assert.ok(!JSON.stringify(f.sync.diagnostics('tenant')).includes('token'));
  } finally {
    await f.close();
  }
});

test('background homework sync resolves missing list dates, pages both buckets and saves question attachments without opening a Viewer', async () => {
  const f = fixture();
  const detailCalls: string[] = [];
  const listCalls: string[] = [];
  try {
    f.materials.splice(0);
    const image = Buffer.alloc(f.homework.attachments[0].sizeBytes!);
    image.write('\x89PNG\r\n\x1a\n', 'latin1');
    f.downloads.set('https://cdn.example/image', image);
    const now = f.homework.startsAt!;
    f.homeworkProvider.homeworkPage = async (session, query) => {
      const id = `${query?.bucket}-${query?.page}`;
      listCalls.push(id);
      return { session, data: { ...page([{ ...f.homework, id, startsAt: undefined }]), pageCount: 2 } };
    };
    f.homeworkProvider.details = async (session, id) => {
      detailCalls.push(id);
      return {
        session,
        data: {
          ...f.homework,
          id,
          startsAt: id.endsWith('-2') ? now - 8 * DAY : now,
          attachments: [
            {
              ...f.homework.attachments[0],
              id,
              extension: id.startsWith('active') ? 'docx' : 'png',
              url: id.startsWith('active') ? 'https://cdn.example/document' : 'https://cdn.example/image',
            },
          ],
        },
      };
    };
    f.sync.sync('tenant');
    await f.sync.idle('tenant');
    assert.deepEqual(listCalls, ['active-1', 'active-2', 'completed-1', 'completed-2']);
    assert.equal(detailCalls.length, 4);
    assert.equal(f.puts, 2);
    assert.equal(f.rendered.length, 1);
    assert.equal(f.store.library.snapshot('tenant').entries.length, 2);
    f.sync.sync('tenant');
    await f.sync.idle('tenant');
    assert.equal(f.puts, 2);
    assert.equal(f.rendered.length, 1);
  } finally {
    await f.close();
  }
});

test('a second tenant downloading identical bytes reuses the derived document', async () => {
  const f = fixture();
  try {
    f.sync.sync('tenant');
    await f.sync.idle('tenant');
    f.accounts.save('second', 'changyan', f.accounts.session('tenant', 'changyan'));
    const study = new StudyService(
      'second',
      f.accounts,
      new MediaProxy(),
      () => ({ state: 'not_saved' }),
      f.studyProvider,
      f.homeworkProvider,
    );
    const sync = new StudySync(
      f.store,
      f.accounts,
      f.library,
      f.objects,
      () => study,
      () => {},
    );
    try {
      sync.sync('second');
      await sync.idle('second');
      assert.equal(f.puts, 4);
      assert.equal(f.rendered.length, 1);
      assert.deepEqual(
        new Set(f.store.library.snapshot('tenant').entries.map((entry) => entry.assetId)),
        new Set(f.store.library.snapshot('second').entries.map((entry) => entry.assetId)),
      );
    } finally {
      await sync.stop();
    }
  } finally {
    await f.close();
  }
});

test('retention drops study references for partitions and deletes unorganized entries using max dates', async () => {
  const f = fixture();
  try {
    f.sync.sync('tenant');
    await f.sync.idle('tenant');
    const snapshot = f.store.library.snapshot('tenant');
    const organized = snapshot.entries.find((entry) => entry.name === '讲义.pdf')!;
    snapshot.partitions.push({ id: 'partition', name: '已整理' });
    organized.partitionId = 'partition';
    f.store.library.save('tenant', snapshot);
    f.advance(6);
    await f.sync.retention('tenant');
    assert.equal(f.store.library.snapshot('tenant').entries.length, 2);
    f.advance(2);
    await f.sync.settings('tenant', 7);
    const remaining = f.store.library.snapshot('tenant').entries;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, organized.id);
    assert.equal(remaining[0].source, null);
    assert.equal(remaining[0].partitionId, 'partition');
    assert.equal(remaining[0].collected, false);
    assert.equal(f.sync.saved('tenant', 'changyan:material').state, 'saved');
    assert.equal(f.sync.saved('tenant', 'zhixue:attachment').state, 'not_saved');
    await assert.rejects(f.sync.settings('tenant', 61));
  } finally {
    await f.close();
  }
});

test('user deletion dismisses the download, automatic sync does not recreate it, explicit save can', async () => {
  const f = fixture();
  try {
    f.sync.sync('tenant');
    await f.sync.idle('tenant');
    const entry = f.store.library.snapshot('tenant').entries.find((entry) => entry.name === '讲义.pdf')!;
    await f.library.request(
      'tenant',
      'library.delete',
      { operationId: 'delete', ids: [entry.id] },
      () => {},
      () => undefined,
    );
    assert.equal(
      (
        f.store.db.prepare("SELECT state FROM learning_downloads WHERE key='changyan:material'").get() as {
          state: string;
        }
      ).state,
      'dismissed',
    );
    f.sync.sync('tenant');
    await f.sync.idle('tenant');
    assert.equal(f.puts, 2);
    const saved = await f.sync.save('tenant', 'changyan:material');
    assert.ok(f.library.entryExists('tenant', saved.entryId));
    assert.equal(f.puts, 3);
  } finally {
    await f.close();
  }
});

test('integrity failure is retried, progress is transient, on-demand saves deduplicate and tenant concurrency is two', async () => {
  const f = fixture();
  try {
    f.fail(true);
    await f.study.materials({ subjectCode: 'math', state: 'pending', type: 'all', page: 1 });
    await assert.rejects(f.sync.save('tenant', 'changyan:material'));
    assert.equal(f.store.library.snapshot('tenant').entries.length, 0);
    assert.equal(f.sync.saved('tenant', 'changyan:material').state, 'failed');
    f.fail(false);
    const first = f.sync.save('tenant', 'changyan:material');
    assert.equal(first, f.sync.save('tenant', 'changyan:material'));
    await first;
    assert.equal(f.sync.saved('tenant', 'changyan:material').state, 'saved');
    for (let index = 0; index < 6; index++) f.materials.push({ ...f.materials[0], id: 'extra' + index });
    f.advance(1 / DAY);
    f.study.clear();
    await f.study.materials({ subjectCode: 'math', state: 'pending', type: 'all', page: 1 });
    await Promise.all(f.materials.slice(1).map((item) => f.sync.save('tenant', 'changyan:' + item.id)));
    assert.equal(f.maximum, 2);
  } finally {
    await f.close();
  }
});

test('outside-window on-demand save uses the saved date for retention and sign-out keeps files', async () => {
  const f = fixture();
  try {
    f.materials[0].sharedAt! -= 30 * DAY;
    const { entryId } = await f.sync.save('tenant', 'changyan:material');
    await f.sync.retention('tenant');
    assert.ok(f.library.entryExists('tenant', entryId));
    f.accounts.delete('tenant', 'changyan');
    await f.sync.stopTenant('tenant');
    assert.ok(f.library.entryExists('tenant', entryId));
    assert.throws(() => f.sync.save('tenant', 'changyan:material'), RemoteKitError);
  } finally {
    await f.close();
  }
});

test('the sync scheduler admits four tenants at once', async () => {
  const f = fixture();
  const releases: (() => void)[] = [];
  let active = 0;
  let maximum = 0;
  let started = 0;
  f.study.collect = async () => {
    active++;
    started++;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active--;
    return [];
  };
  try {
    const session = f.accounts.session('tenant', 'changyan');
    for (let index = 0; index < 6; index++) {
      f.accounts.save('tenant-' + index, 'changyan', session, '学生');
      f.sync.sync('tenant-' + index);
    }
    for (let index = 0; index < 100 && started < 4; index++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(started, 4);
    releases.splice(0).forEach((release) => release());
    for (let index = 0; index < 100 && started < 6; index++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(started, 6);
    releases.splice(0).forEach((release) => release());
    await Promise.all(Array.from({ length: 6 }, (_, index) => f.sync.idle('tenant-' + index)));
    assert.equal(maximum, 4);
  } finally {
    releases.splice(0).forEach((release) => release());
    await f.close();
  }
});
