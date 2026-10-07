import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  AI_ISSUE_FIELDS,
  AI_ISSUE_SEVERITIES,
  aiGenerateRequestSchema,
  AppError,
  QUESTION_TYPES,
  questionInputSchema,
  type AiGenerateResult,
  type AiQuestionReview,
  type AiSetDraft,
  type AiSetReview,
  type ContentBlock,
  type QuestionDTO,
  type QuestionInput,
  type QuestionSetDTO,
} from '@brainbattle/shared';

/** One structured completion: returns the parsed JSON object matching `schema`. */
export interface AiClient {
  complete(req: { system: string; prompt: string; schema: Record<string, unknown> }): Promise<unknown>;
}

/* ---------------------------------------------------------------------- Claude client */

export class AnthropicAiClient implements AiClient {
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly model: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(req: { system: string; prompt: string; schema: Record<string, unknown> }): Promise<unknown> {
    let message: Anthropic.Beta.BetaMessage;
    try {
      // Streamed: a full question set at high effort can outlast non-streaming HTTP timeouts.
      message = await this.client.beta.messages
        .stream({
          model: this.model,
          max_tokens: 32_000,
          // a safety-classifier decline is re-run server-side on Anthropic's recommended fallback model
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'high', format: { type: 'json_schema', schema: req.schema } },
          system: req.system,
          messages: [{ role: 'user', content: req.prompt }],
        })
        .finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
        throw new AppError('AI_UNAVAILABLE', 'AI provider rejected the configured API key');
      }
      if (e instanceof Anthropic.RateLimitError) throw new AppError('RATE_LIMITED', 'AI provider rate limit reached, try again shortly');
      if (e instanceof Anthropic.APIError) throw new AppError('AI_FAILED', `AI request failed (${e.status ?? 'network'})`);
      throw e;
    }
    if (message.stop_reason === 'refusal') throw new AppError('AI_FAILED', 'AI declined this request');
    if (message.stop_reason === 'max_tokens') throw new AppError('AI_FAILED', 'AI response was too long; request fewer questions');
    const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    try {
      return JSON.parse(text);
    } catch {
      throw new AppError('AI_FAILED', 'AI returned an unreadable response');
    }
  }
}

/* ---------------------------------------------------------------------- model-facing question shape */

/**
 * Flat question shape the model reads and writes. Structured outputs require every field, so fields
 * that do not apply to a type carry an empty value and are ignored by `toQuestionInput`.
 */
const draftSchema = z.object({
  type: z.enum(QUESTION_TYPES),
  title: z.string(),
  body: z.string(),
  code: z.string(),
  codeLanguage: z.string(),
  choices: z.array(z.string()),
  correctChoices: z.array(z.number()),
  correctBoolean: z.boolean(),
  correctAnswer: z.string(),
  acceptedAnswers: z.array(z.string()),
  numericTolerance: z.number(),
  explanation: z.string(),
  score: z.number(),
  timeLimitSec: z.number(),
  tags: z.array(z.string()),
});
type Draft = z.infer<typeof draftSchema>;

const str = { type: 'string' };
const strArr = { type: 'array', items: str };
const obj = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

const DRAFT_JSON = obj({
  type: { type: 'string', enum: [...QUESTION_TYPES] },
  title: { ...str, description: 'The question prompt (one or two sentences). Plain text only, no LaTeX.' },
  body: { ...str, description: 'Supporting passage, data, conditions and any formulas. Empty when the title is enough.' },
  code: { ...str, description: 'Code snippet shown with the question. Empty when none.' },
  codeLanguage: str,
  choices: { ...strArr, description: 'MULTIPLE_CHOICE only (4 or 5 options). Empty otherwise.' },
  correctChoices: { type: 'array', items: { type: 'integer' }, description: '1-based indexes into choices. MULTIPLE_CHOICE only.' },
  correctBoolean: { type: 'boolean', description: 'TRUE_FALSE only.' },
  correctAnswer: { ...str, description: 'SHORT_ANSWER / NUMERIC / LATEX only. NUMERIC: a plain number. LATEX: raw LaTeX without $.' },
  acceptedAnswers: { ...strArr, description: 'Other answers graded as correct (SHORT_ANSWER / LATEX).' },
  numericTolerance: { type: 'number', description: 'NUMERIC only: absolute tolerance, 0 for exact.' },
  explanation: { ...str, description: 'Worked solution shown to students after the answer is revealed.' },
  score: { type: 'integer' },
  timeLimitSec: { type: 'integer', description: 'Seconds to answer; 0 = no limit.' },
  tags: strArr,
});

const severity = { type: 'string', enum: [...AI_ISSUE_SEVERITIES] };
const nullableStr = { anyOf: [str, { type: 'null' }] };

