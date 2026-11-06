/**
 * Tests for the row store's save side (spec §3.8, unit W3-3):
 *   - rowDiff.ts (pure): what a save writes — a rating, an undo, the 400
 *     cap, a deck delete, a completed session (M5), no change, the order
 *     rule, a first "write everything" save, the keepRows mode, the
 *     setAside mode (only the rows the decode left out are kept), row keys;
 *   - a seeded property test: 40 random v3 libraries × 12 random edits, each
 *     saved as a diff into a memory RowDb, load back EXACTLY the state (same
 *     rows, same order) and the expected review history;
 *   - the row port (rowStore.ts) over a memory RowDb: one transaction per
 *     save, a failed save changes nothing and the persist controller sends
 *     the full difference again (its `lastSaved` stays), replaceAll, one
 *     write queue, bootOkCount (with the first commit and with
 *     markBootOk), the revlog store; after a load that the decode CHANGED,
 *     a delete or an undo before the first commit still reaches the disk
 *     (review round 1), while a card the decode set aside stays;
 *   - the real SQL layer (`sqliteRowDb`) on a small fake SQLite that runs
 *     exactly the row store's statements: schema and user_version, one
 *     exclusive transaction per write with a rollback on failure, the
 *     `json_group_array` fast path and its per-row fallback.
 *
 * The real expo-sqlite has no native module under jest; E2 (big deck: time
 * to ready < 2 s, save after a rating < 20 ms) is checked on the emulator.
 */
// '@jest/globals' first: the jest.mock factory below uses its `jest`.
import { describe, expect, jest, test } from '@jest/globals';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import type { Card, DataStateV3, ReviewLogEntry, RevlogRow } from '../../domain/model';
import { fieldRecord } from '../../domain/query';
import { FIXED_NOW } from '../../test/clock';
import { makeDeckV3, makeStateV3, noteWithCards, randomStateV3, stateOfV3 } from '../../test/factoriesV3';
import { createRandom, type Random } from '../../test/random';
import { createPersistController } from '../persistController';
import { createMemoryStore } from './memoryPort';
import {
  assembleDoc,
  diffSize,
  diffState,
  emptyDiff,
  isEmptyDiff,
  ROW_TABLES,
  rowKeys,
  sameRating,
  setAsideRows,
  type RowDiff,
} from './rowDiff';
import { revlogSql } from './revlogStore';
import {
  createMemoryRowDb,
  createRowPort,
  openRowDb,
  ROW_LAYOUT_VERSION,
  ROWS_DB_NAME,
  rowSql,
  SCHEMA_SQL,
  sqliteRowDb,
  type MemoryRowDb,
  type RowDb,
  type SqlDatabase,
  type SqlRunner,
} from './rowStore';

// expo-sqlite has no native module under jest: openRowDb() gets a fake (FakeSql below).
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

/* ---------------------------------------------------------------- helpers */

const T0 = FIXED_NOW;
const NO_LEGACY = { readKv: async () => null, readAsyncStorage: async () => null };

/** A small v3 library: one deck, three Basic notes with one card each. */
function library(): DataStateV3 {
  const deck = makeDeckV3({ id: 'd1', name: 'Capitals' });
  const groups = ['France', 'Japan', 'Peru'].map((word, i) =>
    noteWithCards({ deckId: 'd1', fields: [word, `capital ${i}`, '', ''], note: { id: `n${i + 1}` }, card: { id: `c${i + 1}` } }),
  );
  return stateOfV3({ decks: [deck], groups });
}

/** A review-log entry of `card` (its values BEFORE the rating are `card`'s). */
function logEntry(seq: number, card: Card, over: Partial<ReviewLogEntry> = {}): ReviewLogEntry {
  return {
    id: `r${seq}`,
    seq,
    cardId: card.id,
    deckId: card.deckId,
    rating: 'good',
    atMs: T0 + seq * 1000,
    bucket: card.reps === 0 ? 'new' : 'review',
    prev: {
      ease: card.ease,
      intervalDays: card.intervalDays,
      stepIndex: card.stepIndex,
      reps: card.reps,
      lapses: card.lapses,
      due: card.due,
      lastReviewedAt: card.lastReviewedAt,
      knownAt: card.knownAt ?? null,
      knownCheckedAt: card.knownCheckedAt ?? null,
      newState: card.newState,
    },
    ...over,
  };
}

/**
 * A rating, as the reducer makes it: a NEW card object, a NEW person, the
 * log with one more entry. Everything else keeps its identity.
 */
function rate(state: DataStateV3, cardId: string, seq: number, after: Partial<Card> = { intervalDays: 3, reps: 1, stepIndex: null }): DataStateV3 {
  const card = state.cards.find((c) => c.id === cardId)!;
  const rated: Card = { ...card, ...after, lastReviewedAt: T0 + seq * 1000 };
  return {
    ...state,
    cards: state.cards.map((c) => (c.id === cardId ? rated : c)),
    person: { ...state.person, dayDone: { ...state.person.dayDone, reviews: state.person.dayDone.reviews + 1 } },
    reviewLog: [...state.reviewLog, logEntry(seq, card)],
  };
}

/** Undo the last rating: pop the log, put the card's old values back, a new person. */
function undo(state: DataStateV3): DataStateV3 {
  const last = state.reviewLog[state.reviewLog.length - 1];
  return {
    ...state,
    cards: state.cards.map((c) => (c.id === last.cardId ? { ...c, ...last.prev } : c)),
    person: { ...state.person },
    reviewLog: state.reviewLog.slice(0, -1),
  };
}

const keysOf = (diff: RowDiff, table: keyof RowDiff['tables']) => diff.tables[table].upserts.map((u) => u.key);
const metaKeys = (diff: RowDiff) => diff.metaSet.map((m) => m.key).sort();

/** Load the document a RowDb holds, through a row port (the real load path). */
async function loadDoc(db: RowDb): Promise<Record<string, unknown>> {
  const port = createRowPort({ open: async () => db, legacy: NO_LEGACY, kv: createMemoryStore(), now: () => T0 });
  const loaded = await port.load();
  if (loaded.kind !== 'doc') throw new Error(`expected a document, got ${loaded.kind}`);
  return loaded.value as Record<string, unknown>;
}

/** A row port over `db`, as a phone uses it (no old copies). */
function rowPort(db: RowDb) {
  return createRowPort<DataStateV3>({ open: async () => db, legacy: NO_LEGACY, kv: createMemoryStore(), now: () => T0, corruptFile: () => undefined });
}

/* ------------------------------------------------------- the pure diff */

