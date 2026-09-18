import { z } from 'zod';
import { answerSchema } from './question.js';
import type { AnswerPayload, QuestionReveal, StudentQuestionView } from './question.js';
import { PRESENTATION_VIEWS, SCOREBOARD_VISIBILITIES } from './enums.js';
import type {
  ClientRole,
  DeliveryMode,
  GradingStatus,
  PresentationView,
  ProgressMode,
  QuestionPhase,
  ScoreboardVisibility,
  ScoringMode,
  SessionState,
  TimestampSource,
} from './enums.js';
import type { ErrorCode } from './errors.js';
import type { ParticipantDTO, SessionQuestionTeacherView, SessionSettings, TimingWindow } from './session.js';

export const PROTOCOL_VERSION = 1;

/* ------------------------------------------------------------------------------------------------
 * Client → Server
 * ----------------------------------------------------------------------------------------------*/

const id = z.string().min(1).max(64);

export const joinSessionSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('STUDENT'),
    /** first join: join code + nickname. Reconnect: sessionId + resumeToken. */
    joinCode: z.string().min(4).max(20).optional(),
    nickname: z.string().min(1).max(30).optional(),
    sessionId: id.optional(),
    resumeToken: z.string().min(16).max(200).optional(),
    /** optional student account JWT ("계정 참가") */
    authToken: z.string().max(4000).optional(),
    clockEpochId: z.string().min(4).max(64),
  }),
  z.object({ role: z.literal('TEACHER'), sessionId: id, authToken: z.string().max(4000) }),
  z.object({ role: z.literal('SCOREBOARD'), sessionId: id, scoreboardToken: z.string().max(4000) }),
]);
export type JoinSessionPayload = z.infer<typeof joinSessionSchema>;

export const submitAnswerSchema = z.object({
  sessionQuestionId: id,
  answer: answerSchema,
  /** Unique per user submit action. Retries (pending queue replays) MUST reuse the same key. */
  idempotencyKey: z.string().min(8).max(80),
  /** Client-estimated server time at the moment the student pressed submit (monotonic + offset). */
  clientSentAt: z.number().finite(),
  /** Raw monotonic reading (performance.now()) at submit, in the clock epoch below. */
  clientMonoAt: z.number().finite().nonnegative(),
  clockEpochId: z.string().min(4).max(64),
  /** For UPDATE_ANSWER: the revision the client is editing (optimistic concurrency). */
  baseRevision: z.number().int().nonnegative().optional(),
  /** true when this is a resend from the local pending queue after a disconnect. */
  replay: z.boolean().optional(),
});
export type SubmitAnswerPayload = z.infer<typeof submitAnswerSchema>;

export const timeSyncRequestSchema = z.object({
  seq: z.number().int().nonnegative(),
  clockEpochId: z.string().min(4).max(64),
  /** client monotonic time when the request was sent (t0) */
  clientMono: z.number().finite().nonnegative(),
  /** the client's result for the previous exchange, verified by the server */
  lastSample: z
    .object({
      seq: z.number().int().nonnegative(),
      offset: z.number().finite(),
      rtt: z.number().finite().nonnegative(),
    })
    .optional(),
});
export type TimeSyncRequestPayload = z.infer<typeof timeSyncRequestSchema>;

const empty = z.object({}).strict().optional().default({});

export const clientMessageSchemas = {
  JOIN_SESSION: joinSessionSchema,
  LEAVE_SESSION: empty,
  REQUEST_SNAPSHOT: empty,
  SUBMIT_ANSWER: submitAnswerSchema,
  UPDATE_ANSWER: submitAnswerSchema.extend({ baseRevision: z.number().int().nonnegative() }),
  TIME_SYNC_REQUEST: timeSyncRequestSchema,
  STUDENT_SELECT_QUESTION: z.object({ sessionQuestionId: id }),

  TEACHER_OPEN_LOBBY: empty,
  TEACHER_SET_READY: z.object({ ready: z.boolean() }),
  TEACHER_START_SESSION: empty,
  TEACHER_PAUSE_SESSION: empty,
  TEACHER_RESUME_SESSION: empty,
  TEACHER_END_SESSION: empty,
  TEACHER_START_QUESTION: z.object({
    sessionQuestionId: id,
    countdownSec: z.number().int().min(0).max(30).optional(),
    timeLimitSec: z.number().int().min(0).max(3600).nullable().optional(),
  }),
  TEACHER_END_QUESTION: z.object({ sessionQuestionId: id }),
  TEACHER_SHOW_RESULT: z.object({ sessionQuestionId: id }),
  TEACHER_SCORE_UPDATE: z.object({
    submissionId: id,
    score: z.number().min(0).max(100_000),
    feedback: z.string().max(2000).optional(),
  }),
  TEACHER_KICK_PARTICIPANT: z.object({ participantId: id, reason: z.string().max(200).optional() }),
  TEACHER_SET_SCOREBOARD: z.object({
    visibility: z.enum(SCOREBOARD_VISIBILITIES).optional(),
    visible: z.boolean().optional(),
  }),
  TEACHER_SET_PRESENTATION: z.object({
    view: z.enum(PRESENTATION_VIEWS),
    sessionQuestionId: id.nullable().optional(),
  }),
  TEACHER_EXTEND_TIME: z.object({ seconds: z.number().int().min(-3600).max(3600) }),
  TEACHER_RELEASE_RESULTS: empty,
} as const;