const GENERATE_JSON = obj({ questions: { type: 'array', items: DRAFT_JSON } });
const SET_JSON = obj({ title: str, description: str, questions: { type: 'array', items: DRAFT_JSON } });
const REVIEW_JSON = obj({
  verdict: { type: 'string', enum: ['OK', 'NEEDS_FIX'] },
  summary: str,
  issues: {
    type: 'array',
    items: obj({ severity, field: { type: 'string', enum: [...AI_ISSUE_FIELDS] }, message: str, suggestion: nullableStr }),
  },
  revised: { anyOf: [DRAFT_JSON, { type: 'null' }], description: 'Full corrected question, or null when nothing needs to change.' },
});
const SET_REVIEW_JSON = obj({
  summary: str,
  issues: {
    type: 'array',
    items: obj({
      questionNumber: { type: 'integer', description: '1-based position of the question in the set; 0 for the set as a whole.' },
      severity,
      message: str,
      suggestion: nullableStr,
    }),
  },
});

const reviewOutSchema = z.object({
  verdict: z.enum(['OK', 'NEEDS_FIX']),
  summary: z.string(),
  issues: z.array(z.object({ severity: z.enum(AI_ISSUE_SEVERITIES), field: z.enum(AI_ISSUE_FIELDS), message: z.string(), suggestion: z.string().nullable() })),
  revised: draftSchema.nullable(),
});
const setReviewOutSchema = z.object({
  summary: z.string(),
  issues: z.array(z.object({ questionNumber: z.number(), severity: z.enum(AI_ISSUE_SEVERITIES), message: z.string(), suggestion: z.string().nullable() })),
});

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const textBlocks = (s: string): ContentBlock[] => (s.trim() ? [{ type: 'text', text: s.trim() }] : []);

/** Converts a model draft into a validated QuestionInput; null when the draft is unusable. */
export function toQuestionInput(d: Draft): QuestionInput | null {
  const description: ContentBlock[] = [...textBlocks(d.body)];
  if (d.code.trim()) description.push({ type: 'code', code: d.code, language: d.codeLanguage.trim() || undefined });
  const q: QuestionInput = {
    type: d.type,
    title: d.title.trim() || null,
    description: description.length ? description : null,
    explanation: d.explanation.trim() ? textBlocks(d.explanation) : null,
    score: clamp(Math.round(d.score) || 10, 0, 100_000),
    timeLimitSec: d.timeLimitSec > 0 ? clamp(Math.round(d.timeLimitSec), 1, 24 * 3600) : null,
    tags: d.tags.map((t) => t.trim().slice(0, 40)).filter(Boolean).slice(0, 20),
    deliveryMode: 'DIGITAL',
  };
  const accepted = d.acceptedAnswers.map((a) => a.trim()).filter(Boolean);
  const answer = d.correctAnswer.trim();
  switch (d.type) {
    case 'MULTIPLE_CHOICE': {
      const choices = d.choices.slice(0, CIRCLED.length);
      const ids = [...new Set(d.correctChoices)].filter((n) => Number.isInteger(n) && n >= 1 && n <= choices.length).map(String);
      if (!ids.length) return null;
      q.choices = choices.map((c, i) => ({ id: String(i + 1), label: CIRCLED[i], content: textBlocks(c) }));
      q.correctAnswer = ids.length === 1 ? ids[0] : ids;
      q.grading = { method: 'MULTIPLE_CHOICE', ...(ids.length > 1 ? { multipleSelect: true } : {}) };
      break;
    }
    case 'TRUE_FALSE':
      q.correctAnswer = d.correctBoolean;
      q.grading = { method: 'EXACT' };
      break;
    case 'SHORT_ANSWER':
      if (!answer) return null;
      q.correctAnswer = answer;
      q.acceptedAnswers = accepted;
      q.grading = { method: 'TEXT_NORMALIZED' };
      break;
    case 'NUMERIC':
      if (!answer) return null;
      q.correctAnswer = Number.isFinite(Number(answer)) ? Number(answer) : answer;
      q.grading = { method: 'NUMERIC', ...(d.numericTolerance > 0 ? { tolerance: d.numericTolerance } : {}) };
      break;
    case 'LATEX':
      if (!answer) return null;
      q.correctAnswer = answer;
      q.acceptedAnswers = accepted;
      q.grading = { method: 'LATEX', latexNumericEquivalence: true, latexCommutative: true, latexIgnoreVariableAssignment: true };
      break;
    case 'ESSAY':
      q.grading = { method: 'MANUAL' };
      break;
  }
  return questionInputSchema.safeParse(q).success ? q : null;
}

const MEDIA_NOTE: Record<string, string> = { image: '[image attached]', audio: '[audio attached]', video: '[video attached]' };

