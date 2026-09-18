import { AppError } from '@brainbattle/shared';
import type { Db, Queryable } from '../db/db.js';
import type {
  ParticipantRecord,
  ScoreRecord,
  SessionAggregate,
  SessionEventRecord,
  SessionQuestionRecord,
  SessionRecord,
  SubmissionRecord,
} from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function rowToSession(r: Row): SessionRecord {
  return {
    id: r.id,
    teacherId: r.teacher_id,
    questionSetId: r.question_set_id,
    title: r.title,
    joinCode: r.join_code,
    preset: r.preset,
    state: r.state,
    settings: r.settings,
    currentSqId: r.current_sq_id,
    presentation: r.presentation,
    startedAt: n(r.started_at_ms),
    deadlineAt: n(r.deadline_at_ms),
    pauses: r.pauses ?? [],
    lockedAt: n(r.locked_at_ms),
    finishedAt: n(r.finished_at_ms),
    resultsReleased: r.results_released,
    eventSeq: Number(r.event_seq),
    version: Number(r.version),
  };
}

function rowToQuestion(r: Row): SessionQuestionRecord {
  return {
    id: r.id,
    sessionId: r.session_id,
    questionId: r.question_id,
    position: Number(r.position),
    displayNumber: r.display_number,
    snapshot: r.snapshot,
    maxScore: Number(r.max_score),
    timeLimitSec: n(r.time_limit_sec),
    phase: r.phase,
    opensAt: n(r.opens_at_ms),
    startedAt: n(r.started_at_ms),
    deadlineAt: n(r.deadline_at_ms),
    lockedAt: n(r.locked_at_ms),
    pauses: r.pauses ?? [],
  };
}

function rowToParticipant(r: Row): ParticipantRecord {
  return {
    id: r.id,
    sessionId: r.session_id,
    userId: r.user_id,
    nickname: r.nickname,
    nicknameKey: r.nickname_key,
    isGuest: r.is_guest,
    status: r.status,
    resumeTokenHash: r.resume_token_hash,
    joinedAt: Number(r.joined_at_ms),
    lastSeenAt: n(r.last_seen_at_ms),
    disconnectedAt: n(r.disconnected_at_ms),
    currentSqId: r.current_sq_id,
    progress: r.progress ?? {},
    clockSync: r.clock_sync ?? {},
    reconnectedAt: null,
    lastClientTimestamp: null,
  };
}

function rowToSubmission(r: Row): SubmissionRecord {
  return {
    id: r.id,
    sessionId: r.session_id,
    participantId: r.participant_id,
    sessionQuestionId: r.session_question_id,
    answer: r.answer,
    normalized: r.normalized,
    revision: Number(r.revision),
    clientSentAt: n(r.client_sent_at_ms),
    serverReceivedAt: Number(r.server_received_at_ms),
    effectiveSubmittedAt: Number(r.effective_submitted_at_ms),
    timestampSource: r.timestamp_source,
    timestampReason: r.timestamp_reason,
    responseMs: n(r.response_ms),
    isCorrect: r.is_correct,
    autoScore: n(r.auto_score),
    manualScore: n(r.manual_score),
    finalScore: Number(r.final_score),
    gradingStatus: r.grading_status,
    feedback: r.feedback,
    gradedBy: r.graded_by,
    gradedAt: n(r.graded_at_ms),
  };
}

export class SessionStore {
  constructor(readonly db: Db) {}

  async loadAggregate(sessionId: string): Promise<SessionAggregate> {
    const s = await this.db.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    if (!s.rows[0]) throw new AppError('NOT_FOUND', 'session not found');
    const [qs, ps, subs, keys, maxSeq] = await Promise.all([
      this.db.query('SELECT * FROM session_questions WHERE session_id = $1 ORDER BY position', [sessionId]),
      this.db.query('SELECT * FROM session_participants WHERE session_id = $1 ORDER BY joined_at_ms', [sessionId]),
      this.db.query('SELECT * FROM submissions WHERE session_id = $1', [sessionId]),
      this.db.query<{ participant_id: string; idempotency_key: string; submission_id: string; revision: number }>(
        'SELECT participant_id, idempotency_key, submission_id, revision FROM submission_revisions WHERE session_id = $1',
        [sessionId],
      ),
      this.db.query<{ m: number | null }>('SELECT max(seq) AS m FROM session_events WHERE session_id = $1', [sessionId]),
    ]);
    const session = rowToSession(s.rows[0]);
    session.eventSeq = Math.max(session.eventSeq, Number(maxSeq.rows[0]?.m ?? 0));
    return {
      session,
      questions: qs.rows.map(rowToQuestion),
      participants: ps.rows.map(rowToParticipant),
      submissions: subs.rows.map(rowToSubmission),
      idempotencyKeys: keys.rows.map((k) => ({
        participantId: k.participant_id,
        key: k.idempotency_key,
        submissionId: k.submission_id,
        revision: Number(k.revision),
      })),
    };
  }

