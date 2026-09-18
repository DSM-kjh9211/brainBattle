import { z } from 'zod';
import {
  DELIVERY_MODES,
  EDIT_POLICIES,
  JOIN_CODE_FORMATS,
  PROGRESS_MODES,
  REVEAL_POLICIES,
  SCOREBOARD_VISIBILITIES,
  SCORING_MODES,
  TIE_BREAKERS,
} from './enums.js';
import type {
  DeliveryMode,
  ParticipantStatus,
  PresentationView,
  PresetName,
  ProgressMode,
  QuestionPhase,
  ScoringMode,
  SessionState,
} from './enums.js';

export const sessionSettingsSchema = z.object({
  deliveryMode: z.enum(DELIVERY_MODES),
  progressMode: z.enum(PROGRESS_MODES),
  scoringMode: z.enum(SCORING_MODES),
  join: z.object({
    allowGuests: z.boolean(),
    requireLogin: z.boolean(),
    classroomId: z.string().max(60).nullable(),
    maxParticipants: z.number().int().min(1).max(5000),
    allowDuplicateNicknames: z.boolean(),
    /** Allow joining after the session became ACTIVE. */
    allowLateJoin: z.boolean(),
    joinCodeFormat: z.enum(JOIN_CODE_FORMATS),
  }),
  editPolicy: z.enum(EDIT_POLICIES),
  revealPolicy: z.enum(REVEAL_POLICIES),
  scoreboard: z.object({
    visibility: z.enum(SCOREBOARD_VISIBILITIES),
    /** Teacher can hide/show the board at any time without changing the visibility policy. */
    visible: z.boolean(),
  }),
  ranking: z.object({
    /** true: equal score => equal rank (competition ranking 1,2,2,4); tie breakers ignored. */
    allowTies: z.boolean(),
    tieBreakers: z.array(z.enum(TIE_BREAKERS)).max(4),
  }),
  timing: z.object({
    /** FREE progress: overall session duration. null = no time limit (teacher ends manually). */
    sessionTimeLimitSec: z.number().int().min(10).max(24 * 3600).nullable(),
    /** SYNCHRONIZED: fallback per-question limit when the question has none. null = until teacher ends. */
    defaultQuestionTimeLimitSec: z.number().int().min(3).max(3600).nullable(),
    /** SYNCHRONIZED: QUESTION_PREPARE countdown before a question opens. */
    prepareCountdownSec: z.number().int().min(0).max(30),
    /** Accept in-flight submissions whose trusted timestamp precedes the deadline for this long. */
    lateGraceMs: z.number().int().min(0).max(5000),
    /** Max offline window during which a queued (pending) submission can claim its client time. */
    offlineReplayWindowMs: z.number().int().min(0).max(10 * 60_000),
  }),
  speed: z.object({
    /** fraction of max score guaranteed for a correct answer, the rest decays linearly with time */
    minRatio: z.number().min(0).max(1),
    /** reference window when a question has no time limit */
    windowSec: z.number().int().min(1).max(3600),
  }),
  /** Automatically release per-student results when the session finishes. */
  releaseResultsOnEnd: z.boolean(),
});
export type SessionSettings = z.infer<typeof sessionSettingsSchema>;

/** Partial overrides accepted from the teacher. */
export const sessionSettingsPatchSchema = z.object({
  deliveryMode: z.enum(DELIVERY_MODES).optional(),
  progressMode: z.enum(PROGRESS_MODES).optional(),
  scoringMode: z.enum(SCORING_MODES).optional(),
  join: sessionSettingsSchema.shape.join.partial().optional(),
  editPolicy: z.enum(EDIT_POLICIES).optional(),
  revealPolicy: z.enum(REVEAL_POLICIES).optional(),
  scoreboard: sessionSettingsSchema.shape.scoreboard.partial().optional(),
  ranking: sessionSettingsSchema.shape.ranking.partial().optional(),
  timing: sessionSettingsSchema.shape.timing.partial().optional(),
  speed: sessionSettingsSchema.shape.speed.partial().optional(),
  releaseResultsOnEnd: z.boolean().optional(),
});
export type SessionSettingsPatch = z.infer<typeof sessionSettingsPatchSchema>;

