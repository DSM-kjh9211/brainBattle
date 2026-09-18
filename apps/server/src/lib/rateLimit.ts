import type { Clock } from './clock.js';

/** Classic token bucket; used per connection and per event type. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly clock: Clock,
  ) {
    this.tokens = capacity;
    this.last = clock.now();
  }

  take(n = 1): boolean {
    const now = this.clock.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

/**
 * Join-code brute-force guard.
 * Counts FAILED join attempts per key (client IP). After `maxFailures` failures inside `windowMs`
 * the key is blocked for `blockMs`. With 6-digit codes (9·10⁵ space) and ~10 guesses per 5 min
 * an attacker needs years to hit a live code, and the audit log records the attempts.
 */
export class JoinGuard {
  private failures = new Map<string, number[]>();
  private blockedUntil = new Map<string, number>();

  constructor(
    private readonly clock: Clock,
    private readonly maxFailures = 10,
    private readonly windowMs = 60_000,
    private readonly blockMs = 5 * 60_000,
  ) {}

  isBlocked(key: string): boolean {
    const until = this.blockedUntil.get(key);
    if (until === undefined) return false;
    if (until > this.clock.now()) return true;
    this.blockedUntil.delete(key);
    return false;
  }

  recordFailure(key: string): void {
    const now = this.clock.now();
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    list.push(now);
    this.failures.set(key, list);
    if (list.length >= this.maxFailures) {
      this.blockedUntil.set(key, now + this.blockMs);
      this.failures.delete(key);
    }
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }

  /** periodic cleanup to bound memory */
  sweep(): void {
    const now = this.clock.now();
    for (const [k, list] of this.failures) if (list.every((t) => now - t >= this.windowMs)) this.failures.delete(k);
    for (const [k, until] of this.blockedUntil) if (until <= now) this.blockedUntil.delete(k);
  }
}
