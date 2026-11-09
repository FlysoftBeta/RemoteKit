import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { RemoteKitError } from '../../../../shared/errors.js';
import {
  HttpClient,
  type HttpOptions,
  list,
  record,
  text,
  requiredText,
  number,
  malformed,
  positiveInteger,
  serviceError,
} from '../http.js';
import type {
  Attachment,
  HomeworkDetail,
  HomeworkItem,
  HomeworkReport,
  HomeworkSubmission,
  Page,
  ProviderResult,
  Subject,
} from '../models.js';
import type { AccountSession } from './auth.js';
import { AUTH_CONFIG } from './config.js';
import { ZhixueAuthClient, type ZhixueSession } from './zhixue-auth.js';
import { normalizeHomeworkQuestions } from './zhixue-normalize.js';

const HOMEWORK_BASE_URL = 'https://mhw.zhixue.com';
type RequestTemplate = 'native' | 'native-rich' | 'webview-answer' | 'webview-report' | 'webview-habit-rich';

export interface HomeworkQuery {
  page?: number;
  pageSize?: number;
  bucket?: 'active' | 'completed';
  before?: number;
}

export interface HomeworkReportDetail {
  description: string;
  showAnswers?: boolean;
  questions: HomeworkDetail['questions'];
  attachments: Attachment[];
}

export class ZhixueClient {
  private readonly http: HttpClient;
  private readonly auth: ZhixueAuthClient;

  constructor(options: HttpOptions = {}) {
    this.http = new HttpClient(options, 'zhixue');
    this.auth = new ZhixueAuthClient(options);
  }

  private async read<T>(
    input: AccountSession,
    run: (reader: ZhixueReader) => Promise<T>,
  ): Promise<ProviderResult<T, AccountSession>> {
    const session = await this.auth.ensureFresh(input);
    return { session, data: await run(new ZhixueReader(session.zhixue!, this.http)) };
  }

  subjects(session: AccountSession): Promise<ProviderResult<Subject[], AccountSession>> {
    return this.read(session, async (reader) =>
      list(await reader.post('/hw/answer/homework/subjects', {}, 'native')).map((value) => {
        const item = record(value);
        return { code: requiredText(item.code), name: requiredText(item.name) };
      }),
    );
  }

  homeworkPage(
    session: AccountSession,
    query: HomeworkQuery = {},
  ): Promise<ProviderResult<Page<HomeworkItem>, AccountSession>> {
    return this.read(session, async (reader) => {
      const page = positiveInteger(query.page ?? 1, '页码');
      const pageSize = positiveInteger(query.pageSize ?? 10, '每页数量');
      if (pageSize > 100) throw new RemoteKitError('limit_exceeded', '每页数量不能超过 100');
      const bucket = query.bucket ?? 'active';
      const raw = record(
        await reader.post(
          '/hw/stu/stuHwList',
          {
            createTime: query.before ?? Date.now(),
            page,
            size: pageSize,
            status: bucket === 'completed' ? 1 : 0,
          },
          'native',
        ),
      );
      const total = number(raw.totalElements);
      const pageCount = number(raw.totalPages);
      if (total === undefined || pageCount === undefined) return malformed();
      return {
        page: number(raw.page) ?? page,
        pageSize: number(raw.size) ?? pageSize,
        total,
        accessibleTotal: total,
        pageCount,
        items: list(raw.content).map((value) => normalizeHomework(record(value), bucket)),
      };
    });
  }

  details(session: AccountSession, id: string): Promise<ProviderResult<HomeworkDetail, AccountSession>> {
    return this.read(session, async (reader) => {
      const [definition, submission, attachments] = await Promise.all([
        reader.definition(id),
        reader.submission(id),
        reader.attachments(id),
      ]);
      const metadata = normalizeHomework(definition);
      const completed = metadata.state.submitted || submission.committed;
      const [report, reportDetail] = completed
        ? await Promise.all([reader.report(id), reader.reportDetails(id)])
        : [undefined, undefined];
      return {
        ...metadata,
        description: reportDetail?.description || text(definition.description),
        questions: reportDetail?.questions.length
          ? reportDetail.questions
          : normalizeHomeworkQuestions(definition.questions ?? []),
        attachments: deduplicateAttachments([
          ...attachments,
          ...(reportDetail?.attachments ?? []),
          ...(report?.attachments ?? []),
        ]),
        ...(typeof definition.showAnswer === 'boolean' ? { showAnswers: definition.showAnswer } : {}),
        ...(reportDetail?.showAnswers !== undefined ? { showAnswers: reportDetail.showAnswers } : {}),
        submission,
        ...(report ? { report } : {}),
      };
    });
  }

  submission(
    session: AccountSession,
    id: string,
  ): Promise<ProviderResult<HomeworkSubmission, AccountSession>> {
    return this.read(session, (reader) => reader.submission(id));
  }