const BASE: SessionSettings = {
  deliveryMode: 'DIGITAL',
  progressMode: 'SYNCHRONIZED',
  scoringMode: 'POINT_BASED',
  join: {
    allowGuests: true,
    requireLogin: false,
    classroomId: null,
    maxParticipants: 200,
    allowDuplicateNicknames: false,
    allowLateJoin: true,
    joinCodeFormat: 'NUMERIC_6',
  },
  editPolicy: 'ALLOW',
  revealPolicy: 'AFTER_QUESTION',
  scoreboard: { visibility: 'FULL', visible: true },
  ranking: { allowTies: false, tieBreakers: ['CORRECT_COUNT_DESC', 'LAST_SCORED_AT_ASC'] },
  timing: {
    sessionTimeLimitSec: null,
    defaultQuestionTimeLimitSec: 30,
    prepareCountdownSec: 3,
    lateGraceMs: 1000,
    offlineReplayWindowMs: 120_000,
  },
  speed: { minRatio: 0.5, windowSec: 30 },
  releaseResultsOnEnd: true,
};

/** Operating presets (defaults only; every field can be overridden by the teacher). */
export const PRESET_SETTINGS: Record<Exclude<PresetName, 'CUSTOM'>, SessionSettings> = {
  LIVE_QUIZ: {
    ...BASE,
    deliveryMode: 'DIGITAL',
    progressMode: 'SYNCHRONIZED',
    scoringMode: 'ACCURACY_SPEED',
    editPolicy: 'UNTIL_QUESTION_END',
    revealPolicy: 'AFTER_QUESTION',
    scoreboard: { visibility: 'TOP_10', visible: true },
  },
  PAPER_BATTLE: {
    ...BASE,
    deliveryMode: 'PAPER',
    progressMode: 'FREE',
    scoringMode: 'POINT_BASED',
    // competition: the first answer counts (live scores would otherwise reveal correctness)
    editPolicy: 'NO_EDIT',
    revealPolicy: 'IMMEDIATE',
    scoreboard: { visibility: 'FULL', visible: true },
    timing: { ...BASE.timing, sessionTimeLimitSec: 50 * 60, defaultQuestionTimeLimitSec: null },
  },
  EXAM: {
    ...BASE,
    deliveryMode: 'PAPER',
    progressMode: 'FREE',
    scoringMode: 'POINT_BASED',
    editPolicy: 'UNTIL_SESSION_END',
    revealPolicy: 'AFTER_SESSION',
    scoreboard: { visibility: 'PRIVATE', visible: false },
    join: { ...BASE.join, allowLateJoin: true },
    timing: { ...BASE.timing, sessionTimeLimitSec: 50 * 60, defaultQuestionTimeLimitSec: null },
    releaseResultsOnEnd: false,
  },
};

export function resolveSessionSettings(
  preset: PresetName,
  patch: SessionSettingsPatch | undefined,
  base?: SessionSettings,
): SessionSettings {
  const start: SessionSettings =
    base ?? (preset === 'CUSTOM' ? BASE : PRESET_SETTINGS[preset]);
  const p = patch ?? {};
  const merged: SessionSettings = {
    ...start,
    ...(p.deliveryMode ? { deliveryMode: p.deliveryMode } : {}),
    ...(p.progressMode ? { progressMode: p.progressMode } : {}),
    ...(p.scoringMode ? { scoringMode: p.scoringMode } : {}),
    ...(p.editPolicy ? { editPolicy: p.editPolicy } : {}),
    ...(p.revealPolicy ? { revealPolicy: p.revealPolicy } : {}),
    ...(p.releaseResultsOnEnd !== undefined ? { releaseResultsOnEnd: p.releaseResultsOnEnd } : {}),
    join: { ...start.join, ...stripUndefined(p.join) },
    scoreboard: { ...start.scoreboard, ...stripUndefined(p.scoreboard) },
    ranking: { ...start.ranking, ...stripUndefined(p.ranking) },
    timing: { ...start.timing, ...stripUndefined(p.timing) },
    speed: { ...start.speed, ...stripUndefined(p.speed) },
  };
  return sessionSettingsSchema.parse(merged);
}

export interface SettingsWarning {
  code: string;
  message: string;
}

/**
 * Some combinations are legal but have consequences the teacher should confirm.
 * (Requirement conflict: "answer editing" + "live scoring" lets a student observe their score
 *  change and fix the answer until it is correct. We keep both features and warn instead.)
 */
