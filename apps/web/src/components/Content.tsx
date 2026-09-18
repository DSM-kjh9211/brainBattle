import { useLayoutEffect, useMemo, useRef } from 'react';
import { convertLatexToMarkup } from 'mathlive';
import type { AnswerPayload, Choice, ContentBlock, CorrectAnswer, LeaderboardEntry } from '@brainbattle/shared';

/** Static LaTeX rendering (MathLive's renderer escapes its input). */
export function MathText({ latex, display }: { latex: string; display?: boolean }) {
  const html = useMemo(() => {
    try {
      return convertLatexToMarkup(latex, { defaultMode: display ? 'math' : 'inline-math' } as never);
    } catch {
      return null;
    }
  }, [latex, display]);
  if (html === null) return <code>{latex}</code>;
  return <span className={display ? 'math-display' : 'math-inline'} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Plain text with $inline$ math. React escapes the text parts. */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/(\$[^$]+\$)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('$') && p.endsWith('$') && p.length > 2 ? <MathText key={i} latex={p.slice(1, -1)} /> : <span key={i}>{p}</span>,
      )}
    </>
  );
}

const safeUrl = (u: string) => (/^(https?:|data:image\/|data:audio\/|data:video\/|\/)/i.test(u) ? u : '');

export function ContentBlocks({ blocks }: { blocks: ContentBlock[] | null | undefined }) {
  if (!blocks?.length) return null;
  return (
    <div className="content-blocks">
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'text':
            return (
              <p key={i} className="content-text">
                <RichText text={b.text} />
              </p>
            );
          case 'math':
            return (
              <div key={i} className="content-math">
                <MathText latex={b.latex} display />
              </div>
            );
          case 'image':
            return safeUrl(b.url) ? <img key={i} className="content-image" src={safeUrl(b.url)} alt={b.alt ?? ''} /> : null;
          case 'code':
            return (
              <pre key={i} className="content-code" data-lang={b.language}>
                <code>{b.code}</code>
              </pre>
            );
          case 'audio':
            return safeUrl(b.url) ? <audio key={i} controls src={safeUrl(b.url)} /> : null;
          case 'video':
            return safeUrl(b.url) ? <video key={i} controls src={safeUrl(b.url)} className="content-image" /> : null;
          default:
            return null;
        }
      })}
    </div>
  );
}

export function ChoiceContent({ choice }: { choice: Choice }) {
  return (
    <>
      <span className="choice-label">{choice.label}</span>
      <span className="choice-body">
        <ContentBlocks blocks={choice.content} />
      </span>
    </>
  );
}

export function AnswerView({ answer, choices }: { answer: AnswerPayload; choices?: Choice[] | null }) {
  switch (answer.kind) {
    case 'choice':
      return <span>{answer.choiceIds.map((id) => choices?.find((c) => c.id === id)?.label ?? id).join(', ')}</span>;
    case 'boolean':
      return <span>{answer.value ? 'O (참)' : 'X (거짓)'}</span>;
    case 'latex':
      return <MathText latex={answer.raw} />;
    default:
      return <span className="pre-wrap">{answer.raw}</span>;
  }
}

export function CorrectAnswerView({ value, choices, isLatex }: { value: CorrectAnswer | undefined; choices?: Choice[] | null; isLatex?: boolean }) {
  if (value === undefined || value === null) return <span className="muted">(정답 없음 / 수동 채점)</span>;
  if (typeof value === 'boolean') return <span>{value ? 'O (참)' : 'X (거짓)'}</span>;
  if (Array.isArray(value)) return <span>{value.map((id) => choices?.find((c) => c.id === id)?.label ?? id).join(', ')}</span>;
  if (choices?.length) return <span>{choices.find((c) => c.id === value)?.label ?? String(value)}</span>;
  if (isLatex) return <MathText latex={String(value)} />;
  return <span>{String(value)}</span>;
}

/** Ranked list with FLIP animations when ranks change. */
export function LeaderboardList({ entries, highlight, big, showRank = true }: { entries: LeaderboardEntry[]; highlight?: string | null; big?: boolean; showRank?: boolean }) {
  const rows = useRef(new Map<string, HTMLLIElement>());
  const prev = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const next = new Map<string, DOMRect>();
    for (const [id, el] of rows.current) {
      const rect = el.getBoundingClientRect();
      next.set(id, rect);
      const old = prev.current.get(id);
      if (old) {
        const dy = old.top - rect.top;
        if (Math.abs(dy) > 1) {
          el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 600, easing: 'cubic-bezier(.2,.8,.2,1)' });
        }
      } else {
        el.animate([{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 400 });
      }
    }
    prev.current = next;
  });
  return (
    <ol className={`leaderboard ${big ? 'big' : ''}`}>
      {entries.map((e, i) => (
        <li
          key={e.participantId || `anon-${i}`}
          ref={(el) => {
            const k = e.participantId || `anon-${i}`;
            if (el) rows.current.set(k, el);
            else rows.current.delete(k);
          }}
          className={`lb-row ${highlight && highlight === e.participantId ? 'me' : ''} ${e.rank && e.rank <= 3 ? `top${e.rank}` : ''}`}
        >
          {showRank && <span className="lb-rank">{e.rank ?? '–'}</span>}
          <span className="lb-name">{e.nickname || '•••'}</span>
          <span className="lb-score">{e.score === null ? '' : e.score.toLocaleString()}</span>
        </li>
      ))}
    </ol>
  );
}
