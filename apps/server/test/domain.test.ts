import { describe, expect, it } from 'vitest';
import { areLatexEquivalent, normalizeLatex } from '../src/domain/latex.js';
import { grade, parseNumeric, type QuestionSnapshot } from '../src/domain/grading.js';
import { applyTimeSync, evaluateTimestamp, type ClockSyncState, type TimestampInput } from '../src/domain/timeTrust.js';
import { Leaderboard, projectBoard, projectChanges, projectSelf, type RankRow } from '../src/domain/ranking.js';
import { computeAutoScore } from '../src/domain/scoring.js';
import { activeDuration, assertInsideWindow } from '../src/domain/window.js';

/* ------------------------------------------------------------------ LaTeX normalization */
describe('LaTeX normalization', () => {
  it('produces a canonical text form', () => {
    expect(normalizeLatex('x = \\frac{1}{2}').canonical).toBe('x=1/2');
    expect(normalizeLatex('x=\\dfrac{-b \\pm \\sqrt{b^2-4ac}}{2a}').canonical).toBe('x=(-b±sqrt(b^2-4*a*c))/(2*a)');
    expect(normalizeLatex('\\left( x+1 \\right)^{2}').canonical).toBe('(x+1)^2');
    expect(normalizeLatex('2\\cdot 3').canonical).toBe('2*3');
    expect(normalizeLatex('x^23').canonical).toBe('x^2*3');
  });

  it('treats notation variants as identical', () => {
    expect(areLatexEquivalent('\\frac{1}{2}', '\\dfrac{1}{2}')).toBe(true);
    expect(areLatexEquivalent('\\frac12', '\\frac{1}{2}')).toBe(true);
    expect(areLatexEquivalent('x \\times y', 'x\\cdot y')).toBe(true);
    expect(areLatexEquivalent('2\\sqrt{3}', '2 \\sqrt 3')).toBe(true);
  });

  it('numeric equivalence is policy driven: 1/2 = 0.5 = \\frac{1}{2}', () => {
    expect(areLatexEquivalent('0.5', '\\frac{1}{2}')).toBe(false);
    expect(areLatexEquivalent('0.5', '\\frac{1}{2}', { numericEquivalence: true })).toBe(true);
    expect(areLatexEquivalent('1/2', '\\frac{1}{2}', { numericEquivalence: true })).toBe(true);
    expect(areLatexEquivalent('\\frac{2}{4}', '\\frac{1}{2}', { numericEquivalence: true })).toBe(true);
    expect(areLatexEquivalent('\\sqrt{12}', '2\\sqrt{3}', { numericEquivalence: true })).toBe(true);
  });

  it('commutativity and variable assignment are opt-in', () => {
    expect(areLatexEquivalent('1+x', 'x+1')).toBe(false);
    expect(areLatexEquivalent('1+x', 'x+1', { commutative: true })).toBe(true);
    expect(areLatexEquivalent('ba', 'ab', { commutative: true })).toBe(true);
    expect(areLatexEquivalent('x=3', '3')).toBe(false);
    expect(areLatexEquivalent('x=3', '3', { ignoreVariableAssignment: true })).toBe(true);
    expect(areLatexEquivalent('x-1', '1-x', { commutative: true })).toBe(false);
  });

  it('never throws on garbage; falls back to string compare', () => {
    expect(() => normalizeLatex('\\frac{')).not.toThrow();
    expect(normalizeLatex('a ) b').canonical).toBe('a)b');
  });
});

/* ------------------------------------------------------------------ grading */
const snap = (over: Partial<QuestionSnapshot>): QuestionSnapshot => ({
  questionId: 'q',
  type: 'SHORT_ANSWER',
  title: null,
  description: null,
  choices: null,
  correctAnswer: undefined,
  acceptedAnswers: [],
  grading: { method: 'TEXT_NORMALIZED' },
  explanation: null,
  attachments: [],
  deliveryMode: 'DIGITAL',
  ...over,
});

