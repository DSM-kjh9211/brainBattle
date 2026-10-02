import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../core/auth';
import { api, ApiError } from '../core/api';
import { Dialog } from '../components/Dialog';
import { errorText } from '../components/common';

export function normalizeCodeInput(s: string): string {
  const t = s.trim().toUpperCase().replace(/\s+/g, '');
  const m = /^BRAIN-?([0-9A-Z]{4})$/.exec(t);
  return m ? `BRAIN-${m[1]}` : t.replace(/[^0-9A-Z-]/g, '');
}
export interface JoinDetails { nickname: string; useAccount: boolean }
export function HomePage({ initialCode = '', joinError, onJoin }: {
  initialCode?: string; joinError?: string | null; onJoin?: (details: JoinDetails) => void;
}) {
  const [code, setCode] = useState(initialCode);
  const [checkedCode, setCheckedCode] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nickname, setNickname] = useState('');
  const { user } = useAuth();
  const [useAccount, setUseAccount] = useState(!!user);
  const nav = useNavigate();
  const busy = useRef(false);
  const joinButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const go = async () => {
    const c = normalizeCodeInput(code);
    if (c.length < 4 || busy.current) return;
    // Saved participants keep the original token-based resume flow.
    if (!onJoin) {
      try {
        const identity = JSON.parse(localStorage.getItem(`bb.identity.${c}`) ?? 'null');
        if (identity?.sessionId && identity?.resumeToken) { nav(`/play/${encodeURIComponent(c)}`); return; }
      } catch { /* storage unavailable */ }
    }
    busy.current = true;
    setChecking(true);
    setError(null);
    try {
      const result = await api<{ available: boolean }>('POST', '/api/join/check', { code: c });
      if (!mounted.current) return;
      if (result.available) setCheckedCode(c);
      else setError('현재 이 세션에는 참가할 수 없습니다.');
    } catch (e) {
      if (mounted.current) setError(e instanceof ApiError && e.status < 500
        ? errorText(e.code, '현재 이 세션에는 참가할 수 없습니다.')
        : '서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      busy.current = false;
      if (mounted.current) setChecking(false);
    }
  };
  return <div className="home">
    <div className="home-card">
      <div className="brand"><span className="brand-mark">B</span> BrainBattle</div>
      <p className="tagline">실시간 문제 풀이 · 종이 시험 답안 제출 · 실시간 점수판</p>
      <form className="join-form" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <label htmlFor="code">참가 코드</label>
        <input id="code" className="input code-input" placeholder="예: 728419" value={code}
          autoFocus autoComplete="off" inputMode="text" maxLength={32} disabled={checking}
          aria-describedby={error || joinError ? 'join-error' : undefined} aria-invalid={!!(error || joinError)}
          onChange={(e) => { setCode(e.target.value); setError(null); }} />
        {(error || joinError) && <p id="join-error" className="error" role="alert">{error ?? errorText(joinError!)}</p>}
        <button ref={joinButton} className="btn primary" disabled={checking || normalizeCodeInput(code).length < 4}>
          {checking ? '확인 중…' : '참가하기'}
        </button>
      </form>
      <div className="home-links">
        <Link to={user && (user.role === 'TEACHER' || user.role === 'ADMIN') ? '/teacher' : '/teacher/login'}>
          {user && (user.role === 'TEACHER' || user.role === 'ADMIN') ? '교사 대시보드' : '교사 로그인'}
        </Link><span aria-hidden="true">·</span><Link to="/settings">설정</Link>
      </div>
    </div>
    {checkedCode && <Dialog title="BrainBattle 참가" returnFocus={joinButton.current} onClose={() => setCheckedCode(null)}>
      <form className="dialog-form" onSubmit={(e) => {
        e.preventDefault();
        if (!nickname.trim()) return;
        const details = { nickname: nickname.trim(), useAccount };
        setCheckedCode(null);
        if (onJoin && checkedCode === initialCode) onJoin(details);
        else nav(`/play/${encodeURIComponent(checkedCode)}`, { state: details });
      }}>
        <label htmlFor="join-nickname">닉네임</label>
        <input id="join-nickname" className="input" value={nickname} maxLength={20} autoFocus
          autoComplete="nickname" onChange={(e) => setNickname(e.target.value)} />
        {user && <label className="checkbox"><input type="checkbox" checked={useAccount}
          onChange={(e) => setUseAccount(e.target.checked)} />{user.displayName} 계정으로 참가</label>}
        <div className="modal-actions"><button type="button" className="btn" onClick={() => setCheckedCode(null)}>취소</button>
          <button className="btn primary" disabled={!nickname.trim()}>입장</button></div>
      </form>
    </Dialog>}
  </div>;
}
