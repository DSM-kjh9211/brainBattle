import type {
  LeaderboardChange,
  LeaderboardEntry,
  ScoreboardVisibility,
  SessionSettings,
  TieBreaker,
} from '@brainbattle/shared';

/**
 * Ranking Engine
 * ==============
 * Sort key:   totalScore DESC, then the session's tie breakers in order
 *             (default: correctCount DESC, lastScoredAt ASC — who reached the score first).
 * Ranks:      competition ranking ("1,2,2,4"). Two rows share a rank when every active key is
 *             equal; with allowTies=true only the score is compared.
 * Display:    rows with equal rank are ordered by nickname, then id (stable).
 *
 * Updates are incremental: a score change moves one row (binary insertion) and only rows between
 * its old and new index can change rank. The caller receives exactly those changes and can
 * broadcast them as LEADERBOARD_UPDATE; full snapshots are sent periodically.
 */
export interface RankRow {
  participantId: string;
  nickname: string;
  totalScore: number;
  correctCount: number;
  answeredCount: number;
  lastScoredAt: number | null;
  lastCorrectAt: number | null;
  avgResponseMs: number | null;
}

type Cmp = (a: RankRow, b: RankRow) => number;

const nullsLastAsc = (x: number | null, y: number | null) =>
  x === y ? 0 : x === null ? 1 : y === null ? -1 : x - y;

const TIE_BREAK_CMP: Record<TieBreaker, Cmp> = {
  CORRECT_COUNT_DESC: (a, b) => b.correctCount - a.correctCount,
  LAST_SCORED_AT_ASC: (a, b) => nullsLastAsc(a.lastScoredAt, b.lastScoredAt),
  LAST_CORRECT_AT_ASC: (a, b) => nullsLastAsc(a.lastCorrectAt, b.lastCorrectAt),
  AVG_RESPONSE_MS_ASC: (a, b) => nullsLastAsc(a.avgResponseMs, b.avgResponseMs),
};

export function makeRankComparator(r: SessionSettings['ranking']): Cmp {
  const keys: Cmp[] = [(a, b) => b.totalScore - a.totalScore];
  if (!r.allowTies) for (const t of r.tieBreakers) keys.push(TIE_BREAK_CMP[t]);
  return (a, b) => {
    for (const k of keys) {
      const c = k(a, b);
      if (c !== 0) return c;
    }
    return 0;
  };
}

export class Leaderboard {
  private rows = new Map<string, RankRow>();
  private order: string[] = [];
  private ranks = new Map<string, number>();
  private rankCmp: Cmp;
  private displayCmp: Cmp;
  version = 0;

  constructor(ranking: SessionSettings['ranking']) {
    this.rankCmp = makeRankComparator(ranking);
    this.displayCmp = (a, b) =>
      this.rankCmp(a, b) || a.nickname.localeCompare(b.nickname) || (a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0);
  }

  setRanking(ranking: SessionSettings['ranking']): void {
    this.rankCmp = makeRankComparator(ranking);
    this.rebuild([...this.rows.values()]);
  }

  rebuild(rows: RankRow[]): void {
    this.rows = new Map(rows.map((r) => [r.participantId, { ...r }]));
    this.order = [...this.rows.values()].sort(this.displayCmp).map((r) => r.participantId);
    this.ranks.clear();
    this.recomputeRanks(0, this.order.length - 1, true);
    this.version++;
  }

  get size(): number {
    return this.order.length;
  }

  rankOf(id: string): number | null {
    return this.ranks.get(id) ?? null;
  }

  row(id: string): RankRow | undefined {
    return this.rows.get(id);
  }

  /** Inserts or updates a row; returns every entry whose rank or score changed. */
  upsert(next: RankRow): LeaderboardChange[] {
    const prev = this.rows.get(next.participantId);
    let lo: number;
    let hi: number;
    if (prev) {
      const oldIdx = this.order.indexOf(next.participantId);
      this.order.splice(oldIdx, 1);
      this.rows.set(next.participantId, { ...next });
      const newIdx = this.insertionIndex(next);
      this.order.splice(newIdx, 0, next.participantId);
      lo = Math.min(oldIdx, newIdx);
      hi = Math.max(oldIdx, newIdx);
    } else {
      this.rows.set(next.participantId, { ...next });
      const newIdx = this.insertionIndex(next);
      this.order.splice(newIdx, 0, next.participantId);
      lo = newIdx;
      hi = this.order.length - 1; // everyone below shifts by one
    }
    const changed = this.recomputeRanks(lo, hi, false);
    if (!changed.has(next.participantId)) changed.set(next.participantId, this.ranks.get(next.participantId));
    this.version++;
    const out: LeaderboardChange[] = [];
    for (const [id, oldRank] of changed) {
      out.push({
        ...this.toEntry(this.rows.get(id)!),
        prevRank: id === next.participantId && !prev ? null : (oldRank ?? null),
      });
    }
    return out.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  }