describe('grading engine', () => {
  it('NUMERIC with tolerance', () => {
    const q = snap({ type: 'NUMERIC', correctAnswer: 3.14, grading: { method: 'NUMERIC', tolerance: 0.01 } });
    expect(grade(q, { kind: 'numeric', raw: '3.145' }).isCorrect).toBe(true);
    expect(grade(q, { kind: 'numeric', raw: '3.2' }).isCorrect).toBe(false);
    expect(grade(q, { kind: 'latex', raw: '\\frac{157}{50}' }).isCorrect).toBe(true);
    expect(parseNumeric('1/2')).toBe(0.5);
    expect(parseNumeric('1,000')).toBe(1000);
  });

  it('TEXT_NORMALIZED ignores case, spacing and trailing period', () => {
    const q = snap({ correctAnswer: 'Seoul', acceptedAnswers: ['서울'] });
    expect(grade(q, { kind: 'text', raw: '  seoul. ' }).isCorrect).toBe(true);
    expect(grade(q, { kind: 'text', raw: '서울' }).isCorrect).toBe(true);
    expect(grade(q, { kind: 'text', raw: 'Busan' }).isCorrect).toBe(false);
  });

  it('EXACT is strict', () => {
    const q = snap({ correctAnswer: 'NaCl', grading: { method: 'EXACT' } });
    expect(grade(q, { kind: 'text', raw: 'NaCl' }).isCorrect).toBe(true);
    expect(grade(q, { kind: 'text', raw: 'nacl' }).isCorrect).toBe(false);
  });

  it('MULTIPLE_CHOICE single and multi select', () => {
    const choices = ['a', 'b', 'c'].map((id) => ({ id, content: [] }));
    const single = snap({ type: 'MULTIPLE_CHOICE', choices, correctAnswer: 'b', grading: { method: 'MULTIPLE_CHOICE' } });
    expect(grade(single, { kind: 'choice', choiceIds: ['b'] }).isCorrect).toBe(true);
    expect(() => grade(single, { kind: 'choice', choiceIds: ['a', 'b'] })).toThrow(/exactly one/);
    expect(() => grade(single, { kind: 'choice', choiceIds: ['z'] })).toThrow(/unknown choice/);
    const multi = snap({ type: 'MULTIPLE_CHOICE', choices, correctAnswer: ['a', 'c'], grading: { method: 'MULTIPLE_CHOICE', multipleSelect: true } });
    expect(grade(multi, { kind: 'choice', choiceIds: ['c', 'a'] }).isCorrect).toBe(true);
    expect(grade(multi, { kind: 'choice', choiceIds: ['a'] }).isCorrect).toBe(false);
  });

  it('TRUE_FALSE', () => {
    const q = snap({ type: 'TRUE_FALSE', correctAnswer: true, grading: { method: 'EXACT' } });
    expect(grade(q, { kind: 'boolean', value: true }).isCorrect).toBe(true);
    expect(grade(q, { kind: 'boolean', value: false }).isCorrect).toBe(false);
  });

  it('LATEX keeps raw and stores normalized', () => {
    const q = snap({ type: 'LATEX', correctAnswer: 'x=\\frac{1}{2}', grading: { method: 'LATEX' } });
    const r = grade(q, { kind: 'latex', raw: 'x = \\dfrac{1}{2}' });
    expect(r.isCorrect).toBe(true);
    expect(r.normalized).toBe('x=1/2');
  });

  it('MANUAL / ESSAY and questions without answer key need a teacher', () => {
    expect(grade(snap({ type: 'ESSAY', grading: { method: 'MANUAL' } }), { kind: 'text', raw: 'proof' }).needsManual).toBe(true);
    expect(grade(snap({ type: 'SHORT_ANSWER' }), { kind: 'text', raw: 'x' }).needsManual).toBe(true);
  });

  it('rejects wrong answer kinds and empty answers', () => {
    expect(() => grade(snap({ type: 'TRUE_FALSE', correctAnswer: true }), { kind: 'text', raw: 'yes' })).toThrow();
    expect(() => grade(snap({ correctAnswer: 'a' }), { kind: 'text', raw: '   ' })).toThrow(/empty/);
  });
});

/* ------------------------------------------------------------------ scoring */
describe('scoring policies', () => {
  const base = { ratio: 1, isCorrect: true, maxScore: 1000, responseMs: 0, timeLimitSec: 20, speed: { minRatio: 0.5, windowSec: 30 } };
  it('POINT_BASED / CORRECT_COUNT', () => {
    expect(computeAutoScore({ ...base, mode: 'POINT_BASED' })).toBe(1000);
    expect(computeAutoScore({ ...base, mode: 'CORRECT_COUNT' })).toBe(1);
    expect(computeAutoScore({ ...base, mode: 'POINT_BASED', ratio: null })).toBeNull();
  });
  it('ACCURACY_SPEED decays linearly with server-computed response time', () => {
    expect(computeAutoScore({ ...base, mode: 'ACCURACY_SPEED', responseMs: 0 })).toBe(1000);
    expect(computeAutoScore({ ...base, mode: 'ACCURACY_SPEED', responseMs: 10_000 })).toBe(750);
    expect(computeAutoScore({ ...base, mode: 'ACCURACY_SPEED', responseMs: 20_000 })).toBe(500);
    expect(computeAutoScore({ ...base, mode: 'ACCURACY_SPEED', responseMs: 99_000 })).toBe(500);
    expect(computeAutoScore({ ...base, mode: 'ACCURACY_SPEED', isCorrect: false, ratio: 0 })).toBe(0);
  });
});

