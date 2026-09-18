import { createHash, randomBytes, randomInt } from 'node:crypto';

/** Opaque, prefixed, URL-safe ids: q_f82ac9d1c0e4… */
export function newId(prefix: string, bytes = 9): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Crockford-like alphabet without ambiguous characters (0/O, 1/I/L). */
const ALNUM = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function generateJoinCode(format: 'NUMERIC_6' | 'BRAIN_ALNUM'): string {
  if (format === 'NUMERIC_6') return String(randomInt(100000, 1000000));
  let s = '';
  for (let i = 0; i < 4; i++) s += ALNUM[randomInt(0, ALNUM.length)];
  return `BRAIN-${s}`;
}

/** Normalizes user-typed join codes: "brain 7k2m" → "BRAIN-7K2M", "728 419" → "728419". */
export function normalizeJoinCode(input: string): string {
  const s = input.trim().toUpperCase().replace(/\s+/g, '');
  const m = /^BRAIN-?([0-9A-Z]{4})$/.exec(s);
  if (m) return `BRAIN-${m[1]}`;
  return s.replace(/[^0-9A-Z-]/g, '');
}

export function nicknameKey(nickname: string): string {
  return nickname.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