describe('diffState — what one save writes', () => {
  test('no change → an empty diff (the same object, and a new object with the same parts)', () => {
    const s = library();
    expect(isEmptyDiff(diffState(s, s))).toBe(true);
    expect(isEmptyDiff(diffState(s, { ...s }))).toBe(true);
    expect(diffSize(emptyDiff())).toBe(0);
  });

  test('a rating → 1 card upsert + 1 revlog row + the changed meta keys only', () => {
    const before = library();
    const after = rate(before, 'c2', 1, { intervalDays: 4, ease: 2.6, reps: 1, stepIndex: null });
    const diff = diffState(before, after);
    expect(keysOf(diff, 'cards')).toEqual(['c2']);
    for (const { table } of ROW_TABLES) {
      expect(diff.tables[table].deletes).toEqual([]);
      if (table !== 'cards') expect(diff.tables[table].upserts).toEqual([]);
    }
    expect(metaKeys(diff)).toEqual(['person', 'reviewLog']);
    expect(diff.metaDelete).toEqual([]);
    expect(diff.revlogPut).toEqual([
      {
        seq: 1,
        cardId: 'c2',
        deckId: 'd1',
        atMs: T0 + 1000,
        rating: 'good',
        bucket: 'new',
        ivlBefore: 0,
        ivlAfter: 4,
        easeAfter: 2.6,
        durationMs: null,
      },
    ]);
    expect(diff.revlogAdd).toEqual([]);
    expect(diff.revlogDelete).toEqual([]);
    expect(diffSize(diff)).toBe(4); // 1 card, 2 meta rows, 1 revlog row
  });

  test('a rating inside a session also writes the in-flight marker (and nothing else)', () => {
    const before = library();
    const marker = { kind: 'scheduled' as const, label: 'Today', counts: { again: 0, hard: 0, good: 1, easy: 0 }, total: 1, bestRun: 1, durationSec: 4, fastAnswers: 0, studyDay: '2026-06-10' };
    const after = { ...rate(before, 'c1', 1), inProgressSession: marker };
    expect(metaKeys(diffState(before, after))).toEqual(['inProgressSession', 'person', 'reviewLog']);
  });

  test('two ratings of one card before one save: each row gets the values right after ITS rating', () => {
    const s0 = library();
    const s1 = rate(s0, 'c1', 1, { intervalDays: 1, reps: 1, stepIndex: null });
    const s2 = rate(s1, 'c1', 2, { intervalDays: 3, reps: 2, stepIndex: null });
    const diff = diffState(s0, s2);
    expect(diff.revlogPut.map((r) => [r.seq, r.ivlBefore, r.ivlAfter])).toEqual([
      [1, 0, 1],
      [2, 1, 3],
    ]);
  });

  test('undo → the rating\'s revlog row is deleted (the tail), the card is written back', () => {
    const rated = rate(rate(library(), 'c1', 1), 'c2', 2);
    const diff = diffState(rated, undo(rated));
    expect(diff.revlogDelete).toEqual([2]);
    expect(diff.revlogPut).toEqual([]);
    expect(keysOf(diff, 'cards')).toEqual(['c2']);
    expect(metaKeys(diff)).toEqual(['person', 'reviewLog']);
  });

  test('undo of every rating → every one of those rows is deleted', () => {
    const rated = rate(rate(library(), 'c1', 1), 'c2', 2);
    expect(diffState(rated, undo(undo(rated))).revlogDelete.sort()).toEqual([1, 2]);
  });

  test('undo + a new rating with the SAME seq in one save → the row is written over, not deleted', () => {
    const rated = rate(library(), 'c1', 1);
    const again = rate(undo(rated), 'c3', 1); // seq = last + 1 again
    const diff = diffState(rated, again);
    expect(diff.revlogDelete).toEqual([]);
    expect(diff.revlogPut.map((r) => [r.seq, r.cardId])).toEqual([[1, 'c3']]);
  });

  test('undo + a new rating with a NEW seq in one save → the undone row is deleted, the new one written', () => {
    const rated = rate(rate(library(), 'c1', 1), 'c2', 2);
    const again = rate(undo(rated), 'c3', 3);
    const diff = diffState(rated, again);
    expect(diff.revlogDelete).toEqual([2]);
    expect(diff.revlogPut.map((r) => r.seq)).toEqual([3]);
  });

  test('head drop (the 400 cap) → the old rows are KEPT: they are the history', () => {
    let s = library();
    for (let seq = 1; seq <= 3; seq++) s = rate(s, 'c1', seq);
    // The cap drops the oldest entry when a new one comes (cap 3 here).
    const next = rate(s, 'c2', 4);
    const capped = { ...next, reviewLog: next.reviewLog.slice(-3) };
    const diff = diffState(s, capped);
    expect(diff.revlogDelete).toEqual([]);
    expect(diff.revlogPut.map((r) => r.seq)).toEqual([4]);
  });

  test('the cap drops EVERY old entry in one save → still nothing is deleted', () => {
    let s = library();
    for (let seq = 1; seq <= 2; seq++) s = rate(s, 'c1', seq);
    let next = s;
    for (let seq = 3; seq <= 4; seq++) next = rate(next, 'c2', seq);
    const capped = { ...next, reviewLog: next.reviewLog.slice(-2) };
    // The test plays a cap of 2, so it tells the diff (the app's cap is 400).
    expect(diffState(s, capped, { reviewLogCap: 2 }).revlogDelete).toEqual([]);
  });

  test('undo of EVERY saved rating + a new rating in one save → the undone rows are deleted (final review)', () => {
    // A new learner: rate c1 (saved), Undo, and rate c2 within 400 ms (one save).
    const rated = rate(library(), 'c1', 1);
    const again = rate(undo(rated), 'c2', 2);
    const diff = diffState(rated, again);
    expect(diff.revlogDelete).toEqual([1]);
    expect(diff.revlogPut.map((r) => [r.seq, r.cardId])).toEqual([[2, 'c2']]);
    // Two saved ratings, both undone, then two new ones (also after a failed save, M15).
    const two = rate(rate(library(), 'c1', 1), 'c2', 2);
    const later = rate(rate(undo(undo(two)), 'c3', 3), 'c1', 4);
    expect(diffState(two, later).revlogDelete.sort()).toEqual([1, 2]);
    // A seq gap (ratings made and undone again in between) changes nothing while the cap is far.
    expect(diffState(rated, rate(undo(rated), 'c2', 9)).revlogDelete).toEqual([1]);
  });

  test('every old entry is gone, but the log CAN have passed the cap → the rows are kept (history is never guessed away)', () => {
    // Cap 3: [1, 2] saved; then (one save, the saves failed) 3, 4, 5 → the cap drops 1 and 2;
    // undo 5, 4, 3; rate 6. Rows 1 and 2 left the HEAD: they are history.
    let s = library();
    for (let seq = 1; seq <= 2; seq++) s = rate(s, 'c1', seq);
    const next = rate({ ...s, reviewLog: [] }, 'c2', 6);
    expect(diffState(s, next, { reviewLogCap: 3 }).revlogDelete).toEqual([]);
    // The same two entries with a log that could NOT pass the cap: they were undone.
    const near = rate({ ...s, reviewLog: [] }, 'c2', 3);
    expect(diffState(s, near, { reviewLogCap: 3 }).revlogDelete.sort()).toEqual([1, 2]);
  });

  test('cap + undo in one save → only the undone entry is deleted', () => {
    let s = library();
    for (let seq = 1; seq <= 3; seq++) s = rate(s, 'c1', seq); // [1, 2, 3]
    const next = rate(rate(undo(s), 'c2', 4), 'c3', 5); // [1, 2, 4, 5]
    const capped = { ...next, reviewLog: next.reviewLog.slice(-3) }; // [2, 4, 5]
    expect(diffState(s, capped).revlogDelete).toEqual([3]);
  });

  test('deck delete → deletes in decks, notes and cards', () => {
    const s = library();
    const other = makeDeckV3({ id: 'd2', name: 'Other' });
    const g = noteWithCards({ deckId: 'd2', note: { id: 'n9' }, card: { id: 'c9' } });
    const withOther = { ...s, decks: [...s.decks, other], notes: [...s.notes, g.note], cards: [...s.cards, ...g.cards] };
    const removed = { ...withOther, decks: s.decks, notes: s.notes, cards: s.cards };
    const diff = diffState(withOther, removed);
    expect(diff.tables.decks.deletes).toEqual(['d2']);
    expect(diff.tables.notes.deletes).toEqual(['n9']);
    expect(diff.tables.cards.deletes).toEqual(['c9']);
    expect(diffSize(diff)).toBe(3);
  });

  test('M5: a completed session → the session row, the person and the marker clear are in ONE diff', () => {
    const marker = { kind: 'scheduled' as const, label: 'Today', counts: { again: 0, hard: 0, good: 3, easy: 0 }, total: 3, bestRun: 3, durationSec: 30, fastAnswers: 0, studyDay: '2026-06-10' };
    const during = { ...library(), inProgressSession: marker };
    const session = { id: 's1', dayKey: '2026-06-10', atMs: T0, kind: 'scheduled' as const, counts: marker.counts, total: 3, bestRun: 3, xp: 30 };
    const done = { ...during, sessions: [...during.sessions, session], person: { ...during.person, xp: 30 }, inProgressSession: null };
    const diff = diffState(during, done);
    expect(diff.tables.sessions.upserts).toEqual([{ key: 's1', json: JSON.stringify(session), dayKey: '2026-06-10' }]);
    expect(metaKeys(diff)).toEqual(['inProgressSession', 'person']);
    expect(diff.metaSet.find((m) => m.key === 'inProgressSession')?.json).toBe('null');
  });

  test('a key that becomes undefined is deleted from meta (JSON would drop it too)', () => {
    const s = { ...library(), extra: { a: 1 } } as DataStateV3;
    const diff = diffState(s, { ...s, extra: undefined } as DataStateV3);
    expect(diff.metaDelete).toEqual(['extra']);
    expect(diff.metaSet).toEqual([]);
  });

  test('prev null → every row is written; history rows only where the table has none yet', () => {
    const s = rate(library(), 'c1', 1);
    const diff = diffState(null, s);
    expect(keysOf(diff, 'cards')).toEqual(['c1', 'c2', 'c3']);
    expect(keysOf(diff, 'decks')).toEqual(['d1']);
    expect(diff.revlogPut).toEqual([]);
    expect(diff.revlogAdd.map((r) => r.seq)).toEqual([1]);
    expect(diff.tables.cards.deletes).toEqual([]);
    expect(metaKeys(diff)).toEqual(
      ['collections', 'inProgressSession', 'listPrefs', 'manualLog', 'minReaderVersion', 'onboarded', 'pack', 'person', 'reviewLog', 'schemaVersion', 'settings'].sort(),
    );
  });

  test('keepRows: rows that are not in `next` are NOT deleted, but lost meta keys are', () => {
    const loaded = { ...library(), old: 1 } as DataStateV3;
    const repaired = { ...loaded, cards: loaded.cards.slice(1), old: undefined } as DataStateV3;
    const diff = diffState(loaded, repaired, { keepRows: true });
    expect(diff.tables.cards.deletes).toEqual([]);
    expect(diff.metaDelete).toEqual(['old']);
  });

  test('setAsideRows: the loaded rows (and review-log seqs) that the decoded state does not have', () => {
    const rated = rate(rate(library(), 'c1', 1), 'c2', 2);
    const orphan: Card = { ...rated.cards[0], id: 'c9', noteId: 'n-gone' };
    const loaded = { ...rated, cards: [...rated.cards, orphan] };
    const decoded = { ...rated, reviewLog: rated.reviewLog.slice(0, 1) }; // c9 and seq 2 left out
    const setAside = setAsideRows(loaded, decoded);
    expect([...setAside.tables.cards]).toEqual(['c9']);
    for (const { table } of ROW_TABLES) if (table !== 'cards') expect([...setAside.tables[table]]).toEqual([]);
    expect([...setAside.seqs]).toEqual([2]);
    // A decode that left nothing out → nothing to keep.
    const none = setAsideRows(rated, rated);
    expect(ROW_TABLES.every(({ table }) => none.tables[table].size === 0) && none.seqs.size === 0).toBe(true);
  });

  test('setAside: a row the decode set aside is KEPT, a row the user deleted is DELETED (keepRows would keep both)', () => {
    const s = library();
    const orphan: Card = { ...s.cards[0], id: 'c9', noteId: 'n-gone' };
    const loaded = { ...s, cards: [s.cards[0], orphan, s.cards[1], s.cards[2]] };
    const decoded = { ...s, settings: { ...s.settings } }; // c9 set aside; a new default (changed)
    const setAside = setAsideRows(loaded, decoded);
    // Before the first commit, the user deletes note n3 and its card c3.
    const next = { ...decoded, notes: decoded.notes.slice(0, 2), cards: decoded.cards.slice(0, 2) };
    const diff = diffState(loaded, next, { setAside });
    expect(diff.tables.cards.deletes).toEqual(['c3']);
    expect(diff.tables.notes.deletes).toEqual(['n3']);
    expect(metaKeys(diff)).toEqual(['settings']);
    const safe = diffState(loaded, next, { keepRows: true });
    expect(safe.tables.cards.deletes).toEqual([]);
    expect(safe.tables.notes.deletes).toEqual([]);
  });

  test('setAside: the decode made NEW entry objects — a loaded rating is matched by its content, an undo deletes its row, a re-rate with the same seq writes over it', () => {
    const loaded = rate(rate(rate(library(), 'c1', 1), 'c2', 2), 'c3', 3); // revlog rows 1, 2, 3
    const decoded = { ...loaded, reviewLog: loaded.reviewLog.map((e) => ({ ...e })) };
    const setAside = setAsideRows(loaded, decoded);
    expect(setAside.seqs.size).toBe(0);
    expect(sameRating(loaded.reviewLog[0], decoded.reviewLog[0])).toBe(true);

    // Nothing but the decode: the stored rows are never written over.
    const same = diffState(loaded, decoded, { setAside });
    expect(same.revlogPut).toEqual([]);
    expect(same.revlogDelete).toEqual([]);

    // The user undoes rating 3 before the first commit → its row is deleted.
    const undone = undo(decoded);
    const afterUndo = diffState(loaded, undone, { setAside });
    expect(afterUndo.revlogDelete).toEqual([3]);
    expect(afterUndo.revlogPut).toEqual([]);

    // Undo + a new rating that takes seq 3 again (another card) → written over, not deleted.
    const rerated = rate(undone, 'c1', 3);
    expect(sameRating(loaded.reviewLog[2], rerated.reviewLog[2])).toBe(false);
    const afterRerate = diffState(loaded, rerated, { setAside });
    expect(afterRerate.revlogDelete).toEqual([]);
    expect(afterRerate.revlogPut.map((r) => [r.seq, r.cardId])).toEqual([[3, 'c1']]);
  });

  test('setAside: a review-log entry the decode left out keeps its revlog row; the head drop keeps its rows too', () => {
    const loaded = rate(rate(rate(library(), 'c1', 1), 'c2', 2), 'c3', 3);
    const decoded = { ...loaded, reviewLog: loaded.reviewLog.slice(0, 2) }; // the decode left seq 3 out
    const setAside = setAsideRows(loaded, decoded);
    expect(diffState(loaded, decoded, { setAside }).revlogDelete).toEqual([]);
    // Without setAside, a missing seq at the tail looks like an undo.
    expect(diffState(loaded, decoded).revlogDelete).toEqual([3]);
    // The 400 cap drops seq 1 when a new rating comes: its row stays (the history).
    const next = rate(decoded, 'c1', 4);
    const capped = { ...next, reviewLog: next.reviewLog.slice(1) };
    const diff = diffState(loaded, capped, { setAside });
    expect(diff.revlogDelete).toEqual([]);
    expect(diff.revlogPut.map((r) => r.seq)).toEqual([4]);
  });

  test('a card put back in the MIDDLE → the table is rewritten from there, so the order stays', () => {
    const s = library();
    const [c1, c2, c3] = s.cards;
    const without = { ...s, cards: [c1, c3] };
    const back = { ...s, cards: [c1, c2, c3] };
    const diff = diffState(without, back);
    // c3 is deleted and written again AFTER c2.
    expect(diff.tables.cards.deletes).toEqual(['c3']);
    expect(keysOf(diff, 'cards')).toEqual(['c2', 'c3']);
  });

  test('a new row at the END is just added (no rewrite)', () => {
    const s = library();
    const g = noteWithCards({ deckId: 'd1', note: { id: 'n4' }, card: { id: 'c4' } });
    const diff = diffState(s, { ...s, notes: [...s.notes, g.note], cards: [...s.cards, ...g.cards] });
    expect(diff.tables.cards).toEqual({ deletes: [], upserts: [expect.objectContaining({ key: 'c4' })] });
  });

  test('a value JSON cannot write → the diff throws (the save rejects; M15 reports it)', () => {
    const s = library();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => diffState(s, { ...s, settings: cycle } as unknown as DataStateV3)).toThrow();
  });
});

