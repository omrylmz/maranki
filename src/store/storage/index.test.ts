/**
 * Tests for src/store/storage/index.ts (W2 hardening, W3-3):
 *   - createStoragePort() ITSELF, with its real wiring (not buildStoragePort
 *     with injected parts): on a phone it is the ROW STORE (W3-3). On
 *     Android, a failed AsyncStorage read goes to the RKStorage rescue with
 *     today's key, and the rescued text is copied into the row store by the
 *     first save — never into the kv file. A wrong key or two swapped parts
 *     fail here, not only on the emulator (E2b);
 *   - afterAppStorageLoad(): another writer of the kv file waits while a load
 *     of the app port runs (kept from the W2 hardening: a corrupt kv text is
 *     still copied into the kv file right after the load);
 *   - the theme (src/theme/ThemeContext.tsx) copies the old AsyncStorage
 *     choice into the kv file only AFTER that first load;
 *   - appRevlogStore(): the review history of the app's own row database;
 *   - the app's row port decodes with migrate() (`decodedState`), so the
 *     first save after a changed load deletes what the user deleted;
 *     markAppBootOk() counts a boot once (review round 1);
 *   - the web preview banner (src/store/DataContext.tsx) sets pointerEvents
 *     as a style key (react-native-web 0.21 warns about the prop).
 *
 * The native parts are replaced (`jest.mock` below):
 *   - AsyncStorage            → its official in-memory jest mock;
 *   - ./kvStoragePort         → the real module, but getKvStore() returns
 *                               `mockKv`, a fake kv file that logs every write;
 *   - ./rkRescue              → the real module, but rescueRkStorage() is `mockRescue`;
 *   - ./rowStore              → the real module, but openRowDb() opens
 *                               `mockRows.db`, a memory RowDb (a new one per
 *                               test), and a test can hold the opening;
 *   - safe-area-context       → fixed insets (the banner reads them).
 *
 * ORDER MATTERS in the first describe: index.ts keeps ONE app port for the
 * whole app, so "the first load" happens once per test file. The theme test
 * runs first and makes that first load itself.
 */
// '@jest/globals' first: the jest.mock factories below use its `jest`.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import { Platform, Text, View } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import type { DataState } from '../../domain/types';
import { FIXED_NOW } from '../../test/clock';
import { stateFixtureRaw } from '../../test/factories';
import { makeDeckV3, noteWithCards, stateOfV3 } from '../../test/factoriesV3';
import { THEME_KEY, ThemeProvider, useTheme } from '../../theme/ThemeContext';
import { WebPreviewBanner } from '../DataContext';
import { createEngine } from '../engine';
import { migrate } from '../migrate';
import { STORAGE_KEY } from '../persistence';
import {
  afterAppStorageLoad,
  appRevlogStore,
  appStoragePort,
  createStoragePort,
  decodedState,
  diffState,
  KV_COPIED_FROM_KEY,
  KV_STATE_KEY,
  type KeyValueStore,
  markAppBootOk,
  WEB_PREVIEW_NOTICE,
  type AppStoragePort,
} from './index';
import { createMemoryRowDb, type MemoryRowDb, type RowDb } from './rowStore';

/* ------------------------------------------------------------ module mocks */

/** A fake kv file: a Map, a log of every write, and gates a test can hold. */
interface FakeKv extends KeyValueStore {
  data: Map<string, string>;
  log: string[];
  /** While set, multiSet waits for it (the copy-forward's transaction "runs"). */
  holdMultiSet: Promise<void> | null;
  /** While set, getItem waits for it and then REJECTS (a read that fails). */
  failGetItem: Promise<void> | null;
  /** The theme reads its key synchronously on the first render. */
  getItemSync(key: string): string | null;
  /** Empty the file and the log, and open every gate (before each test). */
  reset(): void;
}

