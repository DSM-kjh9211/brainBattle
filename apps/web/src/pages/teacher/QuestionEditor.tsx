import { useState } from 'react';
import {
  DEFAULT_GRADING_METHOD,
  QUESTION_TYPES,
  type Choice,
  type ContentBlock,
  type GradingConfig,
  type QuestionDTO,
  type QuestionInput,
  type QuestionType,
} from '@brainbattle/shared';
import { api, ApiError } from '../../core/api';
import { MathEditor } from '../../components/MathEditor';
import { ContentBlocks } from '../../components/Content';
import { Modal } from '../../components/common';

export const TYPE_LABEL: Record<QuestionType, string> = {
  MULTIPLE_CHOICE: '객관식',
  TRUE_FALSE: 'OX',
  SHORT_ANSWER: '단답형',
  NUMERIC: '숫자',
  LATEX: '수식(LaTeX)',
  ESSAY: '서술형(수동 채점)',
};

const MAX_INLINE_FILE = 600 * 1024;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

/** Content block editor with drag & drop for images. */
export function BlockEditor({ value, onChange, label }: { value: ContentBlock[]; onChange: (b: ContentBlock[]) => void; label: string }) {
  const [drag, setDrag] = useState(false);
  const set = (i: number, b: ContentBlock) => onChange(value.map((x, j) => (j === i ? b : x)));
  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    const added: ContentBlock[] = [];
    for (const f of Array.from(files)) {
      if (f.size > MAX_INLINE_FILE) {
        alert(`${f.name}: 600KB 이하 파일만 첨부할 수 있습니다 (MVP: 인라인 저장).`);
        continue;
      }
      const url = await readAsDataUrl(f);
      if (f.type.startsWith('image/')) added.push({ type: 'image', url, alt: f.name });
      else if (f.type.startsWith('audio/')) added.push({ type: 'audio', url });
      else if (f.type.startsWith('video/')) added.push({ type: 'video', url });
    }
    onChange([...value, ...added]);
  };
  return (
    <div
      className={`block-editor ${drag ? 'drag' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        void onFiles(e.dataTransfer.files);
      }}
    >
      <div className="field-label">{label}</div>
      {value.map((b, i) => (
        <div key={i} className="block-row">
          <span className="block-type">{b.type}</span>
          {b.type === 'text' && (
            <textarea className="input" rows={2} value={b.text} placeholder="텍스트 ($x^2$ 처럼 인라인 수식 가능)" onChange={(e) => set(i, { ...b, text: e.target.value })} />
          )}
          {b.type === 'math' && <MathEditor compact value={b.latex} onChange={(latex) => set(i, { ...b, latex })} />}
          {b.type === 'code' && (
            <div className="grow">
              <input className="input small" placeholder="언어 (python, c, …)" value={b.language ?? ''} onChange={(e) => set(i, { ...b, language: e.target.value })} />
              <textarea className="input mono" rows={4} value={b.code} onChange={(e) => set(i, { ...b, code: e.target.value })} />
            </div>
          )}
          {(b.type === 'image' || b.type === 'audio' || b.type === 'video') && (
            <div className="grow">
              {b.url.startsWith('data:') ? <span className="muted small">첨부 파일 ({Math.round(b.url.length / 1365)}KB)</span> : (
                <input className="input" placeholder="https://…" value={b.url} onChange={(e) => set(i, { ...b, url: e.target.value })} />
              )}
              <ContentBlocks blocks={[b]} />
            </div>
          )}
          <button type="button" className="btn ghost" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="블록 삭제">✕</button>
        </div>
      ))}
      <div className="row wrap">
        <button type="button" className="btn small" onClick={() => onChange([...value, { type: 'text', text: '' }])}>+ 텍스트</button>
        <button type="button" className="btn small" onClick={() => onChange([...value, { type: 'math', latex: '' }])}>+ 수식</button>
        <button type="button" className="btn small" onClick={() => onChange([...value, { type: 'image', url: '' }])}>+ 이미지 URL</button>
        <button type="button" className="btn small" onClick={() => onChange([...value, { type: 'code', code: '', language: '' }])}>+ 코드</button>
        <label className="btn small">
          + 파일 <input type="file" hidden accept="image/*,audio/*,video/*" multiple onChange={(e) => void onFiles(e.target.files)} />
        </label>
        <span className="muted small">이미지를 여기로 끌어다 놓을 수 있습니다</span>
      </div>
    </div>
  );
}

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

function defaultChoices(n = 4): Choice[] {
  return Array.from({ length: n }, (_, i) => ({ id: String(i + 1), label: CIRCLED[i], content: [] }));
}

function toForm(q?: QuestionDTO | null): QuestionInput & { grading: GradingConfig } {
  if (!q) {
    return {
      type: 'MULTIPLE_CHOICE',
      displayNumber: '',
      deliveryMode: 'DIGITAL',
      title: '',
      description: [],
      choices: defaultChoices(),
      correctAnswer: '1',
      acceptedAnswers: [],
      grading: { method: 'MULTIPLE_CHOICE' },
      score: 10,
      timeLimitSec: 30,
      explanation: [],
    };
  }
  return { ...q, displayNumber: q.displayNumber ?? '', grading: q.grading, explanation: q.explanation ?? [], description: q.description ?? [] };
}

export function QuestionEditor({ question, onClose, onSaved }: { question?: QuestionDTO | null; onClose: () => void; onSaved: (q: QuestionDTO) => void }) {
  const [f, setF] = useState(() => toForm(question));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const patch = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const g = f.grading;
  const setG = (p: Partial<GradingConfig>) => patch({ grading: { ...g, ...p } });
  const paper = f.deliveryMode === 'PAPER';

  const changeType = (t: QuestionType) => {
    const base: Partial<typeof f> = { type: t, grading: { method: DEFAULT_GRADING_METHOD[t] }, acceptedAnswers: [] };
    if (t === 'MULTIPLE_CHOICE') Object.assign(base, { choices: f.choices?.length ? f.choices : defaultChoices(), correctAnswer: '1' });
    else if (t === 'TRUE_FALSE') Object.assign(base, { choices: null, correctAnswer: true });
    else if (t === 'ESSAY') Object.assign(base, { choices: null, correctAnswer: undefined });
    else Object.assign(base, { choices: null, correctAnswer: '' });
    patch(base);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const body: QuestionInput = {
      ...f,
      displayNumber: f.displayNumber?.trim() || null,
      title: f.title?.trim() || null,
      description: f.description?.length ? f.description : null,
      explanation: f.explanation?.length ? f.explanation : null,
      correctAnswer:
        f.type === 'NUMERIC' && typeof f.correctAnswer === 'string' && f.correctAnswer.trim() !== '' && !Number.isNaN(Number(f.correctAnswer))
          ? Number(f.correctAnswer)
          : f.correctAnswer === '' ? undefined : f.correctAnswer,
      acceptedAnswers: (f.acceptedAnswers ?? []).filter((x) => x !== '' && x !== null),
    };
    try {
      const saved = question
        ? await api<QuestionDTO>('PUT', `/api/questions/${question.id}`, body)
        : await api<QuestionDTO>('POST', '/api/questions', body);
      onSaved(saved);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message}${e.details ? ' — ' + JSON.stringify(e.details).slice(0, 300) : ''}` : String(e));
    } finally {
      setSaving(false);
    }
  };

  const choices = f.choices ?? [];
  const correctIds = Array.isArray(f.correctAnswer) ? f.correctAnswer : typeof f.correctAnswer === 'string' ? [f.correctAnswer] : [];

  return (
    <Modal title={question ? '문제 수정' : '새 문제'} onClose={onClose} wide>
      <div className="form-grid">
        <label>
          유형
          <select className="input" value={f.type} onChange={(e) => changeType(e.target.value as QuestionType)}>
            {QUESTION_TYPES.map((t) => (
              <option key={t} value={t}>{TYPE_LABEL[t]}</option>
            ))}
          </select>
        </label>
        <label>
          표시 번호
          <input className="input" placeholder="예: 7, 15-1, A, 서술형 1" value={f.displayNumber ?? ''} onChange={(e) => patch({ displayNumber: e.target.value })} />
        </label>
        <label>
          제공 방식
          <select className="input" value={f.deliveryMode} onChange={(e) => patch({ deliveryMode: e.target.value as 'DIGITAL' | 'PAPER' })}>
            <option value="DIGITAL">디지털 (문제 표시)</option>
            <option value="PAPER">종이/답안만 (문제 미표시)</option>
          </select>
        </label>
        <label>
          배점
          <input className="input" type="number" min={0} value={f.score} onChange={(e) => patch({ score: Number(e.target.value) })} />
        </label>
        <label>
          제한 시간(초)
          <input className="input" type="number" min={0} placeholder="없음" value={f.timeLimitSec ?? ''} onChange={(e) => patch({ timeLimitSec: e.target.value === '' ? null : Number(e.target.value) })} />
        </label>
      </div>

      {!paper && (
        <>
          <label className="block">
            제목 / 발문
            <input className="input" value={f.title ?? ''} onChange={(e) => patch({ title: e.target.value })} />
          </label>
          <BlockEditor label="본문" value={f.description ?? []} onChange={(description) => patch({ description })} />
        </>
      )}
      {paper && <p className="muted small">종이/답안 전용 문제: 학생 화면에는 "문제 {f.displayNumber || 'N'}번 / 답: [입력]"만 표시됩니다. 제목·본문은 선택 사항입니다.</p>}

      <fieldset className="fieldset">
        <legend>정답 및 채점</legend>
        {f.type === 'MULTIPLE_CHOICE' && (
          <>
            <label className="checkbox">
              <input type="checkbox" checked={!!g.multipleSelect} onChange={(e) => setG({ multipleSelect: e.target.checked })} /> 복수 정답(모두 선택해야 정답)
            </label>
            {choices.map((c, i) => (
              <div key={c.id} className="choice-edit">
                <input
                  type={g.multipleSelect ? 'checkbox' : 'radio'}
                  name="correct"
                  checked={correctIds.includes(c.id)}
                  onChange={(e) => {
                    if (g.multipleSelect) {
                      const next = e.target.checked ? [...correctIds, c.id] : correctIds.filter((x) => x !== c.id);
                      patch({ correctAnswer: next });
                    } else patch({ correctAnswer: c.id });
                  }}
                  aria-label={`${c.label} 정답`}
                />
                <span className="choice-label">{c.label}</span>
                {!paper && (
                  <input
                    className="input"
                    placeholder="선택지 내용 ($수식$ 가능)"
                    value={c.content?.[0]?.type === 'text' ? c.content[0].text : ''}
                    onChange={(e) =>
                      patch({ choices: choices.map((x, j) => (j === i ? { ...x, content: e.target.value ? [{ type: 'text', text: e.target.value }] : [] } : x)) })
                    }
                  />
                )}
                <button type="button" className="btn ghost" disabled={choices.length <= 2} onClick={() => patch({ choices: choices.filter((_, j) => j !== i) })}>✕</button>
              </div>
            ))}
            <button
              type="button"
              className="btn small"
              disabled={choices.length >= 10}
              onClick={() => {
                const n = choices.length;
                const id = String(Math.max(0, ...choices.map((c) => Number(c.id) || 0)) + 1);
                patch({ choices: [...choices, { id, label: CIRCLED[n] ?? String(n + 1), content: [] }] });
              }}
            >
              + 선택지
            </button>
          </>
        )}
        {f.type === 'TRUE_FALSE' && (
          <div className="seg">
            <label><input type="radio" checked={f.correctAnswer === true} onChange={() => patch({ correctAnswer: true })} /> O (참)</label>
            <label><input type="radio" checked={f.correctAnswer === false} onChange={() => patch({ correctAnswer: false })} /> X (거짓)</label>
          </div>
        )}
        {f.type === 'SHORT_ANSWER' && (
          <>
            <input className="input" placeholder="정답" value={String(f.correctAnswer ?? '')} onChange={(e) => patch({ correctAnswer: e.target.value })} />
            <textarea
              className="input"
              rows={2}
              placeholder="추가 허용 답안 (한 줄에 하나)"
              value={(f.acceptedAnswers ?? []).join('\n')}
              onChange={(e) => patch({ acceptedAnswers: e.target.value.split('\n') })}
            />
            <div className="row wrap">
              <label className="checkbox">
                <input type="radio" checked={g.method === 'TEXT_NORMALIZED'} onChange={() => setG({ method: 'TEXT_NORMALIZED' })} /> 정규화 비교 (공백·대소문자 무시)
              </label>
              <label className="checkbox">
                <input type="radio" checked={g.method === 'EXACT'} onChange={() => setG({ method: 'EXACT' })} /> 정확히 일치
              </label>
            </div>
          </>
        )}
        {f.type === 'NUMERIC' && (
          <div className="row wrap">
            <label>
              정답
              <input className="input" placeholder="3.14 또는 1/2" value={String(f.correctAnswer ?? '')} onChange={(e) => patch({ correctAnswer: e.target.value })} />
            </label>
            <label>
              허용 오차(절대)
              <input className="input" type="number" step="any" min={0} value={g.tolerance ?? ''} onChange={(e) => setG({ tolerance: e.target.value === '' ? undefined : Number(e.target.value) })} />
            </label>
            <label>
              상대 오차(%)
              <input
                className="input"
                type="number"
                step="any"
                min={0}
                value={g.relativeTolerance !== undefined ? g.relativeTolerance * 100 : ''}
                onChange={(e) => setG({ relativeTolerance: e.target.value === '' ? undefined : Number(e.target.value) / 100 })}
              />
            </label>
          </div>
        )}
        {f.type === 'LATEX' && (
          <>
            <div className="field-label">정답 수식</div>
            <MathEditor value={String(f.correctAnswer ?? '')} onChange={(latex) => patch({ correctAnswer: latex })} />
            <div className="field-label">추가 허용 답안</div>
            {(f.acceptedAnswers ?? []).map((a, i) => (
              <div key={i} className="row">
                <MathEditor compact value={String(a ?? '')} onChange={(latex) => patch({ acceptedAnswers: (f.acceptedAnswers ?? []).map((x, j) => (j === i ? latex : x)) })} />
                <button type="button" className="btn ghost" onClick={() => patch({ acceptedAnswers: (f.acceptedAnswers ?? []).filter((_, j) => j !== i) })}>✕</button>
              </div>
            ))}
            <button type="button" className="btn small" onClick={() => patch({ acceptedAnswers: [...(f.acceptedAnswers ?? []), ''] })}>+ 허용 답안</button>
            <div className="row wrap">
              <label className="checkbox">
                <input type="checkbox" checked={!!g.latexNumericEquivalence} onChange={(e) => setG({ latexNumericEquivalence: e.target.checked })} /> 수치 동치 (1/2 = 0.5)
              </label>
              <label className="checkbox">
                <input type="checkbox" checked={!!g.latexCommutative} onChange={(e) => setG({ latexCommutative: e.target.checked })} /> 교환법칙 (x+1 = 1+x)
              </label>
              <label className="checkbox">
                <input type="checkbox" checked={!!g.latexIgnoreVariableAssignment} onChange={(e) => setG({ latexIgnoreVariableAssignment: e.target.checked })} /> "x=" 생략 허용
              </label>
            </div>
          </>
        )}
        {f.type === 'ESSAY' && <p className="muted">서술형은 교사가 직접 채점합니다 (부분 점수 가능).</p>}
      </fieldset>

      <BlockEditor label="해설 (결과 공개 시 표시)" value={f.explanation ?? []} onChange={(explanation) => patch({ explanation })} />

      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary" disabled={saving} onClick={() => void save()}>{saving ? '저장 중…' : '저장'}</button>
      </div>
    </Modal>
  );
}
