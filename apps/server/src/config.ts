import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

export interface ServerConfig {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  corsOrigins: string[] | '*';
  nodeId: string;
  /** public base URL of this node (ws redirect target when another node asks) */
  nodePublicUrl: string | null;
  allowTeacherSignup: boolean;
  webDist: string | null;
  leaseTtlMs: number;
  idleUnloadMs: number;
  heartbeatMs: number;
  leaderboardSnapshotIntervalMs: number;
  trustWindowMs: number;
  logLevel: string;
  authRateLimitPerMin: number;
  apiRateLimitPerMin: number;
  /** AI authoring assistant; disabled (503) when no key is configured */
  anthropicApiKey: string | null;
  aiModel: string;
  aiRateLimitPerMin: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const mode = (env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development') as ServerConfig['env'];
  let jwtSecret = env.JWT_SECRET ?? '';
  if (!jwtSecret) {
    if (mode === 'production') throw new Error('JWT_SECRET is required in production');
    jwtSecret = randomBytes(32).toString('hex');
    if (mode === 'development') console.warn('[brainbattle] JWT_SECRET not set — using an ephemeral secret (tokens reset on restart)');
  }
  const origins = env.CORS_ORIGINS?.trim();
  return {
    env: mode,
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 4000),
    databaseUrl: env.DATABASE_URL ?? 'pglite://./.data/pglite',
    jwtSecret,
    corsOrigins: !origins || origins === '*' ? (mode === 'production' ? [] : '*') : origins.split(',').map((s) => s.trim()),
    nodeId: env.NODE_ID ?? `${hostname()}-${process.pid}`,
    nodePublicUrl: env.NODE_PUBLIC_URL ?? null,
    allowTeacherSignup: (env.ALLOW_TEACHER_SIGNUP ?? (mode === 'production' ? 'false' : 'true')) === 'true',
    webDist: env.WEB_DIST ?? null,
    leaseTtlMs: Number(env.SESSION_LEASE_TTL_MS ?? 15_000),
    idleUnloadMs: Number(env.SESSION_IDLE_UNLOAD_MS ?? 10 * 60_000),
    heartbeatMs: Number(env.WS_HEARTBEAT_MS ?? 15_000),
    leaderboardSnapshotIntervalMs: Number(env.LEADERBOARD_SNAPSHOT_MS ?? 5000),
    trustWindowMs: Number(env.TIMESTAMP_TRUST_WINDOW_MS ?? 1000),
    logLevel: env.LOG_LEVEL ?? (mode === 'test' ? 'silent' : 'info'),
    authRateLimitPerMin: Number(env.AUTH_RATE_LIMIT_PER_MIN ?? 20),
    apiRateLimitPerMin: Number(env.API_RATE_LIMIT_PER_MIN ?? 600),
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || null,
    aiModel: env.AI_MODEL?.trim() || 'claude-opus-5-5',
    aiRateLimitPerMin: Number(env.AI_RATE_LIMIT_PER_MIN ?? 10),
  };
}
