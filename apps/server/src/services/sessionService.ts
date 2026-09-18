import { z } from 'zod';
import {
  AppError,
  createSessionSchema,
  DEFAULT_GRADING_METHOD,
  resolveSessionSettings,
  type SessionSettings,
  type SessionSummaryDTO,
} from '@brainbattle/shared';
import type { Db } from '../db/db.js';
import { isUniqueViolation } from '../db/db.js';
import type { QuestionSnapshot } from '../domain/grading.js';
import { Leaderboard } from '../domain/ranking.js';
import { generateJoinCode, newId } from '../lib/util.js';
import { QuestionRepository } from '../repositories/questions.js';
import { QuestionSetRepository } from '../repositories/questionSets.js';
import { rowToSession } from '../realtime/sessionStore.js';

export class SessionService {
  private readonly sets: QuestionSetRepository;
  private readonly questions: QuestionRepository;

  constructor(private readonly db: Db) {
    this.sets = new QuestionSetRepository(db);
    this.questions = new QuestionRepository(db);
  }

  /**
   * Creates a session and FREEZES the question set into session_questions snapshots, so editing
   * or deleting bank questions never changes a running or finished session.
   */
  async create(teacherId: string, input: z.input<typeof createSessionSchema>): Promise<SessionSummaryDTO & { settings: SessionSettings }> {
    const v = createSessionSchema.parse(input);
    const set = await this.sets.getOwned(v.questionSetId, teacherId);
    if (set.items.length === 0) throw new AppError('BAD_REQUEST', 'question set is empty');
    // CUSTOM starts from the set's own modes; presets start from the preset
    const basePatch =
      v.preset === 'CUSTOM'
        ? { deliveryMode: set.deliveryMode, progressMode: set.progressMode, scoringMode: set.scoringMode }
        : {};
    const settings = resolveSessionSettings(v.preset, { ...basePatch, ...(v.settings ?? {}) } as never);
    if (settings.join.classroomId) {
      const { rows } = await this.db.query<{ teacher_id: string }>('SELECT teacher_id FROM classrooms WHERE id = $1', [
        settings.join.classroomId,
      ]);
      if (rows[0]?.teacher_id !== teacherId) throw new AppError('FORBIDDEN', 'classroom not found');
    }
    const id = newId('ses', 6);
    for (let attempt = 0; attempt < 12; attempt++) {
      const joinCode = generateJoinCode(settings.join.joinCodeFormat);
      try {
        await this.db.tx(async (q) => {
          await q.query(
            `INSERT INTO sessions (id, teacher_id, question_set_id, title, join_code, preset, state, settings)
             VALUES ($1,$2,$3,$4,$5,$6,'CREATED',$7)`,
            [id, teacherId, set.id, v.title?.trim() || set.title, joinCode, v.preset, JSON.stringify(settings)],
          );
          for (const item of set.items) {
            const qd = await this.questions.get(item.questionId, q);
            if (!qd) continue;
            const snapshot: QuestionSnapshot = {
              questionId: qd.id,
              type: qd.type,
              title: qd.title,
              description: qd.description,
              choices: qd.choices,
              correctAnswer: qd.correctAnswer,
              acceptedAnswers: qd.acceptedAnswers,
              grading: qd.grading ?? { method: DEFAULT_GRADING_METHOD[qd.type] },
              explanation: qd.explanation,
              attachments: qd.attachments,
              deliveryMode: qd.deliveryMode,
            };
            await q.query(
              `INSERT INTO session_questions (id, session_id, question_id, position, display_number, snapshot, max_score, time_limit_sec)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [
                newId('sq', 6), id, qd.id, item.position, item.displayNumber, JSON.stringify(snapshot),
                item.scoreOverride ?? qd.score, qd.timeLimitSec,
              ],
            );
          }
        });
        return { ...(await this.summary(id)), settings };
      } catch (e) {
        if (isUniqueViolation(e, 'sessions_join_code_live_uq')) continue; // join code collision → retry
        throw e;
      }
    }
    throw new AppError('INTERNAL', 'could not allocate a join code');
  }

  async summary(id: string): Promise<SessionSummaryDTO> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT s.*, (SELECT count(*) FROM session_participants p WHERE p.session_id = s.id AND p.status <> 'KICKED')::int AS pc
         FROM sessions s WHERE s.id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) throw new AppError('NOT_FOUND', 'session not found');
    return this.toSummary(r);
  }

  private toSummary(r: Record<string, unknown>): SessionSummaryDTO {
    const s = rowToSession(r);
    return {
      id: s.id,
      title: s.title,
      joinCode: s.joinCode,
      state: s.state,
      preset: s.preset,
      questionSetId: s.questionSetId ?? '',
      teacherId: s.teacherId,
      participantCount: Number(r.pc ?? 0),
      createdAt: new Date(r.created_at as string).toISOString(),
      startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
      finishedAt: s.finishedAt ? new Date(s.finishedAt).toISOString() : null,
    };
  }

  async assertOwner(sessionId: string, teacherId: string, isAdmin = false): Promise<void> {
    const { rows } = await this.db.query<{ teacher_id: string }>('SELECT teacher_id FROM sessions WHERE id = $1', [sessionId]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'session not found');
    if (rows[0].teacher_id !== teacherId && !isAdmin) throw new AppError('FORBIDDEN', 'not the teacher of this session');
  }

  async list(teacherId: string): Promise<SessionSummaryDTO[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT s.*, (SELECT count(*) FROM session_participants p WHERE p.session_id = s.id AND p.status <> 'KICKED')::int AS pc
         FROM sessions s WHERE s.teacher_id = $1 ORDER BY s.created_at DESC LIMIT 200`,
      [teacherId],
    );
    return rows.map((r) => this.toSummary(r));
  }

  /**
   * Result analysis (works for live and finished sessions; reads committed data only).
   * Uses submissions_session_q_idx / submissions_session_p_idx / sp_session_idx.
   */
  async results(sessionId: string) {
    const { rows: srows } = await this.db.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    if (!srows[0]) throw new AppError('NOT_FOUND', 'session not found');
    const session = rowToSession(srows[0]);
    const [questions, participants, scores, perQuestion, submissions] = await Promise.all([
      this.db.query<Record<string, unknown>>(
        'SELECT id, position, display_number, max_score, snapshot FROM session_questions WHERE session_id = $1 ORDER BY position',
        [sessionId],
      ),
      this.db.query<Record<string, unknown>>(
        'SELECT id, nickname, is_guest, status, user_id FROM session_participants WHERE session_id = $1 ORDER BY joined_at_ms',
        [sessionId],
      ),
      this.db.query<Record<string, unknown>>('SELECT * FROM scores WHERE session_id = $1', [sessionId]),
      this.db.query<Record<string, unknown>>(
        `SELECT session_question_id,
                count(*)::int AS submitted,
                count(*) FILTER (WHERE is_correct)::int AS correct,
                count(*) FILTER (WHERE grading_status = 'PENDING_MANUAL')::int AS pending,
                avg(final_score) FILTER (WHERE grading_status <> 'PENDING_MANUAL') AS avg_score,
                avg(response_ms) AS avg_response_ms
           FROM submissions WHERE session_id = $1 GROUP BY session_question_id`,
        [sessionId],
      ),
      this.db.query<Record<string, unknown>>(
        `SELECT id, participant_id, session_question_id, answer, normalized, is_correct, final_score, grading_status,
                revision, timestamp_source, response_ms
           FROM submissions WHERE session_id = $1`,
        [sessionId],
      ),
    ]);
    const lb = new Leaderboard(session.settings.ranking);
    const scoreBy = new Map(scores.rows.map((r) => [r.participant_id as string, r]));
    lb.rebuild(
      participants.rows
        .filter((p) => p.status !== 'KICKED')
        .map((p) => {
          const s = scoreBy.get(p.id as string);
          const answered = Number(s?.answered_count ?? 0);
          return {
            participantId: p.id as string,
            nickname: p.nickname as string,
            totalScore: Number(s?.total_score ?? 0),
            correctCount: Number(s?.correct_count ?? 0),
            answeredCount: answered,
            lastScoredAt: (s?.last_scored_at_ms as number | null) ?? null,
            lastCorrectAt: (s?.last_correct_at_ms as number | null) ?? null,
            avgResponseMs: answered ? Number(s?.total_response_ms ?? 0) / answered : null,
          };
        }),
    );
    const participantCount = lb.size;
    const stats = new Map(perQuestion.rows.map((r) => [r.session_question_id as string, r]));
    return {
      session: {
        id: session.id,
        title: session.title,
        state: session.state,
        settings: session.settings,
        startedAt: session.startedAt,
        finishedAt: session.finishedAt,
      },
      questions: questions.rows.map((q) => {
        const st = stats.get(q.id as string);
        const submitted = Number(st?.submitted ?? 0);
        const correct = Number(st?.correct ?? 0);
        const pending = Number(st?.pending ?? 0);
        const snap = q.snapshot as QuestionSnapshot;
        return {
          sessionQuestionId: q.id as string,
          position: Number(q.position),
          displayNumber: q.display_number as string,
          type: snap.type,
          title: snap.title,
          maxScore: Number(q.max_score),
          submitted,
          correct,
          pendingManual: pending,
          submissionRate: participantCount ? submitted / participantCount : 0,
          correctRate: submitted - pending > 0 ? correct / (submitted - pending) : null,
          averageScore: st?.avg_score === null || st?.avg_score === undefined ? null : Number(st.avg_score),
          averageResponseMs: st?.avg_response_ms === null || st?.avg_response_ms === undefined ? null : Number(st.avg_response_ms),
        };
      }),
      leaderboard: lb.entries(),
      participants: participants.rows.map((p) => ({
        participantId: p.id as string,
        nickname: p.nickname as string,
        isGuest: p.is_guest as boolean,
        status: p.status as string,
      })),
      submissions: submissions.rows.map((s) => ({
        submissionId: s.id as string,
        participantId: s.participant_id as string,
        sessionQuestionId: s.session_question_id as string,
        answer: s.answer,
        normalized: s.normalized as string | null,
        isCorrect: s.is_correct as boolean | null,
        finalScore: Number(s.final_score),
        gradingStatus: s.grading_status as string,
        revision: Number(s.revision),
        timestampSource: s.timestamp_source as string,
        responseMs: s.response_ms === null ? null : Number(s.response_ms),
      })),
    };
  }

  async revisions(sessionId: string, submissionId: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT revision, answer, normalized, client_sent_at_ms, server_received_at_ms, effective_submitted_at_ms,
              timestamp_source, timestamp_reason, is_replay, is_correct, auto_score, created_at
         FROM submission_revisions WHERE session_id = $1 AND submission_id = $2 ORDER BY revision`,
      [sessionId, submissionId],
    );
    return rows;
  }

  async events(sessionId: string, limit = 500) {
    const { rows } = await this.db.query<Record<string, unknown>>(
      'SELECT seq, type, actor_type, actor_id, payload, at_ms FROM session_events WHERE session_id = $1 ORDER BY seq DESC LIMIT $2',
      [sessionId, limit],
    );
    return rows;
  }
}