  async findLiveByJoinCode(code: string): Promise<{ id: string; state: string } | null> {
    const { rows } = await this.db.query<{ id: string; state: string }>(
      `SELECT id, state FROM sessions WHERE join_code = $1 AND state <> 'FINISHED'`,
      [code],
    );
    return rows[0] ?? null;
  }

  /** Optimistic concurrency: fails with VERSION_CONFLICT if another writer changed the row. */
  async saveSession(q: Queryable, s: SessionRecord): Promise<void> {
    const r = await q.query(
      `UPDATE sessions SET state=$3, settings=$4, current_sq_id=$5, presentation=$6, started_at_ms=$7, deadline_at_ms=$8,
          pauses=$9, locked_at_ms=$10, finished_at_ms=$11, results_released=$12, event_seq=$13, version=version+1, updated_at=now()
        WHERE id=$1 AND version=$2`,
      [
        s.id, s.version, s.state, JSON.stringify(s.settings), s.currentSqId, JSON.stringify(s.presentation),
        s.startedAt, s.deadlineAt, JSON.stringify(s.pauses), s.lockedAt, s.finishedAt, s.resultsReleased, s.eventSeq,
      ],
    );
    if (r.rowCount === 0) throw new AppError('VERSION_CONFLICT', 'session was modified by another node');
    s.version += 1;
  }

  async saveQuestion(q: Queryable, sq: SessionQuestionRecord): Promise<void> {
    await q.query(
      `UPDATE session_questions SET phase=$2, opens_at_ms=$3, started_at_ms=$4, deadline_at_ms=$5, locked_at_ms=$6, pauses=$7
        WHERE id=$1`,
      [sq.id, sq.phase, sq.opensAt, sq.startedAt, sq.deadlineAt, sq.lockedAt, JSON.stringify(sq.pauses)],
    );
  }

  async insertParticipant(q: Queryable, p: ParticipantRecord, ip: string | null): Promise<void> {
    await q.query(
      `INSERT INTO session_participants (id, session_id, user_id, nickname, nickname_key, is_guest, status, resume_token_hash,
         joined_at_ms, last_seen_at_ms, current_sq_id, progress, clock_sync, join_ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        p.id, p.sessionId, p.userId, p.nickname, p.nicknameKey, p.isGuest, p.status, p.resumeTokenHash, p.joinedAt,
        p.lastSeenAt, p.currentSqId, JSON.stringify(p.progress), JSON.stringify(p.clockSync), ip,
      ],
    );
    await q.query('INSERT INTO scores (session_id, participant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
      p.sessionId,
      p.id,
    ]);
  }

  async saveParticipant(q: Queryable, p: ParticipantRecord): Promise<void> {
    await q.query(
      `UPDATE session_participants SET status=$2, resume_token_hash=$3, last_seen_at_ms=$4, disconnected_at_ms=$5,
          current_sq_id=$6, progress=$7, clock_sync=$8 WHERE id=$1`,
      [
        p.id, p.status, p.resumeTokenHash, p.lastSeenAt, p.disconnectedAt, p.currentSqId,
        JSON.stringify(p.progress), JSON.stringify(stripPending(p.clockSync)),
      ],
    );
  }

  async saveClockSync(p: ParticipantRecord): Promise<void> {
    await this.db.query('UPDATE session_participants SET clock_sync=$2, last_seen_at_ms=$3 WHERE id=$1', [
      p.id,
      JSON.stringify(stripPending(p.clockSync)),
      p.lastSeenAt,
    ]);
  }

  async upsertSubmission(
    q: Queryable,
    sub: SubmissionRecord,
    isNew: boolean,
    expectedPrevRevision: number | null,
  ): Promise<void> {
    if (isNew) {
      await q.query(
        `INSERT INTO submissions (id, session_id, participant_id, session_question_id, answer, normalized, revision,
           client_sent_at_ms, server_received_at_ms, effective_submitted_at_ms, timestamp_source, timestamp_reason, response_ms,
           is_correct, auto_score, manual_score, final_score, grading_status, feedback, graded_by, graded_at_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        this.subParams(sub),
      );
      return;
    }
    const r = await q.query(
      `UPDATE submissions SET answer=$5, normalized=$6, revision=$7, client_sent_at_ms=$8, server_received_at_ms=$9,
          effective_submitted_at_ms=$10, timestamp_source=$11, timestamp_reason=$12, response_ms=$13, is_correct=$14,
          auto_score=$15, manual_score=$16, final_score=$17, grading_status=$18, feedback=$19, graded_by=$20, graded_at_ms=$21,
          updated_at=now()
        WHERE id=$1 AND session_id=$2 AND participant_id=$3 AND session_question_id=$4 AND revision=$22`,
      [...this.subParams(sub), expectedPrevRevision],
    );
    if (r.rowCount === 0) throw new AppError('STALE_REVISION', 'submission changed concurrently');
  }

