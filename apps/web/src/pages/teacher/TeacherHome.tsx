import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { QuestionSetDTO, SessionSummaryDTO } from '@brainbattle/shared';
import { api } from '../../core/api';
import { StateBadge } from '../../components/common';
import { TeacherLayout } from './TeacherLayout';

const MODE_LABEL: Record<string, string> = { DIGITAL: '디지털 문제', PAPER: '종이 문제지', SYNCHRONIZED: '동시 진행', FREE: '자유 진행' };

export default function TeacherHome() {
  const [sets, setSets] = useState<QuestionSetDTO[]>([]);
  const [sessions, setSessions] = useState<SessionSummaryDTO[]>([]);
  const nav = useNavigate();

  const load = () => {
    void api<QuestionSetDTO[]>('GET', '/api/question-sets').then(setSets);
    void api<SessionSummaryDTO[]>('GET', '/api/sessions').then(setSessions);
  };
  useEffect(load, []);

  const createSet = async () => {
    const title = prompt('문제 세트 이름');
    if (!title) return;
    const s = await api<QuestionSetDTO>('POST', '/api/question-sets', { title });
    nav(`/teacher/sets/${s.id}`);
  };

  return (
    <TeacherLayout title="대시보드" actions={<button className="btn primary" onClick={createSet}>+ 문제 세트</button>}>
      <div className="grid-2">
        <section className="panel">
          <h2>문제 세트</h2>
          {sets.length === 0 && <p className="muted">문제 세트가 없습니다. 새로 만들어 보세요.</p>}
          <ul className="card-list">
            {sets.map((s) => (
              <li key={s.id} className="card-item">
                <div>
                  <Link to={`/teacher/sets/${s.id}`} className="card-title">{s.title}</Link>
                  <div className="muted small">
                    {s.questionCount}문항 · {MODE_LABEL[s.deliveryMode]} · {MODE_LABEL[s.progressMode]}
                  </div>
                </div>
                <div className="row">
                  <button className="btn" onClick={() => nav(`/teacher/sessions/new?set=${s.id}`)}>세션 시작</button>
                  <button
                    className="btn ghost"
                    title="세트 복제"
                    onClick={async () => {
                      await api('POST', `/api/question-sets/${s.id}/duplicate`);
                      load();
                    }}
                  >
                    ⧉
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section className="panel">
          <h2>세션</h2>
          {sessions.length === 0 && <p className="muted">아직 진행한 세션이 없습니다.</p>}
          <ul className="card-list">
            {sessions.map((s) => (
              <li key={s.id} className="card-item">
                <div>
                  <Link to={`/teacher/sessions/${s.id}`} className="card-title">{s.title}</Link>
                  <div className="muted small">
                    코드 <b>{s.joinCode}</b> · {s.participantCount}명 · {new Date(s.createdAt).toLocaleString()}
                  </div>
                </div>
                <div className="row">
                  <StateBadge state={s.state} />
                  <Link className="btn ghost" to={`/teacher/sessions/${s.id}/results`}>결과</Link>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </TeacherLayout>
  );
}
