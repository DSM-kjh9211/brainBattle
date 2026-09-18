/**
 * TIME_SYNC client-side estimator (NTP-style, Cristian's algorithm with min-RTT filtering).
 *
 *   t0 = client monotonic at send          (performance.now())
 *   t1 = server wall clock at receive
 *   t2 = server wall clock at send
 *   t3 = client monotonic at receive
 *
 *   rtt    = (t3 - t0) - (t2 - t1)
 *   offset = ((t1 - t0) + (t2 - t3)) / 2          ⇒  serverTime ≈ monotonic + offset
 *
 * The client never uses Date.now(): a monotonic clock cannot be moved by changing the OS time,
 * so "clock manipulation" on the student device has no effect on the estimate.
 *
 * The same formula lets the server verify the client's reported sample: given its own t1 and
 * the client's t0, the only consistent offset for a reported rtt is  t1 - t0 - rtt/2.
 */
export interface TimeSyncSample {
  seq: number;
  offset: number;
  rtt: number;
  /** monotonic time the sample was taken */
  at: number;
}

export interface TimeSyncResponse {
  seq: number;
  clientMono: number;
  serverReceivedAt: number;
  serverSentAt: number;
}

export function computeSample(resp: TimeSyncResponse, t3: number): TimeSyncSample {
  const t0 = resp.clientMono;
  const t1 = resp.serverReceivedAt;
  const t2 = resp.serverSentAt;
  const rtt = Math.max(0, t3 - t0 - (t2 - t1));
  const offset = (t1 - t0 + (t2 - t3)) / 2;
  return { seq: resp.seq, offset, rtt, at: t3 };
}

/** Server-side reconstruction of the offset implied by a reported RTT. */
export function impliedOffset(t0: number, t1: number, rtt: number): number {
  return t1 - t0 - rtt / 2;
}

export class ClockSyncEstimator {
  private samples: TimeSyncSample[] = [];
  private lastSample: TimeSyncSample | null = null;

  constructor(
    private readonly windowSize = 8,
    /** samples older than this (ms, monotonic) are discarded */
    private readonly maxAgeMs = 5 * 60_000,
  ) {}

  addResponse(resp: TimeSyncResponse, t3: number): TimeSyncSample {
    const s = computeSample(resp, t3);
    this.lastSample = s;
    this.samples.push(s);
    this.samples = this.samples.filter((x) => t3 - x.at <= this.maxAgeMs).slice(-this.windowSize);
    return s;
  }

  /** Best (lowest RTT) sample: its offset has the smallest error bound (±rtt/2). */
  best(): TimeSyncSample | null {
    if (this.samples.length === 0) return null;
    return this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  }

  get synced(): boolean {
    return this.samples.length > 0;
  }

  get offset(): number {
    return this.best()?.offset ?? 0;
  }

  get lastReport(): { seq: number; offset: number; rtt: number } | undefined {
    const s = this.lastSample;
    return s ? { seq: s.seq, offset: s.offset, rtt: s.rtt } : undefined;
  }

  serverNow(mono: number): number {
    return mono + this.offset;
  }

  reset(): void {
    this.samples = [];
    this.lastSample = null;
  }
}
