import { z } from 'zod';
import { DELIVERY_MODES, GRADING_METHODS, QUESTION_TYPES } from './enums.js';
import type { DeliveryMode, GradingMethod, QuestionType } from './enums.js';

/**
 * Rich content blocks. The union is intentionally open-ended: new block types (audio/video/graph)
 * can be added without schema migrations because content is stored as JSONB.
 */
export const contentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(20_000) }),
  z.object({ type: z.literal('math'), latex: z.string().max(5_000), display: z.boolean().optional() }),
  z.object({ type: z.literal('image'), url: z.string().max(2_000), alt: z.string().max(500).optional() }),
  z.object({ type: z.literal('code'), code: z.string().max(20_000), language: z.string().max(40).optional() }),
  z.object({ type: z.literal('audio'), url: z.string().max(2_000) }),
  z.object({ type: z.literal('video'), url: z.string().max(2_000) }),
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

export const choiceSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().max(20).optional(),
  content: z.array(contentBlockSchema).max(20).default([]),
});
export type Choice = z.infer<typeof choiceSchema>;

export const attachmentSchema = z.object({
  id: z.string().max(60),
  name: z.string().max(300),
  url: z.string().max(2_000),
  mimeType: z.string().max(120).optional(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

/** Grading configuration. correctAnswer/acceptedAnswers are interpreted according to method. */
export const gradingConfigSchema = z.object({
  method: z.enum(GRADING_METHODS),
  /** NUMERIC: absolute tolerance. */
  tolerance: z.number().nonnegative().optional(),
  /** NUMERIC: relative tolerance (fraction, e.g. 0.01 = 1%). */
  relativeTolerance: z.number().nonnegative().optional(),
  /** TEXT_NORMALIZED / EXACT */
  caseSensitive: z.boolean().optional(),
  /** LATEX: purely numeric expressions compare by value (1/2 == 0.5 == \frac{1}{2}). */
  latexNumericEquivalence: z.boolean().optional(),
  /** LATEX: operands of + and * are order-insensitive (x+1 == 1+x). */
  latexCommutative: z.boolean().optional(),
  /** LATEX: "x=1/2" is accepted when the expected answer is "1/2" (and vice versa). */
  latexIgnoreVariableAssignment: z.boolean().optional(),
  /** MULTIPLE_CHOICE: more than one choice may be selected; all must match. */
  multipleSelect: z.boolean().optional(),
});
export type GradingConfig = z.infer<typeof gradingConfigSchema>;

/** Answer payloads submitted by students. `raw` is always preserved verbatim. */
export const answerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('choice'), choiceIds: z.array(z.string().max(40)).min(1).max(20) }),
  z.object({ kind: z.literal('boolean'), value: z.boolean() }),
  z.object({ kind: z.literal('text'), raw: z.string().max(10_000) }),
  z.object({ kind: z.literal('numeric'), raw: z.string().max(200) }),
  z.object({ kind: z.literal('latex'), raw: z.string().max(5_000) }),
]);
export type AnswerPayload = z.infer<typeof answerSchema>;

/** Answer as stored: payload plus server-computed normalized form. */
export interface StoredAnswer {
  payload: AnswerPayload;
  /** server-computed canonical form, used for grading and display (never trusted from the client) */
  normalized: string | null;
}

export const EXPECTED_ANSWER_KIND: Record<QuestionType, AnswerPayload['kind'][]> = {
  MULTIPLE_CHOICE: ['choice'],
  TRUE_FALSE: ['boolean'],
  SHORT_ANSWER: ['text'],
  NUMERIC: ['numeric', 'text', 'latex'],
  LATEX: ['latex', 'text'],
  ESSAY: ['text', 'latex'],
};

export const DEFAULT_GRADING_METHOD: Record<QuestionType, GradingMethod> = {
  MULTIPLE_CHOICE: 'MULTIPLE_CHOICE',
  TRUE_FALSE: 'EXACT',
  SHORT_ANSWER: 'TEXT_NORMALIZED',
  NUMERIC: 'NUMERIC',
  LATEX: 'LATEX',
  ESSAY: 'MANUAL',
};