  private subParams(s: SubmissionRecord): unknown[] {
    return [
      s.id, s.sessionId, s.participantId, s.sessionQuestionId, JSON.stringify(s.answer), s.normalized, s.revision,
      s.clientSentAt, s.serverReceivedAt, s.effectiveSubmittedAt, s.timestampSource, s.timestampReason, s.responseMs,
      s.isCorrect, s.autoScore, s.manualScore, s.finalScore, s.gradingStatus, s.feedback, s.gradedBy, s.gradedAt,
    ];
  }

  async insertRevision(
    q: Queryable,
    sub: SubmissionRecord,
    meta: { idempotencyKey: string; clientMonoAt: number | null; clockEpochId: string | null; isReplay: boolean },
  ): Promise<void> {
    await q.query(
      `INSERT INTO submission_revisions (id, submission_id, session_id, participant_id, session_question_id, revision, answer,
         normalized, client_sent_at_ms, client_mono_at, clock_epoch_id, server_received_at_ms, effective_submitted_at_ms,
         timestamp_source, timestamp_reason, idempotency_key, is_replay, is_correct, auto_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        `rev_${sub.id.slice(4)}_${sub.revision}`, sub.id, sub.sessionId, sub.participantId, sub.sessionQuestionId,
        sub.revision, JSON.stringify(sub.answer), sub.normalized, sub.clientSentAt, meta.clientMonoAt, meta.clockEpochId,
        sub.serverReceivedAt, sub.effectiveSubmittedAt, sub.timestampSource, sub.timestampReason, meta.idempotencyKey,
        meta.isReplay, sub.isCorrect, sub.autoScore,
      ],
    );
  }

  async saveScore(q: Queryable, sessionId: string, s: ScoreRecord): Promise<void> {
    await q.query(
      `INSERT INTO scores (session_id, participant_id, total_score, correct_count, answered_count, last_scored_at_ms,
          last_correct_at_ms, total_response_ms, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
       ON CONFLICT (session_id, participant_id) DO UPDATE SET total_score=EXCLUDED.total_score,
          correct_count=EXCLUDED.correct_count, answered_count=EXCLUDED.answered_count,
          last_scored_at_ms=EXCLUDED.last_scored_at_ms, last_correct_at_ms=EXCLUDED.last_correct_at_ms,
          total_response_ms=EXCLUDED.total_response_ms, updated_at=now()`,
      [sessionId, s.participantId, s.totalScore, s.correctCount, s.answeredCount, s.lastScoredAt, s.lastCorrectAt, s.totalResponseMs],
    );
  }

  async appendEvents(q: Queryable, sessionId: string, events: SessionEventRecord[]): Promise<void> {
    for (const e of events) {
      await q.query(
        `INSERT INTO session_events (session_id, seq, type, actor_type, actor_id, payload, at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [sessionId, e.seq, e.type, e.actorType, e.actorId, JSON.stringify(e.payload), e.at],
      );
    }
  }

  async saveLeaderboardSnapshot(sessionId: string, version: number, reason: string, entries: unknown[], at: number) {
    await this.db.query(
      'INSERT INTO leaderboard_snapshots (session_id, version, reason, entries, taken_at_ms) VALUES ($1,$2,$3,$4,$5)',
      [sessionId, version, reason, JSON.stringify(entries), at],
    );
  }
}

function stripPending<T extends { pending?: unknown }>(m: Record<string, T>): Record<string, T> {
  // keep at most the 3 most recently synced epochs
  const entries = Object.entries(m)
    .sort((a, b) => ((b[1] as { syncedAt?: number }).syncedAt ?? 0) - ((a[1] as { syncedAt?: number }).syncedAt ?? 0))
    .slice(0, 3);
  return Object.fromEntries(entries.map(([k, v]) => [k, { ...v, pending: null }]));
}