function createFakeKv(): FakeKv {
  const kv: FakeKv = {
    data: new Map(),
    log: [],
    holdMultiSet: null,
    failGetItem: null,
    getItemSync: (key) => kv.data.get(key) ?? null,
    reset: () => {
      kv.data.clear();
      kv.log.length = 0;
      kv.holdMultiSet = null;
      kv.failGetItem = null;
    },
    async getItem(key) {
      if (kv.failGetItem) {
        await kv.failGetItem;
        throw new Error('database is locked');
      }
      return kv.data.get(key) ?? null;
    },
    async setItem(key, value) {
      kv.log.push(`setItem ${key}`);
      kv.data.set(key, value);
    },
    async multiSet(pairs) {
      kv.log.push('multiSet start');
      if (kv.holdMultiSet) await kv.holdMultiSet;
      for (const [key, value] of pairs) kv.data.set(key, value);
      kv.log.push('multiSet end');
    },
  };
  return kv;
}

// ONE fake kv file for the whole test file: the app port (made once, see the
// file comment) keeps the store it got first, so each test resets this one.
const mockKv: FakeKv = createFakeKv();
const mockRescue = jest.fn(async (_key?: string): Promise<string | null> => null);

/**
 * The row database the app port opens. `db` is replaced before each test
 * (the app port opens ONE database for the whole file, so it gets a RowDb
 * that passes every call on to the current `db`). While `hold` is set,
 * opening waits for it (the row store "is opening").
 */
const mockRows: { db: MemoryRowDb | null; hold: Promise<void> | null; opened: number } = { db: null, hold: null, opened: 0 };
async function mockOpenRows(): Promise<RowDb> {
  mockRows.opened += 1;
  if (mockRows.hold) await mockRows.hold;
  const current = () => {
    if (!mockRows.db) throw new Error('no row db');
    return mockRows.db;
  };
  return {
    ensureSchema: () => current().ensureSchema(),
    hasRows: () => current().hasRows(),
    readMeta: () => current().readMeta(),
    readTableJson: (t) => current().readTableJson(t),
    readTableTexts: (t) => current().readTableTexts(t),
    write: (d, m) => current().write(d, m),
    writeRevlog: (r) => current().writeRevlog(r),
    readRevlog: (c) => current().readRevlog(c),
  };
}

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('./kvStoragePort', () => ({
  ...jest.requireActual<object>('./kvStoragePort'),
  getKvStore: () => mockKv,
}));

jest.mock('./rkRescue', () => ({
  ...jest.requireActual<object>('./rkRescue'),
  rescueRkStorage: (key?: string) => mockRescue(key),
}));

jest.mock('./rowStore', () => ({
  ...jest.requireActual<object>('./rowStore'),
  openRowDb: () => mockOpenRows(),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, bottom: 0, left: 0, right: 0 }),
}));

/* ---------------------------------------------------------------- helpers */

const V1_RAW = stateFixtureRaw('v1-main-1333d48');

/** A promise the test resolves by hand. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Let every waiting promise callback run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

let renderer: ReactTestRenderer | null = null;

beforeEach(async () => {
  mockKv.reset();
  mockRows.db = createMemoryRowDb();
  mockRows.hold = null;
  mockRows.opened = 0;
  jest.clearAllMocks(); // the call lists of the AsyncStorage mock, too
  mockRescue.mockReset();
  mockRescue.mockImplementation(async () => null);
  await AsyncStorage.clear();
});

/** The row store's meta rows, parsed. */
const rowMeta = () => new Map(mockRows.db!.snapshot().meta.map(([k, v]) => [k, JSON.parse(v) as unknown]));

