/**
 * The review history (spec §3.8, unit W3-3): the `revlog` table of the row
 * store `maranki-rows.db`.
 *
 * WHY a second log: `reviewLog` in the state is the UNDO window of a study
 * session. It is kept in memory and capped at 400 entries. The revlog is the
 * whole history: one row per rating, never capped, and NOT in memory. It is
 * read only when a screen asks for it (the history CSV, the CardSheet
 * "History" line, a backup).
 *
 *   reviewLog (state, ≤ 400)          revlog (table, uncapped)
 *   ──────────────────────────        ───────────────────────────────
 *   seq 601 … 1000                    seq 1 … 1000
 *   a rating appends an entry   ───▶  the save inserts its row
 *   undo pops the last entry    ───▶  the save deletes that row
 *   the cap drops the oldest    ───▶  nothing: the row stays (history)
 *
 * This file holds the table's parts that need no database:
 *   - the columns and the SQL text (rowStore.ts runs it);
 *   - `revlogRowOf`: one RevlogRow from one ReviewLogEntry (rowDiff.ts calls
 *     it when a save finds a new rating);
 *   - `cleanRevlogRow`: a row from a backup file, checked before it is written;
 *   - `createRevlogStore`: the small read/write API that history.ts and the
 *     Restore flow use.
 *
 * Column mapping (SQL → RevlogRow): seq → seq, card_id → cardId,
 * deck_id → deckId, at_ms → atMs, rating → rating, bucket → bucket,
 * ivl_before → ivlBefore, ivl_after → ivlAfter, ease_after → easeAfter,
 * duration_ms → durationMs.
 *
 * Every number column is NOT NULL in SQL (except duration_ms). A NaN would be
 * written as NULL and the whole save transaction would fail, again and again.
 * So every number here is checked: a value that is not a finite number
 * becomes 0 (duration: null).
 */
import type { Rating, ReviewBucket, RevlogRow } from '../../domain/model';
import type { RowDb } from './rowStore';

/** The revlog columns, in table order. */
export const REVLOG_COLUMNS = [
  'seq',
  'card_id',
  'deck_id',
  'at_ms',
  'rating',
  'bucket',
  'ivl_before',
  'ivl_after',
  'ease_after',
  'duration_ms',
] as const;

/**
 * How many rows one INSERT statement carries: 90 rows × 10 columns = 900
 * bound values, under SQLite's oldest limit of 999 values per statement.
 */
export const REVLOG_ROWS_PER_INSERT = 90;

/** How many seq values one DELETE statement carries. */
export const REVLOG_SEQS_PER_DELETE = 900;

/**
 * What to do when a row with the same `seq` is already stored:
 *   - replace — write over it. For a rating that is certainly new (or that
 *               replaced an undone rating with the same seq);
 *   - ignore  — keep the stored row. For a "write everything" save, where
 *               the row may be stored already with its original values.
 */
export type RevlogInsertMode = 'replace' | 'ignore';

/** `?, ?, ?` with `n` question marks. */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

const COLUMN_LIST = REVLOG_COLUMNS.join(', ');
const ONE_ROW = `(${placeholders(REVLOG_COLUMNS.length)})`;

/** The SQL text of the revlog table (rowStore.ts runs it; the tests read it). */
export const revlogSql = {
  /** One INSERT of `rows` rows. */
  insert: (rows: number, mode: RevlogInsertMode): string =>
    `INSERT OR ${mode === 'replace' ? 'REPLACE' : 'IGNORE'} INTO revlog (${COLUMN_LIST}) VALUES ${Array.from(
      { length: rows },
      () => ONE_ROW,
    ).join(', ')}`,
  /** Delete `n` rows by seq. */
  delete: (n: number): string => `DELETE FROM revlog WHERE seq IN (${placeholders(n)})`,
  /** Delete every row (a replace-all write). */
  clear: 'DELETE FROM revlog',
  /** Every row, oldest first. */
  selectAll: `SELECT ${COLUMN_LIST} FROM revlog ORDER BY seq`,
  /** The rows of one card, oldest first. */
  selectCard: `SELECT ${COLUMN_LIST} FROM revlog WHERE card_id = ? ORDER BY seq`,
} as const;

/** One revlog row as SQL returns it (snake_case columns). */
export interface RevlogSqlRow {
  seq: number;
  card_id: string;
  deck_id: string;
  at_ms: number;
  rating: string;
  bucket: string;
  ivl_before: number;
  ivl_after: number;
  ease_after: number;
  duration_ms: number | null;
}

/** The bound values of one row, in REVLOG_COLUMNS order. */
export function revlogParams(row: RevlogRow): (string | number | null)[] {
  return [
    row.seq,
    row.cardId,
    row.deckId,
    row.atMs,
    row.rating,
    row.bucket,
    row.ivlBefore,
    row.ivlAfter,
    row.easeAfter,
    row.durationMs,
  ];
}

/** A RevlogRow from one SQL result row. */
export function revlogFromSql(r: RevlogSqlRow): RevlogRow {
  return {
    seq: Number(r.seq),
    cardId: String(r.card_id),
    deckId: String(r.deck_id),
    atMs: Number(r.at_ms),
    rating: r.rating as Rating,
    bucket: r.bucket as ReviewBucket,
    ivlBefore: Number(r.ivl_before),
    ivlAfter: Number(r.ivl_after),
    easeAfter: Number(r.ease_after),
    durationMs: r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
  };
}

