export interface Subject {
  code: string;
  name: string;
  stage?: string;
}

export interface ProviderResult<T, S> {
  data: T;
  session: S;
}

export interface Page<T> {
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
  accessibleTotal: number;
  items: T[];
}

export interface ClassMaterial {
  id: string;
  name: string;
  extension?: string;
  sizeBytes?: number;
  md5?: string;
  subject?: Subject;
  sharedBy?: { id: string; name: string };
  sharedAt?: number;
  learningState?: 'pending' | 'learned' | 'unknown';
  phase?: 'before-class' | 'in-class' | 'after-class' | 'unknown';
  taskEndsAt?: number;
}

export interface Attachment {
  id: string;
  name: string;
  extension?: string;
  sizeBytes?: number;
  md5?: string;
  url: string;
  previewImageUrls?: string[];
}

export interface HomeworkItem {
  id: string;
  title: string;
  subject?: Subject;
  type?: { code: number; name: string };
  startsAt?: number;
  endsAt?: number;
  submittedAt?: number;
  score?: number;
  totalScore?: number;
  state: {
    bucket?: 'active' | 'completed';
    code?: number;
    name?: string;
    submitted?: boolean;
    completionCode?: number;
    correctionCode?: number;
  };
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
  mediaUrls: string[];
}

export interface HomeworkSubmission {
  id: string;
  homeworkId: string;
  status?: number;
  committed?: boolean;
  beganAt?: number;
  endsAt?: number;
  score?: number;
  totalScore?: number;
  correctedQuestions?: number;
  totalQuestions?: number;
}

export interface HomeworkReport {
  kind: 'standard' | 'spoken';
  score?: number;
  totalScore?: number;
  scoreRate?: number;
  averageScore?: number;
  maximumScore?: number;
  rank?: number;
  submittedAt?: number;
  submittedDurationSeconds?: number;
  questions: HomeworkQuestion[];
  attachments: Attachment[];
}

export interface HomeworkDetail extends HomeworkItem {
  description: string;
  questions: HomeworkQuestion[];
  attachments: Attachment[];
  showAnswers?: boolean;
  report?: HomeworkReport;
  submission?: HomeworkSubmission;
}

export interface Question {
  id: string;
  questionType: { id: string; name: string; subtype?: { id: string; name: string } };
  difficulty: { id: string; name: string };
  isSubjective: boolean;
  stemHtml: string;
  optionsHtml: string[];
  answerHtml: string;
  analysisHtml: string;
  listeningTextHtml?: string;
  translationHtml?: string;
  audioUrl?: string;
  videoUrl?: string;
  children: Question[];
  tags: Array<{ id: string; name: string; category: string }>;
  sources: Array<{ id: string; name: string; note: string }>;
  mediaUrls: string[];
}
