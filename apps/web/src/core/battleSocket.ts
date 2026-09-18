import {
  ClockSyncEstimator,
  type AnswerPayload,
  type ClientMessageType,
  type ClientPayload,
  type JoinSessionPayload,
  type ServerEnvelope,
  type ServerEventType,
  type SubmitAnswerPayload,
} from '@brainbattle/shared';
import { PendingQueue } from './pendingQueue';

export type SocketStatus = 'idle' | 'connecting' | 'joining' | 'live' | 'reconnecting' | 'closed' | 'fatal';

type AnyEnvelope = ServerEnvelope<ServerEventType>;

export interface BattleSocketOptions {
  url: string;
  /** builds the JOIN_SESSION payload (resume token may change after the first join) */
  join: (epochId: string) => JoinSessionPayload;
  onEvent: (env: AnyEnvelope) => void;
  onStatus?: (s: SocketStatus, detail?: string) => void;
  /** key for the pending queue; null for teacher / scoreboard */
  pendingKey?: string | null;
  syncIntervalMs?: number;
}

const FATAL_JOIN_CODES = new Set(['INVALID_JOIN_CODE', 'KICKED', 'INVALID_RESUME_TOKEN', 'FORBIDDEN', 'UNAUTHENTICATED', 'SESSION_CLOSED', 'SESSION_FULL', 'NICKNAME_TAKEN', 'LOGIN_REQUIRED', 'NOT_IN_CLASSROOM', 'JOIN_BLOCKED']);

const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * Client real-time core shared by the Student, Teacher and Scoreboard clients (web + desktop).
 *
 *  - reconnects with exponential backoff (and immediately on `online`)
 *  - re-joins with the stored identity (participantId is restored server-side via resume token)
 *  - TIME_SYNC: burst of samples on (re)connect, refresh every 30s and on visibility/network change
 *  - estimates server time from a monotonic clock (performance.now) — never Date.now()
 *  - persistent pending queue for submissions with idempotent replay
 */
export class BattleSocket {
  readonly clock = new ClockSyncEstimator();
  /** identifies this page's monotonic clock; performance.now() restarts on reload */
  readonly epochId = `ep_${newKey()}`;
  readonly pending: PendingQueue | null;
  status: SocketStatus = 'idle';

