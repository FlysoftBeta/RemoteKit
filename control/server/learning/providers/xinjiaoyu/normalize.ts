import type { Question } from '../models.js';
import { list, record, requiredText, text } from '../http.js';
import { collectMediaUrls, stripOptionLabel } from '../html.js';

export function normalizeQuestion(value: unknown): Question {
  const raw = record(value);
  const optionsHtml =
    raw.optionsList == null
      ? []
      : list(raw.optionsList).map((item, index) => stripOptionLabel(text(item), index));
  const analysisParts = [
    text(raw.decipherment),
    ...(raw.answerExplanation == null ? [] : list(raw.answerExplanation).map(text)),
  ].filter(Boolean);
  const children = raw.childrenQuestions == null ? [] : list(raw.childrenQuestions).map(normalizeQuestion);
  const listeningTextHtml = text(raw.listeningText);
  const translationHtml = text(raw.chineseText);
  const audioUrl = text(raw.questionAudio);
  const videoUrl = text(raw.questionVideo);
  const subtypeId = text(raw.secondTypeId);
  const subtypeName = text(raw.secondTypeName);
  return {
    id: requiredText(raw.id),
    questionType: {
      id: text(raw.typeId),
      name: text(raw.typeName),
      ...(subtypeId || subtypeName ? { subtype: { id: subtypeId, name: subtypeName } } : {}),
    },
    difficulty: { id: text(raw.difficultyId), name: text(raw.difficultyName) },
    isSubjective: raw.isSubjective === true || raw.isSubjective === 1 || raw.isSubjective === 'true',
    stemHtml: text(raw.content),
    optionsHtml,
    answerHtml: Array.isArray(raw.answer) ? raw.answer.map(text).join('、') : text(raw.answer),
    analysisHtml: analysisParts.join('\n'),
    ...(listeningTextHtml ? { listeningTextHtml } : {}),
    ...(translationHtml ? { translationHtml } : {}),
    ...(audioUrl ? { audioUrl } : {}),
    ...(videoUrl ? { videoUrl } : {}),
    children,
    tags: (raw.tagFeatureInfo == null ? [] : list(raw.tagFeatureInfo)).map((value) => {
      const tag = record(value);
      return { id: text(tag.tagId), name: text(tag.tagName), category: text(tag.tagDimensionName) };
    }),
    sources: (raw.sourceFeatureInfo == null ? [] : list(raw.sourceFeatureInfo)).map((value) => {
      const source = record(value);
      return {
        id: text(source.sourceId),
        name: text(source.sourceName),
        note: text(source.sourceFullNote) || text(source.sourceShortNote),
      };
    }),
    mediaUrls: collectMediaUrls([raw]),
  };
}