describe('rowKeys', () => {
  test('ids as keys; a repeated id gets a key no other row has; no id → a stable hash key; non-objects → null', () => {
    const rows = [{ id: 'a' }, { id: 'a#2' }, { id: 'a' }, { id: 7 }, { name: 'no id' }, null, 'x'];
    const keys = rowKeys(rows);
    expect(keys.slice(0, 4)).toEqual(['a', 'a#2', 'a#3', '7']);
    expect(keys[4]).toMatch(/^~noid-\d+$/);
    expect(rowKeys([{ name: 'no id' }])[0]).toBe(keys[4]);
    expect(keys.slice(5)).toEqual([null, null]);
  });

  test('two rows with one id are BOTH stored and both load again', async () => {
    const s = library();
    const twin = { ...s.cards[0], ord: 1 };
    const state = { ...s, cards: [...s.cards, twin] };
    const db = createMemoryRowDb();
    await db.write(diffState(null, state), 'diff');
    expect((await loadDoc(db)).cards).toEqual(state.cards);
  });
});

describe('records without a prototype (W2 hardening)', () => {
  test('a saved list whose Query.fields has a "__proto__" key loads back with that key', async () => {
    const fields = fieldRecord([
      ['__proto__', ['x']],
      ['level', ['b1']],
    ]);
    const s = library();
    const list = { id: 'l1', name: 'Odd', icon: '★', query: { fields }, createdAt: T0, updatedAt: T0 };
    const state = { ...s, lists: [list] };
    const db = createMemoryRowDb();
    await db.write(diffState(null, state), 'diff');
    const loaded = (await loadDoc(db)).lists as { query: { fields: Record<string, string[]> } }[];
    const back = loaded[0].query.fields;
    expect(Object.prototype.hasOwnProperty.call(back, '__proto__')).toBe(true);
    expect(new Map(Object.entries(back))).toEqual(new Map([['__proto__', ['x']], ['level', ['b1']]]));
  });

  test('assembleDoc keeps a top-level "__proto__" key as an own key', () => {
    const doc = assembleDoc(new Map<string, unknown>([['__proto__', 1], ['schemaVersion', 3]]), {
      decks: [],
      note_types: [],
      notes: [],
      cards: [],
      lists: [],
      sessions: [],
    });
    expect(Object.prototype.hasOwnProperty.call(doc, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(doc)).toBe(Object.prototype);
  });
});

/*
 * W4-7: a fixed wall-clock budget fails on a busy test machine. So the guard
 * counts the CPU time of this process (process.cpuUsage: waiting for the
 * processor is not counted), takes the fastest of 5 ratings per library size,
 * measured in turns (16k, 4k, 16k, 4k …), each diff repeated for at least
 * 10 ms, and up to 3 tries. It proves that the diff grows LINEARLY with the
 * library (4 × the cards < 10 × the time: linear ≈ 4, quadratic ≈ 16), and
 * keeps a budget only as a generous upper bound (100 ms; the real time is a
 * few ms). The 20 ms budget is checked on the phone (spec E2).
 */
describe('speed: a rating in a library of 16,000 cards (spec E2: save after a rating < 20 ms on the phone)', () => {
  /** The CPU time this process has used, in ms (the wall clock where `process.cpuUsage` is missing). */
  const clockMs = (): number => {
    if (typeof process !== 'undefined' && typeof process.cpuUsage === 'function') {
      const used = process.cpuUsage();
      return (used.user + used.system) / 1000;
    }
    return Date.now();
  };

  /** A library of `size` cards (2 per note). */
  function libraryOf(size: number): DataStateV3 {
    const deck = makeDeckV3({ id: 'd1' });
    const template = noteWithCards({ deckId: 'd1', note: { id: 'n0' }, card: { id: 'c0' } });
    const cards = Array.from({ length: size }, (_, i) => ({ ...template.cards[0], id: `c${i}`, noteId: `n${i >> 1}`, ord: i & 1 }));
    const notes = Array.from({ length: size / 2 }, (_, i) => ({ ...template.note, id: `n${i}` }));
    return { ...stateOfV3({ decks: [deck] }), notes, cards };
  }

  /** 5 ratings in a row in a library of `size` cards: each [state before, state after]. Each diff writes exactly the rated card. */
  function ratingsIn(size: number): [DataStateV3, DataStateV3][] {
    let state = libraryOf(size);
    const steps: [DataStateV3, DataStateV3][] = [];
    for (let run = 1; run <= 5; run++) {
      const cardId = `c${(run * size) / 16}`;
      const next = rate(state, cardId, run);
      const diff = diffState(state, next);
      expect(keysOf(diff, 'cards')).toEqual([cardId]);
      expect(diff.tables.notes.upserts).toEqual([]);
      steps.push([state, next]);
      state = next;
    }
    return steps;
  }

  /** The CPU time of one diff of `step` in ms, the diff repeated for at least 10 ms. */
  function diffMs([prev, next]: [DataStateV3, DataStateV3]): number {
    let calls = 0;
    let elapsed = 0;
    const start = clockMs();
    do {
      diffState(prev, next);
      calls += 1;
      elapsed = clockMs() - start;
    } while (elapsed < 10);
    return elapsed / calls;
  }

  test('the diff writes 1 card, grows linearly with the library, and takes far less than 100 ms for 16,000 cards', () => {
    const fullSteps = ratingsIn(16_000);
    const quarterSteps = ratingsIn(4_000);
    let best = { full: Number.POSITIVE_INFINITY, growth: Number.POSITIVE_INFINITY };
    for (let attempt = 0; attempt < 3 && best.growth >= 10; attempt++) {
      let full = Number.POSITIVE_INFINITY;
      let quarter = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 5; i++) {
        full = Math.min(full, diffMs(fullSteps[i]));
        quarter = Math.min(quarter, diffMs(quarterSteps[i]));
      }
      if (full / quarter < best.growth) best = { full, growth: full / quarter };
    }
    expect(best.growth).toBeLessThan(10);
    expect(best.full).toBeLessThan(100);
  });
});

