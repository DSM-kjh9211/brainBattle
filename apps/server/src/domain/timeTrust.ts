import { impliedOffset, type TimestampSource } from '@brainbattle/shared';

/**
 * Timestamp Trust Algorithm
 * =========================
 *
 * Every submission carries three instants:
 *   questionStartedAt  – server clock, authoritative
 *   clientSentAt       – when the student pressed submit, as estimated by the client
 *   serverReceivedAt   – server clock when the message arrived
 *
 * The client never reports Date.now(). It reports its monotonic reading (clientMonoAt, from
 * performance.now()) plus a per-page "clock epoch" id. The SERVER converts it to server time
 * with the offset IT verified during TIME_SYNC:
 *
 *   estimatedServerTime = clientMonoAt + verifiedOffset(epoch)
 *
 * and applies the 1-second rule:
 *
 *   |serverReceivedAt − estimatedServerTime| < 1000ms  ⇒ effective = estimated   (CLIENT_TRUSTED)
 *   otherwise                                          ⇒ effective = received    (SERVER_FALLBACK)
 *
 * subject to sanity checks (any failure ⇒ SERVER_FALLBACK with a reason code):
 *   - a verified, fresh and stable TIME_SYNC exists for that clock epoch
 *   - RTT of that sync was small enough for the estimate to be meaningful
 *   - the client's own estimate agrees with the server's reconstruction
 *   - not before the question/session window started
 *   - not in the future relative to receipt
 *   - not regressing behind the participant's previous claimed timestamp
 *   - offset did not jump (tampering / device sleep) without re-confirmation
 *
 * Offline replay (pending queue flushed after reconnect) legitimately exceeds 1s. Such a replay
 * keeps the client time only if the claimed instant precedes the server-observed disconnect,
 * the replay arrives within the configured offline window, and it is flushed promptly after the
 * reconnect. See docs/DESIGN.md §7 for the rationale of this extension.
 */

export interface TrustPolicy {
  trustWindowMs: number;
  maxSyncAgeMs: number;
  maxRttMs: number;
  futureToleranceMs: number;
  regressionToleranceMs: number;
  estimateMismatchToleranceMs: number;
  offlineReplayWindowMs: number;
  replayFlushWindowMs: number;
}

export const DEFAULT_TRUST_POLICY: TrustPolicy = {
  trustWindowMs: 1000,
  maxSyncAgeMs: 120_000,
  maxRttMs: 1000,
  futureToleranceMs: 50,
  regressionToleranceMs: 250,
  estimateMismatchToleranceMs: 500,
  offlineReplayWindowMs: 120_000,
  replayFlushWindowMs: 30_000,
};

/** Verified clock relationship between one client page (epoch) and the server. */
export interface ClockSyncState {
  epochId: string;
  /** serverTime ≈ clientMono + offset */
  offset: number;
  rtt: number;
  /** server time of the last accepted sample */
  syncedAt: number;
  sampleCount: number;
  stable: boolean;
  lastJumpAt: number | null;
  /** outstanding request awaiting the client's report */
  pending: { seq: number; t0: number; t1: number; t2: number } | null;
}

export interface SyncConfig {
  maxRttMs: number;
  offsetJumpMs: number;
  offsetConfirmMs: number;
  refreshAfterMs: number;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  maxRttMs: 1000,
  offsetJumpMs: 250,
  offsetConfirmMs: 60,
  refreshAfterMs: 60_000,
};

export type SyncOutcome = 'ACCEPTED' | 'NO_SAMPLE' | 'RTT_TOO_HIGH' | 'INCONSISTENT' | 'OFFSET_JUMP' | 'CONFIRMED';

/**
 * Processes a TIME_SYNC_REQUEST. The request's `lastSample` is the client's measurement of the
 * previous exchange; the server re-derives the offset from its own t1 and the reported RTT
 * (offset = t1 − t0 − rtt/2) and rejects reports that are inconsistent with what it observed.
 */
export function applyTimeSync(
  prev: ClockSyncState | undefined,
  req: { seq: number; clockEpochId: string; clientMono: number; lastSample?: { seq: number; offset: number; rtt: number } },
  now: number,
  cfg: SyncConfig = DEFAULT_SYNC_CONFIG,
): { state: ClockSyncState; outcome: SyncOutcome } {
  const base: ClockSyncState = prev ?? {
    epochId: req.clockEpochId,
    offset: 0,
    rtt: Number.POSITIVE_INFINITY,
    syncedAt: 0,
    sampleCount: 0,
    stable: false,
    lastJumpAt: null,
    pending: null,
  };
  let state: ClockSyncState = { ...base };
  let outcome: SyncOutcome = 'NO_SAMPLE';

  const p = base.pending;
  const r = req.lastSample;
  if (p && r && r.seq === p.seq) {
    const serverHold = p.t2 - p.t1;
    // the response cannot have arrived after the next request was sent
    const maxPossibleRtt = req.clientMono - p.t0 - serverHold + 1;
    const offset = impliedOffset(p.t0, p.t1, r.rtt);
    if (r.rtt < 0 || r.rtt > maxPossibleRtt || Math.abs(offset - r.offset) > 2) {
      outcome = 'INCONSISTENT';
    } else if (r.rtt > cfg.maxRttMs) {
      outcome = 'RTT_TOO_HIGH';
    } else if (state.sampleCount === 0) {
      state = { ...state, offset, rtt: r.rtt, syncedAt: now, sampleCount: 1, stable: true };
      outcome = 'ACCEPTED';
    } else {
      const delta = Math.abs(offset - state.offset);
      const errorBound = (r.rtt + state.rtt) / 2;
      if (!state.stable) {
        // after a jump, a second agreeing sample re-establishes trust
        if (delta <= cfg.offsetConfirmMs + errorBound) {
          state = { ...state, offset, rtt: r.rtt, syncedAt: now, sampleCount: state.sampleCount + 1, stable: true };
          outcome = 'CONFIRMED';
        } else {
          state = { ...state, offset, rtt: r.rtt, syncedAt: now, sampleCount: state.sampleCount + 1, lastJumpAt: now };
          outcome = 'OFFSET_JUMP';
        }
      } else if (delta > cfg.offsetJumpMs + errorBound) {
        state = { ...state, offset, rtt: r.rtt, syncedAt: now, sampleCount: state.sampleCount + 1, stable: false, lastJumpAt: now };
        outcome = 'OFFSET_JUMP';
      } else {
        // keep the tighter estimate unless it is getting old (drift)
        const better = r.rtt <= state.rtt || now - state.syncedAt > cfg.refreshAfterMs;
        state = better
          ? { ...state, offset, rtt: r.rtt, syncedAt: now, sampleCount: state.sampleCount + 1 }
          : { ...state, syncedAt: now, sampleCount: state.sampleCount + 1 };
        outcome = 'ACCEPTED';
      }
    }
  }
  state.pending = { seq: req.seq, t0: req.clientMono, t1: now, t2: now };
  return { state, outcome };
}

