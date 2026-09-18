import type { QuestionPhase, SessionState } from './enums.js';

/**
 * Session state machine.
 *
 *   CREATED ──open──▶ LOBBY ──ready──▶ READY ──start──▶ ACTIVE ⇄ PAUSED
 *                      ▲  └──────start──────────────────▶ │         │
 *                      └──reopen── READY                   ▼         ▼
 *   (any non-terminal) ─────────────────end──────────────▶ FINISHED (terminal)
 *
 * The server is the only component that applies transitions; clients use this table
 * purely to decide which buttons to enable.
 */
export const SESSION_TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  CREATED: ['LOBBY', 'FINISHED'],
  LOBBY: ['READY', 'ACTIVE', 'FINISHED'],
  READY: ['LOBBY', 'ACTIVE', 'FINISHED'],
  ACTIVE: ['PAUSED', 'FINISHED'],
  PAUSED: ['ACTIVE', 'FINISHED'],
  FINISHED: [],
};

export function canTransitionSession(from: SessionState, to: SessionState): boolean {
  return SESSION_TRANSITIONS[from].includes(to);
}

/** States in which students may join (subject to allowLateJoin for ACTIVE/PAUSED). */
export function isJoinableState(state: SessionState, allowLateJoin: boolean): boolean {
  if (state === 'LOBBY') return true;
  if (state === 'READY') return allowLateJoin;
  if (state === 'ACTIVE' || state === 'PAUSED') return allowLateJoin;
  return false;
}

/**
 * Question phase machine (SYNCHRONIZED progress):
 *
 *   PENDING ─▶ PREPARE ─▶ ACTIVE ─▶ LOCKED ─▶ RESULT
 *      └────────────────▶ ACTIVE (countdown 0)
 *
 * A question can be restarted only from PENDING. LOCKED/RESULT are final for submission purposes.
 */
export const QUESTION_TRANSITIONS: Record<QuestionPhase, readonly QuestionPhase[]> = {
  PENDING: ['PREPARE', 'ACTIVE'],
  PREPARE: ['ACTIVE', 'PENDING'],
  ACTIVE: ['LOCKED'],
  LOCKED: ['RESULT'],
  RESULT: [],
};

export function canTransitionQuestion(from: QuestionPhase, to: QuestionPhase): boolean {
  return QUESTION_TRANSITIONS[from].includes(to);
}