  remove(id: string): LeaderboardChange[] {
    const idx = this.order.indexOf(id);
    if (idx < 0) return [];
    this.order.splice(idx, 1);
    this.rows.delete(id);
    this.ranks.delete(id);
    const changed = this.recomputeRanks(idx, this.order.length - 1, false);
    this.version++;
    return [...changed].map(([x, oldRank]) => ({ ...this.toEntry(this.rows.get(x)!), prevRank: oldRank ?? null }));
  }

  entries(): LeaderboardEntry[] {
    return this.order.map((id) => this.toEntry(this.rows.get(id)!));
  }

  private toEntry(r: RankRow): LeaderboardEntry {
    return {
      participantId: r.participantId,
      nickname: r.nickname,
      rank: this.ranks.get(r.participantId) ?? null,
      score: r.totalScore,
      correctCount: r.correctCount,
      answeredCount: r.answeredCount,
    };
  }

  private insertionIndex(r: RankRow): number {
    let lo = 0;
    let hi = this.order.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.displayCmp(this.rows.get(this.order[mid]!)!, r) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Recomputes ranks from index `from`; continues past `to` until ranks stabilise.
   * Returns ids whose rank changed, mapped to their previous rank.
   */
  private recomputeRanks(from: number, to: number, force: boolean): Map<string, number | undefined> {
    const changed = new Map<string, number | undefined>();
    for (let i = Math.max(0, from); i < this.order.length; i++) {
      const id = this.order[i]!;
      let rank: number;
      if (i === 0) rank = 1;
      else {
        const prevId = this.order[i - 1]!;
        rank = this.rankCmp(this.rows.get(prevId)!, this.rows.get(id)!) === 0 ? this.ranks.get(prevId)! : i + 1;
      }
      const old = this.ranks.get(id);
      if (old !== rank) {
        changed.set(id, old);
        this.ranks.set(id, rank);
      } else if (!force && i > to) break;
    }
    return changed;
  }
}

/* ------------------------------------------------------------------------ visibility policy */

export const TOP_N: Partial<Record<ScoreboardVisibility, number>> = { TOP_10: 10, TOP_5: 5, TOP_3: 3 };

/** What the public scoreboard / presentation may show. */
export function projectBoard(
  visibility: ScoreboardVisibility,
  visible: boolean,
  entries: LeaderboardEntry[],
): LeaderboardEntry[] {
  if (!visible) return [];
  switch (visibility) {
    case 'FULL':
      return entries;
    case 'TOP_10':
    case 'TOP_5':
    case 'TOP_3': {
      const n = TOP_N[visibility]!;
      return entries.filter((e) => (e.rank ?? Infinity) <= n);
    }
    case 'SCORES_ONLY':
      // anonymous score distribution
      return entries.map((e) => ({ ...e, participantId: '', nickname: '', rank: null }));
    case 'HIDE_RANK':
      return [...entries]
        .map((e) => ({ ...e, rank: null }))
        .sort((a, b) => a.nickname.localeCompare(b.nickname));
    case 'SELF_ONLY':
    case 'PRIVATE':
      return [];
  }
}

/** What a student may see about their own standing. */
export function projectSelf(
  visibility: ScoreboardVisibility,
  visible: boolean,
  resultsReleased: boolean,
  own: { totalScore: number; correctCount: number; answeredCount: number; rank: number | null },
): { showScore: boolean; showRank: boolean } {
  if (resultsReleased) return { showScore: true, showRank: visibility !== 'HIDE_RANK' && visibility !== 'SCORES_ONLY' };
  if (visibility === 'PRIVATE') return { showScore: false, showRank: false };
  const rankAllowed = visible && (visibility === 'FULL' || visibility === 'SELF_ONLY' || visibility in TOP_N);
  return { showScore: true, showRank: rankAllowed };
}

/** Filters incremental changes for a public board audience; null ⇒ send a snapshot instead. */
export function projectChanges(
  visibility: ScoreboardVisibility,
  visible: boolean,
  changes: LeaderboardChange[],
): { changes: LeaderboardChange[]; removed: string[] } | null {
  if (!visible || visibility === 'SELF_ONLY' || visibility === 'PRIVATE') return { changes: [], removed: [] };
  if (visibility === 'FULL') return { changes, removed: [] };
  const n = TOP_N[visibility];
  if (n === undefined) return null; // SCORES_ONLY / HIDE_RANK: reordering semantics differ → snapshot
  const inTop = changes.filter((c) => (c.rank ?? Infinity) <= n);
  const removed = changes
    .filter((c) => (c.rank ?? Infinity) > n && (c.prevRank ?? Infinity) <= n)
    .map((c) => c.participantId);
  return { changes: inTop, removed };
}
