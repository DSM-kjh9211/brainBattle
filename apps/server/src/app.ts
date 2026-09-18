import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import {
  AppError,
  createSessionSchema,
  PRESET_SETTINGS,
  questionInputSchema,
  questionSetInputSchema,
  resolveSessionSettings,
  sessionSettingsPatchSchema,
  settingsWarnings,
  USER_ROLES,
  type UserRole,
} from '@brainbattle/shared';
import type { ServerConfig } from './config.js';
import { createDb, migrate, type Db } from './db/db.js';
import { TokenService, type UserClaims } from './lib/auth.js';
import { systemClock, type Clock } from './lib/clock.js';
import { JoinGuard } from './lib/rateLimit.js';
import { QuestionRepository } from './repositories/questions.js';
import { QuestionSetRepository } from './repositories/questionSets.js';
import { AuditLog, ClassroomRepository, UserRepository } from './repositories/users.js';
import { RealtimeHub } from './realtime/hub.js';
import { SessionManager } from './realtime/sessionManager.js';
import { DEFAULT_RUNTIME_CONFIG } from './realtime/sessionRuntime.js';
import { SessionStore } from './realtime/sessionStore.js';
import { SessionService } from './services/sessionService.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserClaims;
  }
}

export interface BuiltServer {
  app: FastifyInstance;
  db: Db;
  manager: SessionManager;
  hub: RealtimeHub;
  tokens: TokenService;
  close(): Promise<void>;
}