  private ws: WebSocket | null = null;
  private url: string;
  private reqSeq = 0;
  private syncSeq = 0;
  private waiters = new Map<string, { resolve: (e: AnyEnvelope) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = false;
  private syncing = false;
  private readonly listeners: (() => void)[] = [];

  constructor(private readonly opts: BattleSocketOptions) {
    this.url = opts.url;
    this.pending = opts.pendingKey ? new PendingQueue(opts.pendingKey) : null;
  }

  start(): void {
    this.stopped = false;
    const online = () => this.reconnectNow();
    const visible = () => document.visibilityState === 'visible' && this.status === 'live' && void this.syncBurst(2);
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', visible);
    this.listeners.push(() => window.removeEventListener('online', online), () => document.removeEventListener('visibilitychange', visible));
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.listeners.splice(0).forEach((f) => f());
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close(1000, 'bye');
    this.setStatus('closed');
  }

  private setStatus(s: SocketStatus, detail?: string): void {
    this.status = s;
    this.opts.onStatus?.(s, detail);
  }

  private open(): void {
    if (this.stopped) return;
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => void this.afterOpen(ws);
    ws.onmessage = (ev) => this.onMessage(ev.data as string);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const [, w] of this.waiters) w.reject(new Error('connection closed'));
      this.waiters.clear();
      if (this.syncTimer) clearInterval(this.syncTimer);
      if (this.stopped || this.status === 'fatal') return;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.setStatus('reconnecting');
    const delay = Math.min(10_000, 500 * 2 ** this.attempt) + Math.random() * 400;
    this.attempt++;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private reconnectNow(): void {
    if (this.stopped || this.status === 'live' || this.status === 'fatal') return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (!this.ws) this.open();
  }

  private async afterOpen(ws: WebSocket): Promise<void> {
    this.setStatus('joining');
    try {
      const reply = await this.request('JOIN_SESSION', this.opts.join(this.epochId) as never, 15_000);
      if (reply.type === 'ERROR') {
        const p = reply.payload as { code: string; message: string; details?: { ownerUrl?: string } };
        if (p.code === 'SESSION_OWNED_ELSEWHERE' && p.details?.ownerUrl) {
          // another battle node owns this session: follow the redirect
          this.url = p.details.ownerUrl.replace(/^http/, 'ws').replace(/\/?$/, '/ws');
          ws.close();
          return;
        }
        if (FATAL_JOIN_CODES.has(p.code)) {
          this.setStatus('fatal', p.code);
          ws.close();
          return;
        }
        throw new Error(p.message);
      }
      this.attempt = 0;
      this.opts.onEvent(reply);
      this.setStatus('live');
      await this.syncBurst(4);
      this.flushPending();
      if (this.syncTimer) clearInterval(this.syncTimer);
      this.syncTimer = setInterval(() => void this.syncBurst(1), this.opts.syncIntervalMs ?? 30_000);
    } catch {
      ws.close();
    }
  }

  private onMessage(raw: string): void {
    let env: AnyEnvelope;
    try {
      env = JSON.parse(raw) as AnyEnvelope;
    } catch {
      return;
    }
    if (env.type === 'TIME_SYNC_RESPONSE') {
      const t3 = performance.now();
      this.clock.addResponse(env.payload as ServerEnvelope<'TIME_SYNC_RESPONSE'>['payload'], t3);
    }
    if (env.type === 'ANSWER_ACCEPTED' || env.type === 'ANSWER_UPDATED' || env.type === 'ANSWER_REJECTED') {
      // the server has decided (accepted or definitively rejected): drop it from the pending queue
      this.pending?.resolve((env.payload as { idempotencyKey: string }).idempotencyKey);
    }
    if (env.type === 'KICKED') this.setStatus('fatal', 'KICKED');
    if (env.reqId && this.waiters.has(env.reqId)) {
      const w = this.waiters.get(env.reqId)!;
      this.waiters.delete(env.reqId);
      clearTimeout(w.timer);
      w.resolve(env);
      return; // direct replies go to the awaiting caller only
    }
    this.opts.onEvent(env);
  }

  send<T extends ClientMessageType>(type: T, payload: ClientPayload<T>, reqId?: string): string | null {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return null;
    const id = reqId ?? `c${++this.reqSeq}`;
    this.ws.send(JSON.stringify({ type, reqId: id, payload }));
    return id;
  }

  request<T extends ClientMessageType>(type: T, payload: ClientPayload<T>, timeoutMs = 10_000): Promise<AnyEnvelope> {
    return new Promise((resolve, reject) => {
      const id = this.send(type, payload);
      if (!id) return reject(new Error('not connected'));
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`timeout: ${type}`));
      }, timeoutMs);
      this.waiters.set(id, { resolve, reject, timer });
    });
  }

  /** Teacher commands: resolves on ACK, rejects with the server error. */
  async command<T extends ClientMessageType>(type: T, payload: ClientPayload<T>): Promise<void> {
    const r = await this.request(type, payload);
    if (r.type === 'ERROR') {
      const p = r.payload as { code: string; message: string };
      throw Object.assign(new Error(p.message), { code: p.code });
    }
  }

  /** TIME_SYNC round trips; each request reports the previous sample so the server can verify it. */
  async syncBurst(rounds: number): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      for (let i = 0; i < rounds; i++) {
        const seq = ++this.syncSeq;
        const report = this.clock.lastReport;
        await this.request(
          'TIME_SYNC_REQUEST',
          { seq, clockEpochId: this.epochId, clientMono: performance.now(), ...(report ? { lastSample: report } : {}) },
          5000,
        ).catch(() => undefined);
      }
    } finally {
      this.syncing = false;
    }
  }

  /** Estimated authoritative server time. */
  serverNow(): number {
    return this.clock.serverNow(performance.now());
  }

  /**
   * Submit an answer. The press instant is captured immediately (monotonic), the item is queued
   * persistently, then sent. Returns the idempotency key.
   */
  submit(sessionQuestionId: string, answer: AnswerPayload, baseRevision?: number): string {
    const mono = performance.now();
    const payload: SubmitAnswerPayload = {
      sessionQuestionId,
      answer,
      idempotencyKey: newKey(),
      clientMonoAt: mono,
      clientSentAt: this.clock.serverNow(mono),
      clockEpochId: this.epochId,
      ...(baseRevision !== undefined ? { baseRevision } : {}),
    };
    const type = baseRevision !== undefined ? 'UPDATE_ANSWER' : 'SUBMIT_ANSWER';
    this.pending?.add({ type, payload, queuedAt: Date.now(), attempts: 0 });
    if (this.status === 'live') this.send(type, payload as never);
    return payload.idempotencyKey;
  }

  private flushPending(): void {
    if (!this.pending) return;
    for (const item of this.pending.list()) {
      this.pending.markAttempt(item.payload.idempotencyKey);
      this.send(item.type, { ...item.payload, replay: true } as never);
    }
  }
}
