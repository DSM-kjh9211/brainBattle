import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AnswerPayload, LeaderboardEntry, QuestionType } from '@brainbattle/shared';
import { api, downloadWithAuth } from '../../core/api';
import { AnswerView, LeaderboardList } from '../../components/Content';
import { StateBadge } from '../../components/common';
import { TYPE_LABEL } from './QuestionEditor';
import { TeacherLayout } from './TeacherLayout';

interface ResultData {
  session: { id: string; title: string; state: string; startedAt: number | null; finishedAt: number | null };
  questions: {
    sessionQuestionId: string;
    displayNumber: string;
    type: QuestionType;
    title: string | null;
    maxScore: number;
    submitted: number;
    correct: number;
    pendingManual: number;
    submissionRate: number;
    correctRate: number | null;
    averageScore: number | null;
    averageResponseMs: number | null;
  }[];
  leaderboard: LeaderboardEntry[];
  participants: { participantId: string; nickname: string; status: string }[];
  submissions: { participantId: string; sessionQuestionId: string; answer: AnswerPayload; isCorrect: boolean | null; finalScore: number; gradingStatus: string }[];
}

export default function Results() {
  const { id = '' } = useParams();
  const [data, setData] = useState<ResultData | null>(null);
  const [q, setQ] = useState<string | null>(null);
  useEffect(() => void api<ResultData>('GET', `/api/sessions/${id}/results`).then(setData), [id]);
  const byKey = useMemo(() => new Map((data?.submissions ?? []).map((s) => [`${s.participantId}:${s.sessionQuestionId}`, s])), [data]);
  if (!data) return <TeacherLayout title="결과">불러오는 중…</TeacherLayout>;

  const scores = data.leaderboard.map((e) => e.score ?? 0);
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const maxTotal = data.questions.reduce((a, x) => a + x.maxScore, 0);
  const hardest = [...data.questions].filter((x) => x.correctRate !== null && x.correctRate < 1).sort((a, b) => a.correctRate! - b.correctRate!).slice(0, 3);
  const detail = q ? data.questions.find((x) => x.sessionQuestionId === q) : null;

  return (
    <TeacherLayout
      title={`결과 분석 — ${data.session.title}`}
      actions={
        <>
          <StateBadge state={data.session.state} />
          <button className="btn" onClick={() => void downloadWithAuth(`/api/sessions/${id}/results.csv`, `brainbattle-${id}.csv`)}>CSV 내보내기</button>
          <Link className="btn" to={`/teacher/sessions/${id}`}>세션 화면</Link>
        </>
      }
    >
      <div className="stat-cards">
        <div className="stat"><b>{data.leaderboard.length}</b><span>참가자</span></div>
        <div className="stat"><b>{avg.toFixed(1)}</b><span>평균 점수 / {maxTotal}</span></div>
        <div className="stat"><b>{scores.length ? Math.max(...scores) : 0}</b><span>최고 점수</span></div>
        <div className="stat"><b>{hardest.map((h) => h.displayNumber).join(', ') || '-'}</b><span>정답률 낮은 문항</span></div>
      </div>
      <div className="grid-2">
        <section className="panel">
          <h2>문항별 분석</h2>
          <table className="table">
            <thead>
              <tr>
                <th>번호</th>
                <th>유형</th>
                <th>제출률</th>
                <th>정답률</th>
                <th>평균</th>
                <th>평균 풀이</th>
              </tr>
            </thead>
            <tbody>
              {data.questions.map((x) => (
                <tr key={x.sessionQuestionId} className={q === x.sessionQuestionId ? 'current' : ''} onClick={() => setQ(x.sessionQuestionId)} style={{ cursor: 'pointer' }}>
                  <td><b>{x.displayNumber}</b></td>
                  <td>{TYPE_LABEL[x.type]}</td>
                  <td>{Math.round(x.submissionRate * 100)}%</td>
                  <td>
                    <div className="bar"><div className="bar-fill" style={{ width: `${(x.correctRate ?? 0) * 100}%` }} /><span>{x.correctRate === null ? '-' : `${Math.round(x.correctRate * 100)}%`}</span></div>
                  </td>
                  <td>{x.averageScore === null ? '-' : `${x.averageScore.toFixed(1)}/${x.maxScore}`}</td>
                  <td>{x.averageResponseMs === null ? '-' : `${(x.averageResponseMs / 1000).toFixed(1)}s`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="panel">
          <h2>최종 순위</h2>
          <LeaderboardList entries={data.leaderboard} />
        </section>
      </div>
      {detail && (
        <section className="panel">
          <h2>Q{detail.displayNumber} 학생별 답안</h2>
          <table className="table">
            <tbody>
              {data.participants.map((p) => {
                const sub = byKey.get(`${p.participantId}:${detail.sessionQuestionId}`);
                return (
                  <tr key={p.participantId}>
                    <td>{p.nickname}</td>
                    <td>{sub ? <AnswerView answer={sub.answer} /> : <span className="muted">미제출</span>}</td>
                    <td>{sub ? (sub.gradingStatus === 'PENDING_MANUAL' ? '채점 대기' : `${sub.isCorrect ? '✓' : '✗'} ${sub.finalScore}`) : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </TeacherLayout>
  );
}