  report(session: AccountSession, id: string): Promise<ProviderResult<HomeworkReport, AccountSession>> {
    return this.read(session, (reader) => reader.report(id));
  }

  reportDetails(
    session: AccountSession,
    id: string,
  ): Promise<ProviderResult<HomeworkReportDetail | undefined, AccountSession>> {
    return this.read(session, (reader) => reader.reportDetails(id));
  }

  attachments(session: AccountSession, id: string): Promise<ProviderResult<Attachment[], AccountSession>> {
    return this.read(session, (reader) => reader.attachments(id));
  }

  async download(input: AccountSession, attachment: Attachment) {
    const session = await this.auth.ensureFresh(input);
    const data = await this.http.download(
      attachment.url,
      { headers: downloadHeaders(session.zhixue!, attachment) },
      { size: attachment.sizeBytes, md5: attachment.md5 },
    );
    return { session, data };
  }
}

class ZhixueReader {
  private readonly definitions = new Map<string, Promise<Record<string, unknown>>>();

  constructor(
    private readonly session: ZhixueSession,
    private readonly http: HttpClient,
  ) {}

  definition(id: string): Promise<Record<string, unknown>> {
    let result = this.definitions.get(id);
    if (!result) {
      result = this.post(
        '/hw/answer/homework/detail',
        { hwId: id, studentId: this.session.studentId },
        'webview-answer',
      ).then(record);
      this.definitions.set(id, result);
    }
    return result;
  }

  async submission(id: string): Promise<HomeworkSubmission> {
    const raw = record(
      await this.post(
        '/hw/answer/stuhomework/get',
        { hwId: id, studentId: this.session.studentId },
        'webview-answer',
      ),
    );
    return {
      id: requiredText(raw.id),
      homeworkId: text(raw.hwId) || id,
      status: number(raw.status),
      committed: typeof raw.commit === 'boolean' ? raw.commit : undefined,
      beganAt: number(raw.beginTime),
      endsAt: number(raw.endTime),
      score: number(raw.stuScore),
      totalScore: number(raw.totalScore),
      correctedQuestions: number(raw.totalCorrectedQuesCnt),
      totalQuestions: number(raw.totalCorrectQuesCnt),
    };
  }

  async attachments(id: string): Promise<Attachment[]> {
    const [response, definition] = await Promise.all([
      this.post(
        '/hw/homework/attachment/list',
        { hwId: id, studentId: this.session.studentId },
        'webview-answer',
      ),
      this.definition(id),
    ]);
    const raw = [...list(response), ...questionAttachments(definition)];
    if (Number(definition.hwType) === 107) {
      const context = await this.context(id);
      const preview = record(
        await this.post(
          '/hw/clock/answer/preview',
          { hwId: id, stuHwId: context.studentHomeworkId },
          'webview-habit-rich',
        ),
      );
      raw.push(...list(preview.hwTopicAttachments ?? []));
    }
    return deduplicateAttachments(
      await Promise.all(
        raw.map(async (value) => {
          const data = record(value);
          const attachment = normalizeAttachment(data);
          if (!attachment.previewImageUrls?.length && data.convertedId) {
            const converted = record(
              await this.post(
                '/hw/common/attachment/convert/query',
                { id: data.convertedId },
                'webview-habit-rich',
              ),
            );
            attachment.previewImageUrls = list(converted.convertedPaths ?? []).map(requiredText);
          }
          return attachment;
        }),
      ),
    );
  }

  private async context(id: string) {
    const raw = await this.definition(id);
    const type = number(raw.hwType);
    if (type === undefined) return malformed();
    let studentHomeworkId = text(raw.stuHwId);
    if (!studentHomeworkId) studentHomeworkId = (await this.submission(id)).id;
    return { type, studentHomeworkId, classId: requiredText(raw.classId ?? this.session.classId) };
  }

  async report(id: string): Promise<HomeworkReport> {
    const context = await this.context(id);
    const spoken = context.type === 110;
    const raw = record(
      await this.post(
        spoken ? '/hwreport/spoken/stuReportOverView' : '/hwreport/student/studentReport',
        {
          classId: context.classId,
          hwId: id,
          stuHwId: context.studentHomeworkId,
          ...(!spoken ? { hwType: String(context.type), studentId: this.session.studentId } : {}),
        },
        spoken ? 'native-rich' : 'webview-report',
      ),
    );
    const overview = spoken ? record(raw.stuOverView) : raw;
    return {
      kind: spoken ? 'spoken' : 'standard',
      score: number(spoken ? overview.stuScore : raw.studentScore),
      totalScore: number(spoken ? overview.totalScore : raw.fullScore),
      scoreRate: number(spoken ? overview.stuScoreRate : raw.scoreRate),
      averageScore: number(raw.avgScore),
      maximumScore: number(raw.maxScore),
      rank: number(raw.studentSort),
      submittedAt: number(overview.submittedTime),
      submittedDurationSeconds: number(overview.submittedDuration),
      attachments: spoken
        ? []
        : deduplicateAttachments(
            [...list(raw.videoCourseList ?? []), ...questionAttachments(raw)].map((value) =>
              normalizeAttachment(record(value)),
            ),
          ),
      questions: normalizeHomeworkQuestions(
        (spoken ? raw.answerQuestionTypeList : raw.answerTopicList) ?? [],
      ),
    };
  }

