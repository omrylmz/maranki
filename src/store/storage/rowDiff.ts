/**
 * The row diff (spec §3.8, unit W3-3) — PURE: what one save writes to the
 * row store, and how the stored rows become a document again.
 *
 * WHY: the wave-2 kv-store writes the WHOLE library as one JSON text on every
 * save (2.9 MB for German_Complete). The row store keeps one row per deck,
 * card type, note, card, list and session, plus a few `meta` rows for the
 * rest of the state. A save writes only the rows that CHANGED. A rating
 * writes about 4 rows: 1 card, 1 revlog row, `meta.person`, `meta.reviewLog`
 * (+ `meta.inProgressSession`).
 *
 * HOW it finds the changes: by object IDENTITY. The reducer never changes an
 * object in place; it makes a new object for every change (and the DEV
 * freeze, devFreeze.ts, throws when code tries). So a card that is the same
 * object in `prev` and `next` did not change, and is not written:
 *
 *   diffState(prev, next)
 *     prev.cards: [c1, c2, c3]          next.cards: [c1, c2', c4]
 *     → cards: upsert c2' (changed) and c4 (new), delete c3 (gone)
 *
 * The layout:
 *   state key      table        row key
 *   decks          decks        deck.id
 *   noteTypes      note_types   noteType.id
 *   notes          notes        note.id
 *   cards          cards        card.id
 *   lists          lists        list.id
 *   sessions       sessions     session.id (+ the day_key column)
 *   every other    meta         the state key ("person", "settings", …)
 *   reviewLog      meta + revlog rows for its new ratings (revlogStore.ts)
 *
 * ORDER: the rows of a table load in the order they were first written
 * (SQLite rowid order; an update keeps a row's place). The reducer appends
 * new rows at the end, so the stored order stays the state's order. When a
 * command puts a row in the MIDDLE (undo of a delete puts the cards back
 * where they were), the diff rewrites the table from that place on: those
 * rows are deleted and written again, in order. So a reload always gives the
 * lists in exactly the state's order (roundtrip tests compare deep-equal).
 *
 * THE REVIEW HISTORY (revlog): the reviewLog keeps the last 400 ratings for
 * undo. Each NEW entry (a seq that `prev` does not have, or a new object
 * with an old seq after undo + rate) becomes one revlog row. An entry that
 * left the TAIL (undo) deletes its row. An entry that left the HEAD (the 400
 * cap) keeps its row: that is the history.
 *
 * Records keyed by user data (field names, tags) may have no prototype and
 * a "__proto__" key (W2 hardening). This file never spreads such a record:
 * rows are written with JSON.stringify (which keeps such keys) and the
 * document is built with Object.defineProperty (see `setOwn`).
 */
import { fnv1a } from '../../domain/hash';
import type { RevlogRow } from '../../domain/model';
import { REVIEW_LOG_CAP } from '../reducer';
import { isRevlogSeq, type RevlogAfter, revlogRowOf } from './revlogStore';

/* --------------------------------------------------------------- layout */

/** The row tables (everything but `meta` and `revlog`). */
export type RowTable = 'decks' | 'note_types' | 'notes' | 'cards' | 'lists' | 'sessions';

/** Each row table and the state key it holds, in load order. */
export const ROW_TABLES: readonly { table: RowTable; key: string }[] = [
  { table: 'decks', key: 'decks' },
  { table: 'note_types', key: 'noteTypes' },
  { table: 'notes', key: 'notes' },
  { table: 'cards', key: 'cards' },
  { table: 'lists', key: 'lists' },
  { table: 'sessions', key: 'sessions' },
];

/** The state keys that live in row tables (not in `meta`). */
const TABLE_KEYS: ReadonlySet<string> = new Set(ROW_TABLES.map((t) => t.key));

/**
 * The row store's OWN meta keys: they describe the storage, not the state
 * (spec §3.8). They are never part of the document that load() gives.
 *   - copiedFrom  — where the first copy came from (kv, AsyncStorage, rescue);
 *   - bootOkCount — how many boots worked (the old copies are deleted only in
 *                   the release after bootOkCount ≥ 3 has shipped, spec §3.10).
 */
export const STORE_META_KEYS = ['copiedFrom', 'bootOkCount'] as const;
export type StoreMetaKey = (typeof STORE_META_KEYS)[number];
const STORE_KEYS: ReadonlySet<string> = new Set(STORE_META_KEYS);

