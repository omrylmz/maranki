/**
 * Tests for the boot read of the row store (spec §3.10 step 3, §3.11,
 * unit W3-3): legacyChain.ts and the row port's load.
 *
 *   rows → rows; else kv 'maranki.state' → AsyncStorage 'maranki.state.v1'
 *   → the Android RKStorage rescue. The old copies are never deleted or
 *   changed. A corrupt text is copied to files; nothing anywhere = a first
 *   boot. A read that fails anywhere = read-blocked (C1), never the seed.
 *
 * Three levels:
 *   1. the pure chain (readLegacyChain, readStoreChain, readLegacyRaw) with fakes;
 *   2. the row port over a memory RowDb, a memory kv-store and a fake
 *      AsyncStorage: what is read, what is written, and where;
 *   3. the real engine (engine.ts) on that port: the first boot copies the
 *      old data into the rows, a kill before the copy commits copies again,
 *      a second boot reads only the rows, and the M5 marker is banked once.
 *
 * No native module is used: every store is in memory.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import type { DataStateV3, RevlogRow } from '../../domain/model';
import { CURRENT_SCHEMA, type DataState } from '../../domain/types';
import { createClock, FIXED_NOW, type TestClock } from '../../test/clock';
import { stateFixtureRaw } from '../../test/factories';
import { makeDeckV3, noteWithCards, stateOfV3 } from '../../test/factoriesV3';
import { backupStamp } from '../backup';
import { createEngine, type Engine } from '../engine';
import { migrate } from '../migrate';
import { SAVE_DEBOUNCE_MS } from '../persistController';
import { STORAGE_KEY } from '../persistence';
import { LegacyReadError } from './copyForward';
import { KV_CORRUPT_PREFIX, KV_STATE_KEY } from './kvStoragePort';
import {
  copiedFromOf,
  readLegacyChain,
  readLegacyRaw,
  readStoreChain,
  type LegacyChainSources,
} from './legacyChain';
import { createMemoryStore, type MemoryStore } from './memoryPort';
import { diffState, ROW_TABLES } from './rowDiff';
import { createMemoryRowDb, createRowPort, RowStoreError, type MemoryRowDb, type RowDb, type RowPort } from './rowStore';

const T0 = FIXED_NOW;
const V1_RAW = stateFixtureRaw('v1-main-1333d48');

/* ------------------------------------------------------- 1. the pure chain */

/** Fake old sources: each one is a jest.fn, so a test sees what was read. */
function sources(over: Partial<{ kv: string | null | Error; asyncStorage: string | null | Error; rescue: string | null }> = {}) {
  const answer = (v: string | null | Error | undefined) => async () => {
    if (v instanceof Error) throw v;
    return v ?? null;
  };
  const readKv = jest.fn(answer(over.kv));
  const readAsyncStorage = jest.fn(answer(over.asyncStorage));
  const rescue = jest.fn(async () => over.rescue ?? null);
  const legacy: LegacyChainSources = { readKv, readAsyncStorage, rescue };
  return { legacy, readKv, readAsyncStorage, rescue };
}

describe('readLegacyChain — kv → AsyncStorage → rescue', () => {
  test('kv has the data → it is used; AsyncStorage and the rescue are never read', async () => {
    const s = sources({ kv: 'KV', asyncStorage: 'OLD' });
    await expect(readLegacyChain(s.legacy)).resolves.toEqual({ source: 'kv', key: KV_STATE_KEY, raw: 'KV' });
    expect(s.readAsyncStorage).not.toHaveBeenCalled();
    expect(s.rescue).not.toHaveBeenCalled();
  });

  test('kv empty → AsyncStorage', async () => {
    const s = sources({ kv: '', asyncStorage: 'OLD' });
    await expect(readLegacyChain(s.legacy)).resolves.toEqual({ source: 'asyncStorage', key: STORAGE_KEY, raw: 'OLD' });
    expect(s.rescue).not.toHaveBeenCalled();
  });

  test('AsyncStorage cannot read the big value → the rescue', async () => {
    const s = sources({ asyncStorage: new Error('Row too big to fit into CursorWindow'), rescue: 'RESCUED' });
    await expect(readLegacyChain(s.legacy)).resolves.toEqual({ source: 'rkRescue', key: STORAGE_KEY, raw: 'RESCUED' });
  });

  test('the rescue finds nothing → LegacyReadError (read-blocked, never the seed)', async () => {
    const s = sources({ asyncStorage: new Error('CursorWindow') });
    await expect(readLegacyChain(s.legacy)).rejects.toBeInstanceOf(LegacyReadError);
  });

  test('no rescue (iOS) → a failed AsyncStorage read rejects', async () => {
    const s = sources({ asyncStorage: new Error('read failed') });
    await expect(readLegacyChain({ ...s.legacy, rescue: undefined })).rejects.toBeInstanceOf(LegacyReadError);
  });

  test('a kv read that FAILS rejects; the older AsyncStorage copy is never used instead', async () => {
    const s = sources({ kv: new Error('database is locked'), asyncStorage: 'OLD' });
    await expect(readLegacyChain(s.legacy)).rejects.toThrow('database is locked');
    expect(s.readAsyncStorage).not.toHaveBeenCalled();
  });

  test('nothing anywhere → null (a genuine first boot)', async () => {
    await expect(readLegacyChain(sources().legacy)).resolves.toBeNull();
  });

  test('readLegacyRaw never rejects; a failed kv read gives null (not the older copy)', async () => {
    await expect(readLegacyRaw(sources({ kv: 'KV' }).legacy)).resolves.toBe('KV');
    await expect(readLegacyRaw(sources({ kv: new Error('x'), asyncStorage: 'OLD' }).legacy)).resolves.toBeNull();
    await expect(readLegacyRaw(sources({ asyncStorage: new Error('x') }).legacy)).resolves.toBeNull();
  });

  test('copiedFromOf records the source, the key, the time and the length', () => {
    expect(copiedFromOf({ source: 'kv', key: KV_STATE_KEY, raw: 'abc' }, T0)).toEqual({
      source: 'kv',
      key: 'maranki.state',
      at: T0,
      length: 3,
    });
  });
});