export async function buildServer(config: ServerConfig, opts: { clock?: Clock; db?: Db } = {}): Promise<BuiltServer> {
  const clock = opts.clock ?? systemClock;
  const db = opts.db ?? (await createDb(config.databaseUrl));
  await migrate(db);

  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });
  const log = {
    info: (o: object, m?: string) => app.log.info(o, m),
    warn: (o: object, m?: string) => app.log.warn(o, m),
    error: (o: object, m?: string) => app.log.error(o, m),
  };

  const tokens = new TokenService(config.jwtSecret);
  const users = new UserRepository(db);
  const classrooms = new ClassroomRepository(db);
  const audit = new AuditLog(db);
  const questions = new QuestionRepository(db);
  const sets = new QuestionSetRepository(db);
  const sessions = new SessionService(db);
  const store = new SessionStore(db);
  const manager = new SessionManager({
    db,
    store,
    clock,
    classrooms,
    log,
    nodeId: config.nodeId,
    nodeUrl: config.nodePublicUrl,
    leaseTtlMs: config.leaseTtlMs,
    idleUnloadMs: config.idleUnloadMs,
    config: {
      ...DEFAULT_RUNTIME_CONFIG,
      leaderboardSnapshotIntervalMs: config.leaderboardSnapshotIntervalMs,
      trust: { ...DEFAULT_RUNTIME_CONFIG.trust, trustWindowMs: config.trustWindowMs },
    },
  });
  const joinGuard = new JoinGuard(clock);
  const hub = new RealtimeHub({
    manager,
    tokens,
    clock,
    audit,
    joinGuard,
    allowedOrigins: config.corsOrigins,
    heartbeatMs: config.heartbeatMs,
    log,
  });

  await app.register(cors, { origin: config.corsOrigins === '*' ? true : config.corsOrigins, credentials: false });
  await app.register(rateLimit, { global: true, max: config.apiRateLimitPerMin, timeWindow: '1 minute' });

  /* ------------------------------------------------------------------ errors */
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.httpStatus).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'validation failed', details: { issues: err.issues } } });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode === 429) return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: 'too many requests' } });
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: 'BAD_REQUEST', message: e.message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'internal error' } });
  });

  /* ------------------------------------------------------------------ auth helpers */
  const authenticate = async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new AppError('UNAUTHENTICATED', 'missing bearer token');
    req.user = await tokens.verifyUser(h.slice(7));
  };
  const requireRole =
    (...roles: UserRole[]) =>
    async (req: FastifyRequest) => {
      await authenticate(req);
      if (!roles.includes(req.user!.role) && req.user!.role !== 'ADMIN') throw new AppError('FORBIDDEN', 'insufficient role');
    };
  const teacher = { preHandler: requireRole('TEACHER') };
  const uid = (req: FastifyRequest) => req.user!.sub;
  const params = <T extends z.ZodRawShape>(req: FastifyRequest, shape: T) => z.object(shape).parse(req.params);
  const idParam = { id: z.string().min(1).max(64) };

  /* ------------------------------------------------------------------ health */
  app.get('/api/health', async () => {
    await db.query('SELECT 1');
    return { ok: true, nodeId: config.nodeId, sessionsLoaded: manager.loaded.length, connections: hub.connectionCount, time: clock.now() };
  });

  /* ------------------------------------------------------------------ auth */
  const authLimit = { config: { rateLimit: { max: config.authRateLimitPerMin, timeWindow: '1 minute' } } };
  app.post('/api/auth/register', authLimit, async (req) => {
    const body = z
      .object({
        email: z.string().email().max(200),
        password: z.string().min(8).max(200),
        displayName: z.string().min(1).max(60),
        role: z.enum(USER_ROLES).default('STUDENT'),
      })
      .parse(req.body);
    if (body.role === 'ADMIN') throw new AppError('FORBIDDEN', 'cannot self-register as admin');
    if (body.role === 'TEACHER' && !config.allowTeacherSignup) throw new AppError('FORBIDDEN', 'teacher signup is disabled');
    const user = await users.create(body);
    await audit.record({ actorId: user.id, action: 'USER_REGISTER', targetType: 'user', targetId: user.id, ip: req.ip });
    return { token: await tokens.signUser({ sub: user.id, role: user.role, name: user.displayName }), user };
  });

  app.post('/api/auth/login', authLimit, async (req) => {
    const body = z.object({ email: z.string().max(200), password: z.string().max(200) }).parse(req.body);
    try {
      const user = await users.authenticate(body.email, body.password);
      await audit.record({ actorId: user.id, action: 'LOGIN', ip: req.ip });
      return { token: await tokens.signUser({ sub: user.id, role: user.role, name: user.displayName }), user };
    } catch (e) {
      await audit.record({ actorId: null, action: 'LOGIN_FAILED', ip: req.ip, details: { email: body.email } });
      throw e;
    }
  });

  app.get('/api/auth/me', { preHandler: authenticate }, async (req) => {
    const u = await users.get(uid(req));
    if (!u) throw new AppError('UNAUTHENTICATED', 'user no longer exists');
    return u;
  });

  /* ------------------------------------------------------------------ questions */
  app.get('/api/questions', teacher, async (req) => {
    const q = z
      .object({ search: z.string().max(100).optional(), type: z.string().max(40).optional(), limit: z.coerce.number().optional(), offset: z.coerce.number().optional() })
      .parse(req.query);
    return questions.list(uid(req), q);
  });
  app.post('/api/questions', teacher, async (req) => questions.create(uid(req), questionInputSchema.parse(req.body)));
  app.get('/api/questions/:id', teacher, async (req) => questions.getOwned(params(req, idParam).id, uid(req)));
  app.put('/api/questions/:id', teacher, async (req) => questions.update(params(req, idParam).id, uid(req), questionInputSchema.parse(req.body)));
  app.delete('/api/questions/:id', teacher, async (req, reply) => {
    const { id } = params(req, idParam);
    await questions.delete(id, uid(req));
    await audit.record({ actorId: uid(req), action: 'QUESTION_DELETE', targetType: 'question', targetId: id, ip: req.ip });
    return reply.status(204).send();
  });
  app.post('/api/questions/:id/duplicate', teacher, async (req) => questions.duplicate(params(req, idParam).id, uid(req)));

  /* ------------------------------------------------------------------ question sets */
  app.get('/api/question-sets', teacher, async (req) => sets.list(uid(req)));
  app.post('/api/question-sets', teacher, async (req) => sets.create(uid(req), questionSetInputSchema.parse(req.body)));
  app.get('/api/question-sets/:id', teacher, async (req) => sets.getOwned(params(req, idParam).id, uid(req)));
  app.put('/api/question-sets/:id', teacher, async (req) => sets.update(params(req, idParam).id, uid(req), questionSetInputSchema.parse(req.body)));
  app.delete('/api/question-sets/:id', teacher, async (req, reply) => {
    const { id } = params(req, idParam);
    await sets.delete(id, uid(req));
    await audit.record({ actorId: uid(req), action: 'QUESTION_SET_DELETE', targetType: 'question_set', targetId: id, ip: req.ip });
    return reply.status(204).send();
  });
  app.post('/api/question-sets/:id/duplicate', teacher, async (req) => sets.duplicateSet(params(req, idParam).id, uid(req)));
  /** full preview of a set (teacher view, includes answers) */
  app.get('/api/question-sets/:id/preview', teacher, async (req) => {
    const set = await sets.getOwned(params(req, idParam).id, uid(req));
    const qs = await Promise.all(set.items.map((i) => questions.get(i.questionId)));
    return { set, questions: qs.filter(Boolean) };
  });
  app.post('/api/question-sets/:id/items', teacher, async (req) => {
    const body = z
      .object({
        questionId: z.string().min(1),
        position: z.number().int().min(0).optional(),
        displayNumber: z.string().max(40).nullable().optional(),
        scoreOverride: z.number().min(0).nullable().optional(),
      })
      .parse(req.body);
    return sets.addQuestion(params(req, idParam).id, uid(req), body.questionId, body);
  });
  /** create a question and append it to the set in one call */
  app.post('/api/question-sets/:id/questions', teacher, async (req) => {
    const { id } = params(req, idParam);
    await sets.getOwned(id, uid(req));
    const q = await questions.create(uid(req), questionInputSchema.parse(req.body));
    return sets.addQuestion(id, uid(req), q.id);
  });
  app.patch('/api/question-sets/:id/items/:itemId', teacher, async (req) => {
    const p = params(req, { ...idParam, itemId: z.string().min(1) });
    const body = z
      .object({ displayNumber: z.string().max(40).nullable().optional(), scoreOverride: z.number().min(0).nullable().optional() })
      .parse(req.body);
    return sets.updateItem(p.id, uid(req), p.itemId, body);
  });
  app.delete('/api/question-sets/:id/items/:itemId', teacher, async (req) => {
    const p = params(req, { ...idParam, itemId: z.string().min(1) });
    return sets.removeItem(p.id, uid(req), p.itemId);
  });
  app.post('/api/question-sets/:id/items/:itemId/duplicate', teacher, async (req) => {
    const p = params(req, { ...idParam, itemId: z.string().min(1) });
    return sets.duplicateItem(p.id, uid(req), p.itemId);
  });
  app.put('/api/question-sets/:id/order', teacher, async (req) => {
    const body = z.object({ itemIds: z.array(z.string().min(1)).max(1000) }).parse(req.body);
    return sets.reorder(params(req, idParam).id, uid(req), body.itemIds);
  });

  /* ------------------------------------------------------------------ sessions */
  app.get('/api/presets', async () => ({ presets: PRESET_SETTINGS }));
  app.post('/api/settings/preview', async (req) => {
    const body = z
      .object({ preset: createSessionSchema.shape.preset, settings: sessionSettingsPatchSchema.optional() })
      .parse(req.body);
    const settings = resolveSessionSettings(body.preset, body.settings);
    return { settings, warnings: settingsWarnings(settings) };
  });

  app.post('/api/sessions', teacher, async (req) => {
    const created = await sessions.create(uid(req), createSessionSchema.parse(req.body));
    await audit.record({ actorId: uid(req), action: 'SESSION_CREATE', targetType: 'session', targetId: created.id, ip: req.ip });
    return { ...created, warnings: settingsWarnings(created.settings) };
  });
  app.get('/api/sessions', teacher, async (req) => sessions.list(uid(req)));
  app.get('/api/sessions/:id', teacher, async (req) => {
    const { id } = params(req, idParam);
    await sessions.assertOwner(id, uid(req), req.user!.role === 'ADMIN');
    return sessions.summary(id);
  });
  app.patch('/api/sessions/:id/settings', teacher, async (req) => {
    const { id } = params(req, idParam);
    await sessions.assertOwner(id, uid(req), req.user!.role === 'ADMIN');
    await manager.updateSettings(id, sessionSettingsPatchSchema.parse(req.body));
    const rt = await manager.get(id);
    return { settings: rt.session.settings, warnings: settingsWarnings(rt.session.settings) };
  });
  app.post('/api/sessions/:id/scoreboard-token', teacher, async (req) => {
    const { id } = params(req, idParam);
    await sessions.assertOwner(id, uid(req), req.user!.role === 'ADMIN');
    await audit.record({ actorId: uid(req), action: 'SCOREBOARD_TOKEN', targetType: 'session', targetId: id, ip: req.ip });
    return { token: await tokens.signScoreboard(id) };
  });
  app.get('/api/sessions/:id/results', teacher, async (req) => {
    const { id } = params(req, idParam);
    await sessions.assertOwner(id, uid(req), req.user!.role === 'ADMIN');
    return sessions.results(id);
  });
  app.get('/api/sessions/:id/results.csv', teacher, async (req, reply: FastifyReply) => {
    const { id } = params(req, idParam);
    await sessions.assertOwner(id, uid(req), req.user!.role === 'ADMIN');
    const r = await sessions.results(id);
    const byKey = new Map(r.submissions.map((s) => [`${s.participantId}:${s.sessionQuestionId}`, s]));
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['rank', 'nickname', 'score', 'correct', ...r.questions.map((q) => `Q${q.displayNumber}`)];
    const lines = r.leaderboard.map((e) =>
      [e.rank, e.nickname, e.score, e.correctCount, ...r.questions.map((q) => byKey.get(`${e.participantId}:${q.sessionQuestionId}`)?.finalScore ?? '')]
        .map(esc)
        .join(','),
    );
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="brainbattle-${id}.csv"`);
    return '﻿' + [header.map(esc).join(','), ...lines].join('\r\n');
  });
  app.get('/api/sessions/:id/submissions/:submissionId/revisions', teacher, async (req) => {
    const p = params(req, { ...idParam, submissionId: z.string().min(1) });
    await sessions.assertOwner(p.id, uid(req), req.user!.role === 'ADMIN');
    return sessions.revisions(p.id, p.submissionId);
  });
  app.get('/api/sessions/:id/events', teacher, async (req) => {
    const { id } = params(req, idParam);
    await sessions.assertOwner(id, uid(req), req.user!.role === 'ADMIN');
    return sessions.events(id);
  });

  /* ------------------------------------------------------------------ classrooms */
  app.get('/api/classrooms', teacher, async (req) => classrooms.list(uid(req)));
  app.post('/api/classrooms', teacher, async (req) => {
    const body = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
    return classrooms.create(uid(req), body.name);
  });
  app.get('/api/classrooms/:id/members', teacher, async (req) => {
    const { id } = params(req, idParam);
    await classrooms.assertOwner(id, uid(req));
    return classrooms.members(id);
  });
  app.post('/api/classrooms/:id/members', teacher, async (req) => {
    const { id } = params(req, idParam);
    await classrooms.assertOwner(id, uid(req));
    const body = z.object({ email: z.string().email() }).parse(req.body);
    const user = await users.findByEmail(body.email);
    if (!user) throw new AppError('NOT_FOUND', 'no user with that email');
    await classrooms.addMember(id, user.id);
    return classrooms.members(id);
  });
  app.delete('/api/classrooms/:id/members/:userId', teacher, async (req) => {
    const p = params(req, { ...idParam, userId: z.string().min(1) });
    await classrooms.assertOwner(p.id, uid(req));
    await classrooms.removeMember(p.id, p.userId);
    return classrooms.members(p.id);
  });

  /* ------------------------------------------------------------------ static web app (optional) */
  if (config.webDist) {
    const root = resolve(config.webDist);
    if (existsSync(root)) {
      await app.register(fastifyStatic, { root, wildcard: false });
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
          return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'not found' } });
        }
        return reply.sendFile('index.html'); // SPA fallback
      });
    }
  }

  await app.ready();
  hub.attach(app.server);

  return {
    app,
    db,
    manager,
    hub,
    tokens,
    async close() {
      await manager.shutdown();
      await hub.close();
      await app.close();
      if (!opts.db) await db.close();
    },
  };
}
