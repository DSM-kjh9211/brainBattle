import {
  AppError,
  canTransitionQuestion,
  canTransitionSession,
  type ClientPayload,
  type ClientRole,
  type LeaderboardChange,
  type LeaderboardEntry,
  type OwnSubmissionView,
  type ParticipantScoreView,
  type PresentationContent,
  type QuestionReveal,
  type QuestionStats,
  type ScoreboardSessionState,
  type ServerEventMap,
  type ServerEventType,
  type SessionState,
  type StudentSessionState,
  type SubmitAnswerPayload,
  type TeacherSessionState,
  type TimingWindow,
} from '@brainbattle/shared';
import { isUniqueViolation, type Queryable } from '../db/db.js';
import { grade } from '../domain/grading.js';
import { Leaderboard, projectBoard, projectChanges, projectSelf, type RankRow } from '../domain/ranking.js';
import { computeAutoScore, isFullMarks, maxAssignableScore } from '../domain/scoring.js';
import {
  applyTimeSync,
  DEFAULT_TRUST_POLICY,
  evaluateTimestamp,
  type ClockSyncState,
  type TrustPolicy,
} from '../domain/timeTrust.js';
import { activeDuration, assertInsideWindow, type SubmissionWindow } from '../domain/window.js';
import type { Clock, TimerHandle } from '../lib/clock.js';
import { newId, nicknameKey, randomToken, round2, sha256 } from '../lib/util.js';
import type { ClassroomRepository } from '../repositories/users.js';
import type { SessionStore } from './sessionStore.js';
import { checkNewStudentAdmission, checkStudentAdmission } from './admission.js';
import type {
  ParticipantRecord,
  ScoreRecord,
  SessionAggregate,
  SessionEventRecord,
  SessionQuestionRecord,
  SessionRecord,
  SubmissionRecord,
} from './types.js';
import {
  computeStats,
  toOwnSubmission,
  toParticipantDTO,
  toReveal,
  toStudentQuestion,
  toTeacherQuestion,
  toTeacherSubmission,
} from './views.js';

/** A live WebSocket connection. connectionId is NEVER used as participant identity. */
export interface Conn {
  readonly id: string;
  readonly ip: string;
  role: ClientRole | null;
  userId: string | null;
  participantId: string | null;
  sessionId: string | null;
  send<T extends ServerEventType>(type: T, payload: ServerEventMap[T], opts?: { reqId?: string; seq?: number }): void;
  close(code: number, reason: string): void;
}

export interface RuntimeConfig {
  leaderboardSnapshotIntervalMs: number;
  leaderboardPersistIntervalMs: number;
  incrementalMaxChanges: number;
  clockSyncFlushIntervalMs: number;
  trust: TrustPolicy;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  leaderboardSnapshotIntervalMs: 5000,
  leaderboardPersistIntervalMs: 30_000,
  incrementalMaxChanges: 50,
  clockSyncFlushIntervalMs: 10_000,
  trust: DEFAULT_TRUST_POLICY,
};

export interface RuntimeDeps {
  store: SessionStore;
  clock: Clock;
  classrooms: ClassroomRepository;
  config: RuntimeConfig;
  log: { info: (o: object, msg?: string) => void; warn: (o: object, msg?: string) => void; error: (o: object, msg?: string) => void };
}

type Actor = { type: SessionEventRecord['actorType']; id: string | null };
type PublishedScore = { totalScore: number; correctCount: number; answeredCount: number; rank: number | null };

const clone = <T>(v: T): T => structuredClone(v);

export class SessionRuntime {
  session!: SessionRecord;
  readonly questions = new Map<string, SessionQuestionRecord>();
  questionOrder: string[] = [];
  readonly participants = new Map<string, ParticipantRecord>();
  private readonly byResumeHash = new Map<string, string>();
  private readonly subsByParticipant = new Map<string, Map<string, SubmissionRecord>>();
  private readonly subsByQuestion = new Map<string, Map<string, SubmissionRecord>>();
  private readonly subsById = new Map<string, SubmissionRecord>();
  private readonly idem = new Map<string, Map<string, { submissionId: string; revision: number }>>();
  private readonly scores = new Map<string, ScoreRecord>();
  leaderboard!: Leaderboard;

  readonly teachers = new Set<Conn>();
  readonly boards = new Set<Conn>();
  readonly students = new Map<string, Conn>();

  private queue: Promise<unknown> = Promise.resolve();
  private timers: Partial<Record<'session' | 'question' | 'prepare' | 'snapshot' | 'flush' | 'persistLb', TimerHandle>> = {};
  private lbDirty = false;
  private lbPersistDirty = false;
  private clockDirty = new Set<string>();
  private readonly publishedScores = new Map<string, PublishedScore>();
  private publishedBoard: LeaderboardEntry[] | null = null;
  disposed = false;

  constructor(private readonly deps: RuntimeDeps) {}

  get id(): string {
    return this.session.id;
  }

  private get now(): number {
    return this.deps.clock.now();
  }

  /* ============================================================== lifecycle */

  hydrate(agg: SessionAggregate): void {
    this.session = agg.session;
    for (const q of agg.questions) this.questions.set(q.id, q);
    this.questionOrder = agg.questions.sort((a, b) => a.position - b.position).map((q) => q.id);
    for (const p of agg.participants) {
      // a crash/failover means every socket is gone: nobody is CONNECTED on a fresh runtime
      if (p.status === 'CONNECTED' || p.status === 'RECONNECTING') {
        p.status = 'DISCONNECTED';
        p.disconnectedAt = this.now;
      }
      this.participants.set(p.id, p);
      this.byResumeHash.set(p.resumeTokenHash, p.id);
    }
    for (const s of agg.submissions) this.indexSubmission(s);
    for (const k of agg.idempotencyKeys) {
      this.idemMap(k.participantId).set(k.key, { submissionId: k.submissionId, revision: k.revision });
    }
    for (const p of this.participants.values()) {
      const subs = [...(this.subsByParticipant.get(p.id)?.values() ?? [])];
      const trusted = subs.filter((s) => s.timestampSource === 'CLIENT_TRUSTED').map((s) => s.effectiveSubmittedAt);
      p.lastClientTimestamp = trusted.length ? Math.max(...trusted) : null;
      this.scores.set(p.id, this.computeScore(p.id));
    }
    this.leaderboard = new Leaderboard(this.session.settings.ranking);
    this.leaderboard.rebuild(this.rankRows());
    for (const pid of this.participants.keys()) this.studentScoreView(pid, true);
    const sb0 = this.session.settings.scoreboard;
    this.publishedBoard = projectBoard(sb0.visibility, sb0.visible, this.leaderboard.entries());
    this.scheduleTimers();
    this.startBackgroundTimers();
  }

