import { AppError, resolveSessionSettings, type SessionSettingsPatch } from '@brainbattle/shared';
import type { Db } from '../db/db.js';
import type { Clock, TimerHandle } from '../lib/clock.js';
import type { ClassroomRepository } from '../repositories/users.js';
import { SessionRuntime, type RuntimeConfig, type RuntimeDeps } from './sessionRuntime.js';
import type { SessionStore } from './sessionStore.js';

export interface ManagerDeps {
  db: Db;
  store: SessionStore;
  clock: Clock;
  classrooms: ClassroomRepository;
  config: RuntimeConfig;
  log: RuntimeDeps['log'];
  nodeId: string;
  nodeUrl: string | null;
  leaseTtlMs: number;
  idleUnloadMs: number;
}

/**
 * Session ownership
 * =================
 * A live session is owned by exactly one battle-server node, recorded as a lease row
 * (session_leases). The owner keeps all of the session's sockets, timers and in-memory state;
 * every other node refuses JOIN_SESSION for it with SESSION_OWNED_ELSEWHERE + the owner's URL
 * (a load balancer hashing on ?session= makes this rare). Leases are renewed every ttl/3.
 *
 * Failover: if a node dies its leases expire; the recovery loop on any other node (or the next
 * client reconnect) acquires the lease and re-hydrates the session from PostgreSQL. All
 * authoritative state (state machine, deadlines as absolute instants, submissions, scores,
 * participant clock sync) is persisted, so timers are rebuilt and nothing is lost.
 */
export class SessionManager {
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly loading = new Map<string, Promise<SessionRuntime>>();
  private readonly idleSince = new Map<string, number>();
  private maintenance: TimerHandle | null = null;
  private stopped = false;

  constructor(private readonly deps: ManagerDeps) {}

  get loaded(): SessionRuntime[] {
    return [...this.runtimes.values()];
  }

  peek(sessionId: string): SessionRuntime | undefined {
    return this.runtimes.get(sessionId);
  }

  async get(sessionId: string): Promise<SessionRuntime> {
    const existing = this.runtimes.get(sessionId);
    if (existing && !existing.disposed) return existing;
    let p = this.loading.get(sessionId);
    if (!p) {
      p = this.load(sessionId).finally(() => this.loading.delete(sessionId));
      this.loading.set(sessionId, p);
    }
    return p;
  }

  private async load(sessionId: string): Promise<SessionRuntime> {
    await this.acquireLease(sessionId);
    try {
      const agg = await this.deps.store.loadAggregate(sessionId);
      const rt = new SessionRuntime({
        store: this.deps.store,
        clock: this.deps.clock,
        classrooms: this.deps.classrooms,
        config: this.deps.config,
        log: this.deps.log,
      });
      rt.hydrate(agg);
      this.runtimes.set(sessionId, rt);
      this.deps.log.info({ sessionId, state: agg.session.state }, 'session runtime loaded');
      return rt;
    } catch (e) {
      await this.releaseLease(sessionId).catch(() => undefined);
      throw e;
    }
  }

  async findByJoinCode(code: string): Promise<string | null> {
    const row = await this.deps.store.findLiveByJoinCode(code);
    return row?.id ?? null;
  }

  /* -------------------------------------------------------------- leases */

  private async acquireLease(sessionId: string): Promise<void> {
    const now = this.deps.clock.now();
    const { rows } = await this.deps.db.query<{ node_id: string }>(
      `INSERT INTO session_leases (session_id, node_id, node_url, expires_at_ms) VALUES ($1,$2,$3,$4)
       ON CONFLICT (session_id) DO UPDATE SET node_id = EXCLUDED.node_id, node_url = EXCLUDED.node_url,
              expires_at_ms = EXCLUDED.expires_at_ms
        WHERE session_leases.node_id = EXCLUDED.node_id OR session_leases.expires_at_ms < $5
       RETURNING node_id`,
      [sessionId, this.deps.nodeId, this.deps.nodeUrl, now + this.deps.leaseTtlMs, now],
    );
    if (rows.length === 0) {
      const owner = await this.deps.db.query<{ node_id: string; node_url: string | null }>(
        'SELECT node_id, node_url FROM session_leases WHERE session_id = $1',
        [sessionId],
      );
      throw new AppError('SESSION_OWNED_ELSEWHERE', 'session is hosted by another battle server', {
        ownerNodeId: owner.rows[0]?.node_id,
        ownerUrl: owner.rows[0]?.node_url,
      });
    }
  }

