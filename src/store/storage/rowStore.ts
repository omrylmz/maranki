/**
 * The row store (spec §3.7 "Row store", §3.8, §3.10, unit W3-3): the app
 * state in SQLite TABLES in its own file `maranki-rows.db`, one row per deck,
 * card type, note, card, list and session, plus `meta` rows and the
 * uncapped review history (`revlog`).
 *
 * WHY: the wave-2 kv-store writes the whole library (2.9 MB for
 * German_Complete) as ONE text on every save. The row store writes only the
 * rows that changed (rowDiff.ts), in one transaction. A rating writes about
 * 4 rows. The file is separate from the kv file `maranki-kv.db`, with its own
 * connection, so a save never meets "database is locked" from a kv write.
 *
 * Three layers, so each one can be tested alone:
 *   1. `RowDb` — the database as the port needs it: read tables and meta,
 *      write one diff in ONE transaction, read the revlog. Two versions:
 *        - `sqliteRowDb(db)` / `openRowDb()` — the real one, expo-sqlite;
 *        - `createMemoryRowDb()` — the same rules in memory, for tests and
 *          tools (the web preview does NOT use it: it uses the memory port).
 *   2. `createRowPort(options)` — the StoragePort (storagePort.ts) over a
 *      RowDb. It holds the boot read of spec §3.10 (row store first, then the
 *      legacy chain, legacyChain.ts) and the save rules below.
 *   3. rowDiff.ts (pure) — what a save writes.
 *
 * SAVE RULES (each one is a test in rowDiff.test.ts / legacyChain.test.ts):
 *   - ONE transaction per save (`withExclusiveTransactionAsync`). save()
 *     resolves only after COMMIT and rejects after a rollback. The persist
 *     controller moves its `lastSaved` only when save() resolved, so a failed
 *     save is simply sent again as the full difference (M15).
 *   - ONE write queue: save, replaceAll and the revlog writes run one after
 *     another, never two transactions at once. load() runs on it too, so its
 *     reads never see a commit half way.
 *   - The first save after a load that found the row store EMPTY (the first
 *     boot of this build: the data came from the kv-store, AsyncStorage or
 *     the rescue) writes EVERY row, with `meta.copiedFrom`, in one
 *     transaction — whatever `prev` says. The engine makes this save AT
 *     BOOT, before the app is ready (spec §3.10 step 3): `firstCopyPending()`
 *     tells it that a copy from the old storage waits. A kill before it
 *     commits rolls everything back, and the next boot copies again. The old
 *     copies are never deleted or changed (spec §3.1 rule 3). A genuine
 *     first boot (nothing stored anywhere) is NOT saved at boot: its seed
 *     is written with the first change (engine.ts bootOnce says why).
 *   - replaceAll (restore, factory reset) deletes every row and writes the
 *     state, in one transaction. "Restore is replace, never merge." A
 *     restore also gives the review history the restored library gets (the
 *     backup's rows, or this phone's kept rows): they are written in the
 *     SAME transaction, right after the old history is deleted. So a kill
 *     or a failed write never leaves the history table empty (final
 *     review). If it fails, the next save is a replace too, with the same
 *     history rows. A replaceAll never writes `meta.copiedFrom`: the rows
 *     then hold a backup or the seed, not the old copy.
 *   - The rows document of the last load was declared CORRUPT (migrate()
 *     said 'invalid'; the persist controller kept a copy with
 *     preserveCorrupt and saves the seed): that seed save REPLACES every
 *     row, like the kv port replaced the whole document. Keeping the old
 *     rows would bring the old library back on the next boot, under a new
 *     person and default settings. The replace deletes the revlog too, so
 *     the corrupt copy of a rows document carries the revlog rows (key
 *     "revlog", like a backup file): the study history is never lost.
 *   - Data from the OLD storage that the controller declared corrupt (a
 *     text JSON cannot read, or a document migrate() called invalid) is
 *     NOT copied: the seed is saved instead, without `meta.copiedFrom`.
 *   - The row store never deletes a row it did not load as part of the
 *     state: a card that the integrity check set aside stays on disk.
 *   - The first save after a rows load that the decode CHANGED (a repair, a
 *     new default after an app update) has no `prev` (the controller's
 *     `lastSaved` is null). It is diffed from the document AS LOADED. The
 *     port runs `decode` (the app: migrate()) on that document once, to know
 *     which rows the decode LEFT OUT (`setAsideRows`): only those are kept.
 *     Every other row that the state no longer has is deleted, also when
 *     the user deleted it before this first commit (a deck delete in the
 *     first 400 ms, or after a failed first save), and an undo deletes its
 *     revlog row as usual. Without `decode` (or when it fails) the port
 *     keeps EVERY loaded row on that save (the safe old rule).
 *   - M5: `completeSession` gives the new session, the person and
 *     `inProgressSession: null` in ONE state, so they are in one diff and one
 *     transaction (payout and marker clear are atomic).
 *   - A seq is never given twice (spec §3.4: "monotonic; also the revlog row
 *     key"): `highestRevlogSeq()` tells the engine the highest seq the
 *     revlog TABLE holds (read at each rows load, raised by every write).
 *     The table can hold a seq the review log does not have: an entry that
 *     migrate() removed keeps its row, and so do a restored backup's rows.
 *   - `meta.bootOkCount` (spec §3.10 step 6) goes up by one per load: with
 *     `markBootOk()`, which DataContext calls (through storage/index.ts
 *     `markAppBootOk`) when the boot was not blocked, or else with the first
 *     commit after the load — whichever comes first, never twice. The old
 *     storage copies may be deleted only in the release after
 *     bootOkCount ≥ 3 has shipped.
 *
 * READ RULES (C1):
 *   - the file cannot be opened, the tables cannot be made, or a read fails
 *     → load() REJECTS: the app is read-blocked and writes nothing;
 *   - rows exist but `meta.schemaVersion` does not, or a meta row is not
 *     valid JSON → load() rejects (never use the old copies or the seed over
 *     data we could not read);
 *   - a table row that is not valid JSON is left out of the document and
 *     counted (`stats().lastLoad.unreadableRows`); it stays on disk.
 */