/** A small library in the shape the app port saves (DataState: the v3 shape after the merge). */
function library(withRating = false): DataState {
  const deck = makeDeckV3({ id: 'd1' });
  const g = noteWithCards({ deckId: 'd1', note: { id: 'n1' }, card: { id: 'c1' } });
  const base = stateOfV3({ decks: [deck], groups: [g] });
  if (!withRating) return base as unknown as DataState;
  const card = g.cards[0];
  return {
    ...base,
    cards: [{ ...card, reps: 1, intervalDays: 1 }],
    reviewLog: [
      {
        id: 'r1',
        seq: 1,
        cardId: 'c1',
        deckId: 'd1',
        rating: 'good',
        atMs: FIXED_NOW,
        bucket: 'new',
        prev: { ease: card.ease, intervalDays: 0, stepIndex: null, reps: 0, lapses: 0, due: card.due, lastReviewedAt: null, knownAt: null, knownCheckedAt: null },
      },
    ],
  } as unknown as DataState;
}

afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = null;
  jest.restoreAllMocks();
});

/* -------------------------- the first load and the theme (order matters) */

describe('no other kv write while the app port loads', () => {
  test('the theme copies its old choice only AFTER the first load has ended', async () => {
    // The first launch after the upgrade: the data and the theme are both
    // still in AsyncStorage, and the kv file is empty.
    await AsyncStorage.setItem(STORAGE_KEY, V1_RAW);
    await AsyncStorage.setItem(THEME_KEY, 'dark');
    const opening = deferred();
    mockRows.hold = opening.promise;

    const seen: { mode: string; hydrated: boolean }[] = [];
    function Probe() {
      const theme = useTheme();
      seen.push({ mode: theme.mode, hydrated: theme.hydrated });
      return null;
    }
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(ThemeProvider, null, React.createElement(Probe)));
    });
    await act(settle);
    // The old choice is USED at once (no wait for the data) …
    expect(seen.at(-1)).toEqual({ mode: 'dark', hydrated: true });
    // … but not written yet: the data's first load has not even started.
    expect(mockKv.log).toEqual([]);

    // DataProvider boots: the row store opens (slowly) and the load runs.
    const loading = appStoragePort().load();
    await settle();
    expect(mockKv.log).toEqual([]);

    // The load ends; only then does the theme write.
    opening.resolve();
    await expect(loading).resolves.toMatchObject({ kind: 'doc', raw: V1_RAW });
    await settle();
    expect(mockKv.log).toEqual([`setItem ${THEME_KEY}`]);
    expect(mockKv.data.get(THEME_KEY)).toBe('dark');
    // W3-3: the load only READS the old copies; nothing is copied into the kv file.
    expect(mockKv.data.has(KV_STATE_KEY)).toBe(false);
    expect(mockRows.opened).toBe(1);
  });

  test('a later load ("Try again") holds other writers too, and a FAILED load ends the wait', async () => {
    const readEnds = deferred();
    mockKv.failGetItem = readEnds.promise;
    const loading = appStoragePort().load();
    let free = false;
    void afterAppStorageLoad().then(() => {
      free = true;
    });
    await settle();
    expect(free).toBe(false);

    readEnds.resolve();
    await expect(loading).rejects.toThrow('database is locked');
    await settle();
    expect(free).toBe(true);
    // No load runs now: the wait ends at once.
    await expect(afterAppStorageLoad()).resolves.toBeUndefined();
  });
});

/* ------------------------------------------- createStoragePort() itself */

