import type { WireError } from './errors';
// Learning Apps (学习, 题库): account state, browsing models and socket methods shared by the
// Viewer and Control. Provider HTML is already media-proxied and formula-rendered by Control;
// the Viewer still sanitizes it before insertion.

export type LearningProvider = 'changyan' | 'xinjiaoyu';

export type LearningAccount =
  | { status: 'signed_out' }
  | {
      status: 'signing_in';
      step: 'credentials' | 'verification' | 'site' | 'finishing';
      tabId?: string;
      error?: WireError;
    }
  | { status: 'signed_in'; displayName: string; since: number }
  | { status: 'expired'; displayName: string; username?: string }
  | { status: 'failed'; error: WireError; failureKind?: 'expired' | 'browser-replaced'; username?: string };

export interface StudySync {
  attachmentFailures?: { key: string; error: WireError }[];
  retentionDays: number;
  syncing: boolean;
  lastSyncAt?: number;
  error?: WireError;
}

/** Pushed as the `learning` field of ProductState; the Viewer never persists it. */
export interface LearningState {
  accounts: Record<LearningProvider, LearningAccount>;
  study: StudySync;
}

export const STUDY_RETENTION_DAYS = { min: 1, max: 60, default: 7 } as const;

export interface Subject {
  code: string;
  name: string;
}

export interface LearningPage<T> {
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
  /** Items the provider lets us page through; may be smaller than `total`. */
  accessibleTotal: number;
  items: T[];
}

/** Where an attachment stands in the user's 我的文件. */
export type AttachmentSave =
  | { state: 'saved'; entryId: string }
  | { state: 'downloading'; received: number; total?: number }
  | { state: 'failed'; error: WireError }
  | { state: 'not_saved' };

export interface StudyAttachment {
  /** Stable provider key (`zhixue:<id>` / `changyan:<id>`). */
  key: string;
  name: string;
  extension?: string;
  sizeBytes?: number;
  save: AttachmentSave;
}

export interface HomeworkSummary {
  id: string;
  title: string;
  subject?: Subject;
  typeName?: string;
  startsAt?: number;
  endsAt?: number;
  submittedAt?: number;
  score?: number;
  totalScore?: number;
  status: 'pending' | 'submitted' | 'corrected';
  attachmentCount: number;
  attachmentsSaved: number;
}

export interface HomeworkQuestion {
  id: string;
  number: string;
  typeName: string;
  stemHtml: string;
  optionsHtml: string[];
  children: HomeworkQuestion[];
  answerHtml?: string;
  analysisHtml?: string;
  studentAnswerHtml?: string;
  score?: number;
  totalScore?: number;
}

export interface HomeworkDetail extends HomeworkSummary {
  description: string;
  questions: HomeworkQuestion[];
  attachments: StudyAttachment[];
  report?: {
    score?: number;
    totalScore?: number;
    averageScore?: number;
    maximumScore?: number;
    rank?: number;
  };
}

export type MaterialType = 'all' | 'courseware' | 'document' | 'video' | 'audio' | 'image' | 'other';

export interface StudySubject extends Subject {
  hasPending: boolean;
}

export interface ClassMaterial {
  id: string;
  name: string;
  extension?: string;
  sizeBytes?: number;
  subject?: Subject;
  sharedBy?: string;
  sharedAt?: number;
  taskEndsAt?: number;
  learningState: 'pending' | 'learned' | 'unknown';
  attachment: StudyAttachment;
}

export interface BankSubject {
  id: string;
  name: string;
  stage: string;
}

export interface BankQuestionType {
  id: string;
  name: string;
  children: BankQuestionType[];
}

export interface BankTextbook {
  id: string;
  name: string;
  edition?: string;
  grade?: string;
  semester?: string;
}

export interface BankCatalogNode {
  id: string;
  title: string;
  selectable: boolean;
  children: BankCatalogNode[];
}

export interface BankQuestion {
  id: string;
  typeName: string;
  difficulty: string;
  isSubjective: boolean;
  stemHtml: string;
  optionsHtml: string[];
  answerHtml: string;
  analysisHtml: string;
  listeningTextHtml?: string;
  translationHtml?: string;
  /** Media-proxy URLs. */
  audioUrl?: string;
  videoUrl?: string;
  children: BankQuestion[];
  tags: string[];
  source?: string;
}

export interface BankQuery {
  subjectId: string;
  textbookId?: string;
  catalogId?: string;
  typeIds?: string[];
  difficultyIds?: string[];
  search?: string;
  sort: 'newest' | 'oldest';
  page: number;
  pageSize: number;
}

export interface LearningSocketMethods {
  'learning.signIn': {
    params:
      | { provider: 'changyan'; windowId: string; username: string; password: string }
      | { provider: 'xinjiaoyu'; windowId: string };
    result: { started: true };
  };
  'learning.signInCancel': { params: { provider: LearningProvider }; result: { cancelled: boolean } };
  'learning.signOut': { params: { provider: LearningProvider }; result: { signedOut: true } };

  'study.settings': { params: { retentionDays: number }; result: StudySync };
  'study.sync': { params: Record<string, never>; result: StudySync };
  'study.homework.list': {
    params: { bucket: 'active' | 'completed'; subjectCode?: string; page: number };
    result: LearningPage<HomeworkSummary>;
  };
  'study.homework.detail': { params: { id: string }; result: HomeworkDetail };
  'study.subjects': { params: Record<string, never>; result: { subjects: StudySubject[] } };
  'study.materials.list': {
    params: { subjectCode: string; state: 'pending' | 'learned'; type: MaterialType; page: number };
    result: LearningPage<ClassMaterial>;
  };
  /** Saves the attachment into 我的文件 if needed and resolves when it is saved. */
  'study.attachment.save': { params: { key: string }; result: { entryId: string } };

  'bank.subjects': { params: Record<string, never>; result: { subjects: BankSubject[] } };
  'bank.subject': {
    params: { subjectId: string };
    result: {
      types: BankQuestionType[];
      difficulties: { id: string; name: string }[];
      textbooks: BankTextbook[];
    };
  };
  'bank.catalog': { params: { subjectId: string; textbookId: string }; result: { nodes: BankCatalogNode[] } };
  'bank.questions': { params: BankQuery; result: LearningPage<BankQuestion> };

  /** Reading position per document object; zero-based page, offset 0..1 within it. */
  'document.progress.get': { params: { assetId: string }; result: { page: number; offset: number } | null };
  'document.progress.set': {
    params: { assetId: string; page: number; offset: number };
    result: { saved: true };
  };
}
