import type { SubmitAnswerPayload } from '@brainbattle/shared';

/**
 * Local Pending Queue (SUBMIT_PENDING).
 *
 * Every submit is written here BEFORE it is sent. It is removed only when the server answers
 * ANSWER_ACCEPTED / ANSWER_UPDATED / ANSWER_REJECTED for the same idempotency key. After a
 * reconnect (or page reload) the remaining items are re-sent with `replay: true` and the SAME
 * idempotency key, so the server applies each at most once and can evaluate the original
 * press time (clientMonoAt in the original clock epoch).
 */
export interface PendingSubmit {
  type: 'SUBMIT_ANSWER' | 'UPDATE_ANSWER';
  payload: SubmitAnswerPayload;
  queuedAt: number;
  attempts: number;
}

export interface KeyValueStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

const memoryStorage = (): KeyValueStorage => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

export class PendingQueue {
  private items: PendingSubmit[] = [];
  private readonly storage: KeyValueStorage;

  constructor(
    private readonly key: string,
    storage?: KeyValueStorage,
  ) {
    let s = storage;
    if (!s) {
      try {
        s = window.localStorage;
      } catch {
        s = memoryStorage();
      }
    }
    this.storage = s;
    this.load();
  }

  private load(): void {
    try {
      const raw = this.storage.getItem(this.key);
      this.items = raw ? (JSON.parse(raw) as PendingSubmit[]) : [];
    } catch {
      this.items = [];
    }
  }

  private persist(): void {
    try {
      if (this.items.length) this.storage.setItem(this.key, JSON.stringify(this.items));
      else this.storage.removeItem(this.key);
    } catch {
      /* quota / private mode: queue stays in memory */
    }
  }

  add(item: PendingSubmit): void {
    // a newer answer for the same question supersedes an older unsent UPDATE of it
    this.items = this.items.filter(
      (x) => !(x.payload.sessionQuestionId === item.payload.sessionQuestionId && x.type === 'UPDATE_ANSWER' && item.type === 'UPDATE_ANSWER'),
    );
    this.items.push(item);
    this.persist();
  }

  resolve(idempotencyKey: string): PendingSubmit | undefined {
    const found = this.items.find((x) => x.payload.idempotencyKey === idempotencyKey);
    if (found) {
      this.items = this.items.filter((x) => x !== found);
      this.persist();
    }
    return found;
  }

  markAttempt(idempotencyKey: string): void {
    const it = this.items.find((x) => x.payload.idempotencyKey === idempotencyKey);
    if (it) {
      it.attempts += 1;
      this.persist();
    }
  }

  list(): PendingSubmit[] {
    return [...this.items];
  }

  has(sessionQuestionId: string): boolean {
    return this.items.some((x) => x.payload.sessionQuestionId === sessionQuestionId);
  }

  get size(): number {
    return this.items.length;
  }
}