/* ------------------------------------------------------------------ timestamp trust */
function syncedState(offset: number, at: number): ClockSyncState {
  return { epochId: 'e', offset, rtt: 20, syncedAt: at, sampleCount: 3, stable: true, lastJumpAt: null, pending: null };
}

describe('timestamp trust algorithm', () => {
  const now = 1_000_000;
  const offset = 5_000_000; // server = mono + offset
  const input = (msAgo: number, over: Partial<TimestampInput> = {}): TimestampInput => {
    const mono = now - offset - msAgo;
    return {
      serverReceivedAt: now,
      clientMonoAt: mono,
      clientSentAt: mono + offset,
      sync: syncedState(offset, now - 5000),
      windowStartAt: now - 60_000,
      lastClientTimestamp: null,
      replay: false,
      disconnectedAt: null,
      reconnectedAt: null,
      ...over,
    };
  };

  it('500ms difference → CLIENT_TRUSTED', () => {
    const d = evaluateTimestamp(input(500));
    expect(d.source).toBe('CLIENT_TRUSTED');
    expect(d.effectiveSubmittedAt).toBe(now - 500);
  });
  it('999ms difference → CLIENT_TRUSTED', () => {
    const d = evaluateTimestamp(input(999));
    expect(d.source).toBe('CLIENT_TRUSTED');
    expect(d.effectiveSubmittedAt).toBe(now - 999);
  });
  it('1000ms or more → SERVER_FALLBACK', () => {
    expect(evaluateTimestamp(input(1000))).toMatchObject({ source: 'SERVER_FALLBACK', reason: 'OUTSIDE_TRUST_WINDOW', effectiveSubmittedAt: now });
    expect(evaluateTimestamp(input(5000)).source).toBe('SERVER_FALLBACK');
  });
  it('no verified sync → fallback', () => {
    expect(evaluateTimestamp(input(100, { sync: undefined })).reason).toBe('NO_TIME_SYNC');
  });
  it('client clock manipulation: reported wall time disagrees with monotonic estimate', () => {
    expect(evaluateTimestamp(input(100, { clientSentAt: now - 60_000 })).reason).toBe('CLIENT_ESTIMATE_MISMATCH');
  });
  it('before question start / in the future / regression are rejected', () => {
    expect(evaluateTimestamp(input(500, { windowStartAt: now - 100 })).reason).toBe('BEFORE_WINDOW_START');
    expect(evaluateTimestamp(input(-5000)).reason).toBe('CLIENT_TIME_IN_FUTURE');
    expect(evaluateTimestamp(input(500, { lastClientTimestamp: now - 100 })).reason).toBe('TIMESTAMP_REGRESSION');
  });
  it('unstable offset / stale sync / high RTT → fallback', () => {
    expect(evaluateTimestamp(input(100, { sync: { ...syncedState(offset, now), stable: false } })).reason).toBe('OFFSET_UNSTABLE');
    expect(evaluateTimestamp(input(100, { sync: syncedState(offset, now - 10 * 60_000) })).reason).toBe('SYNC_STALE');
    expect(evaluateTimestamp(input(100, { sync: { ...syncedState(offset, now), rtt: 5000 } })).reason).toBe('RTT_TOO_HIGH');
  });
  it('offline replay keeps client time only when it precedes the observed disconnect', () => {
    const ok = evaluateTimestamp(input(20_000, { replay: true, disconnectedAt: now - 19_000, reconnectedAt: now - 500 }));
    expect(ok).toMatchObject({ source: 'CLIENT_TRUSTED', reason: 'OFFLINE_REPLAY_VERIFIED', effectiveSubmittedAt: now - 20_000 });
    expect(evaluateTimestamp(input(20_000, { replay: true, disconnectedAt: now - 25_000, reconnectedAt: now - 500 })).reason).toBe('REPLAY_AFTER_DISCONNECT');
    expect(
      evaluateTimestamp(input(200_000, { replay: true, disconnectedAt: now - 190_000, reconnectedAt: now - 500, sync: syncedState(offset, now - 195_000), windowStartAt: now - 300_000 })).reason,
    ).toBe('REPLAY_WINDOW_EXCEEDED');
    expect(evaluateTimestamp(input(20_000, { replay: true, disconnectedAt: now - 19_000, reconnectedAt: now - 60_000 })).reason).toBe('REPLAY_NOT_PROMPT');
    expect(evaluateTimestamp(input(20_000, { replay: false, disconnectedAt: now - 19_000, reconnectedAt: now - 500 })).reason).toBe('OUTSIDE_TRUST_WINDOW');
  });
});

