import { list, record, text, number, malformed } from '../http.js';
import { collectMediaUrls, stripOptionLabel } from '../html.js';
import type { HomeworkQuestion } from '../models.js';

function html(value: unknown): string {
  if (Array.isArray(value)) return value.map(html).filter(Boolean).join('<br>');
  if (value && typeof value === 'object') {
    const raw = record(value);
    return html(raw.content ?? raw.value);
  }
  return text(value);
}

function formula(value: unknown): string {
  const source = text(value);
  if (!source) return '';
  // These two report fields are MathQuill input, rather than HTML from the question bank.
  return `\\(${source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}\\)`;
}

export function normalizeHomeworkQuestion(
  value: unknown,
  fallbackNumber: string,
  inheritedType = '',
): HomeworkQuestion {
  const source = record(value);
  const detail = source.questionDetail ?? source.childQuestionDetail;
  const raw = detail == null ? source : { ...source, ...record(detail) };
  const answerDetail =
    raw.childQuestionAnswerDetail == null ? undefined : record(raw.childQuestionAnswerDetail);
  const typeName =
    text(raw.questionTypeName ?? raw.typeName ?? raw.sectionName ?? raw.sectionCategoryName) || inheritedType;
  const nested =
    raw.childQuestions ??
    raw.subTopics ??
    raw.childrenQuestions ??
    raw.children ??
    raw.questions ??
    raw.subQuestions;
  const children =
    nested == null
      ? []
      : list(nested).map((item, index) =>
          normalizeHomeworkQuestion(item, `${fallbackNumber}.${index + 1}`, typeName),
        );
  const options = raw.options ?? raw.optionsList ?? raw.optionList;
  let optionsHtml =
    options == null
      ? []
      : list(options).map((value, index) => {
          const option = value && typeof value === 'object' ? record(value) : undefined;
          return stripOptionLabel(
            html(option ? (option.content ?? option.optionContent ?? option.value) : value),
            index,
          );
        });
  if (options == null && raw.optionCount != null) {
    const count = number(raw.optionCount);
    if (count === undefined || !Number.isInteger(count) || count < 0 || count > 26) return malformed();
    // Free-form answer sheets supply option counts; the actual choice text lives in attachments.
    optionsHtml = Array.from({ length: count }, () => '');
  }
  const answerHtml =
    raw.answers != null
      ? list(raw.answers)
          .map((value) => {
            const answer = record(value);
            const alternatives = answer.alternativeValues == null ? [] : list(answer.alternativeValues);
            return [answer.value, ...alternatives].map(formula).join(' 或 ');
          })
          .join('<br>')
      : html(raw.answer ?? raw.correctAnswer ?? raw.standardAnswer);
  const studentAnswerHtml =
    answerDetail?.studentAnswer !== undefined
      ? formula(answerDetail.studentAnswer)
      : raw.stuAnswer !== undefined
        ? formula(raw.stuAnswer)
        : html(raw.studentAnswer);
  const analysisHtml = html(raw.analysis ?? raw.explanation ?? raw.parse);
  const score = number(
    raw.stuScore ?? raw.studentScore ?? answerDetail?.score ?? (detail == null ? raw.score : undefined),
  );
  const totalScore = number(raw.totalScore ?? raw.fullScore ?? (detail == null ? undefined : raw.score));
  return {
    id: text(raw.childQuestionId ?? raw.questionId ?? raw.topicId ?? raw.id) || `group:${fallbackNumber}`,
    number: text(raw.questionNo ?? raw.number ?? raw.sort) || fallbackNumber,
    typeName,
    stemHtml: html(
      raw.content ??
        raw.stem ??
        raw.questionContent ??
        raw.topicContent ??
        raw.questionTitle ??
        raw.title ??
        raw.sectionName,
    ),
    optionsHtml,
    children,
    ...(answerHtml ? { answerHtml } : {}),
    ...(analysisHtml ? { analysisHtml } : {}),
    ...(studentAnswerHtml ? { studentAnswerHtml } : {}),
    ...(score !== undefined ? { score } : {}),
    ...(totalScore !== undefined ? { totalScore } : {}),
    mediaUrls: collectMediaUrls([raw]),
  };
}

export function normalizeHomeworkQuestions(value: unknown): HomeworkQuestion[] {
  return list(value).map((item, index) => normalizeHomeworkQuestion(item, String(index + 1)));
}
