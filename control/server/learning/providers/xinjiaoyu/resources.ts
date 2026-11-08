import { RemoteKitError } from '../../../../shared/errors.js';
import { list, record, requiredText, text, number, malformed, positiveInteger } from '../http.js';
import type { Page, ProviderResult, Question, Subject } from '../models.js';
import { APIClient, decodeIdentity, type XinjiaoyuOptions, type XinjiaoyuSession } from './client.js';
import { normalizeQuestion } from './normalize.js';

// Fixed ids used by the production question bank's showDifficultyName mapping.
export const QUESTION_DIFFICULTIES = [
  { id: '10018', name: '基础题' },
  { id: '10019', name: '中档题' },
  { id: '10020', name: '较难题' },
];

export interface QuestionType {
  id: string;
  name: string;
  isSubjective: boolean;
  children: QuestionType[];
}

export interface Textbook {
  id: string;
  name: string;
  edition?: string;
  grade?: string;
  semester?: string;
}

export interface CatalogItem {
  id: string;
  title: string;
  children: CatalogItem[];
  dimensionId?: string;
  tagId?: string;
  selectable: boolean;
}

export interface QuestionQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  /** Omit for all textbooks. A catalog selection requires a textbook. */
  textbookId?: string;
  /** Omit for 全部章节. */
  catalogId?: string;
  logicTypeIds?: string[];
  difficultyIds?: string[];
  sortOrder?: 'newest' | 'oldest';
}

function asList(value: unknown): unknown[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  const raw = record(value);
  return list(raw.records ?? raw.rows);
}

function normalizeType(value: unknown): QuestionType {
  const raw = record(value);
  return {
    id: requiredText(raw.id),
    name: requiredText(raw.name),
    isSubjective: raw.isSubjective === true || raw.isSubjective === 1,
    children: raw.children == null ? [] : list(raw.children).map(normalizeType),
  };
}

function normalizeCatalog(value: unknown): CatalogItem {
  const raw = record(value);
  return {
    id: requiredText(raw.key),
    title: text(raw.alias) || requiredText(raw.value),
    dimensionId: text(raw.dimensionId) || undefined,
    tagId: text(raw.labelId) || undefined,
    selectable: Number(raw.labelStatus) !== 2,
    children: raw.children == null ? [] : list(raw.children).map(normalizeCatalog),
  };
}