describe('readStoreChain — the rows first', () => {
  test('rows → rows; the old places are never read', async () => {
    const s = sources({ kv: 'KV' });
    await expect(readStoreChain(async () => ({ doc: 1 }), s.legacy)).resolves.toEqual({ from: 'rows', rows: { doc: 1 } });
    expect(s.readKv).not.toHaveBeenCalled();
  });

  test('a rows read that fails rejects, even when the kv copy is readable', async () => {
    const s = sources({ kv: 'KV' });
    await expect(readStoreChain(() => Promise.reject(new Error('disk I/O error')), s.legacy)).rejects.toThrow('disk I/O error');
    expect(s.readKv).not.toHaveBeenCalled();
  });

  test('rows empty → the legacy chain; nothing → "nothing"', async () => {
    await expect(readStoreChain(async () => null, sources({ kv: 'KV' }).legacy)).resolves.toMatchObject({ from: 'legacy', found: { source: 'kv' } });
    await expect(readStoreChain(async () => null, sources().legacy)).resolves.toEqual({ from: 'nothing' });
  });
});

/* -------------------------------------------- 2. the row port's load */

interface Phone {
  rows: MemoryRowDb;
  kv: MemoryStore;
  /** The AsyncStorage document (null = nothing stored; an Error = the read fails). */
  asyncStorage: string | null | Error;
  rescue: string | null;
  asyncStorageReads: number;
  corruptFiles: { raw: string; stamp: string }[];
}

function phone(over: Partial<Phone> = {}): Phone {
  return { rows: createMemoryRowDb(), kv: createMemoryStore(), asyncStorage: null, rescue: null, asyncStorageReads: 0, corruptFiles: [], ...over };
}

/**
 * The row port of one app run on `p` (Android: with the rescue). `decode`:
 * the port's decode of a loaded document (the app passes migrate()'s state);
 * left out, the first save after a changed load keeps every loaded row.
 */
function portOn<S = DataStateV3>(
  p: Phone,
  now: () => number = () => T0,
  open?: () => Promise<RowDb>,
  decode?: (doc: Record<string, unknown>) => object | null,
): RowPort<S> {
  return createRowPort<S>({
    open: open ?? (async () => p.rows),
    kv: p.kv,
    now,
    decode,
    corruptFile: (raw, stamp) => {
      p.corruptFiles.push({ raw, stamp });
    },
    legacy: {
      readKv: () => p.kv.getItem(KV_STATE_KEY),
      readAsyncStorage: async () => {
        p.asyncStorageReads += 1;
        if (p.asyncStorage instanceof Error) throw p.asyncStorage;
        return p.asyncStorage;
      },
      rescue: async () => p.rescue,
    },
  });
}

const meta = (db: MemoryRowDb) => new Map(db.snapshot().meta.map(([k, v]) => [k, JSON.parse(v) as unknown]));

/** A small v3 library. */
function library(): DataStateV3 {
  const deck = makeDeckV3({ id: 'd1' });
  return stateOfV3({ decks: [deck], groups: [noteWithCards({ deckId: 'd1', note: { id: 'n1' }, card: { id: 'c1' } })] });
}

/** One history row of card c1, as the revlog table holds it. */
function historyRow(seq: number, over: Partial<RevlogRow> = {}): RevlogRow {
  return { seq, cardId: 'c1', deckId: 'd1', atMs: T0 - 10_000 + seq, rating: 'good', bucket: 'review', ivlBefore: 2, ivlAfter: 5, easeAfter: 2.5, durationMs: null, ...over };
}

/** A review-log entry of card c1 (a review rated Again), as a save stores it. `prev` keys may be changed. */
function reviewEntry(seq: number, prev: Record<string, unknown> = {}) {
  return {
    id: `r${seq}`,
    seq,
    cardId: 'c1',
    deckId: 'd1',
    rating: 'again' as const,
    atMs: T0 - 10_000 + seq,
    bucket: 'review' as const,
    prev: { ease: 2.5, intervalDays: 4, stepIndex: null, reps: 3, lapses: 0, due: T0 - 1000, lastReviewedAt: T0 - 86_400_000, ...prev },
  };
}

/** The app's decode (storage/index.ts decodedState): migrate()'s state, or null. */
const appDecode = (doc: Record<string, unknown>): object | null => {
  const out = migrate(doc, T0);
  return out.kind === 'ok' ? out.state : null;
};

