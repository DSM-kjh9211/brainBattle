import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../core/api';
import { useAuth } from '../../core/auth';

export default function LoginPage() {
  const { login, register } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'TEACHER' | 'STUDENT'>('TEACHER');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password, name, role);
      nav(params.get('next') ?? (role === 'STUDENT' && mode === 'register' ? '/' : '/teacher'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '요청에 실패했습니다');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="home">
      <form className="home-card" onSubmit={submit}>
        <div className="brand small">
          <span className="brand-mark">B</span> BrainBattle
        </div>
        <div className="tabs">
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>로그인</button>
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>회원가입</button>
        </div>
        <input className="input" type="email" placeholder="이메일" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <input className="input" type="password" placeholder="비밀번호 (8자 이상)" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === 'register' ? 8 : 1} />
        {mode === 'register' && (
          <>
            <input className="input" placeholder="이름" value={name} onChange={(e) => setName(e.target.value)} required />
            <div className="seg">
              <label><input type="radio" checked={role === 'TEACHER'} onChange={() => setRole('TEACHER')} /> 교사</label>
              <label><input type="radio" checked={role === 'STUDENT'} onChange={() => setRole('STUDENT')} /> 학생</label>
            </div>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <button className="btn primary big" disabled={busy}>{mode === 'login' ? '로그인' : '가입'}</button>
        <p className="muted small">데모 계정: teacher@brainbattle.local / brainbattle123 (npm run seed)</p>
        <Link to="/" className="muted small">← 학생 참가 화면</Link>
      </form>
    </div>
  );
}
