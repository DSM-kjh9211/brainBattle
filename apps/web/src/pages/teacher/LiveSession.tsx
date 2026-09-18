import { useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  canTransitionSession,
  PRESENTATION_VIEWS,
  SCOREBOARD_VISIBILITIES,
  type ClientMessageType,
  type ClientPayload,
  type PresentationView,
  type SessionQuestionTeacherView,
  type TeacherSessionState,
  type TeacherSubmissionView,
} from '@brainbattle/shared';
import { api } from '../../core/api';
import { useAuth } from '../../core/auth';
import { openPresentation } from '../../core/platform';
import { TEACHER_RESYNC_EVENTS, teacherReducer } from '../../core/reducers';
import { useBattle, useServerNow } from '../../core/useBattle';
import { AnswerView, LeaderboardList } from '../../components/Content';
import { ConnectionBadge, Countdown, errorText, StateBadge, Toast, useToast } from '../../components/common';
import { TYPE_LABEL } from './QuestionEditor';
import { TeacherLayout } from './TeacherLayout';

const VIEW_LABEL: Record<PresentationView, string> = {
  WAITING: '대기 화면',
  QUESTION: '문제',
  SUBMISSION_STATUS: '제출 현황',
  ANSWER: '정답',
  SCOREBOARD: '점수판',
  RESULTS: '결과',
};
const VIS_LABEL: Record<string, string> = {
  FULL: '전체 순위',
  TOP_10: 'Top 10',
  TOP_5: 'Top 5',
  TOP_3: 'Top 3',
  SELF_ONLY: '개인 점수만',
  SCORES_ONLY: '점수만',
  HIDE_RANK: '순위 숨김',
  PRIVATE: '비공개',
};

type Tab = 'control' | 'matrix' | 'grading' | 'ranking' | 'participants';