/** True when `key` is a state key that lives in `meta`. */
export function isMetaKey(key: string): boolean {
  return !TABLE_KEYS.has(key) && !STORE_KEYS.has(key);
}

/* ----------------------------------------------------------------- diff */

/** One row to write: its key, its JSON text, and (sessions only) its day. */
export interface RowWrite {
  key: string;
  json: string;
  /** The `day_key` column of `sessions`; null in the other tables. */
  dayKey: string | null;
}

/** The changes of one table. The writer runs the deletes BEFORE the upserts. */
export interface TableDiff {
  deletes: string[];
  upserts: RowWrite[];
}

/** One `meta` row to write. */
export interface MetaWrite {
  key: string;
  json: string;
}

/** Everything one save writes, in one transaction (rowStore.ts). */
export interface RowDiff {
  tables: Record<RowTable, TableDiff>;
  metaSet: MetaWrite[];
  metaDelete: string[];
  /** Revlog rows to delete (ratings that were undone). */
  revlogDelete: number[];
  /** Revlog rows to write OVER a stored row with the same seq (new ratings). */
  revlogPut: RevlogRow[];
  /** Revlog rows to write only when no row has that seq yet (a "write everything" save). */
  revlogAdd: RevlogRow[];
}

/** A diff that writes nothing. */
export function emptyDiff(): RowDiff {
  return {
    tables: {
      decks: { deletes: [], upserts: [] },
      note_types: { deletes: [], upserts: [] },
      notes: { deletes: [], upserts: [] },
      cards: { deletes: [], upserts: [] },
      lists: { deletes: [], upserts: [] },
      sessions: { deletes: [], upserts: [] },
    },
    metaSet: [],
    metaDelete: [],
    revlogDelete: [],
    revlogPut: [],
    revlogAdd: [],
  };
}

/** How many rows a diff writes or deletes (0 = nothing to do). */
export function diffSize(diff: RowDiff): number {
  let n = diff.metaSet.length + diff.metaDelete.length;
  n += diff.revlogDelete.length + diff.revlogPut.length + diff.revlogAdd.length;
  for (const { table } of ROW_TABLES) n += diff.tables[table].deletes.length + diff.tables[table].upserts.length;
  return n;
}

/** True when the diff writes nothing. */
export function isEmptyDiff(diff: RowDiff): boolean {
  return diffSize(diff) === 0;
}

/**
 * The loaded rows that the app's decode LEFT OUT of the state (spec §3.5:
 * the integrity check sets aside a card without its note, …). The row store
 * never deletes them: they stay on the disk. `setAsideRows` finds them.
 */
export interface SetAside {
  /** The row keys of each table. */
  tables: Record<RowTable, ReadonlySet<string>>;
  /** The review-log seqs (their revlog rows stay). */
  seqs: ReadonlySet<number>;
}

export interface DiffOptions {
  /**
   * Never delete a row of a table (or of the revlog) only because `next`
   * does not have it, and never write over a stored revlog row. The SAFE
   * fallback for the first save after a load whose document `migrate()`
   * changed, when the port cannot know which rows the decode left out (see
   * `setAside`): then it keeps every loaded row. Meta keys that `next` lost
   * ARE deleted (they are state, not rows).
   */
  keepRows?: boolean;
  /**
   * The first save after a load whose document the decode CHANGED, when the
   * port knows what the decode left out. `prev` is then the document AS
   * LOADED (not a state the app made):
   *   - a row (or revlog seq) in `setAside` is never deleted: the decode
   *     left it out, and the row store never deletes such a row (spec §3.5);
   *   - every OTHER row that `next` does not have is deleted as usual: the
   *     user deleted it (a deck delete, an undo …) before this first save;
   *   - the decode may give a review-log entry a new object, so an entry of
   *     `prev` and one of `next` are the SAME rating when seq, card, time and
   *     rating match (`sameRating`). Such an entry never writes over its
   *     stored revlog row; only a NEW rating with an old seq (after an
   *     undo) does.
   * Example: loaded cards [c1, c2, c9], c9 set aside, the user deleted c2:
   *   diffState(loaded, next, { setAside }) → cards: delete c2 (c9 stays).
   */
  setAside?: SetAside;
  /**
   * The review-log cap (the reducer's REVIEW_LOG_CAP, 400): how long the log
   * can be before a new rating drops its oldest entry. It decides whether a
   * missing entry can have left the HEAD (see diffRevlog). Only tests that
   * play a smaller cap pass it.
   */
  reviewLogCap?: number;
}

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null;