/* --------------------------------------------------------------- checks */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** A finite number, or `fallback`. */
function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** True for a seq the table can use as its key: a whole number ≥ 0 (seq starts at 1). */
export function isRevlogSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** A duration in ms, or null when it is missing or not a usable number. */
function duration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The values a rating left on the card: its interval and ease AFTER the
 * rating. rowDiff.ts finds them (see `revlogRowOf`).
 */
export interface RevlogAfter {
  intervalDays: unknown;
  ease: unknown;
}

/**
 * One revlog row from one review-log entry, or null when the entry cannot
 * have a row (no usable `seq`, or not an object at all).
 *
 * The entry keeps the card's values BEFORE the rating (`prev`). The values
 * AFTER it come from `after`: the `prev` of the card's next rating in the
 * log, or the card itself when this was its last rating (rowDiff.ts decides).
 * When `after` is null (the card is gone), the row says "unchanged".
 *
 * Example:
 *   revlogRowOf({ seq: 7, cardId: 'c1', deckId: 'd1', rating: 'good', atMs: 1000,
 *                 bucket: 'review', prev: { intervalDays: 3, ease: 2.5, … } },
 *               { intervalDays: 8, ease: 2.5 })
 *   // → { seq: 7, cardId: 'c1', …, ivlBefore: 3, ivlAfter: 8, easeAfter: 2.5, durationMs: null }
 */
export function revlogRowOf(entry: unknown, after: RevlogAfter | null): RevlogRow | null {
  if (!isObject(entry) || !isRevlogSeq(entry.seq)) return null;
  const prev = isObject(entry.prev) ? entry.prev : {};
  const ivlBefore = num(prev.intervalDays, 0);
  const easeBefore = num(prev.ease, 0);
  return {
    seq: entry.seq,
    cardId: String(entry.cardId ?? ''),
    deckId: String(entry.deckId ?? ''),
    atMs: num(entry.atMs, 0),
    rating: String(entry.rating ?? '') as Rating,
    bucket: (typeof entry.bucket === 'string' ? entry.bucket : entry.wasNew === true ? 'new' : 'review') as ReviewBucket,
    ivlBefore,
    ivlAfter: after ? num(after.intervalDays, ivlBefore) : ivlBefore,
    easeAfter: after ? num(after.ease, easeBefore) : easeBefore,
    durationMs: duration(entry.durationMs),
  };
}

/**
 * A history row from outside (a backup file), made safe to write, or null
 * when it cannot be a row (no usable seq or card id). Unknown keys are
 * dropped; numbers that are not finite become 0 (duration: null).
 */
export function cleanRevlogRow(value: unknown): RevlogRow | null {
  if (!isObject(value) || !isRevlogSeq(value.seq)) return null;
  if (typeof value.cardId !== 'string' || value.cardId === '') return null;
  return {
    seq: value.seq,
    cardId: value.cardId,
    deckId: typeof value.deckId === 'string' ? value.deckId : '',
    atMs: num(value.atMs, 0),
    rating: String(value.rating ?? '') as Rating,
    bucket: String(value.bucket ?? 'review') as ReviewBucket,
    ivlBefore: num(value.ivlBefore, 0),
    ivlAfter: num(value.ivlAfter, 0),
    easeAfter: num(value.easeAfter, 0),
    durationMs: duration(value.durationMs),
  };
}

/* ---------------------------------------------------------------- store */

/**
 * The review history as the app reads and writes it. Reads see every
 * COMMITTED save: a rating appears here after its save transaction (the
 * engine saves 400 ms after a change; `actions.flush()` saves at once).
 */
export interface RevlogStore {
  /** The history rows of one card, oldest first (CardSheet "History"). */
  forCard(cardId: string): Promise<RevlogRow[]>;
  /** Every history row, oldest first (the history CSV, a backup). */
  all(): Promise<RevlogRow[]>;
  /**
   * Write history rows (tools and tests), in one transaction. A row with the
   * same seq is replaced. Rows that cannot be written (see cleanRevlogRow)
   * are left out. Resolves the number of rows written.
   *
   * NOT for a restore (final review): a restore's history must be written
   * in the replace-all's OWN transaction — `actions.restore(state, history)`
   * (StoragePort.replaceAll). A second write after the replace-all leaves the
   * table empty when the app is killed in between, or when the replace-all
   * fails and a later save finishes it without these rows.
   */
  write(rows: readonly unknown[]): Promise<number>;
}

/** Run `task` after every write queued before it (the row store's one write queue). */
export type WriteQueue = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * The revlog store of one row database. `open` gives the database (opened
 * once, by the row port); `enqueue` is the row port's write queue, so a
 * history write never runs at the same time as a save (two write
 * transactions at once would fail with "database is locked").
 */
export function createRevlogStore(open: () => Promise<RowDb>, enqueue: WriteQueue): RevlogStore {
  return {
    async forCard(cardId) {
      return (await open()).readRevlog(cardId);
    },
    async all() {
      return (await open()).readRevlog();
    },
    write(rows) {
      const clean: RevlogRow[] = [];
      for (const row of rows) {
        const ok = cleanRevlogRow(row);
        if (ok) clean.push(ok);
      }
      if (clean.length === 0) return Promise.resolve(0);
      return enqueue(async () => {
        await (await open()).writeRevlog(clean);
        return clean.length;
      });
    },
  };
}

/**
 * The revlog store of the web preview: nothing is saved there (decision D6),
 * so there is never any history. Reads resolve [], a write writes nothing.
 */
export const EMPTY_REVLOG_STORE: RevlogStore = {
  forCard: async () => [],
  all: async () => [],
  write: async () => 0,
};