export type ClientMessageType = keyof typeof clientMessageSchemas;
export type ClientPayload<T extends ClientMessageType> = z.infer<(typeof clientMessageSchemas)[T]>;

export interface ClientEnvelope<T extends ClientMessageType = ClientMessageType> {
  type: T;
  /** correlation id; the server echoes it on the direct reply (ACK / ERROR / ANSWER_*) */
  reqId?: string;
  payload: ClientPayload<T>;
}

export const clientEnvelopeSchema = z.object({
  type: z.string().max(40),
  reqId: z.string().max(80).optional(),
  payload: z.unknown().optional(),
});

export const TEACHER_COMMANDS: ReadonlySet<ClientMessageType> = new Set([
  'TEACHER_OPEN_LOBBY',
  'TEACHER_SET_READY',
  'TEACHER_START_SESSION',
  'TEACHER_PAUSE_SESSION',
  'TEACHER_RESUME_SESSION',
  'TEACHER_END_SESSION',
  'TEACHER_START_QUESTION',
  'TEACHER_END_QUESTION',
  'TEACHER_SHOW_RESULT',
  'TEACHER_SCORE_UPDATE',
  'TEACHER_KICK_PARTICIPANT',
  'TEACHER_SET_SCOREBOARD',
  'TEACHER_SET_PRESENTATION',
  'TEACHER_EXTEND_TIME',
  'TEACHER_RELEASE_RESULTS',
]);

export const STUDENT_COMMANDS: ReadonlySet<ClientMessageType> = new Set([
  'SUBMIT_ANSWER',
  'UPDATE_ANSWER',
  'STUDENT_SELECT_QUESTION',
]);

/* ------------------------------------------------------------------------------------------------
 * Server → Client
 * ----------------------------------------------------------------------------------------------*/

export interface LeaderboardEntry {
  participantId: string;
  nickname: string;
  /** null when the policy hides ranks */
  rank: number | null;
  /** null when the policy hides scores (never for FULL/TOP_N) */
  score: number | null;
  correctCount: number;
  answeredCount: number;
}

export interface LeaderboardChange extends LeaderboardEntry {
  prevRank: number | null;
}

export interface OwnSubmissionView {
  submissionId: string;
  sessionQuestionId: string;
  answer: AnswerPayload;
  revision: number;
  effectiveSubmittedAt: number;
  timestampSource: TimestampSource;
  /** only present when the reveal policy allows it */
  isCorrect?: boolean | null;
  score?: number | null;
  gradingStatus?: GradingStatus;
  feedback?: string | null;
}

export interface TeacherSubmissionView {
  submissionId: string;
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
}

export interface QuestionStats {
  sessionQuestionId: string;
  submitted: number;
  correct: number;
  pendingManual: number;
  /** correct / graded submissions, 0..1 (null when nothing graded yet) */
  correctRate: number | null;
  averageScore: number | null;
}

export interface ParticipantScoreView {
  participantId: string;
  totalScore: number;
  correctCount: number;
  answeredCount: number;
  rank: number | null;
}

interface SessionCommon {
  sessionId: string;
  title: string;
  joinCode: string;
  state: SessionState;
  deliveryMode: DeliveryMode;
  progressMode: ProgressMode;
  scoringMode: ScoringMode;
  /** Session-wide window (FREE progress deadline, pauses). */
  timing: TimingWindow;
  currentSessionQuestionId: string | null;
  currentPhase: QuestionPhase | null;
  /** PREPARE → ACTIVE instant for the current question */
  questionOpensAt: number | null;
  questionDeadlineAt: number | null;
  questionCount: number;
  serverTime: number;
  eventSeq: number;
  scoreboard: { visibility: ScoreboardVisibility; visible: boolean };
  presentation: { view: PresentationView; sessionQuestionId: string | null };
  resultsReleased: boolean;
}