/** The list under `key`, or [] when the state has no list there. */
function listOf(state: Obj | null, key: string): readonly unknown[] {
  const value = state?.[key];
  return Array.isArray(value) ? value : [];
}

/**
 * The row key of every entry of a table list, in order. null = the entry is
 * not an object (it cannot be a row; JSON would make it `null`, and the
 * integrity check drops such entries on load).
 *   - an object with a string (or finite number) `id` → that id;
 *   - an object without a usable id → `~noid-<hash of its JSON>` (never
 *     expected: migrate() gives every row an id, but the data is never lost);
 *   - the second entry with the same key → `<key>#2` (then #3 …), a key no
 *     other entry has. So two entries with one id are both kept.
 */
export function rowKeys(rows: readonly unknown[]): (string | null)[] {
  const base = rows.map((row): string | null => {
    if (!isObject(row)) return null;
    const id = row.id;
    if (typeof id === 'string' && id !== '') return id;
    if (typeof id === 'number' && Number.isFinite(id)) return String(id);
    return `~noid-${fnv1a(JSON.stringify(row) ?? '')}`;
  });
  const taken = new Set<string>();
  for (const key of base) if (key !== null) taken.add(key);
  const given = new Set<string>();
  return base.map((key) => {
    if (key === null) return null;
    if (!given.has(key)) {
      given.add(key);
      return key;
    }
    let n = 2;
    while (taken.has(`${key}#${n}`) || given.has(`${key}#${n}`)) n += 1;
    const extra = `${key}#${n}`;
    given.add(extra);
    return extra;
  });
}

/**
 * The row keys of a list, computed once per list OBJECT. The state's lists
 * never change in place, so the keys of a list stay right. A save after a
 * rating then reuses the keys of the last save (see `replacedInPlace`).
 */
const keysCache = new WeakMap<readonly unknown[], (string | null)[]>();

function keysOf(rows: readonly unknown[]): (string | null)[] {
  let keys = keysCache.get(rows);
  if (!keys) {
    keys = rowKeys(rows);
    keysCache.set(rows, keys);
  }
  return keys;
}

/** True when `row` has an id that is its own key (not a hash or a missing id). */
function hasPlainId(row: unknown): row is Obj {
  if (!isObject(row)) return false;
  const id = row.id;
  return (typeof id === 'string' && id !== '') || (typeof id === 'number' && Number.isFinite(id));
}

/**
 * The positions where `next` has a different object than `prev`, when
 * `next` is `prev` with some rows REPLACED in place: the same length, and
 * every replaced row keeps its id at its position (a rating, a flag, an
 * edit). Then nothing moved, nothing was added or removed, and `next` has
 * exactly the row keys of `prev`. Else null (the full comparison runs).
 * This keeps a rating's save fast on 16k cards: no maps, one pass.
 */
function replacedInPlace(prev: readonly unknown[], next: readonly unknown[]): number[] | null {
  if (prev.length !== next.length) return null;
  const changed: number[] = [];
  for (let i = 0; i < next.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (a === b) continue;
    if (!hasPlainId(a) || !hasPlainId(b) || a.id !== b.id) return null;
    changed.push(i);
  }
  return changed;
}

/** The JSON text of a row. Throws when JSON.stringify cannot write it (a cycle, a BigInt). */
function jsonOf(value: unknown): string {
  const json = JSON.stringify(value);
  if (typeof json !== 'string') throw new Error('rowDiff: a value cannot be written as JSON');
  return json;
}

function rowWrite(table: RowTable, key: string, row: Obj): RowWrite {
  return { key, json: jsonOf(row), dayKey: table === 'sessions' ? String(row.dayKey ?? '') : null };
}

/**
 * Which rows that `next` does not have are KEPT on the disk: 'all' (the
 * keepRows mode), the keys in a set (the setAside mode), or none (null).
 */
type Keep = 'all' | ReadonlySet<string> | null;

/**
 * The changes of one table from `prevRows` to `nextRows` (see the file
 * comment for the order rule). `prevRows` null = write every row of `next`.
 */