  private async releaseLease(sessionId: string): Promise<void> {
    await this.deps.db.query('DELETE FROM session_leases WHERE session_id = $1 AND node_id = $2', [
      sessionId,
      this.deps.nodeId,
    ]);
  }

  private async renewLeases(): Promise<void> {
    const ids = [...this.runtimes.keys()];
    if (ids.length === 0) return;
    const now = this.deps.clock.now();
    const { rows } = await this.deps.db.query<{ session_id: string }>(
      `UPDATE session_leases SET expires_at_ms = $1 WHERE node_id = $2 AND session_id = ANY($3::text[]) RETURNING session_id`,
      [now + this.deps.leaseTtlMs, this.deps.nodeId, ids],
    );
    const kept = new Set(rows.map((r) => r.session_id));
    for (const id of ids) {
      if (!kept.has(id)) {
        // lease lost (e.g. long GC pause / network partition): another node may own it now
        this.deps.log.warn({ sessionId: id }, 'session lease lost, unloading runtime');
        this.unload(id, 'SESSION_MOVED');
      }
    }
  }

  /** Picks up live sessions whose owner vanished (lease expired) so their deadlines still fire. */
  async recoverOrphans(): Promise<string[]> {
    const now = this.deps.clock.now();
    const { rows } = await this.deps.db.query<{ id: string }>(
      `SELECT s.id FROM sessions s LEFT JOIN session_leases l ON l.session_id = s.id
        WHERE s.state IN ('ACTIVE','PAUSED') AND (l.session_id IS NULL OR l.expires_at_ms < $1)
        LIMIT 100`,
      [now],
    );
    const recovered: string[] = [];
    for (const r of rows) {
      if (this.runtimes.has(r.id)) continue;
      try {
        await this.get(r.id);
        recovered.push(r.id);
      } catch (e) {
        if (!(e instanceof AppError && e.code === 'SESSION_OWNED_ELSEWHERE')) {
          this.deps.log.error({ sessionId: r.id, err: String(e) }, 'orphan recovery failed');
        }
      }
    }
    return recovered;
  }

  private unload(sessionId: string, reason: string): void {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return;
    this.runtimes.delete(sessionId);
    this.idleSince.delete(sessionId);
    rt.dispose(reason);
  }

  /** Finished sessions without connections are unloaded after idleUnloadMs. */
  private async evictIdle(): Promise<void> {
    const now = this.deps.clock.now();
    for (const [id, rt] of this.runtimes) {
      const idle = rt.connectionCount === 0 && (rt.session.state === 'FINISHED' || rt.session.state === 'CREATED');
      if (!idle) {
        this.idleSince.delete(id);
        continue;
      }
      const since = this.idleSince.get(id) ?? now;
      this.idleSince.set(id, since);
      if (now - since >= this.deps.idleUnloadMs) {
        await rt.flush().catch(() => undefined);
        this.unload(id, 'IDLE');
        await this.releaseLease(id).catch(() => undefined);
      }
    }
  }

  startMaintenance(intervalMs = Math.max(1000, Math.floor(this.deps.leaseTtlMs / 3))): void {
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.renewLeases();
        await this.evictIdle();
        await this.recoverOrphans();
      } catch (e) {
        this.deps.log.error({ err: String(e) }, 'session maintenance failed');
      }
      if (!this.stopped) this.maintenance = this.deps.clock.setTimer(() => void tick(), intervalMs);
    };
    this.maintenance = this.deps.clock.setTimer(() => void tick(), intervalMs);
  }

  /** Settings may change before the session starts (scoreboard settings: any time via WS). */
  async updateSettings(sessionId: string, patch: SessionSettingsPatch): Promise<void> {
    const rt = await this.get(sessionId);
    await rt.run(async () => {
      if (!['CREATED', 'LOBBY', 'READY'].includes(rt.session.state)) {
        throw new AppError('INVALID_TRANSITION', 'settings can only be changed before the session starts');
      }
      const next = structuredClone(rt.session);
      next.settings = resolveSessionSettings(next.preset, patch, next.settings);
      await this.deps.db.tx((q) => this.deps.store.saveSession(q, next));
      rt.session = next;
      rt.leaderboard.setRanking(next.settings.ranking);
      for (const t of rt.teachers) t.send('SESSION_STATE', rt.teacherState());
    });
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.maintenance?.cancel();
    for (const [id, rt] of this.runtimes) {
      await rt.flush().catch(() => undefined);
      rt.dispose('SERVER_SHUTDOWN');
      await this.releaseLease(id).catch(() => undefined);
    }
    this.runtimes.clear();
  }
}
