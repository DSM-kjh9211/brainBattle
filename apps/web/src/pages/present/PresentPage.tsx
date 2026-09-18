import { useParams, useSearchParams } from 'react-router-dom';
import type { ScoreboardSessionState } from '@brainbattle/shared';
import { boardReducer } from '../../core/reducers';
import { useBattle, useServerNow } from '../../core/useBattle';
import { ChoiceContent, ContentBlocks, CorrectAnswerView, LeaderboardList } from '../../components/Content';
import { ConnectionBadge, Countdown, errorText } from '../../components/common';

/**
 * Read-only projector / scoreboard client. Authenticated with a session-scoped scoreboard token;
 * the server only ever sends it data allowed by the visibility policy.
 */
export default function PresentPage() {
  const { sessionId = '' } = useParams();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const battle = useBattle<ScoreboardSessionState>({
    enabled: !!token,
    routeKey: sessionId,
    reducer: boardReducer,
    join: () => ({ role: 'SCOREBOARD', sessionId, scoreboardToken: token }),
  });
  const s = battle.state;
  const now = useServerNow(battle.socket, 200);

  if (!token || battle.fatal) return <div className="present center-msg"><h1>{errorText(battle.fatal ?? 'UNAUTHENTICATED')}</h1></div>;
  if (!s) return <div className="present center-msg"><ConnectionBadge status={battle.status} /></div>;

  const content = s.presentationContent;
  const view = s.presentation.view;
  const qIndex = content?.question ? content.question.position + 1 : null;
  const deadline = s.progressMode === 'SYNCHRONIZED' ? (s.currentPhase === 'ACTIVE' ? s.questionDeadlineAt : null) : s.timing.deadlineAt;
  const joinUrl = `${location.origin}/play/${s.joinCode}`;

  return (
    <div className="present" onDoubleClick={() => void document.documentElement.requestFullscreen?.().catch(() => undefined)}>
      <header className="present-head">
        <span className="present-brand">BRAINBATTLE</span>
        {qIndex && view !== 'WAITING' && (
          <span className="present-q">
            Q {qIndex} / {s.questionCount}
          </span>
        )}
        <div className="spacer" />
        <Countdown deadlineAt={s.state === 'PAUSED' || s.state === 'FINISHED' ? null : deadline} now={now} big paused={s.state === 'PAUSED'} />
        <span className="present-count">👥 {s.participantCount}</span>
        {battle.status !== 'live' && <ConnectionBadge status={battle.status} />}
      </header>

      <main className="present-main">
        {view === 'WAITING' && (
          <div className="present-waiting">
            <p>참가 주소</p>
            <h2>{joinUrl.replace(/^https?:\/\//, '').replace(`/play/${s.joinCode}`, '')}</h2>
            <p>참가 코드</p>
            <div className="present-code">{s.joinCode}</div>
            <p className="muted">{s.participantCount}명 참가 중</p>
          </div>
        )}

        {view === 'QUESTION' && content?.question && (
          <div className="present-question">
            <div className="present-qnum">문제 {content.question.displayNumber}</div>
            {content.question.deliveryMode === 'PAPER' ? (
              <h1>문제지 {content.question.displayNumber}번을 풀어 주세요</h1>
            ) : (
              <>
                {content.question.title && <h1>{content.question.title}</h1>}
                <ContentBlocks blocks={content.question.description} />
                {content.question.choices && (
                  <div className="present-choices">
                    {content.question.choices.map((c, i) => (
                      <div key={c.id} className={`choice c${i % 4}`}>
                        <ChoiceContent choice={c} />
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            {s.currentPhase === 'PREPARE' && s.questionOpensAt && <div className="prepare-count">{Math.max(0, Math.ceil((s.questionOpensAt - now) / 1000))}</div>}
          </div>
        )}

        {view === 'SUBMISSION_STATUS' && content?.submissionStatus && (
          <div className="present-status">
            {content.question && <div className="present-qnum">문제 {content.question.displayNumber}</div>}
            <div className="big-number">
              {content.submissionStatus.submitted} <span>/ {content.submissionStatus.total}</span>
            </div>
            <div className="bar huge">
              <div className="bar-fill" style={{ width: `${content.submissionStatus.total ? (content.submissionStatus.submitted / content.submissionStatus.total) * 100 : 0}%` }} />
            </div>
            <p>제출 완료</p>
          </div>
        )}

        {view === 'ANSWER' && content?.question && (
          <div className="present-question">
            <div className="present-qnum">문제 {content.question.displayNumber} 정답</div>
            {content.question.title && <h2>{content.question.title}</h2>}
            {content.reveal ? (
              <div className="present-answer">
                <CorrectAnswerView value={content.reveal.correctAnswer} choices={content.question.choices} isLatex={content.question.type === 'LATEX'} />
              </div>
            ) : (
              <p className="muted">정답은 문제가 마감된 후 표시됩니다</p>
            )}
            {content.stats && content.stats.correctRate !== null && <p className="present-rate">정답률 {Math.round(content.stats.correctRate * 100)}% · 제출 {content.stats.submitted}명</p>}
            {content.reveal && <ContentBlocks blocks={content.reveal.explanation} />}
          </div>
        )}

        {(view === 'SCOREBOARD' || view === 'RESULTS') && (
          <div className="present-board">
            {view === 'RESULTS' && <h1 className="present-title">최종 결과</h1>}
            {!s.scoreboard.visible || s.leaderboard.length === 0 ? (
              <p className="muted big-msg">{s.scoreboard.visible ? '아직 점수가 없습니다' : '점수판 비공개'}</p>
            ) : (
              <LeaderboardList entries={s.leaderboard} big showRank={s.scoreboard.visibility !== 'HIDE_RANK' && s.scoreboard.visibility !== 'SCORES_ONLY'} />
            )}
          </div>
        )}
      </main>
      {s.state === 'PAUSED' && <div className="overlay"><div className="overlay-card">⏸ 일시정지</div></div>}
    </div>
  );
}