function blocksToText(blocks: ContentBlock[] | null | undefined): string {
  return (blocks ?? [])
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'math') return `$${b.latex}$`;
      if (b.type === 'code') return `\`\`\`${b.language ?? ''}\n${b.code}\n\`\`\``;
      return MEDIA_NOTE[b.type];
    })
    .join('\n');
}

/** What the model sees of an existing question. Media is replaced by a marker: its content is not sent. */
function describeQuestion(q: QuestionInput | QuestionDTO): Record<string, unknown> {
  const choices = q.choices ?? [];
  const ca = q.correctAnswer;
  const correctIds = Array.isArray(ca) ? ca : typeof ca === 'string' ? [ca] : [];
  return {
    type: q.type,
    deliveryMode: q.deliveryMode ?? 'DIGITAL',
    title: q.title ?? '',
    body: blocksToText(q.description),
    ...(q.type === 'MULTIPLE_CHOICE'
      ? {
          choices: choices.map((c, i) => `${i + 1}. ${blocksToText(c.content)}`),
          correctChoices: choices.flatMap((c, i) => (correctIds.includes(c.id) ? [i + 1] : [])),
        }
      : { correctAnswer: ca ?? null, acceptedAnswers: q.acceptedAnswers ?? [] }),
    grading: q.grading ?? null,
    score: q.score ?? 10,
    timeLimitSec: q.timeLimitSec ?? 0,
    explanation: blocksToText(q.explanation),
  };
}

/* ---------------------------------------------------------------------- prompts */

const FORMAT_RULES = `Question format rules:
- Types: MULTIPLE_CHOICE (pick from choices), TRUE_FALSE, SHORT_ANSWER (short text, auto-graded after whitespace/case normalization), NUMERIC (a number, auto-graded with tolerance), LATEX (a math expression typed in a formula editor, auto-graded by expression equivalence), ESSAY (free text, graded by the teacher by hand).
- Text fields are plain text, no Markdown. body, choices and explanation render inline math written as $...$ LaTeX. The title is shown verbatim (also in tables and menus), so it must not contain LaTeX: when the prompt needs a formula, put the formula in body and keep the title as the instruction ("다음 일차함수의 기울기를 구하시오.").
- Auto-graded answers are compared by machine, so every auto-graded question needs exactly one defensible answer. For SHORT_ANSWER keep the answer to a word or short phrase and list every other spelling or synonym a student could reasonably type in acceptedAnswers.
- MULTIPLE_CHOICE: distractors must be plausible and unambiguously wrong; do not number or letter the choice text.
- Students answer under a countdown on a phone or laptop, usually in a live classroom quiz: keep prompts short enough to read in the time limit.`;

const AUTHOR_SYSTEM = `You write quiz questions for teachers using BrainBattle, a real-time classroom quiz platform. Teachers review your drafts before any student sees them, but they rely on your answers being correct: solve every question yourself and check the stored answer against your solution before returning it.

${FORMAT_RULES}

Write in the language of the teacher's request (Korean when it is in Korean). Each question should test something distinct. Give every question an explanation a student can learn from, a score (10 for a typical question, more for harder ones) and a realistic time limit in seconds.`;

const REVIEW_SYSTEM = `You review quiz questions for teachers using BrainBattle, a real-time classroom quiz platform. The teacher wants to know, before students see the question, whether anything is wrong with it. Solve the question yourself first, then compare with the stored answer.

${FORMAT_RULES}

Look for: a wrong or missing answer, more than one defensible answer, ambiguous or misleading wording, weak or accidentally-correct distractors, answers an auto-grader would reject although a student is right (missing accepted answers, tolerance too tight), factual errors, typos, an explanation that does not match the answer, and a time limit or score that does not fit the difficulty.
Severity: ERROR = students would be graded wrongly or cannot answer; WARNING = likely to confuse or be unfair; INFO = optional polish.
Report only real problems; an empty issue list with verdict OK is the right result for a sound question. "[image attached]" marks media you cannot see: do not report problems that depend on its content. Questions with deliveryMode PAPER are printed on paper, so an empty title and body is expected there.
Write the summary, messages and suggestions in the language of the question (Korean when it is in Korean).`;

const DIFFICULTY_TEXT = { EASY: 'easy', MEDIUM: 'medium', HARD: 'hard', MIXED: 'a mix from easy to hard, ordered easy first' };