export default function LiveSession() {
  const { id = '' } = useParams();
  const { token } = useAuth();
  const { toast, show, clear } = useToast();
  const resync = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tab, setTab] = useState<Tab>('control');
  const [gradeFocus, setGradeFocus] = useState<string | null>(null);

  const battle = useBattle<TeacherSessionState>({
    enabled: !!token,
    routeKey: id,
    reducer: teacherReducer,
    join: () => ({ role: 'TEACHER', sessionId: id, authToken: token! }),
    onEvent: (env, socket) => {
      // structural changes ⇒ fetch an authoritative snapshot (cheap for one teacher client)
      if (TEACHER_RESYNC_EVENTS.has(env.type)) {
        if (resync.current) clearTimeout(resync.current);
        resync.current = setTimeout(() => socket.send('REQUEST_SNAPSHOT', {}), 80);
      }
    },
  });
  const s = battle.state;
  const now = useServerNow(battle.socket, 250);

  const cmd = async <T extends ClientMessageType>(type: T, payload: ClientPayload<T>, ok?: string) => {
    try {
      await battle.socket.current!.command(type, payload);
      if (ok) show(ok, 'success');
    } catch (e) {
      const err = e as { code?: string; message: string };
      show(errorText(err.code ?? '', err.message), 'error');
    }
  };

  const openBoard = async () => {
    const r = await api<{ token: string }>('POST', `/api/sessions/${id}/scoreboard-token`);
    await openPresentation(`${location.origin}/present/${id}?token=${encodeURIComponent(r.token)}`);
  };

  if (battle.fatal) {
    return (
      <TeacherLayout title="세션">
        <p className="error">{errorText(battle.fatal)}</p>
        <Link to="/teacher">← 대시보드</Link>
      </TeacherLayout>
    );
  }
  if (!s) {
    return (
      <TeacherLayout title="세션">
        <ConnectionBadge status={battle.status} /> 연결 중…
      </TeacherLayout>
    );
  }

  const connected = s.participants.filter((p) => p.status === 'CONNECTED').length;
  const active = s.participants.filter((p) => p.status !== 'KICKED' && p.status !== 'LEFT');
  const current = s.questions.find((q) => q.sessionQuestionId === s.currentSessionQuestionId) ?? null;
  const deadline = s.progressMode === 'SYNCHRONIZED' ? (current?.phase === 'ACTIVE' ? current.deadlineAt : null) : s.timing.deadlineAt;
  const can = (to: TeacherSessionState['state']) => canTransitionSession(s.state, to);
  const pendingManual = s.submissions.filter((x) => x.gradingStatus === 'PENDING_MANUAL').length;

  return (
    <TeacherLayout>
      <div className="live-head">
        <div>
          <h1>{s.title}</h1>
          <div className="row wrap">
            <StateBadge state={s.state} />
            <span className="muted">{s.deliveryMode === 'PAPER' ? '종이 문제지' : '디지털'} · {s.progressMode === 'FREE' ? '자유 진행' : '동시 진행'}</span>
            <ConnectionBadge status={battle.status} />
          </div>
        </div>
        <button className="join-code" title="클릭하여 복사" onClick={() => void navigator.clipboard?.writeText(s.joinCode).then(() => show('참가 코드 복사됨'))}>
          <span className="muted small">참가 코드</span>
          <b>{s.joinCode}</b>
        </button>
        <div className="live-stats">
          <div><b>{active.length}</b><span>참가자</span></div>
          <div><b>{connected}</b><span>연결</span></div>
          <div><b>{s.submissions.length}</b><span>제출</span></div>
          <div><b>{current?.displayNumber ?? '-'}</b><span>현재 문제</span></div>
          <div><Countdown deadlineAt={s.state === 'PAUSED' || s.state === 'FINISHED' ? null : deadline} now={now} /><span>남은 시간</span></div>
        </div>
      </div>

      <div className="control-bar">
        {s.state === 'CREATED' && <button className="btn primary" onClick={() => void cmd('TEACHER_OPEN_LOBBY', {})}>대기실 열기</button>}
        {s.state === 'LOBBY' && <button className="btn" onClick={() => void cmd('TEACHER_SET_READY', { ready: true })}>준비 완료</button>}
        {s.state === 'READY' && <button className="btn" onClick={() => void cmd('TEACHER_SET_READY', { ready: false })}>대기실로</button>}
        {(s.state === 'LOBBY' || s.state === 'READY') && <button className="btn primary" onClick={() => void cmd('TEACHER_START_SESSION', {}, '세션 시작')}>▶ 시작</button>}
        {can('PAUSED') && <button className="btn" onClick={() => void cmd('TEACHER_PAUSE_SESSION', {})}>⏸ 일시정지</button>}
        {s.state === 'PAUSED' && <button className="btn primary" onClick={() => void cmd('TEACHER_RESUME_SESSION', {})}>▶ 재개</button>}
        {(s.state === 'ACTIVE' || s.state === 'PAUSED') && deadline && (
          <>
            <button className="btn" onClick={() => void cmd('TEACHER_EXTEND_TIME', { seconds: 60 })}>+1분</button>
            <button className="btn" onClick={() => void cmd('TEACHER_EXTEND_TIME', { seconds: -30 })}>-30초</button>
          </>
        )}
        {s.state !== 'FINISHED' && can('FINISHED') && (
          <button className="btn danger" onClick={() => confirm('세션을 종료하고 답안을 잠그시겠습니까?') && void cmd('TEACHER_END_SESSION', {}, '세션 종료')}>■ 종료</button>
        )}
        {s.state === 'FINISHED' && !s.resultsReleased && <button className="btn primary" onClick={() => void cmd('TEACHER_RELEASE_RESULTS', {}, '결과 공개')}>결과 공개</button>}
        {s.state === 'FINISHED' && <Link className="btn" to={`/teacher/sessions/${id}/results`}>결과 분석 →</Link>}
        <div className="spacer" />
        <button className="btn" onClick={() => void openBoard()}>🖥 발표 화면 열기</button>
      </div>

      <div className="present-bar">
        <span className="muted">발표 화면:</span>
        {PRESENTATION_VIEWS.map((v) => (
          <button
            key={v}
            className={`chip ${s.presentation.view === v ? 'active' : ''}`}
            onClick={() => void cmd('TEACHER_SET_PRESENTATION', { view: v, sessionQuestionId: s.currentSessionQuestionId ?? s.presentation.sessionQuestionId })}
          >
            {VIEW_LABEL[v]}
          </button>
        ))}
        <span className="muted">점수판:</span>
        <select className="input small" value={s.scoreboard.visibility} onChange={(e) => void cmd('TEACHER_SET_SCOREBOARD', { visibility: e.target.value as never })}>
          {SCOREBOARD_VISIBILITIES.map((v) => (
            <option key={v} value={v}>{VIS_LABEL[v]}</option>
          ))}
        </select>
        <label className="checkbox">
          <input type="checkbox" checked={s.scoreboard.visible} onChange={(e) => void cmd('TEACHER_SET_SCOREBOARD', { visible: e.target.checked })} /> 공개
        </label>
      </div>

      <div className="tabs">
        {(
          [
            ['control', s.progressMode === 'SYNCHRONIZED' ? '문제 진행' : '문항 통계'],
            ['matrix', '제출 현황'],
            ['grading', `채점${pendingManual ? ` (${pendingManual})` : ''}`],
            ['ranking', '실시간 순위'],
            ['participants', `참가자 (${active.length})`],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'control' && <ControlTab s={s} cmd={cmd} total={active.length} />}
      {tab === 'matrix' && (
        <MatrixTab
          s={s}
          onCell={(subId) => {
            setGradeFocus(subId);
            setTab('grading');
          }}
        />
      )}
      {tab === 'grading' && <GradingTab s={s} cmd={cmd} focus={gradeFocus} />}
      {tab === 'ranking' && <LeaderboardList entries={s.leaderboard} />}
      {tab === 'participants' && <ParticipantsTab s={s} cmd={cmd} />}
      <Toast message={toast?.message ?? null} kind={toast?.kind} onDone={clear} />
    </TeacherLayout>
  );
}

type Cmd = <T extends ClientMessageType>(type: T, payload: ClientPayload<T>, ok?: string) => Promise<void>;

function ControlTab({ s, cmd, total }: { s: TeacherSessionState; cmd: Cmd; total: number }) {
  const stats = new Map(s.stats.map((x) => [x.sessionQuestionId, x]));
  const sync = s.progressMode === 'SYNCHRONIZED';
  const nextPending = s.questions.find((q) => q.phase === 'PENDING');
  return (
    <div className="panel">
      {sync && s.state === 'ACTIVE' && nextPending && (
        <div className="row">
          <button className="btn primary big" onClick={() => void cmd('TEACHER_START_QUESTION', { sessionQuestionId: nextPending.sessionQuestionId })}>
            ▶ 다음 문제 시작 (Q{nextPending.displayNumber})
          </button>
          <button className="btn" onClick={() => void cmd('TEACHER_START_QUESTION', { sessionQuestionId: nextPending.sessionQuestionId, countdownSec: 0 })}>
            카운트다운 없이 시작
          </button>
        </div>
      )}
      <table className="table">
        <thead>
          <tr>
            <th>번호</th>
            <th>유형</th>
            <th>문제</th>
            {sync && <th>상태</th>}
            <th>제출</th>
            <th>정답률</th>
            <th>평균</th>
            {sync && <th />}
          </tr>
        </thead>
        <tbody>
          {s.questions.map((q) => {
            const st = stats.get(q.sessionQuestionId);
            const rate = st?.correctRate;
            return (
              <tr key={q.sessionQuestionId} className={q.sessionQuestionId === s.currentSessionQuestionId ? 'current' : ''}>
                <td><b>{q.displayNumber}</b></td>
                <td>{TYPE_LABEL[q.type]}</td>
                <td className="ellipsis">{q.title ?? <span className="muted">(답안 전용)</span>}</td>
                {sync && <td><StateBadge state={q.phase} /></td>}
                <td>
                  <Bar value={st?.submitted ?? 0} max={total} label={`${st?.submitted ?? 0}/${total}`} />
                </td>
                <td>{rate === null || rate === undefined ? '-' : `${Math.round(rate * 100)}%`}{st?.pendingManual ? <span className="muted"> (대기 {st.pendingManual})</span> : null}</td>
                <td>{st?.averageScore === null || st?.averageScore === undefined ? '-' : st.averageScore.toFixed(1)}</td>
                {sync && (
                  <td className="row">
                    {q.phase === 'PENDING' && s.state === 'ACTIVE' && (
                      <button className="btn small" onClick={() => void cmd('TEACHER_START_QUESTION', { sessionQuestionId: q.sessionQuestionId })}>시작</button>
                    )}
                    {(q.phase === 'ACTIVE' || q.phase === 'PREPARE') && (
                      <button className="btn small danger" onClick={() => void cmd('TEACHER_END_QUESTION', { sessionQuestionId: q.sessionQuestionId })}>마감</button>
                    )}
                    {(q.phase === 'ACTIVE' || q.phase === 'LOCKED') && (
                      <button className="btn small" onClick={() => void cmd('TEACHER_SHOW_RESULT', { sessionQuestionId: q.sessionQuestionId })}>결과 공개</button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="bar" title={label}>
      <div className="bar-fill" style={{ width: `${pct}%` }} />
      <span>{label}</span>
    </div>
  );
}

function MatrixTab({ s, onCell }: { s: TeacherSessionState; onCell: (submissionId: string) => void }) {
  const byKey = useMemo(() => new Map(s.submissions.map((x) => [`${x.participantId}:${x.sessionQuestionId}`, x])), [s.submissions]);
  const rank = new Map(s.leaderboard.map((e) => [e.participantId, e]));
  const people = s.participants.filter((p) => p.status !== 'KICKED');
  return (
    <div className="panel matrix-wrap">
      <table className="matrix">
        <thead>
          <tr>
            <th className="sticky">학생</th>
            <th>진행</th>
            <th>점수</th>
            {s.questions.map((q) => (
              <th key={q.sessionQuestionId} title={q.title ?? ''}>{q.displayNumber}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {people.map((p) => {
            const done = s.questions.filter((q) => byKey.has(`${p.participantId}:${q.sessionQuestionId}`)).length;
            return (
              <tr key={p.participantId}>
                <td className="sticky">
                  <span className={`status-dot st-${p.status.toLowerCase()}`} title={p.status} /> {p.nickname}
                </td>
                <td>{Math.round((done / Math.max(1, s.questions.length)) * 100)}%</td>
                <td>{rank.get(p.participantId)?.score ?? 0}</td>
                {s.questions.map((q) => {
                  const sub = byKey.get(`${p.participantId}:${q.sessionQuestionId}`);
                  const cur = p.currentSessionQuestionId === q.sessionQuestionId && s.progressMode === 'FREE';
                  const cls = sub ? (sub.gradingStatus === 'PENDING_MANUAL' ? 'pend' : sub.isCorrect ? 'ok' : 'bad') : cur ? 'cur' : 'none';
                  return (
                    <td key={q.sessionQuestionId} className={`cell ${cls}`}>
                      {sub ? (
                        <button className="cell-btn" onClick={() => onCell(sub.submissionId)} title={`${sub.finalScore}점 · 수정 ${sub.revision - 1}회`}>
                          {cur ? '●' : '✓'}
                        </button>
                      ) : cur ? '●' : '-'}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted small">✓ 제출(초록 정답 · 빨강 오답 · 노랑 채점 대기) · ● 현재 선택 문제 · - 미제출 · 셀을 누르면 채점 화면으로 이동</p>
    </div>
  );
}

function GradingTab({ s, cmd, focus }: { s: TeacherSessionState; cmd: Cmd; focus: string | null }) {
  const [qFilter, setQFilter] = useState<string>(() => (focus ? (s.submissions.find((x) => x.submissionId === focus)?.sessionQuestionId ?? '') : ''));
  const [onlyPending, setOnlyPending] = useState(false);
  const names = new Map(s.participants.map((p) => [p.participantId, p.nickname]));
  const qs = new Map(s.questions.map((q) => [q.sessionQuestionId, q]));
  const list = s.submissions
    .filter((x) => (!qFilter || x.sessionQuestionId === qFilter) && (!onlyPending || x.gradingStatus === 'PENDING_MANUAL'))
    .sort((a, b) => (qs.get(a.sessionQuestionId)?.position ?? 0) - (qs.get(b.sessionQuestionId)?.position ?? 0) || (names.get(a.participantId) ?? '').localeCompare(names.get(b.participantId) ?? ''));
  return (
    <div className="panel">
      <div className="row wrap">
        <select className="input small" value={qFilter} onChange={(e) => setQFilter(e.target.value)}>
          <option value="">전체 문제</option>
          {s.questions.map((q) => (
            <option key={q.sessionQuestionId} value={q.sessionQuestionId}>Q{q.displayNumber} {q.title ?? ''}</option>
          ))}
        </select>
        <label className="checkbox"><input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} /> 채점 대기만</label>
        <span className="muted">{list.length}건</span>
      </div>
      <div className="grading-list">
        {list.map((sub) => (
          <GradeCard key={sub.submissionId} sub={sub} q={qs.get(sub.sessionQuestionId)!} name={names.get(sub.participantId) ?? '?'} cmd={cmd} focused={focus === sub.submissionId} scoringMode={s.scoringMode} />
        ))}
      </div>
    </div>
  );
}

function GradeCard({ sub, q, name, cmd, focused, scoringMode }: { sub: TeacherSubmissionView; q: SessionQuestionTeacherView; name: string; cmd: Cmd; focused: boolean; scoringMode: string }) {
  const max = scoringMode === 'CORRECT_COUNT' ? 1 : q.maxScore;
  const [custom, setCustom] = useState('');
  const [feedback, setFeedback] = useState(sub.feedback ?? '');
  const steps = max <= 1 ? [0, 1] : [0, 0.2, 0.4, 0.6, 0.8, 1].map((r) => Math.round(r * max * 100) / 100);
  const give = (score: number) => void cmd('TEACHER_SCORE_UPDATE', { submissionId: sub.submissionId, score, ...(feedback ? { feedback } : {}) }, `${name}: ${score}점`);
  return (
    <div className={`grade-card ${sub.gradingStatus === 'PENDING_MANUAL' ? 'pending' : ''} ${focused ? 'focused' : ''}`} ref={(el) => {
        if (focused) el?.scrollIntoView({ block: 'center' });
      }}>
      <div className="grade-head">
        <b>{name}</b>
        <span className="muted">Q{q.displayNumber} · {TYPE_LABEL[q.type]}</span>
        <span className={`pill ${sub.gradingStatus === 'PENDING_MANUAL' ? 'warn' : sub.isCorrect ? 'ok' : 'bad'}`}>
          {sub.gradingStatus === 'PENDING_MANUAL' ? '채점 대기' : `${sub.finalScore} / ${max}${sub.gradingStatus === 'MANUALLY_GRADED' ? ' (수동)' : ''}`}
        </span>
      </div>
      <div className="grade-answer">
        <AnswerView answer={sub.answer} />
        {sub.normalized && sub.answer.kind === 'latex' && <code className="muted small"> → {sub.normalized}</code>}
      </div>
      <div className="muted small">
        rev {sub.revision} · {sub.timestampSource === 'CLIENT_TRUSTED' ? '클라이언트 시각 신뢰' : '서버 시각'} ({sub.timestampReason})
        {sub.responseMs !== null && ` · 풀이 ${(sub.responseMs / 1000).toFixed(1)}초`}
      </div>
      <div className="row wrap">
        {steps.map((v) => (
          <button key={v} className={`btn small ${sub.finalScore === v && sub.gradingStatus !== 'PENDING_MANUAL' ? 'primary' : ''}`} onClick={() => give(v)}>
            {v}
          </button>
        ))}
        <input className="input tiny" type="number" min={0} max={max} step="any" placeholder="직접" value={custom} onChange={(e) => setCustom(e.target.value)} />
        <button className="btn small" disabled={custom === ''} onClick={() => give(Number(custom))}>적용</button>
        <input className="input small grow" placeholder="피드백 (선택)" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
      </div>
    </div>
  );
}

function ParticipantsTab({ s, cmd }: { s: TeacherSessionState; cmd: Cmd }) {
  const STATUS: Record<string, string> = { CONNECTED: '연결됨', DISCONNECTED: '연결 끊김', RECONNECTING: '재연결 중', LEFT: '나감', KICKED: '강퇴됨' };
  return (
    <div className="panel">
      <table className="table">
        <thead>
          <tr>
            <th>닉네임</th>
            <th>유형</th>
            <th>상태</th>
            <th>입장</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {s.participants.map((p) => (
            <tr key={p.participantId}>
              <td>{p.nickname}</td>
              <td>{p.isGuest ? '게스트' : '계정'}</td>
              <td><span className={`status-dot st-${p.status.toLowerCase()}`} /> {STATUS[p.status]}</td>
              <td>{new Date(p.joinedAt).toLocaleTimeString()}</td>
              <td>
                {p.status !== 'KICKED' && (
                  <button className="btn small danger" onClick={() => confirm(`${p.nickname} 학생을 강퇴할까요?`) && void cmd('TEACHER_KICK_PARTICIPANT', { participantId: p.participantId }, '강퇴 완료')}>
                    강퇴
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
