import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { QuestionSetDTO, SessionSummaryDTO } from '@brainbattle/shared';
import { api } from '../../core/api';
import { StateBadge } from '../../components/common';
import { useDialogs } from '../../components/Dialog';
import { PanelSkeleton } from '../../components/Skeleton';
import { TeacherLayout } from './TeacherLayout';

const MODE_LABEL: Record<string, string> = { DIGITAL: '디지털 문제', PAPER: '종이 문제지', SYNCHRONIZED: '동시 진행', FREE: '자유 진행' };

export default function TeacherHome() {
  const dialogs = useDialogs();
  const [sets, setSets] = useState<QuestionSetDTO[]>([]);
  const [sessions, setSessions] = useState<SessionSummaryDTO[]>([]);
  const [setsLoading, setSetsLoading] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [setsError, setSetsError] = useState(false);
  const [sessionsError, setSessionsError] = useState(false);
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();
  const ongoingSessions = sessions.filter((s) => s.state !== 'FINISHED');
  const finishedSessions = sessions.filter((s) => s.state === 'FINISHED');
  const sessionItem = (s: SessionSummaryDTO) => (
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
  );

  const load = () => {
    setSetsLoading(true);
    setSessionsLoading(true);
    setSetsError(false);
    setSessionsError(false);
    void api<QuestionSetDTO[]>('GET', '/api/question-sets').then(setSets).catch(() => setSetsError(true)).finally(() => setSetsLoading(false));
    void api<SessionSummaryDTO[]>('GET', '/api/sessions').then(setSessions).catch(() => setSessionsError(true)).finally(() => setSessionsLoading(false));
  };
  useEffect(load, []);

  const createSet = async () => {
    const title = await dialogs.input({ title: '문제 세트 만들기', label: '문제 세트 이름', confirmText: '만들기', maxLength: 200 });
    if (!title) return;
    setCreating(true);
    try {
      const s = await api<QuestionSetDTO>('POST', '/api/question-sets', { title });
      nav(`/teacher/sets/${s.id}`);
    } catch {
      await dialogs.notice({ title: '문제 세트를 만들 수 없습니다.', description: '잠시 후 다시 시도해 주세요.' });
    } finally {
      setCreating(false);
    }
  };

  return (
    <TeacherLayout title="대시보드" actions={<button className="btn primary" disabled={creating} onClick={createSet}>+ 문제 세트</button>}>
      <div className="grid-2">
        <section className="panel">
          <h2>문제 세트</h2>
          {setsLoading && <PanelSkeleton label="문제 세트" />}
          {!setsLoading && setsError && <p className="error" role="alert">문제 세트를 불러올 수 없습니다. <button className="btn small" onClick={load}>다시 시도</button></p>}
          {!setsLoading && !setsError && sets.length === 0 && <p className="muted">문제 세트가 없습니다. 새로 만들어 보세요.</p>}
          <ul className="card-list">
            {!setsLoading && sets.map((s) => (
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
                      try {
                        await api('POST', `/api/question-sets/${s.id}/duplicate`);
                        load();
                      } catch {
                        await dialogs.notice({ title: '문제 세트를 복제할 수 없습니다.', description: '잠시 후 다시 시도해 주세요.' });
                      }
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
          {sessionsLoading && <PanelSkeleton label="세션" />}
          {!sessionsLoading && sessionsError && <p className="error" role="alert">세션을 불러올 수 없습니다. <button className="btn small" onClick={load}>다시 시도</button></p>}
          {!sessionsLoading && !sessionsError && sessions.length === 0 && <p className="muted">아직 진행한 세션이 없습니다.</p>}
          <ul className="card-list">
            {!sessionsLoading && ongoingSessions.map(sessionItem)}
          </ul>
          {!sessionsLoading && !sessionsError && finishedSessions.length > 0 && (
            <details className="disclosure finished-sessions">
              <summary>완료된 세션 {finishedSessions.length}개 · 보기/숨기기</summary>
              <ul className="card-list">{finishedSessions.map(sessionItem)}</ul>
            </details>
          )}
        </section>
      </div>
    </TeacherLayout>
  );
}