  async reportDetails(id: string): Promise<HomeworkReportDetail | undefined> {
    const context = await this.context(id);
    if (context.type === 110) return undefined;
    const raw = record(
      await this.post(
        '/hwreport/question/getStuReportDetail',
        {
          classId: context.classId,
          hwId: id,
          hwType: String(context.type),
          stuHwId: context.studentHomeworkId,
          studentId: this.session.studentId,
        },
        'webview-report',
      ),
    );
    return {
      description: text(raw.hwDescription),
      ...(typeof raw.showAnswerResult === 'boolean' ? { showAnswers: raw.showAnswerResult } : {}),
      questions: normalizeHomeworkQuestions(raw.mainTopics ?? []),
      attachments: deduplicateAttachments(
        [...questionAttachments(raw), ...list(raw.answerAttachList ?? [])].map((value) =>
          normalizeAttachment(record(value)),
        ),
      ),
    };
  }

  async post(path: string, params: Record<string, unknown>, template: RequestTemplate): Promise<unknown> {
    return this.http.retry(async () => {
      const envelope = record(
        await this.http.json(
          `${HOMEWORK_BASE_URL}${path}`,
          {
            method: 'POST',
            headers: requestHeaders(this.session, template),
            body: JSON.stringify({ base: requestBase(this.session, template), params }),
          },
          0,
        ),
      );
      if (typeof envelope.code !== 'string' && typeof envelope.code !== 'number') return malformed();
      if (String(envelope.code) !== '000000') serviceError(envelope.code, '智学');
      if (envelope.result == null) return malformed();
      return envelope.result;
    }, false);
  }
}

function normalizeHomework(raw: Record<string, unknown>, bucket?: 'active' | 'completed'): HomeworkItem {
  const state = raw.homeworkState == null ? {} : record(raw.homeworkState);
  const typeCode = number(raw.hwType);
  return {
    id: requiredText(raw.hwId ?? raw.id),
    title: text(raw.title) || '作业',
    ...(raw.subjectCode || raw.subjectName
      ? { subject: { code: text(raw.subjectCode), name: text(raw.subjectName) } }
      : {}),
    ...(typeCode !== undefined ? { type: { code: typeCode, name: text(raw.hwTypeName) } } : {}),
    startsAt: number(raw.beginTime),
    endsAt: number(raw.endTime ?? raw.endDateTime),
    submittedAt: number(raw.submittedTime),
    score: number(raw.stuScore),
    totalScore: number(raw.totalScore),
    state: {
      ...(bucket ? { bucket } : {}),
      code: number(state.stateCode),
      name: text(state.stateName) || undefined,
      submitted: typeof raw.commit === 'boolean' ? raw.commit : undefined,
      completionCode: number(raw.completeStatus),
      correctionCode: number(raw.correctStatus),
    },
  };
}

function normalizeAttachment(raw: Record<string, unknown>): Attachment {
  const url = requiredText(raw.path ?? raw.url);
  let filename: string;
  let identity: string;
  try {
    const address = new URL(url);
    filename = decodeURIComponent(address.pathname.split('/').pop() || '附件');
    identity = createHash('sha256')
      .update(address.origin + address.pathname)
      .digest('hex');
  } catch {
    return malformed();
  }
  return {
    id: text(raw.id ?? raw.attachmentId) || identity,
    name: text(raw.name) || filename,
    url,
    extension: text(raw.extensionName) || (filename.includes('.') ? filename.split('.').pop() : undefined),
    sizeBytes: number(raw.size),
    ...(raw.md5 ? { md5: text(raw.md5) } : {}),
    ...(raw.imgAttachmentList != null
      ? {
          previewImageUrls: list(raw.imgAttachmentList).map((value) => {
            const item = record(value);
            return requiredText(item.path ?? item.url);
          }),
        }
      : {}),
  };
}

function deduplicateAttachments(items: Attachment[]): Attachment[] {
  return [...new Map(items.map((item) => [item.url, item])).values()];
}