/** The memory RowDb `db` WITHOUT highestRevlogSeq (a RowDb from elsewhere may not have it). */
function withoutTop(db: MemoryRowDb): RowDb {
  return {
    ensureSchema: () => db.ensureSchema(),
    hasRows: () => db.hasRows(),
    readMeta: () => db.readMeta(),
    readTableJson: (t) => db.readTableJson(t),
    readTableTexts: (t) => db.readTableTexts(t),
    write: (d, m) => db.write(d, m),
    writeRevlog: (r) => db.writeRevlog(r),
    readRevlog: (c) => db.readRevlog(c),
  };
}

describe('the row port knows the highest seq of its history table (so a seq is never given twice)', () => {
  test('read with each rows load, raised by every commit and every revlog.write, never lowered', async () => {
    const p = phone();
    // History rows 1 and 5 on the disk; the review log of the document has none.
    await p.rows.write(diffState(null, library()), 'diff');
    await p.rows.writeRevlog([historyRow(1), historyRow(5)]);
    const port = portOn(p);
    expect(port.highestRevlogSeq()).toBe(0); // no load yet
    await port.load();
    expect(port.highestRevlogSeq()).toBe(5);
    // A restore writes the backup's history: raised by the rows written (not by a row it leaves out).
    await expect(port.revlog.write([historyRow(9), { seq: 50 }])).resolves.toBe(1);
    expect(port.highestRevlogSeq()).toBe(9);
    // A replace deletes the history, but the number is never lowered (a gap is harmless).
    await port.replaceAll(library());
    expect(p.rows.snapshot().revlog).toEqual([]);
    expect(port.highestRevlogSeq()).toBe(9);
    // A save that writes a history row with a higher seq raises it.
    await port.save({ ...library(), reviewLog: [reviewEntry(12)] }, library());
    expect(p.rows.snapshot().revlog.map((r) => r.seq)).toEqual([12]);
    expect(port.highestRevlogSeq()).toBe(12);
  });

  test('a RowDb without highestRevlogSeq is asked with readRevlog(); a read that fails rejects the load (C1)', async () => {
    const p = phone();
    await p.rows.write(diffState(null, library()), 'diff');
    await p.rows.writeRevlog([historyRow(4), historyRow(2)]);
    const plain = portOn(p, () => T0, async () => withoutTop(p.rows));
    await plain.load();
    expect(plain.highestRevlogSeq()).toBe(4);
    const broken: RowDb = {
      ...withoutTop(p.rows),
      highestRevlogSeq: async () => {
        throw new Error('disk I/O error');
      },
    };
    await expect(portOn(p, () => T0, async () => broken).load()).rejects.toThrow('disk I/O error');
  });

  test('a load from the old storage (the row store is empty) has no history: 0', async () => {
    const p = phone();
    await p.kv.setItem(KV_STATE_KEY, V1_RAW);
    const port = portOn(p);
    await port.load();
    expect(port.highestRevlogSeq()).toBe(0);
  });
});