function diffTable(
  table: RowTable,
  prevRows: readonly unknown[] | null,
  nextRows: readonly unknown[],
  keep: Keep,
  out: TableDiff,
): void {
  if (prevRows === nextRows) return;
  if (prevRows === null) {
    const keys = keysOf(nextRows);
    nextRows.forEach((row, i) => {
      const key = keys[i];
      if (key !== null && isObject(row)) out.upserts.push(rowWrite(table, key, row));
    });
    return;
  }

  // The common case: rows replaced in place (same ids at the same places).
  const inPlace = replacedInPlace(prevRows, nextRows);
  if (inPlace) {
    const keys = keysOf(prevRows);
    keysCache.set(nextRows, keys);
    for (const i of inPlace) {
      const key = keys[i];
      const row = nextRows[i];
      if (key !== null && isObject(row)) out.upserts.push(rowWrite(table, key, row));
    }
    return;
  }

  const nextKeys = keysOf(nextRows);
  const prevKeys = keysOf(prevRows);
  const before = new Map<string, { row: unknown; index: number }>();
  prevRows.forEach((row, index) => {
    const key = prevKeys[index];
    if (key !== null) before.set(key, { row, index });
  });

  // Where the stored order would stop matching `next`: the first new row
  // that has an old row after it, or the first old row that moved up.
  let rewriteFrom = nextRows.length;
  let firstNew = -1;
  let lastIndex = -1;
  for (let i = 0; i < nextRows.length; i++) {
    const key = nextKeys[i];
    if (key === null) continue;
    const old = before.get(key);
    if (!old) {
      if (firstNew < 0) firstNew = i;
      continue;
    }
    if (firstNew >= 0 || old.index < lastIndex) {
      rewriteFrom = firstNew >= 0 ? firstNew : i;
      break;
    }
    lastIndex = old.index;
  }

  const inNext = new Set<string>();
  for (let i = 0; i < nextRows.length; i++) {
    const key = nextKeys[i];
    const row = nextRows[i];
    if (key === null || !isObject(row)) continue;
    inNext.add(key);
    const old = before.get(key);
    if (i >= rewriteFrom) {
      // Written again at the end, in order: delete the old row first.
      if (old) out.deletes.push(key);
      out.upserts.push(rowWrite(table, key, row));
    } else if (!old || old.row !== row) {
      out.upserts.push(rowWrite(table, key, row));
    }
  }
  if (keep === 'all') return;
  for (const key of before.keys()) if (!inNext.has(key) && !keep?.has(key)) out.deletes.push(key);
}

/**
 * The meta changes: every state key outside the row tables. A key whose
 * value is `undefined` (or that `next` does not have) is deleted, the same
 * as JSON.stringify drops it from a whole document.
 */
function diffMeta(prev: Obj | null, next: Obj, out: RowDiff): void {
  const keys = new Set<string>(Object.keys(next));
  if (prev) for (const key of Object.keys(prev)) keys.add(key);
  for (const key of keys) {
    if (!isMetaKey(key)) continue;
    const value = next[key];
    if (prev && Object.prototype.hasOwnProperty.call(prev, key) && prev[key] === value) continue;
    if (value === undefined) {
      if (prev === null || prev[key] !== undefined) out.metaDelete.push(key);
      continue;
    }
    out.metaSet.push({ key, json: jsonOf(value) });
  }
}

/** The review-log entries that can have a revlog row, by seq (the last one wins when a seq repeats). */
function entriesBySeq(log: readonly unknown[]): Map<number, unknown> {
  const map = new Map<number, unknown>();
  for (const entry of log) if (isObject(entry) && isRevlogSeq(entry.seq)) map.set(entry.seq, entry);
  return map;
}

/**
 * The card values AFTER each rating of `log` (index → values): the `prev` of
 * the same card's next rating in the log, or else the card in `cards`
 * (looked up only when needed), or null when the card is gone.
 */
function afterValues(log: readonly unknown[], cards: readonly unknown[]): (index: number) => RevlogAfter | null {
  const laterPrev = new Map<number, RevlogAfter>();
  const seen = new Map<string, RevlogAfter>();
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (!isObject(entry) || typeof entry.cardId !== 'string') continue;
    const later = seen.get(entry.cardId);
    if (later) laterPrev.set(i, later);
    const prev = isObject(entry.prev) ? entry.prev : null;
    seen.set(entry.cardId, { intervalDays: prev?.intervalDays, ease: prev?.ease });
  }
  // A rating's save needs ONE card: a plain search is faster than a map of
  // 16k cards. A save that writes many history rows builds the map once.
  let byId: Map<string, Obj> | null = null;
  let searches = 0;
  const findCard = (id: string): Obj | undefined => {
    if (!byId && searches < 4) {
      searches += 1;
      for (const card of cards) if (isObject(card) && card.id === id) return card;
      return undefined;
    }
    if (!byId) {
      byId = new Map();
      for (const card of cards) if (isObject(card) && typeof card.id === 'string') byId.set(card.id, card);
    }
    return byId.get(id);
  };
  return (index) => {
    const later = laterPrev.get(index);
    if (later) return later;
    const entry = log[index];
    if (!isObject(entry) || typeof entry.cardId !== 'string') return null;
    const card = findCard(entry.cardId);
    return card ? { intervalDays: card.intervalDays, ease: card.ease } : null;
  };
}

