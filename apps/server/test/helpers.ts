import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import type {
  ClientMessageType,
  ClientPayload,
  QuestionInput,
  ServerEnvelope,
  ServerEventMap,
  ServerEventType,
  SessionSettingsPatch,
  StudentSessionState,
  TeacherSessionState,
} from '@brainbattle/shared';
import { buildServer, type BuiltServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, type Db } from '../src/db/db.js';
import { ManualClock } from '../src/lib/clock.js';

export const JWT_SECRET = 'test-secret-test-secret-test-secret-123';

export interface TestServer {
  server: BuiltServer;
  clock: ManualClock;
  baseUrl: string;
  wsUrl: string;
  db: Db;
  close(): Promise<void>;
}

export async function startServer(opts: { clock?: ManualClock; db?: Db; nodeId?: string } = {}): Promise<TestServer> {
  const clock = opts.clock ?? new ManualClock(Date.UTC(2026, 8, 18, 9, 0, 0));
  const db = opts.db ?? (await createDb('pglite://memory'));
  const config = {
    ...loadConfig({ NODE_ENV: 'test', JWT_SECRET, DATABASE_URL: 'pglite://memory' }),
    nodeId: opts.nodeId ?? 'test-node-1',
    heartbeatMs: 60_000,
    authRateLimitPerMin: 10_000,
    apiRateLimitPerMin: 100_000,
  };
  const server = await buildServer(config, { clock, db });
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (server.app.server.address() as AddressInfo).port;
  return {
    server,
    clock,
    db,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    close: () => server.close(),
  };
}

export async function api<T = any>(t: TestServer, method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: T }> {
  const res = await fetch(t.baseUrl + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : (undefined as T) };
}

let userCounter = 0;
export async function registerTeacher(t: TestServer, name = '교사') {
  const email = `t${++userCounter}_${Date.now()}@test.local`;
  const r = await api(t, 'POST', '/api/auth/register', { email, password: 'password123', displayName: name, role: 'TEACHER' });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return r.body as { token: string; user: { id: string } };
}

export async function registerStudent(t: TestServer, name = '학생') {
  const email = `s${++userCounter}_${Date.now()}@test.local`;
  const r = await api(t, 'POST', '/api/auth/register', { email, password: 'password123', displayName: name, role: 'STUDENT' });
  return r.body as { token: string; user: { id: string; email: string } };
}

export const Q = {
  mc: (over: Partial<QuestionInput> = {}): QuestionInput => ({
    type: 'MULTIPLE_CHOICE',
    title: '2+2?',
    choices: [
      { id: 'a', content: [{ type: 'text', text: '3' }] },
      { id: 'b', content: [{ type: 'text', text: '4' }] },
    ],
    correctAnswer: 'b',
    score: 10,
    ...over,
  }),
  numeric: (over: Partial<QuestionInput> = {}): QuestionInput => ({ type: 'NUMERIC', title: 'pi', correctAnswer: 3.14, grading: { method: 'NUMERIC', tolerance: 0.01 }, score: 10, ...over }),
  essay: (over: Partial<QuestionInput> = {}): QuestionInput => ({ type: 'ESSAY', title: 'prove', score: 10, ...over }),
  latex: (over: Partial<QuestionInput> = {}): QuestionInput => ({
    type: 'LATEX',
    title: 'half',
    correctAnswer: '\\frac{1}{2}',
    grading: { method: 'LATEX', latexNumericEquivalence: true },
    score: 10,
    ...over,
  }),
};

export async function createSession(
  t: TestServer,
  teacherToken: string,
  questions: QuestionInput[],
  opts: { preset?: string; settings?: SessionSettingsPatch } = {},
) {
  const set = await api(t, 'POST', '/api/question-sets', { title: 'set', deliveryMode: 'DIGITAL', progressMode: 'SYNCHRONIZED', scoringMode: 'POINT_BASED' }, teacherToken);
  for (const q of questions) {
    const r = await api(t, 'POST', `/api/question-sets/${set.body.id}/questions`, q, teacherToken);
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  }
  const s = await api(t, 'POST', '/api/sessions', { questionSetId: set.body.id, preset: opts.preset ?? 'CUSTOM', settings: opts.settings }, teacherToken);
  if (s.status !== 200) throw new Error(JSON.stringify(s.body));
  return s.body as { id: string; joinCode: string; settings: any };
}

type AnyEnv = ServerEnvelope<ServerEventType>;

/** Minimal protocol client used by the integration tests. */
export class TestClient {
  ws!: WebSocket;
  readonly messages: AnyEnv[] = [];
  private waiters: { match: (m: AnyEnv) => boolean; resolve: (m: AnyEnv) => void }[] = [];
  private reqSeq = 0;
  closed = false;
  /** simulated monotonic clock: mono = serverNow - monoOffset */
  monoOffset = 1_000_000_000_000 - 12_345.678;
  epoch = `ep_${Math.random().toString(36).slice(2, 10)}`;
  syncSeq = 0;
  lastSample: { seq: number; offset: number; rtt: number } | undefined;

  constructor(private readonly url: string, private readonly clock: ManualClock) {}

  static async connect(t: TestServer): Promise<TestClient> {
    const c = new TestClient(t.wsUrl, t.clock);
    await c.open();
    return c;
  }

