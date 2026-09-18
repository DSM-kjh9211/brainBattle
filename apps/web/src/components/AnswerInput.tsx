import { useState } from 'react';
import type { AnswerPayload, StudentQuestionView } from '@brainbattle/shared';
import { ChoiceContent } from './Content';
import { MathEditor } from './MathEditor';

export type Draft = AnswerPayload | null;

export function emptyDraft(q: StudentQuestionView): Draft {
  switch (q.type) {
    case 'LATEX':
      return { kind: 'latex', raw: '' };
    case 'NUMERIC':
      return { kind: 'numeric', raw: '' };
    case 'SHORT_ANSWER':
    case 'ESSAY':
      return { kind: 'text', raw: '' };
    default:
      return null;
  }
}

export function isDraftComplete(d: Draft): d is AnswerPayload {
  if (!d) return false;
  if (d.kind === 'choice') return d.choiceIds.length > 0;
  if (d.kind === 'boolean') return true;
  return d.raw.trim().length > 0;
}

interface Props {
  question: StudentQuestionView;
  draft: Draft;
  onChange: (d: Draft) => void;
  onSubmit: () => void;
  disabled?: boolean;
}

/** Type-specific answer input. Produces an AnswerPayload; grading happens only on the server. */
export function AnswerInput({ question: q, draft, onChange, onSubmit, disabled }: Props) {
  const [mathMode, setMathMode] = useState(draft?.kind === 'latex' && q.type !== 'LATEX');
  const paper = q.deliveryMode === 'PAPER';

  if (q.type === 'MULTIPLE_CHOICE') {
    const selected = draft?.kind === 'choice' ? draft.choiceIds : [];
    const toggle = (id: string) => {
      if (disabled) return;
      if (q.multipleSelect) {
        const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
        onChange(next.length ? { kind: 'choice', choiceIds: next } : null);
      } else onChange({ kind: 'choice', choiceIds: [id] });
    };
    return (
      <div className={`choices ${paper ? 'paper' : ''}`} role={q.multipleSelect ? 'group' : 'radiogroup'}>
        {(q.choices ?? []).map((c, i) => (
          <button
            key={c.id}
            type="button"
            role={q.multipleSelect ? 'checkbox' : 'radio'}
            aria-checked={selected.includes(c.id)}
            className={`choice c${i % 4} ${selected.includes(c.id) ? 'selected' : ''}`}
            disabled={disabled}
            onClick={() => toggle(c.id)}
          >
            <ChoiceContent choice={c} />
          </button>
        ))}
        {q.multipleSelect && <p className="muted small">복수 선택 가능</p>}
      </div>
    );
  }

  if (q.type === 'TRUE_FALSE') {
    const v = draft?.kind === 'boolean' ? draft.value : null;
    return (
      <div className="choices tf">
        <button type="button" className={`choice tf-o ${v === true ? 'selected' : ''}`} disabled={disabled} onClick={() => onChange({ kind: 'boolean', value: true })}>
          O
        </button>
        <button type="button" className={`choice tf-x ${v === false ? 'selected' : ''}`} disabled={disabled} onClick={() => onChange({ kind: 'boolean', value: false })}>
          X
        </button>
      </div>
    );
  }

  const raw = draft && 'raw' in draft ? draft.raw : '';
  const useMath = q.type === 'LATEX' || mathMode;

  return (
    <div className="free-answer">
      {q.type !== 'LATEX' && q.type !== 'SHORT_ANSWER' && (
        <label className="math-toggle">
          <input
            type="checkbox"
            checked={mathMode}
            disabled={disabled}
            onChange={(e) => {
              setMathMode(e.target.checked);
              onChange(e.target.checked ? { kind: 'latex', raw: '' } : q.type === 'NUMERIC' ? { kind: 'numeric', raw: '' } : { kind: 'text', raw: '' });
            }}
          />
          수식 입력기 사용 (분수·루트 등)
        </label>
      )}
      {useMath ? (
        <MathEditor value={raw} disabled={disabled} autoFocus onChange={(latex) => onChange({ kind: 'latex', raw: latex })} onSubmit={onSubmit} />
      ) : q.type === 'ESSAY' ? (
        <textarea
          className="input essay"
          value={raw}
          disabled={disabled}
          rows={8}
          placeholder="답안을 작성하세요"
          onChange={(e) => onChange({ kind: 'text', raw: e.target.value })}
        />
      ) : (
        <input
          className="input answer-input"
          value={raw}
          disabled={disabled}
          autoFocus
          inputMode={q.type === 'NUMERIC' ? 'decimal' : 'text'}
          placeholder={q.type === 'NUMERIC' ? '숫자 (예: 3.14, -2, 1/2)' : '답 입력'}
          onChange={(e) => onChange(q.type === 'NUMERIC' ? { kind: 'numeric', raw: e.target.value } : { kind: 'text', raw: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) onSubmit();
          }}
        />
      )}
    </div>
  );
}
