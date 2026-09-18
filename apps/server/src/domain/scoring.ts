import type { ScoringMode, SessionSettings } from '@brainbattle/shared';
import { round2 } from '../lib/util.js';

/**
 * Scoring policies (per session):
 *
 *  POINT_BASED     score = ratio × maxScore                           (Paper Battle default)
 *  CORRECT_COUNT   score = 1 per correct answer; total = #correct
 *  ACCURACY_SPEED  score = maxScore × (minRatio + (1−minRatio)·(1 − t/T)) for correct answers,
 *                  t = effectiveSubmittedAt − questionStartedAt (pauses excluded), T = time limit
 *                  or speed window. The client never supplies t.        (Live Quiz default)
 *  CUSTOM          pluggable strategy registered at startup (falls back to POINT_BASED)
 */
export interface AutoScoreInput {
  mode: ScoringMode;
  ratio: number | null;
  isCorrect: boolean | null;
  maxScore: number;
  responseMs: number | null;
  timeLimitSec: number | null;
  speed: SessionSettings['speed'];
}

export type CustomScoringStrategy = (i: AutoScoreInput) => number;
const customStrategies = new Map<string, CustomScoringStrategy>();

export function registerCustomScoring(name: string, fn: CustomScoringStrategy): void {
  customStrategies.set(name, fn);
}

export function computeAutoScore(i: AutoScoreInput): number | null {
  if (i.ratio === null) return null; // manual grading pending
  switch (i.mode) {
    case 'POINT_BASED':
      return round2(i.ratio * i.maxScore);
    case 'CORRECT_COUNT':
      return i.isCorrect ? 1 : 0;
    case 'ACCURACY_SPEED': {
      if (!i.isCorrect) return round2(i.ratio * i.maxScore * i.speed.minRatio);
      const windowMs = (i.timeLimitSec && i.timeLimitSec > 0 ? i.timeLimitSec : i.speed.windowSec) * 1000;
      const t = Math.min(Math.max(i.responseMs ?? windowMs, 0), windowMs);
      const factor = i.speed.minRatio + (1 - i.speed.minRatio) * (1 - t / windowMs);
      return round2(i.maxScore * factor);
    }
    case 'CUSTOM': {
      const fn = customStrategies.get('default');
      return round2(fn ? fn(i) : i.ratio * i.maxScore);
    }
  }
}

/** Upper bound a teacher may assign manually for a question under a scoring mode. */
export function maxAssignableScore(mode: ScoringMode, maxScore: number): number {
  return mode === 'CORRECT_COUNT' ? 1 : maxScore;
}

/** A manual score counts as "correct" when it is full marks. */
export function isFullMarks(mode: ScoringMode, score: number, maxScore: number): boolean {
  return score >= maxAssignableScore(mode, maxScore) - 1e-9;
}