export function settingsWarnings(s: SessionSettings): SettingsWarning[] {
  const out: SettingsWarning[] = [];
  const editable = s.editPolicy !== 'NO_EDIT';
  // With any other reveal policy the server holds score changes until the question/session
  // closes (see SessionRuntime.holdScores), so live scores cannot leak correctness.
  if (editable && s.revealPolicy === 'IMMEDIATE') {
    out.push({
      code: 'EDIT_WITH_LIVE_FEEDBACK',
      message:
        '답안 수정이 허용된 상태에서 정오/점수가 즉시 공개됩니다. 학생이 결과를 보고 답을 고칠 수 있습니다. ' +
        '경쟁 목적이면 "제출 후 수정 불가" 또는 "문제 종료 후 공개"를 권장합니다.',
    });
  }
  if (s.scoringMode === 'ACCURACY_SPEED' && s.progressMode === 'FREE') {
    out.push({
      code: 'SPEED_IN_FREE_MODE',
      message: '자유 진행에서는 풀이 시간이 세션 시작 시각부터 계산됩니다.',
    });
  }
  if (s.join.classroomId && !s.join.requireLogin) {
    out.push({ code: 'CLASSROOM_IMPLIES_LOGIN', message: '학급 제한이 설정되어 있어 로그인이 필수로 적용됩니다.' });
  }
  if (s.progressMode === 'FREE' && s.timing.sessionTimeLimitSec === null) {
    out.push({ code: 'NO_SESSION_DEADLINE', message: '세션 제한 시간이 없어 교사가 직접 종료해야 답안이 잠깁니다.' });
  }
  return out;
}

function stripUndefined<T extends object>(o: T | undefined): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export const questionSetInputSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5_000).optional().nullable(),
  deliveryMode: z.enum(DELIVERY_MODES).default('DIGITAL'),
  progressMode: z.enum(PROGRESS_MODES).default('SYNCHRONIZED'),
  scoringMode: z.enum(SCORING_MODES).default('POINT_BASED'),
});

export interface QuestionSetItemDTO {
  id: string;
  questionId: string;
  position: number;
  /** effective display number (override ?? question default ?? position+1) */
  displayNumber: string;
  displayNumberOverride: string | null;
  scoreOverride: number | null;
}

export interface QuestionSetDTO {
  id: string;
  ownerId: string;
  title: string;
  description: string | null;
  deliveryMode: DeliveryMode;
  progressMode: ProgressMode;
  scoringMode: ScoringMode;
  items: QuestionSetItemDTO[];
  questionCount: number;
  createdAt: string;
  updatedAt: string;
}

export const createSessionSchema = z.object({
  questionSetId: z.string().min(1),
  title: z.string().max(200).optional(),
  preset: z.enum(['LIVE_QUIZ', 'PAPER_BATTLE', 'EXAM', 'CUSTOM']).default('CUSTOM'),
  settings: sessionSettingsPatchSchema.optional(),
});

export interface PauseInterval {
  pausedAt: number;
  resumedAt: number | null;
}

/** Server-side authoritative timing for a synchronized question or the free-progress session window. */
export interface TimingWindow {
  /** epoch ms (server clock) */
  startedAt: number | null;
  /** epoch ms deadline adjusted for pauses; null = open-ended */
  deadlineAt: number | null;
  pauses: PauseInterval[];
}

export interface SessionQuestionTeacherView {
  sessionQuestionId: string;
  questionId: string;
  position: number;
  displayNumber: string;
  type: import('./enums.js').QuestionType;
  deliveryMode: DeliveryMode;
  title: string | null;
  maxScore: number;
  timeLimitSec: number | null;
  phase: QuestionPhase;
  startedAt: number | null;
  deadlineAt: number | null;
  lockedAt: number | null;
}

export interface SessionSummaryDTO {
  id: string;
  title: string;
  joinCode: string;
  state: SessionState;
  preset: PresetName;
  questionSetId: string;
  teacherId: string;
  participantCount: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ParticipantDTO {
  participantId: string;
  nickname: string;
  isGuest: boolean;
  userId: string | null;
  status: ParticipantStatus;
  joinedAt: number;
  lastSeenAt: number | null;
  currentSessionQuestionId: string | null;
}

export type { PresentationView };