import { openDatabaseAsync, type SQLiteBindValue } from 'expo-sqlite';

import type { DataState } from '../../domain/types';
import type { RevlogRow } from '../../domain/model';
import type { LoadResult, StoragePort } from '../storagePort';
import { classifyRaw, createKvStoragePort, type KeyValueStore } from './kvStoragePort';
import {
  copiedFromOf,
  readLegacyRaw,
  readStoreChain,
  type LegacyChainSources,
  type LegacySource,
  type RowCopiedFrom,
} from './legacyChain';
import {
  assembleDoc,
  diffSize,
  diffState,
  emptyDiff,
  isEmptyDiff,
  isMetaKey,
  ROW_TABLES,
  setAsideRows,
  STORE_META_KEYS,
  withStoreMeta,
  type DiffOptions,
  type MetaWrite,
  type RowDiff,
  type RowTable,
  type RowWrite,
  type SetAside,
} from './rowDiff';
import {
  cleanRevlogRow,
  createRevlogStore,
  placeholders,
  REVLOG_ROWS_PER_INSERT,
  REVLOG_SEQS_PER_DELETE,
  revlogFromSql,
  revlogParams,
  revlogSql,
  type RevlogInsertMode,
  type RevlogSqlRow,
  type RevlogStore,
  type WriteQueue,
} from './revlogStore';

/* --------------------------------------------------------------- layout */

/** The row store's database file (separate from the kv file `maranki-kv.db`). */
export const ROWS_DB_NAME = 'maranki-rows.db';

/**
 * The SQL layout version (PRAGMA user_version): which TABLES exist. It is
 * separate from `meta.schemaVersion` (the data model). It is never lowered:
 * a newer build may add tables, and this build still reads its own ones.
 */
export const ROW_LAYOUT_VERSION = 1;

/** How long one write waits for another writer before it fails (a guard: all writes are queued anyway). */
export const BUSY_TIMEOUT_MS = 5000;

/** The tables and indexes of spec §3.8. Every statement is safe to run again. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta       (key TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS decks      (id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS note_types (id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notes      (id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cards      (id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lists      (id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions   (id TEXT PRIMARY KEY NOT NULL, day_key TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS revlog (
  seq INTEGER PRIMARY KEY, card_id TEXT NOT NULL, deck_id TEXT NOT NULL, at_ms INTEGER NOT NULL,
  rating TEXT NOT NULL, bucket TEXT NOT NULL, ivl_before REAL NOT NULL, ivl_after REAL NOT NULL,
  ease_after REAL NOT NULL, duration_ms INTEGER);
CREATE INDEX IF NOT EXISTS revlog_card ON revlog(card_id);
CREATE INDEX IF NOT EXISTS revlog_at ON revlog(at_ms);
`;

/** Rows per INSERT: 300 × 3 values = 900, under SQLite's oldest limit of 999 bound values. */
export const ROWS_PER_INSERT = 300;
/** Keys per DELETE … IN (…). */
export const KEYS_PER_DELETE = 900;

/** `(?, ?), (?, ?)` — `rows` groups of `width` question marks. */
function valueRows(rows: number, width: number): string {
  const one = `(${placeholders(width)})`;
  return Array.from({ length: rows }, () => one).join(', ');
}

/**
 * The SQL text of the row tables and `meta` (the revlog's is in
 * revlogStore.ts). Table names come only from ROW_TABLES, never from data.
 *
 * Upserts use `ON CONFLICT … DO UPDATE`, not `INSERT OR REPLACE`: an update
 * keeps the row's rowid, so it keeps its place in the load order (rowDiff.ts).
 */