export interface TimestampInput {
  serverReceivedAt: number;
  clientSentAt: number;
  clientMonoAt: number;
  sync: ClockSyncState | undefined;
  /** questionStartedAt (SYNCHRONIZED) or session startedAt (FREE) */
  windowStartAt: number | null;
  /** participant's previous client-claimed timestamp (any question) */
  lastClientTimestamp: number | null;
  replay: boolean;
  disconnectedAt: number | null;
  reconnectedAt: number | null;
}

export type TimestampReason =
  | 'WITHIN_TRUST_WINDOW'
  | 'OFFLINE_REPLAY_VERIFIED'
  | 'NO_TIME_SYNC'
  | 'OFFSET_UNSTABLE'
  | 'RTT_TOO_HIGH'
  | 'SYNC_STALE'
  | 'CLIENT_ESTIMATE_MISMATCH'
  | 'CLIENT_TIME_IN_FUTURE'
  | 'BEFORE_WINDOW_START'
  | 'TIMESTAMP_REGRESSION'
  | 'OUTSIDE_TRUST_WINDOW'
  | 'REPLAY_AFTER_DISCONNECT'
  | 'REPLAY_WINDOW_EXCEEDED'
  | 'REPLAY_NOT_PROMPT';

export interface TimestampDecision {
  effectiveSubmittedAt: number;
  source: TimestampSource;
  reason: TimestampReason;
  estimatedServerTime: number | null;
  /** serverReceivedAt − estimatedServerTime */
  diffMs: number | null;
}

export function evaluateTimestamp(i: TimestampInput, policy: TrustPolicy = DEFAULT_TRUST_POLICY): TimestampDecision {
  const fallback = (reason: TimestampReason, est: number | null = null): TimestampDecision => ({
    effectiveSubmittedAt: i.serverReceivedAt,
    source: 'SERVER_FALLBACK',
    reason,
    estimatedServerTime: est,
    diffMs: est === null ? null : i.serverReceivedAt - est,
  });
  const trusted = (reason: TimestampReason, est: number): TimestampDecision => ({
    effectiveSubmittedAt: Math.round(est),
    source: 'CLIENT_TRUSTED',
    reason,
    estimatedServerTime: est,
    diffMs: i.serverReceivedAt - est,
  });

  const s = i.sync;
  if (!s || s.sampleCount === 0) return fallback('NO_TIME_SYNC');
  if (!s.stable) return fallback('OFFSET_UNSTABLE');
  if (s.rtt > policy.maxRttMs) return fallback('RTT_TOO_HIGH');

  const est = i.clientMonoAt + s.offset;
  if (Math.abs(i.clientSentAt - est) > policy.estimateMismatchToleranceMs) return fallback('CLIENT_ESTIMATE_MISMATCH', est);
  if (Math.abs(est - s.syncedAt) > policy.maxSyncAgeMs) return fallback('SYNC_STALE', est);

  const futureTolerance = Math.max(policy.futureToleranceMs, s.rtt / 2);
  if (est > i.serverReceivedAt + futureTolerance) return fallback('CLIENT_TIME_IN_FUTURE', est);
  if (i.windowStartAt !== null && est < i.windowStartAt) return fallback('BEFORE_WINDOW_START', est);
  if (i.lastClientTimestamp !== null && est < i.lastClientTimestamp - policy.regressionToleranceMs) {
    return fallback('TIMESTAMP_REGRESSION', est);
  }

  // effective time is never later than receipt (clamp tiny positive estimation error)
  const clamped = Math.min(est, i.serverReceivedAt);
  const diff = i.serverReceivedAt - clamped;
  if (diff < policy.trustWindowMs) return trusted('WITHIN_TRUST_WINDOW', clamped);
  if (!i.replay) return fallback('OUTSIDE_TRUST_WINDOW', est);

  // ---- offline replay path
  if (i.disconnectedAt === null || clamped > i.disconnectedAt + policy.trustWindowMs) {
    return fallback('REPLAY_AFTER_DISCONNECT', est);
  }
  if (diff > policy.offlineReplayWindowMs) return fallback('REPLAY_WINDOW_EXCEEDED', est);
  if (i.reconnectedAt === null || i.serverReceivedAt - i.reconnectedAt > policy.replayFlushWindowMs) {
    return fallback('REPLAY_NOT_PROMPT', est);
  }
  return trusted('OFFLINE_REPLAY_VERIFIED', clamped);
}