/* --------------------------------------------------- property: round trip */

interface Sim {
  state: DataStateV3;
  nextSeq: number;
  /** The seqs whose revlog rows must be stored. */
  history: Set<number>;
}

const CAP = 6;

/** One random edit, the way the reducer makes it (new objects only for what changes). */
function randomEdit(rnd: Random, sim: Sim): DataStateV3 {
  const s = sim.state;
  const pick = rnd.int(0, 10);
  if (pick === 0 && s.cards.length > 0) {
    // change one card
    const i = rnd.int(0, s.cards.length - 1);
    return { ...s, cards: s.cards.map((c, j) => (j === i ? { ...c, fav: !c.fav } : c)) };
  }
  if (pick === 1 && s.cards.length > 0) {
    // delete one card (and its log entries stay: the log is history)
    const i = rnd.int(0, s.cards.length - 1);
    return { ...s, cards: s.cards.filter((_, j) => j !== i) };
  }
  if (pick === 2 && s.decks.length > 0) {
    // put a new card in the middle (an undo of a delete)
    const i = rnd.int(0, s.cards.length);
    const card = { ...noteWithCards({ deckId: s.decks[0].id }).cards[0], id: `new-${sim.nextSeq}-${i}` };
    return { ...s, cards: [...s.cards.slice(0, i), card, ...s.cards.slice(i)] };
  }
  if (pick === 3 && s.cards.length > 1) {
    // move one card (a reorder)
    const from = rnd.int(0, s.cards.length - 1);
    const to = rnd.int(0, s.cards.length - 2);
    const rest = s.cards.filter((_, j) => j !== from);
    return { ...s, cards: [...rest.slice(0, to), s.cards[from], ...rest.slice(to)] };
  }
  if ((pick === 4 || pick === 5) && s.cards.length > 0) {
    // a rating (monotonic seq), with the cap
    const card = rnd.pick(s.cards);
    const seq = sim.nextSeq++;
    sim.history.add(seq);
    const next = rate(s, card.id, seq, { intervalDays: rnd.int(1, 30), reps: card.reps + 1, stepIndex: null });
    return { ...next, reviewLog: next.reviewLog.slice(-CAP) };
  }
  if (pick === 6 && s.reviewLog.length > 0) {
    sim.history.delete(s.reviewLog[s.reviewLog.length - 1].seq);
    return undo(s);
  }
  if (pick === 7) return { ...s, settings: { ...s.settings, hintsEnabled: !s.settings.hintsEnabled } };
  if (pick === 8 && s.decks.length > 1) {
    const gone = s.decks[s.decks.length - 1].id;
    return { ...s, decks: s.decks.slice(0, -1), cards: s.cards.filter((c) => c.deckId !== gone) };
  }
  if (pick === 9) {
    const session = { id: `s${sim.nextSeq}`, dayKey: '2026-06-10', atMs: T0, kind: 'scheduled' as const, counts: { again: 0, hard: 0, good: 1, easy: 0 }, total: 1, bestRun: 1, xp: 10 };
    sim.nextSeq += 1;
    return { ...s, sessions: [...s.sessions, session], inProgressSession: null };
  }
  return s; // no change
}

describe('property: saving diffs and loading gives back exactly the state', () => {
  test('40 random libraries × 12 random edits (rows, order, meta and history)', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = createRandom(`rowdiff-${seed}`);
      const sim: Sim = { state: randomStateV3(rnd, { maxNotes: 12 }), nextSeq: 1, history: new Set() };
      const db = createMemoryRowDb();
      await db.write(diffState(null, sim.state), 'diff');
      for (let step = 0; step < 12; step++) {
        const prev = sim.state;
        const next = randomEdit(rnd, sim);
        await db.write(diffState(prev, next, { reviewLogCap: CAP }), 'diff');
        sim.state = next;
        const doc = await loadDoc(db);
        expect({ seed, step, doc }).toEqual({ seed, step, doc: next });
        expect({ seed, step, history: db.snapshot().revlog.map((r) => r.seq) }).toEqual({
          seed,
          step,
          history: [...sim.history].sort((a, b) => a - b),
        });
      }
    }
  });
});

describe('property: several ratings and undos in ONE save (final review)', () => {
  test('60 seeds × 30 saves of 1–4 ratings/undos each: the history is exactly the ratings that are left', async () => {
    // One save covers every change of the 400 ms debounce (or of a run of failed saves, M15).
    // Seqs only go up, like the engine's minSeq: an undone seq is never given again.
    for (let seed = 1; seed <= 60; seed++) {
      const rnd = createRandom(`rowdiff-window-${seed}`);
      let state = library();
      let nextSeq = 1;
      const history = new Set<number>();
      const db = createMemoryRowDb();
      await db.write(diffState(null, state), 'diff');
      for (let save = 0; save < 30; save++) {
        const prev = state;
        const edits = rnd.int(1, 4);
        for (let e = 0; e < edits; e++) {
          if (state.reviewLog.length > 0 && rnd.int(0, 1) === 0) {
            history.delete(state.reviewLog[state.reviewLog.length - 1].seq);
            state = undo(state);
          } else {
            const card = rnd.pick(state.cards);
            history.add(nextSeq);
            state = rate(state, card.id, nextSeq++, { intervalDays: rnd.int(1, 30), reps: card.reps + 1, stepIndex: null });
          }
        }
        await db.write(diffState(prev, state), 'diff');
        expect({ seed, save, history: db.snapshot().revlog.map((r) => r.seq) }).toEqual({
          seed,
          save,
          history: [...history].sort((a, b) => a - b),
        });
      }
    }
  });
});

/* -------------------------------------------------------- the row port */