describe('TIME_SYNC verification', () => {
  it('derives the offset itself and rejects inconsistent reports', () => {
    const offset = 777_000;
    let st = applyTimeSync(undefined, { seq: 1, clockEpochId: 'e', clientMono: 1000 }, 1000 + offset + 40).state;
    // honest client: rtt 80 → offset = t1 - t0 - 40
    let r = applyTimeSync(st, { seq: 2, clockEpochId: 'e', clientMono: 1200, lastSample: { seq: 1, offset, rtt: 80 } }, 1200 + offset + 40);
    expect(r.outcome).toBe('ACCEPTED');
    expect(r.state.offset).toBe(offset);
    st = r.state;
    // lying client: reports an offset that does not follow from its rtt
    r = applyTimeSync(st, { seq: 3, clockEpochId: 'e', clientMono: 1400, lastSample: { seq: 2, offset: offset + 900, rtt: 80 } }, 1400 + offset + 40);
    expect(r.outcome).toBe('INCONSISTENT');
    expect(r.state.offset).toBe(offset);
  });

  it('flags sudden offset jumps and re-establishes after confirmation', () => {
    const o = 100_000;
    let st = applyTimeSync(undefined, { seq: 1, clockEpochId: 'e', clientMono: 0 }, o).state;
    st = applyTimeSync(st, { seq: 2, clockEpochId: 'e', clientMono: 100, lastSample: { seq: 1, offset: o, rtt: 0 } }, 100 + o + 5000).state;
    expect(st.stable).toBe(true);
    // the previous exchange (seq 2) implies a 5s jump
    const jumped = applyTimeSync(st, { seq: 3, clockEpochId: 'e', clientMono: 200, lastSample: { seq: 2, offset: o + 5000, rtt: 0 } }, 200 + o + 5000);
    expect(jumped.outcome).toBe('OFFSET_JUMP');
    expect(jumped.state.stable).toBe(false);
    const confirmed = applyTimeSync(jumped.state, { seq: 4, clockEpochId: 'e', clientMono: 300, lastSample: { seq: 3, offset: o + 5000, rtt: 0 } }, 300 + o + 5000);
    expect(confirmed.outcome).toBe('CONFIRMED');
    expect(confirmed.state.stable).toBe(true);
  });
});

/* ------------------------------------------------------------------ submission window */
describe('submission window', () => {
  const w = { startedAt: 1000, deadlineAt: 11_000, lockedAt: null, pauses: [{ pausedAt: 5000, resumedAt: 7000 }] };
  it('accepts inside, rejects before/after/during pause', () => {
    expect(() => assertInsideWindow({ window: w, effectiveAt: 2000, receivedAt: 2000, trusted: false, verifiedReplay: false, lateGraceMs: 1000 })).not.toThrow();
    expect(() => assertInsideWindow({ window: w, effectiveAt: 500, receivedAt: 500, trusted: false, verifiedReplay: false, lateGraceMs: 1000 })).toThrow(/not started/);
    expect(() => assertInsideWindow({ window: w, effectiveAt: 11_000, receivedAt: 11_000, trusted: false, verifiedReplay: false, lateGraceMs: 1000 })).toThrow(/deadline/);
    expect(() => assertInsideWindow({ window: w, effectiveAt: 6000, receivedAt: 6000, trusted: false, verifiedReplay: false, lateGraceMs: 1000 })).toThrow(/paused/);
  });
  it('in-flight grace only for trusted timestamps', () => {
    const args = { window: w, effectiveAt: 10_900, receivedAt: 11_400, verifiedReplay: false, lateGraceMs: 1000 };
    expect(() => assertInsideWindow({ ...args, trusted: true })).not.toThrow();
    expect(() => assertInsideWindow({ ...args, trusted: true, receivedAt: 12_500 })).toThrow(/too late/);
    expect(() => assertInsideWindow({ ...args, trusted: false, effectiveAt: 11_400 })).toThrow();
  });
  it('response time excludes pauses', () => {
    expect(activeDuration(1000, 9000, w.pauses)).toBe(6000);
  });
});