  open(): Promise<void> {
    this.closed = false;
    this.ws = new WebSocket(this.url);
    this.ws.on('message', (data) => {
      const m = JSON.parse(data.toString()) as AnyEnv;
      this.messages.push(m);
      const idx = this.waiters.findIndex((w) => w.match(m));
      if (idx >= 0) {
        const [w] = this.waiters.splice(idx, 1);
        w!.resolve(m);
      }
    });
    this.ws.on('close', () => (this.closed = true));
    return new Promise((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
  }

  mono(): number {
    return this.clock.now() - this.monoOffset;
  }

  send<T extends ClientMessageType>(type: T, payload: ClientPayload<T> | Record<string, unknown>): string {
    const reqId = `r${++this.reqSeq}`;
    this.ws.send(JSON.stringify({ type, reqId, payload }));
    return reqId;
  }

  sendRaw(s: string): void {
    this.ws.send(s);
  }

  waitFor<T extends ServerEventType>(type: T, pred: (p: ServerEventMap[T], m: AnyEnv) => boolean = () => true, timeoutMs = 5000): Promise<ServerEnvelope<T>> {
    const match = (m: AnyEnv) => m.type === type && pred(m.payload as ServerEventMap[T], m);
    const found = this.messages.find(match);
    if (found) {
      this.messages.splice(this.messages.indexOf(found), 1);
      return Promise.resolve(found as ServerEnvelope<T>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== res);
        reject(new Error(`timeout waiting for ${type}; got: ${this.messages.map((m) => m.type).join(',')}`));
      }, timeoutMs);
      const res = (m: AnyEnv) => {
        clearTimeout(timer);
        const i = this.messages.indexOf(m);
        if (i >= 0) this.messages.splice(i, 1);
        resolve(m as ServerEnvelope<T>);
      };
      this.waiters.push({ match, resolve: res });
    });
  }

  /** Sends and waits for the direct reply (same reqId). */
  async request<T extends ClientMessageType>(type: T, payload: ClientPayload<T> | Record<string, unknown>): Promise<AnyEnv> {
    const reqId = this.send(type, payload);
    return new Promise((resolve, reject) => {
      const match = (m: AnyEnv) => m.reqId === reqId;
      const found = this.messages.find(match);
      if (found) return resolve(found);
      const timer = setTimeout(() => reject(new Error(`no reply to ${type}`)), 5000);
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  /** Performs n TIME_SYNC round trips (rtt 0 in-process). */
  async sync(rounds = 3): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      const seq = ++this.syncSeq;
      const t0 = this.mono();
      this.send('TIME_SYNC_REQUEST', { seq, clockEpochId: this.epoch, clientMono: t0, ...(this.lastSample ? { lastSample: this.lastSample } : {}) });
      const r = await this.waitFor('TIME_SYNC_RESPONSE', (p) => p.seq === seq);
      const t3 = this.mono();
      const p = r.payload;
      const rtt = Math.max(0, t3 - p.clientMono - (p.serverSentAt - p.serverReceivedAt));
      const offset = (p.serverReceivedAt - p.clientMono + (p.serverSentAt - t3)) / 2;
      this.lastSample = { seq, offset, rtt };
    }
  }

  async joinStudent(joinCode: string, nickname: string, extra: Record<string, unknown> = {}): Promise<StudentSessionState> {
    const r = await this.request('JOIN_SESSION', { role: 'STUDENT', joinCode, nickname, clockEpochId: this.epoch, ...extra });
    if (r.type !== 'SESSION_STATE') throw new Error(`join failed: ${JSON.stringify(r.payload)}`);
    return r.payload as StudentSessionState;
  }

  async joinTeacher(sessionId: string, authToken: string): Promise<TeacherSessionState> {
    const r = await this.request('JOIN_SESSION', { role: 'TEACHER', sessionId, authToken });
    if (r.type !== 'SESSION_STATE') throw new Error(`teacher join failed: ${JSON.stringify(r.payload)}`);
    return r.payload as TeacherSessionState;
  }

  /** Builds a submit payload claiming the student pressed submit `msAgo` ms before now (server time). */
  submitPayload(sessionQuestionId: string, answer: unknown, msAgo = 0, extra: Record<string, unknown> = {}) {
    const clientMonoAt = this.mono() - msAgo;
    return {
      sessionQuestionId,
      answer,
      idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      clientMonoAt,
      clientSentAt: clientMonoAt + (this.lastSample?.offset ?? 0),
      clockEpochId: this.epoch,
      ...extra,
    };
  }

  async cmd<T extends ClientMessageType>(type: T, payload: ClientPayload<T> | Record<string, unknown> = {}): Promise<AnyEnv> {
    const r = await this.request(type, payload);
    return r;
  }

  close(): Promise<void> {
    return new Promise((res) => {
      if (this.ws.readyState === WebSocket.CLOSED) return res();
      this.ws.once('close', () => res());
      this.ws.close();
    });
  }

  clear(): void {
    this.messages.length = 0;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until a condition holds (for async server-side bookkeeping). */
export async function eventually(fn: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(20);
  }
  throw new Error('condition not met in time');
}
