import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiClient } from '../src/services/aiService.js';
import { api, Q, registerStudent, registerTeacher, startServer, type TestServer } from './helpers.js';

const draft = (over: Record<string, unknown> = {}) => ({
  type: 'MULTIPLE_CHOICE',
  title: '2+2?',
  body: '',
  code: '',
  codeLanguage: '',
  choices: ['3', '4', '5', '6'],
  correctChoices: [2],
  correctBoolean: false,
  correctAnswer: '',
  acceptedAnswers: [],
  numericTolerance: 0,
  explanation: '$2+2=4$',
  score: 10,
  timeLimitSec: 30,
  tags: ['덧셈'],
  ...over,
});

/** Scripted model: replies are queued per test, requests are recorded. */
class FakeAi implements AiClient {
  replies: unknown[] = [];
  requests: { system: string; prompt: string }[] = [];
  async complete(req: { system: string; prompt: string }) {
    this.requests.push(req);
    return this.replies.shift();
  }
}

const fake = new FakeAi();
let t: TestServer;
let off: TestServer;
let token: string;
beforeAll(async () => {
  t = await startServer({ ai: fake });
  off = await startServer();
  token = (await registerTeacher(t)).token;
});
afterAll(async () => {
  await t.close();
  await off.close();
});

describe('AI authoring assistant', () => {
  it('is disabled without an API key', async () => {
    const teacher = await registerTeacher(off);
    expect((await api(off, 'GET', '/api/ai/status', undefined, teacher.token)).body).toEqual({ enabled: false });
    const r = await api(off, 'POST', '/api/ai/questions/generate', { topic: '분수' }, teacher.token);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('AI_UNAVAILABLE');
  });

  it('is teacher-only', async () => {
    const s = await registerStudent(t);
    expect((await api(t, 'POST', '/api/ai/questions/generate', { topic: '분수' }, s.token)).status).toBe(403);
    expect((await api(t, 'POST', '/api/ai/questions/generate', { topic: '분수' })).status).toBe(401);
  });

  it('generates drafts that the question API accepts, dropping unusable ones', async () => {
    fake.replies = [
      {
        questions: [
          draft(),
          draft({ correctChoices: [9] }), // points at no choice
          draft({ type: 'NUMERIC', choices: [], correctChoices: [], correctAnswer: '3.14', numericTolerance: 0.01 }),
          draft({ type: 'TRUE_FALSE', choices: [], correctChoices: [], correctBoolean: true }),
          draft({ type: 'SHORT_ANSWER', choices: [], correctChoices: [], correctAnswer: '' }), // no answer
          draft({ correctChoices: [1, 3] }),
        ],
      },
    ];
    const r = await api(t, 'POST', '/api/ai/questions/generate', { topic: '사칙연산', count: 6, types: ['MULTIPLE_CHOICE', 'NUMERIC'] }, token);
    expect(r.status).toBe(200);
    expect(r.body.dropped).toBe(2);
    expect(r.body.questions.map((q: any) => q.type)).toEqual(['MULTIPLE_CHOICE', 'NUMERIC', 'TRUE_FALSE', 'MULTIPLE_CHOICE']);
    expect(r.body.questions[0]).toMatchObject({ correctAnswer: '2', choices: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }] });
    expect(r.body.questions[1]).toMatchObject({ correctAnswer: 3.14, grading: { method: 'NUMERIC', tolerance: 0.01 } });
    expect(r.body.questions[2].correctAnswer).toBe(true);
    expect(r.body.questions[3]).toMatchObject({ correctAnswer: ['1', '3'], grading: { multipleSelect: true } });
    expect(fake.requests.at(-1)!.prompt).toContain('사칙연산');
    expect(fake.requests.at(-1)!.prompt).toContain('MULTIPLE_CHOICE, NUMERIC');
    for (const q of r.body.questions) expect((await api(t, 'POST', '/api/questions', q, token)).status).toBe(200);
  });

  it('saves drafts atomically: batch endpoints roll back when one question is invalid', async () => {
    const bad = Q.mc({ correctAnswer: 'zzz' });
    const count = async () => (await api(t, 'GET', '/api/questions', undefined, token)).body.length;
    const sets = async () => (await api(t, 'GET', '/api/question-sets', undefined, token)).body.length;
    const before = await count();
    const setsBefore = await sets();

    expect((await api(t, 'POST', '/api/questions/batch', { questions: [Q.mc(), bad] }, token)).status).toBe(400);
    expect((await api(t, 'POST', '/api/question-sets', { title: 'AI 세트', questions: [Q.mc(), bad] }, token)).status).toBe(400);
    expect(await count()).toBe(before);
    expect(await sets()).toBe(setsBefore);

    expect((await api(t, 'POST', '/api/questions/batch', { questions: [Q.mc(), Q.numeric()] }, token)).body).toHaveLength(2);
    const set = await api(t, 'POST', '/api/question-sets', { title: 'AI 세트', questions: [Q.mc(), Q.numeric()] }, token);
    expect(set.body.items.map((i: any) => i.position)).toEqual([0, 1]);
    const more = await api(t, 'POST', `/api/question-sets/${set.body.id}/questions/batch`, { questions: [Q.essay()] }, token);
    expect(more.body.items).toHaveLength(3);
    const other = await registerTeacher(t);
    expect((await api(t, 'POST', `/api/question-sets/${set.body.id}/questions/batch`, { questions: [Q.essay()] }, other.token)).status).toBe(403);
  });

  it('fails when the model returns nothing usable', async () => {
    fake.replies = [{ questions: [draft({ correctChoices: [] })] }];
    const r = await api(t, 'POST', '/api/ai/questions/generate', { topic: 'x' }, token);
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('AI_FAILED');
  });

  it('validates the request before calling the model', async () => {
    const before = fake.requests.length;
    expect((await api(t, 'POST', '/api/ai/questions/generate', { topic: '', count: 3 }, token)).status).toBe(400);
    expect((await api(t, 'POST', '/api/ai/questions/generate', { topic: 'x', count: 500 }, token)).status).toBe(400);
    expect(fake.requests.length).toBe(before);
  });

  it('generates a set draft with title and description', async () => {
    fake.replies = [{ title: '분수 퀴즈', description: '분수의 덧셈과 뺄셈', questions: [draft(), draft({ title: '3+3?' })] }];
    const r = await api(t, 'POST', '/api/ai/question-sets/generate', { topic: '분수', count: 2 }, token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ title: '분수 퀴즈', description: '분수의 덧셈과 뺄셈', dropped: 0 });
    expect(r.body.questions).toHaveLength(2);
  });

  it('reviews a question; the revision keeps media and delivery settings the model never saw', async () => {
    fake.replies = [
      {
        verdict: 'NEEDS_FIX',
        summary: '정답이 틀렸습니다.',
        issues: [{ severity: 'ERROR', field: 'ANSWER', message: '2+2는 4입니다.', suggestion: '정답을 4로 바꾸세요.' }],
        revised: draft(),
      },
    ];
    const image = { type: 'image', url: 'data:image/png;base64,AAAA' };
    const question = Q.mc({ correctAnswer: 'a', displayNumber: '7', description: [{ type: 'text', text: '계산하시오' }, image] as never });
    const r = await api(t, 'POST', '/api/ai/questions/review', { question }, token);
    expect(r.status).toBe(200);
    expect(r.body.verdict).toBe('NEEDS_FIX');
    expect(r.body.issues).toHaveLength(1);
    expect(r.body.revised).toMatchObject({ correctAnswer: '2', displayNumber: '7' });
    expect(r.body.revised.description).toContainEqual(image);
    const sent = fake.requests.at(-1)!.prompt;
    expect(sent).toContain('[image attached]');
    expect(sent).not.toContain('base64');
    expect((await api(t, 'POST', '/api/questions', r.body.revised, token)).status).toBe(200);
  });

  it('reviews a set and maps issues back to set items; other teachers cannot review it', async () => {
    const set = await api(t, 'POST', '/api/question-sets', { title: '세트' }, token);
    await api(t, 'POST', `/api/question-sets/${set.body.id}/questions`, Q.mc(), token);
    const withTwo = await api(t, 'POST', `/api/question-sets/${set.body.id}/questions`, Q.numeric(), token);
    fake.replies = [
      {
        summary: '대체로 양호',
        issues: [
          { questionNumber: 2, severity: 'WARNING', message: '허용 오차가 좁습니다.', suggestion: null },
          { questionNumber: 0, severity: 'INFO', message: '문항 수가 적습니다.', suggestion: '문항을 추가하세요.' },
        ],
      },
    ];
    const r = await api(t, 'POST', `/api/ai/question-sets/${set.body.id}/review`, {}, token);
    expect(r.status).toBe(200);
    expect(r.body.issues[0]).toMatchObject({ itemId: withTwo.body.items[1].id, displayNumber: '2' });
    expect(r.body.issues[1]).toMatchObject({ itemId: null, displayNumber: null });
    const other = await registerTeacher(t);
    expect((await api(t, 'POST', `/api/ai/question-sets/${set.body.id}/review`, {}, other.token)).status).toBe(403);
  });
});