function generationPrompt(v: z.infer<typeof aiGenerateRequestSchema>, forSet: boolean): string {
  return [
    forSet
      ? `Create a complete question set of ${v.count} questions, with a short set title and a one-sentence description.`
      : `Write ${v.count} question${v.count > 1 ? 's' : ''}.`,
    `Topic: ${v.topic}`,
    v.audience ? `Students: ${v.audience}` : '',
    `Difficulty: ${DIFFICULTY_TEXT[v.difficulty]}`,
    v.types.length ? `Use only these question types: ${v.types.join(', ')}` : 'Choose the question types that suit the topic; prefer auto-graded types.',
    v.instructions ? `Additional instructions from the teacher: ${v.instructions}` : '',
    v.sourceText ? `Base the questions on this reference material only:\n<reference>\n${v.sourceText}\n</reference>` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/* ---------------------------------------------------------------------- service */

export class AiService {
  constructor(private readonly client: AiClient | null) {}

  get enabled(): boolean {
    return this.client !== null;
  }

  private complete(system: string, prompt: string, schema: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new AppError('AI_UNAVAILABLE', 'AI features are not configured on this server');
    return this.client.complete({ system, prompt, schema });
  }

  private collect(drafts: unknown, limit: number): AiGenerateResult {
    const list = z.array(z.unknown()).safeParse(drafts);
    if (!list.success) throw new AppError('AI_FAILED', 'AI returned an unexpected response');
    const questions: QuestionInput[] = [];
    for (const raw of list.data.slice(0, limit)) {
      const d = draftSchema.safeParse(raw);
      const q = d.success ? toQuestionInput(d.data) : null;
      if (q) questions.push(q);
    }
    if (!questions.length) throw new AppError('AI_FAILED', 'AI did not produce any usable question');
    return { questions, dropped: list.data.length - questions.length };
  }

  async generateQuestions(input: unknown): Promise<AiGenerateResult> {
    const v = aiGenerateRequestSchema.parse(input);
    const out = (await this.complete(AUTHOR_SYSTEM, generationPrompt(v, false), GENERATE_JSON)) as { questions?: unknown };
    return this.collect(out?.questions, v.count);
  }

  async generateSet(input: unknown): Promise<AiSetDraft> {
    const v = aiGenerateRequestSchema.parse(input);
    const out = (await this.complete(AUTHOR_SYSTEM, generationPrompt(v, true), SET_JSON)) as { title?: unknown; description?: unknown; questions?: unknown };
    const title = typeof out?.title === 'string' && out.title.trim() ? out.title.trim().slice(0, 200) : v.topic.slice(0, 200);
    const description = typeof out?.description === 'string' && out.description.trim() ? out.description.trim().slice(0, 5_000) : null;
    return { title, description, ...this.collect(out?.questions, v.count) };
  }

  async reviewQuestion(question: QuestionInput): Promise<AiQuestionReview> {
    const out = reviewOutSchema.safeParse(
      await this.complete(REVIEW_SYSTEM, `Review this question:\n${JSON.stringify(describeQuestion(question), null, 2)}`, REVIEW_JSON),
    );
    if (!out.success) throw new AppError('AI_FAILED', 'AI returned an unexpected response');
    let revised = out.data.revised ? toQuestionInput(out.data.revised) : null;
    if (revised) {
      // The model never saw media or delivery settings: carry them over from the original.
      const media = (question.description ?? []).filter((b) => b.type === 'image' || b.type === 'audio' || b.type === 'video');
      revised = {
        ...revised,
        displayNumber: question.displayNumber,
        deliveryMode: question.deliveryMode,
        attachments: question.attachments,
        description: media.length ? [...(revised.description ?? []), ...media] : revised.description,
      };
    }
    return { verdict: out.data.verdict, summary: out.data.summary, issues: out.data.issues, revised };
  }

  async reviewSet(set: QuestionSetDTO, questions: Map<string, QuestionDTO>): Promise<AiSetReview> {
    const items = set.items.filter((i) => questions.has(i.questionId));
    if (!items.length) throw new AppError('BAD_REQUEST', 'the question set is empty');
    const payload = {
      title: set.title,
      description: set.description,
      questions: items.map((item, i) => ({
        questionNumber: i + 1,
        ...describeQuestion(questions.get(item.questionId)!),
        ...(item.scoreOverride !== null ? { score: item.scoreOverride } : {}),
      })),
    };
    const out = setReviewOutSchema.safeParse(
      await this.complete(
        REVIEW_SYSTEM,
        `Review this whole question set. Besides problems in individual questions, report set-level problems with questionNumber 0: duplicated or overlapping questions, one question giving away another's answer, gaps in coverage of the set's topic, and an uneven difficulty or score balance.\n${JSON.stringify(payload, null, 2)}`,
        SET_REVIEW_JSON,
      ),
    );
    if (!out.success) throw new AppError('AI_FAILED', 'AI returned an unexpected response');
    return {
      summary: out.data.summary,
      issues: out.data.issues.map((i) => {
        const item = items[i.questionNumber - 1];
        return { itemId: item?.id ?? null, displayNumber: item?.displayNumber ?? null, severity: i.severity, message: i.message, suggestion: i.suggestion };
      }),
    };
  }
}
