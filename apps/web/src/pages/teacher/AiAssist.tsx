import { useEffect, useState } from 'react';
import {
  AI_MAX_QUESTIONS,
  QUESTION_TYPES,
  type AiDifficulty,
  type AiGenerateRequest,
  type AiIssueSeverity,
  type AiQuestionReview,
  type AiSetDraft,
  type AiSetReview,
  type AiStatus,
  type Choice,
  type QuestionInput,
  type QuestionType,
} from '@brainbattle/shared';
import { api, ApiError } from '../../core/api';
import { ContentBlocks, CorrectAnswerView } from '../../components/Content';
import { errorText, Modal } from '../../components/common';
import { TYPE_LABEL } from './QuestionEditor';

const AI_OFF_HINT = '서버에 ANTHROPIC_API_KEY가 설정되어 있지 않아 AI 기능을 사용할 수 없습니다.';

let statusCache: Promise<boolean> | null = null;

/** null while unknown. The status is fetched once per page load. */
export function useAiEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    statusCache ??= api<AiStatus>('GET', '/api/ai/status').then((s) => s.enabled, () => false);
    let alive = true;
    void statusCache.then((e) => alive && setEnabled(e));
    return () => {
      alive = false;
    };
  }, []);
  return enabled;
}

export function AiButton({ children, onClick, disabled, primary }: { children: string; onClick: () => void; disabled?: boolean; primary?: boolean }) {
  const enabled = useAiEnabled();
  return (
    <button type="button" className={`btn ${primary ? 'primary' : ''}`} disabled={disabled || !enabled} title={enabled === false ? AI_OFF_HINT : undefined} onClick={onClick}>
      ✨ {children}
    </button>
  );
}

const aiError = (e: unknown) => (e instanceof ApiError ? errorText(e.code, e.message) : 'AI 요청에 실패했습니다. 잠시 후 다시 시도해 주세요.');

const SEVERITY_LABEL: Record<AiIssueSeverity, string> = { ERROR: '오류', WARNING: '주의', INFO: '참고' };