describe('the row port load: where the data comes from', () => {
  test('rows → rows: the kv-store and AsyncStorage are never read', async () => {
    const p = phone({ asyncStorage: 'OLD' });
    await p.rows.write(diffState(null, library()), 'diff');
    await p.kv.setItem(KV_STATE_KEY, 'KV');
    const port = portOn(p);
    await expect(port.load()).resolves.toEqual({ kind: 'doc', value: library() });
    expect(p.asyncStorageReads).toBe(0);
    expect(port.stats().lastLoad).toMatchObject({ from: 'rows', unreadableRows: 0 });
  });

  test('kv → used as is; the first save copies it into the rows with meta.copiedFrom; kv is never changed', async () => {
    const p = phone({ asyncStorage: 'OLDER' });
    await p.kv.setItem(KV_STATE_KEY, JSON.stringify(library()));
    const kvBefore = p.kv.snapshot();
    const kvWrites = p.kv.writes;
    const port = portOn(p);
    const loaded = await port.load();
    expect(loaded).toMatchObject({ kind: 'doc', raw: JSON.stringify(library()) });
    expect(p.asyncStorageReads).toBe(0);
    expect(p.rows.writes).toBe(0); // the load only READS
    const state = (loaded as { value: DataStateV3 }).value;
    // Even with prev = the loaded state, the first save writes EVERY row (the rows were empty).
    await port.save(state, state);
    expect(p.rows.writes).toBe(1);
    expect(meta(p.rows).get('copiedFrom')).toEqual({ source: 'kv', key: 'maranki.state', at: T0, length: JSON.stringify(library()).length });
    expect(meta(p.rows).get('bootOkCount')).toBe(1);
    expect(p.kv.snapshot()).toEqual(kvBefore);
    expect(p.kv.writes).toBe(kvWrites);
    // The next run reads the rows.
    await expect(portOn(p).load()).resolves.toEqual({ kind: 'doc', value: library() });
  });

  test('AsyncStorage → copied into the rows (source asyncStorage); AsyncStorage is only read', async () => {
    const p = phone({ asyncStorage: V1_RAW });
    const port = portOn(p);
    await expect(port.load()).resolves.toMatchObject({ kind: 'doc', raw: V1_RAW });
    await port.save(library(), null);
    expect(meta(p.rows).get('copiedFrom')).toMatchObject({ source: 'asyncStorage', key: 'maranki.state.v1' });
    expect(p.kv.writes).toBe(0);
  });

  test('Android rescue → copied into the rows (source rkRescue)', async () => {
    const p = phone({ asyncStorage: new Error('Row too big to fit into CursorWindow'), rescue: V1_RAW });
    const port = portOn(p);
    await expect(port.load()).resolves.toMatchObject({ kind: 'doc', raw: V1_RAW });
    await port.save(library(), null);
    expect(meta(p.rows).get('copiedFrom')).toMatchObject({ source: 'rkRescue', key: 'maranki.state.v1', length: V1_RAW.length });
  });

  test('the rescue finds nothing → the load rejects and nothing is written anywhere', async () => {
    const p = phone({ asyncStorage: new Error('CursorWindow') });
    await expect(portOn(p).load()).rejects.toBeInstanceOf(LegacyReadError);
    expect(p.rows.writes).toBe(0);
    expect(p.kv.writes).toBe(0);
  });

  test('a kv read that fails → the load rejects (never the older AsyncStorage copy)', async () => {
    const p = phone({ asyncStorage: V1_RAW });
    p.kv.getItem = async () => {
      throw new Error('database is locked');
    };
    await expect(portOn(p).load()).rejects.toThrow('database is locked');
    expect(p.asyncStorageReads).toBe(0);
  });

  test('corrupt kv text → { kind: corrupt }; preserveCorrupt keeps it in the kv file AND a file', async () => {
    const p = phone();
    await p.kv.setItem(KV_STATE_KEY, '{"cards":[{"id":"c1","front":"Hal');
    const port = portOn(p);
    const loaded = await port.load();
    expect(loaded).toEqual({ kind: 'corrupt', raw: '{"cards":[{"id":"c1","front":"Hal' });
    await port.preserveCorrupt('{"cards":[{"id":"c1","front":"Hal');
    const stamp = backupStamp(new Date(T0));
    expect(p.kv.snapshot()[`${KV_CORRUPT_PREFIX}${stamp}`]).toBe('{"cards":[{"id":"c1","front":"Hal');
    expect(p.corruptFiles).toEqual([{ raw: '{"cards":[{"id":"c1","front":"Hal', stamp }]);
    // The seed is saved to the ROWS; no copiedFrom (nothing was copied).
    await port.save(library(), null);
    expect(meta(p.rows).has('copiedFrom')).toBe(false);
    expect(p.kv.snapshot()[KV_STATE_KEY]).toBe('{"cards":[{"id":"c1","front":"Hal'); // the old copy stays
  });

  test('nothing anywhere → empty (first boot); the seed is then written to the rows', async () => {
    const p = phone();
    const port = portOn(p);
    await expect(port.load()).resolves.toEqual({ kind: 'empty' });
    await port.save(library(), null);
    expect(meta(p.rows).get('schemaVersion')).toBe(3);
    expect(meta(p.rows).get('bootOkCount')).toBe(1);
  });

  test('firstCopyPending: true after a load from an OLD place, until the copy commits; never for rows, nothing, or a corrupt text', async () => {
    const fromKv = phone();
    await fromKv.kv.setItem(KV_STATE_KEY, JSON.stringify(library()));
    const port = portOn(fromKv);
    expect(port.firstCopyPending()).toBe(false); // no load yet
    await port.load();
    expect(port.firstCopyPending()).toBe(true);
    fromKv.rows.failWrites = 1;
    await expect(port.save(library(), null)).rejects.toThrow('disk is full');
    expect(port.firstCopyPending()).toBe(true); // a failed copy still waits
    await port.save(library(), null);
    expect(port.firstCopyPending()).toBe(false);
    // The rows now hold the data: a new run has nothing to copy.
    const next = portOn(fromKv);
    await next.load();
    expect(next.firstCopyPending()).toBe(false);

    const empty = portOn(phone());
    await empty.load();
    expect(empty.firstCopyPending()).toBe(false);
    const corrupt = phone();
    await corrupt.kv.setItem(KV_STATE_KEY, '{"broken":');
    const corruptPort = portOn(corrupt);
    await corruptPort.load();
    expect(corruptPort.firstCopyPending()).toBe(false);
  });

  test('a kv DOCUMENT the controller declares corrupt (preserveCorrupt): no first copy waits any more, and the seed save records NO copiedFrom', async () => {
    const p = phone();
    const raw = JSON.stringify({ ...library(), settings: 'x' }); // JSON reads it; migrate() says 'invalid'
    await p.kv.setItem(KV_STATE_KEY, raw);
    const port = portOn(p);
    await expect(port.load()).resolves.toMatchObject({ kind: 'doc', raw });
    expect(port.firstCopyPending()).toBe(true); // a document: the port cannot know yet
    await port.preserveCorrupt(raw); // the controller: unusable, keep a copy, save the seed
    expect(port.firstCopyPending()).toBe(false);
    expect(p.corruptFiles.map((f) => f.raw)).toEqual([raw]);
    await port.save(library(), null);
    expect(port.stats().lastSave?.mode).toBe('full');
    expect(meta(p.rows).has('copiedFrom')).toBe(false);
    expect(meta(p.rows).get('bootOkCount')).toBe(1);
    expect(port.firstCopyPending()).toBe(false);
  });

  test('a restore or a factory reset before the first copy (replaceAll) records NO copiedFrom: the rows do not hold the old copy', async () => {
    const p = phone();
    await p.kv.setItem(KV_STATE_KEY, JSON.stringify({ schemaVersion: 99, minReaderVersion: 99 })); // too new: the boot is blocked
    const port = portOn(p);
    await port.load();
    await port.replaceAll(library()); // the user chose "Erase everything" or a backup
    expect(meta(p.rows).has('copiedFrom')).toBe(false);
    expect(meta(p.rows).get('bootOkCount')).toBe(1);
    expect(port.firstCopyPending()).toBe(false);
    // Also when the replace fails first and the save after it retries it.
    const q = phone();
    await q.kv.setItem(KV_STATE_KEY, JSON.stringify(library()));
    const again = portOn(q);
    await again.load();
    q.rows.failWrites = 1;
    await expect(again.replaceAll(library())).rejects.toThrow('disk is full');
    await again.save(library(), null);
    expect(again.stats().lastSave?.mode).toBe('replace');
    expect(meta(q.rows).has('copiedFrom')).toBe(false);
  });

  test('rows without schemaVersion (damaged) → reject; nothing is written, the old copies are not read', async () => {
    const p = phone({ asyncStorage: V1_RAW });
    const diff = diffState(null, library());
    diff.metaSet = diff.metaSet.filter((m) => m.key !== 'schemaVersion');
    await p.rows.write(diff, 'diff');
    const writes = p.rows.writes;
    await expect(portOn(p).load()).rejects.toBeInstanceOf(RowStoreError);
    expect(p.rows.writes).toBe(writes);
    expect(p.asyncStorageReads).toBe(0);
  });

  test('a meta row that is not valid JSON → reject (never written over)', async () => {
    const p = phone();
    const diff = diffState(null, library());
    diff.metaSet = diff.metaSet.map((m) => (m.key === 'person' ? { key: 'person', json: '{"xp":' } : m));
    await p.rows.write(diff, 'diff');
    await expect(portOn(p).load()).rejects.toThrow('"person"');
  });

  test('the row file cannot be opened (or a read fails) → reject; a later load tries to open again', async () => {
    const p = phone();
    let attempts = 0;
    const open = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('unable to open database file');
      return p.rows;
    };
    const port = portOn(p, () => T0, open);
    await expect(port.load()).rejects.toThrow('unable to open');
    await expect(port.load()).resolves.toEqual({ kind: 'empty' });
    p.rows.failReads = true;
    await expect(portOn(p).load()).rejects.toThrow('disk I/O error');
  });
});