export interface StudentSessionState extends SessionCommon {
  role: 'STUDENT';
  participantId: string;
  nickname: string;
  /** Returned only on first join; the client stores it to resume after reconnect/reload. */
  resumeToken?: string;
  editPolicy: SessionSettings['editPolicy'];
  /** FREE progress: all questions; SYNCHRONIZED: questions already opened. */
  questions: StudentQuestionView[];
  submissions: OwnSubmissionView[];
  selectedSessionQuestionId: string | null;
  score: ParticipantScoreView | null;
  reveals: QuestionReveal[];
  participantCount: number;
}

export interface TeacherSessionState extends SessionCommon {
  role: 'TEACHER';
  settings: SessionSettings;
  questions: SessionQuestionTeacherView[];
  participants: ParticipantDTO[];
  submissions: TeacherSubmissionView[];
  scores: ParticipantScoreView[];
  stats: QuestionStats[];
  leaderboard: LeaderboardEntry[];
}

export interface ScoreboardSessionState extends SessionCommon {
  role: 'SCOREBOARD';
  participantCount: number;
  leaderboard: LeaderboardEntry[];
  presentationContent: PresentationContent | null;
}

export type AnySessionState = StudentSessionState | TeacherSessionState | ScoreboardSessionState;

export interface PresentationContent {
  view: PresentationView;
  question?: StudentQuestionView | null;
  reveal?: QuestionReveal | null;
  submissionStatus?: { submitted: number; total: number } | null;
  stats?: QuestionStats | null;
}

export interface ServerEventMap {
  SESSION_STATE: AnySessionState;
  PARTICIPANT_JOIN: { participant: ParticipantDTO; participantCount: number };
  PARTICIPANT_LEAVE: { participantId: string; status: ParticipantDTO['status']; participantCount: number };
  PARTICIPANT_RECONNECT: { participantId: string; participantCount: number };
  PARTICIPANT_STATUS: { participantId: string; status: ParticipantDTO['status']; currentSessionQuestionId?: string | null };
  SESSION_STATE_CHANGE: { state: SessionState; timing: TimingWindow; at: number };
  SESSION_START: { state: SessionState; timing: TimingWindow; at: number };
  SESSION_PAUSE: { state: SessionState; timing: TimingWindow; at: number };
  SESSION_RESUME: { state: SessionState; timing: TimingWindow; at: number; questionDeadlineAt: number | null };
  SESSION_END: { state: SessionState; timing: TimingWindow; at: number };
  SESSION_LOCKED: { at: number };
  DEADLINE_UPDATE: { sessionDeadlineAt: number | null; sessionQuestionId: string | null; questionDeadlineAt: number | null };
  QUESTION_PREPARE: { sessionQuestionId: string; opensAt: number; question?: StudentQuestionView };
  QUESTION_START: { sessionQuestionId: string; startedAt: number; deadlineAt: number | null; question?: StudentQuestionView };
  QUESTION_END: { sessionQuestionId: string; lockedAt: number };
  QUESTION_RESULT: { sessionQuestionId: string; reveal: QuestionReveal | null; stats: QuestionStats | null };
  ANSWER_ACCEPTED: { submission: OwnSubmissionView; duplicate: boolean };
  ANSWER_UPDATED: { submission: OwnSubmissionView; duplicate: boolean };
  ANSWER_REJECTED: { sessionQuestionId: string; idempotencyKey: string; code: ErrorCode; message: string };
  SUBMISSION_RECEIVED: { submission: TeacherSubmissionView; stats: QuestionStats };
  SUBMISSION_GRADED: { submission: OwnSubmissionView };
  SCORE_UPDATE: { scores: ParticipantScoreView[] };
  LEADERBOARD_UPDATE: { version: number; changes: LeaderboardChange[]; removed: string[]; total: number };
  LEADERBOARD_SNAPSHOT: { version: number; entries: LeaderboardEntry[]; total: number; visibility: ScoreboardVisibility; visible: boolean };
  STATS_UPDATE: { stats: QuestionStats[] };
  SCOREBOARD_SETTINGS: { visibility: ScoreboardVisibility; visible: boolean };
  PRESENTATION_UPDATE: { view: PresentationView; sessionQuestionId: string | null; content: PresentationContent | null };
  RESULTS_RELEASED: { reveals: QuestionReveal[]; submissions: OwnSubmissionView[] };
  TIME_SYNC_RESPONSE: { seq: number; clientMono: number; serverReceivedAt: number; serverSentAt: number; accepted: boolean };
  KICKED: { reason: string | null };
  ACK: { ok: true; result?: unknown };
  ERROR: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}

export type ServerEventType = keyof ServerEventMap;

export interface ServerEnvelope<T extends ServerEventType = ServerEventType> {
  type: T;
  reqId?: string;
  /** per-session broadcast sequence (monotonic); omitted for direct replies */
  seq?: number;
  payload: ServerEventMap[T];
}

export type { ClientRole };
