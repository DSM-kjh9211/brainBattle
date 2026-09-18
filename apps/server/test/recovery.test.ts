import { describe, expect, it } from 'vitest';
import type { StudentSessionState } from '@brainbattle/shared';
import { createDb } from '../src/db/db.js';
import { ManualClock } from '../src/lib/clock.js';
import { createSession, Q, registerTeacher, startServer, TestClient } from './helpers.js';

describe('battle server failover', () => {
  it('a crashed node’s live session is recovered from the database by another node', async () => {
    const db = await createDb('pglite://memory');
    const clockA = new ManualClock(Date.UTC(2026, 8, 18, 10, 0, 0));
    const a = await startServer({ db, clock: clockA, nodeId: 'node-A' });
    const { token } = await registerTeacher(a);
    const session = await createSession(a, token, [Q.numeric(), Q.mc()], {
      settings: { progressMode: 'FREE', timing: { sessionTimeLimitSec: 120 } },
    });
    const teacher = await TestClient.connect(a);
    await teacher.joinTeacher(session.id, token);
    await teacher.cmd('TEACHER_OPEN_LOBBY');
    const stu = await TestClient.connect(a);
    const joined = await stu.joinStudent(session.joinCode, '생존자');
    await stu.sync(3);
    await teacher.cmd('TEACHER_START_SESSION');
    const st = await stu.waitFor('SESSION_STATE', (p: any) => p.questions?.length === 2);
    const sq0 = (st.payload as StudentSessionState).questions[0]!.sessionQuestionId;
    clockA.advance(10_000);
    const ok = await stu.request('SUBMIT_ANSWER', stu.submitPayload(sq0, { kind: 'numeric', raw: '3.14' }, 100));
    expect(ok.type).toBe('ANSWER_ACCEPTED');

    // ---- node A dies: sockets drop, in-memory state is lost, the lease is NOT released
    for (const rt of a.server.manager.loaded) rt.dispose('crash');
    await a.server.hub.close();
    await a.server.app.close();

    // ---- node B shares the database
    const clockB = new ManualClock(clockA.now() + 2000);
    const b = await startServer({ db, clock: clockB, nodeId: 'node-B' });
    expect(await b.server.manager.recoverOrphans()).toEqual([]); // A's lease still valid
    clockB.advance(16_000); // lease TTL (15s) expires
    expect(await b.server.manager.recoverOrphans()).toEqual([session.id]);

    // the student's pending-reconnect logic resumes on B with the same identity and answers
    const again = await TestClient.connect(b);
    const r = await again.request('JOIN_SESSION', { role: 'STUDENT', sessionId: session.id, resumeToken: joined.resumeToken, clockEpochId: again.epoch });
    expect(r.type).toBe('SESSION_STATE');
    const restored = r.payload as StudentSessionState;
    expect(restored.participantId).toBe(joined.participantId);
    expect(restored.state).toBe('ACTIVE');
    expect(restored.submissions.map((s) => s.sessionQuestionId)).toEqual([sq0]);
    expect(restored.score?.totalScore).toBe(10);

    // deadlines are persisted as absolute instants, so B rebuilds the timer and locks on time
    clockB.advance(120_000);
    await again.waitFor('SESSION_LOCKED');
    const row = await db.query<{ state: string; finished_at_ms: number; started_at_ms: number }>('SELECT state, finished_at_ms, started_at_ms FROM sessions WHERE id = $1', [session.id]);
    expect(row.rows[0]!.state).toBe('FINISHED');
    expect(Number(row.rows[0]!.finished_at_ms) - Number(row.rows[0]!.started_at_ms)).toBe(120_000);

    await b.close();
    await db.close();
  });
});
