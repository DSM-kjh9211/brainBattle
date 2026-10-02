import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionSettingsPatch } from '@brainbattle/shared';
import { api, createSession, Q, registerStudent, registerTeacher, startServer, TestClient, type TestServer } from './helpers.js';

let t: TestServer;
beforeEach(async () => { t = await startServer(); });
afterEach(async () => { await t.close(); });

async function setup(settings: SessionSettingsPatch = {}) {
  const { token } = await registerTeacher(t);
  const session = await createSession(t, token, [Q.mc()], { settings });
  const teacher = await TestClient.connect(t);
  await teacher.joinTeacher(session.id, token);
  return { session, teacher, token };
}

const check = (code: string, token?: string) => api(t, 'POST', '/api/join/check', { code }, token);

describe('join preflight', () => {
  it('distinguishes unknown, unopened and finished sessions without exposing metadata', async () => {
    expect(await check('NOT-A-CODE')).toMatchObject({ status: 404, body: { error: { code: 'INVALID_JOIN_CODE' } } });
    const s = await setup();
    expect(await check(s.session.joinCode)).toMatchObject({ status: 409, body: { error: { code: 'SESSION_CLOSED' } } });
    await s.teacher.cmd('TEACHER_OPEN_LOBBY');
    const valid = await check(` ${s.session.joinCode.slice(0, 3)} ${s.session.joinCode.slice(3)} `);
    expect(valid).toEqual({ status: 200, body: { available: true } });
    expect((await t.db.query('SELECT id FROM session_participants WHERE session_id = $1', [s.session.id])).rows).toEqual([]);
    await s.teacher.cmd('TEACHER_END_SESSION');
    const finished = await check(s.session.joinCode);
    expect(finished.status).toBe(409);
    expect(finished.body).toEqual({ error: { code: 'SESSION_FINISHED', message: 'session has finished' } });
  });

  it('enforces login, capacity and late-join policy while allowing account rejoin', async () => {
    const s = await setup({ join: { allowGuests: false, maxParticipants: 1, allowLateJoin: false } });
    await s.teacher.cmd('TEACHER_OPEN_LOBBY');
    expect((await check(s.session.joinCode)).body.error.code).toBe('LOGIN_REQUIRED');
    expect((await check(s.session.joinCode, 'invalid')).body.error.code).toBe('UNAUTHENTICATED');
    const a = await registerStudent(t, 'account-a');
    const b = await registerStudent(t, 'account-b');
    expect((await check(s.session.joinCode, a.token)).body).toEqual({ available: true });
    const student = await TestClient.connect(t);
    const first = await student.joinStudent(s.session.joinCode, 'account-a', { authToken: a.token });
    expect((await check(s.session.joinCode, b.token)).body.error.code).toBe('SESSION_FULL');
    await s.teacher.cmd('TEACHER_START_SESSION');
    expect((await check(s.session.joinCode, b.token)).body.error.code).toBe('SESSION_CLOSED');
    expect((await check(s.session.joinCode, a.token)).body).toEqual({ available: true });
    const resumed = await TestClient.connect(t);
    expect((await resumed.joinStudent(s.session.joinCode, 'account-a', { authToken: a.token })).participantId).toBe(first.participantId);
    await s.teacher.cmd('TEACHER_KICK_PARTICIPANT', { participantId: first.participantId });
    expect((await check(s.session.joinCode, a.token)).body.error.code).toBe('KICKED');
  });

  it('requires classroom membership', async () => {
    const { token } = await registerTeacher(t);
    const classroom = await api(t, 'POST', '/api/classrooms', { name: 'class' }, token);
    const session = await createSession(t, token, [Q.mc()], { settings: { join: { classroomId: classroom.body.id, requireLogin: true } } });
    const teacher = await TestClient.connect(t);
    await teacher.joinTeacher(session.id, token);
    await teacher.cmd('TEACHER_OPEN_LOBBY');
    const account = await registerStudent(t);
    expect((await check(session.joinCode, account.token)).body.error.code).toBe('NOT_IN_CLASSROOM');
    await api(t, 'POST', `/api/classrooms/${classroom.body.id}/members`, { email: account.user.email }, token);
    expect((await check(session.joinCode, account.token)).body).toEqual({ available: true });
  });

  it('keeps guest joining available to a signed-in account removed from a guest-enabled session', async () => {
    const s = await setup({ join: { allowGuests: true } });
    await s.teacher.cmd('TEACHER_OPEN_LOBBY');
    const account = await registerStudent(t, 'removed-account');
    const first = await TestClient.connect(t);
    const joined = await first.joinStudent(s.session.joinCode, 'account', { authToken: account.token });
    await s.teacher.cmd('TEACHER_KICK_PARTICIPANT', { participantId: joined.participantId });
    expect((await check(s.session.joinCode, account.token)).body).toEqual({ available: true });
    const guest = await TestClient.connect(t);
    expect((await guest.joinStudent(s.session.joinCode, 'guest')).participantId).not.toBe(joined.participantId);
    const kicked = await TestClient.connect(t);
    expect((await kicked.request('JOIN_SESSION', { role: 'STUDENT', joinCode: s.session.joinCode, nickname: 'account', authToken: account.token, clockEpochId: kicked.epoch })).payload).toMatchObject({ code: 'KICKED' });
  });

  it('checks an unowned runtime without acquiring a lease or loading an aggregate', async () => {
    const s = await setup();
    await s.teacher.cmd('TEACHER_OPEN_LOBBY');
    // A different node can perform preflight while the WebSocket owner remains unchanged.
    const second = await startServer({ db: t.db, clock: t.clock, nodeId: 'check-only-node' });
    try {
      expect(await api(second, 'POST', '/api/join/check', { code: s.session.joinCode })).toEqual({ status: 200, body: { available: true } });
      expect(second.server.manager.loaded).toEqual([]);
      expect((await t.db.query<{ node_id: string }>('SELECT node_id FROM session_leases WHERE session_id = $1', [s.session.id])).rows[0]?.node_id).toBe('test-node-1');
    } finally {
      // close() closes the shared DB; close just the second node's own resources here.
      await second.server.hub.close();
      await second.server.manager.shutdown();
      await second.server.app.close();
    }
  });

  it('shares failed-attempt blocking with WebSocket and does not reset guesses on a successful check', async () => {
    t.clock.advance(6 * 60_000);
    const s = await setup();
    await s.teacher.cmd('TEACHER_OPEN_LOBBY');
    for (let i = 0; i < 9; i++) expect((await check('INVALID-CODE')).body.error.code).toBe('INVALID_JOIN_CODE');
    expect((await check(s.session.joinCode)).body).toEqual({ available: true });
    const client = await TestClient.connect(t);
    expect((await client.request('JOIN_SESSION', { role: 'STUDENT', joinCode: 'INVALID-CODE', nickname: 'x', clockEpochId: client.epoch })).payload).toMatchObject({ code: 'INVALID_JOIN_CODE' });
    expect(await check(s.session.joinCode)).toMatchObject({ status: 429, body: { error: { code: 'JOIN_BLOCKED' } } });
    expect((await client.request('JOIN_SESSION', { role: 'STUDENT', joinCode: s.session.joinCode, nickname: 'x', clockEpochId: client.epoch })).payload).toMatchObject({ code: 'JOIN_BLOCKED' });
    t.clock.advance(6 * 60_000);
  });

  it('rate limits successful preflight requests as well as failed guesses', async () => {
    const s = await setup();
    await s.teacher.cmd('TEACHER_OPEN_LOBBY');
    for (let i = 0; i < 20; i++) expect((await check(s.session.joinCode)).body).toEqual({ available: true });
    expect(await check(s.session.joinCode)).toMatchObject({ status: 429, body: { error: { code: 'RATE_LIMITED' } } });
  });

  it('bounds direct peers even when forwarded IP headers rotate', async () => {
    const s = await setup();
    await s.teacher.cmd('TEACHER_OPEN_LOBBY');
    const request = (i: number) => t.server.app.inject({
      method: 'POST', url: '/api/join/check', payload: { code: s.session.joinCode },
      headers: { 'x-forwarded-for': `198.51.100.${i}` },
    });
    for (let i = 1; i <= 120; i++) expect((await request(i)).statusCode).toBe(200);
    const blocked = await request(121);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('RATE_LIMITED');
  });
});
