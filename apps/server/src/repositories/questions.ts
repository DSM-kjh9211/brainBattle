import {
  AppError,
  DEFAULT_GRADING_METHOD,
  questionInputSchema,
  type QuestionDTO,
  type QuestionInput,
} from '@brainbattle/shared';
import type { Db, Queryable } from '../db/db.js';
import { newId } from '../lib/util.js';

interface QuestionRow {
  id: string;
  owner_id: string;
  display_number: string | null;
  type: QuestionDTO['type'];
  title: string | null;
  description: QuestionDTO['description'];
  choices: QuestionDTO['choices'];
  correct_answer: QuestionDTO['correctAnswer'] | null;
  accepted_answers: QuestionDTO['acceptedAnswers'];
  grading: QuestionDTO['grading'];
  score: number;
  time_limit_sec: number | null;
  explanation: QuestionDTO['explanation'];
  attachments: QuestionDTO['attachments'];
  delivery_mode: QuestionDTO['deliveryMode'];
  tags: string[];
  created_at: Date | string;
  updated_at: Date | string;
}

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

export function toQuestionDTO(r: QuestionRow): QuestionDTO {
  return {
    id: r.id,
    ownerId: r.owner_id,
    displayNumber: r.display_number,
    type: r.type,
    title: r.title,
    description: r.description,
    choices: r.choices,
    correctAnswer: r.correct_answer ?? undefined,
    acceptedAnswers: r.accepted_answers ?? [],
    grading: r.grading,
    score: Number(r.score),
    timeLimitSec: r.time_limit_sec,
    explanation: r.explanation,
    attachments: r.attachments ?? [],
    deliveryMode: r.delivery_mode,
    tags: r.tags ?? [],
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

const j = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

export class QuestionRepository {
  constructor(private readonly db: Db) {}

  async list(ownerId: string, opts: { search?: string; type?: string; limit?: number; offset?: number } = {}) {
    const params: unknown[] = [ownerId];
    let where = 'owner_id = $1 AND deleted_at IS NULL';
    if (opts.type) {
      params.push(opts.type);
      where += ` AND type = $${params.length}`;
    }
    if (opts.search) {
      params.push(`%${opts.search}%`);
      where += ` AND (coalesce(title,'') ILIKE $${params.length} OR coalesce(display_number,'') ILIKE $${params.length})`;
    }
    params.push(Math.min(opts.limit ?? 100, 500), opts.offset ?? 0);
    const { rows } = await this.db.query<QuestionRow>(
      `SELECT * FROM questions WHERE ${where} ORDER BY updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows.map(toQuestionDTO);
  }

  async get(id: string, q: Queryable = this.db): Promise<QuestionDTO | null> {
    const { rows } = await q.query<QuestionRow>('SELECT * FROM questions WHERE id = $1 AND deleted_at IS NULL', [id]);
    return rows[0] ? toQuestionDTO(rows[0]) : null;
  }

  async getOwned(id: string, ownerId: string, q: Queryable = this.db): Promise<QuestionDTO> {
    const qd = await this.get(id, q);
    if (!qd) throw new AppError('NOT_FOUND', 'question not found');
    if (qd.ownerId !== ownerId) throw new AppError('FORBIDDEN', 'not the owner of this question');
    return qd;
  }

  async create(ownerId: string, input: QuestionInput, q: Queryable = this.db): Promise<QuestionDTO> {
    const v = questionInputSchema.parse(input);
    const id = newId('q', 6);
    const grading = v.grading ?? { method: DEFAULT_GRADING_METHOD[v.type] };
    const { rows } = await q.query<QuestionRow>(
      `INSERT INTO questions (id, owner_id, display_number, type, title, description, choices, correct_answer,
         accepted_answers, grading, score, time_limit_sec, explanation, attachments, delivery_mode, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        id, ownerId, v.displayNumber ?? null, v.type, v.title ?? null, j(v.description), j(v.choices),
        j(v.correctAnswer), JSON.stringify(v.acceptedAnswers ?? []), JSON.stringify(grading), v.score,
        v.timeLimitSec ?? null, j(v.explanation), JSON.stringify(v.attachments ?? []), v.deliveryMode,
        JSON.stringify(v.tags ?? []),
      ],
    );
    return toQuestionDTO(rows[0]!);
  }

  async update(id: string, ownerId: string, input: QuestionInput): Promise<QuestionDTO> {
    await this.getOwned(id, ownerId);
    const v = questionInputSchema.parse(input);
    const grading = v.grading ?? { method: DEFAULT_GRADING_METHOD[v.type] };
    const { rows } = await this.db.query<QuestionRow>(
      `UPDATE questions SET display_number=$2, type=$3, title=$4, description=$5, choices=$6, correct_answer=$7,
         accepted_answers=$8, grading=$9, score=$10, time_limit_sec=$11, explanation=$12, attachments=$13,
         delivery_mode=$14, tags=$15, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [
        id, v.displayNumber ?? null, v.type, v.title ?? null, j(v.description), j(v.choices), j(v.correctAnswer),
        JSON.stringify(v.acceptedAnswers ?? []), JSON.stringify(grading), v.score, v.timeLimitSec ?? null,
        j(v.explanation), JSON.stringify(v.attachments ?? []), v.deliveryMode, JSON.stringify(v.tags ?? []),
      ],
    );
    return toQuestionDTO(rows[0]!);
  }

  /**
   * Soft delete: running/finished sessions keep their own snapshot, and question sets drop the item.
   */
  async delete(id: string, ownerId: string): Promise<void> {
    await this.getOwned(id, ownerId);
    await this.db.tx(async (q) => {
      await q.query('UPDATE questions SET deleted_at = now() WHERE id = $1', [id]);
      const { rows } = await q.query<{ set_id: string }>(
        'DELETE FROM question_set_questions WHERE question_id = $1 RETURNING set_id',
        [id],
      );
      for (const setId of new Set(rows.map((r) => r.set_id))) await compactPositions(q, setId);
    });
  }

  async duplicate(id: string, ownerId: string, q: Queryable = this.db): Promise<QuestionDTO> {
    const src = await this.getOwned(id, ownerId, q);
    return this.create(
      ownerId,
      {
        displayNumber: src.displayNumber,
        type: src.type,
        title: src.title ? `${src.title} (복사본)` : null,
        description: src.description,
        choices: src.choices,
        correctAnswer: src.correctAnswer,
        acceptedAnswers: src.acceptedAnswers,
        grading: src.grading,
        score: src.score,
        timeLimitSec: src.timeLimitSec,
        explanation: src.explanation,
        attachments: src.attachments,
        deliveryMode: src.deliveryMode,
        tags: src.tags,
      },
      q,
    );
  }
}

export async function compactPositions(q: Queryable, setId: string): Promise<void> {
  await q.query(
    `UPDATE question_set_questions t SET position = s.rn - 1
       FROM (SELECT id, row_number() OVER (ORDER BY position) AS rn FROM question_set_questions WHERE set_id = $1) s
      WHERE t.id = s.id`,
    [setId],
  );
}