function flatten(nodes: CatalogItem[]): CatalogItem[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

export class XinjiaoyuProvider {
  private readonly client: APIClient;

  constructor(options: XinjiaoyuOptions = {}) {
    this.client = new APIClient(options);
  }

  async subjects(session: XinjiaoyuSession): Promise<ProviderResult<Subject[], XinjiaoyuSession>> {
    const result = await this.client.get<unknown>(session, '/api/v3/server_system/audit/cfg/query');
    const unique = new Map<string, Subject>();
    for (const value of list(record(result.data).unints)) {
      const unit = record(value);
      for (const value of unit.auditGroups == null ? [] : list(unit.auditGroups)) {
        const group = record(value);
        if (text(group.phaseId) !== this.client.stageId) continue;
        const code = requiredText(group.courseId);
        unique.set(code, {
          code,
          name: requiredText(group.course),
          stage: text(group.phaseName) || text(group.phase) || this.client.stageId,
        });
      }
    }
    return {
      session: result.session,
      data: [...unique.values()].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
    };
  }

  async types(
    session: XinjiaoyuSession,
    subjectCode: string,
  ): Promise<ProviderResult<QuestionType[], XinjiaoyuSession>> {
    const result = await this.client.post<unknown>(
      session,
      '/api/v3/server_questions/questions/type/management/list/byScene',
      {
        courseId: subjectCode,
        phaseId: this.client.stageId,
        sceneType: 1,
      },
    );
    const types = new Map<string, QuestionType>();
    for (const value of asList(result.data)) {
      const group = record(value);
      for (const raw of group.questionsTypeList == null ? [] : list(group.questionsTypeList)) {
        const type = normalizeType(raw);
        types.set(type.id, type);
      }
    }
    return { session: result.session, data: [...types.values()] };
  }

  async books(
    session: XinjiaoyuSession,
    subjectCode: string,
  ): Promise<ProviderResult<Textbook[], XinjiaoyuSession>> {
    const params = { phaseId: this.client.stageId, courseId: subjectCode, questionFilter: 1 };
    const types = await this.client.post<unknown>(session, '/api/v3/server_base/textbook/type/list', params);
    let current = types.session;
    const unique = new Map<string, Textbook>();
    for (const type of asList(types.data)) {
      const result = await this.client.post<unknown>(current, '/api/v3/server_base/textbook/list', {
        ...params,
        textBookTypeId: requiredText(record(type).key),
      });
      current = result.session;
      for (const value of asList(result.data)) {
        const book = record(value);
        const id = requiredText(book.id);
        unique.set(id, {
          id,
          name: requiredText(book.textBookName),
          ...(book.typeName ? { edition: text(book.typeName) } : {}),
          ...(book.gradeName ? { grade: text(book.gradeName) } : {}),
          ...(book.semesterName ? { semester: text(book.semesterName) } : {}),
        });
      }
    }
    return { session: current, data: [...unique.values()] };
  }

  async catalog(
    session: XinjiaoyuSession,
    textbookId?: string,
  ): Promise<ProviderResult<CatalogItem[], XinjiaoyuSession>> {
    if (!textbookId) return { session, data: [] };
    const result = await this.client.post<unknown>(session, '/api/v3/server_base/catalogNew/list', {
      textBookId: textbookId,
      includeHidden: true,
    });
    return { session: result.session, data: asList(result.data).map(normalizeCatalog) };
  }

  async questions(
    session: XinjiaoyuSession,
    subjectCode: string,
    query: QuestionQuery = {},
  ): Promise<ProviderResult<Page<Question>, XinjiaoyuSession>> {
    const requestedPage = positiveInteger(query.page ?? 1, '页码');
    const requestedSize = Math.max(10, positiveInteger(query.pageSize ?? 20, '每页数量'));
    if (query.catalogId && !query.textbookId) {
      throw new RemoteKitError('invalid_request', '选择章节前请先选择教材');
    }
    let current = session;
    let nodes: CatalogItem[] = [];
    if (query.textbookId) {
      const catalog = await this.catalog(current, query.textbookId);
      current = catalog.session;
      nodes = catalog.data;
      if (query.catalogId) {
        const selected = flatten(nodes).find((node) => node.id === query.catalogId);
        if (!selected) throw new RemoteKitError('invalid_request', '所选章节不属于当前教材');
        nodes = [selected];
      }
    }
    const tags = new Map<string, { dimensionId: string; tagId: string }>();
    for (const node of flatten(nodes)) {
      if (!node.selectable || !node.dimensionId || !node.tagId) continue;
      tags.set(`${node.dimensionId}:${node.tagId}`, { dimensionId: node.dimensionId, tagId: node.tagId });
    }
    const identity = decodeIdentity(session.token);
    const result = await this.client.post<unknown>(
      current,
      '/api/v3/server_questions/questions/bank/query/list/all/esDetail',
      {
        size: requestedSize,
        current: requestedPage,
        status: 0,
        logicTypeIds: query.logicTypeIds?.length ? query.logicTypeIds : null,
        phaseId: this.client.stageId,
        courseId: subjectCode,
        isDesc: query.sortOrder !== 'oldest',
        sortMode: 1,
        tagIdsType: 0,
        ...(query.textbookId ? { textBookId: query.textbookId } : {}),
        ...(query.catalogId ? { textBookCatalogId: query.catalogId } : {}),
        classicType: null,
        ruleType: null,
        search: query.search ?? '',
        // The service uses isAllBook for all chapters of a book, not for all textbooks.
        isAllBook: !query.catalogId,
        dimensionTagList: [...tags.values()],
        userId: identity.userId,
        filterOutUserSchoolId: identity.schoolId,
        scope: 1,
        ...(query.difficultyIds?.length ? { difficultyIds: query.difficultyIds } : {}),
      },
    );
    if (result.data === null) {
      return {
        session: result.session,
        data: {
          page: requestedPage,
          pageSize: requestedSize,
          pageCount: 0,
          total: 0,
          accessibleTotal: 0,
          items: [],
        },
      };
    }
    const raw = record(result.data);
    const accessibleTotal = number(raw.total);
    const total = number(raw.realTotal) ?? accessibleTotal;
    const pageSize = number(raw.size) ?? requestedSize;
    const page = number(raw.current) ?? requestedPage;
    if (
      accessibleTotal === undefined ||
      accessibleTotal < 0 ||
      total === undefined ||
      total < 0 ||
      !Number.isInteger(pageSize) ||
      pageSize < 10 ||
      !Number.isInteger(page) ||
      page < 1
    )
      return malformed();
    return {
      session: result.session,
      data: {
        page,
        pageSize,
        total,
        accessibleTotal,
        pageCount: Math.min(
          number(raw.pages) ?? Math.ceil(accessibleTotal / pageSize),
          Math.ceil(accessibleTotal / pageSize),
        ),
        items: list(raw.records).map(normalizeQuestion),
      },
    };
  }
}
