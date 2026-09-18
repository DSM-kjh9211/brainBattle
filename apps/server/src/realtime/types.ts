import type {
  AnswerPayload,
  GradingStatus,
  ParticipantStatus,
  PauseInterval,
  PresentationView,
  PresetName,
  QuestionPhase,
  SessionSettings,
  SessionState,
  TimestampSource,
} from '@brainbattle/shared';
import type { QuestionSnapshot } from '../domain/grading.js';
import type { ClockSyncState } from '../domain/timeTrust.js';

export interface SessionRecord {
  id: string;
  teacherId: string;
  questionSetId: string | null;
  title: string;
  joinCode: string;
  preset: PresetName;
  state: SessionState;
  settings: SessionSettings;
  currentSqId: string | null;
  presentation: { view: PresentationView; sessionQuestionId: string | null };
  startedAt: number | null;
  deadlineAt: number | null;
  pauses: PauseInterval[];
  lockedAt: number | null;
  finishedAt: number | null;
  resultsReleased: boolean;
  eventSeq: number;
  version: number;
}

export interface SessionQuestionRecord {
  id: string;
  sessionId: string;
  questionId: string;
  position: number;
  displayNumber: string;
  snapshot: QuestionSnapshot;
  maxScore: number;
  timeLimitSec: number | null;
  phase: QuestionPhase;
  opensAt: number | null;
  startedAt: number | null;
  deadlineAt: number | null;
  lockedAt: number | null;
  pauses: PauseInterval[];
}

export interface ParticipantRecord {
  id: string;
  sessionId: string;
  userId: string | null;
  nickname: string;
  nicknameKey: string;
  isGuest: boolean;
  status: ParticipantStatus;
  resumeTokenHash: string;
  joinedAt: number;
  lastSeenAt: number | null;
  disconnectedAt: number | null;
  currentSqId: string | null;
  progress: { finalized?: string[] };
  clockSync: Record<string, ClockSyncState>;
  /** memory only */
  reconnectedAt: number | null;
  lastClientTimestamp: number | null;
}

export interface SubmissionRecord {
  id: string;
  sessionId: string;
  participantId: string;
  sessionQuestionId: string;
  answer: AnswerPayload;
  normalized: string | null;
  revision: number;
  clientSentAt: number | null;
  serverReceivedAt: number;
  effectiveSubmittedAt: number;
  timestampSource: TimestampSource;
  timestampReason: string;
  responseMs: number | null;
  isCorrect: boolean | null;
  autoScore: number | null;
  manualScore: number | null;
  finalScore: number;
  gradingStatus: GradingStatus;
  feedback: string | null;
  gradedBy: string | null;
  gradedAt: number | null;
}

export interface ScoreRecord {
  participantId: string;
  totalScore: number;
  correctCount: number;
  answeredCount: number;
  lastScoredAt: number | null;
  lastCorrectAt: number | null;
  totalResponseMs: number;
}

export interface SessionAggregate {
  session: SessionRecord;
  questions: SessionQuestionRecord[];
  participants: ParticipantRecord[];
  submissions: SubmissionRecord[];
  idempotencyKeys: { participantId: string; key: string; submissionId: string; revision: number }[];
}

export interface SessionEventRecord {
  seq: number;
  type: string;
  actorType: 'TEACHER' | 'STUDENT' | 'SYSTEM' | 'SCOREBOARD';
  actorId: string | null;
  payload: Record<string, unknown>;
  at: number;
}