describe('the row port over a memory RowDb', () => {
  /** A row port with data on its disk (a boot that loaded rows). */
  async function booted(state: DataStateV3) {
    const db = createMemoryRowDb();
    await db.write(diffState(null, state), 'diff');
    const port = rowPort(db);
    await port.load();
    return { db, port };
  }

  test('a save is ONE transaction; a rating writes only its rows', async () => {
    const s = library();
    const { db, port } = await booted(s);
    const writes = db.writes;
    await port.save(rate(s, 'c1', 1), s);
    expect(db.writes).toBe(writes + 1);
    expect(port.stats().lastSave).toMatchObject({ mode: 'diff', rows: 5 }); // card, person, reviewLog, revlog + bootOkCount
  });

  test('a save of nothing new writes nothing (no transaction)', async () => {
    const s = library();
    const { db, port } = await booted(s);
    await port.save(rate(s, 'c1', 1), s); // the first commit also counts the boot
    const writes = db.writes;
    const rated = rate(s, 'c1', 1);
    await port.save(rated, rated);
    expect(db.writes).toBe(writes);
  });

  test('M5: the completion (session + person + marker clear) is in ONE transaction', async () => {
    const marker = { kind: 'scheduled' as const, label: 'Today', counts: { again: 0, hard: 0, good: 1, easy: 0 }, total: 1, bestRun: 1, durationSec: 5, fastAnswers: 0, studyDay: '2026-06-10' };
    const during = { ...library(), inProgressSession: marker };
    const { db, port } = await booted(during);
    const session = { id: 's1', dayKey: '2026-06-10', atMs: T0, kind: 'scheduled' as const, counts: marker.counts, total: 1, bestRun: 1, xp: 10 };
    const done = { ...during, sessions: [session], person: { ...during.person, xp: 10 }, inProgressSession: null };
    const writes = db.writes;
    await port.save(done, during);
    expect(db.writes).toBe(writes + 1);
    const doc = await loadDoc(db);
    expect(doc.sessions).toEqual([session]);
    expect(doc.inProgressSession).toBeNull();
    expect((doc.person as { xp: number }).xp).toBe(10);
  });

  test('a failed save changes NOTHING on the disk and rejects', async () => {
    const s = library();
    const { db, port } = await booted(s);
    const before = db.snapshot();
    db.failWrites = 1;
    await expect(port.save(rate(s, 'c1', 1), s)).rejects.toThrow('disk is full');
    expect(db.snapshot()).toEqual(before);
  });

  test('a failed save keeps the controller\'s lastSaved: the next save sends the FULL difference', async () => {
    jest.useFakeTimers();
    try {
      const s = library();
      const db = createMemoryRowDb();
      await db.write(diffState(null, s), 'diff');
      const port = rowPort(db);
      const errors: unknown[] = [];
      const persist = createPersistController<DataStateV3>(port, {
        now: () => T0,
        decode: (value) => ({ kind: 'ok', state: value as DataStateV3 }),
        seed: () => makeStateV3(),
        onError: (e) => errors.push(e),
      });
      const boot = await persist.load();
      if (boot.kind !== 'loaded') throw new Error('not loaded');
      const loaded = boot.state;
      const one = rate(loaded, 'c1', 1);
      db.failWrites = 1;
      persist.scheduleSave(one);
      expect(await persist.flush()).toMatchObject({ ok: false, reason: 'write' });
      expect(errors).toEqual(['write']);
      const two = rate(one, 'c2', 2);
      persist.scheduleSave(two);
      expect(await persist.flush()).toEqual({ ok: true });
      // Both ratings reached the disk: the second save diffed from the LOADED state.
      const doc = await loadDoc(db);
      expect(doc.cards).toEqual(two.cards);
      expect(doc.reviewLog).toEqual(two.reviewLog);
      expect(db.snapshot().revlog.map((r) => r.seq)).toEqual([1, 2]);
      expect(errors).toEqual(['write', null]);
    } finally {
      jest.useRealTimers();
    }
  });

  test('replaceAll deletes every row (also rows not in the state, and the history) and keeps the store\'s own meta', async () => {
    const s = rate(library(), 'c1', 1);
    const { db, port } = await booted(s);
    await port.save(s, null); // the first commit writes bootOkCount
    // A row the state does not have (an orphan the integrity check set aside).
    await db.write({ ...emptyDiff(), tables: { ...emptyDiff().tables, cards: { deletes: [], upserts: [{ key: 'orphan', json: '{"id":"orphan"}', dayKey: null }] } } }, 'diff');
    const fresh = makeStateV3();
    await port.replaceAll(fresh);
    const snap = db.snapshot();
    expect(snap.tables.cards).toEqual([]);
    expect(snap.revlog).toEqual([]);
    expect(snap.meta.map(([k]) => k)).toContain('bootOkCount');
    expect(await loadDoc(db)).toEqual(fresh);
  });

  test('a FAILED replaceAll → the next save replaces everything too (restore is replace, never merge)', async () => {
    const s = library();
    const { db, port } = await booted(s);
    const backup = stateOfV3({ decks: [makeDeckV3({ id: 'd9' })], groups: [noteWithCards({ deckId: 'd9', note: { id: 'n9' }, card: { id: 'c9' } })] });
    db.failWrites = 1;
    await expect(port.replaceAll(backup)).rejects.toThrow();
    expect(await loadDoc(db)).toEqual(s);
    // The controller then saves `backup` with its OLD lastSaved (s).
    await port.save(backup, s);
    expect(await loadDoc(db)).toEqual(backup);
    expect(port.stats().lastSave?.mode).toBe('replace');
  });

  test('replaceAll with a restore history: ONE transaction; the history wins its seqs; unusable rows are left out; the top is raised (final review)', async () => {
    const s = rate(library(), 'c1', 1);
    const { db, port } = await booted(s);
    const history = (seq: number, cardId: string): RevlogRow => ({ seq, cardId, deckId: 'd1', atMs: T0 - seq, rating: 'hard', bucket: 'review', ivlBefore: 2, ivlAfter: 3, easeAfter: 2.3, durationMs: 500 });
    // The restored log has seq 1 (its own rating); the history has seq 1 too (the backup's row of it) and 40.
    const restored = rate(library(), 'c2', 1);
    const commits = db.writes;
    await port.replaceAll(restored, [history(1, 'c2'), history(40, 'c3'), { ...history(41, 'c3'), atMs: Number.NaN }, { seq: 42 } as unknown as RevlogRow]);
    expect(db.writes - commits).toBe(1);
    expect(db.snapshot().revlog.map((r) => [r.seq, r.cardId, r.rating])).toEqual([
      [1, 'c2', 'hard'], // the history row wins over the log's own row with the same seq
      [40, 'c3', 'hard'],
      [41, 'c3', 'hard'], // a NaN time is written as 0, never a failed transaction
    ]);
    expect(db.snapshot().revlog[2].atMs).toBe(0);
    expect(port.highestRevlogSeq()).toBe(41);
    // A later replace without history (a factory reset) deletes them.
    await port.replaceAll(makeStateV3(), undefined);
    expect(db.snapshot().revlog).toEqual([]);
  });

  test('a FAILED replaceAll with a history → the save that retries it writes the history too; a later save does not again', async () => {
    const s = rate(library(), 'c1', 1);
    const { db, port } = await booted(s);
    const kept: RevlogRow = { seq: 7, cardId: 'c1', deckId: 'd1', atMs: T0 - 7, rating: 'good', bucket: 'review', ivlBefore: 1, ivlAfter: 3, easeAfter: 2.5, durationMs: null };
    const backup = library();
    db.failWrites = 1;
    await expect(port.replaceAll(backup, [kept])).rejects.toThrow();
    expect(db.snapshot().revlog.map((r) => r.seq)).toEqual([1]); // nothing changed
    await port.save(backup, s);
    expect(port.stats().lastSave?.mode).toBe('replace');
    expect(db.snapshot().revlog.map((r) => r.seq)).toEqual([7]);
    // The next save is a plain diff: the restore's rows are not written again (an undo of them is not possible anyway).
    await db.write({ ...emptyDiff(), revlogDelete: [7] }, 'diff');
    const next = rate(backup, 'c2', 8);
    await port.save(next, backup);
    expect(port.stats().lastSave?.mode).toBe('diff');
    expect(db.snapshot().revlog.map((r) => r.seq)).toEqual([8]);
  });

  test('one write queue: two saves at once never run together', async () => {
    const s = library();
    const { db, port } = await booted(s);
    let running = 0;
    let overlap = false;
    const write = db.write.bind(db);
    db.write = async (diff, mode) => {
      running += 1;
      if (running > 1) overlap = true;
      await new Promise((r) => setTimeout(r, 5));
      await write(diff, mode);
      running -= 1;
    };
    const one = rate(s, 'c1', 1);
    const two = rate(one, 'c2', 2);
    await Promise.all([port.save(one, s), port.save(two, one), port.revlog.write([{ seq: 99, cardId: 'c3', deckId: 'd1', atMs: T0, rating: 'easy', bucket: 'review', ivlBefore: 1, ivlAfter: 4, easeAfter: 2.65, durationMs: 1200 }])]);
    expect(overlap).toBe(false);
    expect(db.snapshot().revlog.map((r) => r.seq)).toEqual([1, 2, 99]);
  });

  test('bootOkCount goes up by one with the first commit after each load', async () => {
    const s = library();
    const db = createMemoryRowDb();
    await db.write(diffState(null, s), 'diff');
    const count = () => JSON.parse(new Map(db.snapshot().meta).get('bootOkCount') ?? '0') as number;
    for (let boot = 1; boot <= 3; boot++) {
      const port = rowPort(db);
      const loaded = await port.load();
      const state = (loaded as { value: DataStateV3 }).value;
      const changed = { ...state, onboarded: !state.onboarded };
      await port.save(changed, state);
      await port.save({ ...changed, onboarded: state.onboarded }, changed); // a second commit: no new count
      expect(count()).toBe(boot);
    }
    // bootOkCount is the store's own key: it is never part of the document.
    expect(await loadDoc(db)).not.toHaveProperty('bootOkCount');
  });

  test('markBootOk counts a boot that only READS (no commit) — once per load, never twice', async () => {
    const s = library();
    const db = createMemoryRowDb();
    await db.write(diffState(null, s), 'diff');
    const count = () => JSON.parse(new Map(db.snapshot().meta).get('bootOkCount') ?? '0') as number;
    for (let boot = 1; boot <= 3; boot++) {
      const port = rowPort(db);
      await port.load();
      await port.markBootOk();
      await port.markBootOk(); // a second call: no new count, no transaction
      expect(count()).toBe(boot);
    }
    // markBootOk, then a commit in the same boot: the commit does not count again.
    const port = rowPort(db);
    const state = ((await port.load()) as { value: DataStateV3 }).value;
    await port.markBootOk();
    await port.save({ ...state, onboarded: !state.onboarded }, state);
    expect(count()).toBe(4);
    // The commit first, then markBootOk: still one count.
    const port2 = rowPort(db);
    const state2 = ((await port2.load()) as { value: DataStateV3 }).value;
    await port2.save({ ...state2, onboarded: !state2.onboarded }, state2);
    const writes = db.writes;
    await port2.markBootOk();
    expect(db.writes).toBe(writes);
    expect(count()).toBe(5);
  });

  test('markBootOk writes nothing while the row store is EMPTY (rows without schemaVersion would block the next boot)', async () => {
    const db = createMemoryRowDb();
    const port = rowPort(db);
    await port.markBootOk(); // before any load: nothing to count
    expect(await port.load()).toEqual({ kind: 'empty' });
    await port.markBootOk();
    expect(db.writes).toBe(0);
    expect(await db.hasRows()).toBe(false);
    // The first save (the seed or the copy) writes every row and the count.
    await port.save(library(), null);
    expect(JSON.parse(new Map(db.snapshot().meta).get('bootOkCount') ?? '0')).toBe(1);
    await expect(loadDoc(db)).resolves.toEqual(library());
  });

  test('markBootOk never rejects: a failed write leaves the count to the next commit; a failed load counts nothing', async () => {
    const s = library();
    const db = createMemoryRowDb();
    await db.write(diffState(null, s), 'diff');
    const count = () => JSON.parse(new Map(db.snapshot().meta).get('bootOkCount') ?? '0') as number;
    const port = rowPort(db);
    await port.load();
    db.failWrites = 1;
    await expect(port.markBootOk()).resolves.toBeUndefined();
    expect(count()).toBe(0);
    await port.save({ ...s, onboarded: !s.onboarded }, s);
    expect(count()).toBe(1);
    // A load that fails (read-blocked): nothing to count.
    db.failReads = true;
    await expect(port.load()).rejects.toThrow();
    db.failReads = false;
    const writes = db.writes;
    await port.markBootOk();
    expect(db.writes).toBe(writes);
  });

  /* After a load that the decode CHANGED (review round 1, finding 2). */

  /** Two decks d1 (n1, c1) and d2 (n2, c2), plus card c9 whose note is gone (the decode sets it aside). */
  function twoDecksAndAnOrphan(): DataStateV3 {
    const groups = ['d1', 'd2'].map((deckId, i) =>
      noteWithCards({ deckId, fields: [`word ${i + 1}`, `meaning ${i + 1}`, '', ''], note: { id: `n${i + 1}` }, card: { id: `c${i + 1}` } }),
    );
    const s = stateOfV3({ decks: [makeDeckV3({ id: 'd1', name: 'One' }), makeDeckV3({ id: 'd2', name: 'Two' })], groups });
    return { ...s, cards: [...s.cards, { ...s.cards[0], id: 'c9', noteId: 'n-gone' }] };
  }

  /**
   * A decode like the app's (migrate() with the integrity check): a card
   * whose note is missing is set aside, and a value gets a new default, so
   * the state is CHANGED and the controller's first save has no `prev`.
   */
  function changingDecode(doc: unknown): DataStateV3 {
    const d = doc as DataStateV3;
    const notes = new Set(d.notes.map((n) => n.id));
    return { ...d, cards: d.cards.filter((c) => notes.has(c.noteId)), settings: { ...d.settings } };
  }

  /** The user deletes deck d2 (deleteDeck: its note and card go with it). */
  function deleteD2(s: DataStateV3): DataStateV3 {
    return { ...s, decks: s.decks.filter((d) => d.id !== 'd2'), notes: s.notes.filter((n) => n.id !== 'n2'), cards: s.cards.filter((c) => c.id !== 'c2') };
  }

  /** A boot through the persist controller, of rows that the decode changes. `portDecode`: the port's own decode (default: the same one). */
  async function changedBoot(
    onDisk: DataStateV3,
    { portDecode }: { portDecode?: (doc: Record<string, unknown>) => object | null } = { portDecode: changingDecode },
  ) {
    const db = createMemoryRowDb();
    await db.write(diffState(null, onDisk), 'diff');
    const port = createRowPort<DataStateV3>({
      open: async () => db,
      legacy: NO_LEGACY,
      kv: createMemoryStore(),
      now: () => T0,
      corruptFile: () => undefined,
      decode: portDecode,
    });
    const errors: unknown[] = [];
    const persist = createPersistController<DataStateV3>(port, {
      now: () => T0,
      decode: (value) => ({ kind: 'ok', state: changingDecode(value), changed: true }),
      seed: () => makeStateV3(),
      onError: (e) => errors.push(e),
    });
    const boot = await persist.load();
    if (boot.kind !== 'loaded') throw new Error('not loaded');
    return { db, persist, loaded: boot.state, errors };
  }

  const keysIn = (db: MemoryRowDb, table: keyof RowDiff['tables']) => db.snapshot().tables[table].map(([key]) => key);

  test('changed load: a FAILED first save, then a deck delete → the deleted rows are gone; the card the decode set aside stays', async () => {
    const { db, persist, loaded, errors } = await changedBoot(twoDecksAndAnOrphan());
    expect(loaded.cards.map((c) => c.id)).toEqual(['c1', 'c2']);
    db.failWrites = 1; // the disk is full (M15)
    persist.scheduleSave(loaded); // the engine's boot update
    expect(await persist.flush()).toMatchObject({ ok: false, reason: 'write' });
    persist.scheduleSave(deleteD2(loaded));
    expect(await persist.flush()).toEqual({ ok: true });
    expect(errors).toEqual(['write', null]);
    expect(keysIn(db, 'decks')).toEqual(['d1']);
    expect(keysIn(db, 'notes')).toEqual(['n1']);
    expect(keysIn(db, 'cards')).toEqual(['c1', 'c9']); // c9: set aside, never deleted (spec §3.5)
    // The next boot: deck d2 does not come back.
    const doc = await loadDoc(db);
    expect((doc.decks as { id: string }[]).map((d) => d.id)).toEqual(['d1']);
    expect((doc.cards as { id: string }[]).map((c) => c.id)).toEqual(['c1', 'c9']);
  });

  test('changed load: a delete inside the first 400 ms (before the first commit) reaches the disk too', async () => {
    const { db, persist, loaded } = await changedBoot(twoDecksAndAnOrphan());
    persist.scheduleSave(loaded); // the engine's boot update …
    persist.scheduleSave(deleteD2(loaded)); // … and the user's delete, in the same debounce
    expect(await persist.flush()).toEqual({ ok: true });
    expect(keysIn(db, 'decks')).toEqual(['d1']);
    expect(keysIn(db, 'notes')).toEqual(['n1']);
    expect(keysIn(db, 'cards')).toEqual(['c1', 'c9']);
  });

  test('changed load: an undo of a loaded rating before the first commit deletes its revlog row', async () => {
    const onDisk = rate(rate(twoDecksAndAnOrphan(), 'c1', 1), 'c2', 2);
    const { db, persist, loaded } = await changedBoot(onDisk);
    expect(db.snapshot().revlog.map((r) => r.seq)).toEqual([1, 2]);
    persist.scheduleSave(undo(loaded));
    expect(await persist.flush()).toEqual({ ok: true });
    expect(db.snapshot().revlog.map((r) => r.seq)).toEqual([1]);
    expect((await loadDoc(db)).reviewLog).toEqual(undo(loaded).reviewLog);
  });

  test('changed load without a usable port decode (none, null, or a throw) → that save keeps EVERY loaded row (the safe old rule)', async () => {
    const throws = () => {
      throw new Error('migrate bug');
    };
    for (const portDecode of [undefined, () => null, throws]) {
      const { db, persist, loaded } = await changedBoot(twoDecksAndAnOrphan(), { portDecode });
      persist.scheduleSave(deleteD2(loaded));
      expect(await persist.flush()).toEqual({ ok: true });
      expect(keysIn(db, 'decks')).toEqual(['d1', 'd2']);
      expect(keysIn(db, 'cards')).toEqual(['c1', 'c2', 'c9']);
    }
  });

  test('a rows document the decode calls INVALID: after the corrupt copy, the seed save REPLACES every row (the old library never comes back)', async () => {
    const db = createMemoryRowDb();
    const onDisk = rate(twoDecksAndAnOrphan(), 'c1', 1);
    await db.write(diffState(null, onDisk), 'diff');
    const corrupt: string[] = [];
    const port = createRowPort<DataStateV3>({
      open: async () => db,
      legacy: NO_LEGACY,
      kv: createMemoryStore(),
      now: () => T0,
      corruptFile: (raw) => {
        corrupt.push(raw);
      },
      decode: () => null,
    });
    const persist = createPersistController<DataStateV3>(port, {
      now: () => T0,
      decode: () => ({ kind: 'invalid' }),
      seed: () => makeStateV3(),
    });
    const boot = await persist.load();
    expect(boot.kind).toBe('corrupt');
    expect(corrupt).toHaveLength(1); // the copy is kept FIRST
    expect(await persist.flush()).toEqual({ ok: true }); // the controller's seed save
    expect(port.stats().lastSave?.mode).toBe('replace');
    expect(keysIn(db, 'decks')).toEqual([]);
    expect(keysIn(db, 'cards')).toEqual([]); // c9 too: the whole document was unusable
    expect(db.snapshot().revlog).toEqual([]);
    const doc = await loadDoc(db);
    expect(doc.cards).toEqual([]);
    expect(doc.settings).toEqual(makeStateV3().settings);
  });

  /** The row port and the persist controller over `db`, with a decode that calls every document INVALID. */
  function invalidBoot(db: RowDb) {
    const corrupt: string[] = [];
    const kv = createMemoryStore();
    const port = createRowPort<DataStateV3>({
      open: async () => db,
      legacy: NO_LEGACY,
      kv,
      now: () => T0,
      corruptFile: (raw) => {
        corrupt.push(raw);
      },
      decode: () => null,
    });
    const persist = createPersistController<DataStateV3>(port, {
      now: () => T0,
      decode: () => ({ kind: 'invalid' }),
      seed: () => makeStateV3(),
    });
    return { corrupt, kv, port, persist };
  }

  test('an INVALID rows document: the corrupt copy carries the REVLOG rows, so the seed replace never loses the study history', async () => {
    const db = createMemoryRowDb();
    const onDisk = rate(rate(twoDecksAndAnOrphan(), 'c1', 1), 'c2', 2);
    await db.write(diffState(null, onDisk), 'diff');
    // Older history: a rating that already left the 400-entry undo window (it is only in the revlog).
    const old: RevlogRow = { seq: 0, cardId: 'c1', deckId: 'd1', atMs: T0 - 5000, rating: 'again', bucket: 'review', ivlBefore: 4, ivlAfter: 1, easeAfter: 2.3, durationMs: 900 };
    await db.writeRevlog([old]);
    const history = db.snapshot().revlog;
    expect(history.map((r) => r.seq)).toEqual([0, 1, 2]);

    const { corrupt, kv, persist } = invalidBoot(db);
    expect((await persist.load()).kind).toBe('corrupt');
    expect(corrupt).toHaveLength(1);
    const copy = JSON.parse(corrupt[0]) as Record<string, unknown>;
    // The whole history, in the shape of a backup file's `revlog` …
    expect(copy.revlog).toEqual(history);
    // … next to the stored document itself.
    expect((copy.cards as { id: string }[]).map((c) => c.id)).toEqual(keysIn(db, 'cards'));
    expect(copy.schemaVersion).toBe(3);
    // The kv copy is the same text.
    const kvCopies = Object.entries(kv.snapshot()).filter(([key]) => key.startsWith('maranki.state.corrupt.'));
    expect(kvCopies.map(([, text]) => text)).toEqual(corrupt);

    // The seed save still REPLACES every row (the old library never comes back).
    expect(await persist.flush()).toEqual({ ok: true });
    expect(db.snapshot().revlog).toEqual([]);
    expect(keysIn(db, 'cards')).toEqual([]);
  });

  test('an INVALID rows document whose revlog cannot be read: no copy, read-blocked, and NOTHING is replaced', async () => {
    const db = createMemoryRowDb();
    await db.write(diffState(null, rate(twoDecksAndAnOrphan(), 'c1', 1)), 'diff');
    const before = db.snapshot();
    // The tables read fine, but the revlog read fails (a damaged page of the file).
    const broken: MemoryRowDb = Object.assign(Object.create(db) as MemoryRowDb, {
      readRevlog: () => Promise.reject(new Error('disk I/O error')),
    });
    const { corrupt, persist } = invalidBoot(broken);
    expect(await persist.load()).toMatchObject({ kind: 'blocked', reason: 'read' });
    expect(corrupt).toEqual([]);
    expect(await persist.flush()).toEqual({ ok: false, reason: 'blocked' });
    expect(db.snapshot()).toEqual(before);
  });

  test('a rows document with a meta key "revlog" of its own: the history in the corrupt copy goes under "_revlog" (no key twice)', async () => {
    const db = createMemoryRowDb();
    await db.write(diffState(null, { ...rate(twoDecksAndAnOrphan(), 'c1', 1), revlog: 'mine' } as DataStateV3), 'diff');
    const { corrupt, persist } = invalidBoot(db);
    await persist.load();
    const copy = JSON.parse(corrupt[0]) as Record<string, unknown>;
    expect(copy.revlog).toBe('mine');
    expect(copy._revlog).toEqual(db.snapshot().revlog);
    expect(corrupt[0].match(/"revlog":/g)).toHaveLength(1);
  });

  test('the revlog store reads one card or all rows, oldest first, and writes backup rows (bad ones left out)', async () => {
    let s = library();
    s = rate(rate(rate(s, 'c1', 1), 'c2', 2), 'c1', 3);
    const { db, port } = await booted(library());
    await port.save(s, library());
    expect((await port.revlog.forCard('c1')).map((r) => r.seq)).toEqual([1, 3]);
    expect((await port.revlog.all()).map((r) => r.seq)).toEqual([1, 2, 3]);
    const wrote = await port.revlog.write([
      { seq: 10, cardId: 'c3', deckId: 'd1', atMs: T0, rating: 'hard', bucket: 'review', ivlBefore: 2, ivlAfter: 3, easeAfter: Number.NaN, durationMs: -5 },
      { seq: 1.5, cardId: 'c3' },
      { cardId: 'c3' },
      'nope',
    ]);
    expect(wrote).toBe(1);
    const ten = (await port.revlog.forCard('c3'))[0] as RevlogRow;
    expect(ten).toMatchObject({ seq: 10, easeAfter: 0, durationMs: null });
    expect(db.snapshot().revlog).toHaveLength(4);
  });
});

