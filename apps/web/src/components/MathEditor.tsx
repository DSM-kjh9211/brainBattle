import { useEffect, useMemo, useRef, useState } from 'react';
import { MathfieldElement } from 'mathlive';
import 'mathlive/fonts.css';
import { findCommandForKey, MATH_COMMANDS, searchSlashCommands, type MathCommand, type ShortcutMap } from '@brainbattle/shared';
import { effectiveShortcuts } from '../core/platform';

MathfieldElement.fontsDirectory = '/mathlive/fonts';
MathfieldElement.soundsDirectory = null;

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'math-field': React.DetailedHTMLProps<React.HTMLAttributes<MathfieldElement>, MathfieldElement>;
    }
  }
}

export interface MathEditorProps {
  value: string;
  onChange: (latex: string) => void;
  /** Enter key (outside the slash palette) */
  onSubmit?: () => void;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  shortcuts?: ShortcutMap;
  compact?: boolean;
}

/**
 * WYSIWYG math input. Students never type LaTeX: they use the toolbar, keyboard shortcuts
 * (Ctrl+/ fraction, Ctrl+R root, …) or slash commands (/frac, /sqrt, …) which insert structured
 * templates with empty slots navigable by keyboard. The value is stored as LaTeX (raw), and the
 * server computes the normalized form.
 */