  dispose(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of Object.values(this.timers)) t?.cancel();
    this.timers = {};
    const all = [...this.teachers, ...this.boards, ...this.students.values()];
    for (const c of all) c.close(4009, reason);
    this.teachers.clear();
    this.boards.clear();
    this.students.clear();
  }

  get connectionCount(): number {
    return this.teachers.size + this.boards.size + this.students.size;
  }

  /** Serializes every state-changing operation of this session (actor model). */
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const p = this.queue.then(async () => {
      if (this.disposed) throw new AppError('SESSION_OWNED_ELSEWHERE', 'session runtime was unloaded, reconnect');
      return fn();
    });
    this.queue = p.catch(() => undefined);
    return p;
  }

  /* ============================================================== helpers */

  private idemMap(pid: string) {
    let m = this.idem.get(pid);
    if (!m) this.idem.set(pid, (m = new Map()));
    return m;
  }

  private indexSubmission(s: SubmissionRecord): void {
    this.subsById.set(s.id, s);
    let a = this.subsByParticipant.get(s.participantId);
    if (!a) this.subsByParticipant.set(s.participantId, (a = new Map()));
    a.set(s.sessionQuestionId, s);
    let b = this.subsByQuestion.get(s.sessionQuestionId);
    if (!b) this.subsByQuestion.set(s.sessionQuestionId, (b = new Map()));
    b.set(s.participantId, s);
  }

  private computeScore(pid: string): ScoreRecord {
    const subs = [...(this.subsByParticipant.get(pid)?.values() ?? [])];
    let total = 0;
    let correct = 0;
    let respTotal = 0;
    let lastScoredAt: number | null = null;
    let lastCorrectAt: number | null = null;
    for (const s of subs) {
      total += s.finalScore;
      if (s.isCorrect) {
        correct++;
        lastCorrectAt = Math.max(lastCorrectAt ?? 0, s.effectiveSubmittedAt);
      }
      if (s.finalScore > 0) lastScoredAt = Math.max(lastScoredAt ?? 0, s.effectiveSubmittedAt);
      if (s.responseMs !== null) respTotal += s.responseMs;
    }
    return {
      participantId: pid,
      totalScore: round2(total),
      correctCount: correct,
      answeredCount: subs.length,
      lastScoredAt,
      lastCorrectAt,
      totalResponseMs: respTotal,
    };
  }

  private rankRow(pid: string): RankRow {
    const p = this.participants.get(pid)!;
    const s = this.scores.get(pid) ?? this.computeScore(pid);
    return {
      participantId: pid,
      nickname: p.nickname,
      totalScore: s.totalScore,
      correctCount: s.correctCount,
      answeredCount: s.answeredCount,
      lastScoredAt: s.lastScoredAt,
      lastCorrectAt: s.lastCorrectAt,
      avgResponseMs: s.answeredCount ? s.totalResponseMs / s.answeredCount : null,
    };
  }

  private rankRows(): RankRow[] {
    return [...this.participants.values()].filter((p) => p.status !== 'KICKED').map((p) => this.rankRow(p.id));
  }

  private activeParticipantCount(): number {
    let n = 0;
    for (const p of this.participants.values()) if (p.status !== 'KICKED' && p.status !== 'LEFT') n++;
    return n;
  }

  private sessionTiming(): TimingWindow {
    return { startedAt: this.session.startedAt, deadlineAt: this.session.deadlineAt, pauses: this.session.pauses };
  }

  private currentQuestion(): SessionQuestionRecord | null {
    return this.session.currentSqId ? (this.questions.get(this.session.currentSqId) ?? null) : null;
  }

  private requireQuestion(sqId: string): SessionQuestionRecord {
    const sq = this.questions.get(sqId);
    if (!sq) throw new AppError('NOT_FOUND', 'question not in this session');
    return sq;
  }

  private event(type: string, actor: Actor, payload: Record<string, unknown> = {}): SessionEventRecord {
    return { seq: ++this.session.eventSeq, type, actorType: actor.type, actorId: actor.id, payload, at: this.now };
  }

  /**
   * Persists a new session/question state atomically (optimistic version check), then swaps it
   * into memory. Memory is only updated after the DB commit succeeded.
   */
  private async commit(opts: {
    session?: SessionRecord;
    questions?: SessionQuestionRecord[];
    events?: SessionEventRecord[];
    extra?: (q: Queryable) => Promise<void>;
  }): Promise<void> {
    await this.deps.store.db.tx(async (q) => {
      if (opts.session) {
        opts.session.eventSeq = this.session.eventSeq;
        await this.deps.store.saveSession(q, opts.session);
      }
      for (const sq of opts.questions ?? []) await this.deps.store.saveQuestion(q, sq);
      if (opts.events?.length) await this.deps.store.appendEvents(q, this.session.id, opts.events);
      if (opts.extra) await opts.extra(q);
    });
    if (opts.session) this.session = opts.session;
    for (const sq of opts.questions ?? []) this.questions.set(sq.id, sq);
  }

  /* -------------------------------------------------------------- emit */

  private emit<T extends ServerEventType>(
    type: T,
    payload: ServerEventMap[T],
    to: { teachers?: boolean; boards?: boolean; students?: boolean | string[] },
  ): void {
    const seq = this.session.eventSeq;
    if (to.teachers) for (const c of this.teachers) c.send(type, payload, { seq });
    if (to.boards) for (const c of this.boards) c.send(type, payload, { seq });
    if (to.students === true) for (const c of this.students.values()) c.send(type, payload, { seq });
    else if (Array.isArray(to.students)) {
      for (const pid of to.students) this.students.get(pid)?.send(type, payload, { seq });
    }
  }

  private emitStudentsEach<T extends ServerEventType>(type: T, build: (pid: string) => ServerEventMap[T] | null): void {
    const seq = this.session.eventSeq;
    for (const [pid, c] of this.students) {
      const p = build(pid);
      if (p) c.send(type, p, { seq });
    }
  }

  /* ============================================================== reveal policy */

  private questionClosed(sq: SessionQuestionRecord): boolean {
    if (this.session.state === 'FINISHED') return true;
    if (this.session.settings.progressMode === 'SYNCHRONIZED') return sq.phase === 'LOCKED' || sq.phase === 'RESULT';
    return false;
  }

  /** May the student see correctness/score of their own answer to sq? */
  canSeeGrade(sq: SessionQuestionRecord): boolean {
    const policy = this.session.settings.revealPolicy;
    if (policy === 'NEVER') return false;
    if (this.session.resultsReleased) return true;
    if (policy === 'IMMEDIATE') return true;
    if (policy === 'AFTER_QUESTION') return this.questionClosed(sq);
    return false; // AFTER_SESSION waits for release
  }

  /** May the student see the answer key (correctAnswer / explanation) of sq? */
  canSeeAnswerKey(sq: SessionQuestionRecord): boolean {
    const policy = this.session.settings.revealPolicy;
    if (policy === 'NEVER') return false;
    if (this.session.resultsReleased) return true;
    if (policy === 'AFTER_SESSION') return false;
    if (this.session.settings.progressMode === 'SYNCHRONIZED') return sq.phase === 'RESULT' || this.session.state === 'FINISHED';
    return this.session.state === 'FINISHED';
  }

  private visibleQuestionsForStudents(): SessionQuestionRecord[] {
    const all = this.questionOrder.map((id) => this.questions.get(id)!);
    const st = this.session.state;
    if (st === 'CREATED' || st === 'LOBBY' || st === 'READY') return [];
    if (this.session.settings.progressMode === 'FREE') return all;
    return all.filter((q) => q.phase === 'ACTIVE' || q.phase === 'LOCKED' || q.phase === 'RESULT');
  }

  /* ============================================================== snapshots */

  private common() {
    const s = this.session;
    const cur = this.currentQuestion();
    return {
      sessionId: s.id,
      title: s.title,
      joinCode: s.joinCode,
      state: s.state,
      deliveryMode: s.settings.deliveryMode,
      progressMode: s.settings.progressMode,
      scoringMode: s.settings.scoringMode,
      timing: this.sessionTiming(),
      currentSessionQuestionId: s.currentSqId,
      currentPhase: cur?.phase ?? null,
      questionOpensAt: cur?.opensAt ?? null,
      questionDeadlineAt: cur?.deadlineAt ?? null,
      questionCount: this.questionOrder.length,
      serverTime: this.now,
      eventSeq: s.eventSeq,
      scoreboard: { ...s.settings.scoreboard },
      presentation: { ...s.presentation },
      resultsReleased: s.resultsReleased,
    };
  }

  studentState(pid: string, resumeToken?: string): StudentSessionState {
    const p = this.participants.get(pid)!;
    const subs = [...(this.subsByParticipant.get(pid)?.values() ?? [])];
    const visible = this.visibleQuestionsForStudents();
    return {
      ...this.common(),
      role: 'STUDENT',
      participantId: pid,
      nickname: p.nickname,
      ...(resumeToken ? { resumeToken } : {}),
      editPolicy: this.session.settings.editPolicy,
      questions: visible.map((q) => toStudentQuestion(this.session, q)),
      submissions: subs.map((s) => toOwnSubmission(s, this.canSeeGrade(this.questions.get(s.sessionQuestionId)!))),
      selectedSessionQuestionId: p.currentSqId,
      score: this.studentScoreView(pid),
      reveals: visible.filter((q) => this.canSeeAnswerKey(q)).map(toReveal),
      participantCount: this.activeParticipantCount(),
    };
  }

  teacherState(): TeacherSessionState {
    const board = this.leaderboard.entries();
    return {
      ...this.common(),
      role: 'TEACHER',
      settings: clone(this.session.settings),
      questions: this.questionOrder.map((id) => toTeacherQuestion(this.session, this.questions.get(id)!)),
      participants: [...this.participants.values()].map(toParticipantDTO),
      submissions: [...this.subsById.values()].map(toTeacherSubmission),
      scores: board.map((e) => ({
        participantId: e.participantId,
        totalScore: e.score ?? 0,
        correctCount: e.correctCount,
        answeredCount: e.answeredCount,
        rank: e.rank,
      })),
      stats: this.questionOrder.map((id) => this.stats(id)),
      leaderboard: board,
    };
  }

  boardState(): ScoreboardSessionState {
    const s = this.session.settings.scoreboard;
    return {
      ...this.common(),
      role: 'SCOREBOARD',
      participantCount: this.activeParticipantCount(),
      leaderboard: this.holdScores() && this.publishedBoard ? this.publishedBoard : projectBoard(s.visibility, s.visible, this.leaderboard.entries()),
      presentationContent: this.presentationContent(),
    };
  }

  private stats(sqId: string): QuestionStats {
    return computeStats(sqId, this.subsByQuestion.get(sqId)?.values() ?? []);
  }

  /**
   * Score hold. While students may not yet learn whether their answers are correct (reveal policy
   * other than IMMEDIATE and the question/session still open), score changes go to teachers only.
   * Students and the public board receive them when the question closes (SYNCHRONIZED) or the
   * session ends (FREE). Otherwise a live score/rank change would reveal correctness mid-question
   * — and, with answer editing allowed, the correct answer.
   */
  holdScores(): boolean {
    const s = this.session;
    if (s.settings.revealPolicy === 'IMMEDIATE' || s.state === 'FINISHED') return false;
    if (s.settings.progressMode === 'FREE') return s.state === 'ACTIVE' || s.state === 'PAUSED';
    const cur = this.currentQuestion();
    return !!cur && (cur.phase === 'ACTIVE' || cur.phase === 'PREPARE');
  }

  /** Score as last published to the student (live when not holding). */
  private studentScoreView(pid: string, live = !this.holdScores()): ParticipantScoreView | null {
    let raw: PublishedScore | undefined;
    if (live) {
      const sc = this.scores.get(pid);
      if (!sc) return null;
      raw = { totalScore: sc.totalScore, correctCount: sc.correctCount, answeredCount: sc.answeredCount, rank: this.leaderboard.rankOf(pid) };
      this.publishedScores.set(pid, raw);
    } else {
      raw = this.publishedScores.get(pid) ?? { totalScore: 0, correctCount: 0, answeredCount: 0, rank: null };
    }
    const sc = raw;
    const rank = raw.rank;
    const s = this.session.settings.scoreboard;
    const v = projectSelf(s.visibility, s.visible, this.session.resultsReleased, { ...sc, rank });
    if (!v.showScore) return null;
    return {
      participantId: pid,
      totalScore: sc.totalScore,
      correctCount: sc.correctCount,
      answeredCount: sc.answeredCount,
      rank: v.showRank ? rank : null,
    };
  }

  private presentationContent(): PresentationContent | null {
    const pres = this.session.presentation;
    const sq = pres.sessionQuestionId ? this.questions.get(pres.sessionQuestionId) : this.currentQuestion();
    switch (pres.view) {
      case 'WAITING':
      case 'SCOREBOARD':
      case 'RESULTS':
        return { view: pres.view };
      case 'QUESTION':
        return { view: 'QUESTION', question: sq ? toStudentQuestion(this.session, sq) : null };
      case 'SUBMISSION_STATUS': {
        const total = this.activeParticipantCount();
        const submitted = sq
          ? (this.subsByQuestion.get(sq.id)?.size ?? 0)
          : [...this.subsByParticipant.values()].reduce((a, m) => a + m.size, 0);
        return {
          view: 'SUBMISSION_STATUS',
          question: sq ? toStudentQuestion(this.session, sq) : null,
          submissionStatus: { submitted, total: sq ? total : total * this.questionOrder.length },
        };
      }
      case 'ANSWER':
        return {
          view: 'ANSWER',
          question: sq ? toStudentQuestion(this.session, sq) : null,
          reveal: sq && this.questionClosed(sq) ? toReveal(sq) : null,
          stats: sq ? this.stats(sq.id) : null,
        };
    }
  }

  /* ============================================================== joining */

  async joinTeacher(conn: Conn, userId: string, isAdmin: boolean, reqId?: string): Promise<void> {
    return this.run(async () => {
      // authorization: only the owning teacher (or an admin) controls a session
      if (this.session.teacherId !== userId && !isAdmin) throw new AppError('FORBIDDEN', 'not the teacher of this session');
      conn.role = 'TEACHER';
      conn.userId = userId;
      conn.sessionId = this.id;
      this.teachers.add(conn);
      conn.send('SESSION_STATE', this.teacherState(), { reqId });
    });
  }

  async joinBoard(conn: Conn, reqId?: string): Promise<void> {
    return this.run(async () => {
      conn.role = 'SCOREBOARD';
      conn.sessionId = this.id;
      this.boards.add(conn);
      conn.send('SESSION_STATE', this.boardState(), { reqId });
    });
  }

  async joinStudent(
    conn: Conn,
    req: { nickname?: string; resumeToken?: string; user?: { id: string; name: string } | null },
    reqId?: string,
  ): Promise<void> {
    return this.run(async () => {
      const now = this.now;
      let p: ParticipantRecord | undefined;
      let issuedToken: string | undefined;

      if (req.resumeToken) {
        const pid = this.byResumeHash.get(sha256(req.resumeToken));
        p = pid ? this.participants.get(pid) : undefined;
        if (!p) throw new AppError('INVALID_RESUME_TOKEN', 'unknown resume token');
      } else if (req.user) {
        p = [...this.participants.values()].find((x) => x.userId === req.user!.id);
        if (p) {
          // account holders can resume from another device: rotate the resume token
          issuedToken = randomToken();
          this.byResumeHash.delete(p.resumeTokenHash);
          p.resumeTokenHash = sha256(issuedToken);
          this.byResumeHash.set(p.resumeTokenHash, p.id);
        }
      }

      if (p) {
        if (p.status === 'KICKED') throw new AppError('KICKED', 'you were removed from this session');
        const wasDisconnectedAt = p.disconnectedAt;
        const old = this.students.get(p.id);
        if (old && old !== conn) {
          old.send('ERROR', { code: 'CONFLICT', message: 'session opened on another connection' });
          old.participantId = null;
          old.close(4001, 'replaced by a newer connection');
        }
        const next: ParticipantRecord = { ...p, status: 'CONNECTED', lastSeenAt: now, reconnectedAt: now };
        next.disconnectedAt = wasDisconnectedAt;
        await this.deps.store.db.tx((q) => this.deps.store.saveParticipant(q, next));
        this.participants.set(p.id, next);
        this.attachStudent(conn, next.id);
        conn.send('SESSION_STATE', this.studentState(next.id, issuedToken), { reqId });
        this.event('PARTICIPANT_RECONNECT', { type: 'STUDENT', id: next.id });
        this.emit('PARTICIPANT_RECONNECT', { participantId: next.id, participantCount: this.activeParticipantCount() }, { teachers: true });
        this.emit('PARTICIPANT_STATUS', { participantId: next.id, status: 'CONNECTED' }, { teachers: true });
        return;
      }

      // ---- new participant
      await checkNewStudentAdmission({ state: this.session.state, settings: this.session.settings, participantCount: this.activeParticipantCount() }, req.user, (classroomId, userId) => this.deps.classrooms.isMember(classroomId, userId));
      const st = this.session.settings.join;

      const nickname = sanitizeNickname(req.nickname ?? req.user?.name ?? '');
      const key = nicknameKey(nickname);
      if (!st.allowDuplicateNicknames) {
        for (const x of this.participants.values()) {
          if (x.status !== 'KICKED' && x.nicknameKey === key) throw new AppError('NICKNAME_TAKEN', 'nickname already in use');
        }
      }
      const token = randomToken();
      const rec: ParticipantRecord = {
        id: newId('p', 6),
        sessionId: this.id,
        userId: req.user?.id ?? null,
        nickname,
        nicknameKey: key,
        isGuest: !req.user,
        status: 'CONNECTED',
        resumeTokenHash: sha256(token),
        joinedAt: now,
        lastSeenAt: now,
        disconnectedAt: null,
        currentSqId: null,
        progress: {},
        clockSync: {},
        reconnectedAt: now,
        lastClientTimestamp: null,
      };
      const ev = this.event('PARTICIPANT_JOIN', { type: 'STUDENT', id: rec.id }, { nickname, isGuest: rec.isGuest, ip: conn.ip });
      try {
        await this.deps.store.db.tx(async (q) => {
          await this.deps.store.insertParticipant(q, rec, conn.ip);
          await this.deps.store.appendEvents(q, this.id, [ev]);
        });
      } catch (e) {
        if (isUniqueViolation(e)) throw new AppError('CONFLICT', 'already joined with this account');
        throw e;
      }
      this.participants.set(rec.id, rec);
      this.byResumeHash.set(rec.resumeTokenHash, rec.id);
      this.scores.set(rec.id, this.computeScore(rec.id));
      this.attachStudent(conn, rec.id);
      const changes = this.leaderboard.upsert(this.rankRow(rec.id));
      conn.send('SESSION_STATE', this.studentState(rec.id, token), { reqId });
      const count = this.activeParticipantCount();
      this.emit('PARTICIPANT_JOIN', { participant: toParticipantDTO(rec), participantCount: count }, { teachers: true, boards: true });
      this.publishLeaderboardChanges(changes);
    });
  }

  /** Read-only preflight; actual joining still checks admission inside its serialized mutation. */
  async checkStudentAdmission(user?: { id: string } | null): Promise<void> {
    return this.run(async () => {
      const existing = user ? [...this.participants.values()].find((p) => p.userId === user.id) : undefined;
      await checkStudentAdmission({ state: this.session.state, settings: this.session.settings, participantCount: this.activeParticipantCount(), accountStatus: existing?.status }, user, (classroomId, userId) => this.deps.classrooms.isMember(classroomId, userId));
    });
  }

  private attachStudent(conn: Conn, pid: string): void {
    conn.role = 'STUDENT';
    conn.participantId = pid;
    conn.sessionId = this.id;
    this.students.set(pid, conn);
  }

  /** Socket closed (network loss, tab closed). The participant is kept; only the status changes. */
  onDisconnect(conn: Conn): void {
    this.teachers.delete(conn);
    this.boards.delete(conn);
    const pid = conn.participantId;
    if (!pid || this.students.get(pid) !== conn) return;
    this.students.delete(pid);
    void this.run(async () => {
      const p = this.participants.get(pid);
      if (!p || p.status === 'KICKED' || p.status === 'LEFT' || this.students.has(pid)) return;
      const next: ParticipantRecord = { ...p, status: 'DISCONNECTED', disconnectedAt: this.now };
      await this.deps.store.db.tx((q) => this.deps.store.saveParticipant(q, next));
      this.participants.set(pid, next);
      this.emit('PARTICIPANT_STATUS', { participantId: pid, status: 'DISCONNECTED' }, { teachers: true });
    }).catch((e) => this.deps.log.warn({ err: String(e), pid }, 'disconnect bookkeeping failed'));
  }

  async leave(conn: Conn, reqId?: string): Promise<void> {
    return this.run(async () => {
      const pid = conn.participantId;
      this.teachers.delete(conn);
      this.boards.delete(conn);
      if (!pid) return void conn.send('ACK', { ok: true }, { reqId });
      const p = this.participants.get(pid)!;
      const next: ParticipantRecord = { ...p, status: 'LEFT', disconnectedAt: this.now };
      const ev = this.event('PARTICIPANT_LEAVE', { type: 'STUDENT', id: pid });
      await this.deps.store.db.tx(async (q) => {
        await this.deps.store.saveParticipant(q, next);
        await this.deps.store.appendEvents(q, this.id, [ev]);
      });
      this.participants.set(pid, next);
      if (this.students.get(pid) === conn) this.students.delete(pid);
      conn.send('ACK', { ok: true }, { reqId });
      this.emit('PARTICIPANT_LEAVE', { participantId: pid, status: 'LEFT', participantCount: this.activeParticipantCount() }, { teachers: true, boards: true });
    });
  }

  resendSnapshot(conn: Conn, reqId?: string): void {
    if (conn.role === 'TEACHER') conn.send('SESSION_STATE', this.teacherState(), { reqId });
    else if (conn.role === 'SCOREBOARD') conn.send('SESSION_STATE', this.boardState(), { reqId });
    else if (conn.participantId) conn.send('SESSION_STATE', this.studentState(conn.participantId), { reqId });
  }

  /* ============================================================== time sync */

  /**
   * TIME_SYNC is answered immediately (not queued behind other commands) so the server hold time
   * t2 − t1 stays ~0. It only touches this participant's in-memory clock state; persistence is
   * batched by the flush timer.
   */
  handleTimeSync(conn: Conn, req: ClientPayload<'TIME_SYNC_REQUEST'>, receivedAt: number, reqId?: string): void {
    const pid = conn.participantId;
    let accepted = false;
    if (pid) {
      const p = this.participants.get(pid);
      if (p) {
        const { state, outcome } = applyTimeSync(p.clockSync[req.clockEpochId], req, receivedAt);
        p.clockSync = { ...p.clockSync, [req.clockEpochId]: state };
        p.lastSeenAt = receivedAt;
        accepted = outcome === 'ACCEPTED' || outcome === 'CONFIRMED';
        if (outcome === 'INCONSISTENT' || outcome === 'OFFSET_JUMP') {
          this.deps.log.warn({ pid, outcome, epoch: req.clockEpochId }, 'time sync anomaly');
        }
        this.clockDirty.add(pid);
        const pending = state.pending!;
        pending.t2 = this.now;
        conn.send('TIME_SYNC_RESPONSE', {
          seq: req.seq,
          clientMono: req.clientMono,
          serverReceivedAt: pending.t1,
          serverSentAt: pending.t2,
          accepted,
        }, { reqId });
        return;
      }
    }
    // teachers / boards only need an estimate for countdown rendering
    conn.send('TIME_SYNC_RESPONSE', {
      seq: req.seq,
      clientMono: req.clientMono,
      serverReceivedAt: receivedAt,
      serverSentAt: this.now,
      accepted,
    }, { reqId });
  }

  private async flushClockSync(): Promise<void> {
    const ids = [...this.clockDirty];
    this.clockDirty.clear();
    for (const pid of ids) {
      const p = this.participants.get(pid);
      if (p) await this.deps.store.saveClockSync(p).catch(() => this.clockDirty.add(pid));
    }
  }

  /* ============================================================== session control (teacher) */

  private assertSessionTransition(to: SessionState): void {
    if (!canTransitionSession(this.session.state, to)) {
      throw new AppError('INVALID_TRANSITION', `cannot go from ${this.session.state} to ${to}`);
    }
  }

  async openLobby(actor: Actor): Promise<void> {
    return this.run(async () => {
      this.assertSessionTransition('LOBBY');
      const s = { ...clone(this.session), state: 'LOBBY' as const };
      await this.commit({ session: s, events: [this.event('SESSION_LOBBY', actor)] });
      this.broadcastStateChange('SESSION_STATE_CHANGE');
    });
  }

  async setReady(actor: Actor, ready: boolean): Promise<void> {
    return this.run(async () => {
      const to = ready ? 'READY' : 'LOBBY';
      this.assertSessionTransition(to);
      const s = { ...clone(this.session), state: to as SessionState };
      await this.commit({ session: s, events: [this.event(ready ? 'SESSION_READY' : 'SESSION_LOBBY', actor)] });
      this.broadcastStateChange('SESSION_STATE_CHANGE');
    });
  }

  async startSession(actor: Actor): Promise<void> {
    return this.run(async () => {
      // the ACTIVE edge is shared with resume: a command is valid only from its own source states
      if (this.session.state !== 'LOBBY' && this.session.state !== 'READY') {
        throw new AppError('INVALID_TRANSITION', `cannot start from ${this.session.state}`);
      }
      this.assertSessionTransition('ACTIVE');
      if (this.questionOrder.length === 0) throw new AppError('BAD_REQUEST', 'session has no questions');
      const now = this.now;
      const s = clone(this.session);
      s.state = 'ACTIVE';
      s.startedAt = now;
      const limit = s.settings.timing.sessionTimeLimitSec;
      s.deadlineAt = limit ? now + limit * 1000 : null;
      if (s.settings.progressMode === 'FREE') s.presentation = { view: 'SUBMISSION_STATUS', sessionQuestionId: null };
      await this.commit({ session: s, events: [this.event('SESSION_START', actor, { deadlineAt: s.deadlineAt })] });
      this.scheduleTimers();
      this.broadcastStateChange('SESSION_START');
      if (s.settings.progressMode === 'FREE') {
        // FREE progress: every question becomes visible at once
        this.emitStudentsEach('SESSION_STATE', (pid) => this.studentState(pid));
      }
      this.emitPresentation();
    });
  }

  async pauseSession(actor: Actor): Promise<void> {
    return this.run(async () => {
      this.assertSessionTransition('PAUSED');
      const now = this.now;
      const s = clone(this.session);
      s.state = 'PAUSED';
      s.pauses = [...s.pauses, { pausedAt: now, resumedAt: null }];
      const qs: SessionQuestionRecord[] = [];
      const cur = this.currentQuestion();
      if (cur && (cur.phase === 'ACTIVE' || cur.phase === 'PREPARE')) {
        qs.push({ ...clone(cur), pauses: [...cur.pauses, { pausedAt: now, resumedAt: null }] });
      }
      await this.commit({ session: s, questions: qs, events: [this.event('SESSION_PAUSE', actor)] });
      this.scheduleTimers();
      this.broadcastStateChange('SESSION_PAUSE');
    });
  }

  async resumeSession(actor: Actor): Promise<void> {
    return this.run(async () => {
      if (this.session.state !== 'PAUSED') throw new AppError('INVALID_TRANSITION', `cannot resume from ${this.session.state}`);
      this.assertSessionTransition('ACTIVE');
      const now = this.now;
      const s = clone(this.session);
      const open = s.pauses[s.pauses.length - 1];
      const pausedFor = open && open.resumedAt === null ? now - open.pausedAt : 0;
      if (open && open.resumedAt === null) open.resumedAt = now;
      s.state = 'ACTIVE';
      // the clock stops while paused: extend deadlines by the pause duration
      if (s.deadlineAt !== null) s.deadlineAt += pausedFor;
      const qs: SessionQuestionRecord[] = [];
      const cur = this.currentQuestion();
      if (cur && (cur.phase === 'ACTIVE' || cur.phase === 'PREPARE')) {
        const q = clone(cur);
        const qp = q.pauses[q.pauses.length - 1];
        if (qp && qp.resumedAt === null) qp.resumedAt = now;
        if (q.deadlineAt !== null) q.deadlineAt += pausedFor;
        if (q.opensAt !== null && q.phase === 'PREPARE') q.opensAt += pausedFor;
        qs.push(q);
      }
      await this.commit({ session: s, questions: qs, events: [this.event('SESSION_RESUME', actor, { pausedFor })] });
      this.scheduleTimers();
      this.broadcastStateChange('SESSION_RESUME');
    });
  }

  async endSession(actor: Actor, at?: number): Promise<void> {
    return this.run(() => this.finish(actor, at ?? this.now));
  }

  private async finish(actor: Actor, at: number): Promise<void> {
    if (this.session.state === 'FINISHED') return;
    this.assertSessionTransition('FINISHED');
    const s = clone(this.session);
    const open = s.pauses[s.pauses.length - 1];
    if (open && open.resumedAt === null) open.resumedAt = at;
    s.state = 'FINISHED';
    s.lockedAt = at;
    s.finishedAt = at;
    if (s.settings.releaseResultsOnEnd) s.resultsReleased = true;
    s.presentation = { view: 'RESULTS', sessionQuestionId: null };
    const qs: SessionQuestionRecord[] = [];
    const cur = this.currentQuestion();
    if (cur && (cur.phase === 'ACTIVE' || cur.phase === 'PREPARE')) {
      const q = clone(cur);
      if (q.phase === 'PREPARE') {
        q.phase = 'PENDING';
        q.opensAt = null;
      } else {
        q.phase = 'LOCKED';
        q.lockedAt = at;
      }
      qs.push(q);
    }
    const entries = this.leaderboard.entries();
    await this.commit({
      session: s,
      questions: qs,
      events: [this.event('SESSION_END', actor, { at })],
      extra: (q) =>
        q
          .query(
            'INSERT INTO leaderboard_snapshots (session_id, version, reason, entries, taken_at_ms) VALUES ($1,$2,$3,$4,$5)',
            [this.id, this.leaderboard.version, 'SESSION_END', JSON.stringify(entries), at],
          )
          .then(() => undefined),
    });
    this.scheduleTimers();
    this.emit('SESSION_LOCKED', { at }, { teachers: true, boards: true, students: true });
    if (qs[0]?.phase === 'LOCKED') this.emit('QUESTION_END', { sessionQuestionId: qs[0].id, lockedAt: at }, { teachers: true, boards: true, students: true });
    this.broadcastStateChange('SESSION_END');
    if (s.resultsReleased) this.sendResultsToStudents();
    this.sendSnapshotNow();
    this.sendScoreViews();
    this.emitPresentation();
  }

  async releaseResults(actor: Actor): Promise<void> {
    return this.run(async () => {
      if (this.session.state !== 'FINISHED') throw new AppError('INVALID_TRANSITION', 'results can be released after the session ends');
      if (this.session.resultsReleased) return;
      const s = { ...clone(this.session), resultsReleased: true };
      await this.commit({ session: s, events: [this.event('RESULTS_RELEASED', actor)] });
      this.sendResultsToStudents();
      this.emitStudentsEach('SCORE_UPDATE', (pid) => {
        const v = this.studentScoreView(pid);
        return v ? { scores: [v] } : null;
      });
      for (const c of this.teachers) c.send('SESSION_STATE', this.teacherState());
    });
  }

  private sendResultsToStudents(): void {
    this.emitStudentsEach('RESULTS_RELEASED', (pid) => {
      const subs = [...(this.subsByParticipant.get(pid)?.values() ?? [])];
      const reveals: QuestionReveal[] = this.questionOrder
        .map((id) => this.questions.get(id)!)
        .filter((q) => this.canSeeAnswerKey(q))
        .map(toReveal);
      return {
        reveals,
        submissions: subs.map((s) => toOwnSubmission(s, this.canSeeGrade(this.questions.get(s.sessionQuestionId)!))),
      };
    });
  }

  private broadcastStateChange(type: 'SESSION_STATE_CHANGE' | 'SESSION_START' | 'SESSION_PAUSE' | 'SESSION_RESUME' | 'SESSION_END'): void {
    const payload = { state: this.session.state, timing: this.sessionTiming(), at: this.now };
    if (type === 'SESSION_RESUME') {
      this.emit(type, { ...payload, questionDeadlineAt: this.currentQuestion()?.deadlineAt ?? null }, { teachers: true, boards: true, students: true });
    } else {
      this.emit(type, payload, { teachers: true, boards: true, students: true });
    }
  }

  async extendTime(actor: Actor, seconds: number): Promise<void> {
    return this.run(async () => {
      if (this.session.state !== 'ACTIVE' && this.session.state !== 'PAUSED') throw new AppError('INVALID_TRANSITION', 'session not running');
      const now = this.now;
      const delta = seconds * 1000;
      const s = clone(this.session);
      const qs: SessionQuestionRecord[] = [];
      const cur = this.currentQuestion();
      if (s.settings.progressMode === 'SYNCHRONIZED' && cur && cur.phase === 'ACTIVE' && cur.deadlineAt !== null) {
        const q = clone(cur);
        q.deadlineAt = Math.max(now + 1000, q.deadlineAt! + delta);
        qs.push(q);
      } else if (s.deadlineAt !== null) {
        s.deadlineAt = Math.max(now + 1000, s.deadlineAt + delta);
      } else {
        throw new AppError('BAD_REQUEST', 'there is no running deadline to extend');
      }
      await this.commit({ session: s, questions: qs, events: [this.event('TIME_EXTENDED', actor, { seconds })] });
      this.scheduleTimers();
      const c = this.currentQuestion();
      this.emit(
        'DEADLINE_UPDATE',
        { sessionDeadlineAt: this.session.deadlineAt, sessionQuestionId: c?.id ?? null, questionDeadlineAt: c?.deadlineAt ?? null },
        { teachers: true, boards: true, students: true },
      );
    });
  }

  /* ============================================================== question control (SYNCHRONIZED) */

  async startQuestion(actor: Actor, p: ClientPayload<'TEACHER_START_QUESTION'>): Promise<void> {
    return this.run(async () => {
      if (this.session.settings.progressMode !== 'SYNCHRONIZED') {
        throw new AppError('BAD_REQUEST', 'question control is only available in SYNCHRONIZED mode');
      }
      if (this.session.state !== 'ACTIVE') throw new AppError('INVALID_TRANSITION', 'session must be ACTIVE');
      const sq = this.requireQuestion(p.sessionQuestionId);
      if (sq.phase !== 'PENDING') throw new AppError('INVALID_TRANSITION', `question is already ${sq.phase}`);
      const now = this.now;
      const qs: SessionQuestionRecord[] = [];
      const events: SessionEventRecord[] = [];
      // starting the next question closes the current one
      const cur = this.currentQuestion();
      let lockedPrev: SessionQuestionRecord | null = null;
      if (cur && cur.id !== sq.id && (cur.phase === 'ACTIVE' || cur.phase === 'PREPARE')) {
        lockedPrev = clone(cur);
        if (cur.phase === 'ACTIVE') {
          lockedPrev.phase = 'LOCKED';
          lockedPrev.lockedAt = now;
        } else {
          lockedPrev.phase = 'PENDING';
          lockedPrev.opensAt = null;
        }
        qs.push(lockedPrev);
        events.push(this.event('QUESTION_END', actor, { sessionQuestionId: cur.id, auto: true }));
      }
      const countdown = p.countdownSec ?? this.session.settings.timing.prepareCountdownSec;
      const limit =
        p.timeLimitSec !== undefined ? p.timeLimitSec : (sq.timeLimitSec ?? this.session.settings.timing.defaultQuestionTimeLimitSec);
      const next = clone(sq);
      next.timeLimitSec = limit && limit > 0 ? limit : null;
      next.pauses = [];
      const s = clone(this.session);
      s.currentSqId = sq.id;
      s.presentation = { view: 'QUESTION', sessionQuestionId: sq.id };
      if (countdown > 0) {
        next.phase = 'PREPARE';
        next.opensAt = now + countdown * 1000;
        events.push(this.event('QUESTION_PREPARE', actor, { sessionQuestionId: sq.id, opensAt: next.opensAt }));
      } else {
        this.activate(next, now);
        events.push(this.event('QUESTION_START', actor, { sessionQuestionId: sq.id, deadlineAt: next.deadlineAt }));
      }
      qs.push(next);
      await this.commit({ session: s, questions: qs, events });
      this.scheduleTimers();
      if (lockedPrev?.phase === 'LOCKED') this.announceQuestionEnd(lockedPrev);
      if (next.phase === 'PREPARE') {
        this.emit('QUESTION_PREPARE', { sessionQuestionId: next.id, opensAt: next.opensAt! }, { teachers: true, boards: true, students: true });
      } else this.announceQuestionStart(next);
      this.emitPresentation();
    });
  }

  private activate(q: SessionQuestionRecord, now: number): void {
    q.phase = 'ACTIVE';
    q.startedAt = now;
    q.deadlineAt = q.timeLimitSec ? now + q.timeLimitSec * 1000 : null;
    q.lockedAt = null;
  }

  private async openPrepared(sqId: string): Promise<void> {
    const sq = this.questions.get(sqId);
    if (!sq || sq.phase !== 'PREPARE' || this.session.state !== 'ACTIVE') return;
    const next = clone(sq);
    this.activate(next, this.now);
    await this.commit({ questions: [next], events: [this.event('QUESTION_START', { type: 'SYSTEM', id: null }, { sessionQuestionId: sqId })] });
    this.scheduleTimers();
    this.announceQuestionStart(next);
  }

  private announceQuestionStart(q: SessionQuestionRecord): void {
    const payload = { sessionQuestionId: q.id, startedAt: q.startedAt!, deadlineAt: q.deadlineAt };
    const view = toStudentQuestion(this.session, q);
    this.emit('QUESTION_START', { ...payload, question: view }, { teachers: true, boards: true, students: true });
  }

  private announceQuestionEnd(q: SessionQuestionRecord): void {
    this.emit('QUESTION_END', { sessionQuestionId: q.id, lockedAt: q.lockedAt! }, { teachers: true, boards: true, students: true });
    // AFTER_QUESTION: students now learn their own grade for this question
    if (this.canSeeGrade(q)) {
      this.emitStudentsEach('SUBMISSION_GRADED', (pid) => {
        const s = this.subsByParticipant.get(pid)?.get(q.id);
        return s ? { submission: toOwnSubmission(s, true) } : null;
      });
    }
    this.sendScoreViews();
    this.sendSnapshotNow();
  }

  async endQuestion(actor: Actor, sqId: string, at?: number): Promise<void> {
    return this.run(() => this.lockQuestion(actor, sqId, at ?? this.now));
  }

  private async lockQuestion(actor: Actor, sqId: string, at: number): Promise<void> {
    const sq = this.requireQuestion(sqId);
    if (sq.phase === 'PREPARE') {
      const q = { ...clone(sq), phase: 'PENDING' as const, opensAt: null };
      await this.commit({ questions: [q], events: [this.event('QUESTION_CANCELLED', actor, { sessionQuestionId: sqId })] });
      this.scheduleTimers();
      this.emit('QUESTION_END', { sessionQuestionId: sqId, lockedAt: at }, { teachers: true, boards: true, students: true });
      return;
    }
    if (!canTransitionQuestion(sq.phase, 'LOCKED')) throw new AppError('INVALID_TRANSITION', `question is ${sq.phase}`);
    const q = { ...clone(sq), phase: 'LOCKED' as const, lockedAt: at };
    await this.commit({ questions: [q], events: [this.event('QUESTION_END', actor, { sessionQuestionId: sqId, at })] });
    this.scheduleTimers();
    this.announceQuestionEnd(q);
    void this.persistLeaderboard('QUESTION_END');
  }

  async showResult(actor: Actor, sqId: string): Promise<void> {
    return this.run(async () => {
      let sq = this.requireQuestion(sqId);
      if (sq.phase === 'ACTIVE') {
        await this.lockQuestion(actor, sqId, this.now);
        sq = this.questions.get(sqId)!;
      }
      if (!canTransitionQuestion(sq.phase, 'RESULT')) throw new AppError('INVALID_TRANSITION', `question is ${sq.phase}`);
      const q = { ...clone(sq), phase: 'RESULT' as const };
      const s = { ...clone(this.session), presentation: { view: 'ANSWER' as const, sessionQuestionId: sqId } };
      await this.commit({ session: s, questions: [q], events: [this.event('QUESTION_RESULT', actor, { sessionQuestionId: sqId })] });
      const stats = this.stats(sqId);
      this.emit('QUESTION_RESULT', { sessionQuestionId: sqId, reveal: toReveal(q), stats }, { teachers: true, boards: true });
      this.emitStudentsEach('QUESTION_RESULT', () => ({
        sessionQuestionId: sqId,
        reveal: this.canSeeAnswerKey(q) ? toReveal(q) : null,
        stats: null,
      }));
      this.emitPresentation();
    });
  }

  /* ============================================================== participants & board (teacher) */

  async kick(actor: Actor, participantId: string, reason?: string): Promise<void> {
    return this.run(async () => {
      const p = this.participants.get(participantId);
      if (!p) throw new AppError('NOT_FOUND', 'participant not found');
      if (p.status === 'KICKED') return;
      const next: ParticipantRecord = { ...p, status: 'KICKED', disconnectedAt: this.now };
      const ev = this.event('PARTICIPANT_KICKED', actor, { participantId, reason: reason ?? null });
      await this.deps.store.db.tx(async (q) => {
        await this.deps.store.saveParticipant(q, next);
        await this.deps.store.appendEvents(q, this.id, [ev]);
      });
      this.participants.set(participantId, next);
      const conn = this.students.get(participantId);
      if (conn) {
        conn.send('KICKED', { reason: reason ?? null });
        this.students.delete(participantId);
        conn.participantId = null;
        conn.close(4003, 'kicked');
      }
      const changes = this.leaderboard.remove(participantId);
      this.emit('PARTICIPANT_LEAVE', { participantId, status: 'KICKED', participantCount: this.activeParticipantCount() }, { teachers: true, boards: true });
      this.publishLeaderboardChanges(changes, [participantId]);
    });
  }

  async setScoreboard(actor: Actor, p: ClientPayload<'TEACHER_SET_SCOREBOARD'>): Promise<void> {
    return this.run(async () => {
      const s = clone(this.session);
      if (p.visibility) s.settings.scoreboard.visibility = p.visibility;
      if (p.visible !== undefined) s.settings.scoreboard.visible = p.visible;
      await this.commit({ session: s, events: [this.event('SCOREBOARD_SETTINGS', actor, { ...s.settings.scoreboard })] });
      this.emit('SCOREBOARD_SETTINGS', { ...s.settings.scoreboard }, { teachers: true, boards: true, students: true });
      this.sendSnapshotNow();
      this.sendScoreViews();
    });
  }

  async setPresentation(actor: Actor, p: ClientPayload<'TEACHER_SET_PRESENTATION'>): Promise<void> {
    return this.run(async () => {
      const sqId = p.sessionQuestionId ?? null;
      const sq = sqId ? this.requireQuestion(sqId) : this.currentQuestion();
      if (p.view === 'ANSWER' && (!sq || !this.questionClosed(sq))) {
        // never project an answer key while students can still answer
        throw new AppError('INVALID_TRANSITION', 'the answer can be shown after the question is closed');
      }
      if (p.view === 'QUESTION' && sq && this.session.settings.progressMode === 'SYNCHRONIZED' && sq.phase === 'PENDING') {
        throw new AppError('INVALID_TRANSITION', 'question has not started yet');
      }
      const s = { ...clone(this.session), presentation: { view: p.view, sessionQuestionId: sqId } };
      await this.commit({ session: s, events: [this.event('PRESENTATION', actor, { view: p.view, sessionQuestionId: sqId })] });
      this.emitPresentation();
    });
  }

  private emitPresentation(): void {
    this.emit(
      'PRESENTATION_UPDATE',
      { view: this.session.presentation.view, sessionQuestionId: this.session.presentation.sessionQuestionId, content: this.presentationContent() },
      { teachers: true, boards: true },
    );
  }

  /* ============================================================== grading (teacher) */

  async setManualScore(actor: Actor, p: ClientPayload<'TEACHER_SCORE_UPDATE'>): Promise<void> {
    return this.run(async () => {
      const sub = this.subsById.get(p.submissionId);
      if (!sub) throw new AppError('NOT_FOUND', 'submission not found');
      const sq = this.questions.get(sub.sessionQuestionId)!;
      const max = maxAssignableScore(this.session.settings.scoringMode, sq.maxScore);
      if (p.score > max) throw new AppError('BAD_REQUEST', `score must be between 0 and ${max}`);
      const now = this.now;
      const next: SubmissionRecord = {
        ...sub,
        manualScore: round2(p.score),
        finalScore: round2(p.score),
        isCorrect: isFullMarks(this.session.settings.scoringMode, p.score, sq.maxScore),
        gradingStatus: 'MANUALLY_GRADED',
        feedback: p.feedback ?? sub.feedback,
        gradedBy: actor.id,
        gradedAt: now,
      };
      const score = this.computeScoreWith(sub.participantId, next);
      const ev = this.event('SCORE_OVERRIDE', actor, {
        submissionId: sub.id,
        participantId: sub.participantId,
        from: sub.finalScore,
        to: next.finalScore,
      });
      await this.deps.store.db.tx(async (q) => {
        await this.deps.store.upsertSubmission(q, next, false, sub.revision);
        await this.deps.store.saveScore(q, this.id, score);
        await this.deps.store.appendEvents(q, this.id, [ev]);
      });
      this.indexSubmission(next);
      this.scores.set(sub.participantId, score);
      const changes = this.leaderboard.upsert(this.rankRow(sub.participantId));
      this.emit('SUBMISSION_RECEIVED', { submission: toTeacherSubmission(next), stats: this.stats(sq.id) }, { teachers: true });
      if (this.canSeeGrade(sq)) this.emit('SUBMISSION_GRADED', { submission: toOwnSubmission(next, true) }, { students: [sub.participantId] });
      this.publishLeaderboardChanges(changes);
    });
  }

  private computeScoreWith(pid: string, replacement: SubmissionRecord): ScoreRecord {
    const m = this.subsByParticipant.get(pid) ?? new Map<string, SubmissionRecord>();
    const saved = m.get(replacement.sessionQuestionId);
    m.set(replacement.sessionQuestionId, replacement);
    this.subsByParticipant.set(pid, m);
    try {
      return this.computeScore(pid);
    } finally {
      if (saved) m.set(replacement.sessionQuestionId, saved);
      else m.delete(replacement.sessionQuestionId);
    }
  }

  /* ============================================================== student actions */

  async selectQuestion(conn: Conn, sqId: string, reqId?: string): Promise<void> {
    return this.run(async () => {
      const pid = conn.participantId;
      if (!pid) throw new AppError('NOT_JOINED', 'join the session first');
      if (this.session.settings.progressMode !== 'FREE') throw new AppError('BAD_REQUEST', 'only in FREE progress mode');
      this.requireQuestion(sqId);
      const p = this.participants.get(pid)!;
      if (p.currentSqId === sqId) return void conn.send('ACK', { ok: true }, { reqId });
      const progress = { ...p.progress, finalized: [...(p.progress.finalized ?? [])] };
      // UNTIL_QUESTION_END in FREE progress: leaving an answered question finalizes it
      if (this.session.settings.editPolicy === 'UNTIL_QUESTION_END' && p.currentSqId) {
        const answered = this.subsByParticipant.get(pid)?.has(p.currentSqId);
        if (answered && !progress.finalized.includes(p.currentSqId)) progress.finalized.push(p.currentSqId);
      }
      const next: ParticipantRecord = { ...p, currentSqId: sqId, progress, lastSeenAt: this.now };
      await this.deps.store.db.tx((q) => this.deps.store.saveParticipant(q, next));
      this.participants.set(pid, next);
      conn.send('ACK', { ok: true, result: { finalized: progress.finalized } }, { reqId });
      this.emit('PARTICIPANT_STATUS', { participantId: pid, status: next.status, currentSessionQuestionId: sqId }, { teachers: true });
    });
  }

  /**
   * SUBMIT_ANSWER / UPDATE_ANSWER.
   * `receivedAt` is stamped by the socket layer when the frame arrived (before queueing), so time
   * spent waiting in this session's command queue never counts against the student.
   */
  async submit(conn: Conn, p: SubmitAnswerPayload, isUpdate: boolean, receivedAt: number, reqId?: string): Promise<void> {
    return this.run(async () => {
      try {
        await this.doSubmit(conn, p, isUpdate, receivedAt, reqId);
      } catch (e) {
        const err = e instanceof AppError ? e : new AppError('INTERNAL', 'submission failed');
        if (!(e instanceof AppError)) this.deps.log.error({ err: String(e), stack: (e as Error)?.stack }, 'submit failed');
        conn.send(
          'ANSWER_REJECTED',
          { sessionQuestionId: p.sessionQuestionId, idempotencyKey: p.idempotencyKey, code: err.code, message: err.message },
          { reqId },
        );
      }
    });
  }

  private async doSubmit(conn: Conn, p: SubmitAnswerPayload, isUpdate: boolean, receivedAt: number, reqId?: string): Promise<void> {
    const pid = conn.participantId;
    if (!pid || conn.role !== 'STUDENT') throw new AppError('NOT_JOINED', 'join the session as a student first');
    const participant = this.participants.get(pid)!;
    if (participant.status === 'KICKED') throw new AppError('KICKED', 'removed from session');
    const sq = this.requireQuestion(p.sessionQuestionId);
    const existing = this.subsByParticipant.get(pid)?.get(sq.id);

    // 1. idempotency: a retry of an already-applied action returns the stored result
    const prior = this.idemMap(pid).get(p.idempotencyKey);
    if (prior) {
      const cur = this.subsById.get(prior.submissionId)!;
      const view = toOwnSubmission(cur, this.canSeeGrade(sq));
      conn.send(prior.revision === 1 ? 'ANSWER_ACCEPTED' : 'ANSWER_UPDATED', { submission: view, duplicate: true, idempotencyKey: p.idempotencyKey }, { reqId });
      return;
    }

    // 2. which window governs this question?
    const settings = this.session.settings;
    const st = this.session.state;
    if (st === 'CREATED' || st === 'LOBBY' || st === 'READY') throw new AppError('QUESTION_NOT_ACTIVE', 'session has not started');
    let window: SubmissionWindow;
    let windowStart: number | null;
    let closedCode: 'SUBMISSION_CLOSED' | 'SESSION_LOCKED';
    if (settings.progressMode === 'SYNCHRONIZED') {
      if (sq.phase === 'PENDING' || sq.phase === 'PREPARE') throw new AppError('QUESTION_NOT_ACTIVE', 'question is not open');
      window = {
        startedAt: sq.startedAt,
        deadlineAt: sq.deadlineAt,
        lockedAt: [sq.lockedAt, this.session.lockedAt].filter((x): x is number => x !== null).reduce<number | null>((a, b) => (a === null ? b : Math.min(a, b)), null),
        // session.pauses is a superset of the question's pauses (a pause is recorded on both)
        pauses: this.session.pauses,
      };
      windowStart = sq.startedAt;
      closedCode = this.session.lockedAt !== null ? 'SESSION_LOCKED' : 'SUBMISSION_CLOSED';
    } else {
      window = { startedAt: this.session.startedAt, deadlineAt: this.session.deadlineAt, lockedAt: this.session.lockedAt, pauses: this.session.pauses };
      windowStart = this.session.startedAt;
      closedCode = 'SESSION_LOCKED';
    }

    // 3. timestamp trust
    const decision = evaluateTimestamp(
      {
        serverReceivedAt: receivedAt,
        clientSentAt: p.clientSentAt,
        clientMonoAt: p.clientMonoAt,
        sync: participant.clockSync[p.clockEpochId] as ClockSyncState | undefined,
        windowStartAt: windowStart,
        lastClientTimestamp: participant.lastClientTimestamp,
        replay: !!p.replay,
        disconnectedAt: participant.disconnectedAt,
        reconnectedAt: participant.reconnectedAt,
      },
      { ...this.deps.config.trust, offlineReplayWindowMs: settings.timing.offlineReplayWindowMs },
    );

    // 4. server deadline always wins
    assertInsideWindow({
      window,
      effectiveAt: decision.effectiveSubmittedAt,
      receivedAt,
      trusted: decision.source === 'CLIENT_TRUSTED',
      verifiedReplay: decision.reason === 'OFFLINE_REPLAY_VERIFIED',
      lateGraceMs: settings.timing.lateGraceMs,
      closedCode,
    });

    // 5. edit policy
    if (existing) {
      if (isUpdate && p.baseRevision !== existing.revision) {
        throw new AppError('STALE_REVISION', `answer was changed elsewhere (current revision ${existing.revision})`);
      }
      this.assertEditable(pid, sq, existing);
    } else if (isUpdate) {
      throw new AppError('NOT_FOUND', 'nothing to update: submit first');
    }

    // 6. grade (server-side only) & score
    const g = grade(sq.snapshot, p.answer);
    const responseMs = windowStart !== null ? activeDuration(windowStart, decision.effectiveSubmittedAt, window.pauses) : null;
    const auto = computeAutoScore({
      mode: settings.scoringMode,
      ratio: g.ratio,
      isCorrect: g.isCorrect,
      maxScore: sq.maxScore,
      responseMs,
      timeLimitSec: sq.timeLimitSec,
      speed: settings.speed,
    });
    const rec: SubmissionRecord = {
      id: existing?.id ?? newId('sub', 8),
      sessionId: this.id,
      participantId: pid,
      sessionQuestionId: sq.id,
      answer: p.answer,
      normalized: g.normalized,
      revision: (existing?.revision ?? 0) + 1,
      // stored as integer epoch ms (browser clocks report fractional milliseconds)
      clientSentAt: Math.round(p.clientSentAt),
      serverReceivedAt: receivedAt,
      effectiveSubmittedAt: decision.effectiveSubmittedAt,
      timestampSource: decision.source,
      timestampReason: decision.reason,
      responseMs,
      isCorrect: g.isCorrect,
      autoScore: auto,
      // a new answer invalidates a previous manual grade
      manualScore: null,
      finalScore: auto ?? 0,
      gradingStatus: g.needsManual ? 'PENDING_MANUAL' : 'AUTO_GRADED',
      feedback: null,
      gradedBy: null,
      gradedAt: null,
    };
    const score = this.computeScoreWith(pid, rec);
    const ev = this.event(existing ? 'ANSWER_UPDATED' : 'ANSWER_SUBMITTED', { type: 'STUDENT', id: pid }, {
      submissionId: rec.id,
      sessionQuestionId: sq.id,
      revision: rec.revision,
      timestampSource: rec.timestampSource,
      timestampReason: rec.timestampReason,
      diffMs: decision.diffMs,
      replay: !!p.replay,
    });

    // 7. persist atomically: submission + revision history + score + event
    try {
      await this.deps.store.db.tx(async (q) => {
        await this.deps.store.upsertSubmission(q, rec, !existing, existing?.revision ?? null);
        await this.deps.store.insertRevision(q, rec, {
          idempotencyKey: p.idempotencyKey,
          clientMonoAt: p.clientMonoAt,
          clockEpochId: p.clockEpochId,
          isReplay: !!p.replay,
        });
        await this.deps.store.saveScore(q, this.id, score);
        await this.deps.store.appendEvents(q, this.id, [ev]);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('CONFLICT', 'duplicate submission');
      throw e;
    }

    // 8. apply to memory & notify
    this.indexSubmission(rec);
    this.idemMap(pid).set(p.idempotencyKey, { submissionId: rec.id, revision: rec.revision });
    this.scores.set(pid, score);
    if (decision.source === 'CLIENT_TRUSTED') {
      participant.lastClientTimestamp = Math.max(participant.lastClientTimestamp ?? 0, decision.effectiveSubmittedAt);
    }
    const own = toOwnSubmission(rec, this.canSeeGrade(sq));
    conn.send(existing ? 'ANSWER_UPDATED' : 'ANSWER_ACCEPTED', { submission: own, duplicate: false, idempotencyKey: p.idempotencyKey }, { reqId });
    this.emit('SUBMISSION_RECEIVED', { submission: toTeacherSubmission(rec), stats: this.stats(sq.id) }, { teachers: true });
    const changes = this.leaderboard.upsert(this.rankRow(pid));
    this.publishLeaderboardChanges(changes);
    if (this.session.presentation.view === 'SUBMISSION_STATUS') this.emitPresentation();
  }

  private assertEditable(pid: string, sq: SessionQuestionRecord, existing: SubmissionRecord): void {
    const policy = this.session.settings.editPolicy;
    if (policy === 'NO_EDIT') throw new AppError('EDIT_NOT_ALLOWED', 'answers cannot be changed after submitting');
    if (existing.gradingStatus === 'MANUALLY_GRADED' && policy !== 'ALLOW' && policy !== 'UNTIL_SESSION_END') {
      throw new AppError('EDIT_NOT_ALLOWED', 'answer was already graded');
    }
    if (policy === 'UNTIL_QUESTION_END' && this.session.settings.progressMode === 'FREE') {
      const finalized = this.participants.get(pid)!.progress.finalized ?? [];
      if (finalized.includes(sq.id)) throw new AppError('EDIT_NOT_ALLOWED', 'you already moved on from this question');
    }
  }

  /* ============================================================== leaderboard fan-out */

  /**
   * Incremental fan-out: teachers get every change, the public board a projection filtered by the
   * visibility policy, and each affected student a SCORE_UPDATE for themselves only.
   * Large reshuffles fall back to a (throttled) snapshot instead of long change lists.
   */
  private publishLeaderboardChanges(changes: LeaderboardChange[], removed: string[] = []): void {
    if (changes.length === 0 && removed.length === 0) return;
    this.lbDirty = true;
    this.lbPersistDirty = true;
    const total = this.leaderboard.size;
    const version = this.leaderboard.version;
    const big = changes.length > this.deps.config.incrementalMaxChanges;
    if (big) {
      this.sendSnapshotNow();
    } else {
      this.emit('LEADERBOARD_UPDATE', { version, changes, removed, total }, { teachers: true });
    }
    // score hold: students and the public board learn about changes when the question closes
    if (this.holdScores()) return;
    if (!big) {
      const sb = this.session.settings.scoreboard;
      const proj = projectChanges(sb.visibility, sb.visible, changes);
      if (proj === null) this.sendBoardSnapshot();
      else {
        if (proj.changes.length || proj.removed.length || removed.length) {
          this.emit('LEADERBOARD_UPDATE', { version, changes: proj.changes, removed: [...proj.removed, ...removed], total }, { boards: true });
        }
        this.publishedBoard = projectBoard(sb.visibility, sb.visible, this.leaderboard.entries());
      }
    }
    const affected = changes.map((c) => c.participantId).filter((id) => this.students.has(id));
    for (const pid of affected) {
      const v = this.studentScoreView(pid);
      if (v) this.students.get(pid)!.send('SCORE_UPDATE', { scores: [v] }, { seq: this.session.eventSeq });
    }
  }

  private sendScoreViews(): void {
    this.emitStudentsEach('SCORE_UPDATE', (pid) => {
      const v = this.studentScoreView(pid);
      return v ? { scores: [v] } : null;
    });
  }

  private sendBoardSnapshot(): void {
    const sb = this.session.settings.scoreboard;
    const entries =
      this.holdScores() && this.publishedBoard
        ? projectBoard(sb.visibility, sb.visible, this.publishedBoard)
        : projectBoard(sb.visibility, sb.visible, this.leaderboard.entries());
    if (!this.holdScores()) this.publishedBoard = entries;
    this.emit(
      'LEADERBOARD_SNAPSHOT',
      { version: this.leaderboard.version, entries, total: this.leaderboard.size, visibility: sb.visibility, visible: sb.visible },
      { boards: true },
    );
  }

  private sendSnapshotNow(): void {
    const sb = this.session.settings.scoreboard;
    this.emit(
      'LEADERBOARD_SNAPSHOT',
      { version: this.leaderboard.version, entries: this.leaderboard.entries(), total: this.leaderboard.size, visibility: sb.visibility, visible: sb.visible },
      { teachers: true },
    );
    this.sendBoardSnapshot();
    this.lbDirty = false;
  }

  private async persistLeaderboard(reason: string): Promise<void> {
    if (!this.lbPersistDirty && reason === 'PERIODIC') return;
    this.lbPersistDirty = false;
    await this.deps.store
      .saveLeaderboardSnapshot(this.id, this.leaderboard.version, reason, this.leaderboard.entries(), this.now)
      .catch((e) => this.deps.log.warn({ err: String(e) }, 'leaderboard snapshot persist failed'));
  }

  /* ============================================================== timers */

  private scheduleTimers(): void {
    for (const k of ['session', 'question', 'prepare'] as const) {
      this.timers[k]?.cancel();
      delete this.timers[k];
    }
    if (this.disposed || this.session.state !== 'ACTIVE') return;
    const now = this.now;
    const clock = this.deps.clock;
    const sys: Actor = { type: 'SYSTEM', id: null };
    if (this.session.deadlineAt !== null) {
      const at = this.session.deadlineAt;
      this.timers.session = clock.setTimer(() => {
        void this.run(() => (this.session.deadlineAt === at && this.session.state === 'ACTIVE' ? this.finish(sys, at) : undefined)).catch((e) =>
          this.deps.log.error({ err: String(e) }, 'session deadline handling failed'),
        );
      }, at - now);
    }
    const cur = this.currentQuestion();
    if (cur?.phase === 'PREPARE' && cur.opensAt !== null) {
      const id = cur.id;
      this.timers.prepare = clock.setTimer(() => {
        void this.run(() => this.openPrepared(id)).catch((e) => this.deps.log.error({ err: String(e) }, 'open question failed'));
      }, cur.opensAt - now);
    }
    if (cur?.phase === 'ACTIVE' && cur.deadlineAt !== null) {
      const id = cur.id;
      const at = cur.deadlineAt;
      this.timers.question = clock.setTimer(() => {
        void this.run(async () => {
          const q = this.questions.get(id);
          if (q && q.phase === 'ACTIVE' && q.deadlineAt === at && this.session.state === 'ACTIVE') await this.lockQuestion(sys, id, at);
        }).catch((e) => this.deps.log.error({ err: String(e) }, 'question deadline handling failed'));
      }, at - now);
    }
  }

  private startBackgroundTimers(): void {
    const clock = this.deps.clock;
    const cfg = this.deps.config;
    const snapshot = () => {
      if (this.disposed) return;
      if (this.lbDirty) this.sendSnapshotNow();
      this.timers.snapshot = clock.setTimer(snapshot, cfg.leaderboardSnapshotIntervalMs);
    };
    const flush = () => {
      if (this.disposed) return;
      void this.flushClockSync();
      this.timers.flush = clock.setTimer(flush, cfg.clockSyncFlushIntervalMs);
    };
    const persist = () => {
      if (this.disposed) return;
      void this.persistLeaderboard('PERIODIC');
      this.timers.persistLb = clock.setTimer(persist, cfg.leaderboardPersistIntervalMs);
    };
    this.timers.snapshot = clock.setTimer(snapshot, cfg.leaderboardSnapshotIntervalMs);
    this.timers.flush = clock.setTimer(flush, cfg.clockSyncFlushIntervalMs);
    this.timers.persistLb = clock.setTimer(persist, cfg.leaderboardPersistIntervalMs);
  }

  /** Used by the manager before unloading/shutdown. */
  async flush(): Promise<void> {
    await this.flushClockSync();
    await this.persistLeaderboard('PERIODIC');
  }
}

function sanitizeNickname(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const s = raw.normalize('NFKC').replace(/\p{Cc}/gu, '').trim().replace(/\s+/g, ' ');
  if (s.length < 1 || s.length > 20) throw new AppError('BAD_REQUEST', 'nickname must be 1–20 characters');
  return s;
}

export type { OwnSubmissionView };
