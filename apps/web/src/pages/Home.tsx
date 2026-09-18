import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../core/auth';

export function normalizeCodeInput(s: string): string {
  const t = s.trim().toUpperCase().replace(/\s+/g, '');
  const m = /^BRAIN-?([0-9A-Z]{4})$/.exec(t);
  return m ? `BRAIN-${m[1]}` : t.replace(/[^0-9A-Z-]/g, '');
}

export function HomePage() {
  const [code, setCode] = useState('');
  const nav = useNavigate();
  const { user } = useAuth();
  const go = () => {
    const c = normalizeCodeInput(code);
    if (c.length >= 4) nav(`/play/${encodeURIComponent(c)}`);
  };
  return (
    <div className="home">
      <div className="home-card">
        <div className="brand">
          <span className="brand-mark">B</span> BrainBattle
        </div>
        <p className="tagline">실시간 문제 풀이 · 종이 시험 답안 제출 · 실시간 점수판</p>
        <form
          className="join-form"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <label htmlFor="code" className="sr-only">참가 코드</label>
          <input
            id="code"
            className="input code-input"
            placeholder="참가 코드 (예: 728419)"
            value={code}
            autoFocus
            autoComplete="off"
            inputMode="text"
            onChange={(e) => setCode(e.target.value)}
          />
          <button className="btn primary big" disabled={normalizeCodeInput(code).length < 4}>
            참가하기
          </button>
        </form>
        <div className="home-links">
          {user && (user.role === 'TEACHER' || user.role === 'ADMIN') ? (
            <Link to="/teacher">교사 대시보드 →</Link>
          ) : (
            <Link to="/teacher/login">교사 로그인</Link>
          )}
          <Link to="/settings">수식 단축키 설정</Link>
        </div>
      </div>
    </div>
  );
}