/* ------------------------------------------------------------------ ranking */
const row = (id: string, score: number, over: Partial<RankRow> = {}): RankRow => ({
  participantId: id,
  nickname: id,
  totalScore: score,
  correctCount: 0,
  answeredCount: 0,
  lastScoredAt: null,
  lastCorrectAt: null,
  avgResponseMs: null,
  ...over,
});

describe('ranking engine', () => {
  it('sorts by score, then tie breakers', () => {
    const lb = new Leaderboard({ allowTies: false, tieBreakers: ['CORRECT_COUNT_DESC', 'LAST_SCORED_AT_ASC'] });
    lb.rebuild([
      row('a', 10, { correctCount: 1, lastScoredAt: 500 }),
      row('b', 10, { correctCount: 2, lastScoredAt: 900 }),
      row('c', 10, { correctCount: 2, lastScoredAt: 800 }),
      row('d', 20),
    ]);
    expect(lb.entries().map((e) => [e.participantId, e.rank])).toEqual([
      ['d', 1],
      ['c', 2],
      ['b', 3],
      ['a', 4],
    ]);
  });

  it('ties share a rank (competition ranking) when tie breakers are exhausted or disabled', () => {
    const lb = new Leaderboard({ allowTies: true, tieBreakers: [] });
    lb.rebuild([row('a', 10), row('b', 10), row('c', 5)]);
    expect(lb.entries().map((e) => e.rank)).toEqual([1, 1, 3]);
    const lb2 = new Leaderboard({ allowTies: false, tieBreakers: ['CORRECT_COUNT_DESC'] });
    lb2.rebuild([row('a', 10, { correctCount: 1 }), row('b', 10, { correctCount: 1 }), row('c', 10, { correctCount: 0 })]);
    expect(lb2.entries().map((e) => e.rank)).toEqual([1, 1, 3]);
  });

  it('incremental upsert reports only affected rows with previous ranks', () => {
    const lb = new Leaderboard({ allowTies: false, tieBreakers: [] });
    lb.rebuild([row('a', 30), row('b', 20), row('c', 10), row('d', 5)]);
    const changes = lb.upsert(row('c', 25));
    expect(changes.map((c) => [c.participantId, c.prevRank, c.rank])).toEqual([
      ['c', 3, 2],
      ['b', 2, 3],
    ]);
    expect(lb.entries().map((e) => e.participantId)).toEqual(['a', 'c', 'b', 'd']);
    const added = lb.upsert(row('e', 100));
    expect(added.find((c) => c.participantId === 'e')).toMatchObject({ rank: 1, prevRank: null });
    expect(added).toHaveLength(5);
  });

  it('visibility projections', () => {
    const lb = new Leaderboard({ allowTies: false, tieBreakers: [] });
    lb.rebuild(Array.from({ length: 12 }, (_, i) => row(`p${i}`, 100 - i)));
    const all = lb.entries();
    expect(projectBoard('FULL', true, all)).toHaveLength(12);
    expect(projectBoard('TOP_10', true, all)).toHaveLength(10);
    expect(projectBoard('TOP_3', true, all)).toHaveLength(3);
    expect(projectBoard('TOP_3', false, all)).toHaveLength(0);
    expect(projectBoard('PRIVATE', true, all)).toHaveLength(0);
    expect(projectBoard('SCORES_ONLY', true, all).every((e) => e.nickname === '' && e.rank === null)).toBe(true);
    expect(projectBoard('HIDE_RANK', true, all).every((e) => e.rank === null)).toBe(true);
    expect(projectSelf('PRIVATE', true, false, { totalScore: 1, correctCount: 0, answeredCount: 0, rank: 1 }).showScore).toBe(false);
    expect(projectSelf('HIDE_RANK', true, false, { totalScore: 1, correctCount: 0, answeredCount: 0, rank: 1 })).toEqual({ showScore: true, showRank: false });
    const changes = lb.upsert(row('p11', 1000));
    const proj = projectChanges('TOP_3', true, changes)!;
    expect(proj.changes.map((c) => c.participantId)).toEqual(['p11', 'p0', 'p1']);
    expect(proj.removed).toEqual(['p2']);
  });
});
