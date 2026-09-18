import type { AuthResponse, UserDTO } from '@brainbattle/shared';

/** Base URL of the dedicated BrainBattle server. Empty ⇒ same origin (dev proxy / served by the server). */
export const API_BASE: string = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

/**
 * WebSocket endpoint. `sid` (when known) is a routing hint so a load balancer can hash every
 * connection of a session to the battle node that owns it (see docs/DESIGN.md §3).
 */
export function wsUrl(sid?: string | null): string {
  const explicit = import.meta.env.VITE_WS_URL as string | undefined;
  const q = sid ? `?sid=${encodeURIComponent(sid)}` : '';
  if (explicit) return explicit + q;
  if (API_BASE) return API_BASE.replace(/^http/, 'ws') + '/ws' + q;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws${q}`;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'bb.auth';

export interface StoredAuth {
  token: string;
  user: UserDTO;
}

export function loadAuth(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? (JSON.parse(raw) as StoredAuth) : null;
  } catch {
    return null;
  }
}

export function saveAuth(a: StoredAuth | null): void {
  try {
    if (a) localStorage.setItem(TOKEN_KEY, JSON.stringify(a));
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const auth = loadAuth();
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(auth ? { authorization: `Bearer ${auth.token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const err = json?.error ?? { code: 'HTTP_' + res.status, message: res.statusText };
    if (res.status === 401) saveAuth(null);
    throw new ApiError(res.status, err.code, err.message, err.details);
  }
  return json as T;
}

export async function downloadWithAuth(path: string, filename: string): Promise<void> {
  const auth = loadAuth();
  const res = await fetch(API_BASE + path, { headers: auth ? { authorization: `Bearer ${auth.token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD_FAILED', 'download failed');
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export const auth = {
  login: (email: string, password: string) => api<AuthResponse>('POST', '/api/auth/login', { email, password }),
  register: (email: string, password: string, displayName: string, role: 'TEACHER' | 'STUDENT') =>
    api<AuthResponse>('POST', '/api/auth/register', { email, password, displayName, role }),
};
