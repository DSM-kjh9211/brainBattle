import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { OwnSubmissionView, QuestionReveal, StudentQuestionView } from '@brainbattle/shared';
import { useAuth } from '../../core/auth';
import { studentReducer, type StudentView } from '../../core/reducers';
import { useBattle, useServerNow } from '../../core/useBattle';
import { AnswerInput, emptyDraft, isDraftComplete, type Draft } from '../../components/AnswerInput';
import { AnswerView, ContentBlocks, CorrectAnswerView } from '../../components/Content';
import { ConnectionBadge, Countdown, errorText, StateBadge, Toast, useToast } from '../../components/common';

interface Identity {
  sessionId: string;
  resumeToken: string;
  nickname: string;
}

const idKey = (code: string) => `bb.identity.${code}`;
const draftKey = (code: string) => `bb.drafts.${code}`;

function readJSON<T>(k: string): T | null {
  try {
    const raw = localStorage.getItem(k);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function writeJSON(k: string, v: unknown) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

export function PlayPage() {
  const { code = '' } = useParams();
  const { user, token } = useAuth();
  const identityRef = useRef<Identity | null>(readJSON<Identity>(idKey(code)));
  const [nickname, setNickname] = useState(identityRef.current?.nickname ?? '');
  const [useAccount, setUseAccount] = useState(false);
  const [started, setStarted] = useState(!!identityRef.current);
  const { toast, show, clear } = useToast();

  const battle = useBattle<StudentView>({
    enabled: started,
    pendingKey: `bb.pending.${code}`,
    reducer: studentReducer,
    join: (epoch) => {
      const id = identityRef.current;
      if (id) return { role: 'STUDENT', sessionId: id.sessionId, resumeToken: id.resumeToken, clockEpochId: epoch };
      return {
        role: 'STUDENT',
        joinCode: code,
        nickname: nickname.trim(),
        clockEpochId: epoch,
        ...(useAccount && token ? { authToken: token } : {}),
      };
    },
    onEvent: (env) => {
      if (env.type === 'SESSION_STATE') {
        const p = env.payload as StudentView;
        if (p.role === 'STUDENT' && p.resumeToken) {
          identityRef.current = { sessionId: p.sessionId, resumeToken: p.resumeToken, nickname: p.nickname };
          writeJSON(idKey(code), identityRef.current);
        }
      }
      if (env.type === 'ANSWER_REJECTED') {
        const p = env.payload as { code: string; message: string };
        show(errorText(p.code, p.message), 'error');
      }
      if (env.type === 'ANSWER_ACCEPTED' || env.type === 'ANSWER_UPDATED') {
        const p = env.payload as { duplicate: boolean };
        if (!p.duplicate) show(env.type === 'ANSWER_ACCEPTED' ? '제출 완료' : '수정 완료', 'success');
      }
    },
  });

  // resume failed ⇒ forget the stale identity and show the join form again
  useEffect(() => {
    if (battle.fatal === 'INVALID_RESUME_TOKEN') {
      writeJSON(idKey(code), null);
      identityRef.current = null;
      setStarted(false);
    }
  }, [battle.fatal, code]);

  const s = battle.state;

  if (!started || (!s && battle.fatal && battle.fatal !== 'INVALID_RESUME_TOKEN')) {
    return (
      <div className="home">
        <form
          className="home-card"
          onSubmit={(e) => {
            e.preventDefault();
            if (nickname.trim()) setStarted(true);
          }}
        >
          <div className="brand small">
            <span className="brand-mark">B</span> BrainBattle
          </div>
          <p>
            참가 코드 <b className="code-chip">{code}</b>
          </p>
          {battle.fatal && <p className="error">{errorText(battle.fatal)}</p>}
          <input
            className="input"
            placeholder="닉네임 (이름)"
            maxLength={20}
            value={nickname}
            autoFocus
            onChange={(e) => setNickname(e.target.value)}
          />
          {user && (
            <label className="checkbox">
              <input type="checkbox" checked={useAccount} onChange={(e) => setUseAccount(e.target.checked)} /> {user.displayName} 계정으로 참가
            </label>
          )}
          <button className="btn primary big" disabled={!nickname.trim()}>
            입장
          </button>
          <Link to="/" className="muted small">
            ← 다른 코드 입력
          </Link>
        </form>
      </div>
    );
  }

  if (!s) {
    return (
      <div className="page-loading">
        <ConnectionBadge status={battle.status} /> 세션에 연결하는 중…
      </div>
    );
  }

  return (
    <div className="play">
      <PlayHeader s={s} status={battle.status} pending={battle.pendingCount} socket={battle.socket} />
      {s.kicked || battle.fatal === 'KICKED' ? (
        <div className="center-msg">
          <h2>세션에서 제외되었습니다</h2>
          <Link to="/">처음으로</Link>
        </div>
      ) : (
        <StudentBody s={s} battle={battle} code={code} />
      )}
      <Toast message={toast?.message ?? null} kind={toast?.kind} onDone={clear} />
    </div>
  );
}

type Battle = ReturnType<typeof useBattle<StudentView>>;

function PlayHeader({ s, status, pending, socket }: { s: StudentView; status: Battle['status']; pending: number; socket: Battle['socket'] }) {
  const now = useServerNow(socket, 250);
  const deadline = s.progressMode === 'SYNCHRONIZED' ? (s.currentPhase === 'ACTIVE' ? s.questionDeadlineAt : null) : s.timing.deadlineAt;
  return (
    <header className="play-header">
      <div className="brand small">
        <span className="brand-mark">B</span>
        <span className="hide-sm">{s.title}</span>
      </div>
      <StateBadge state={s.state} />
      <Countdown deadlineAt={s.state === 'PAUSED' || s.state === 'FINISHED' || s.locked ? null : deadline} now={now} />
      <div className="spacer" />
      {s.score && (
        <span className="my-score" title="내 점수">
          {s.score.rank !== null && <b>{s.score.rank}위 · </b>}
          {s.score.totalScore.toLocaleString()}점
        </span>
      )}
      <span className="nick">{s.nickname}</span>
      <ConnectionBadge status={status} pending={pending} />
    </header>
  );
}

function StudentBody({ s, battle, code }: { s: StudentView; battle: Battle; code: string }) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => readJSON(draftKey(code)) ?? {});
  useEffect(() => writeJSON(draftKey(code), drafts), [drafts, code]);
  const subs = useMemo(() => new Map(s.submissions.map((x) => [x.sessionQuestionId, x])), [s.submissions]);
  const reveals = useMemo(() => new Map(s.reveals.map((r) => [r.sessionQuestionId, r])), [s.reveals]);
  const now = useServerNow(battle.socket, 250);

  const submit = useCallback(
    (q: StudentQuestionView) => {
      const d = drafts[q.sessionQuestionId] ?? null;
      if (!isDraftComplete(d)) return;
      const existing = subs.get(q.sessionQuestionId);
      battle.socket.current?.submit(q.sessionQuestionId, d, existing?.revision);
      battle.refreshPending();
    },
    [drafts, subs, battle],
  );

  if (s.state === 'CREATED' || s.state === 'LOBBY' || s.state === 'READY') {
    return (
      <div className="center-msg lobby">
        <div className="pulse-ring" />
        <h2>{s.nickname} 님, 입장 완료!</h2>
        <p>선생님이 시작하면 문제가 나타납니다.</p>
        <p className="muted">현재 참가자 {s.participantCount}명</p>
      </div>
    );
  }

  const finished = s.state === 'FINISHED' || s.locked;
  const pausedOverlay = s.state === 'PAUSED' && (
    <div className="overlay">
      <div className="overlay-card">⏸ 일시정지 — 잠시 기다려 주세요</div>
    </div>
  );

  if (finished) return <FinishedView s={s} subs={subs} reveals={reveals} />;

  if (s.progressMode === 'SYNCHRONIZED') {
    const q = s.questions.find((x) => x.sessionQuestionId === s.currentSessionQuestionId) ?? null;
    if (!q || s.currentPhase === 'PREPARE' || s.currentPhase === 'PENDING') {
      return (
        <div className="center-msg">
          {pausedOverlay}
          {s.currentPhase === 'PREPARE' && s.questionOpensAt ? (
            <>
              <p className="muted">다음 문제</p>
              <div className="prepare-count">{Math.max(0, Math.ceil((s.questionOpensAt - now) / 1000))}</div>
            </>
          ) : (
            <h2>다음 문제를 기다리는 중…</h2>
          )}
        </div>
      );
    }
    const open = s.currentPhase === 'ACTIVE' && s.state === 'ACTIVE';
    return (
      <main className="play-main">
        {pausedOverlay}
        <QuestionPanel
          q={q}
          s={s}
          draft={drafts[q.sessionQuestionId] ?? emptyDraft(q)}
          onDraft={(d) => setDrafts((m) => ({ ...m, [q.sessionQuestionId]: d }))}
          sub={subs.get(q.sessionQuestionId)}
          reveal={reveals.get(q.sessionQuestionId)}
          open={open}
          pending={battle.socket.current?.pending?.has(q.sessionQuestionId) ?? false}
          online={battle.status === 'live'}
          onSubmit={() => submit(q)}
        />
      </main>
    );
  }

  return (
    <FreeProgress
      s={s}
      drafts={drafts}
      setDrafts={setDrafts}
      subs={subs}
      reveals={reveals}
      battle={battle}
      submit={submit}
      overlay={pausedOverlay}
    />
  );
}