/* ------------------------------------------------- the real SQL layer */

/**
 * A small fake of expo-sqlite that runs EXACTLY the row store's statements
 * (rowSql, revlogSql, SCHEMA_SQL) on in-memory tables with rowids, like
 * SQLite: an upsert keeps the rowid, a new row gets the next one, a
 * transaction is all or nothing, TEXT NOT NULL refuses a non-string.
 */
interface FakeRow {
  rowid: number;
  [col: string]: unknown;
}
class FakeSql implements SqlDatabase {
  tables = new Map<string, FakeRow[]>();
  userVersion = 0;
  wal = false;
  schemaRuns = 0;
  transactions = 0;
  busyTimeouts = 0;
  statements: string[] = [];
  /** A statement matching this throws (inside a transaction: it rolls back). */
  failOn: RegExp | null = null;
  /** The last rowid given out (SQLite gives a new row the next one). */
  private rowid = 0;

  constructor() {
    for (const t of ['meta', 'decks', 'note_types', 'notes', 'cards', 'lists', 'sessions', 'revlog']) this.tables.set(t, []);
  }

  private rows(t: string): FakeRow[] {
    const rows = this.tables.get(t);
    if (!rows) throw new Error(`no such table: ${t}`);
    return rows;
  }

  private sorted(t: string): FakeRow[] {
    return [...this.rows(t)].sort((a, b) => a.rowid - b.rowid);
  }