/** correctAnswer is stored as JSON; its shape depends on type. */
export const correctAnswerSchema = z.union([
  z.string().max(5_000),
  z.number(),
  z.boolean(),
  z.array(z.string().max(40)).max(20),
  z.null(),
]);
export type CorrectAnswer = z.infer<typeof correctAnswerSchema>;

const questionInputBase = z.object({
  displayNumber: z.string().max(40).optional().nullable(),
  type: z.enum(QUESTION_TYPES),
  title: z.string().max(500).optional().nullable(),
  description: z.array(contentBlockSchema).max(50).optional().nullable(),
  choices: z.array(choiceSchema).max(20).optional().nullable(),
  correctAnswer: correctAnswerSchema.optional(),
  acceptedAnswers: z.array(correctAnswerSchema).max(50).optional(),
  grading: gradingConfigSchema.optional(),
  score: z.number().min(0).max(100_000).default(10),
  timeLimitSec: z.number().int().min(0).max(24 * 3600).optional().nullable(),
  explanation: z.array(contentBlockSchema).max(50).optional().nullable(),
  attachments: z.array(attachmentSchema).max(20).optional(),
  deliveryMode: z.enum(DELIVERY_MODES).default('DIGITAL'),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

export function validateQuestionShape(
  q: Partial<z.infer<typeof questionInputBase>>,
  ctx: z.RefinementCtx,
): void {
  if (q.type === 'MULTIPLE_CHOICE') {
    if (!q.choices || q.choices.length < 2) {
      ctx.addIssue({ code: 'custom', path: ['choices'], message: 'MULTIPLE_CHOICE needs at least 2 choices' });
    }
    const ids = new Set((q.choices ?? []).map((c) => c.id));
    if (ids.size !== (q.choices ?? []).length) {
      ctx.addIssue({ code: 'custom', path: ['choices'], message: 'choice ids must be unique' });
    }
    const ca = q.correctAnswer;
    const list = Array.isArray(ca) ? ca : typeof ca === 'string' ? [ca] : [];
    for (const id of list) {
      if (!ids.has(id)) ctx.addIssue({ code: 'custom', path: ['correctAnswer'], message: `unknown choice ${id}` });
    }
  }
  if (q.type === 'TRUE_FALSE' && q.correctAnswer != null && typeof q.correctAnswer !== 'boolean') {
    ctx.addIssue({ code: 'custom', path: ['correctAnswer'], message: 'TRUE_FALSE answer must be boolean' });
  }
}

export const questionInputSchema = questionInputBase.superRefine(validateQuestionShape);
export type QuestionInput = z.input<typeof questionInputSchema>;

/** Full question as seen by its owner (teacher). */
export interface QuestionDTO {
  id: string;
  ownerId: string;
  displayNumber: string | null;
  type: QuestionType;
  title: string | null;
  description: ContentBlock[] | null;
  choices: Choice[] | null;
  correctAnswer: CorrectAnswer | undefined;
  acceptedAnswers: CorrectAnswer[];
  grading: GradingConfig;
  score: number;
  timeLimitSec: number | null;
  explanation: ContentBlock[] | null;
  attachments: Attachment[];
  deliveryMode: DeliveryMode;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Question as delivered to students. Never contains correctAnswer/acceptedAnswers/grading details.
 * In PAPER delivery mode title/description/choice contents are stripped as well.
 */
export interface StudentQuestionView {
  sessionQuestionId: string;
  position: number;
  displayNumber: string;
  type: QuestionType;
  deliveryMode: DeliveryMode;
  maxScore: number;
  timeLimitSec: number | null;
  title: string | null;
  description: ContentBlock[] | null;
  /** In PAPER mode only id + label are sent (e.g. circled digits). */
  choices: Choice[] | null;
  multipleSelect: boolean;
  attachments: Attachment[];
}

/** Revealed after the reveal policy allows it. */
export interface QuestionReveal {
  sessionQuestionId: string;
  correctAnswer: CorrectAnswer | undefined;
  acceptedAnswers: CorrectAnswer[];
  explanation: ContentBlock[] | null;
}
