import type {
  Choice,
  DeliveryMode,
  OwnSubmissionView,
  ParticipantDTO,
  QuestionReveal,
  QuestionStats,
  SessionQuestionTeacherView,
  StudentQuestionView,
  TeacherSubmissionView,
} from '@brainbattle/shared';
import type { ParticipantRecord, SessionQuestionRecord, SessionRecord, SubmissionRecord } from './types.js';

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

export function effectiveDelivery(session: SessionRecord, sq: SessionQuestionRecord): DeliveryMode {
  return session.settings.deliveryMode === 'PAPER' || sq.snapshot.deliveryMode === 'PAPER' ? 'PAPER' : 'DIGITAL';
}

/**
 * Student-safe projection. NEVER includes correctAnswer / acceptedAnswers / grading / explanation.
 * PAPER delivery strips the content: the sheet only shows "문제 7번  답: [ ]".
 */
export function toStudentQuestion(session: SessionRecord, sq: SessionQuestionRecord): StudentQuestionView {
  const delivery = effectiveDelivery(session, sq);
  const s = sq.snapshot;
  const choices: Choice[] | null = s.choices
    ? s.choices.map((c, i) =>
        delivery === 'PAPER'
          ? { id: c.id, label: c.label ?? CIRCLED[i] ?? String(i + 1), content: [] }
          : { id: c.id, label: c.label ?? CIRCLED[i] ?? String(i + 1), content: c.content ?? [] },
      )
    : null;
  return {
    sessionQuestionId: sq.id,
    position: sq.position,
    displayNumber: sq.displayNumber,
    type: s.type,
    deliveryMode: delivery,
    maxScore: sq.maxScore,
    timeLimitSec: sq.timeLimitSec,
    title: delivery === 'PAPER' ? null : s.title,
    description: delivery === 'PAPER' ? null : s.description,
    choices,
    multipleSelect: !!s.grading.multipleSelect,
    attachments: delivery === 'PAPER' ? [] : s.attachments ?? [],
  };
}

export function toReveal(sq: SessionQuestionRecord): QuestionReveal {
  return {
    sessionQuestionId: sq.id,
    correctAnswer: sq.snapshot.correctAnswer,
    acceptedAnswers: sq.snapshot.acceptedAnswers ?? [],
    explanation: sq.snapshot.explanation,
  };
}

export function toTeacherQuestion(session: SessionRecord, sq: SessionQuestionRecord): SessionQuestionTeacherView {
  return {
    sessionQuestionId: sq.id,
    questionId: sq.questionId,
    position: sq.position,
    displayNumber: sq.displayNumber,
    type: sq.snapshot.type,
    deliveryMode: effectiveDelivery(session, sq),
    title: sq.snapshot.title,
    maxScore: sq.maxScore,
    timeLimitSec: sq.timeLimitSec,
    phase: sq.phase,
    startedAt: sq.startedAt,
    deadlineAt: sq.deadlineAt,
    lockedAt: sq.lockedAt,
  };
}

export function toParticipantDTO(p: ParticipantRecord): ParticipantDTO {
  return {
    participantId: p.id,
    nickname: p.nickname,
    isGuest: p.isGuest,
    userId: p.userId,
    status: p.status,
    joinedAt: p.joinedAt,
    lastSeenAt: p.lastSeenAt,
    currentSessionQuestionId: p.currentSqId,
  };
}

export function toTeacherSubmission(s: SubmissionRecord): TeacherSubmissionView {
  return {
    submissionId: s.id,
    participantId: s.participantId,
    sessionQuestionId: s.sessionQuestionId,
    answer: s.answer,
    normalized: s.normalized,
    revision: s.revision,
    clientSentAt: s.clientSentAt,
    serverReceivedAt: s.serverReceivedAt,
    effectiveSubmittedAt: s.effectiveSubmittedAt,
    timestampSource: s.timestampSource,
    timestampReason: s.timestampReason,
    responseMs: s.responseMs,
    isCorrect: s.isCorrect,
    autoScore: s.autoScore,
    manualScore: s.manualScore,
    finalScore: s.finalScore,
    gradingStatus: s.gradingStatus,
    feedback: s.feedback,
  };
}

export function toOwnSubmission(s: SubmissionRecord, showGrade: boolean): OwnSubmissionView {
  const base: OwnSubmissionView = {
    submissionId: s.id,
    sessionQuestionId: s.sessionQuestionId,
    answer: s.answer,
    revision: s.revision,
    effectiveSubmittedAt: s.effectiveSubmittedAt,
    timestampSource: s.timestampSource,
  };
  if (!showGrade) return base;
  return {
    ...base,
    isCorrect: s.isCorrect,
    score: s.gradingStatus === 'PENDING_MANUAL' ? null : s.finalScore,
    gradingStatus: s.gradingStatus,
    feedback: s.feedback,
  };
}

export function computeStats(sqId: string, subs: Iterable<SubmissionRecord>): QuestionStats {
  let submitted = 0;
  let correct = 0;
  let pendingManual = 0;
  let graded = 0;
  let scoreSum = 0;
  for (const s of subs) {
    submitted++;
    if (s.gradingStatus === 'PENDING_MANUAL') {
      pendingManual++;
      continue;
    }
    graded++;
    scoreSum += s.finalScore;
    if (s.isCorrect) correct++;
  }
  return {
    sessionQuestionId: sqId,
    submitted,
    correct,
    pendingManual,
    correctRate: graded ? correct / graded : null,
    averageScore: graded ? scoreSum / graded : null,
  };
}
