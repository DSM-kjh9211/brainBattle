import { z } from 'zod';
import { QUESTION_TYPES } from './enums.js';
import { questionInputSchema, type QuestionInput } from './question.js';

/** AI authoring assistant (question generation / review / set generation). Teacher-only, REST. */
export const AI_DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD', 'MIXED'] as const;
export type AiDifficulty = (typeof AI_DIFFICULTIES)[number];

export const AI_MAX_QUESTIONS = 20;

export const aiGenerateRequestSchema = z.object({
  topic: z.string().trim().min(1).max(500),
  /** free text, e.g. "중학교 2학년", "신입 개발자" */
  audience: z.string().trim().max(100).optional(),
  difficulty: z.enum(AI_DIFFICULTIES).default('MEDIUM'),
  count: z.number().int().min(1).max(AI_MAX_QUESTIONS).default(5),
  /** allowed question types; empty = AI picks */
  types: z.array(z.enum(QUESTION_TYPES)).max(QUESTION_TYPES.length).default([]),
  instructions: z.string().trim().max(2_000).optional(),
  /** reference material the questions must be based on (pasted by the teacher) */
  sourceText: z.string().max(30_000).optional(),
});
export type AiGenerateRequest = z.input<typeof aiGenerateRequestSchema>;

export const aiReviewQuestionRequestSchema = z.object({ question: questionInputSchema });

/** Drafts are never saved by the server: the teacher reviews them and saves through the normal question API. */
export interface AiGenerateResult {
  questions: QuestionInput[];
  /** drafts the model produced that failed validation and were discarded */
  dropped: number;
}

export interface AiSetDraft extends AiGenerateResult {
  title: string;
  description: string | null;
}

export const AI_ISSUE_SEVERITIES = ['ERROR', 'WARNING', 'INFO'] as const;
export type AiIssueSeverity = (typeof AI_ISSUE_SEVERITIES)[number];

export const AI_ISSUE_FIELDS = ['TITLE', 'BODY', 'CHOICES', 'ANSWER', 'GRADING', 'EXPLANATION', 'OTHER'] as const;
export type AiIssueField = (typeof AI_ISSUE_FIELDS)[number];

export interface AiReviewIssue {
  severity: AiIssueSeverity;
  field: AiIssueField;
  message: string;
  suggestion: string | null;
}

export interface AiQuestionReview {
  verdict: 'OK' | 'NEEDS_FIX';
  summary: string;
  issues: AiReviewIssue[];
  /** corrected version of the question (null when nothing needs to change) */
  revised: QuestionInput | null;
}

export interface AiSetReviewIssue {
  /** id of the set item the issue is about; null = the set as a whole */
  itemId: string | null;
  displayNumber: string | null;
  severity: AiIssueSeverity;
  message: string;
  suggestion: string | null;
}

export interface AiSetReview {
  summary: string;
  issues: AiSetReviewIssue[];
}

export interface AiStatus {
  enabled: boolean;
}
