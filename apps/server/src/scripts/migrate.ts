import { mkdirSync } from 'node:fs';
import { createDb, migrate } from '../db/db.js';

const url = process.env.DATABASE_URL ?? 'pglite://./.data/pglite';
if (url.startsWith('pglite://') && !url.endsWith('memory')) mkdirSync(url.slice(9), { recursive: true });
const db = await createDb(url);
const applied = await migrate(db);
console.log(applied.length ? `applied migrations: ${applied.join(', ')}` : 'database is up to date');
await db.close();