/**
 * True when two review-log entries are the SAME rating: the same object, or
 * (the decode made a new object for a loaded entry) the same seq, card, time
 * and rating. A new rating that took the seq of an undone one has another
 * time, so it is not the same rating.
 */
export function sameRating(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return isObject(a) && isObject(b) && a.seq === b.seq && a.cardId === b.cardId && a.atMs === b.atMs && a.rating === b.rating;
}

/**
 * The revlog changes from prev.reviewLog to next.reviewLog (see the file
 * comment). `keepAll` = the keepRows mode; `setAside` = the setAside mode
 * (see DiffOptions); `cap` = the review-log cap.
 */
function diffRevlog(
  prev: Obj | null,
  next: Obj,
  keepAll: boolean,
  setAside: SetAside | null,
  cap: number,
  out: RowDiff,
): void {
  const nextLog = listOf(next, 'reviewLog');
  const prevLog = prev ? listOf(prev, 'reviewLog') : null;
  if (prevLog === nextLog) return;
  const after = afterValues(nextLog, listOf(next, 'cards'));
  const before = prevLog ? entriesBySeq(prevLog) : null;
  const nextBySeq = entriesBySeq(nextLog);
  const nextSeqs = new Set<number>(nextBySeq.keys());
  // `prev` is a state the app made → its entries ARE the objects of `next`.
  // `prev` is the loaded document (setAside) → compare the ratings.
  const same = setAside ? sameRating : (a: unknown, b: unknown) => a === b;
  let maxNext = -Infinity;
  /** The ratings of `next` that `prev` does not have (made since the last save). */
  let newRatings = 0;

  nextLog.forEach((entry, index) => {
    if (!isObject(entry) || !isRevlogSeq(entry.seq)) return;
    if (entry.seq > maxNext) maxNext = entry.seq;
    const old = before?.get(entry.seq);
    if (old === entry) return; // already stored
    if (old === undefined || !same(old, entry)) newRatings += 1;
    const row = revlogRowOf(entry, after(index));
    if (!row) return;
    // Write over a stored row only for a NEW rating. A "write everything"
    // save, the keepRows mode and a loaded rating in a new object (setAside
    // mode) only add a row where the seq has none.
    const stored = !before || keepAll || (old !== undefined && same(old, entry));
    if (stored) out.revlogAdd.push(row);
    else out.revlogPut.push(row);
  });

  if (!prevLog || !before || keepAll) return;
  // Which missing entries were UNDONE (delete their rows) and which fell off
  // the HEAD because of the 400 cap (keep their rows: that is the history)?
  // Undo pops from the END of the log, the cap drops from the START, and new
  // ratings are added after. So the entries of `prev` that are still in
  // `next` (the same rating) are one block in the middle: a missing entry
  // AFTER that block was undone, one BEFORE it was dropped by the cap.
  let lastKept = -1;
  let maxPrev = -Infinity;
  prevLog.forEach((entry, index) => {
    if (!isObject(entry) || !isRevlogSeq(entry.seq)) return;
    if (entry.seq > maxPrev) maxPrev = entry.seq;
    if (same(nextBySeq.get(entry.seq), entry)) lastKept = index;
  });
  // When NO entry of `prev` is left, there is no block. Then a head drop is
  // possible only when the log can have grown past the cap since the last
  // save: `prev`'s entries plus the ratings made since. Each rating gets a
  // seq above every seq of `prev` (the engine's minSeq), so `maxNext −
  // maxPrev` counts at least every rating made up to the newest one, also
  // the ones undone again. When even that cannot reach the cap, nothing left
  // the head: every missing entry was UNDONE, also when a new rating came
  // after the undo (a new learner: rate, Undo, rate again within one save).
  // Else the old rule decides, and keeps a row when unsure (it is history):
  // a missing seq above every seq of `next` was undone (an undo of
  // everything leaves `next` empty).
  const grown = prevLog.length + Math.max(newRatings, maxNext - maxPrev);
  const noHeadDrop = grown <= cap;
  prevLog.forEach((entry, index) => {
    if (!isObject(entry) || !isRevlogSeq(entry.seq) || nextSeqs.has(entry.seq)) return;
    // The decode left this entry out: its row stays (spec §3.5).
    if (setAside?.seqs.has(entry.seq)) return;
    const undone = lastKept >= 0 ? index > lastKept : noHeadDrop || entry.seq > maxNext;
    if (undone) out.revlogDelete.push(entry.seq);
  });
}

