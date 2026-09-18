import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QuestionInput, SessionSettingsPatch, StudentSessionState, TeacherSessionState } from '@brainbattle/shared';
import { api, createSession, eventually, Q, registerStudent, registerTeacher, startServer, TestClient, type TestServer } from './helpers.js';

let t: TestServer;
beforeAll(async () => {
  t = await startServer();
});
afterAll(async () => {
  await t.close();
});

interface Setup {
  teacher: TestClient;
  teacherToken: string;
  session: { id: string; joinCode: string };
  state: TeacherSessionState;
  sq: (i: number) => string;
}

async function setup(questions: QuestionInput[], settings: SessionSettingsPatch = {}, preset = 'CUSTOM'): Promise<Setup> {
  const { token } = await registerTeacher(t);
  const session = await createSession(t, token, questions, { preset, settings });
  const teacher = await TestClient.connect(t);
  const state = await teacher.joinTeacher(session.id, token);
  expect((await teacher.cmd('TEACHER_OPEN_LOBBY')).type).toBe('ACK');
  return { teacher, teacherToken: token, session, state, sq: (i) => state.questions[i]!.sessionQuestionId };
}

async function student(s: Setup, nickname: string): Promise<{ c: TestClient; st: StudentSessionState }> {
  const c = await TestClient.connect(t);
  const st = await c.joinStudent(s.session.joinCode, nickname);
  await c.sync(3);
  return { c, st };
}

/** SYNCHRONIZED session with the first question open */
async function liveQuestion(questions: QuestionInput[], settings: SessionSettingsPatch = {}) {
  const s = await setup(questions, { progressMode: 'SYNCHRONIZED', ...settings });
  const a = await student(s, `A${Math.random().toString(36).slice(2, 6)}`);
  expect((await s.teacher.cmd('TEACHER_START_SESSION')).type).toBe('ACK');
  expect((await s.teacher.cmd('TEACHER_START_QUESTION', { sessionQuestionId: s.sq(0), countdownSec: 0 })).type).toBe('ACK');
  await a.c.waitFor('QUESTION_START');
  return { s, a };
}

/* ====================================================================== joining */

describe('joining', () => {
  it('학생 정상 참가: student joins with code, teacher is notified, resume token issued', async () => {
    const s = await setup([Q.mc()]);
    const c = await TestClient.connect(t);
    const st = await c.joinStudent(s.session.joinCode, '김민수');
    expect(st.role).toBe('STUDENT');
    expect(st.participantId).toMatch(/^p_/);
    expect(st.resumeToken).toBeTruthy();
    expect(st.nickname).toBe('김민수');
    // question content is not sent before the session starts
    expect(st.questions).toEqual([]);
    const joined = await s.teacher.waitFor('PARTICIPANT_JOIN');
    expect(joined.payload.participant.nickname).toBe('김민수');
    expect(joined.payload.participantCount).toBe(1);
  });

  it('잘못된 참가 코드: rejected, and brute force gets blocked', async () => {
    const results: string[] = [];
    for (let i = 0; i < 11; i++) {
      const c = await TestClient.connect(t);
      const r = await c.request('JOIN_SESSION', { role: 'STUDENT', joinCode: String(100000 + i), nickname: 'x', clockEpochId: c.epoch });
      results.push((r.payload as { code: string }).code);
      await c.close();
    }
    expect(results[0]).toBe('INVALID_JOIN_CODE');
    expect(results).toContain('JOIN_BLOCKED');
    t.clock.advance(6 * 60_000); // block expires
  });

  it('중복 참가: duplicate nickname rejected, same socket cannot join twice, account re-join resumes', async () => {
    const s = await setup([Q.mc()]);
    const a = await TestClient.connect(t);
    await a.joinStudent(s.session.joinCode, '이지훈');
    const b = await TestClient.connect(t);
    const dup = await b.request('JOIN_SESSION', { role: 'STUDENT', joinCode: s.session.joinCode, nickname: ' 이지훈 ', clockEpochId: b.epoch });
    expect(dup.payload).toMatchObject({ code: 'NICKNAME_TAKEN' });
    const again = await a.request('JOIN_SESSION', { role: 'STUDENT', joinCode: s.session.joinCode, nickname: 'other', clockEpochId: a.epoch });
    expect(again.payload).toMatchObject({ code: 'CONFLICT' });

    const acct = await registerStudent(t, '박서준');
    const d1 = await TestClient.connect(t);
    const first = await d1.joinStudent(s.session.joinCode, '박서준', { authToken: acct.token });
    const d2 = await TestClient.connect(t);
    const second = await d2.joinStudent(s.session.joinCode, '박서준', { authToken: acct.token });
    expect(second.participantId).toBe(first.participantId); // same identity, not a second participant
    await eventually(() => d1.closed); // the older connection is replaced
  });

  it('로그인 필수 / 최대 인원 settings are enforced by the server', async () => {
    const s = await setup([Q.mc()], { join: { allowGuests: false, maxParticipants: 1 } });
    const g = await TestClient.connect(t);
    const r = await g.request('JOIN_SESSION', { role: 'STUDENT', joinCode: s.session.joinCode, nickname: 'guest', clockEpochId: g.epoch });
    expect(r.payload).toMatchObject({ code: 'LOGIN_REQUIRED' });
    const u1 = await registerStudent(t, 'u1');
    const u2 = await registerStudent(t, 'u2');
    await (await TestClient.connect(t)).joinStudent(s.session.joinCode, 'u1', { authToken: u1.token });
    const c2 = await TestClient.connect(t);
    const full = await c2.request('JOIN_SESSION', { role: 'STUDENT', joinCode: s.session.joinCode, nickname: 'u2', authToken: u2.token, clockEpochId: c2.epoch });
    expect(full.payload).toMatchObject({ code: 'SESSION_FULL' });
  });
});

