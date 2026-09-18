import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { AppError, type UserRole } from '@brainbattle/shared';

export interface UserClaims {
  typ: 'user';
  sub: string;
  role: UserRole;
  name: string;
}

export interface ScoreboardClaims {
  typ: 'scoreboard';
  sid: string;
}

export class TokenService {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly userTtl = '12h',
    private readonly boardTtl = '24h',
  ) {
    if (secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
    this.key = new TextEncoder().encode(secret);
  }

  signUser(c: Omit<UserClaims, 'typ'>): Promise<string> {
    return new SignJWT({ typ: 'user', role: c.role, name: c.name })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(c.sub)
      .setIssuedAt()
      .setExpirationTime(this.userTtl)
      .sign(this.key);
  }

  signScoreboard(sessionId: string): Promise<string> {
    return new SignJWT({ typ: 'scoreboard', sid: sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(this.boardTtl)
      .sign(this.key);
  }

  async verifyUser(token: string): Promise<UserClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'] });
      if (payload.typ !== 'user' || typeof payload.sub !== 'string') throw new Error('wrong token type');
      return { typ: 'user', sub: payload.sub, role: payload.role as UserRole, name: String(payload.name ?? '') };
    } catch {
      throw new AppError('UNAUTHENTICATED', 'invalid or expired token');
    }
  }

  async verifyScoreboard(token: string): Promise<ScoreboardClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'] });
      if (payload.typ !== 'scoreboard' || typeof payload.sid !== 'string') throw new Error('wrong token type');
      return { typ: 'scoreboard', sid: payload.sid };
    } catch {
      throw new AppError('UNAUTHENTICATED', 'invalid or expired scoreboard token');
    }
  }
}

export function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10);
}

export function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}