describe('createStoragePort() with its real wiring', () => {
  test('Android: AsyncStorage cannot read the big value → the rescue reads TODAY\'S key; the first save copies it into the ROW store', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'android');
    try {
      jest.spyOn(AsyncStorage, 'getItem').mockImplementation(async (key: string) => {
        if (key === STORAGE_KEY) throw new Error('Row too big to fit into CursorWindow');
        return null;
      });
      mockRescue.mockImplementation(async () => V1_RAW);

      const port = createStoragePort(() => FIXED_NOW);
      await expect(port.load()).resolves.toMatchObject({ kind: 'doc', raw: V1_RAW });

      expect(mockRescue).toHaveBeenCalledTimes(1);
      expect(mockRescue).toHaveBeenCalledWith('maranki.state.v1');
      // The load only reads: nothing in the kv file, nothing in the rows yet.
      expect(mockKv.log).toEqual([]);
      expect(mockRows.db!.writes).toBe(0);

      // The first save (the engine's, after migrate) writes every row and the record of the copy.
      await port.save(library(), null);
      expect(rowMeta().get('copiedFrom')).toEqual({
        source: 'rkRescue',
        key: 'maranki.state.v1',
        at: FIXED_NOW,
        length: V1_RAW.length,
      });
      expect(mockKv.data.has(KV_STATE_KEY)).toBe(false);
      expect(mockKv.data.has(KV_COPIED_FROM_KEY)).toBe(false);
      // AsyncStorage is only read, never changed.
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    } finally {
      os.restore();
    }
  });

  test('Android: the rescue finds nothing → the load rejects (read-blocked) and nothing is written', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'android');
    try {
      jest.spyOn(AsyncStorage, 'getItem').mockImplementation(async () => {
        throw new Error('Row too big to fit into CursorWindow');
      });
      await expect(createStoragePort(() => FIXED_NOW).load()).rejects.toThrow();
      expect(mockRescue).toHaveBeenCalledWith('maranki.state.v1');
      expect(mockKv.log).toEqual([]);
      expect(mockRows.db!.writes).toBe(0);
    } finally {
      os.restore();
    }
  });

  test('iOS: there is no RKStorage, so the rescue is never called', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    try {
      jest.spyOn(AsyncStorage, 'getItem').mockImplementation(async () => {
        throw new Error('read failed');
      });
      await expect(createStoragePort(() => FIXED_NOW).load()).rejects.toThrow();
      expect(mockRescue).not.toHaveBeenCalled();
    } finally {
      os.restore();
    }
  });
});