/* ====================================================================== reconnect */

describe('reconnection', () => {
  it('WebSocket 재연결: participant survives disconnect and state is restored by participantId', async () => {
    const { s, a } = await liveQuestion([Q.mc(), Q.mc()]);
    const pid = (await a.c.request('REQUEST_SNAPSHOT', {})).payload as StudentSessionState;
    const acc = await a.c.request('SUBMIT_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['b'] }, 100));
    expect(acc.type).toBe('ANSWER_ACCEPTED');
    const token = a.st.resumeToken!;
    await a.c.close();
    const st = await s.teacher.waitFor('PARTICIPANT_STATUS', (p) => p.participantId === a.st.participantId && p.status === 'DISCONNECTED');
    expect(st.payload.status).toBe('DISCONNECTED');

    const again = await TestClient.connect(t);
    const r = await again.request('JOIN_SESSION', { role: 'STUDENT', sessionId: s.session.id, resumeToken: token, clockEpochId: again.epoch });
    expect(r.type).toBe('SESSION_STATE');
    const restored = r.payload as StudentSessionState;
    expect(restored.participantId).toBe(a.st.participantId);
    expect(restored.participantId).toBe(pid.participantId);
    expect(restored.submissions).toHaveLength(1);
    expect(restored.currentSessionQuestionId).toBe(s.sq(0));
    expect(restored.currentPhase).toBe('ACTIVE');
    expect(restored.score?.totalScore).toBe(10);
    await s.teacher.waitFor('PARTICIPANT_RECONNECT', (p) => p.participantId === a.st.participantId);
  });

  it('invalid resume tokens are rejected', async () => {
    const s = await setup([Q.mc()]);
    const c = await TestClient.connect(t);
    const r = await c.request('JOIN_SESSION', { role: 'STUDENT', sessionId: s.session.id, resumeToken: 'x'.repeat(40), clockEpochId: c.epoch });
    expect(r.payload).toMatchObject({ code: 'INVALID_RESUME_TOKEN' });
  });
});

/* ====================================================================== submissions */

describe('submissions', () => {
  it('제출 성공: accepted, graded server-side, teacher + leaderboard notified; no answer key leaks', async () => {
    const { s, a } = await liveQuestion([Q.mc()], { revealPolicy: 'AFTER_QUESTION' });
    const start = (a.c.messages.find((m) => m.type === 'QUESTION_START') ?? (await a.c.request('REQUEST_SNAPSHOT', {})));
    expect(JSON.stringify(start)).not.toContain('correctAnswer');
    t.clock.advance(2000);
    const r = await a.c.request('SUBMIT_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['b'] }, 300));
    expect(r.type).toBe('ANSWER_ACCEPTED');
    const sub = (r.payload as any).submission;
    expect(sub.revision).toBe(1);
    expect(sub.timestampSource).toBe('CLIENT_TRUSTED');
    expect(sub.isCorrect).toBeUndefined(); // reveal policy: not until the question ends
    const tr = await s.teacher.waitFor('SUBMISSION_RECEIVED');
    expect(tr.payload.submission.isCorrect).toBe(true);
    expect(tr.payload.submission.finalScore).toBe(10);
    expect(tr.payload.stats.submitted).toBe(1);
    const lb = await s.teacher.waitFor('LEADERBOARD_UPDATE', (p) => p.changes.some((c) => c.score === 10));
    expect(lb.payload.changes[0]).toMatchObject({ participantId: a.st.participantId, score: 10, rank: 1 });
  });

  it('제출 중복 요청: the same idempotency key is applied exactly once', async () => {
    const { s, a } = await liveQuestion([Q.mc()]);
    const p = a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['b'] }, 100);
    const [r1, r2] = await Promise.all([a.c.request('SUBMIT_ANSWER', p), a.c.request('SUBMIT_ANSWER', p)]);
    expect(r1.type).toBe('ANSWER_ACCEPTED');
    expect(r2.type).toBe('ANSWER_ACCEPTED');
    expect((r2.payload as any).duplicate).toBe(true);
    const rev = await t.db.query('SELECT count(*)::int AS n FROM submission_revisions WHERE participant_id = $1', [a.st.participantId]);
    expect(Number((rev.rows[0] as any).n)).toBe(1);
  });

  it('제출 직후 연결 끊김: a frame that reached the server is committed even if the socket drops', async () => {
    const { s, a } = await liveQuestion([Q.mc()]);
    a.c.send('SUBMIT_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['b'] }, 50));
    a.c.ws.terminate();
    const got = await s.teacher.waitFor('SUBMISSION_RECEIVED');
    expect(got.payload.submission.participantId).toBe(a.st.participantId);
  });

  it('pending queue replay after reconnect keeps the original client time (offline replay verified)', async () => {
    const { s, a } = await liveQuestion([Q.numeric({ timeLimitSec: 60 })]);
    t.clock.advance(5000);
    // student pressed submit now, but the network was already gone: the frame never arrived
    const pending = a.c.submitPayload(s.sq(0), { kind: 'numeric', raw: '3.14' }, 0, { replay: true });
    a.c.ws.terminate();
    await s.teacher.waitFor('PARTICIPANT_STATUS', (p) => p.status === 'DISCONNECTED');
    t.clock.advance(20_000); // offline for 20s
    const again = await TestClient.connect(t);
    again.epoch = a.c.epoch; // same page (same monotonic clock epoch)
    again.monoOffset = a.c.monoOffset;
    await again.request('JOIN_SESSION', { role: 'STUDENT', sessionId: s.session.id, resumeToken: a.st.resumeToken, clockEpochId: again.epoch });
    again.lastSample = undefined;
    await again.sync(3);
    const r = await again.request('SUBMIT_ANSWER', pending);
    expect(r.type).toBe('ANSWER_ACCEPTED');
    const tr = await s.teacher.waitFor('SUBMISSION_RECEIVED');
    expect(tr.payload.submission.timestampReason).toBe('OFFLINE_REPLAY_VERIFIED');
    expect(tr.payload.submission.responseMs).toBe(5000);
  });

  it('deadline 직전 제출 / in-flight across the deadline is accepted with a trusted timestamp', async () => {
    const { s, a } = await liveQuestion([Q.mc({ timeLimitSec: 10 })]);
    t.clock.advance(9_900);
    const ok = await a.c.request('SUBMIT_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['b'] }, 0));
    expect(ok.type).toBe('ANSWER_ACCEPTED');

    const { s: s2, a: b } = await liveQuestion([Q.mc({ timeLimitSec: 10 })]);
    t.clock.advance(10_300); // deadline passed 300ms ago, question locked by the server timer
    await b.c.waitFor('QUESTION_END');
    // pressed 500ms ago (200ms before the deadline), message delayed in flight
    const late = await b.c.request('SUBMIT_ANSWER', b.c.submitPayload(s2.sq(0), { kind: 'choice', choiceIds: ['b'] }, 500));
    expect(late.type).toBe('ANSWER_ACCEPTED');
  });

  it('deadline 이후 제출: rejected with SUBMISSION_CLOSED — the server deadline wins', async () => {
    const { s, a } = await liveQuestion([Q.mc({ timeLimitSec: 10 })]);
    t.clock.advance(10_001);
    const r = await a.c.request('SUBMIT_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['b'] }, 0));
    expect(r.type).toBe('ANSWER_REJECTED');
    expect((r.payload as any).code).toBe('SUBMISSION_CLOSED');
    // a lying client claiming it pressed submit long before the deadline is not trusted (diff ≥ 1s)
    const lie = await a.c.request('SUBMIT_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['b'] }, 5000));
    expect((lie.payload as any).code).toBe('SUBMISSION_CLOSED');
  });

  it.each([
    [500, 'CLIENT_TRUSTED'],
    [999, 'CLIENT_TRUSTED'],
    [1000, 'SERVER_FALLBACK'],
    [2500, 'SERVER_FALLBACK'],
  ])('Client timestamp %ims 차이 → %s', async (msAgo, expected) => {
    const { s, a } = await liveQuestion([Q.mc({ timeLimitSec: 60 })]);
    t.clock.advance(10_000);
    const r = await a.c.request('SUBMIT_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['b'] }, msAgo));
    expect(r.type).toBe('ANSWER_ACCEPTED');
    const sub = (r.payload as any).submission;
    expect(sub.timestampSource).toBe(expected);
    const now = t.clock.now();
    expect(sub.effectiveSubmittedAt).toBe(expected === 'CLIENT_TRUSTED' ? now - msAgo : now);
    const tr = await s.teacher.waitFor('SUBMISSION_RECEIVED');
    expect(tr.payload.submission.responseMs).toBe(expected === 'CLIENT_TRUSTED' ? 10_000 - msAgo : 10_000);
  });

  it('Client clock 조작: tampered wall clock / jumped monotonic clock / pre-start claims fall back to server time', async () => {
    const { s, a } = await liveQuestion([Q.mc({ timeLimitSec: 60 }), Q.mc({ timeLimitSec: 60 })]);
    t.clock.advance(3000);
    // 1) client-side Date manipulation → reported time disagrees with monotonic estimate
    const p1 = a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['b'] }, 200, { clientSentAt: t.clock.now() - 30_000 });
    const r1 = await a.c.request('SUBMIT_ANSWER', p1);
    expect((r1.payload as any).submission.timestampSource).toBe('SERVER_FALLBACK');
    expect((await s.teacher.waitFor('SUBMISSION_RECEIVED')).payload.submission.timestampReason).toBe('CLIENT_ESTIMATE_MISMATCH');

    // 2) claim before the question started
    const { s: s2, a: b } = await liveQuestion([Q.mc({ timeLimitSec: 60 })]);
    t.clock.advance(300);
    const r2 = await b.c.request('SUBMIT_ANSWER', b.c.submitPayload(s2.sq(0), { kind: 'choice', choiceIds: ['b'] }, 800));
    expect((r2.payload as any).submission.timestampSource).toBe('SERVER_FALLBACK');
    expect((await s2.teacher.waitFor('SUBMISSION_RECEIVED')).payload.submission.timestampReason).toBe('BEFORE_WINDOW_START');

    // 3) monotonic clock suddenly shifted by 10s (tampering / sleep) → offset unstable
    const { s: s3, a: c } = await liveQuestion([Q.mc({ timeLimitSec: 60 })]);
    t.clock.advance(1000);
    c.c.monoOffset -= 10_000;
    await c.c.sync(2);
    const r3 = await c.c.request('SUBMIT_ANSWER', c.c.submitPayload(s3.sq(0), { kind: 'choice', choiceIds: ['b'] }, 100));
    expect((r3.payload as any).submission.timestampSource).toBe('SERVER_FALLBACK');
    expect((await s3.teacher.waitFor('SUBMISSION_RECEIVED')).payload.submission.timestampReason).toBe('OFFSET_UNSTABLE');
  });

  it('submission rate limit', async () => {
    const { s, a } = await liveQuestion([Q.mc({ timeLimitSec: 60 })], { editPolicy: 'ALLOW' });
    const replies = await Promise.all(
      Array.from({ length: 14 }, () => a.c.request('SUBMIT_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['a'] }, 0))),
    );
    expect(replies.some((r) => (r.payload as any).code === 'RATE_LIMITED')).toBe(true);
  });
});

/* ====================================================================== pause / resume */

describe('pause and resume', () => {
  it('세션 일시정지: submissions are closed while paused; 재개: deadline is extended by the pause', async () => {
    const { s, a } = await liveQuestion([Q.mc({ timeLimitSec: 20 })]);
    const started = (await s.teacher.request('REQUEST_SNAPSHOT', {})).payload as TeacherSessionState;
    const deadline0 = started.questionDeadlineAt!;
    t.clock.advance(5000);
    expect((await s.teacher.cmd('TEACHER_PAUSE_SESSION')).type).toBe('ACK');
    const paused = await a.c.waitFor('SESSION_PAUSE');
    expect(paused.payload.state).toBe('PAUSED');
    t.clock.advance(30_000); // longer than the remaining time: timers must not fire while paused
    const r = await a.c.request('SUBMIT_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['b'] }, 0));
    expect((r.payload as any).code).toBe('SUBMISSION_CLOSED');
    expect(a.c.messages.find((m) => m.type === 'QUESTION_END')).toBeUndefined();

    expect((await s.teacher.cmd('TEACHER_RESUME_SESSION')).type).toBe('ACK');
    const resumed = await a.c.waitFor('SESSION_RESUME');
    expect(resumed.payload.questionDeadlineAt).toBe(deadline0 + 30_000);
    t.clock.advance(2000);
    const ok = await a.c.request('SUBMIT_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['b'] }, 100));
    expect(ok.type).toBe('ANSWER_ACCEPTED');
    const tr = await s.teacher.waitFor('SUBMISSION_RECEIVED');
    expect(tr.payload.submission.responseMs).toBe(5000 + 2000 - 100); // pause excluded
  });

  it('invalid transitions are rejected by the server state machine', async () => {
    const s = await setup([Q.mc()]);
    expect((await s.teacher.cmd('TEACHER_PAUSE_SESSION')).payload).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect((await s.teacher.cmd('TEACHER_RESUME_SESSION')).payload).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect((await s.teacher.cmd('TEACHER_START_QUESTION', { sessionQuestionId: s.sq(0) })).payload).toMatchObject({ code: 'INVALID_TRANSITION' });
    await s.teacher.cmd('TEACHER_START_SESSION');
    await s.teacher.cmd('TEACHER_END_SESSION');
    expect((await s.teacher.cmd('TEACHER_START_SESSION')).payload).toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});

/* ====================================================================== editing */

describe('answer editing', () => {
  it('답안 수정: UPDATE_ANSWER creates a new revision and keeps the history', async () => {
    const { s, a } = await liveQuestion([Q.mc({ timeLimitSec: 60 })], { editPolicy: 'ALLOW' });
    const r1 = await a.c.request('SUBMIT_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['a'] }, 0));
    expect(r1.type).toBe('ANSWER_ACCEPTED');
    t.clock.advance(1000);
    const r2 = await a.c.request('UPDATE_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['b'] }, 0, { baseRevision: 1 }));
    expect(r2.type).toBe('ANSWER_UPDATED');
    expect((r2.payload as any).submission.revision).toBe(2);
    // stale base revision (edited elsewhere) is refused
    const r3 = await a.c.request('UPDATE_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['a'] }, 0, { baseRevision: 1 }));
    expect((r3.payload as any).code).toBe('STALE_REVISION');
    const hist = await t.db.query('SELECT revision, answer FROM submission_revisions WHERE participant_id = $1 ORDER BY revision', [a.st.participantId]);
    expect(hist.rows.map((r: any) => r.answer.choiceIds[0])).toEqual(['a', 'b']);
    const score = await t.db.query('SELECT total_score FROM scores WHERE participant_id = $1', [a.st.participantId]);
    expect(Number((score.rows[0] as any).total_score)).toBe(10);
  });

  it('수정 불가 설정: NO_EDIT rejects any change after the first submission', async () => {
    const { s, a } = await liveQuestion([Q.mc({ timeLimitSec: 60 })], { editPolicy: 'NO_EDIT' });
    await a.c.request('SUBMIT_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['a'] }, 0));
    const r = await a.c.request('UPDATE_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['b'] }, 0, { baseRevision: 1 }));
    expect((r.payload as any).code).toBe('EDIT_NOT_ALLOWED');
    const r2 = await a.c.request('SUBMIT_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['b'] }, 0));
    expect((r2.payload as any).code).toBe('EDIT_NOT_ALLOWED');
  });

  it('UNTIL_QUESTION_END in FREE progress finalizes a question when the student moves on', async () => {
    const s = await setup([Q.mc(), Q.mc()], { progressMode: 'FREE', editPolicy: 'UNTIL_QUESTION_END' });
    const a = await student(s, 'free');
    await s.teacher.cmd('TEACHER_START_SESSION');
    await a.c.waitFor('SESSION_STATE', (p: any) => p.questions?.length === 2);
    await a.c.request('STUDENT_SELECT_QUESTION', { sessionQuestionId: s.sq(0) });
    await a.c.request('SUBMIT_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['a'] }, 0));
    const ok = await a.c.request('UPDATE_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['b'] }, 0, { baseRevision: 1 }));
    expect(ok.type).toBe('ANSWER_UPDATED');
    await a.c.request('STUDENT_SELECT_QUESTION', { sessionQuestionId: s.sq(1) });
    const blocked = await a.c.request('UPDATE_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['a'] }, 0, { baseRevision: 2 }));
    expect((blocked.payload as any).code).toBe('EDIT_NOT_ALLOWED');
    const status = await s.teacher.waitFor('PARTICIPANT_STATUS', (p) => p.currentSessionQuestionId === s.sq(1));
    expect(status.payload.participantId).toBe(a.st.participantId);
  });
});

/* ====================================================================== scoring & ranking */

describe('scoring and ranking', () => {
  it('점수 변경: manual partial score updates totals and ranking immediately', async () => {
    const { s, a } = await liveQuestion([Q.essay({ score: 10, timeLimitSec: 60 })]);
    const r = await a.c.request('SUBMIT_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'text', raw: '증명: ...' }, 0));
    expect(r.type).toBe('ANSWER_ACCEPTED');
    const sub = (await s.teacher.waitFor('SUBMISSION_RECEIVED')).payload.submission;
    expect(sub.gradingStatus).toBe('PENDING_MANUAL');
    expect((await s.teacher.cmd('TEACHER_SCORE_UPDATE', { submissionId: sub.submissionId, score: 6, feedback: '부분 점수' })).type).toBe('ACK');
    const graded = await s.teacher.waitFor('SUBMISSION_RECEIVED', (p) => p.submission.gradingStatus === 'MANUALLY_GRADED');
    expect(graded.payload.submission.finalScore).toBe(6);
    const lb = await s.teacher.waitFor('LEADERBOARD_UPDATE', (p) => p.changes.some((c) => c.score === 6));
    expect(lb.payload.changes[0]!.participantId).toBe(a.st.participantId);
    const own = await a.c.waitFor('SCORE_UPDATE', (p) => p.scores[0]!.totalScore === 6);
    expect(own.payload.scores[0]!.participantId).toBe(a.st.participantId);
    // score above max is refused
    expect((await s.teacher.cmd('TEACHER_SCORE_UPDATE', { submissionId: sub.submissionId, score: 11 })).payload).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('동점자: equal scores are ordered by tie breakers (earlier effective submission first)', async () => {
    const s = await setup([Q.mc({ timeLimitSec: 60 })], { progressMode: 'SYNCHRONIZED' });
    const a = await student(s, '빠른학생');
    const b = await student(s, '느린학생');
    await s.teacher.cmd('TEACHER_START_SESSION');
    await s.teacher.cmd('TEACHER_START_QUESTION', { sessionQuestionId: s.sq(0), countdownSec: 0 });
    t.clock.advance(4000);
    // b's message arrives first but a pressed earlier (trusted client time)
    await b.c.request('SUBMIT_ANSWER', b.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['b'] }, 100));
    await a.c.request('SUBMIT_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['b'] }, 900));
    const snap = (await s.teacher.request('REQUEST_SNAPSHOT', {})).payload as TeacherSessionState;
    expect(snap.leaderboard.map((e) => [e.nickname, e.score, e.rank])).toEqual([
      ['빠른학생', 10, 1],
      ['느린학생', 10, 2],
    ]);
  });

  it('ACCURACY_SPEED uses server-computed response time', async () => {
    const { s, a } = await liveQuestion([Q.mc({ timeLimitSec: 20, score: 1000 })], { scoringMode: 'ACCURACY_SPEED' });
    t.clock.advance(10_000);
    await a.c.request('SUBMIT_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['b'] }, 0, { responseTime: 1 }));
    const tr = await s.teacher.waitFor('SUBMISSION_RECEIVED');
    expect(tr.payload.submission.finalScore).toBe(750);
  });
});

/* ====================================================================== scoreboard */

describe('scoreboard', () => {
  it('Scoreboard 갱신: board receives incremental updates filtered by the visibility policy, read-only', async () => {
    const s = await setup([Q.mc({ timeLimitSec: 60 })], { progressMode: 'SYNCHRONIZED', scoreboard: { visibility: 'TOP_3', visible: true } });
    const tok = await api(t, 'POST', `/api/sessions/${s.session.id}/scoreboard-token`, undefined, s.teacherToken);
    const board = await TestClient.connect(t);
    const bs = await board.request('JOIN_SESSION', { role: 'SCOREBOARD', sessionId: s.session.id, scoreboardToken: tok.body.token });
    expect(bs.type).toBe('SESSION_STATE');
    const students = [];
    for (let i = 0; i < 4; i++) students.push(await student(s, `s${i}`));
    await s.teacher.cmd('TEACHER_START_SESSION');
    await s.teacher.cmd('TEACHER_START_QUESTION', { sessionQuestionId: s.sq(0), countdownSec: 0 });
    t.clock.advance(1000);
    await students[3]!.c.request('SUBMIT_ANSWER', students[3]!.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['b'] }, 0));
    const up = await board.waitFor('LEADERBOARD_UPDATE', (p) => p.changes.some((c) => c.nickname === 's3'));
    expect(up.payload.changes.every((c) => (c.rank ?? 99) <= 3)).toBe(true);
    expect(JSON.stringify(up.payload)).not.toContain('choiceIds');

    // read-only: scoreboard cannot control or submit
    expect((await board.cmd('TEACHER_END_SESSION')).payload).toMatchObject({ code: 'FORBIDDEN' });
    expect((await board.cmd('SUBMIT_ANSWER', students[0]!.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['b'] }))).payload).toMatchObject({ code: 'FORBIDDEN' });

    // hide / show during the session
    await s.teacher.cmd('TEACHER_SET_SCOREBOARD', { visible: false });
    const hidden = await board.waitFor('LEADERBOARD_SNAPSHOT', (p) => p.visible === false);
    expect(hidden.payload.entries).toEqual([]);

    // periodic full snapshot
    await s.teacher.cmd('TEACHER_SET_SCOREBOARD', { visible: true, visibility: 'FULL' });
    await students[0]!.c.request('SUBMIT_ANSWER', students[0]!.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['b'] }, 0));
    board.clear();
    t.clock.advance(5000);
    const snap = await board.waitFor('LEADERBOARD_SNAPSHOT');
    expect(snap.payload.entries).toHaveLength(4);
  });

  it('presentation cannot reveal the answer while the question is open', async () => {
    const { s } = await liveQuestion([Q.mc({ timeLimitSec: 60 })]);
    const r = await s.teacher.cmd('TEACHER_SET_PRESENTATION', { view: 'ANSWER', sessionQuestionId: s.sq(0) });
    expect(r.payload).toMatchObject({ code: 'INVALID_TRANSITION' });
    await s.teacher.cmd('TEACHER_END_QUESTION', { sessionQuestionId: s.sq(0) });
    expect((await s.teacher.cmd('TEACHER_SET_PRESENTATION', { view: 'ANSWER', sessionQuestionId: s.sq(0) })).type).toBe('ACK');
  });
});

/* ====================================================================== authorization */

describe('authorization', () => {
  it('Teacher 권한 없는 사용자 명령: students and foreign teachers are refused', async () => {
    const { s, a } = await liveQuestion([Q.mc({ timeLimitSec: 60 })]);
    for (const cmd of ['TEACHER_END_SESSION', 'TEACHER_PAUSE_SESSION', 'TEACHER_START_QUESTION', 'TEACHER_KICK_PARTICIPANT'] as const) {
      const r = await a.c.cmd(cmd, cmd === 'TEACHER_START_QUESTION' ? { sessionQuestionId: s.sq(0) } : cmd === 'TEACHER_KICK_PARTICIPANT' ? { participantId: a.st.participantId } : {});
      expect(r.payload).toMatchObject({ code: 'FORBIDDEN' });
    }
    const other = await registerTeacher(t, 'intruder');
    const c = await TestClient.connect(t);
    const r = await c.request('JOIN_SESSION', { role: 'TEACHER', sessionId: s.session.id, authToken: other.token });
    expect(r.payload).toMatchObject({ code: 'FORBIDDEN' });
    const rest = await api(t, 'GET', `/api/sessions/${s.session.id}/results`, undefined, other.token);
    expect(rest.status).toBe(403);
    const forged = await c.request('JOIN_SESSION', { role: 'TEACHER', sessionId: s.session.id, authToken: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.' });
    expect(forged.payload).toMatchObject({ code: 'UNAUTHENTICATED' });
    // student REST access to teacher APIs
    const stu = await registerStudent(t);
    expect((await api(t, 'GET', '/api/questions', undefined, stu.token)).status).toBe(403);
  });

  it('Student가 다른 학생 Submission 수정 시도: identity comes from the connection, never the payload', async () => {
    const s = await setup([Q.mc({ timeLimitSec: 60 })], { progressMode: 'SYNCHRONIZED', editPolicy: 'ALLOW' });
    const a = await student(s, 'victim');
    const b = await student(s, 'attacker');
    await s.teacher.cmd('TEACHER_START_SESSION');
    await s.teacher.cmd('TEACHER_START_QUESTION', { sessionQuestionId: s.sq(0), countdownSec: 0 });
    const ra = await a.c.request('SUBMIT_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['b'] }, 0));
    const victimSub = (ra.payload as any).submission;
    // attacker tries to update "revision 1" (the victim's) and to smuggle ids in the payload
    const rb = await b.c.request(
      'UPDATE_ANSWER',
      b.c.submitPayload(s.sq(0), { kind: 'choice', choiceIds: ['a'] }, 0, { baseRevision: 1, participantId: a.st.participantId, submissionId: victimSub.submissionId }),
    );
    expect(rb.type === 'ERROR' || rb.type === 'ANSWER_REJECTED').toBe(true);
    const rc = await b.c.cmd('TEACHER_SCORE_UPDATE', { submissionId: victimSub.submissionId, score: 0 });
    expect(rc.payload).toMatchObject({ code: 'FORBIDDEN' });
    const row = await t.db.query('SELECT answer, revision FROM submissions WHERE id = $1', [victimSub.submissionId]);
    expect((row.rows[0] as any).answer.choiceIds).toEqual(['b']);
    expect(Number((row.rows[0] as any).revision)).toBe(1);
    // students never receive other students' answers
    expect(JSON.stringify(b.c.messages)).not.toContain(victimSub.submissionId);
  });

  it('kicked students are disconnected and cannot resume', async () => {
    const s = await setup([Q.mc()]);
    const a = await student(s, 'kickme');
    expect((await s.teacher.cmd('TEACHER_KICK_PARTICIPANT', { participantId: a.st.participantId })).type).toBe('ACK');
    await a.c.waitFor('KICKED');
    await eventually(() => a.c.closed);
    const c = await TestClient.connect(t);
    const r = await c.request('JOIN_SESSION', { role: 'STUDENT', sessionId: s.session.id, resumeToken: a.st.resumeToken, clockEpochId: c.epoch });
    expect(r.payload).toMatchObject({ code: 'KICKED' });
  });
});

/* ====================================================================== session end & free progress */

describe('session end and paper battle', () => {
  it('시험 종료: FREE/PAPER session locks at the server deadline; later submissions → SESSION_LOCKED', async () => {
    const s = await setup(
      [Q.numeric({ deliveryMode: 'PAPER', displayNumber: '15-1' }), Q.mc({ deliveryMode: 'PAPER' })],
      { deliveryMode: 'PAPER', progressMode: 'FREE', timing: { sessionTimeLimitSec: 60 }, revealPolicy: 'AFTER_SESSION', releaseResultsOnEnd: false },
    );
    const a = await student(s, 'paper');
    await s.teacher.cmd('TEACHER_START_SESSION');
    const st = await a.c.waitFor('SESSION_STATE', (p: any) => p.questions?.length === 2);
    const qv = (st.payload as StudentSessionState).questions[0]!;
    // paper mode: only the number, no content
    expect(qv.displayNumber).toBe('15-1');
    expect(qv.title).toBeNull();
    expect(qv.description).toBeNull();
    expect((st.payload as StudentSessionState).questions[1]!.choices!.map((c) => c.label)).toEqual(['①', '②']);
    const ok = await a.c.request('SUBMIT_ANSWER', a.c.submitPayload(s.sq(0), { kind: 'numeric', raw: '3.14' }, 0));
    expect(ok.type).toBe('ANSWER_ACCEPTED');
    t.clock.advance(60_000);
    await a.c.waitFor('SESSION_LOCKED');
    await a.c.waitFor('SESSION_END');
    const late = await a.c.request('SUBMIT_ANSWER', a.c.submitPayload(s.sq(1), { kind: 'choice', choiceIds: ['b'] }, 0));
    expect((late.payload as any).code).toBe('SESSION_LOCKED');
    // results released later by the teacher
    expect((await s.teacher.cmd('TEACHER_RELEASE_RESULTS')).type).toBe('ACK');
    const rel = await a.c.waitFor('RESULTS_RELEASED');
    expect(rel.payload.submissions[0]!.isCorrect).toBe(true);
    expect(rel.payload.reveals).toHaveLength(2);
    const results = await api(t, 'GET', `/api/sessions/${s.session.id}/results`, undefined, s.teacherToken);
    expect(results.status).toBe(200);
    expect(results.body.questions[0]).toMatchObject({ submitted: 1, correct: 1 });
    expect(results.body.leaderboard[0]).toMatchObject({ nickname: 'paper', score: 10 });
  });
});

/* ====================================================================== REST CRUD */

describe('question & set management', () => {
  it('CRUD, duplicate, reorder, and snapshot isolation of running sessions', async () => {
    const { token } = await registerTeacher(t);
    const q1 = (await api(t, 'POST', '/api/questions', Q.mc({ displayNumber: '1' }), token)).body;
    const q2 = (await api(t, 'POST', '/api/questions', { type: 'NUMERIC', deliveryMode: 'PAPER', displayNumber: 'A', correctAnswer: 5, score: 3 }, token)).body;
    expect(q1.id).toMatch(/^q_/);
    expect(q2.title).toBeNull(); // answer-only question without title/description
    const bad = await api(t, 'POST', '/api/questions', { type: 'MULTIPLE_CHOICE', choices: [{ id: 'a', content: [] }], score: 1 }, token);
    expect(bad.status).toBe(400);
    const set = (await api(t, 'POST', '/api/question-sets', { title: 'S' }, token)).body;
    await api(t, 'POST', `/api/question-sets/${set.id}/items`, { questionId: q1.id }, token);
    const withTwo = (await api(t, 'POST', `/api/question-sets/${set.id}/items`, { questionId: q2.id }, token)).body;
    expect(withTwo.items.map((i: any) => i.displayNumber)).toEqual(['1', 'A']);
    const dup = (await api(t, 'POST', `/api/question-sets/${set.id}/items/${withTwo.items[0].id}/duplicate`, undefined, token)).body;
    expect(dup.items).toHaveLength(3);
    const reordered = (await api(t, 'PUT', `/api/question-sets/${set.id}/order`, { itemIds: [...dup.items].reverse().map((i: any) => i.id) }, token)).body;
    expect(reordered.items[0].displayNumber).toBe('A');
    const setCopy = (await api(t, 'POST', `/api/question-sets/${set.id}/duplicate`, undefined, token)).body;
    expect(setCopy.items).toHaveLength(3);

    const session = (await api(t, 'POST', '/api/sessions', { questionSetId: set.id, preset: 'PAPER_BATTLE' }, token)).body;
    expect(session.settings.deliveryMode).toBe('PAPER');
    await api(t, 'PUT', `/api/questions/${q2.id}`, { type: 'NUMERIC', deliveryMode: 'PAPER', displayNumber: 'A', correctAnswer: 999, score: 3 }, token);
    const snap = await t.db.query("SELECT snapshot->>'correctAnswer' AS ca FROM session_questions WHERE session_id = $1 AND question_id = $2", [session.id, q2.id]);
    expect((snap.rows[0] as any).ca).toBe('5'); // frozen

    expect((await api(t, 'DELETE', `/api/questions/${q1.id}`, undefined, token)).status).toBe(204);
    const after = (await api(t, 'GET', `/api/question-sets/${set.id}`, undefined, token)).body;
    expect(after.items.map((i: any) => i.position)).toEqual([0, 1]);

    const other = await registerTeacher(t);
    expect((await api(t, 'GET', `/api/question-sets/${set.id}`, undefined, other.token)).status).toBe(403);
    expect((await api(t, 'PUT', `/api/questions/${q2.id}`, Q.mc(), other.token)).status).toBe(403);
  });
});
