import { MIGRATIONS } from './schema.js';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  readonly kind: 'pg' | 'pglite';
  /** Runs fn inside a transaction. All statements must use the provided Queryable. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * DATABASE_URL:
 *   postgres://user:pass@host:5432/db  → node-postgres pool (production)
 *   pglite://memory                    → in-process PGlite, in-memory (tests)
 *   pglite://./.data/pglite            → in-process PGlite persisted to a directory (local dev)
 */
export async function createDb(url: string): Promise<Db> {
  if (url.startsWith('pglite://')) return createPgliteDb(url.slice('pglite://'.length));
  return createPgDb(url);
}

async function createPgliteDb(location: string): Promise<Db> {
  const { PGlite, types } = await import('@electric-sql/pglite');
  const parsers = {
    [types.INT8]: (v: string) => Number(v),
    [types.NUMERIC]: (v: string) => Number(v),
  };
  const pg =
    location === 'memory' || location === ''
      ? new PGlite({ parsers })
      : new PGlite(location, { parsers });
  await pg.waitReady;
  const wrap = (q: { query: typeof pg.query }): Queryable => ({
    async query<T>(sql: string, params?: unknown[]) {
      const r = await q.query<T>(sql, params as unknown[]);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
  });
  // PGlite is a single connection; serialize transactions explicitly so interleaved async
  // work from different session actors cannot observe each other's uncommitted state.
  let chain: Promise<unknown> = Promise.resolve();
  const base = wrap(pg);
  return {
    kind: 'pglite',
    query: (sql, params) => {
      const run = chain.then(() => base.query(sql, params));
      chain = run.catch(() => undefined);
      return run as never;
    },
    tx: <T>(fn: (q: Queryable) => Promise<T>) => {
      const run = chain.then(() => pg.transaction(async (tx) => fn(wrap(tx))));
      chain = run.catch(() => undefined);
      return run as Promise<T>;
    },
    exec: async (sql) => {
      const run = chain.then(() => pg.exec(sql));
      chain = run.catch(() => undefined);
      await run;
    },
    close: async () => {
      await chain;
      await pg.close();
    },
  };
}

async function createPgDb(url: string): Promise<Db> {
  const pgMod = await import('pg');
  const pgLib = (pgMod as unknown as { default?: typeof pgMod }).default ?? pgMod;
  pgLib.types.setTypeParser(20, (v: string) => Number(v)); // int8 → number (epoch ms fits in 2^53)
  pgLib.types.setTypeParser(1700, (v: string) => Number(v)); // numeric → number
  const pool = new pgLib.Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_SIZE ?? 20),
  });
  const query = async <T>(sql: string, params?: unknown[]) => {
    const r = await pool.query(sql, params);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
  };
  return {
    kind: 'pg',
    query,
    async tx<T>(fn: (q: Queryable) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: async <R>(sql: string, params?: unknown[]) => {
            const r = await client.query(sql, params);
            return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    async exec(sql) {
      await pool.query(sql);
    },
    close: () => pool.end(),
  };
}

export async function migrate(db: Db): Promise<number[]> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const { rows } = await db.query<{ version: number }>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => Number(r.version)));
  const done: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    await db.tx(async (q) => {
      for (const stmt of splitSql(m.sql)) await q.query(stmt);
      await q.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
    });
    done.push(m.version);
  }
  return done;
}

function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.replace(/--.*$/gm, '').trim())
    .filter((s) => s.length > 0);
}

/** true when err is a unique_violation (23505) */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e?.code !== '23505') return false;
  if (!constraint) return true;
  return e.constraint === constraint || (e.message ?? '').includes(constraint);
}
