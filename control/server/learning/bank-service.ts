import type { BankQuestion, BankQuery, BankCatalogNode, LearningPage } from '../../shared/learning';
import type { Question } from './providers/models';
import { XinjiaoyuProvider, QUESTION_DIFFICULTIES } from './providers/xinjiaoyu/resources';
import { LearningAccounts } from './accounts';
import { Cache } from './cache';
import type { MediaProxy } from './media-proxy';
import { richHtml } from './rich-html';

export class BankService {
  private readonly cache: Cache;
  constructor(
    private readonly tenant: string,
    private readonly accounts: LearningAccounts,
    private readonly media: MediaProxy,
    readonly provider = new XinjiaoyuProvider(),
    now = Date.now,
  ) {
    this.cache = new Cache(now);
  }
  private async read<T>(key: string, ttl: number, load: () => Promise<T>) {
    this.accounts.session(this.tenant, 'xinjiaoyu');
    return this.cache.get(key, ttl, load);
  }
  subjects() {
    return this.read('subjects', 3600_000, async () => ({
      subjects: (
        await this.accounts.use(this.tenant, 'xinjiaoyu', (session) => this.provider.subjects(session))
      ).map((subject) => ({ id: subject.code, name: subject.name, stage: subject.stage! })),
    }));
  }
  subject(id: string) {
    return this.read(`subject:${id}`, 3600_000, async () => {
      const types = await this.accounts.use(this.tenant, 'xinjiaoyu', (session) =>
        this.provider.types(session, id),
      );
      const textbooks = await this.accounts.use(this.tenant, 'xinjiaoyu', (session) =>
        this.provider.books(session, id),
      );
      return {
        types: types.map(function map(type): {
          id: string;
          name: string;
          children: ReturnType<typeof map>[];
        } {
          return { id: type.id, name: type.name, children: type.children.map(map) };
        }),
        difficulties: QUESTION_DIFFICULTIES,
        textbooks,
      };
    });
  }
  catalog(subjectId: string, textbookId: string) {
    return this.read(`catalog:${subjectId}:${textbookId}`, 3600_000, async () => ({
      nodes: (
        await this.accounts.use(this.tenant, 'xinjiaoyu', (session) =>
          this.provider.catalog(session, textbookId),
        )
      ).map(function map(node): BankCatalogNode {
        return {
          id: node.id,
          title: node.title,
          selectable: node.selectable,
          children: node.children.map(map),
        };
      }),
    }));
  }
  private question(item: Question): BankQuestion {
    const html = (value: string) => richHtml(value, this.tenant, 'xinjiaoyu', this.media);
    return {
      id: item.id,
      typeName: item.questionType.subtype?.name || item.questionType.name,
      difficulty: item.difficulty.name,
      isSubjective: item.isSubjective,
      stemHtml: html(item.stemHtml),
      optionsHtml: item.optionsHtml.map(html),
      answerHtml: html(item.answerHtml),
      analysisHtml: html(item.analysisHtml),
      listeningTextHtml: item.listeningTextHtml ? html(item.listeningTextHtml) : undefined,
      translationHtml: item.translationHtml ? html(item.translationHtml) : undefined,
      audioUrl: item.audioUrl ? this.media.url(this.tenant, item.audioUrl, 'xinjiaoyu') : undefined,
      videoUrl: item.videoUrl ? this.media.url(this.tenant, item.videoUrl, 'xinjiaoyu') : undefined,
      children: item.children.map((item) => this.question(item)),
      tags: item.tags.map((tag) => tag.name),
      source:
        item.sources
          .map((source) => source.note || source.name)
          .filter(Boolean)
          .join('、') || undefined,
    };
  }
  async questions(query: BankQuery): Promise<LearningPage<BankQuestion>> {
    const result = await this.read(`questions:${JSON.stringify(query)}`, 300_000, () =>
      this.accounts.use(this.tenant, 'xinjiaoyu', (session) =>
        this.provider.questions(session, query.subjectId, {
          page: query.page,
          pageSize: query.pageSize,
          textbookId: query.textbookId,
          catalogId: query.catalogId,
          logicTypeIds: query.typeIds,
          difficultyIds: query.difficultyIds,
          search: query.search,
          sortOrder: query.sort,
        }),
      ),
    );
    return { ...result, items: result.items.map((item) => this.question(item)) };
  }
}