function questionAttachments(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(questionAttachments);
  if (!value || typeof value !== 'object') return [];
  const raw = record(value);
  return [
    ...list(raw.questionAttachList ?? []),
    ...[
      'questions',
      'mainTopics',
      'answerTopicList',
      'answerQuestionTypeList',
      'childQuestions',
      'subTopics',
      'childrenQuestions',
      'children',
      'subQuestions',
      'questionDetail',
      'childQuestionDetail',
    ].flatMap((key) => questionAttachments(raw[key])),
  ];
}

function requestHeaders(session: ZhixueSession, template: RequestTemplate): Record<string, string> {
  if (template === 'native' || template === 'native-rich') return nativeHeaders(session);
  const referer =
    template === 'webview-answer'
      ? '/zhixuestudent/views/answerSheet/reply.html'
      : template === 'webview-report'
        ? '/zhixuestudent/views/homeworkReport/homework-report.html'
        : '/zhixuestudent/views/learningTask/topic.html';
  const { zhixue, device } = AUTH_CONFIG;
  return {
    'user-agent': zhixue.webViewUserAgent,
    'sec-ch-ua-platform': '"Android"',
    authorization: session.token,
    sucOriginAppKey: '',
    'X-Device-Id': 'undefined',
    'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Android WebView";v="150"',
    'sec-ch-ua-mobile': '?1',
    sucUserToken: session.token,
    sucAccessDeviceId: device.id,
    'X-Client-Type': 'undefined',
    accept: 'application/json, text/plain, */*',
    appName: zhixue.packageName,
    'content-type': 'application/json',
    sucClientType: 'android',
    origin: HOMEWORK_BASE_URL,
    'X-Requested-With': zhixue.packageName,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    referer: `${HOMEWORK_BASE_URL}${referer}`,
    'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    ...cookieHeader(session.cookies),
  };
}

function nativeHeaders(session: ZhixueSession): Record<string, string> {
  const { zhixue, device } = AUTH_CONFIG;
  return {
    deviceId: device.id,
    browserVersion: `Android_${zhixue.version}`,
    appName: zhixue.packageName,
    channel: zhixue.channel,
    'X-Client-Type': 'android',
    'X-Device-Id': device.id,
    authbizcode: zhixue.authBizCode,
    authguid: randomUUID(),
    authtimestamp: String(Date.now()),
    authtoken: randomBytes(16).toString('hex'),
    authorization: session.token,
    sucOriginAppKey: '',
    sucUserToken: session.token,
    sucAccessDeviceId: device.id,
    sucClientType: 'android',
    userId: device.zhixueUserId,
    'content-type': 'application/json',
    'user-agent': zhixue.httpUserAgent,
    ...cookieHeader(session.cookies),
  };
}

function requestBase(session: ZhixueSession, template: RequestTemplate): Record<string, unknown> {
  const { zhixue, device } = AUTH_CONFIG;
  if (template === 'webview-answer' || template === 'webview-report') {
    return { appId: 'APP', extend: {}, packageName: '', sysType: '', sysVersion: '', udid: '' };
  }
  const base: Record<string, unknown> = {
    appId: zhixue.appId,
    appVersion: zhixue.version,
    packageName: zhixue.packageName,
    sucAccessDeviceId: device.id,
    sucClientType: 'android',
    sysType: 'Android',
    sysVersion: 'CB-C6-STU',
    udid: '',
  };
  if (template === 'native-rich' || template === 'webview-habit-rich') {
    return {
      Authorization: session.token,
      appId: zhixue.appId,
      appVersion: zhixue.version,
      packageName: zhixue.packageName,
      sucAccessDeviceId: device.id,
      sucClientType: 'android',
      sucOriginAppKey: '',
      sucUserToken: session.token,
      sysType: 'Android',
      sysVersion: 'CB-C6-STU',
      udid: '',
      userId: session.studentId,
      utag: '',
    };
  }
  return base;
}

function cookieHeader(cookies?: Record<string, string>): Record<string, string> {
  if (!cookies || !Object.keys(cookies).length) return {};
  return {
    cookie: Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; '),
  };
}

function downloadHeaders(session: ZhixueSession, attachment: Attachment): Record<string, string> {
  const image = /^(png|jpe?g|gif|webp|svg)$/.test(attachment.extension?.toLowerCase() ?? '');
  const { zhixue } = AUTH_CONFIG;
  return {
    'user-agent': zhixue.webViewUserAgent,
    'sec-ch-ua-platform': '"Android"',
    'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Android WebView";v="150"',
    'sec-ch-ua-mobile': '?1',
    accept: image ? 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' : '*/*',
    'X-Requested-With': zhixue.packageName,
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Dest': image ? 'image' : 'empty',
    'Sec-Fetch-Storage-Access': 'active',
    referer: `${HOMEWORK_BASE_URL}/`,
    'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    ...(!image ? { range: 'bytes=0-' } : {}),
  };
}