export const rowSql = {
  anyRow: (table: RowTable | 'meta' | 'revlog') => `SELECT 1 AS one FROM ${table} LIMIT 1`,
  readMeta: 'SELECT key, json FROM meta ORDER BY rowid',
  /** One table as ONE JSON array text, in rowid order (one JSON.parse instead of 16k). */
  readJson: (table: RowTable) => `SELECT json_group_array(json(json) ORDER BY rowid) AS a FROM ${table}`,
  /** One table's stored texts, one row each (the fallback, and the raw copy). */
  readTexts: (table: RowTable) => `SELECT json FROM ${table} ORDER BY rowid`,
  upsert: (table: RowTable, rows: number) =>
    table === 'sessions'
      ? `INSERT INTO sessions (id, day_key, json) VALUES ${valueRows(rows, 3)} ON CONFLICT(id) DO UPDATE SET day_key = excluded.day_key, json = excluded.json`
      : `INSERT INTO ${table} (id, json) VALUES ${valueRows(rows, 2)} ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
  delete: (table: RowTable, keys: number) => `DELETE FROM ${table} WHERE id IN (${placeholders(keys)})`,
  clear: (table: RowTable) => `DELETE FROM ${table}`,
  upsertMeta: (rows: number) =>
    `INSERT INTO meta (key, json) VALUES ${valueRows(rows, 2)} ON CONFLICT(key) DO UPDATE SET json = excluded.json`,
  deleteMeta: (keys: number) => `DELETE FROM meta WHERE key IN (${placeholders(keys)})`,
  /** A replace-all keeps only the store's own meta rows (copiedFrom, bootOkCount). */
  clearMeta: `DELETE FROM meta WHERE key NOT IN (${placeholders(STORE_META_KEYS.length)})`,
  /** The highest history seq (`top` is NULL when the revlog is empty). The other revlog SQL is in revlogStore.ts. */
  revlogTop: 'SELECT MAX(seq) AS top FROM revlog',
  userVersion: 'PRAGMA user_version',
  setUserVersion: (v: number) => `PRAGMA user_version = ${Math.trunc(v)}`,
  wal: 'PRAGMA journal_mode = WAL',
  busyTimeout: `PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`,
} as const;

/* ----------------------------------------------------------------- RowDb */

/**
 * How a write treats what is stored:
 *   - diff    — apply the diff to the stored rows;
 *   - replace — first delete every row (all tables, the revlog, and meta
 *               except the store's own keys), then apply the diff.
 */
export type WriteMode = 'diff' | 'replace';

/** The row database as the row port needs it. Every method rejects on failure. */
export interface RowDb {
  /** Make the tables when they are missing (and turn on WAL). Never lowers PRAGMA user_version. */
  ensureSchema(): Promise<void>;
  /** True when any table (meta and revlog too) has a row. */
  hasRows(): Promise<boolean>;
  /** Every meta row as [key, stored JSON text], in storage order. */
  readMeta(): Promise<[string, string][]>;
  /** One table as ONE JSON array text, in storage order. May reject when a row is not valid JSON. */
  readTableJson(table: RowTable): Promise<string>;
  /** One table's stored texts, one per row, in storage order. */
  readTableTexts(table: RowTable): Promise<string[]>;
  /** Apply `diff` in ONE transaction. Resolves after COMMIT; on any failure nothing is changed and it rejects. */
  write(diff: RowDiff, mode: WriteMode): Promise<void>;
  /** Write history rows (INSERT OR REPLACE by seq) in one transaction. */
  writeRevlog(rows: readonly RevlogRow[]): Promise<void>;
  /** History rows, oldest first; only one card's when `cardId` is given. */
  readRevlog(cardId?: string): Promise<RevlogRow[]>;
  /**
   * The highest `seq` in the revlog table, or 0 when the table is empty.
   * Optional: the port asks a RowDb without it with `readRevlog()` (every
   * row, so slower). Both RowDbs of this file have it.
   */
  highestRevlogSeq?(): Promise<number>;
}

/** The part of an expo-sqlite connection the row store uses (a transaction has the same methods). */
export interface SqlRunner {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params: SQLiteBindValue[]): Promise<unknown>;
  getFirstAsync<T>(source: string, params: SQLiteBindValue[]): Promise<T | null>;
  getAllAsync<T>(source: string, params: SQLiteBindValue[]): Promise<T[]>;
}

/** An expo-sqlite database (`SQLiteDatabase` fits this type). */
export interface SqlDatabase extends SqlRunner {
  /** expo-sqlite runs the task on a NEW connection, inside BEGIN … COMMIT (ROLLBACK when it throws). */
  withExclusiveTransactionAsync(task: (txn: SqlRunner) => Promise<void>): Promise<void>;
}

/** `items` in slices of at most `size`. */
function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The bound values of row upserts. */
function upsertParams(table: RowTable, rows: readonly RowWrite[]): SQLiteBindValue[] {
  const params: SQLiteBindValue[] = [];
  for (const row of rows) {
    if (table === 'sessions') params.push(row.key, row.dayKey ?? '', row.json);
    else params.push(row.key, row.json);
  }
  return params;
}

/** Insert history rows in slices. */
async function insertRevlog(txn: SqlRunner, rows: readonly RevlogRow[], mode: RevlogInsertMode): Promise<void> {
  for (const part of chunks(rows, REVLOG_ROWS_PER_INSERT)) {
    await txn.runAsync(revlogSql.insert(part.length, mode), part.flatMap(revlogParams));
  }
}

/** Run every statement of one diff on a transaction (the order is part of the contract). */
async function runDiff(txn: SqlRunner, diff: RowDiff, mode: WriteMode): Promise<void> {
  await txn.execAsync(rowSql.busyTimeout);
  if (mode === 'replace') {
    for (const { table } of ROW_TABLES) await txn.runAsync(rowSql.clear(table), []);
    await txn.runAsync(rowSql.clearMeta, [...STORE_META_KEYS]);
    await txn.runAsync(revlogSql.clear, []);
  }
  for (const { table } of ROW_TABLES) {
    const { deletes, upserts } = diff.tables[table];
    for (const part of chunks(deletes, KEYS_PER_DELETE)) await txn.runAsync(rowSql.delete(table, part.length), part);
    for (const part of chunks(upserts, ROWS_PER_INSERT)) {
      await txn.runAsync(rowSql.upsert(table, part.length), upsertParams(table, part));
    }
  }
  for (const part of chunks(diff.metaDelete, KEYS_PER_DELETE)) await txn.runAsync(rowSql.deleteMeta(part.length), part);
  for (const part of chunks<MetaWrite>(diff.metaSet, ROWS_PER_INSERT)) {
    await txn.runAsync(rowSql.upsertMeta(part.length), part.flatMap((m) => [m.key, m.json]));
  }
  for (const part of chunks(diff.revlogDelete, REVLOG_SEQS_PER_DELETE)) await txn.runAsync(revlogSql.delete(part.length), part);
  await insertRevlog(txn, diff.revlogPut, 'replace');
  await insertRevlog(txn, diff.revlogAdd, 'ignore');
}

/** A stored seq as a number ≥ 0: NULL (an empty table) or anything else that is not a usable seq → 0. */
function seqOrZero(value: unknown): number {
  const seq = Number(value ?? 0);
  return Number.isFinite(seq) && seq > 0 ? seq : 0;
}

/** The RowDb over an expo-sqlite database. */
export function sqliteRowDb(db: SqlDatabase): RowDb {
  return {
    async ensureSchema() {
      await db.execAsync(rowSql.wal);
      const version = (await db.getFirstAsync<{ user_version: number }>(rowSql.userVersion, []))?.user_version ?? 0;
      await db.execAsync(SCHEMA_SQL);
      if (!(Number(version) >= ROW_LAYOUT_VERSION)) await db.execAsync(rowSql.setUserVersion(ROW_LAYOUT_VERSION));
    },
    async hasRows() {
      for (const table of ['meta', ...ROW_TABLES.map((t) => t.table), 'revlog'] as const) {
        if (await db.getFirstAsync<{ one: number }>(rowSql.anyRow(table), [])) return true;
      }
      return false;
    },
    async readMeta() {
      const rows = await db.getAllAsync<{ key: string; json: string }>(rowSql.readMeta, []);
      return rows.map((r) => [String(r.key), String(r.json)]);
    },
    async readTableJson(table) {
      const row = await db.getFirstAsync<{ a: string | null }>(rowSql.readJson(table), []);
      return typeof row?.a === 'string' ? row.a : '[]';
    },
    async readTableTexts(table) {
      const rows = await db.getAllAsync<{ json: string }>(rowSql.readTexts(table), []);
      return rows.map((r) => String(r.json));
    },
    write(diff, mode) {
      return db.withExclusiveTransactionAsync((txn) => runDiff(txn, diff, mode));
    },
    writeRevlog(rows) {
      return db.withExclusiveTransactionAsync(async (txn) => {
        await txn.execAsync(rowSql.busyTimeout);
        await insertRevlog(txn, rows, 'replace');
      });
    },
    async readRevlog(cardId) {
      const rows =
        cardId === undefined
          ? await db.getAllAsync<RevlogSqlRow>(revlogSql.selectAll, [])
          : await db.getAllAsync<RevlogSqlRow>(revlogSql.selectCard, [cardId]);
      return rows.map(revlogFromSql);
    },
    async highestRevlogSeq() {
      const row = await db.getFirstAsync<{ top: number | null }>(rowSql.revlogTop, []);
      return seqOrZero(row?.top);
    },
  };
}

/**
 * Open the app's row database `maranki-rows.db` (expo-sqlite's default
 * folder, the same as the kv file, but its own file and connection).
 * Native only: the web preview never opens it (withExclusiveTransactionAsync
 * does not work on web; the web uses the memory port, spec §3.7).
 */
export async function openRowDb(): Promise<RowDb> {
  const db = await openDatabaseAsync(ROWS_DB_NAME);
  return sqliteRowDb(db);
}

/* ------------------------------------------------------ the memory RowDb */

/** Everything a memory RowDb holds, as plain data (for tests). */
export interface MemoryRowSnapshot {
  meta: [string, string][];
  tables: Record<RowTable, [string, string][]>;
  revlog: RevlogRow[];
}

/**
 * A RowDb in memory, with the same rules as SQLite: TEXT values only, an
 * update keeps a row's place, a new row goes to the end, a write is ONE
 * transaction (all or nothing). For tests and tools; the app never uses it.
 */
export interface MemoryRowDb extends RowDb {
  /** Committed write transactions (write and writeRevlog). */
  readonly writes: number;
  /** The next `failWrites` writes fail (and change nothing). */
  failWrites: number;
  /** While true, every read rejects (a broken file). */
  failReads: boolean;
  /** PRAGMA user_version. */
  layoutVersion: number;
  snapshot(): MemoryRowSnapshot;
}

type Tables = Map<RowTable, Map<string, string>>;

function emptyTables(): Tables {
  return new Map(ROW_TABLES.map(({ table }) => [table, new Map<string, string>()]));
}

function assertText(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(`NOT NULL constraint failed: ${what}`);
}

function assertRevlog(row: RevlogRow): void {
  for (const v of [row.seq, row.atMs, row.ivlBefore, row.ivlAfter, row.easeAfter]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('NOT NULL constraint failed: revlog');
  }
  assertText(row.cardId, 'revlog.card_id');
  assertText(row.deckId, 'revlog.deck_id');
}

export function createMemoryRowDb(initial?: MemoryRowSnapshot): MemoryRowDb {
  let meta = new Map<string, string>(initial?.meta ?? []);
  let tables = emptyTables();
  if (initial) for (const { table } of ROW_TABLES) tables.set(table, new Map(initial.tables[table]));
  let revlog = new Map<number, RevlogRow>((initial?.revlog ?? []).map((r) => [r.seq, { ...r }]));
  let writes = 0;

  const tick = () => Promise.resolve();
  const table = (t: RowTable) => tables.get(t) ?? new Map<string, string>();

  const db: MemoryRowDb = {
    failWrites: 0,
    failReads: false,
    layoutVersion: 0,
    get writes() {
      return writes;
    },
    snapshot() {
      const out = {} as Record<RowTable, [string, string][]>;
      for (const { table: t } of ROW_TABLES) out[t] = [...table(t)];
      return { meta: [...meta], tables: out, revlog: [...revlog.values()].sort((a, b) => a.seq - b.seq) };
    },
    async ensureSchema() {
      await tick();
      if (db.failReads) throw new Error('disk I/O error');
      db.layoutVersion = Math.max(db.layoutVersion, ROW_LAYOUT_VERSION);
    },
    async hasRows() {
      await tick();
      if (db.failReads) throw new Error('disk I/O error');
      return meta.size > 0 || revlog.size > 0 || ROW_TABLES.some(({ table: t }) => table(t).size > 0);
    },
    async readMeta() {
      await tick();
      if (db.failReads) throw new Error('disk I/O error');
      return [...meta];
    },
    async readTableJson(t) {
      await tick();
      if (db.failReads) throw new Error('disk I/O error');
      return `[${[...table(t).values()].join(',')}]`;
    },
    async readTableTexts(t) {
      await tick();
      if (db.failReads) throw new Error('disk I/O error');
      return [...table(t).values()];
    },
    async write(diff, mode) {
      await tick();
      if (db.failWrites > 0) {
        db.failWrites -= 1;
        throw new Error('database or disk is full');
      }
      // Work on copies; swap them in only when everything worked (one transaction).
      const nextMeta =
        mode === 'replace'
          ? new Map([...meta].filter(([key]) => (STORE_META_KEYS as readonly string[]).includes(key)))
          : new Map(meta);
      const nextTables: Tables = mode === 'replace' ? emptyTables() : new Map([...tables].map(([k, v]) => [k, new Map(v)]));
      const nextRevlog = mode === 'replace' ? new Map<number, RevlogRow>() : new Map(revlog);
      for (const { table: t } of ROW_TABLES) {
        const rows = nextTables.get(t)!;
        for (const key of diff.tables[t].deletes) rows.delete(key);
        for (const row of diff.tables[t].upserts) {
          assertText(row.key, `${t}.id`);
          assertText(row.json, `${t}.json`);
          rows.set(row.key, row.json);
        }
      }
      for (const key of diff.metaDelete) nextMeta.delete(key);
      for (const m of diff.metaSet) {
        assertText(m.key, 'meta.key');
        assertText(m.json, 'meta.json');
        nextMeta.set(m.key, m.json);
      }
      for (const seq of diff.revlogDelete) nextRevlog.delete(seq);
      for (const row of diff.revlogPut) {
        assertRevlog(row);
        nextRevlog.set(row.seq, { ...row });
      }
      for (const row of diff.revlogAdd) {
        assertRevlog(row);
        if (!nextRevlog.has(row.seq)) nextRevlog.set(row.seq, { ...row });
      }
      meta = nextMeta;
      tables = nextTables;
      revlog = nextRevlog;
      writes += 1;
    },
    async writeRevlog(rows) {
      await tick();
      if (db.failWrites > 0) {
        db.failWrites -= 1;
        throw new Error('database or disk is full');
      }
      const next = new Map(revlog);
      for (const row of rows) {
        assertRevlog(row);
        next.set(row.seq, { ...row });
      }
      revlog = next;
      writes += 1;
    },
    async readRevlog(cardId) {
      await tick();
      if (db.failReads) throw new Error('disk I/O error');
      return [...revlog.values()]
        .filter((r) => cardId === undefined || r.cardId === cardId)
        .sort((a, b) => a.seq - b.seq)
        .map((r) => ({ ...r }));
    },
    async highestRevlogSeq() {
      await tick();
      if (db.failReads) throw new Error('disk I/O error');
      let top = 0;
      for (const seq of revlog.keys()) if (seq > top) top = seq;
      return top;
    },
  };
  return db;
}

/* --------------------------------------------------------------- the port */

/** The row store has rows, but they cannot be used. load() rejects with it (read-blocked, C1). */
export class RowStoreError extends Error {
  readonly reason: unknown;

  constructor(message: string, reason?: unknown) {
    super(message);
    this.name = 'RowStoreError';
    this.reason = reason;
  }
}

/** Where the last load found the data. */
export type LoadSource = 'rows' | LegacySource | 'empty';

/** Facts about the last load and save, for dev timings (perfMarks) and tests. */
export interface RowPortStats {
  lastLoad: { from: LoadSource; unreadableRows: number; ms: number } | null;
  lastSave: { mode: 'diff' | 'full' | 'replace'; rows: number; ms: number } | null;
  /** Committed save and replace transactions of this port. */
  commits: number;
}

export interface RowPortOptions {
  /** Open the row database (the app: `openRowDb`). Called once; a failure is tried again by the next load. */
  open: () => Promise<RowDb>;
  /** The old places, read only when the row store is EMPTY (legacyChain.ts). Read only: nothing there is ever changed. */
  legacy: LegacyChainSources;
  /** The kv-store: ONLY for the corrupt copy `maranki.state.corrupt.{stamp}` (spec §3.10). */
  kv: KeyValueStore;
  /** The clock: the stamp of a corrupt copy and of `meta.copiedFrom`. */
  now: () => number;
  /** The file copy of a corrupt text. Default: `writeCorruptBackupFile` (backups/corrupt-{stamp}.json). */
  corruptFile?: (raw: string, stamp: string) => void | Promise<void>;
  /**
   * The app's decode of a loaded document: the STATE it makes of it (the
   * app: migrate()'s state), or null when it makes none. Called at most once
   * per load, and only for the first save after a rows load that the decode
   * changed (see the file comment): the rows of the document that this
   * state does not have are the rows the decode set aside, and only those
   * are kept. It must be the same decode the engine uses. Left out, null or
   * a throw → that save keeps every loaded row (the safe old rule).
   */
  decode?: (doc: Record<string, unknown>) => object | null;
}

/** The row port: a StoragePort, plus the review history and dev facts. */
export interface RowPort<S = DataState> extends StoragePort<S> {
  /** The uncapped review history in the same database (history.ts, the Restore flow). */
  readonly revlog: RevlogStore;
  stats(): RowPortStats;
  /**
   * Count this boot: `meta.bootOkCount` + 1 (spec §3.10 step 6). The engine
   * calls it once the boot reached "ready" (never for a read-blocked boot).
   * One small transaction on the write queue. Once per load: a no-op when
   * this load's count is already on the disk (markBootOk() or a commit wrote
   * it), before any load, and while the row store is still EMPTY (the first
   * copy from the old storage writes the count with every row; a count
   * alone would leave rows without `schemaVersion`, which the next boot
   * cannot read). Never rejects: when the write fails, the next commit
   * writes the count.
   */
  markBootOk(): Promise<void>;
  /**
   * True after a load that found a document in an OLD place (the kv-store,
   * AsyncStorage or the rescue) and the row store empty, until the first
   * commit: the copy into the rows (with `meta.copiedFrom`) still waits.
   * False again when the controller declares that document corrupt
   * (preserveCorrupt): then the seed is saved, not a copy.
   * The engine then saves once at boot (spec §3.10 step 3: the copy is made
   * during the first boot, not at the first change), so the next boot reads
   * the rows and does not migrate the old document again.
   */
  firstCopyPending(): boolean;
  /**
   * The highest `seq` the revlog table holds, as far as this port knows
   * (synchronous, so the engine can read it on every rating): read with each
   * rows load, and raised by every commit and every `revlog.write`. 0 before
   * the first load. Never lowered (also not by a replace): a gap in the
   * numbers is harmless, a seq given twice is not.
   *
   * WHY: the engine gives the next rating `seq = highest + 1`, and it knows
   * only the seqs of the state's review log. The table can hold a HIGHER
   * one: a review-log entry that migrate() removed (it had no usable card
   * id) keeps its history row, and so do the rows of a restored backup's history. A
   * new rating with such a seq would write over that row (or be dropped by
   * INSERT OR IGNORE): one history row lost for good. So the engine never
   * gives a seq at or below this number.
   */
  highestRevlogSeq(): number;
}

/** What the boot read found in the row store. */
interface RowsRead {
  doc: Record<string, unknown>;
  unreadableRows: number;
  bootOkCount: number;
}

/** A wall-clock reading in ms, for timings only (never for data). */
function msNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/**
 * One table's rows. The fast path parses ONE array text; when that fails (a
 * row that is not valid JSON), each row is parsed alone and the broken ones
 * are counted and left out. A read that fails rejects (C1).
 */
async function readTable(db: RowDb, table: RowTable): Promise<{ rows: unknown[]; unreadable: number }> {
  let text: string | null;
  try {
    text = await db.readTableJson(table);
  } catch {
    text = null;
  }
  if (text !== null) {
    try {
      const rows: unknown = JSON.parse(text);
      if (Array.isArray(rows)) return { rows, unreadable: 0 };
    } catch {
      // A broken row: read them one by one below.
    }
  }
  const rows: unknown[] = [];
  let unreadable = 0;
  for (const json of await db.readTableTexts(table)) {
    try {
      rows.push(JSON.parse(json));
    } catch {
      unreadable += 1;
    }
  }
  return { rows, unreadable };
}

/** The highest seq of the revlog table (a RowDb without `highestRevlogSeq` reads every row). Rejects when the read fails. */
async function storedRevlogTop(db: RowDb): Promise<number> {
  if (typeof db.highestRevlogSeq === 'function') return seqOrZero(await db.highestRevlogSeq());
  let top = 0;
  for (const row of await db.readRevlog()) if (row.seq > top) top = row.seq;
  return seqOrZero(top);
}

/** The highest seq of the history rows a diff puts into the revlog (0 when it writes none). */
function topSeqOf(rows: readonly RevlogRow[]): number {
  let top = 0;
  for (const row of rows) if (row.seq > top) top = row.seq;
  return top;
}

/** The stored document, or null when the row store is EMPTY. Rejects when rows exist but cannot be used. */
async function readRows(db: RowDb): Promise<RowsRead | null> {
  if (!(await db.hasRows())) return null;
  const meta = new Map<string, unknown>();
  for (const [key, json] of await db.readMeta()) {
    try {
      meta.set(key, JSON.parse(json));
    } catch (cause) {
      throw new RowStoreError(`The saved value "${key}" cannot be read.`, cause);
    }
  }
  if (!meta.has('schemaVersion')) {
    throw new RowStoreError('The row store has rows but no schemaVersion: it is not used and not changed.');
  }
  const tables = {} as Record<RowTable, unknown[]>;
  let unreadableRows = 0;
  for (const { table } of ROW_TABLES) {
    const read = await readTable(db, table);
    tables[table] = read.rows;
    unreadableRows += read.unreadable;
  }
  const count = meta.get('bootOkCount');
  return {
    doc: assembleDoc(meta, tables),
    unreadableRows,
    bootOkCount: typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : 0,
  };
}

/**
 * The stored rows as ONE text, without parsing anything ("Save a copy of
 * the raw data"): `{"schemaVersion":3,…,"cards":[…],…}` from the stored JSON
 * texts. When every row is valid JSON, the text is a document a restore can
 * read; when one is broken, the text still has it, byte for byte.
 *
 * `withRevlog: true` also adds the review history as one more key,
 * `"revlog":[{seq, cardId, …}, …]` (the same rows a backup file carries).
 * The corrupt copy needs it: the history is NOT part of the document, and
 * the seed save after a corrupt load deletes it (see preserveCorrupt). The
 * key is "revlog", or "_revlog" (and so on) when the document itself has a
 * key "revlog", so no key is ever written twice.
 */
async function rawDump(db: RowDb, withRevlog = false): Promise<string> {
  const parts: string[] = [];
  const keys = new Set<string>();
  for (const [key, json] of await db.readMeta()) {
    if (!isMetaKey(key)) continue;
    keys.add(key);
    parts.push(`${JSON.stringify(key)}:${json}`);
  }
  for (const { table, key } of ROW_TABLES) {
    keys.add(key);
    parts.push(`${JSON.stringify(key)}:[${(await db.readTableTexts(table)).join(',')}]`);
  }
  if (withRevlog) {
    let historyKey = 'revlog';
    while (keys.has(historyKey)) historyKey = `_${historyKey}`;
    parts.push(`${JSON.stringify(historyKey)}:${JSON.stringify(await db.readRevlog())}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * The row port (see the file comment). `S` is the state shape (the app's
 * `DataState`); the diff reads it as a plain object.
 *
 * Example (index.ts builds it on a phone):
 *   const port = createRowPort({ open: openRowDb, kv: getKvStore(), now: Date.now,
 *     legacy: { readKv: () => kv.getItem('maranki.state'), readAsyncStorage, rescue },
 *     decode: (doc) => decodedState(doc, Date.now()) });   // migrate()'s state
 *   const engine = createEngine(port);
 *   // after boot() reached "ready": void port.markBootOk();
 */
export function createRowPort<S = DataState>(options: RowPortOptions): RowPort<S> {
  const { legacy, now } = options;
  const kvCopies = createKvStoragePort<S>({ store: options.kv, now, corruptFile: options.corruptFile });

  /* The database: opened (and its tables made) once. A failure is tried again next time. */
  let opening: Promise<RowDb> | null = null;
  const getDb = (): Promise<RowDb> => {
    if (!opening) {
      const started = (async () => {
        const db = await options.open();
        await db.ensureSchema();
        return db;
      })();
      opening = started;
      started.catch(() => {
        if (opening === started) opening = null;
      });
    }
    return opening;
  };

  /* One write queue: save, replaceAll and revlog writes, one after another. */
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue: WriteQueue = (task) => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };

  /* What the last load left for the first commit after it (see the file comment). */
  /** The document the last ROWS load gave: the base of a save that has no `prev`. */
  let loadedDoc: Record<string, unknown> | null = null;
  /**
   * The rows of `loadedDoc` that the decode left out (see `decode`):
   * undefined = not asked yet; null = unknown, so that save keeps every row.
   */
  let setAside: SetAside | null | undefined;
  /** True after a load that found the row store empty: the first commit writes every row. */
  let writeAll = false;
  /**
   * True when the next save must replace everything: after a failed
   * replaceAll, and after the loaded rows were declared corrupt
   * (preserveCorrupt, see the file comment).
   */
  let replaceNext = false;
  /**
   * The history rows of the last replaceAll (a restore: the backup's rows or
   * this phone's kept rows), until a replace commits. The save that retries
   * a failed replaceAll (`replaceNext`) writes them too, in its own
   * transaction: a retry never finishes a restore without its history.
   */
  let replaceHistory: readonly RevlogRow[] = [];
  /** Written with the first commit after a copy from the old storage. */
  let copiedFrom: RowCopiedFrom | null = null;
  /** `meta.bootOkCount` to write for this load (markBootOk or the first commit); null = written. */
  let bootCount: number | null = null;
  /** The highest seq the revlog table holds, as far as this port knows (see highestRevlogSeq). Never lowered. */
  let revlogTop = 0;
  const raiseRevlogTop = (seq: number) => {
    if (seq > revlogTop) revlogTop = seq;
  };

  const stats: RowPortStats = { lastLoad: null, lastSave: null, commits: 0 };

  /** After a commit: the disk holds the newest state, nothing is pending. */
  function committed(mode: 'diff' | 'full' | 'replace', rows: number, started: number): void {
    loadedDoc = null;
    setAside = undefined;
    writeAll = false;
    replaceNext = false;
    replaceHistory = [];
    copiedFrom = null;
    bootCount = null;
    stats.commits += 1;
    stats.lastSave = { mode, rows, ms: msNow() - started };
  }

  const pendingStoreMeta = () => ({ copiedFrom, bootOkCount: bootCount });

  /**
   * What a replace writes: every row of `state`, and the replace's history
   * rows (`replaceHistory`). The history rows are written OVER a row with
   * the same seq ('replace' mode), and the review log's own rows only where
   * no row has that seq ('ignore' mode): the restored history wins, as when
   * a restore wrote it after the commit.
   */
  function replaceDiff(state: object): RowDiff {
    const diff = diffState(null, state);
    if (replaceHistory.length === 0) return diff;
    return { ...diff, revlogPut: [...diff.revlogPut, ...replaceHistory] };
  }

  /**
   * The options of the first save after a CHANGED rows load (no `prev`):
   * keep only the rows the decode left out, when the decode can tell us.
   * Asked once per load (a failed save asks nothing again).
   */
  function changedLoadOptions(doc: Record<string, unknown>): DiffOptions {
    if (setAside === undefined) {
      setAside = null;
      try {
        const decoded = options.decode?.(doc) ?? null;
        if (decoded !== null && typeof decoded === 'object') setAside = setAsideRows(doc, decoded);
      } catch {
        // The decode failed here: keep every loaded row (the safe old rule).
      }
    }
    return setAside ? { setAside } : { keepRows: true };
  }

  /** The boot read (see load()). */
  async function loadNow(): Promise<LoadResult> {
    const started = msNow();
    // A load that fails counts no boot (markBootOk then does nothing).
    bootCount = null;
    setAside = undefined;
    const db = await getDb(); // rejects → read-blocked (C1)
    // Rows first. A rows read that fails rejects: the old copies may be
    // OLDER than the rows, so they are never used instead.
    const read = await readStoreChain(() => readRows(db), legacy);
    replaceNext = false;
    replaceHistory = [];
    if (read.from === 'rows') {
      // The history can hold a seq the review log does not have any more
      // (see highestRevlogSeq). A read that fails rejects, like every read here (C1).
      raiseRevlogTop(await storedRevlogTop(db));
      loadedDoc = read.rows.doc;
      writeAll = false;
      copiedFrom = null;
      bootCount = read.rows.bootOkCount + 1;
      stats.lastLoad = { from: 'rows', unreadableRows: read.rows.unreadableRows, ms: msNow() - started };
      return { kind: 'doc', value: read.rows.doc };
    }
    // The row store is empty: the first boot of this build (or of the app).
    loadedDoc = null;
    writeAll = true;
    copiedFrom = null;
    bootCount = 1;
    if (read.from === 'nothing') {
      stats.lastLoad = { from: 'empty', unreadableRows: 0, ms: msNow() - started };
      return { kind: 'empty' };
    }
    stats.lastLoad = { from: read.found.source, unreadableRows: 0, ms: msNow() - started };
    const result = classifyRaw(read.found.raw);
    // Only a parsed document is copied. A corrupt text is kept by
    // preserveCorrupt (kv key + file); the seed is then saved to the rows.
    if (result.kind === 'doc') copiedFrom = copiedFromOf(read.found, now());
    return result;
  }

  /* The review history. A `revlog.write` raises the top by its rows (a restore's rows come with replaceAll). */
  const history = createRevlogStore(getDb, enqueue);
  const revlog: RevlogStore = {
    forCard: (cardId) => history.forCard(cardId),
    all: () => history.all(),
    async write(rows) {
      const written = await history.write(rows);
      // Only the rows the store wrote (cleanRevlogRow, as in history.write).
      for (const row of rows) raiseRevlogTop(cleanRevlogRow(row)?.seq ?? 0);
      return written;
    },
  };

  return {
    revlog,

    stats: () => ({ ...stats }),

    load(): Promise<LoadResult> {
      // On the write queue too: the reads of one load (meta, then each table)
      // never see a save commit in between ("Try again" while an older
      // engine's last save still runs).
      return enqueue(loadNow);
    },

    save(next, prev) {
      return enqueue(async () => {
        const started = msNow();
        const db = await getDb();
        let mode: 'diff' | 'full' | 'replace';
        let diff: RowDiff;
        if (replaceNext) {
          // A failed replaceAll (its history rows too) or a corrupt rows load.
          mode = 'replace';
          diff = replaceDiff(next as object);
        } else if (writeAll) {
          // The rows were empty at load: write every row, whatever prev says.
          mode = 'full';
          diff = diffState(null, next as object);
        } else if (prev !== null) {
          mode = 'diff';
          diff = diffState(prev as object, next as object);
        } else if (loadedDoc !== null) {
          // The decode changed the loaded document: write what differs from
          // what was read. Keep the rows the decode set aside (spec §3.5);
          // delete the rows the user deleted since the load.
          mode = 'diff';
          diff = diffState(loadedDoc, next as object, changedLoadOptions(loadedDoc));
        } else {
          mode = 'full';
          diff = diffState(null, next as object);
        }
        diff = withStoreMeta(diff, pendingStoreMeta());
        if (mode !== 'replace' && isEmptyDiff(diff)) return;
        await db.write(diff, mode === 'replace' ? 'replace' : 'diff');
        raiseRevlogTop(Math.max(topSeqOf(diff.revlogPut), topSeqOf(diff.revlogAdd)));
        committed(mode, diffSize(diff), started);
      });
    },

    replaceAll(state, history = []) {
      // Rows that cannot be written are left out (as revlog.write does): one
      // NaN would fail the whole transaction, again and again.
      const rows: RevlogRow[] = [];
      for (const row of history) {
        const clean = cleanRevlogRow(row);
        if (clean) rows.push(clean);
      }
      return enqueue(async () => {
        const started = msNow();
        // A restore or a factory reset: the rows will hold THIS state, not
        // the copy from the old storage, so there is no copiedFrom to record
        // (also not on the save that retries this replace).
        copiedFrom = null;
        // THIS replace's history (none for a factory reset): kept until a
        // replace commits, so the save that retries it writes them too.
        replaceHistory = rows;
        try {
          const db = await getDb();
          const diff = withStoreMeta(replaceDiff(state as object), pendingStoreMeta());
          await db.write(diff, 'replace');
          raiseRevlogTop(Math.max(topSeqOf(diff.revlogPut), topSeqOf(diff.revlogAdd)));
          committed('replace', diffSize(diff), started);
        } catch (error) {
          // Nothing changed on the disk. The controller saves `state` again
          // with the next flush(); that save must replace everything too,
          // with the same history rows (`replaceHistory`).
          replaceNext = true;
          throw error;
        }
      });
    },

    markBootOk() {
      return enqueue(async () => {
        // Nothing to count (no load, or already written), or the rows are
        // still empty: the first copy writes the count with every row.
        if (bootCount === null || writeAll) return;
        const count = bootCount;
        try {
          const db = await getDb();
          await db.write(withStoreMeta(emptyDiff(), { bootOkCount: count }), 'diff');
          bootCount = null; // on the disk now: the next commit does not write it again
        } catch {
          // A counter is never a write error for the UI: the next commit writes it.
        }
      });
    },

    async preserveCorrupt(raw) {
      // The controller only asks for this copy when it cannot use the loaded
      // data: it saves the SEED next. So the rows will never hold a copy of
      // the old storage, and there is no `meta.copiedFrom` to record (and no
      // first copy waits: firstCopyPending() is false from now on).
      copiedFrom = null;
      if (loadedDoc === null) {
        // A corrupt text from the old storage (or a document migrate() called
        // invalid). The kv port's copies (spec §3.10):
        // `maranki.state.corrupt.{stamp}` in the kv file AND
        // backups/corrupt-{stamp}.json. One good copy is enough.
        await kvCopies.preserveCorrupt(raw);
        return;
      }
      // The unusable document came from the ROWS. The seed save will REPLACE
      // every row (see the file comment), the revlog too. The revlog is the
      // whole study history and it is NOT in the document (nor in `raw`, the
      // controller's text of the parsed document). So the copy is made from
      // the disk itself: every stored text byte for byte (also a row that
      // was not valid JSON) plus the revlog rows. A read that fails here
      // rejects: the controller then blocks writes, and nothing is replaced.
      const copy = await enqueue(async () => rawDump(await getDb(), true));
      await kvCopies.preserveCorrupt(copy);
      // Set only after the copy worked: without a copy, nothing is ever written.
      replaceNext = true;
    },

    firstCopyPending() {
      return writeAll && copiedFrom !== null;
    },

    highestRevlogSeq() {
      return revlogTop;
    },

    async readRaw() {
      // A rescue path: it must never reject.
      let db: RowDb;
      try {
        db = await getDb();
      } catch {
        // We cannot know whether the rows hold data, so do not offer an
        // OLDER copy as if it were the user's current data.
        return null;
      }
      try {
        if (await db.hasRows()) return await rawDump(db);
      } catch {
        return null;
      }
      return readLegacyRaw(legacy);
    },
  };
}
