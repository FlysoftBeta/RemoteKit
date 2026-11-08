import type {
  AttachmentSave,
  HomeworkDetail,
  HomeworkSummary,
  HomeworkQuestion,
  StudyAttachment,
  MaterialType,
  ClassMaterial,
  LearningPage,
} from '../../shared/learning';
import { RemoteKitError } from '../../shared/errors';
import type {
  Attachment,
  ClassMaterial as ProviderMaterial,
  HomeworkDetail as ProviderHomework,
  HomeworkItem,
  HomeworkQuestion as ProviderQuestion,
} from './providers/models';
import type { StreamingDownload } from './providers/http';
import { StudyClient } from './providers/changyan/study';
import { ZhixueClient } from './providers/changyan/zhixue';
import { LearningAccounts } from './accounts';
import { Cache } from './cache';
import type { MediaProxy } from './media-proxy';
import { richHtml } from './rich-html';

export interface DownloadItem {
  key: string;
  name: string;
  extension?: string;
  sizeBytes?: number;
  publishedAt: number;
  subject: string;
  detail: string;
  attachment?: Attachment;
  material?: ProviderMaterial;
}
export class StudyService {
  private readonly cache: Cache;
  private readonly attachments = new Map<string, DownloadItem>();
  constructor(
    readonly tenant: string,
    private readonly accounts: LearningAccounts,
    private readonly media: MediaProxy,
    private readonly saved: (key: string) => AttachmentSave,
    readonly study = new StudyClient(),
    readonly homework = new ZhixueClient(),
    private readonly now = Date.now,
  ) {
    this.cache = new Cache(now);
  }
  private async read<T>(key: string, ttl: number, load: () => Promise<T>) {
    this.accounts.session(this.tenant, 'changyan');
    return this.cache.get(key, ttl, load);
  }
  async subjects() {
    const subjects = await this.read('subjects', 60_000, async () => {
      const study = await this.accounts.use(this.tenant, 'changyan', (session) =>
        this.study.subjects(session),
      );
      const homework = await this.accounts.use(this.tenant, 'changyan', (session) =>
        this.homework.subjects(session),
      );
      const byCode = new Map([...homework, ...study].map((subject) => [subject.code, subject]));
      return [...byCode.values()];
    });
    return {
      subjects: await Promise.all(
        subjects.map(async (subject) => {
          const page = await this.materials({
            subjectCode: subject.code,
            state: 'pending',
            type: 'all',
            page: 1,
          });
          return { ...subject, hasPending: page.total > 0 };
        }),
      ),
    };
  }
  rawHomeworkPage(bucket: 'active' | 'completed', page: number) {
    return this.read(`homework:${bucket}:${page}`, 60_000, () =>
      this.accounts.use(this.tenant, 'changyan', (session) =>
        this.homework.homeworkPage(session, { bucket, page }),
      ),
    );
  }
  rawDetail(id: string) {
    return this.read(`detail:${id}`, 300_000, () =>
      this.accounts.use(this.tenant, 'changyan', (session) => this.homework.details(session, id)),
    );
  }
  private summary(item: HomeworkItem, detail: ProviderHomework): HomeworkSummary {
    const attachments = this.homeworkAttachments(detail);
    const corrected =
      detail.state.correctionCode === 2 ||
      (!!detail.submission?.totalQuestions &&
        (detail.submission.correctedQuestions ?? 0) >= detail.submission.totalQuestions);
    return {
      id: item.id,
      title: item.title,
      subject: item.subject,
      typeName: item.type?.name,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      submittedAt: detail.report?.submittedAt ?? item.submittedAt,
      score: detail.report?.score ?? item.score,
      totalScore: detail.report?.totalScore ?? item.totalScore,
      status: corrected
        ? 'corrected'
        : detail.submission?.committed ||
            detail.state.submitted ||
            detail.submittedAt !== undefined ||
            item.state.bucket === 'completed'
          ? 'submitted'
          : 'pending',
      attachmentCount: attachments.length,
      attachmentsSaved: attachments.filter((item) => item.save.state === 'saved').length,
    };
  }
  async list(params: {
    bucket: 'active' | 'completed';
    subjectCode?: string;
    page: number;
  }): Promise<LearningPage<HomeworkSummary>> {
    let result = await this.rawHomeworkPage(params.bucket, params.subjectCode ? 1 : params.page);
    if (params.subjectCode) {
      const items = [...result.items];
      for (let page = 2; page <= result.pageCount; page++)
        items.push(...(await this.rawHomeworkPage(params.bucket, page)).items);
      const filtered = items.filter((item) => item.subject?.code === params.subjectCode);
      result = {
        ...result,
        page: params.page,
        total: filtered.length,
        accessibleTotal: filtered.length,
        pageCount: Math.ceil(filtered.length / result.pageSize),
        items: filtered.slice((params.page - 1) * result.pageSize, params.page * result.pageSize),
      };
    }
    return {
      ...result,
      items: await Promise.all(
        result.items.map(async (item) => this.summary(item, await this.rawDetail(item.id))),
      ),
    };
  }
  private question(item: ProviderQuestion): HomeworkQuestion {
    const html = (value: string) => richHtml(value, this.tenant, 'changyan', this.media);
    return {
      id: item.id,
      number: item.number,
      typeName: item.typeName,
      stemHtml: html(item.stemHtml),
      optionsHtml: item.optionsHtml.map(html),
      children: item.children.map((child) => this.question(child)),
      answerHtml: item.answerHtml === undefined ? undefined : html(item.answerHtml),
      analysisHtml: item.analysisHtml === undefined ? undefined : html(item.analysisHtml),
      studentAnswerHtml: item.studentAnswerHtml === undefined ? undefined : html(item.studentAnswerHtml),
      score: item.score,
      totalScore: item.totalScore,
    };
  }
  private homeworkAttachments(detail: ProviderHomework) {
    return detail.attachments.map((attachment) => {
      const key = `zhixue:${attachment.id}`;
      this.attachments.set(key, {
        key,
        name: attachment.name,
        extension: attachment.extension,
        sizeBytes: attachment.sizeBytes,
        publishedAt: detail.startsAt ?? 0,
        subject: detail.subject?.name || '其他',
        detail: detail.title,
        attachment,
      });
      return this.attachment(this.attachments.get(key)!);
    });
  }
  private attachment(item: DownloadItem): StudyAttachment {
    return {
      key: item.key,
      name: item.name,
      extension: item.extension,
      sizeBytes: item.sizeBytes,
      save: this.saved(item.key),
    };
  }
  async detail(id: string): Promise<HomeworkDetail> {
    const detail = await this.rawDetail(id);
    return {
      ...this.summary(detail, detail),
      description: richHtml(detail.description, this.tenant, 'changyan', this.media),
      questions: detail.questions.map((item) => this.question(item)),
      attachments: this.homeworkAttachments(detail),
      report: detail.report
        ? {
            score: detail.report.score,
            totalScore: detail.report.totalScore,
            averageScore: detail.report.averageScore,
            maximumScore: detail.report.maximumScore,
            rank: detail.report.rank,
          }
        : undefined,
    };
  }
  private material(item: ProviderMaterial): ClassMaterial {
    const key = `changyan:${item.id}`;
    const attachment: DownloadItem = {
      key,
      name: item.name,
      extension: item.extension,
      sizeBytes: item.sizeBytes,
      publishedAt: item.sharedAt ?? 0,
      subject: item.subject?.name || '其他',
      detail: item.name,
      material: item,
    };
    this.attachments.set(key, attachment);
    return {
      id: item.id,
      name: item.name,
      extension: item.extension,
      sizeBytes: item.sizeBytes,
      subject: item.subject,
      sharedBy: item.sharedBy?.name,
      sharedAt: item.sharedAt,
      taskEndsAt: item.taskEndsAt,
      learningState: item.learningState ?? 'unknown',
      attachment: this.attachment(attachment),
    };
  }
  async materials(params: {
    subjectCode: string;
    state: 'pending' | 'learned';
    type: MaterialType;
    page: number;
    startDate?: string;
    endDate?: string;
  }): Promise<LearningPage<ClassMaterial>> {
    const result = await this.read(`materials:${JSON.stringify(params)}`, 60_000, () =>
      this.accounts.use(this.tenant, 'changyan', (session) =>
        this.study.materialPage(session, params.subjectCode, params),
      ),
    );
    return { ...result, items: result.items.map((item) => this.material(item)) };
  }
  async resolve(key: string): Promise<DownloadItem> {
    if (!this.attachments.has(key) && key.startsWith('changyan:')) {
      const item = await this.accounts.use(this.tenant, 'changyan', (session) =>
        this.study.material(session, key.slice(9)),
      );
      this.material(item);
    }
    const item = this.attachments.get(key);
    if (!item) throw new RemoteKitError('not_found', '请重新打开附件所在的作业或资料');
    return item;
  }
  async download(item: DownloadItem): Promise<StreamingDownload> {
    return this.accounts.use(this.tenant, 'changyan', (session) =>
      item.material
        ? this.study.download(session, item.material)
        : this.homework.download(session, item.attachment!),
    );
  }
  async collect(cutoff: number): Promise<DownloadItem[]> {
    const keys = new Set<string>();
    const end = this.now();
    for (const bucket of ['active', 'completed'] as const) {
      let page = 1;
      while (true) {
        const result = await this.rawHomeworkPage(bucket, page);
        for (const item of result.items) {
          if (item.startsAt === undefined || item.startsAt < cutoff || item.startsAt > end) continue;
          for (const attachment of this.homeworkAttachments(await this.rawDetail(item.id)))
            keys.add(attachment.key);
        }
        if (page >= result.pageCount || !result.items.length) break;
        page++;
      }
    }
    const subjects = await this.accounts.use(this.tenant, 'changyan', (session) =>
      this.study.subjects(session),
    );
    const startDate = new Date(cutoff).toISOString().slice(0, 10);
    for (const subject of subjects)
      for (const state of ['pending', 'learned'] as const) {
        let page = 1;
        while (true) {
          const result = await this.materials({
            subjectCode: subject.code,
            state,
            type: 'all',
            page,
            startDate,
          });
          for (const item of result.items)
            if (item.sharedAt !== undefined && item.sharedAt >= cutoff && item.sharedAt <= end) {
              const attachment = this.attachments.get(item.attachment.key)!;
              if (attachment.subject === '其他') attachment.subject = subject.name;
              keys.add(attachment.key);
            }
          if (page >= result.pageCount || !result.items.length) break;
          page++;
        }
      }
    return [...keys].map((key) => this.attachments.get(key)!);
  }
  clear() {
    this.cache.clear();
  }
}