function FreeProgress({
  s,
  drafts,
  setDrafts,
  subs,
  reveals,
  battle,
  submit,
  overlay,
}: {
  s: StudentView;
  drafts: Record<string, Draft>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, Draft>>>;
  subs: Map<string, OwnSubmissionView>;
  reveals: Map<string, QuestionReveal>;
  battle: Battle;
  submit: (q: StudentQuestionView) => void;
  overlay: React.ReactNode;
}) {
  const [picked, setSelected] = useState<string | null>(s.selectedSessionQuestionId);
  // the question list may arrive after this component mounted (SESSION_START → SESSION_STATE)
  const selected = picked && s.questions.some((q) => q.sessionQuestionId === picked) ? picked : (s.questions[0]?.sessionQuestionId ?? null);
  const idx = s.questions.findIndex((q) => q.sessionQuestionId === selected);
  const q = s.questions[idx] ?? null;

  const select = useCallback(
    (id: string) => setSelected(id),
    [battle.socket],
  );

  useEffect(() => {
    if (selected && battle.status === 'live') battle.socket.current?.send('STUDENT_SELECT_QUESTION', { sessionQuestionId: selected });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [battle.status === 'live', selected]);

  // Alt+←/→ moves between questions without the mouse
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
      const n = s.questions[idx + (e.key === 'ArrowRight' ? 1 : -1)];
      if (n) {
        e.preventDefault();
        select(n.sessionQuestionId);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [idx, s.questions, select]);

  const pendingSet = new Set(battle.socket.current?.pending?.list().map((p) => p.payload.sessionQuestionId) ?? []);
  const answered = s.questions.filter((x) => subs.has(x.sessionQuestionId)).length;

  return (
    <main className="play-free">
      {overlay}
      <nav className="q-grid" aria-label="문제 목록">
        <div className="q-grid-head">
          제출 {answered}/{s.questions.length}
        </div>
        <div className="q-grid-cells">
          {s.questions.map((x) => {
            const st = pendingSet.has(x.sessionQuestionId) ? 'pending' : subs.has(x.sessionQuestionId) ? 'done' : 'none';
            const sel = x.sessionQuestionId === selected;
            return (
              <button
                key={x.sessionQuestionId}
                className={`q-cell ${st} ${sel ? 'selected' : ''}`}
                onClick={() => select(x.sessionQuestionId)}
                aria-current={sel}
                title={st === 'done' ? '제출 완료' : st === 'pending' ? '전송 대기' : '미제출'}
              >
                <span className="q-num">{x.displayNumber}</span>
                <span className="q-mark">{sel ? '●' : st === 'done' ? '✓' : st === 'pending' ? '…' : '-'}</span>
              </button>
            );
          })}
        </div>
      </nav>
      {q && (
        <section className="play-main">
          <QuestionPanel
            q={q}
            s={s}
            draft={drafts[q.sessionQuestionId] ?? emptyDraft(q)}
            onDraft={(d) => setDrafts((m) => ({ ...m, [q.sessionQuestionId]: d }))}
            sub={subs.get(q.sessionQuestionId)}
            reveal={reveals.get(q.sessionQuestionId)}
            open={s.state === 'ACTIVE'}
            pending={pendingSet.has(q.sessionQuestionId)}
            online={battle.status === 'live'}
            onSubmit={() => submit(q)}
          />
          <div className="q-nav">
            <button className="btn" disabled={idx <= 0} onClick={() => select(s.questions[idx - 1]!.sessionQuestionId)}>
              ← 이전
            </button>
            <span className="muted small">Alt + ←/→</span>
            <button className="btn" disabled={idx >= s.questions.length - 1} onClick={() => select(s.questions[idx + 1]!.sessionQuestionId)}>
              다음 →
            </button>
          </div>
        </section>
      )}
    </main>
  );
}

function QuestionPanel(props: {
  q: StudentQuestionView;
  s: StudentView;
  draft: Draft;
  onDraft: (d: Draft) => void;
  sub: OwnSubmissionView | undefined;
  reveal: QuestionReveal | undefined;
  open: boolean;
  pending: boolean;
  online: boolean;
  onSubmit: () => void;
}) {
  const { q, s, draft, onDraft, sub, reveal, open, pending, online, onSubmit } = props;
  const lockedAfterSubmit = !!sub && s.editPolicy === 'NO_EDIT';
  const canEdit = open && !lockedAfterSubmit;
  const complete = isDraftComplete(draft);
  const paper = q.deliveryMode === 'PAPER';
  return (
    <article className="question-card">
      <div className="q-head">
        <span className="q-number">문제 {q.displayNumber}{paper ? '번' : ''}</span>
        <span className="muted small">{q.maxScore}점</span>
      </div>
      {!paper && (
        <>
          {q.title && <h2 className="q-title">{q.title}</h2>}
          <ContentBlocks blocks={q.description} />
        </>
      )}
      <div className="answer-area">
        <div className="answer-label">답:</div>
        <AnswerInput question={q} draft={draft} onChange={onDraft} onSubmit={() => canEdit && complete && onSubmit()} disabled={!canEdit} />
      </div>
      <div className="submit-row">
        <SubmissionStatus sub={sub} pending={pending} online={online} />
        <button className="btn primary big" disabled={!canEdit || !complete || pending} onClick={onSubmit}>
          {pending ? '전송 중…' : lockedAfterSubmit ? '제출 완료 (수정 불가)' : sub ? '수정 제출' : '제출'}
        </button>
      </div>
      {sub && sub.isCorrect !== undefined && (
        <div className={`grade ${sub.gradingStatus === 'PENDING_MANUAL' ? 'pending' : sub.isCorrect ? 'correct' : 'wrong'}`}>
          {sub.gradingStatus === 'PENDING_MANUAL' ? '채점 대기 중' : sub.isCorrect ? `정답! +${sub.score}` : `오답 (${sub.score ?? 0}점)`}
          {sub.feedback && <div className="feedback">💬 {sub.feedback}</div>}
        </div>
      )}
      {reveal && (
        <div className="reveal">
          <div>
            정답: <CorrectAnswerView value={reveal.correctAnswer} choices={q.choices} isLatex={q.type === 'LATEX'} />
          </div>
          <ContentBlocks blocks={reveal.explanation} />
        </div>
      )}
      {!open && !sub && <p className="muted">제출이 마감되었습니다.</p>}
    </article>
  );
}

function SubmissionStatus({ sub, pending, online }: { sub?: OwnSubmissionView; pending: boolean; online: boolean }) {
  if (pending) return <span className="sub-status pending">{online ? 'SUBMIT_PENDING — 서버 확인 중' : '오프라인 — 재연결 시 자동 전송'}</span>;
  if (sub)
    return (
      <span className="sub-status done">
        ✓ 제출됨 (수정 {sub.revision - 1}회){sub.timestampSource === 'SERVER_FALLBACK' ? ' · 서버 시각 기준' : ''}
      </span>
    );
  return <span className="sub-status none">미제출</span>;
}

function FinishedView({ s, subs, reveals }: { s: StudentView; subs: Map<string, OwnSubmissionView>; reveals: Map<string, QuestionReveal> }) {
  return (
    <main className="play-main finished">
      <h2>시험/퀴즈가 종료되었습니다</h2>
      {s.score && (
        <div className="final-score">
          {s.score.rank !== null && <div className="final-rank">{s.score.rank}위</div>}
          <div>{s.score.totalScore.toLocaleString()}점 · 정답 {s.score.correctCount}개</div>
        </div>
      )}
      {!s.resultsReleased && <p className="muted">결과는 선생님이 공개하면 확인할 수 있습니다.</p>}
      <table className="table">
        <thead>
          <tr>
            <th>문제</th>
            <th>내 답</th>
            <th>결과</th>
            <th>정답</th>
          </tr>
        </thead>
        <tbody>
          {s.questions.map((q) => {
            const sub = subs.get(q.sessionQuestionId);
            const rv = reveals.get(q.sessionQuestionId);
            return (
              <tr key={q.sessionQuestionId}>
                <td>{q.displayNumber}</td>
                <td>{sub ? <AnswerView answer={sub.answer} choices={q.choices} /> : <span className="muted">-</span>}</td>
                <td>
                  {sub?.isCorrect === undefined
                    ? '비공개'
                    : sub.gradingStatus === 'PENDING_MANUAL'
                      ? '채점 대기'
                      : `${sub.isCorrect ? '✓' : '✗'} ${sub.score ?? 0}점`}
                </td>
                <td>{rv ? <CorrectAnswerView value={rv.correctAnswer} choices={q.choices} isLatex={q.type === 'LATEX'} /> : '-'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Link to="/" className="btn">처음으로</Link>
    </main>
  );
}
