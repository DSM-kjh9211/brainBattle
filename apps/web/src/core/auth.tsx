import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { UserDTO } from '@brainbattle/shared';
import { auth as authApi, loadAuth, saveAuth, type StoredAuth } from './api';

interface AuthCtx {
  user: UserDTO | null;
  token: string | null;
  login(email: string, password: string): Promise<void>;
  register(email: string, password: string, name: string, role: 'TEACHER' | 'STUDENT'): Promise<void>;
  logout(): void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<StoredAuth | null>(() => loadAuth());
  const set = useCallback((a: StoredAuth | null) => {
    saveAuth(a);
    setStored(a);
  }, []);
  const value: AuthCtx = {
    user: stored?.user ?? null,
    token: stored?.token ?? null,
    login: async (email, password) => set(await authApi.login(email, password)),
    register: async (email, password, name, role) => set(await authApi.register(email, password, name, role)),
    logout: () => set(null),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('AuthProvider missing');
  return c;
}

/** UX guard only — every teacher API and WS command is authorized again by the server. */
export function RequireTeacher({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const loc = useLocation();
  if (!user || (user.role !== 'TEACHER' && user.role !== 'ADMIN')) {
    return <Navigate to={`/teacher/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  }
  return <>{children}</>;
}
