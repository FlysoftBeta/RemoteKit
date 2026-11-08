import {
  HttpClient,
  type HttpOptions,
  list,
  record,
  malformed,
  positiveInteger,
  requiredText,
  number,
} from '../http.js';
import type { ClassMaterial, Subject, Page, ProviderResult } from '../models.js';
import type { AccountSession } from './auth.js';
import { GatewayClient } from './gateway.js';

export interface MaterialQuery {
  page?: number;
  state?: 'pending' | 'learned';
  type?: 'all' | 'courseware' | 'document' | 'video' | 'audio' | 'image' | 'other';
  startDate?: string;
  endDate?: string;
}

const GROUP = {
  materials: 'f93f1aca22d347039fce412efea90c8d',
  files: '51a521bd781245e49f2d9eacd42c29e8',
  preview: '80f129f1288e40efab6a9343198bcd9d',
} as const;

const TYPE_CODE: Record<MaterialQuery['type'] & string, number> = {
  all: -1,
  courseware: 2,
  document: 1,
  video: 3,
  audio: 4,
  image: 5,
  other: 0,
};

interface RawStudySubject {
  subjectName: string;
  subjectCode: string;
}

interface RawStudyMaterial {
  resourceId: string;
  resourceName: string;
  extension?: string;
  resourceLength?: number;
  resourceMd5?: string;
  subjectCode?: string;
  subjectName?: string;
  sharePersonId?: string;
  sharePersonName?: string;
  shareTime?: number;
  learnState?: number;
  learnPhase?: number;
  taskEndTime?: number;
}

export class StudyClient {
  private readonly gateway: GatewayClient;
  private readonly http: HttpClient;

  constructor(options: HttpOptions = {}) {
    this.gateway = new GatewayClient(options);
    this.http = new HttpClient(options, 'changyan');
  }

  async subjects(session: AccountSession): Promise<ProviderResult<Subject[], AccountSession>> {
    const result = await this.gateway.gateway<{ data: RawStudySubject[] }>(session, {
      path: '/futureclass/resourceServer/studentTask/taskSubjectList',
      groupId: GROUP.materials,
      query: { userId: session.changyan.userId },
    });
    return {
      session: result.session,
      data: list(record(result.data).data).map((value) => {
        const item = record(value);
        return { code: requiredText(item.subjectCode), name: requiredText(item.subjectName) };
      }),
    };
  }

  async materialPage(
    session: AccountSession,
    subjectCode: string,
    query: MaterialQuery = {},
  ): Promise<ProviderResult<Page<ClassMaterial>, AccountSession>> {
    const page = positiveInteger(query.page ?? 1, '页码');
    const dates = defaultDateRange(query.startDate, query.endDate);
    const type = TYPE_CODE[query.type ?? 'all'];
    const result = await this.gateway.gateway<{ total: number; data: RawStudyMaterial[] }>(session, {
      path: '/futureclass/studentserver/studentTask/v2/taskListOrderByState',
      groupId: GROUP.materials,
      query: {
        userId: session.changyan.userId,
        subjectCode,
        learnState: query.state === 'learned' ? 1 : 0,
        pageNum: page,
        limit: 15,
        thumbSize: '0_0',
        startTime: dates.start,
        endTime: dates.end,
        ...(type !== -1 ? { extension: type } : {}),
      },
    });
    const total = number(record(result.data).total);
    if (total === undefined || total < 0) return malformed();
    const items = list(result.data.data).map((item) =>
      normalizeMaterial(record(item) as unknown as RawStudyMaterial),
    );
    return {
      session: result.session,
      data: { page, pageSize: 15, pageCount: Math.ceil(total / 15), total, accessibleTotal: total, items },
    };
  }

  async material(
    session: AccountSession,
    id: string,
  ): Promise<ProviderResult<ClassMaterial, AccountSession>> {
    const result = await this.gateway.gateway<{ data: RawStudyMaterial[] }>(session, {
      path: '/futureclass/resourceServer/studentTask/learnTaskByResId',
      groupId: GROUP.materials,
      query: { userId: session.changyan.userId, resourceId: id },
    });
    const raw = list(record(result.data).data)[0];
    if (!raw) return malformed();
    return { session: result.session, data: normalizeMaterial(record(raw) as unknown as RawStudyMaterial) };
  }

  async downloadUrl(session: AccountSession, id: string): Promise<ProviderResult<string, AccountSession>> {
    const result = await this.gateway.gateway<{ fileUrl: string }>(session, {
      path: '/futureclass/studentserver/stuRes/v2/school/getDownloadUrl',
      groupId: GROUP.files,
      query: { userId: session.changyan.userId, resId: id, platform: 'changyan' },
    });
    return { session: result.session, data: requiredText(record(result.data).fileUrl) };
  }

  async remoteMd5(
    session: AccountSession,
    id: string,
  ): Promise<ProviderResult<string | undefined, AccountSession>> {
    const result = await this.gateway.gateway<Array<{ resId: string; md5: string }>>(session, {
      path: '/futureclass/studentserver/stuRes/school/md5',
      groupId: GROUP.preview,
      query: { resId: id },
    });
    const found = list(result.data)
      .map(record)
      .find((item) => item.resId === id);
    return { session: result.session, data: found ? requiredText(found.md5) : undefined };
  }

  async download(session: AccountSession, material: ClassMaterial) {
    const result = await this.downloadUrl(session, material.id);
    const data = await this.http.download(result.data, {}, { size: material.sizeBytes, md5: material.md5 });
    return { session: result.session, data };
  }
}

function normalizeMaterial(raw: RawStudyMaterial): ClassMaterial {
  return {
    id: requiredText(raw.resourceId),
    name: requiredText(raw.resourceName),
    ...(raw.extension ? { extension: raw.extension } : {}),
    ...(raw.resourceLength !== undefined ? { sizeBytes: number(raw.resourceLength) } : {}),
    ...(raw.resourceMd5 ? { md5: raw.resourceMd5 } : {}),
    ...(raw.subjectCode || raw.subjectName
      ? {
          subject: {
            code: raw.subjectCode ?? '',
            name: raw.subjectName ?? '',
          },
        }
      : {}),
    ...(raw.sharePersonId || raw.sharePersonName
      ? {
          sharedBy: {
            id: raw.sharePersonId ?? '',
            name: raw.sharePersonName ?? '',
          },
        }
      : {}),
    ...(raw.shareTime !== undefined ? { sharedAt: raw.shareTime } : {}),
    ...(raw.learnState !== undefined
      ? { learningState: raw.learnState === 0 ? 'pending' : raw.learnState === 1 ? 'learned' : 'unknown' }
      : {}),
    ...(raw.learnPhase !== undefined
      ? {
          phase:
            raw.learnPhase === 0
              ? 'before-class'
              : raw.learnPhase === 1
                ? 'in-class'
                : raw.learnPhase === 2
                  ? 'after-class'
                  : 'unknown',
        }
      : {}),
    ...(raw.taskEndTime !== undefined ? { taskEndsAt: raw.taskEndTime } : {}),
  };
}

function defaultDateRange(start?: string, end?: string): { start: string; end: string } {
  const today = new Date();
  const sixMonthsAgo = new Date(today);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  return { start: start ?? localDate(sixMonthsAgo), end: end ?? localDate(today) };
}

function localDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
