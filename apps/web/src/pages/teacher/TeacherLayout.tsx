import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../../core/auth';
import { desktop } from '../../core/platform';

export function TeacherLayout({ children, title, actions }: { children: ReactNode; title?: string; actions?: ReactNode }) {
  const { user, logout } = useAuth();
  return (
    <div className="teacher">
      <header className="t-header">
        <Link to="/teacher" className="brand small">
          <span className="brand-mark">B</span> BrainBattle
        </Link>
        <nav className="t-nav">
          <NavLink to="/teacher" end>홈</NavLink>
          <NavLink to="/teacher/questions">문제 은행</NavLink>
          <NavLink to="/teacher/sessions/new">새 세션</NavLink>
        </nav>
        <div className="spacer" />
        {desktop && (
          <button className="btn ghost" onClick={() => void desktop!.toggleFullscreen()} title="전체화면 (F11)">⛶</button>
        )}
        <span className="muted">{user?.displayName}</span>
        <button className="btn ghost" onClick={logout}>로그아웃</button>
      </header>
      {(title || actions) && (
        <div className="t-titlebar">
          {title && <h1>{title}</h1>}
          <div className="spacer" />
          {actions}
        </div>
      )}
      <div className="t-content">{children}</div>
    </div>
  );
}
