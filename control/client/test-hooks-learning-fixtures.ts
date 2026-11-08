import rawQuestions from '../test/fixtures/learning/questions.json';
import zhixue from '../test/fixtures/learning/zhixue.json';
import rendition from '../test/fixtures/pdfrender-smoke.json';
import type { BankQuestion, HomeworkDetail, LearningPage } from '../shared/learning';
import type { LibrarySnapshot } from '../shared/file-library';
import type { ProductState, SocketMethods } from '../shared/product';

export const LEARNING_MOCK_MARKER = 'remotekit-learning-dev-fixture';
const now = new Date(2026, 10, 9, 16).getTime();
const media = (html: string) =>
  html.replace(/https:\/\/cdn\.example\/[^\s"'<>]+/g, '/api/learning/media/mock-image');
function normalize(raw: any): BankQuestion {
  return {
    id: raw.id,
    typeName: raw.typeName,
    difficulty: raw.difficultyName ?? '中等',
    isSubjective: !!raw.isSubjective,
    stemHtml: media(raw.content ?? ''),
    optionsHtml: (raw.optionsList ?? []).map(media),
    answerHtml: media(raw.answer ?? ''),
    analysisHtml: media(raw.decipherment ?? ''),
    listeningTextHtml: raw.listeningText,
    translationHtml: raw.chineseText,
    audioUrl: raw.questionAudio ? '/api/learning/media/mock-audio' : undefined,
    children: (raw.childrenQuestions ?? []).map(normalize),
    tags: (raw.tagFeatureInfo ?? []).map((tag: any) => tag.tagName),
    source: raw.sourceFeatureInfo?.[0]?.sourceName ?? '校本精选 · 同步练习',
  };
}
export const bankFixtures = rawQuestions.map(normalize);
export const libraryFixture: LibrarySnapshot = {
  revision: 1,
  basket: [],
  partitions: [],
  excludedSources: [],
  basketPartitionId: null,
  sources: [{ app: 'study', channel: '数学', count: 2, excluded: false }],
  entries: [
    {
      id: 'learning-file',
      assetId: 'learning-document',
      name: '二次函数课堂讲义.pdf',
      type: 'application/pdf',
      size: 2516582,
      detail: '二次函数的图像与性质',
      source: { app: 'study', channel: '数学' },
      createdAt: now,
      partitionId: null,
      collected: false,
    },
  ],
};
export const homeworkFixture: HomeworkDetail = {
  id: zhixue.definition.hwId,
  title: '二次函数的图像与性质',
  subject: { code: '02', name: '数学' },
  startsAt: now - 3600000,
  endsAt: now + 8 * 3600000,
  status: 'pending',
  attachmentCount: 1,
  attachmentsSaved: 1,
  description: zhixue.definition.description,
  attachments: [
    {
      key: 'zhixue:file',
      name: libraryFixture.entries[0].name,
      sizeBytes: 2516582,
      save: { state: 'saved', entryId: 'learning-file' },
    },
  ],
  questions: [
    {
      id: 'homework-question',
      number: '1',
      typeName: zhixue.reportDetails.mainTopics[0].sectionName,
      stemHtml: media(zhixue.reportDetails.mainTopics[0].subTopics[0].questionTitle),
      optionsHtml: [],
      answerHtml: '1/2',
      studentAnswerHtml: '1/2',
      analysisHtml: '<p>根据等式的性质求解。</p>',
      score: 8,
      totalScore: 10,
      children: [],
    },
  ],
};
export const documentFixture = rendition;
const paged = <T>(items: T[], page: number, pageSize = 8): LearningPage<T> => ({
  page,
  pageSize,
  pageCount: 3,
  total: 12345,
  accessibleTotal: 1000,
  items,
});

export function learningProductFixture(appId = 'study', signed = true): ProductState {
  return {
    serverIncarnation: LEARNING_MOCK_MARKER,
    snapshotSequence: 1,
    operationGeneration: 'mock-generation',
    user: { id: 'learning-mock-user', username: '同学', isAdmin: false },
    learning: {
      accounts: {
        changyan: signed
          ? { status: 'signed_in', displayName: '同学', since: now }
          : { status: 'signed_out' },
        xinjiaoyu: signed
          ? { status: 'signed_in', displayName: '同学', since: now }
          : { status: 'signed_out' },
      },
      study: { retentionDays: 7, syncing: false, lastSyncAt: now },
    },
    workspace: {
      tenantId: 'learning-mock',
      revision: 1,
      windows: [{ id: 'learning-window', appId, activeTabId: null, lastActiveAt: now }],
      tabs: [],
      spaces: [
        {
          id: 'learning-space',
          windowIds: ['learning-window'],
          weights: [1],
          focusedWindowId: 'learning-window',
          lastActiveAt: now,
        },
      ],
      activeSpaceId: 'learning-space',
      apps: [],
      favorites: [],
      sites: {},
      settings: {
        workspace: {
          qualityPreference: 'auto',
          uiScale: 1,
          topDeadZone: 'off',
          showStats: false,
          autoFullscreen: false,
          avSync: false,
          audioChannels: { left: true, right: true },
        },
        browser: { searchEngine: 'bing', memorySaverEnabled: true },
      },
    },
    quality: {
      resourceLimitation: null,
      mode: 'product',
      preference: 'auto',
      clientScale: 1,
      effectiveDpr: 1,
      requested: { audio: false, degradationPreference: 'maintain-resolution', maxFps: 60 },
      applied: null,
      estimatedLatencyMs: null,
      clockUncertaintyMs: null,
      feedbackStatus: 'unknown',
      reason: '',
    },
    endpointGeneration: 1,
    endpointError: null,
    viewer: { connected: true },
    announcements: [],
    pageDialogs: [],
    fileRequests: [],
    integrations: { siteUa: false, lifecycle: false, popupAdoption: false },
  };
}

export class LearningFakeTransport {
  state = learningProductFixture();
  library = structuredClone(libraryFixture);
  calls: { method: string; params: unknown }[] = [];
  fail = '';
  empty = false;
  changed = () => {};
  request = async <K extends keyof SocketMethods>(
    method: K,
    params: SocketMethods[K]['params'],
  ): Promise<SocketMethods[K]['result']> => {
    this.calls.push({
      method,
      params: method === 'learning.signIn' ? { ...params, password: undefined } : params,
    });
    if (method === this.fail) throw new Error('服务暂时不可用');
    const p = params as any;
    let result: unknown;
    switch (method) {
      case 'study.subjects':
        result = {
          subjects: [
            { code: '02', name: '数学', hasPending: true },
            { code: '01', name: '语文', hasPending: true },
            { code: '03', name: '英语', hasPending: false },
            { code: '04', name: '物理', hasPending: false },
            { code: '05', name: '化学', hasPending: false },
          ],
        };
        break;
      case 'study.homework.list':
        result = paged(
          this.empty
            ? []
            : Array.from({ length: 8 }, (_, index) => ({
                ...homeworkFixture,
                id: `homework-${p.page}-${index}`,
                title: [
                  '二次函数的图像与性质',
                  '古诗文阅读与积累',
                  '阅读理解 · 每日练习',
                  '力与运动单元巩固',
                ][index % 4],
                subject: {
                  code: p.subjectCode || ['02', '01', '03', '04'][index % 4],
                  name: ['数学', '语文', '英语', '物理'][index % 4],
                },
                startsAt: now - index * 86400000,
                status: p.bucket === 'completed' ? (index % 2 ? 'submitted' : 'corrected') : 'pending',
                score: p.bucket === 'completed' ? 92 : undefined,
                totalScore: 100,
              })),
          p.page,
        );
        break;
      case 'study.homework.detail':
        result = { ...homeworkFixture, id: p.id };
        break;
      case 'study.materials.list':
        result = paged(
          this.empty
            ? []
            : Array.from({ length: 8 }, (_, index) => ({
                id: `material-${p.page}-${index}`,
                name: `${['二次函数课堂讲义.pdf', '单元复习课件.pptx', '课后拓展练习.docx'][index % 3]}`,
                subject: { code: p.subjectCode, name: '数学' },
                sizeBytes: 2516582,
                sharedBy: '陈老师',
                sharedAt: now - index * 86400000,
                learningState: p.state,
                attachment: { ...homeworkFixture.attachments[0] },
              })),
          p.page,
        );
        break;
      case 'study.attachment.save':
        result = { entryId: 'learning-file' };
        break;
      case 'bank.subjects':
        result = {
          subjects: [
            { id: 'math', name: '数学', stage: '初中' },
            { id: 'chinese', name: '语文', stage: '初中' },
            { id: 'english', name: '英语', stage: '高中' },
          ],
        };
        break;
      case 'bank.subject':
        result = {
          types: [
            { id: 'choice', name: '选择题', children: [{ id: 'single', name: '单选题', children: [] }] },
            { id: 'reading', name: '阅读理解', children: [] },
            { id: 'calculation', name: '计算题', children: [] },
          ],
          difficulties: [
            { id: 'easy', name: '基础' },
            { id: 'middle', name: '中等' },
            { id: 'hard', name: '较难' },
          ],
          textbooks: [{ id: 'book', name: '九年级上册', edition: '人教版' }],
        };
        break;
      case 'bank.catalog':
        result = {
          nodes: [
            {
              id: 'chapter',
              title: '第二十二章 二次函数',
              selectable: true,
              children: [
                { id: 'section', title: '22.1 二次函数的图像和性质', selectable: true, children: [] },
              ],
            },
          ],
        };
        break;
      case 'bank.questions':
        result = paged(
          this.empty
            ? []
            : Array.from({ length: 9 }, (_, index) => ({
                ...bankFixtures[index % bankFixtures.length],
                id: `bank-${p.page}-${index}`,
              })),
          p.page,
          9,
        );
        break;
      case 'document.progress.get':
        result = null;
        break;
      case 'document.progress.set':
        result = { saved: true };
        break;
      case 'library.get':
        result = this.library;
        break;
      case 'library.basket':
        this.library = { ...this.library, revision: this.library.revision + 1, basket: p.ids };
        result = this.library;
        break;
      case 'study.settings':
        this.state.learning.study.retentionDays = p.retentionDays;
        this.changed();
        result = this.state.learning.study;
        break;
      case 'study.sync':
        this.state.learning.study.lastSyncAt = Date.now();
        this.changed();
        result = this.state.learning.study;
        break;
      case 'learning.signIn':
        this.state.learning.accounts[p.provider as 'changyan' | 'xinjiaoyu'] = {
          status: 'signed_in',
          displayName: '同学',
          since: Date.now(),
        };
        this.changed();
        result = { started: true };
        break;
      case 'learning.signInCancel':
      case 'learning.signOut':
        this.state.learning.accounts[p.provider as 'changyan' | 'xinjiaoyu'] = { status: 'signed_out' };
        this.changed();
        result = method === 'learning.signOut' ? { signedOut: true } : { cancelled: true };
        break;
      case 'window.state': {
        const win = this.state.workspace.windows.find((win) => win.id === p.windowId);
        if (win) win.state = p.state;
        this.changed();
        result = { state: this.state };
        break;
      }
      case 'viewport':
      case 'feedback':
        result = this.state;
        break;
      case 'launcher.get':
        result = {
          items: ['study', 'questions', 'files', 'settings'].map((appId) => ({
            key: `app:${appId}`,
            kind: 'app',
            group: 'apps',
            appId,
            title: (
              { study: '学习', questions: '题库', files: '我的文件', settings: '设置' } as Record<
                string,
                string
              >
            )[appId],
            score: 0,
          })),
        };
        break;
      case 'usage.record':
      case 'page.preview':
        result = { recorded: true };
        break;
      default:
        throw new Error(`未模拟的方法 ${method}`);
    }
    return structuredClone(result) as SocketMethods[K]['result'];
  };
}
