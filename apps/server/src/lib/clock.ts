/**
 * Server clock + timer abstraction. The server wall clock (UTC epoch ms) is the authoritative
 * time source of the whole system. Tests inject ManualClock to control time deterministically.
 */
export interface TimerHandle {
  cancel(): void;
}

export interface Clock {
  now(): number;
  setTimer(fn: () => void, delayMs: number): TimerHandle;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer(fn, delayMs) {
    const t = setTimeout(fn, Math.max(0, delayMs));
    t.unref?.();
    return { cancel: () => clearTimeout(t) };
  },
};

export class ManualClock implements Clock {
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;

  constructor(private t = 1_750_000_000_000) {}

  now(): number {
    return this.t;
  }

  setTimer(fn: () => void, delayMs: number): TimerHandle {
    const id = this.nextId++;
    this.timers.push({ at: this.t + Math.max(0, delayMs), fn, id });
    return { cancel: () => (this.timers = this.timers.filter((x) => x.id !== id)) };
  }

  /** Advance time, firing due timers in order. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = target;
  }

  set(t: number): void {
    this.t = t;
  }
}