describe('readRaw ("Save a copy of the raw data") never rejects', () => {
  test('rows → one text of the stored rows, readable as the same document', async () => {
    const p = phone();
    await p.rows.write(diffState(null, library()), 'diff');
    const raw = await portOn(p).readRaw();
    expect(JSON.parse(raw!)).toEqual(library());
  });

  test('a broken row is still in the text, byte for byte', async () => {
    const p = phone();
    const diff = diffState(null, library());
    diff.tables.cards.upserts.push({ key: 'bad', json: '{"id":"bad",', dayKey: null });
    await p.rows.write(diff, 'diff');
    expect(await portOn(p).readRaw()).toContain('{"id":"bad",');
  });

  test('rows empty → the newest old copy; the file cannot open → null (not an older copy)', async () => {
    const p = phone({ asyncStorage: 'OLD' });
    await expect(portOn(p).readRaw()).resolves.toBe('OLD');
    await p.kv.setItem(KV_STATE_KEY, 'KV');
    await expect(portOn(p).readRaw()).resolves.toBe('KV');
    await expect(portOn(p, () => T0, () => Promise.reject(new Error('no file'))).readRaw()).resolves.toBeNull();
    p.rows.failReads = true;
    await expect(portOn(p).readRaw()).resolves.toBeNull();
  });
});

/* -------------------------------------------- 3. the engine on the row port */