  async execAsync(source: string) {
    this.statements.push(source);
    if (this.failOn?.test(source)) throw new Error('fake failure');
    if (source === rowSql.wal) this.wal = true;
    else if (source === SCHEMA_SQL) this.schemaRuns += 1;
    else if (source === rowSql.busyTimeout) this.busyTimeouts += 1;
    else if (/^PRAGMA user_version = (\d+)$/.test(source)) this.userVersion = Number(/(\d+)$/.exec(source)![1]);
    else throw new Error(`fake: unknown exec ${source}`);
  }

  async runAsync(source: string, params: unknown[]) {
    this.statements.push(source);
    if (this.failOn?.test(source)) throw new Error('fake failure');
    let m: RegExpExecArray | null;
    if ((m = /^DELETE FROM (\w+)$/.exec(source))) {
      this.tables.set(m[1], []);
    } else if ((m = /^DELETE FROM meta WHERE key NOT IN/.exec(source))) {
      this.tables.set('meta', this.rows('meta').filter((r) => params.includes(r.key)));
    } else if ((m = /^DELETE FROM (\w+) WHERE (id|key|seq) IN/.exec(source))) {
      const [, t, col] = m;
      this.tables.set(t, this.rows(t).filter((r) => !params.includes(r[col])));
    } else if ((m = /^INSERT INTO (\w+) \(([^)]+)\) VALUES .* ON CONFLICT\((\w+)\)/.exec(source))) {
      const [, t, colList, keyCol] = m;
      const cols = colList.split(', ');
      for (let i = 0; i < params.length; i += cols.length) {
        const values = Object.fromEntries(cols.map((c, j) => [c, params[i + j]]));
        for (const c of cols) if (typeof values[c] !== 'string') throw new Error(`NOT NULL constraint failed: ${t}.${c}`);
        const found = this.rows(t).find((r) => r[keyCol] === values[keyCol]);
        if (found) Object.assign(found, values);
        else this.rows(t).push({ rowid: ++this.rowid, ...values });
      }
    } else if ((m = /^INSERT OR (REPLACE|IGNORE) INTO revlog \(([^)]+)\)/.exec(source))) {
      const [, how, colList] = m;
      const cols = colList.split(', ');
      for (let i = 0; i < params.length; i += cols.length) {
        const values = Object.fromEntries(cols.map((c, j) => [c, params[i + j]]));
        const at = this.rows('revlog').findIndex((r) => r.seq === values.seq);
        if (at >= 0 && how === 'IGNORE') continue;
        if (at >= 0) this.rows('revlog').splice(at, 1);
        this.rows('revlog').push({ rowid: ++this.rowid, ...values });
      }
    } else throw new Error(`fake: unknown run ${source}`);
    return { changes: 1, lastInsertRowId: this.rowid };
  }

  async getFirstAsync<T>(source: string, params: unknown[]): Promise<T | null> {
    this.statements.push(source);
    if (this.failOn?.test(source)) throw new Error('fake failure');
    let m: RegExpExecArray | null;
    if (source === rowSql.userVersion) return { user_version: this.userVersion } as T;
    if ((m = /^SELECT 1 AS one FROM (\w+) LIMIT 1$/.exec(source))) return (this.rows(m[1]).length > 0 ? { one: 1 } : null) as T | null;
    if (source === rowSql.revlogTop) {
      // MAX() of an empty table is NULL in SQLite.
      const seqs = this.rows('revlog').map((r) => Number(r.seq));
      return { top: seqs.length > 0 ? Math.max(...seqs) : null } as T;
    }
    if ((m = /^SELECT json_group_array\(json\(json\) ORDER BY rowid\) AS a FROM (\w+)$/.exec(source))) {
      // json() fails on a malformed row, like SQLite ("malformed JSON").
      const texts = this.sorted(m[1]).map((r) => JSON.stringify(JSON.parse(String(r.json))));
      return { a: `[${texts.join(',')}]` } as T;
    }
    void params;
    throw new Error(`fake: unknown getFirst ${source}`);
  }

  async getAllAsync<T>(source: string, params: unknown[]): Promise<T[]> {
    this.statements.push(source);
    if (this.failOn?.test(source)) throw new Error('fake failure');
    let m: RegExpExecArray | null;
    if (source === rowSql.readMeta) return this.sorted('meta').map((r) => ({ key: r.key, json: r.json })) as T[];
    if ((m = /^SELECT json FROM (\w+) ORDER BY rowid$/.exec(source))) return this.sorted(m[1]).map((r) => ({ json: r.json })) as T[];
    if (source === revlogSql.selectAll) return [...this.rows('revlog')].sort((a, b) => Number(a.seq) - Number(b.seq)) as unknown as T[];
    if (source === revlogSql.selectCard) {
      return this.rows('revlog')
        .filter((r) => r.card_id === params[0])
        .sort((a, b) => Number(a.seq) - Number(b.seq)) as unknown as T[];
    }
    throw new Error(`fake: unknown getAll ${source}`);
  }

  async withExclusiveTransactionAsync(task: (txn: SqlRunner) => Promise<void>) {
    this.transactions += 1;
    const saved = new Map([...this.tables].map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]));
    try {
      await task(this);
    } catch (error) {
      this.tables = saved; // ROLLBACK
      throw error;
    }
  }
}

