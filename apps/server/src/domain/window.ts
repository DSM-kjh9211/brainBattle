import { AppError, type PauseInterval } from '@brainbattle/shared';

/**
 * A submission window: the question (SYNCHRONIZED) or the whole session (FREE progress).
 * Pauses are gaps in the window; deadlines are extended by pause durations when resumed.
 */
export interface SubmissionWindow {
  startedAt: number | null;
  deadlineAt: number | null;
  /** hard lock (teacher ended the question/session) */
  lockedAt: number | null;
  pauses: PauseInterval[];
}

export function isPausedAt(pauses: PauseInterval[], t: number): PauseInterval | null {
  for (const p of pauses) {
    if (t >= p.pausedAt && (p.resumedAt === null || t < p.resumedAt)) return p;
  }
  return null;
}

/** Milliseconds between from and to excluding paused intervals. */
export function activeDuration(from: number, to: number, pauses: PauseInterval[]): number {
  if (to <= from) return 0;
  let paused = 0;
  for (const p of pauses) {
    const s = Math.max(from, p.pausedAt);
    const e = Math.min(to, p.resumedAt ?? to);
    if (e > s) paused += e - s;
  }
  return Math.max(0, to - from - paused);
}

export function closeInstant(w: SubmissionWindow): number | null {
  const candidates = [w.deadlineAt, w.lockedAt].filter((x): x is number => x !== null);
  return candidates.length ? Math.min(...candidates) : null;
}

/**
 * Decides whether a submission is inside the window.
 *
 *  - the effective time must be inside [startedAt, close) and not inside a pause
 *  - if the window was already closed (or paused) when the message arrived, the submission is
 *    accepted only when its effective time is CLIENT_TRUSTED and it arrived within lateGraceMs of
 *    the closing instant (in-flight message) — or it is a verified offline replay.
 *  - the server deadline always wins over the client's countdown.
 */
export function assertInsideWindow(opts: {
  window: SubmissionWindow;
  effectiveAt: number;
  receivedAt: number;
  trusted: boolean;
  verifiedReplay: boolean;
  lateGraceMs: number;
  closedCode?: 'SUBMISSION_CLOSED' | 'SESSION_LOCKED';
}): void {
  const { window: w, effectiveAt, receivedAt } = opts;
  const closedCode = opts.closedCode ?? 'SUBMISSION_CLOSED';
  if (w.startedAt === null || effectiveAt < w.startedAt) {
    throw new AppError('QUESTION_NOT_ACTIVE', 'submission window has not started');
  }
  const close = closeInstant(w);
  if (close !== null && effectiveAt >= close) throw new AppError(closedCode, 'deadline passed');
  if (isPausedAt(w.pauses, effectiveAt)) throw new AppError('SUBMISSION_CLOSED', 'session was paused');

  // instant at which the window closed before receipt (deadline/lock or pause start)
  let closedSince: number | null = null;
  if (close !== null && receivedAt >= close) closedSince = close;
  const pauseAtReceipt = isPausedAt(w.pauses, receivedAt);
  if (pauseAtReceipt) closedSince = closedSince === null ? pauseAtReceipt.pausedAt : Math.min(closedSince, pauseAtReceipt.pausedAt);
  if (closedSince === null) return;

  if (!opts.trusted) throw new AppError(closedCode, 'submission arrived after the window closed');
  if (opts.verifiedReplay) return;
  if (receivedAt - closedSince > opts.lateGraceMs) {
    throw new AppError(closedCode, 'submission arrived too late');
  }
}