function IssueList({ issues }: { issues: { severity: AiIssueSeverity; where?: string | null; message: string; suggestion: string | null }[] }) {
  return (
    <ul className="ai-issues">
      {issues.map((i, n) => (
        <li key={n} className={`ai-issue sev-${i.severity.toLowerCase()}`}>
          <span className="ai-sev">{SEVERITY_LABEL[i.severity]}</span>
          <div>
            {i.where && <b>{i.where} </b>}
            {i.message}
            {i.suggestion && <div className="muted small">제안: {i.suggestion}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function DraftPreview({ q }: { q: QuestionInput }) {
  return (
    <>
      <div className="q-head">
        <span className="q-number">{TYPE_LABEL[q.type]}</span>
        <span className="muted small">{q.score ?? 10}점{q.timeLimitSec ? ` · ${q.timeLimitSec}초` : ''}</span>
      </div>
      {q.title && <h3>{q.title}</h3>}
      <ContentBlocks blocks={q.description} />
      {q.choices && (
        <ol className="preview-choices">
          {q.choices.map((c) => (
            <li key={c.id}>
              {c.label} <ContentBlocks blocks={c.content} />
            </li>
          ))}
        </ol>
      )}
      <p className="reveal">
        정답: <CorrectAnswerView value={q.correctAnswer} choices={q.choices as Choice[] | null | undefined} isLatex={q.type === 'LATEX'} />
        {q.acceptedAnswers?.length ? <span className="muted small"> (허용: {q.acceptedAnswers.join(', ')})</span> : null}
      </p>
      {q.explanation?.length ? (
        <div className="muted small">
          해설 <ContentBlocks blocks={q.explanation} />
        </div>
      ) : null}
    </>
  );
}

const DIFFICULTY_LABEL: Record<AiDifficulty, string> = { EASY: '쉬움', MEDIUM: '보통', HARD: '어려움', MIXED: '혼합 (쉬움 → 어려움)' };

/**
 * Generates drafts, lets the teacher pick, then hands the picked questions to `onSave`.
 * mode "set" also drafts a set title/description.
 */
export function AiGenerateModal({
  mode,
  onClose,
  onSave,
}: {
  mode: 'questions' | 'set';
  onClose: () => void;
  onSave: (questions: QuestionInput[], set: { title: string; description: string | null }) => Promise<void>;
}) {
  const [form, setForm] = useState<AiGenerateRequest>({ topic: '', audience: '', difficulty: 'MEDIUM', count: mode === 'set' ? 10 : 5, types: [], instructions: '', sourceText: '' });
  const [draft, setDraft] = useState<AiSetDraft | null>(null);
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<'generate' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const patch = (p: Partial<AiGenerateRequest>) => setForm((f) => ({ ...f, ...p }));
  const types = form.types ?? [];

  const generate = async () => {
    setBusy('generate');
    setError(null);
    try {
      const body = { ...form, audience: form.audience || undefined, instructions: form.instructions || undefined, sourceText: form.sourceText || undefined };
      const d =
        mode === 'set'
          ? await api<AiSetDraft>('POST', '/api/ai/question-sets/generate', body)
          : { title: '', description: null, ...(await api<Omit<AiSetDraft, 'title' | 'description'>>('POST', '/api/ai/questions/generate', body)) };
      setDraft(d);
      setTitle(d.title);
      setPicked(new Set(d.questions.map((_, i) => i)));
    } catch (e) {
      setError(aiError(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy('save');
    setError(null);
    try {
      await onSave(draft.questions.filter((_, i) => picked.has(i)), { title: title.trim() || form.topic, description: draft.description });
    } catch (e) {
      setError(e instanceof ApiError ? errorText(e.code, e.message) : '저장하지 못했습니다. 다시 시도해 주세요.');
      setBusy(null);
    }
  };

  const heading = mode === 'set' ? 'AI로 문제 세트 만들기' : 'AI 문제 출제';

  if (!draft) {
    return (
      <Modal title={heading} onClose={onClose} wide>
        <label className="block">
          주제
          <input className="input" autoFocus placeholder="예: 중2 일차함수의 그래프, 파이썬 리스트 컴프리헨션" maxLength={500} value={form.topic} onChange={(e) => patch({ topic: e.target.value })} />
        </label>
        <div className="form-grid">
          <label>
            대상
            <input className="input" placeholder="예: 중학교 2학년" maxLength={100} value={form.audience ?? ''} onChange={(e) => patch({ audience: e.target.value })} />
          </label>
          <label>
            난이도
            <select className="input" value={form.difficulty} onChange={(e) => patch({ difficulty: e.target.value as AiDifficulty })}>
              {(Object.keys(DIFFICULTY_LABEL) as AiDifficulty[]).map((d) => (
                <option key={d} value={d}>{DIFFICULTY_LABEL[d]}</option>
              ))}
            </select>
          </label>
          <label>
            문항 수
            <input className="input" type="number" min={1} max={AI_MAX_QUESTIONS} value={form.count} onChange={(e) => patch({ count: Math.max(1, Math.min(AI_MAX_QUESTIONS, Number(e.target.value) || 1)) })} />
          </label>
        </div>
        <fieldset className="fieldset">
          <legend>문제 유형 (선택하지 않으면 AI가 고릅니다)</legend>
          <div className="row wrap">
            {QUESTION_TYPES.map((t: QuestionType) => (
              <label key={t} className="checkbox">
                <input type="checkbox" checked={types.includes(t)} onChange={(e) => patch({ types: e.target.checked ? [...types, t] : types.filter((x) => x !== t) })} /> {TYPE_LABEL[t]}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block">
          추가 요청 (선택)
          <textarea className="input" rows={2} maxLength={2000} placeholder="예: 계산 문제 위주로, 실생활 예시 포함" value={form.instructions ?? ''} onChange={(e) => patch({ instructions: e.target.value })} />
        </label>
        <label className="block">
          참고 자료 (선택) — 붙여 넣으면 이 내용에서만 출제합니다
          <textarea className="input" rows={4} maxLength={30000} placeholder="교과서 본문, 수업 자료 등" value={form.sourceText ?? ''} onChange={(e) => patch({ sourceText: e.target.value })} />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        {busy && <p className="muted" role="status">AI가 문제를 만들고 있습니다. 1~2분 정도 걸릴 수 있습니다…</p>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn primary" disabled={!!busy || !form.topic.trim()} onClick={() => void generate()}>{busy ? '생성 중…' : '초안 만들기'}</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`${heading} — 초안 확인`} onClose={onClose} wide>
      <p className="warning">AI가 만든 초안입니다. 정답과 해설을 확인한 뒤 저장할 문제만 선택하세요.</p>
      {mode === 'set' && (
        <label className="block">
          세트 이름
          <input className="input" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      )}
      {draft.dropped > 0 && <p className="muted small">형식이 올바르지 않은 초안 {draft.dropped}개는 제외했습니다.</p>}
      {draft.questions.map((q, i) => (
        <article key={i} className={`question-card preview ai-draft ${picked.has(i) ? '' : 'unpicked'}`}>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={picked.has(i)}
              onChange={(e) => {
                const next = new Set(picked);
                if (e.target.checked) next.add(i);
                else next.delete(i);
                setPicked(next);
              }}
            />{' '}
            문제 {i + 1} 저장
          </label>
          <DraftPreview q={q} />
        </article>
      ))}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button className="btn" disabled={!!busy} onClick={() => setDraft(null)}>← 조건 수정</button>
        <button className="btn primary" disabled={!!busy || picked.size === 0} onClick={() => void save()}>
          {busy === 'save' ? '저장 중…' : `선택한 ${picked.size}문제 저장`}
        </button>
      </div>
    </Modal>
  );
}

/** Inline review of the question being edited. `getQuestion` returns the body that would be saved. */
export function AiQuestionReviewPanel({ getQuestion, onApply }: { getQuestion: () => QuestionInput; onApply: (q: QuestionInput) => void }) {
  const [review, setReview] = useState<AiQuestionReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setReview(null);
    try {
      setReview(await api<AiQuestionReview>('POST', '/api/ai/questions/review', { question: getQuestion() }));
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'BAD_REQUEST' ? '문제를 먼저 완성해 주세요 (정답·선택지 등).' : aiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="fieldset">
      <legend>AI 검토</legend>
      <div className="row wrap">
        <AiButton disabled={busy} onClick={() => void run()}>{busy ? '검토 중…' : review ? '다시 검토' : '이 문제 검토'}</AiButton>
        <span className="muted small">정답 오류, 모호한 표현, 자동 채점에서 놓칠 수 있는 답안을 확인합니다. 첨부한 이미지·오디오는 검토하지 않습니다.</span>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {review && (
        <>
          <p className={review.verdict === 'OK' ? 'ai-ok' : 'warning'}>{review.verdict === 'OK' ? '✓ ' : ''}{review.summary}</p>
          <IssueList issues={review.issues} />
          {review.revised && (
            <details className="disclosure">
              <summary>수정안 보기</summary>
              <article className="question-card preview">
                <DraftPreview q={review.revised} />
              </article>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  onApply(review.revised!);
                  setReview(null);
                }}
              >
                수정안을 편집기에 적용
              </button>
            </details>
          )}
        </>
      )}
    </fieldset>
  );
}

export function AiSetReviewModal({ setId, onClose }: { setId: string; onClose: () => void }) {
  const [review, setReview] = useState<AiSetReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api<AiSetReview>('POST', `/api/ai/question-sets/${setId}/review`, {}).then(
      (r) => alive && setReview(r),
      (e) => alive && setError(aiError(e)),
    );
    return () => {
      alive = false;
    };
  }, [setId]);
  return (
    <Modal title="AI 세트 검토" onClose={onClose} wide>
      {!review && !error && <p className="muted" role="status">AI가 세트 전체를 검토하고 있습니다. 1~2분 정도 걸릴 수 있습니다…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {review && (
        <>
          <p>{review.summary}</p>
          {review.issues.length === 0 && <p className="ai-ok">✓ 발견된 문제가 없습니다.</p>}
          <IssueList issues={review.issues.map((i) => ({ ...i, where: i.displayNumber ? `문제 ${i.displayNumber}` : '세트 전체' }))} />
          <p className="muted small">첨부한 이미지·오디오는 검토하지 않습니다.</p>
        </>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>닫기</button>
      </div>
    </Modal>
  );
}