describe('sqliteRowDb (the SQL the phone runs) on a fake SQLite', () => {
  test('openRowDb opens maranki-rows.db — its own file, not the kv file', async () => {
    const sql = new FakeSql();
    jest.mocked(openDatabaseAsync).mockResolvedValue(sql as unknown as SQLiteDatabase);
    const db = await openRowDb();
    expect(openDatabaseAsync).toHaveBeenCalledWith(ROWS_DB_NAME);
    expect(ROWS_DB_NAME).toBe('maranki-rows.db');
    await db.ensureSchema();
    expect(sql.wal).toBe(true);
  });

  test('ensureSchema: WAL, the tables, user_version 1 — and a newer version is never lowered', async () => {
    const sql = new FakeSql();
    await sqliteRowDb(sql).ensureSchema();
    expect(sql.wal).toBe(true);
    expect(sql.schemaRuns).toBe(1);
    expect(sql.userVersion).toBe(ROW_LAYOUT_VERSION);
    sql.userVersion = 5;
    await sqliteRowDb(sql).ensureSchema();
    expect(sql.userVersion).toBe(5);
  });

  test('write → load gives the state back, in order; each write is ONE exclusive transaction', async () => {
    const sql = new FakeSql();
    const db = sqliteRowDb(sql);
    await db.ensureSchema();
    let s = rate(library(), 'c1', 1);
    const marker = { kind: 'scheduled' as const, label: 'x', counts: { again: 0, hard: 0, good: 1, easy: 0 }, total: 1, bestRun: 1, durationSec: 1, fastAnswers: 0 };
    s = { ...s, sessions: [{ id: 's1', dayKey: '2026-06-10', atMs: T0, kind: 'scheduled', counts: marker.counts, total: 1, bestRun: 1, xp: 5 }] };
    await db.write(diffState(null, s), 'diff');
    expect(sql.transactions).toBe(1);
    expect(sql.busyTimeouts).toBe(1);
    expect(await loadDoc(db)).toEqual(s);
    expect(sql.tables.get('sessions')![0].day_key).toBe('2026-06-10');

    // A card put back in the middle keeps its place after the reload.
    const [c1, c2, c3] = s.cards;
    const without = { ...s, cards: [c1, c3] };
    await db.write(diffState(s, without), 'diff');
    await db.write(diffState(without, s), 'diff');
    expect((await loadDoc(db)).cards).toEqual([c1, c2, c3]);

    // An undo deletes the revlog row.
    await db.write(diffState(s, undo(s)), 'diff');
    expect(await db.readRevlog()).toEqual([]);
    expect(sql.transactions).toBe(4);
  });

  test('a statement that fails rolls the whole write back', async () => {
    const sql = new FakeSql();
    const db = sqliteRowDb(sql);
    await db.ensureSchema();
    const s = library();
    await db.write(diffState(null, s), 'diff');
    const before = JSON.stringify([...sql.tables]);
    sql.failOn = /^INSERT INTO meta/;
    await expect(db.write(diffState(s, rate(s, 'c1', 1)), 'diff')).rejects.toThrow('fake failure');
    expect(JSON.stringify([...sql.tables])).toBe(before);
  });

  test('replace mode deletes every table and keeps only the store\'s own meta keys', async () => {
    const sql = new FakeSql();
    const db = sqliteRowDb(sql);
    await db.ensureSchema();
    const s = rate(library(), 'c1', 1);
    const diff = diffState(null, s);
    diff.metaSet.push({ key: 'bootOkCount', json: '2' });
    await db.write(diff, 'diff');
    const fresh = makeStateV3();
    await db.write(diffState(null, fresh), 'replace');
    expect(sql.tables.get('cards')).toEqual([]);
    expect(sql.tables.get('revlog')).toEqual([]);
    expect(new Map(await db.readMeta()).get('bootOkCount')).toBe('2');
    expect(await loadDoc(db)).toEqual(fresh);
  });

  test('a row that is not valid JSON: the fast path fails, the per-row read leaves only that row out', async () => {
    const sql = new FakeSql();
    const db = sqliteRowDb(sql);
    await db.ensureSchema();
    const s = library();
    await db.write(diffState(null, s), 'diff');
    sql.tables.get('cards')!.push({ rowid: 999, id: 'bad', json: '{"id":"bad",' });
    const port = createRowPort({ open: async () => db, legacy: NO_LEGACY, kv: createMemoryStore(), now: () => T0 });
    const loaded = await port.load();
    expect(loaded.kind === 'doc' && (loaded.value as DataStateV3).cards).toEqual(s.cards);
    expect(port.stats().lastLoad).toMatchObject({ from: 'rows', unreadableRows: 1 });
    expect(sql.statements).toContain(rowSql.readTexts('cards'));
    // The broken row stays on the disk.
    expect(sql.tables.get('cards')!.some((r) => r.id === 'bad')).toBe(true);
  });

  test('big writes are split into statements of at most 999 bound values', async () => {
    const sql = new FakeSql();
    const db = sqliteRowDb(sql);
    await db.ensureSchema();
    const deck = makeDeckV3({ id: 'd1' });
    const groups = Array.from({ length: 700 }, (_, i) => noteWithCards({ deckId: 'd1', note: { id: `n${i}` }, card: { id: `c${i}` } }));
    const s = stateOfV3({ decks: [deck], groups });
    const counts: number[] = [];
    const run = sql.runAsync.bind(sql);
    sql.runAsync = async (source, params) => {
      counts.push(params.length);
      return run(source, params);
    };
    await db.write(diffState(null, s), 'diff');
    expect(Math.max(...counts)).toBeLessThanOrEqual(999);
    expect(sql.transactions).toBe(1);
    expect((await loadDoc(db)).cards).toEqual(s.cards);
  });

  test('the revlog reads: one card, and all rows oldest first', async () => {
    const sql = new FakeSql();
    const db = sqliteRowDb(sql);
    await db.ensureSchema();
    const s = rate(rate(library(), 'c2', 1), 'c1', 2);
    await db.write(diffState(null, s), 'diff');
    expect((await db.readRevlog()).map((r) => [r.seq, r.cardId])).toEqual([
      [1, 'c2'],
      [2, 'c1'],
    ]);
    expect((await db.readRevlog('c1')).map((r) => r.seq)).toEqual([2]);
    await db.writeRevlog([{ seq: 2, cardId: 'c1', deckId: 'd1', atMs: 5, rating: 'easy', bucket: 'review', ivlBefore: 0, ivlAfter: 9, easeAfter: 2.7, durationMs: 800 }]);
    expect((await db.readRevlog('c1'))[0]).toMatchObject({ rating: 'easy', ivlAfter: 9, durationMs: 800 });
  });

  test('highestRevlogSeq: SELECT MAX(seq) — the highest history seq, 0 for an empty table (MAX is NULL there)', async () => {
    const sql = new FakeSql();
    const db = sqliteRowDb(sql);
    await db.ensureSchema();
    await expect(db.highestRevlogSeq!()).resolves.toBe(0);
    await db.writeRevlog([
      { seq: 7, cardId: 'c1', deckId: 'd1', atMs: 5, rating: 'good', bucket: 'review', ivlBefore: 0, ivlAfter: 1, easeAfter: 2.5, durationMs: null },
      { seq: 3, cardId: 'c2', deckId: 'd1', atMs: 4, rating: 'good', bucket: 'new', ivlBefore: 0, ivlAfter: 0, easeAfter: 2.5, durationMs: null },
    ]);
    await expect(db.highestRevlogSeq!()).resolves.toBe(7);
    expect(sql.statements).toContain('SELECT MAX(seq) AS top FROM revlog');
  });
});

/* ------------------------------------------------------ the memory RowDb */

describe('createMemoryRowDb', () => {
  test('highestRevlogSeq: the highest history seq (0 when empty); a broken file rejects', async () => {
    const db: MemoryRowDb = createMemoryRowDb();
    await expect(db.highestRevlogSeq!()).resolves.toBe(0);
    await db.write(diffState(null, rate(rate(library(), 'c1', 4), 'c2', 9)), 'diff');
    await expect(db.highestRevlogSeq!()).resolves.toBe(9);
    db.failReads = true;
    await expect(db.highestRevlogSeq!()).rejects.toThrow('disk I/O error');
  });

  test('refuses a value that is not text (like TEXT NOT NULL), and changes nothing then', async () => {
    const db: MemoryRowDb = createMemoryRowDb();
    const diff = emptyDiff();
    diff.metaSet.push({ key: 'a', json: '1' }, { key: 'b', json: undefined as unknown as string });
    await expect(db.write(diff, 'diff')).rejects.toThrow('NOT NULL');
    expect(db.snapshot().meta).toEqual([]);
  });
});