/**
 * Everything that changed from `prev` (the state the disk holds) to `next`.
 * `prev` null = the disk holds nothing usable: write every row of `next`
 * (and add its revlog rows only where the table has none yet).
 *
 * Both states are read as plain objects, so this works for any state shape:
 * a key that is not a list under a table name counts as an empty table.
 *
 * Throws when a value cannot be written as JSON (the save then rejects, and
 * the persist controller reports 'write', M15).
 */
export function diffState(prev: object | null, next: object, options: DiffOptions = {}): RowDiff {
  const p = prev as Obj | null;
  const n = next as Obj;
  const keepAll = options.keepRows === true;
  const setAside = keepAll ? null : (options.setAside ?? null);
  const out = emptyDiff();
  if (p === n) return out;
  for (const { table, key } of ROW_TABLES) {
    const keep: Keep = keepAll ? 'all' : (setAside?.tables[table] ?? null);
    diffTable(table, p ? listOf(p, key) : null, listOf(n, key), keep, out.tables[table]);
  }
  diffMeta(p, n, out);
  diffRevlog(p, n, keepAll, setAside, options.reviewLogCap ?? REVIEW_LOG_CAP, out);
  return out;
}

/**
 * The rows of the LOADED document that the decoded state does not have
 * (by row key per table, and by review-log seq): the rows the decode set
 * aside (spec §3.5). Pure.
 *
 *   setAsideRows({ cards: [c1, c9], … }, { cards: [c1], … })
 *   // → { tables: { cards: Set{'c9'}, decks: Set{}, … }, seqs: Set{} }
 */
export function setAsideRows(loaded: object, decoded: object): SetAside {
  const l = loaded as Obj;
  const d = decoded as Obj;
  const tables = {} as Record<RowTable, ReadonlySet<string>>;
  for (const { table, key } of ROW_TABLES) {
    const kept = new Set(keysOf(listOf(d, key)));
    const left = new Set<string>();
    for (const k of keysOf(listOf(l, key))) if (k !== null && !kept.has(k)) left.add(k);
    tables[table] = left;
  }
  const keptSeqs = entriesBySeq(listOf(d, 'reviewLog'));
  const seqs = new Set<number>();
  for (const seq of entriesBySeq(listOf(l, 'reviewLog')).keys()) if (!keptSeqs.has(seq)) seqs.add(seq);
  return { tables, seqs };
}

/** The store's own meta rows (copiedFrom, bootOkCount) added to a diff. */
export function withStoreMeta(diff: RowDiff, values: Partial<Record<StoreMetaKey, unknown>>): RowDiff {
  const extra: MetaWrite[] = [];
  for (const key of STORE_META_KEYS) {
    const value = values[key];
    if (value !== undefined && value !== null) extra.push({ key, json: jsonOf(value) });
  }
  return extra.length === 0 ? diff : { ...diff, metaSet: [...diff.metaSet, ...extra] };
}

/* ----------------------------------------------------------------- load */

/** Set an own key on `obj`, also a key like "__proto__" (a plain `obj[key] = v` would change the prototype). */
function setOwn(obj: Obj, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * The document from stored rows: every meta value under its key (not the
 * store's own keys), and every table as a list under its state key. This is
 * what load() gives to migrate(), the same as the kv port gives the parsed
 * whole document. Every table key is there, as a list (empty when the table
 * has no rows).
 *
 *   assembleDoc(new Map([['schemaVersion', 3], ['person', {...}]]), { cards: [c1], … })
 *   // → { schemaVersion: 3, person: {...}, decks: [], noteTypes: [], notes: [], cards: [c1], lists: [], sessions: [] }
 */
export function assembleDoc(
  meta: ReadonlyMap<string, unknown>,
  tables: Readonly<Record<RowTable, readonly unknown[]>>,
): Record<string, unknown> {
  const doc: Obj = {};
  for (const [key, value] of meta) if (isMetaKey(key)) setOwn(doc, key, value);
  for (const { table, key } of ROW_TABLES) setOwn(doc, key, [...tables[table]]);
  return doc;
}
