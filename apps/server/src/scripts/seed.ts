/**
 * Seeds a demo teacher and three question sets (Live Quiz / Paper Battle / Exam).
 *   npm run seed            (uses DATABASE_URL, default pglite://./.data/pglite)
 * Login: teacher@brainbattle.local / brainbattle123
 */
import { mkdirSync } from 'node:fs';
import type { QuestionInput } from '@brainbattle/shared';
import { createDb, migrate } from '../db/db.js';
import { QuestionRepository } from '../repositories/questions.js';
import { QuestionSetRepository } from '../repositories/questionSets.js';
import { UserRepository } from '../repositories/users.js';

async function main() {
  const url = process.env.DATABASE_URL ?? 'pglite://./.data/pglite';
  if (url.startsWith('pglite://') && !url.endsWith('memory')) mkdirSync(url.slice(9), { recursive: true });
  const db = await createDb(url);
  await migrate(db);
  const users = new UserRepository(db);
  const questions = new QuestionRepository(db);
  const sets = new QuestionSetRepository(db);

  const email = 'teacher@brainbattle.local';
  const teacher = (await users.findByEmail(email)) ?? (await users.create({ email, password: 'brainbattle123', displayName: '김선생', role: 'TEACHER' }));
  await users.findByEmail('student@brainbattle.local').then(
    (u) => u ?? users.create({ email: 'student@brainbattle.local', password: 'brainbattle123', displayName: '학생1', role: 'STUDENT' }),
  );

  const existing = await sets.list(teacher.id);
  if (existing.length > 0) {
    console.log(`already seeded (${existing.length} sets) for ${email}`);
    await db.close();
    return;
  }

  // ---------- Live Quiz (digital, synchronized)
  const live = await sets.create(teacher.id, { title: '수학 라이브 퀴즈', deliveryMode: 'DIGITAL', progressMode: 'SYNCHRONIZED', scoringMode: 'ACCURACY_SPEED' });
  const liveQs: QuestionInput[] = [
    {
      type: 'MULTIPLE_CHOICE',
      title: '다음 중 소수가 아닌 것은?',
      choices: [
        { id: 'a', content: [{ type: 'text', text: '2' }] },
        { id: 'b', content: [{ type: 'text', text: '9' }] },
        { id: 'c', content: [{ type: 'text', text: '13' }] },
        { id: 'd', content: [{ type: 'text', text: '17' }] },
      ],
      correctAnswer: 'b',
      score: 10,
      timeLimitSec: 20,
      explanation: [{ type: 'text', text: '9 = 3 × 3 이므로 소수가 아닙니다.' }],
    },
    { type: 'TRUE_FALSE', title: '모든 정사각형은 직사각형이다.', correctAnswer: true, score: 10, timeLimitSec: 15 },
    {
      type: 'NUMERIC',
      title: '원주율을 소수 둘째 자리까지 쓰시오.',
      correctAnswer: 3.14,
      grading: { method: 'NUMERIC', tolerance: 0.005 },
      score: 10,
      timeLimitSec: 30,
    },
    {
      type: 'LATEX',
      title: '이차방정식의 근의 공식',
      description: [
        { type: 'text', text: 'ax² + bx + c = 0 의 해 x 를 a, b, c 로 나타내시오.' },
      ],
      correctAnswer: 'x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}',
      acceptedAnswers: ['\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}'],
      grading: { method: 'LATEX', latexCommutative: true, latexIgnoreVariableAssignment: true },
      score: 20,
      timeLimitSec: 60,
    },
    {
      type: 'SHORT_ANSWER',
      title: '다음 코드의 출력은?',
      description: [{ type: 'code', language: 'python', code: 'print(len("brain"))' }],
      correctAnswer: '5',
      score: 10,
      timeLimitSec: 20,
    },
  ];
  for (const q of liveQs) {
    const created = await questions.create(teacher.id, q);
    await sets.addQuestion(live.id, teacher.id, created.id);
  }

  // ---------- Paper Battle (answer only, free progress)
  const paper = await sets.create(teacher.id, { title: '교내 수학 경시대회 (종이 문제지)', deliveryMode: 'PAPER', progressMode: 'FREE', scoringMode: 'POINT_BASED' });
  const paperAnswers: [string, QuestionInput][] = [
    ['1', { type: 'NUMERIC', deliveryMode: 'PAPER', correctAnswer: 12, score: 5 }],
    ['2', { type: 'NUMERIC', deliveryMode: 'PAPER', correctAnswer: '1/2', grading: { method: 'NUMERIC', tolerance: 0.0001 }, score: 5 }],
    ['3', { type: 'MULTIPLE_CHOICE', deliveryMode: 'PAPER', choices: [1, 2, 3, 4, 5].map((n) => ({ id: String(n), content: [] })), correctAnswer: '4', score: 5 }],
    ['4', { type: 'LATEX', deliveryMode: 'PAPER', correctAnswer: '2\\sqrt{3}', grading: { method: 'LATEX', latexNumericEquivalence: true }, score: 10 }],
    ['15-1', { type: 'LATEX', deliveryMode: 'PAPER', correctAnswer: '\\frac{\\pi}{4}', grading: { method: 'LATEX', latexNumericEquivalence: true }, score: 10 }],
    ['15-2', { type: 'SHORT_ANSWER', deliveryMode: 'PAPER', correctAnswer: '피타고라스', score: 5 }],
    ['서술형 1', { type: 'ESSAY', deliveryMode: 'PAPER', score: 20 }],
  ];
  for (const [num, q] of paperAnswers) {
    const created = await questions.create(teacher.id, { ...q, displayNumber: num });
    await sets.addQuestion(paper.id, teacher.id, created.id);
  }

  // ---------- Exam
  const exam = await sets.create(teacher.id, { title: '1학기 중간고사 (디지털)', deliveryMode: 'DIGITAL', progressMode: 'FREE', scoringMode: 'POINT_BASED' });
  for (const q of liveQs.slice(0, 4)) {
    const created = await questions.create(teacher.id, { ...q, timeLimitSec: null });
    await sets.addQuestion(exam.id, teacher.id, created.id);
  }
  const essay = await questions.create(teacher.id, {
    type: 'ESSAY',
    title: '피타고라스 정리를 증명하시오.',
    score: 20,
  });
  await sets.addQuestion(exam.id, teacher.id, essay.id);

  console.log('seeded:', { teacher: email, password: 'brainbattle123', sets: [live.title, paper.title, exam.title] });
  await db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
