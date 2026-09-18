import {
  AppError,
  EXPECTED_ANSWER_KIND,
  type AnswerPayload,
  type Choice,
  type ContentBlock,
  type CorrectAnswer,
  type GradingConfig,
  type QuestionType,
} from '@brainbattle/shared';
import { areLatexEquivalent, evaluate, normalizeLatex, parseLatex } from './latex.js';

/** Immutable copy of a question frozen into a session (edits to the bank don't affect live sessions). */
export interface QuestionSnapshot {
  questionId: string;
  type: QuestionType;
  title: string | null;
  description: ContentBlock[] | null;
  choices: Choice[] | null;
  correctAnswer: CorrectAnswer | undefined;
  acceptedAnswers: CorrectAnswer[];
  grading: GradingConfig;
  explanation: ContentBlock[] | null;
  attachments: { id: string; name: string; url: string; mimeType?: string }[];
  deliveryMode: 'DIGITAL' | 'PAPER';
}

export interface GradeResult {
  /** server-computed canonical form of the answer */
  normalized: string | null;
  /** null when manual grading is required */
  isCorrect: boolean | null;
  /** fraction of the max score earned by auto grading (0..1), null for manual */
  ratio: number | null;
  needsManual: boolean;
}

export function normalizeText(s: string, caseSensitive = false): string {
  let t = s.normalize('NFKC').trim().replace(/\s+/g, ' ');
  t = t.replace(/[.。]+$/, '');
  return caseSensitive ? t : t.toLowerCase();
}

/**
 * Parses a numeric answer. Accepts plain numbers ("3.14", "-2", "1e-3"), fractions ("1/2"),
 * and math-editor LaTeX ("\frac{1}{2}", "2\sqrt{2}", "\pi").
 */
export function parseNumeric(raw: string): number | null {
  const s = raw.trim().replace(/,(?=\d{3}\b)/g, '').replace(/\s+/g, '');
  if (s === '') return null;
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return Number(s);
  try {
    return evaluate(parseLatex(s));
  } catch {
    return null;
  }
}

function asList(ca: CorrectAnswer | undefined): CorrectAnswer[] {
  return ca === undefined ? [] : [ca];
}

/** Checks the answer shape against the question before anything is persisted. */
export function validateAnswer(q: QuestionSnapshot, a: AnswerPayload): void {
  if (!EXPECTED_ANSWER_KIND[q.type].includes(a.kind)) {
    throw new AppError('INVALID_ANSWER', `answer kind ${a.kind} is not valid for ${q.type}`);
  }
  if (a.kind === 'choice') {
    const ids = new Set((q.choices ?? []).map((c) => c.id));
    for (const id of a.choiceIds) if (!ids.has(id)) throw new AppError('INVALID_ANSWER', `unknown choice ${id}`);
    if (!q.grading.multipleSelect && a.choiceIds.length !== 1) {
      throw new AppError('INVALID_ANSWER', 'exactly one choice must be selected');
    }
    if (new Set(a.choiceIds).size !== a.choiceIds.length) throw new AppError('INVALID_ANSWER', 'duplicate choice');
  }
  if ((a.kind === 'text' || a.kind === 'numeric' || a.kind === 'latex') && a.raw.trim() === '') {
    throw new AppError('INVALID_ANSWER', 'empty answer');
  }
}

export function normalizeAnswer(q: QuestionSnapshot, a: AnswerPayload): string | null {
  switch (a.kind) {
    case 'choice':
      return [...a.choiceIds].sort().join(',');
    case 'boolean':
      return a.value ? 'true' : 'false';
    case 'numeric': {
      const v = parseNumeric(a.raw);
      return v === null ? normalizeText(a.raw) : String(v);
    }
    case 'latex':
      return normalizeLatex(a.raw).canonical;
    case 'text':
      if (q.type === 'LATEX') return normalizeLatex(a.raw).canonical;
      if (q.type === 'NUMERIC') {
        const v = parseNumeric(a.raw);
        return v === null ? normalizeText(a.raw) : String(v);
      }
      return normalizeText(a.raw, q.grading.caseSensitive);
  }
}

function answerText(a: AnswerPayload): string {
  switch (a.kind) {
    case 'choice': return a.choiceIds.join(',');
    case 'boolean': return String(a.value);
    default: return a.raw;
  }
}

export function grade(q: QuestionSnapshot, a: AnswerPayload): GradeResult {
  validateAnswer(q, a);
  const normalized = normalizeAnswer(q, a);
  const g = q.grading;
  const expected = [...asList(q.correctAnswer), ...q.acceptedAnswers].filter((x) => x !== null && x !== undefined);

  // no answer key (e.g. a paper question whose key is entered later) ⇒ teacher grades it
  if (g.method === 'MANUAL' || expected.length === 0) {
    return { normalized, isCorrect: null, ratio: null, needsManual: true };
  }

  let correct = false;
  switch (g.method) {
    case 'MULTIPLE_CHOICE': {
      if (a.kind !== 'choice') break;
      const given = [...a.choiceIds].sort().join(',');
      // correctAnswer may be a single id or a list (multi-select); acceptedAnswers are alternative sets
      correct = expected.some((e) => {
        const set = Array.isArray(e) ? e : [String(e)];
        return [...set].sort().join(',') === given;
      });
      break;
    }
    case 'EXACT': {
      if (a.kind === 'boolean') {
        correct = expected.some((e) => e === a.value || String(e).toLowerCase() === String(a.value));
      } else {
        const given = answerText(a).trim();
        correct = expected.some((e) =>
          g.caseSensitive === false ? String(e).trim().toLowerCase() === given.toLowerCase() : String(e).trim() === given,
        );
      }
      break;
    }
    case 'TEXT_NORMALIZED': {
      const given = normalizeText(answerText(a), g.caseSensitive);
      correct = expected.some((e) => normalizeText(String(e), g.caseSensitive) === given);
      break;
    }
    case 'NUMERIC': {
      const v = parseNumeric(answerText(a));
      if (v === null || !Number.isFinite(v)) break;
      correct = expected.some((e) => {
        const target = typeof e === 'number' ? e : parseNumeric(String(e));
        if (target === null) return false;
        const tol = Math.max(g.tolerance ?? 0, (g.relativeTolerance ?? 0) * Math.abs(target), 1e-9);
        return Math.abs(v - target) <= tol;
      });
      break;
    }
    case 'LATEX': {
      const given = answerText(a);
      correct = expected.some((e) =>
        areLatexEquivalent(given, String(e), {
          numericEquivalence: g.latexNumericEquivalence ?? false,
          commutative: g.latexCommutative ?? false,
          ignoreVariableAssignment: g.latexIgnoreVariableAssignment ?? false,
          ...(g.tolerance !== undefined ? { tolerance: g.tolerance } : {}),
        }),
      );
      break;
    }
  }
  return { normalized, isCorrect: correct, ratio: correct ? 1 : 0, needsManual: false };
}
