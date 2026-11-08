import { ExpandMore, ExpandLess } from '@mui/icons-material';
import { Button, Chip, Collapse } from '@mui/material';
import { useEffect, useState } from 'react';
import type { BankQuestion, HomeworkQuestion } from '../../shared/learning';
import { isControlMediaUrl, LearningHtml, stripOptionLabel } from './html';

export function QuestionCard({
  question,
  number,
  showAnswers = false,
  nested = false,
}: {
  question: BankQuestion | HomeworkQuestion;
  number: string;
  showAnswers?: boolean;
  nested?: boolean;
}) {
  const [expanded, setExpanded] = useState(showAnswers);
  const [transcript, setTranscript] = useState(false);
  useEffect(() => setExpanded(showAnswers), [showAnswers]);
  const bank = 'difficulty' in question ? question : undefined;
  const homework = 'difficulty' in question ? undefined : question;
  const letters = (question.answerHtml ?? '')
    .replace(/<[^>]*>/g, '')
    .trim()
    .toUpperCase();
  const hasAnswer = !!(question.answerHtml || question.analysisHtml || bank?.translationHtml);
  return (
    <article className={`question-card${nested ? ' question-child' : ''}`}>
      <div className="question-meta">
        <span className="question-number">{number}</span>
        <Chip size="small" label={question.typeName} />
        {bank?.difficulty && <Chip size="small" variant="outlined" label={bank.difficulty} />}
        {bank?.source && (
          <span className="question-source" title={bank.source}>
            {bank.source}
          </span>
        )}
      </div>
      <LearningHtml html={question.stemHtml} />
      {bank?.audioUrl && isControlMediaUrl(bank.audioUrl) && (
        <audio controls preload="none" src={bank.audioUrl} aria-label="题目音频" />
      )}
      {bank?.listeningTextHtml && (
        <>
          <Button
            className="question-transcript-toggle"
            endIcon={transcript ? <ExpandLess /> : <ExpandMore />}
            onClick={() => setTranscript(!transcript)}
            aria-expanded={transcript}
          >
            听力原文
          </Button>
          <Collapse in={transcript}>
            <LearningHtml html={bank.listeningTextHtml} />
          </Collapse>
        </>
      )}
      {bank?.videoUrl && isControlMediaUrl(bank.videoUrl) && (
        <video controls preload="none" src={bank.videoUrl} aria-label="题目视频" />
      )}
      {question.optionsHtml.map((option, index) => {
        const letter = String.fromCharCode(65 + index);
        return (
          <div
            key={index}
            className={`question-option${expanded && /^[A-Z\s,，、]+$/.test(letters) && letters.includes(letter) ? ' correct-option' : ''}`}
          >
            <span>{letter}</span>
            <LearningHtml html={stripOptionLabel(option)} />
          </div>
        );
      })}
      {question.children.map((child, index) => (
        <QuestionCard
          key={child.id}
          question={child}
          number={`(${index + 1})`}
          showAnswers={showAnswers}
          nested
        />
      ))}
      {(homework?.studentAnswerHtml || homework?.score !== undefined) && (
        <div className="question-student">
          {homework.studentAnswerHtml && (
            <>
              <strong>我的答案</strong>
              <LearningHtml html={homework.studentAnswerHtml} />
            </>
          )}
          {homework.score !== undefined && (
            <span>
              得分 {homework.score}/{homework.totalScore ?? '—'}
            </span>
          )}
        </div>
      )}
      {!!bank?.tags.length && (
        <div className="learning-chips">
          {bank.tags.map((tag) => (
            <Chip size="small" variant="outlined" key={tag} label={tag} />
          ))}
        </div>
      )}
      {hasAnswer && (
        <>
          <Button
            className="question-answer-toggle"
            endIcon={expanded ? <ExpandLess /> : <ExpandMore />}
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
          >
            {expanded ? '收起答案与解析' : '答案与解析'}
          </Button>
          <Collapse in={expanded}>
            {question.answerHtml && (
              <div className="question-answer">
                <strong>答案</strong>
                <LearningHtml html={question.answerHtml} />
              </div>
            )}
            {question.analysisHtml && (
              <>
                <strong>解析</strong>
                <LearningHtml html={question.analysisHtml} />
              </>
            )}
            {bank?.translationHtml && (
              <>
                <strong>参考译文</strong>
                <LearningHtml html={bank.translationHtml} />
              </>
            )}
          </Collapse>
        </>
      )}
    </article>
  );
}
