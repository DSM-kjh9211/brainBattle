import { z } from 'zod';
import { AppError, questionSetInputSchema, type QuestionInput, type QuestionSetDTO, type QuestionSetItemDTO } from '@brainbattle/shared';
import type { Db, Queryable } from '../db/db.js';
import { newId } from '../lib/util.js';
import { compactPositions, QuestionRepository } from './questions.js';

interface SetRow {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  delivery_mode: QuestionSetDTO['deliveryMode'];
  progress_mode: QuestionSetDTO['progressMode'];
  scoring_mode: QuestionSetDTO['scoringMode'];
  created_at: Date | string;
  updated_at: Date | string;
}

interface ItemRow {
  id: string;
  question_id: string;
  position: number;
  display_number: string | null;
  score_override: number | null;
  q_display_number: string | null;
}

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

export class QuestionSetRepository {
  private readonly questions: QuestionRepository;

  constructor(private readonly db: Db) {
    this.questions = new QuestionRepository(db);
  }

  private async items(q: Queryable, setId: string): Promise<QuestionSetItemDTO[]> {
    const { rows } = await q.query<ItemRow>(
      `SELECT i.id, i.question_id, i.position, i.display_number, i.score_override, qs.display_number AS q_display_number
         FROM question_set_questions i JOIN questions qs ON qs.id = i.question_id
        WHERE i.set_id = $1 ORDER BY i.position`,
      [setId],
    );
    return rows.map((r) => ({
      id: r.id,
      questionId: r.question_id,
      position: r.position,
      displayNumber: r.display_number ?? r.q_display_number ?? String(r.position + 1),
      displayNumberOverride: r.display_number,
      scoreOverride: r.score_override === null ? null : Number(r.score_override),
    }));
  }

  private toDTO(r: SetRow, items: QuestionSetItemDTO[]): QuestionSetDTO {
    return {
      id: r.id,
      ownerId: r.owner_id,
      title: r.title,
      description: r.description,
      deliveryMode: r.delivery_mode,
      progressMode: r.progress_mode,
      scoringMode: r.scoring_mode,
      items,
      questionCount: items.length,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    };
  }

  async list(ownerId: string): Promise<QuestionSetDTO[]> {
    const { rows } = await this.db.query<SetRow & { cnt: number }>(
      `SELECT s.*, (SELECT count(*) FROM question_set_questions i WHERE i.set_id = s.id)::int AS cnt
         FROM question_sets s WHERE s.owner_id = $1 AND s.deleted_at IS NULL ORDER BY s.updated_at DESC`,
      [ownerId],
    );
    return rows.map((r) => ({ ...this.toDTO(r, []), questionCount: Number(r.cnt) }));
  }