export function MathEditor({ value, onChange, onSubmit, disabled, placeholder, autoFocus, shortcuts, compact }: MathEditorProps) {
  const ref = useRef<MathfieldElement>(null);
  const [slash, setSlash] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [ascii, setAscii] = useState('');
  const slashRef = useRef<string | null>(null);
  const slashIndexRef = useRef(0);
  const keys = useMemo(() => shortcuts ?? effectiveShortcuts(), [shortcuts]);
  const cbs = useRef({ onChange, onSubmit });
  cbs.current = { onChange, onSubmit };

  const matches = slash !== null ? (slash === '' ? MATH_COMMANDS.filter((c) => c.toolbar) : searchSlashCommands(slash)) : [];
  const matchesRef = useRef<MathCommand[]>([]);
  matchesRef.current = matches;

  const setSlashState = (v: string | null) => {
    slashRef.current = v;
    setSlash(v);
    slashIndexRef.current = 0;
    setSlashIndex(0);
  };

  const insert = (cmd: MathCommand) => {
    const mf = ref.current;
    if (!mf) return;
    mf.insert(cmd.latex, { selectionMode: 'placeholder', format: 'latex', focus: true });
    emit();
  };

  const emit = () => {
    const mf = ref.current;
    if (!mf) return;
    // empty template slots are not part of the answer (an unfinished fraction stays incomplete)
    cbs.current.onChange(mf.getValue('latex-without-placeholders'));
    try {
      setAscii(mf.getValue('ascii-math'));
    } catch {
      setAscii('');
    }
  };

  useEffect(() => {
    const mf = ref.current;
    if (!mf) return;
    mf.smartFence = true;
    mf.mathVirtualKeyboardPolicy = 'auto';
    mf.popoverPolicy = 'off';
    mf.menuItems = [];
    // our slash palette replaces MathLive's own "/" → fraction handling only while it is open
    const onInput = () => emit();

    const typeText = (s: string) => {
      for (const ch of s) mf.executeCommand(['typedText', ch, { focus: true, feedback: false, simulateKeystroke: true }] as never);
    };

    // some virtual keyboards / remote sessions leave `key` empty: fall back to code / keyCode
    const isEnter = (e: KeyboardEvent) => e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter' || e.keyCode === 13;
    const isTab = (e: KeyboardEvent) => e.key === 'Tab' || e.code === 'Tab' || e.keyCode === 9;

    const onKeyDown = (e: KeyboardEvent) => {
      // a shortcut always wins; it also closes an open slash palette
      const cmd = findCommandForKey(e, keys);
      if (cmd) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (slashRef.current !== null) setSlashState(null);
        insert(cmd);
        return;
      }
      const inSlash = slashRef.current !== null;
      if (!inSlash) {
        if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          e.stopImmediatePropagation();
          setSlashState('');
          return;
        }
        // Tab / Shift+Tab walk through empty slots (numerator → denominator …); once every slot is
        // filled, Tab falls through to normal focus navigation
        if (isTab(e) && !e.ctrlKey && !e.altKey && !e.metaKey && mf.value.includes('\\placeholder')) {
          e.preventDefault();
          e.stopImmediatePropagation();
          mf.executeCommand(e.shiftKey ? 'moveToPreviousPlaceholder' : 'moveToNextPlaceholder');
          return;
        }
        if (isEnter(e) && !e.shiftKey && cbs.current.onSubmit) {
          e.preventDefault();
          e.stopImmediatePropagation();
          cbs.current.onSubmit();
        }
        return;
      }
      // ---- slash-command mode
      const buf = slashRef.current!;
      const list = matchesRef.current;
      if (/^[a-zA-Z]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSlashState(buf + e.key.toLowerCase());
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopImmediatePropagation();
        const n = list.length || 1;
        const i = (slashIndexRef.current + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        slashIndexRef.current = i;
        setSlashIndex(i);
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSlashState(buf.length ? buf.slice(0, -1) : null);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSlashState(null);
        return;
      }
      if (isEnter(e) || isTab(e) || e.key === ' ') {
        e.preventDefault();
        e.stopImmediatePropagation();
        const pick = list[slashIndexRef.current];
        setSlashState(null);
        if (pick && (buf.length > 0 || e.key !== ' ')) insert(pick);
        else {
          // nothing matched: behave as if "/" had been typed normally (fraction) + the letters
          typeText('/' + buf);
          emit();
        }
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        // any other character (digit, parenthesis…) ⇒ plain "/" meant division, e.g. "1/2"
        setSlashState(null);
        typeText('/' + buf);
        return; // let MathLive handle this key normally
      }
    };

    mf.addEventListener('input', onInput);
    mf.addEventListener('keydown', onKeyDown, { capture: true });
    if (autoFocus) setTimeout(() => mf.focus(), 50);
    return () => {
      mf.removeEventListener('input', onInput);
      mf.removeEventListener('keydown', onKeyDown, { capture: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);

  // controlled value (e.g. reset after question change); avoid clobbering the caret while typing
  useEffect(() => {
    const mf = ref.current;
    if (mf && mf.getValue('latex-without-placeholders') !== value) {
      mf.value = value;
      try {
        setAscii(value ? mf.getValue('ascii-math') : '');
      } catch {
        setAscii('');
      }
    }
  }, [value]);

  useEffect(() => {
    if (ref.current) ref.current.readOnly = !!disabled;
  }, [disabled]);

  const shortcutOf = (id: string) => keys[id];

  return (
    <div className={`math-editor ${compact ? 'compact' : ''}`}>
      <div className="math-toolbar" role="toolbar" aria-label="수식 도구">
        {MATH_COMMANDS.filter((c) => c.toolbar).map((c) => (
          <button
            key={c.id}
            type="button"
            className="math-tool"
            title={`${c.description}${shortcutOf(c.id) ? ` (${shortcutOf(c.id)})` : ''}  /${c.slash[0]}`}
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault() /* keep focus in the editor */}
            onClick={() => insert(c)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="math-field-wrap">
        <math-field ref={ref} className="math-field" aria-label={placeholder ?? '수식 답안'} />
        {slash !== null && (
          <div className="slash-palette" role="listbox">
            <div className="slash-head">/{slash}</div>
            {matches.length === 0 && <div className="slash-empty">일치하는 명령 없음 — Enter: 그대로 입력</div>}
            {matches.slice(0, 8).map((c, i) => (
              <div
                key={c.id}
                role="option"
                aria-selected={i === slashIndex}
                className={`slash-item ${i === slashIndex ? 'active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setSlashState(null);
                  insert(c);
                }}
              >
                <span className="slash-label">{c.label}</span>
                <span>/{c.slash[0]}</span>
                <span className="muted">{c.description}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {!compact && (
        <div className="math-hint">
          {ascii ? <span>해석: <code>{ascii}</code></span> : <span className="muted">/ 를 입력하면 명령 목록 · 분수 {keys.frac} · 루트 {keys.sqrt} · 제곱 {keys.square} · π {keys.pi}</span>}
        </div>
      )}
    </div>
  );
}
