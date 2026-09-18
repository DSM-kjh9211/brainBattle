import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  AppError,
  clientEnvelopeSchema,
  clientMessageSchemas,
  STUDENT_COMMANDS,
  TEACHER_COMMANDS,
  type ClientMessageType,
  type ClientPayload,
  type ServerEventMap,
  type ServerEventType,
} from '@brainbattle/shared';
import type { Clock } from '../lib/clock.js';
import type { TokenService } from '../lib/auth.js';
import { JoinGuard, TokenBucket } from '../lib/rateLimit.js';
import { newId, normalizeJoinCode } from '../lib/util.js';
import type { AuditLog } from '../repositories/users.js';
import type { SessionManager } from './sessionManager.js';
import type { Conn, SessionRuntime } from './sessionRuntime.js';

export interface HubDeps {
  manager: SessionManager;
  tokens: TokenService;
  clock: Clock;
  audit: AuditLog;
  joinGuard: JoinGuard;
  allowedOrigins: string[] | '*';
  heartbeatMs: number;
  log: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };
}

const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

class WsConn implements Conn {
  readonly id = newId('conn', 8);
  role: Conn['role'] = null;
  userId: string | null = null;
  isAdmin = false;
  participantId: string | null = null;
  sessionId: string | null = null;
  alive = true;
  joining = false;
  chain: Promise<void> = Promise.resolve();
  readonly buckets: { any: TokenBucket; submit: TokenBucket; join: TokenBucket };

  constructor(
    readonly ws: WebSocket,
    readonly ip: string,
    clock: Clock,
  ) {
    this.buckets = {
      any: new TokenBucket(60, 30, clock),
      submit: new TokenBucket(10, 5, clock), // answer submit/update: burst 10, 5/s sustained
      join: new TokenBucket(5, 0.5, clock),
    };
  }

  send<T extends ServerEventType>(type: T, payload: ServerEventMap[T], opts: { reqId?: string; seq?: number } = {}): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      // slow consumer: drop it rather than buffering unboundedly; it will reconnect and resync
      this.ws.close(4008, 'slow consumer');
      return;
    }
    this.ws.send(JSON.stringify({ type, ...(opts.reqId ? { reqId: opts.reqId } : {}), ...(opts.seq !== undefined ? { seq: opts.seq } : {}), payload }));
  }

  close(code: number, reason: string): void {
    try {
      this.ws.close(code, reason);
    } catch {
      this.ws.terminate();
    }
  }
}

/**
 * WebSocket gateway: authentication, per-connection rate limiting, schema validation, role-based
 * authorization, and routing to the owning SessionRuntime. Every command is re-authorized on the
 * server; hiding buttons in the UI is never relied upon.
 */