describe('the engine boots through the legacy chain into the row store', () => {
  let clock: TestClock;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    clock = createClock(T0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function start(p: Phone): Promise<Engine> {
    const engine = createEngine(portOn<DataState>(p, clock.now), { now: clock.now, freeze: true, preservePremigrate: () => undefined });
    await engine.boot();
    return engine;
  }

  async function pass(ms: number) {
    clock.advance(ms);
    await jest.advanceTimersByTimeAsync(ms);
  }

  /**
   * `state` as the row store loads it: every row table is a list (an empty
   * one when the state has none). The v3 state has all six lists, so this
   * changes nothing there; an older state shape gets the missing ones.
   */
  const asLoaded = (state: object) => ({ ...Object.fromEntries(ROW_TABLES.map(({ key }) => [key, []])), ...state });

  test('first boot of the build: the kv data is migrated, banked once (M5), and copied into the rows', async () => {
    const p = phone();
    await p.kv.setItem(KV_STATE_KEY, V1_RAW);
    const first = await start(p);
    expect(first.meta.getState().persistError).toBeNull();
    const state = first.store.getState();
    expect(state.schemaVersion).toBe(CURRENT_SCHEMA);
    expect(state.sessions).toHaveLength(2); // the killed session's marker was banked
    expect(state.inProgressSession).toBeNull();
    await pass(SAVE_DEBOUNCE_MS);
    expect(meta(p.rows).get('copiedFrom')).toMatchObject({ source: 'kv' });
    first.dispose();

    // Second boot: only the rows are read, nothing is banked twice, the state is the same.
    const kvReads = jest.spyOn(p.kv, 'getItem');
    const second = await start(p);
    expect(kvReads).not.toHaveBeenCalled();
    expect(second.store.getState().sessions).toHaveLength(2);
    expect(second.store.getState()).toEqual(asLoaded(state));
    expect(p.kv.snapshot()[KV_STATE_KEY]).toBe(V1_RAW); // the old copy stays
    second.dispose();
  });

  test('killed before the copy committed → the next boot copies again (and still banks once)', async () => {
    const p = phone({ asyncStorage: V1_RAW });
    // The boot's copy into the rows is ONE transaction. A kill in its middle
    // rolls it back, as this failed write does.
    p.rows.failWrites = 1;
    const first = await start(p);
    expect(first.store.getState().sessions).toHaveLength(2);
    first.dispose(); // an OS kill: no save after it
    expect(p.rows.writes).toBe(0);

    const second = await start(p);
    expect(second.store.getState().sessions).toHaveLength(2);
    await pass(SAVE_DEBOUNCE_MS);
    expect(meta(p.rows).get('copiedFrom')).toMatchObject({ source: 'asyncStorage' });
    second.dispose();
    const third = await start(p);
    expect(third.store.getState().sessions).toHaveLength(2);
    third.dispose();
  });

  test('a rating is saved to the rows; a reboot gives the same state back', async () => {
    const p = phone({ asyncStorage: V1_RAW });
    const app = await start(p);
    await pass(SAVE_DEBOUNCE_MS);
    const card = app.store.getState().cards[0];
    app.actions.rateCard(card.id, 'good');
    await app.flush();
    const saved = app.store.getState();
    app.dispose();
    const again = await start(p);
    expect(again.store.getState()).toEqual(asLoaded(saved));
    again.dispose();
  });

  test('a corrupt kv text: copied to files, the seed is saved to the rows, and the next boot does not copy again', async () => {
    const p = phone();
    await p.kv.setItem(KV_STATE_KEY, '{"broken":');
    const first = await start(p);
    expect(first.store.getState().cards).toEqual([]);
    expect(p.corruptFiles).toHaveLength(1);
    await pass(SAVE_DEBOUNCE_MS);
    expect(meta(p.rows).get('schemaVersion')).toBe(CURRENT_SCHEMA);
    first.dispose();
    await start(p).then((e) => e.dispose());
    expect(p.corruptFiles).toHaveLength(1);
  });

  test('a read failure → read-blocked: changes stay in memory, nothing is written anywhere (C1)', async () => {
    const p = phone({ asyncStorage: new Error('CursorWindow') });
    const app = await start(p);
    expect(app.meta.getState().persistError).toBe('read');
    app.actions.markOnboarded();
    await pass(10 * SAVE_DEBOUNCE_MS);
    await app.flush();
    expect(p.rows.writes).toBe(0);
    expect(p.kv.writes).toBe(0);
    app.dispose();
  });

  test('a too-new kv document → blocked; the rows stay empty and the kv text is unchanged', async () => {
    const p = phone();
    const raw = JSON.stringify({ schemaVersion: 99, minReaderVersion: 99 });
    await p.kv.setItem(KV_STATE_KEY, raw);
    const app = await start(p);
    expect(app.meta.getState().persistError).toBe('too-new');
    app.actions.markOnboarded();
    await pass(10 * SAVE_DEBOUNCE_MS);
    expect(p.rows.writes).toBe(0);
    expect(p.kv.snapshot()[KV_STATE_KEY]).toBe(raw);
    app.dispose();
  });

  test('spec §3.10 step 3: the copy into the rows is made AT BOOT, in one transaction with copiedFrom — not at the first change', async () => {
    const p = phone();
    await p.kv.setItem(KV_STATE_KEY, V1_RAW);
    const app = await start(p);
    // boot() has resolved, no time has passed, nothing was changed by the user.
    expect(p.rows.writes).toBe(1);
    expect(meta(p.rows).get('copiedFrom')).toMatchObject({ source: 'kv', key: KV_STATE_KEY, length: V1_RAW.length });
    expect(meta(p.rows).get('bootOkCount')).toBe(1); // this boot is counted with the copy
    expect(meta(p.rows).get('schemaVersion')).toBe(CURRENT_SCHEMA);
    app.dispose(); // the user only opened the app

    // The next boot reads the ROWS: the kv text is not read (or migrated) again.
    const kvReads = jest.spyOn(p.kv, 'getItem');
    const second = await start(p);
    expect(kvReads).not.toHaveBeenCalled();
    expect(second.store.getState().sessions).toHaveLength(2); // the marker of the copy is banked once
    second.dispose();
  });

  test('a copy at boot that fails: the app is ready anyway (write error, M15) and the next flush copies, with copiedFrom', async () => {
    const p = phone({ asyncStorage: V1_RAW });
    p.rows.failWrites = 1;
    const app = await start(p);
    expect(app.meta.getState()).toMatchObject({ ready: true, persistError: 'write' });
    expect(app.store.getState().sessions).toHaveLength(2); // the reconcile still ran
    expect(p.rows.writes).toBe(0);
    await expect(app.flush()).resolves.toEqual({ ok: true });
    expect(app.meta.getState().persistError).toBeNull();
    expect(meta(p.rows).get('copiedFrom')).toMatchObject({ source: 'asyncStorage' });
    app.dispose();
    const again = await start(p);
    expect(again.store.getState()).toEqual(asLoaded(app.store.getState()));
    again.dispose();
  });

  test('a v3 document in the kv-store that needs no repair is copied at boot too', async () => {
    const p = phone();
    const doc = JSON.parse(JSON.stringify(library())) as DataStateV3;
    await p.kv.setItem(KV_STATE_KEY, JSON.stringify(doc));
    const app = await start(p);
    expect(p.rows.writes).toBe(1);
    expect(meta(p.rows).get('copiedFrom')).toMatchObject({ source: 'kv' });
    app.dispose();
  });

  test('a first boot with nothing anywhere and a rows boot do not write at boot', async () => {
    // (A corrupt text DOES write at boot: the seed replaces it, see the next test.)
    for (const setup of [
      async (_p: Phone) => undefined,
      async (p: Phone) => {
        await p.rows.write(diffState(null, library()), 'diff');
      },
    ]) {
      const p = phone();
      await setup(p);
      const writes = p.rows.writes;
      const app = await start(p);
      expect(p.rows.writes).toBe(writes);
      app.dispose();
    }
  });

  test('an INVALID rows document (settings: "x"): the seed save replaces every row, so the reboot gives the seed', async () => {
    const p = phone();
    // Disk damage: a meta row that is valid JSON but not settings. migrate() says 'invalid'.
    await p.rows.write(diffState(null, { ...library(), settings: 'x' }), 'diff');
    expect(p.rows.snapshot().tables.cards).toHaveLength(1);
    const app = await start(p);
    expect(app.store.getState().cards).toEqual([]); // the seed
    expect(p.corruptFiles).toHaveLength(1); // a copy of the unusable document was kept first
    await pass(SAVE_DEBOUNCE_MS);
    app.dispose();
    // The old card, note and deck rows are gone; the next boot finds the seed.
    const rows = p.rows.snapshot().tables;
    expect([rows.cards, rows.notes, rows.decks]).toEqual([[], [], []]);
    const again = await start(p);
    expect(again.store.getState().cards).toEqual([]);
    expect(again.store.getState().decks).toEqual([]);
    expect(again.store.getState().settings).toEqual(app.store.getState().settings);
    expect(p.corruptFiles).toHaveLength(1); // it does not copy the same text again
    again.dispose();
  });

  const corruptKeysIn = (p: Phone) => Object.keys(p.kv.snapshot()).filter((key) => key.startsWith(KV_CORRUPT_PREFIX));

  test('spec §3.10 step 3 for a CORRUPT old text: the seed is saved AT BOOT (one transaction, no copiedFrom), so a kill right after boot copies nothing again', async () => {
    const p = phone();
    await p.kv.setItem(KV_STATE_KEY, '{"broken":');
    const app = await start(p);
    // boot() has resolved, no time has passed, nothing was changed by the user.
    expect(p.corruptFiles.map((f) => f.raw)).toEqual(['{"broken":']); // the copy is kept FIRST
    expect(p.rows.writes).toBe(1);
    expect(meta(p.rows).get('schemaVersion')).toBe(CURRENT_SCHEMA);
    expect(meta(p.rows).get('bootOkCount')).toBe(1);
    expect(meta(p.rows).has('copiedFrom')).toBe(false); // the rows hold the seed, not a copy
    app.dispose(); // an OS kill right after boot: no debounced save runs any more

    // The next boot reads the ROWS: the old text is not read, and not copied a second time.
    const kvReads = jest.spyOn(p.kv, 'getItem');
    const again = await start(p);
    expect(kvReads).not.toHaveBeenCalled();
    expect(again.store.getState().cards).toEqual([]);
    expect(p.corruptFiles).toHaveLength(1);
    expect(corruptKeysIn(p)).toHaveLength(1);
    expect(p.kv.snapshot()[KV_STATE_KEY]).toBe('{"broken":'); // the old copy is never changed
    again.dispose();
  });

  test('an INVALID document in the old storage (settings: "x"): no copiedFrom and no first copy pending; the seed is saved at boot', async () => {
    const p = phone();
    const raw = JSON.stringify({ ...library(), settings: 'x' });
    await p.kv.setItem(KV_STATE_KEY, raw);
    const port = portOn<DataState>(p, clock.now);
    const app = createEngine(port, { now: clock.now, freeze: true, preservePremigrate: () => undefined });
    const boot = await app.boot();
    expect(boot.kind).toBe('corrupt'); // migrate() said 'invalid'
    expect(port.firstCopyPending()).toBe(false); // the document is NOT copied into the rows
    expect(p.corruptFiles.map((f) => f.raw)).toEqual([raw]);
    // The seed is on the disk now, without a copiedFrom record.
    expect(p.rows.writes).toBe(1);
    expect(meta(p.rows).has('copiedFrom')).toBe(false);
    expect(p.rows.snapshot().tables.cards).toEqual([]);
    app.dispose(); // killed right after boot
    const again = await start(p);
    expect(again.store.getState().cards).toEqual([]);
    expect(p.corruptFiles).toHaveLength(1); // not copied again
    again.dispose();
  });

  test('an INVALID rows document with review history: the seed replace runs AT BOOT, and the corrupt copy keeps the revlog rows', async () => {
    const p = phone();
    await p.rows.write(diffState(null, { ...library(), settings: 'x' }), 'diff');
    const history = [
      { seq: 1, cardId: 'c1', deckId: 'd1', atMs: T0 - 2000, rating: 'good' as const, bucket: 'new' as const, ivlBefore: 0, ivlAfter: 1, easeAfter: 2.5, durationMs: 1200 },
      { seq: 2, cardId: 'c1', deckId: 'd1', atMs: T0 - 1000, rating: 'again' as const, bucket: 'review' as const, ivlBefore: 1, ivlAfter: 1, easeAfter: 2.3, durationMs: null },
    ];
    await p.rows.writeRevlog(history);
    const app = await start(p);
    // No time has passed: the old rows are replaced already.
    expect(p.rows.snapshot().tables.cards).toEqual([]);
    expect(p.rows.snapshot().revlog).toEqual([]);
    // … but the study history is in the copy (the file and the kv key), next to the document.
    expect(p.corruptFiles).toHaveLength(1);
    const copy = JSON.parse(p.corruptFiles[0].raw) as Record<string, unknown>;
    expect(copy.revlog).toEqual(history);
    expect((copy.cards as { id: string }[]).map((c) => c.id)).toEqual(['c1']);
    expect(corruptKeysIn(p).map((key) => p.kv.snapshot()[key])).toEqual([p.corruptFiles[0].raw]);
    app.dispose();
  });

  test.each([
    ['with the app\'s decode (setAside mode)', appDecode],
    ['without a decode (keepRows mode)', undefined],
  ])(
    'review round 2: a review-log entry that migrate() removes keeps its seq — the next rating gets a NEW seq and every history row stays (%s)',
    async (_mode, decode) => {
      const p = phone();
      // The rows: review log [seq 1, seq 2 with no usable card id (migrate() removes it)], history rows 1 and 2.
      // (W4-7: a broken prev, such as prev.ease null, is now repaired instead of removed; see migrate.test.ts.)
      await p.rows.write(diffState(null, { ...library(), reviewLog: [reviewEntry(1), { ...reviewEntry(2), cardId: '' }] }), 'diff');
      const history = p.rows.snapshot().revlog;
      expect(history.map((r) => [r.seq, r.rating])).toEqual([
        [1, 'again'],
        [2, 'again'],
      ]);
      const app = createEngine(portOn<DataState>(p, clock.now, undefined, decode), { now: clock.now, freeze: true, preservePremigrate: () => undefined });
      const boot = await app.boot();
      expect(boot.kind === 'loaded' && boot.repaired).toContain('reviewLog #1: a rating with no usable card id (""), removed');
      expect(app.store.getState().reviewLog.map((e) => e.seq)).toEqual([1]);

      app.actions.rateCard('c1', 'easy');
      // Not seq 2: the history table holds a row 2 already.
      expect(app.store.getState().reviewLog.map((e) => e.seq)).toEqual([1, 3]);
      await app.flush();
      expect(app.meta.getState().persistError).toBeNull();
      const after = p.rows.snapshot().revlog;
      expect(after.map((r) => [r.seq, r.rating])).toEqual([
        [1, 'again'],
        [2, 'again'],
        [3, 'easy'],
      ]);
      expect(after[1]).toEqual(history[1]); // row 2 is unchanged
      app.dispose();
    },
  );

  test('review round 2: after a Restore whose backup history goes higher than its review log, the next rating gets a seq above that history', async () => {
    const p = phone();
    const port = portOn<DataState>(p, clock.now);
    const app = createEngine(port, { now: clock.now, freeze: true, preservePremigrate: () => undefined });
    await app.boot(); // nothing anywhere: the seed
    // The Restore flow (revlogStore.ts RevlogStore.write): replace, flush, then the backup's history rows.
    app.actions.restore(library()); // its review log is empty
    expect((await app.actions.flush()).ok).toBe(true);
    const backupHistory = [historyRow(1), historyRow(2, { rating: 'hard' }), historyRow(3, { rating: 'again' })];
    await expect(port.revlog.write(backupHistory)).resolves.toBe(3);

    app.actions.rateCard('c1', 'good');
    expect(app.store.getState().reviewLog.map((e) => e.seq)).toEqual([4]);
    await app.flush();
    const rows = p.rows.snapshot().revlog;
    expect(rows.slice(0, 3)).toEqual(backupHistory); // the restored history is unchanged
    expect(rows.map((r) => [r.seq, r.rating])).toEqual([
      [1, 'good'],
      [2, 'hard'],
      [3, 'again'],
      [4, 'good'],
    ]);
    app.dispose();
  });
});
