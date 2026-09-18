import { useState } from 'react';
import { Link } from 'react-router-dom';
import { DEFAULT_SHORTCUTS, isBrowserReserved, MATH_COMMANDS, type ShortcutMap } from '@brainbattle/shared';
import { desktop, detectOS, effectiveShortcuts, loadShortcutOverrides, saveShortcutOverrides } from '../core/platform';
import { MathEditor } from '../components/MathEditor';

function describe(e: React.KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta'].filter(Boolean);
  if (!mods.length) return null;
  const code = e.nativeEvent.code;
  const key = code.startsWith('Key') ? code.slice(3) : code.startsWith('Digit') ? code.slice(5) : code === 'Slash' ? '/' : code === 'Equal' ? '=' : code === 'Minus' ? '-' : code;
  return [...mods, key].join('+');
}

/** Per-device math shortcut configuration (conflicts differ by OS / browser / desktop app). */
export default function SettingsPage() {
  const [overrides, setOverrides] = useState<ShortcutMap>(loadShortcutOverrides());
  const [recording, setRecording] = useState<string | null>(null);
  const [demo, setDemo] = useState('');
  const effective = effectiveShortcuts();
  const os = detectOS();
  const update = (m: ShortcutMap) => {
    setOverrides(m);
    saveShortcutOverrides(m);
  };
  return (
    <div className="settings-page">
      <Link to="/">← 처음으로</Link>
      <h1>수식 입력 단축키</h1>
      <p className="muted">
        환경: {desktop ? '데스크톱 앱' : '웹 브라우저'} / {os}. 브라우저가 예약한 단축키(예: Ctrl+숫자 = 탭 전환)는 웹에서 자동으로 Alt+숫자로 바뀝니다.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>명령</th>
            <th>슬래시</th>
            <th>단축키</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {MATH_COMMANDS.filter((c) => c.id in DEFAULT_SHORTCUTS || c.toolbar).map((c) => (
            <tr key={c.id}>
              <td>{c.label} {c.description}</td>
              <td><code>/{c.slash[0]}</code></td>
              <td>
                <button
                  className={`btn small ${recording === c.id ? 'primary' : ''}`}
                  onClick={() => setRecording(c.id)}
                  onKeyDown={(e) => {
                    if (recording !== c.id) return;
                    e.preventDefault();
                    if (e.key === 'Escape') return setRecording(null);
                    const b = describe(e);
                    if (!b) return;
                    if (!desktop && isBrowserReserved(b, os)) {
                      alert(`${b} 는 브라우저가 사용하는 단축키입니다.`);
                      return;
                    }
                    update({ ...overrides, [c.id]: b });
                    setRecording(null);
                  }}
                >
                  {recording === c.id ? '키를 누르세요…' : (effective[c.id] ?? '없음')}
                </button>
              </td>
              <td>
                {overrides[c.id] && (
                  <button className="btn ghost small" onClick={() => {
                    const { [c.id]: _, ...rest } = overrides;
                    update(rest);
                  }}>기본값</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>연습</h2>
      <MathEditor value={demo} onChange={setDemo} shortcuts={effective} />
      <p className="muted small">LaTeX(저장 형식): <code>{demo || '—'}</code></p>
    </div>
  );
}