export class RealtimeHub {
  private wss: WebSocketServer | null = null;
  private readonly conns = new Set<WsConn>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: HubDeps) {}

  attach(server: Server, path = '/ws'): void {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== path) return;
      if (!this.originAllowed(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
    });
    // liveness uses real time (not the injectable domain clock): a missed pong ⇒ terminate ⇒ DISCONNECTED
    this.heartbeat = setInterval(() => {
      for (const c of this.conns) {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        try {
          c.ws.ping();
        } catch {
          /* ignore */
        }
      }
    }, this.deps.heartbeatMs);
    this.heartbeat.unref?.();
  }

  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (this.deps.allowedOrigins === '*' || !origin) return true; // non-browser clients (desktop, tests) send no Origin
    return this.deps.allowedOrigins.includes(origin);
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    const conn = new WsConn(ws, ip, this.deps.clock);
    this.conns.add(conn);
    ws.on('pong', () => (conn.alive = true));
    ws.on('message', (data: RawData, isBinary: boolean) => {
      // stamp receipt time before any queueing: this is serverReceivedAt
      const receivedAt = this.deps.clock.now();
      conn.alive = true;
      if (isBinary) return conn.send('ERROR', { code: 'BAD_REQUEST', message: 'binary frames not supported' });
      const text = data.toString();
      // TIME_SYNC bypasses the per-connection queue so the server hold time (t2 − t1) stays tiny;
      // everything else is processed strictly in arrival order per connection.
      if (text.includes('"TIME_SYNC_REQUEST"')) return void this.onMessage(conn, text, receivedAt);
      conn.chain = conn.chain.then(() => this.onMessage(conn, text, receivedAt));
    });
    ws.on('close', () => {
      this.conns.delete(conn);
      if (conn.sessionId) this.deps.manager.peek(conn.sessionId)?.onDisconnect(conn);
    });
    ws.on('error', () => undefined);
  }

  private async onMessage(conn: WsConn, raw: string, receivedAt: number): Promise<void> {
    let reqId: string | undefined;
    try {
      if (!conn.buckets.any.take()) throw new AppError('RATE_LIMITED', 'too many messages');
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new AppError('BAD_REQUEST', 'invalid JSON');
      }
      const env = clientEnvelopeSchema.parse(json);
      reqId = env.reqId;
      const type = env.type as ClientMessageType;
      const schema = clientMessageSchemas[type];
      if (!schema) throw new AppError('BAD_REQUEST', `unknown message type ${env.type}`);
      const parsed = schema.safeParse(env.payload ?? {});
      if (!parsed.success) {
        throw new AppError('BAD_REQUEST', 'invalid payload', { issues: parsed.error.issues.slice(0, 5) as unknown as Record<string, unknown> });
      }
      await this.dispatch(conn, type, parsed.data as never, receivedAt, reqId);
    } catch (e) {
      const err = e instanceof AppError ? e : null;
      if (!err) this.deps.log.error({ err: String(e), stack: (e as Error)?.stack }, 'ws message failed');
      conn.send(
        'ERROR',
        {
          code: err?.code ?? 'INTERNAL',
          message: err?.message ?? 'internal error',
          ...(err?.details ? { details: err.details } : {}),
        },
        { reqId },
      );
    }
  }

  private async runtimeFor(conn: WsConn): Promise<SessionRuntime> {
    if (!conn.sessionId) throw new AppError('NOT_JOINED', 'send JOIN_SESSION first');
    return this.deps.manager.get(conn.sessionId);
  }

  private async dispatch<T extends ClientMessageType>(
    conn: WsConn,
    type: T,
    payload: ClientPayload<T>,
    receivedAt: number,
    reqId?: string,
  ): Promise<void> {
    if (type === 'JOIN_SESSION') return this.join(conn, payload as ClientPayload<'JOIN_SESSION'>, reqId);

    if (type === 'TIME_SYNC_REQUEST') {
      const p = payload as ClientPayload<'TIME_SYNC_REQUEST'>;
      const rt = conn.sessionId ? this.deps.manager.peek(conn.sessionId) : undefined;
      if (rt) return rt.handleTimeSync(conn, p, receivedAt);
      return conn.send('TIME_SYNC_RESPONSE', {
        seq: p.seq,
        clientMono: p.clientMono,
        serverReceivedAt: receivedAt,
        serverSentAt: this.deps.clock.now(),
        accepted: false,
      });
    }

    const rt = await this.runtimeFor(conn);

    if (type === 'LEAVE_SESSION') return rt.leave(conn, reqId);
    if (type === 'REQUEST_SNAPSHOT') return rt.resendSnapshot(conn, reqId);

    if (STUDENT_COMMANDS.has(type)) {
      if (conn.role !== 'STUDENT' || !conn.participantId) throw new AppError('FORBIDDEN', 'student command');
      if (type === 'STUDENT_SELECT_QUESTION') {
        return rt.selectQuestion(conn, (payload as ClientPayload<'STUDENT_SELECT_QUESTION'>).sessionQuestionId, reqId);
      }
      if (!conn.buckets.submit.take()) throw new AppError('RATE_LIMITED', 'too many submissions');
      // a student can only ever write their own submission: the participant id comes from the
      // authenticated connection, never from the payload
      return rt.submit(conn, payload as ClientPayload<'SUBMIT_ANSWER'>, type === 'UPDATE_ANSWER', receivedAt, reqId);
    }

    if (TEACHER_COMMANDS.has(type)) {
      // re-authorize on every command
      if (conn.role !== 'TEACHER' || !conn.userId) throw new AppError('FORBIDDEN', 'teacher command');
      if (rt.session.teacherId !== conn.userId && !conn.isAdmin) throw new AppError('FORBIDDEN', 'not the teacher of this session');
      const actor = { type: 'TEACHER' as const, id: conn.userId };
      switch (type) {
        case 'TEACHER_OPEN_LOBBY': await rt.openLobby(actor); break;
        case 'TEACHER_SET_READY': await rt.setReady(actor, (payload as ClientPayload<'TEACHER_SET_READY'>).ready); break;
        case 'TEACHER_START_SESSION': await rt.startSession(actor); break;
        case 'TEACHER_PAUSE_SESSION': await rt.pauseSession(actor); break;
        case 'TEACHER_RESUME_SESSION': await rt.resumeSession(actor); break;
        case 'TEACHER_END_SESSION': await rt.endSession(actor); break;
        case 'TEACHER_START_QUESTION': await rt.startQuestion(actor, payload as ClientPayload<'TEACHER_START_QUESTION'>); break;
        case 'TEACHER_END_QUESTION': await rt.endQuestion(actor, (payload as ClientPayload<'TEACHER_END_QUESTION'>).sessionQuestionId); break;
        case 'TEACHER_SHOW_RESULT': await rt.showResult(actor, (payload as ClientPayload<'TEACHER_SHOW_RESULT'>).sessionQuestionId); break;
        case 'TEACHER_SCORE_UPDATE': await rt.setManualScore(actor, payload as ClientPayload<'TEACHER_SCORE_UPDATE'>); break;
        case 'TEACHER_KICK_PARTICIPANT': {
          const p = payload as ClientPayload<'TEACHER_KICK_PARTICIPANT'>;
          await rt.kick(actor, p.participantId, p.reason);
          await this.deps.audit.record({ actorId: conn.userId, action: 'PARTICIPANT_KICK', targetType: 'participant', targetId: p.participantId, ip: conn.ip });
          break;
        }
        case 'TEACHER_SET_SCOREBOARD': await rt.setScoreboard(actor, payload as ClientPayload<'TEACHER_SET_SCOREBOARD'>); break;
        case 'TEACHER_SET_PRESENTATION': await rt.setPresentation(actor, payload as ClientPayload<'TEACHER_SET_PRESENTATION'>); break;
        case 'TEACHER_EXTEND_TIME': await rt.extendTime(actor, (payload as ClientPayload<'TEACHER_EXTEND_TIME'>).seconds); break;
        case 'TEACHER_RELEASE_RESULTS': await rt.releaseResults(actor); break;
        default: throw new AppError('BAD_REQUEST', `unsupported ${type}`);
      }
      return conn.send('ACK', { ok: true }, { reqId });
    }
    throw new AppError('BAD_REQUEST', `unsupported ${type}`);
  }

  private async join(conn: WsConn, p: ClientPayload<'JOIN_SESSION'>, reqId?: string): Promise<void> {
    if (conn.sessionId) throw new AppError('CONFLICT', 'connection already joined a session');
    if (conn.joining) throw new AppError('CONFLICT', 'join already in progress');
    if (!conn.buckets.join.take()) throw new AppError('RATE_LIMITED', 'too many join attempts');
    conn.joining = true;
    try {
      if (p.role === 'TEACHER') {
        const claims = await this.deps.tokens.verifyUser(p.authToken);
        const rt = await this.deps.manager.get(p.sessionId).catch((e) => {
          throw e instanceof AppError && e.code === 'NOT_FOUND' ? new AppError('FORBIDDEN', 'not the teacher of this session') : e;
        });
        conn.isAdmin = claims.role === 'ADMIN';
        await rt.joinTeacher(conn, claims.sub, conn.isAdmin, reqId);
        return;
      }
      if (p.role === 'SCOREBOARD') {
        const claims = await this.deps.tokens.verifyScoreboard(p.scoreboardToken);
        if (claims.sid !== p.sessionId) throw new AppError('FORBIDDEN', 'token is for another session');
        const rt = await this.deps.manager.get(p.sessionId);
        await rt.joinBoard(conn, reqId);
        return;
      }

      // ---- student: brute-force protection on join codes
      const guardKey = conn.ip;
      if (this.deps.joinGuard.isBlocked(guardKey)) throw new AppError('JOIN_BLOCKED', 'too many failed attempts, try again later');
      let user: { id: string; name: string } | null = null;
      if (p.authToken) {
        const c = await this.deps.tokens.verifyUser(p.authToken);
        user = { id: c.sub, name: c.name };
      }
      let sessionId: string | null = null;
      if (p.sessionId && p.resumeToken) sessionId = p.sessionId;
      else if (p.joinCode) sessionId = await this.deps.manager.findByJoinCode(normalizeJoinCode(p.joinCode));
      else throw new AppError('BAD_REQUEST', 'joinCode or sessionId+resumeToken required');

      if (!sessionId) {
        this.deps.joinGuard.recordFailure(guardKey);
        void this.deps.audit.record({ actorId: user?.id ?? null, action: 'JOIN_CODE_FAILED', ip: conn.ip, details: { code: p.joinCode } });
        throw new AppError('INVALID_JOIN_CODE', 'no active session with this code');
      }
      let rt: SessionRuntime;
      try {
        rt = await this.deps.manager.get(sessionId);
      } catch (e) {
        if (e instanceof AppError && e.code === 'NOT_FOUND') {
          this.deps.joinGuard.recordFailure(guardKey);
          throw new AppError('INVALID_RESUME_TOKEN', 'session not found');
        }
        throw e;
      }
      try {
        await rt.joinStudent(conn, { nickname: p.nickname, resumeToken: p.resumeToken, user }, reqId);
      } catch (e) {
        if (e instanceof AppError && e.code === 'INVALID_RESUME_TOKEN') this.deps.joinGuard.recordFailure(guardKey);
        throw e;
      }
      this.deps.joinGuard.recordSuccess(guardKey);
    } finally {
      conn.joining = false;
    }
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.conns) c.ws.terminate();
    this.conns.clear();
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
  }
}
