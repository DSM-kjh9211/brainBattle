/**
 * Canonical enumerations shared by server and clients.
 * Declared as const tuples so they can be used both as TS union types and zod enums.
 */
export const USER_ROLES = ['TEACHER', 'STUDENT', 'ADMIN'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const QUESTION_TYPES = [
  'MULTIPLE_CHOICE',
  'TRUE_FALSE',
  'SHORT_ANSWER',
  'NUMERIC',
  'LATEX',
  'ESSAY',
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** DIGITAL: content shown in BrainBattle. PAPER: answer-only sheet, content distributed elsewhere. */
export const DELIVERY_MODES = ['DIGITAL', 'PAPER'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const PROGRESS_MODES = ['SYNCHRONIZED', 'FREE'] as const;
export type ProgressMode = (typeof PROGRESS_MODES)[number];

export const SCORING_MODES = ['POINT_BASED', 'CORRECT_COUNT', 'ACCURACY_SPEED', 'CUSTOM'] as const;
export type ScoringMode = (typeof SCORING_MODES)[number];

export const GRADING_METHODS = [
  'EXACT',
  'NUMERIC',
  'TEXT_NORMALIZED',
  'MULTIPLE_CHOICE',
  'LATEX',
  'MANUAL',
] as const;
export type GradingMethod = (typeof GRADING_METHODS)[number];

export const SESSION_STATES = ['CREATED', 'LOBBY', 'READY', 'ACTIVE', 'PAUSED', 'FINISHED'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** Per-question phase (used for SYNCHRONIZED progress). */
export const QUESTION_PHASES = ['PENDING', 'PREPARE', 'ACTIVE', 'LOCKED', 'RESULT'] as const;
export type QuestionPhase = (typeof QUESTION_PHASES)[number];

export const PARTICIPANT_STATUSES = ['CONNECTED', 'DISCONNECTED', 'RECONNECTING', 'LEFT', 'KICKED'] as const;
export type ParticipantStatus = (typeof PARTICIPANT_STATUSES)[number];

export const EDIT_POLICIES = ['ALLOW', 'NO_EDIT', 'UNTIL_SESSION_END', 'UNTIL_QUESTION_END'] as const;
export type EditPolicy = (typeof EDIT_POLICIES)[number];

export const SCOREBOARD_VISIBILITIES = [
  'FULL',
  'TOP_10',
  'TOP_5',
  'TOP_3',
  'SELF_ONLY',
  'SCORES_ONLY',
  'HIDE_RANK',
  'PRIVATE',
] as const;
export type ScoreboardVisibility = (typeof SCOREBOARD_VISIBILITIES)[number];

/** When a student may learn whether their answer was correct (and see the correct answer). */
export const REVEAL_POLICIES = ['IMMEDIATE', 'AFTER_QUESTION', 'AFTER_SESSION', 'NEVER'] as const;
export type RevealPolicy = (typeof REVEAL_POLICIES)[number];

export const TIE_BREAKERS = [
  'CORRECT_COUNT_DESC',
  'LAST_SCORED_AT_ASC',
  'LAST_CORRECT_AT_ASC',
  'AVG_RESPONSE_MS_ASC',
] as const;
export type TieBreaker = (typeof TIE_BREAKERS)[number];

export const TIMESTAMP_SOURCES = ['CLIENT_TRUSTED', 'SERVER_FALLBACK'] as const;
export type TimestampSource = (typeof TIMESTAMP_SOURCES)[number];

export const GRADING_STATUSES = ['AUTO_GRADED', 'PENDING_MANUAL', 'MANUALLY_GRADED'] as const;
export type GradingStatus = (typeof GRADING_STATUSES)[number];

export const PRESENTATION_VIEWS = [
  'WAITING',
  'QUESTION',
  'SUBMISSION_STATUS',
  'ANSWER',
  'SCOREBOARD',
  'RESULTS',
] as const;
export type PresentationView = (typeof PRESENTATION_VIEWS)[number];

export const CLIENT_ROLES = ['TEACHER', 'STUDENT', 'SCOREBOARD'] as const;
export type ClientRole = (typeof CLIENT_ROLES)[number];

export const PRESETS = ['LIVE_QUIZ', 'PAPER_BATTLE', 'EXAM', 'CUSTOM'] as const;
export type PresetName = (typeof PRESETS)[number];

export const JOIN_CODE_FORMATS = ['NUMERIC_6', 'BRAIN_ALNUM'] as const;
export type JoinCodeFormat = (typeof JOIN_CODE_FORMATS)[number];