describe('the row store is the app\'s storage on a phone (W3-3)', () => {
  test('the kv data of a v2.2.0 phone is read through the legacy chain; the rows are used from then on', async () => {
    mockKv.data.set(KV_STATE_KEY, V1_RAW);
    const first = createStoragePort(() => FIXED_NOW);
    await expect(first.load()).resolves.toMatchObject({ kind: 'doc', raw: V1_RAW });
    await first.save(library(), null);
    expect(rowMeta().get('copiedFrom')).toMatchObject({ source: 'kv', key: 'maranki.state' });
    // The next run: the rows, not the kv copy (which stays as it was).
    const next = createStoragePort(() => FIXED_NOW);
    await expect(next.load()).resolves.toEqual({ kind: 'doc', value: library() });
    expect(mockKv.data.get(KV_STATE_KEY)).toBe(V1_RAW);
    expect(mockKv.log).toEqual([]);
  });

  test('the app port keeps the row port\'s firstCopyPending, so the engine copies the kv data into the rows AT BOOT (spec §3.10 step 3)', async () => {
    mockKv.data.set(KV_STATE_KEY, V1_RAW);
    const port: AppStoragePort = appStoragePort();
    expect(typeof port.firstCopyPending).toBe('function');
    const engine = createEngine(port, { now: () => FIXED_NOW, preservePremigrate: () => undefined, freeze: false });
    await engine.boot();
    // No change, no timer: the copy is on the disk when boot() resolves.
    expect(rowMeta().get('copiedFrom')).toMatchObject({ source: 'kv', key: KV_STATE_KEY, length: V1_RAW.length });
    expect(port.firstCopyPending?.()).toBe(false);
    engine.dispose();
  });

  test('the app port keeps the row port\'s highestRevlogSeq, so the engine never gives a seq that the history table holds', async () => {
    // The rows: a review log with seq 1, and a history that goes up to seq 77
    // (for example a backup's history, or an entry migrate() removed).
    await mockRows.db!.write(diffState(null, library(true)), 'diff');
    await mockRows.db!.writeRevlog([
      { seq: 77, cardId: 'c1', deckId: 'd1', atMs: FIXED_NOW - 1000, rating: 'again', bucket: 'review', ivlBefore: 4, ivlAfter: 2, easeAfter: 2.3, durationMs: null },
    ]);
    const port: AppStoragePort = appStoragePort();
    expect(typeof port.highestRevlogSeq).toBe('function');
    const engine = createEngine(port, { now: () => FIXED_NOW, preservePremigrate: () => undefined, freeze: false });
    await engine.boot();
    expect(port.highestRevlogSeq?.()).toBe(77);
    engine.actions.rateCard('c1', 'good');
    expect(engine.store.getState().reviewLog.map((e) => e.seq)).toEqual([1, 78]);
    await engine.flush();
    expect(mockRows.db!.snapshot().revlog.map((r) => [r.seq, r.rating])).toEqual([
      [1, 'good'],
      [77, 'again'],
      [78, 'good'],
    ]);
    engine.dispose();
  });

  test('appRevlogStore() reads the review history of the app port\'s own row database', async () => {
    await appStoragePort().save(library(true), null);
    await expect(appRevlogStore().forCard('c1')).resolves.toEqual([
      expect.objectContaining({ seq: 1, cardId: 'c1', rating: 'good', ivlBefore: 0, ivlAfter: 1 }),
    ]);
    await expect(appRevlogStore().forCard('nope')).resolves.toEqual([]);
  });

  test('decodedState is migrate()\'s state, or null when migrate() gives none', () => {
    const doc: unknown = JSON.parse(V1_RAW);
    const out = migrate(doc, FIXED_NOW);
    expect(out.kind).toBe('ok');
    expect(decodedState(doc, FIXED_NOW)).toEqual(out.kind === 'ok' ? out.state : 'not ok');
    expect(decodedState({ schemaVersion: 999, minReaderVersion: 999 }, FIXED_NOW)).toBeNull(); // too new
    expect(decodedState('not a document', FIXED_NOW)).toBeNull();
  });

  test('the app\'s row port decodes with migrate(): after a changed rows load, the first save deletes a card the user deleted', async () => {
    // Rows that hold a state of this build's schema (any schema: migrate() makes it).
    const state = decodedState(JSON.parse(V1_RAW), FIXED_NOW) as DataState;
    expect(state.cards.length).toBeGreaterThan(1);
    await mockRows.db!.write(diffState(null, state), 'diff');
    const port = createStoragePort(() => FIXED_NOW);
    const loaded = await port.load();
    if (loaded.kind !== 'doc') throw new Error(`expected a document, got ${loaded.kind}`);
    const doc = loaded.value as DataState;
    const gone = doc.cards[0].id;
    // After a load the decode CHANGED, the controller's first save has no prev.
    await port.save({ ...doc, cards: doc.cards.slice(1) }, null);
    const stored = mockRows.db!.snapshot().tables.cards.map(([key]) => key);
    expect(stored).not.toContain(gone);
    expect(stored).toHaveLength(doc.cards.length - 1);
  });

  test('markAppBootOk() counts a boot of the app port in its own row database — once per load', async () => {
    await mockRows.db!.write(diffState(null, library()), 'diff');
    await appStoragePort().load();
    const writes = mockRows.db!.writes;
    await markAppBootOk();
    await markAppBootOk();
    expect(rowMeta().get('bootOkCount')).toBe(1);
    expect(mockRows.db!.writes).toBe(writes + 1);
  });
});

/* ------------------------------------------------------- web preview banner */

describe('the web preview banner', () => {
  test('pointerEvents is a style key (no deprecated prop), and the copy is exact', async () => {
    mockKv.data.set(THEME_KEY, 'light'); // no theme copy needed
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(ThemeProvider, null, React.createElement(WebPreviewBanner)));
    });
    const view = renderer!.root.findByType(View);
    expect(view.props.pointerEvents).toBeUndefined();
    expect(view.props.style).toMatchObject({ position: 'absolute', top: 24, pointerEvents: 'none' });
    expect(renderer!.root.findByType(Text).props.children).toBe(WEB_PREVIEW_NOTICE);
    expect(WEB_PREVIEW_NOTICE).toBe('Web preview — nothing is saved.');
  });
});