  async get(id: string, q: Queryable = this.db): Promise<QuestionSetDTO | null> {
    const { rows } = await q.query<SetRow>('SELECT * FROM question_sets WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!rows[0]) return null;
    return this.toDTO(rows[0], await this.items(q, id));
  }

  async getOwned(id: string, ownerId: string, q: Queryable = this.db): Promise<QuestionSetDTO> {
    const s = await this.get(id, q);
    if (!s) throw new AppError('NOT_FOUND', 'question set not found');
    if (s.ownerId !== ownerId) throw new AppError('FORBIDDEN', 'not the owner of this question set');
    return s;
  }

  /** Creates the set, optionally with new questions, atomically. */
  async create(ownerId: string, input: z.input<typeof questionSetInputSchema>, questions: QuestionInput[] = []): Promise<QuestionSetDTO> {
    const v = questionSetInputSchema.parse(input);
    const id = newId('qs', 6);
    return this.db.tx(async (q) => {
      await q.query(
        `INSERT INTO question_sets (id, owner_id, title, description, delivery_mode, progress_mode, scoring_mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, ownerId, v.title, v.description ?? null, v.deliveryMode, v.progressMode, v.scoringMode],
      );
      for (const input of questions) await this.insertAt(q, id, (await this.questions.create(ownerId, input, q)).id, {});
      return (await this.get(id, q))!;
    });
  }

  /** Creates the questions and appends them to the set; all or nothing. */
  async addNewQuestions(setId: string, ownerId: string, questions: QuestionInput[]): Promise<QuestionSetDTO> {
    return this.db.tx(async (q) => {
      await this.getOwned(setId, ownerId, q);
      for (const input of questions) await this.insertAt(q, setId, (await this.questions.create(ownerId, input, q)).id, {});
      await this.touch(q, setId);
      return (await this.get(setId, q))!;
    });
  }

  async update(id: string, ownerId: string, input: z.input<typeof questionSetInputSchema>): Promise<QuestionSetDTO> {
    await this.getOwned(id, ownerId);
    const v = questionSetInputSchema.parse(input);
    await this.db.query(
      `UPDATE question_sets SET title=$2, description=$3, delivery_mode=$4, progress_mode=$5, scoring_mode=$6, updated_at=now()
        WHERE id=$1`,
      [id, v.title, v.description ?? null, v.deliveryMode, v.progressMode, v.scoringMode],
    );
    return (await this.get(id))!;
  }

  async delete(id: string, ownerId: string): Promise<void> {
    await this.getOwned(id, ownerId);
    await this.db.query('UPDATE question_sets SET deleted_at = now() WHERE id = $1', [id]);
  }

  private touch(q: Queryable, id: string) {
    return q.query('UPDATE question_sets SET updated_at = now() WHERE id = $1', [id]);
  }

  async addQuestion(
    setId: string,
    ownerId: string,
    questionId: string,
    opts: { position?: number; displayNumber?: string | null; scoreOverride?: number | null } = {},
  ): Promise<QuestionSetDTO> {
    return this.db.tx(async (q) => {
      await this.getOwned(setId, ownerId, q);
      await this.questions.getOwned(questionId, ownerId, q);
      await this.insertAt(q, setId, questionId, opts);
      await this.touch(q, setId);
      return (await this.get(setId, q))!;
    });
  }

  private async insertAt(
    q: Queryable,
    setId: string,
    questionId: string,
    opts: { position?: number; displayNumber?: string | null; scoreOverride?: number | null },
  ): Promise<void> {
    const { rows } = await q.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM question_set_questions WHERE set_id = $1',
      [setId],
    );
    const count = Number(rows[0]!.n);
    const pos = Math.max(0, Math.min(opts.position ?? count, count));
    // positions are DEFERRABLE unique ⇒ shifting inside the transaction is safe
    await q.query('UPDATE question_set_questions SET position = position + 1 WHERE set_id = $1 AND position >= $2', [
      setId,
      pos,
    ]);
    await q.query(
      `INSERT INTO question_set_questions (id, set_id, question_id, position, display_number, score_override)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [newId('qsi', 6), setId, questionId, pos, opts.displayNumber ?? null, opts.scoreOverride ?? null],
    );
  }

  async removeItem(setId: string, ownerId: string, itemId: string): Promise<QuestionSetDTO> {
    return this.db.tx(async (q) => {
      await this.getOwned(setId, ownerId, q);
      const r = await q.query('DELETE FROM question_set_questions WHERE id = $1 AND set_id = $2', [itemId, setId]);
      if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'item not found');
      await compactPositions(q, setId);
      await this.touch(q, setId);
      return (await this.get(setId, q))!;
    });
  }

  async updateItem(
    setId: string,
    ownerId: string,
    itemId: string,
    patch: { displayNumber?: string | null; scoreOverride?: number | null },
  ): Promise<QuestionSetDTO> {
    return this.db.tx(async (q) => {
      await this.getOwned(setId, ownerId, q);
      const sets: string[] = [];
      const params: unknown[] = [itemId, setId];
      if (patch.displayNumber !== undefined) {
        params.push(patch.displayNumber);
        sets.push(`display_number = $${params.length}`);
      }
      if (patch.scoreOverride !== undefined) {
        params.push(patch.scoreOverride);
        sets.push(`score_override = $${params.length}`);
      }
      if (sets.length) {
        const r = await q.query(`UPDATE question_set_questions SET ${sets.join(', ')} WHERE id = $1 AND set_id = $2`, params);
        if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'item not found');
      }
      await this.touch(q, setId);
      return (await this.get(setId, q))!;
    });
  }

  /** Reorder (drag & drop): itemIds must be a permutation of the current items. */
  async reorder(setId: string, ownerId: string, itemIds: string[]): Promise<QuestionSetDTO> {
    return this.db.tx(async (q) => {
      const set = await this.getOwned(setId, ownerId, q);
      const current = new Set(set.items.map((i) => i.id));
      if (itemIds.length !== current.size || !itemIds.every((id) => current.has(id)) || new Set(itemIds).size !== itemIds.length) {
        throw new AppError('CONFLICT', 'item list does not match the current set (reload and retry)');
      }
      for (let i = 0; i < itemIds.length; i++) {
        await q.query('UPDATE question_set_questions SET position = $1 WHERE id = $2', [i, itemIds[i]]);
      }
      await this.touch(q, setId);
      return (await this.get(setId, q))!;
    });
  }

  /** Duplicates the underlying question and inserts the copy right after the item. */
  async duplicateItem(setId: string, ownerId: string, itemId: string): Promise<QuestionSetDTO> {
    return this.db.tx(async (q) => {
      const set = await this.getOwned(setId, ownerId, q);
      const item = set.items.find((i) => i.id === itemId);
      if (!item) throw new AppError('NOT_FOUND', 'item not found');
      const copy = await this.questions.duplicate(item.questionId, ownerId, q);
      await this.insertAt(q, setId, copy.id, { position: item.position + 1, scoreOverride: item.scoreOverride });
      await this.touch(q, setId);
      return (await this.get(setId, q))!;
    });
  }

  /** Duplicates the set. Questions are shared (deep copy is available per item). */
  async duplicateSet(setId: string, ownerId: string): Promise<QuestionSetDTO> {
    return this.db.tx(async (q) => {
      const src = await this.getOwned(setId, ownerId, q);
      const id = newId('qs', 6);
      await q.query(
        `INSERT INTO question_sets (id, owner_id, title, description, delivery_mode, progress_mode, scoring_mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, ownerId, `${src.title} (복사본)`, src.description, src.deliveryMode, src.progressMode, src.scoringMode],
      );
      for (const it of src.items) {
        await q.query(
          `INSERT INTO question_set_questions (id, set_id, question_id, position, display_number, score_override)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [newId('qsi', 6), id, it.questionId, it.position, it.displayNumberOverride, it.scoreOverride],
        );
      }
      return (await this.get(id, q))!;
    });
  }
}
