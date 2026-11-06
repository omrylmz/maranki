/**
 * Tests for the load classifier that fixes the C1 data-loss bug: the three
 * stored-value cases must be distinguished so a corrupt blob is preserved and
 * only genuine first-boot/valid documents lead to a (writable) seed/load.
 *
 * W1-1 (schema v2) adds:
 *   - decideLoad: old documents are MIGRATED, too-new and migration bugs are
 *     BLOCKED (never "corrupt"). Since W2-1 it is a dry run of the
 *     controller's own decision (judgeDocument), so these tests pin that too;
 *   - premigrate.ts: the safety-copy files (once per version jump, keep 3);
 *   - the real <DataProvider> on the AsyncStorage jest mock and the in-memory
 *     expo-file-system of jest-expo: what is (and is NOT) written to disk,
 *     restore() and setLimits().
 *
 * W2-1 moves the live document to the kv-store (`maranki.state` in
 * `maranki-kv.db`), copied forward ONCE from AsyncStorage. So the DataProvider
 * tests now run on an in-memory kv-store (mocked below): an old build's text
 * is put in AsyncStorage, and the saves are checked in the kv-store. The rules
 * they pin are the same; only the place of the live copy (and of the corrupt
 * copy) changed, as spec §3.7 asks. The theme choice moved to the same
 * kv-store (read synchronously; the old AsyncStorage key copied once): the
 * ThemeProvider tests at the end.
 *
 * W3-1: migrate() ends in schema 3 (the note model), so a loaded or saved
 * document is a v3 one: these tests check it with stateProblemsV3.
 *
 * W3-3 moves the live document again, into the ROW STORE (`maranki-rows.db`,
 * storage/rowStore.ts). Under jest the row database is a memory RowDb
 * (mocked below, a new one for every test). So the DataProvider tests check
 * the saves in the rows now: `storedDoc()` is the document the rows hold,
 * `rowWrites()` counts their write transactions, and the one-time copy is
 * recorded in the rows' `meta.copiedFrom` (the kv file gets no copy any
 * more). The rules they pin are the same.
 *
 * W2-1 review round 1:
 *   - the wave-1 boot path (`bootLoad`) was deleted: the app boots only
 *     through the engine. Its rules are pinned on that path now
 *     (engine.integration.test.ts "the load rules, through the engine");
 *   - DataProvider survives an effect that runs setup → cleanup → setup
 *     (React.StrictMode, Fast Refresh): it still becomes ready and saves;
 *   - a bug in the boot reconcile reaches the error boundary (crash screen)
 *     instead of leaving the splash screen up forever;
 *   - the crash screen's "Save a copy" line after a failed share.
 */
// '@jest/globals' first: the jest.mock factory below runs when AsyncStorage
// is first imported, and it needs `jest` to be ready by then.
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import React, { useEffect } from 'react';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import TestRenderer, { act, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';

import { CURRENT_SCHEMA, DataState } from '../domain/types';
import { buildSeedState } from '../domain/seed';
import { localTime } from '../test/clock';
import { makeState, STATE_FIXTURES, stateFixtureRaw } from '../test/factories';
// W3-1: a loaded document is the v3 note model (factories.ts builds v2 INPUT documents).
import { randomStateV3, stateProblemsV3 } from '../test/factoriesV3';
import { createRandom } from '../test/random';
import { ErrorScreen } from '../components/ErrorScreen';
import { backupStamp } from './backup';
import { DataProvider, useData } from './DataContext';
import { migrate } from './migrate';
import {
  classifyStored,
  decideLoad,
  isValidState,
  parseStored,
  persistErrorMessage,
  serialize,
  STORAGE_KEY,
} from './persistence';
import {
  BACKUP_DIR,
  type BackupFolder,
  corruptFileName,
  documentBackupFolder,
  fileStamp,
  parsePremigrateName,
  premigrateFileName,
  writeCorruptCopy,
  writePremigrateCopy,
} from './premigrate';
import { CRASH_COPY } from './problemCopy';
import { rescueFileName } from './rescueExport';
import { appStoragePort } from './storage';
import { getKvStore, KV_CORRUPT_PREFIX, KV_STATE_KEY } from './storage/kvStoragePort';
import { ROW_TABLES } from './storage/rowDiff';
import { createMemoryRowDb, createRowPort, type MemoryRowDb, type RowDb } from './storage/rowStore';
import { THEME_KEY, ThemeProvider, useTheme } from '../theme/ThemeContext';

// The in-memory AsyncStorage that the package ships for jest.
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// The kv-store (expo-sqlite/kv-store) has no native module under jest: an
// in-memory SQLiteStorage that records which keys each write touched.
jest.mock('expo-sqlite/kv-store', () => {
  class SQLiteStorage {
    readonly databaseName: string;
    readonly data = new Map<string, string>();
    /** Keys written with setItem (the port's save and replaceAll), in order. */
    readonly setItemKeys: string[] = [];
    /** Keys of each multiSet (the one-time copy-forward), in order. */
    readonly multiSetKeys: string[][] = [];
    constructor(databaseName: string) {
      this.databaseName = databaseName;
    }
    async getItem(key: string) {
      return this.data.get(key) ?? null;
    }
    getItemSync(key: string) {
      return this.data.get(key) ?? null;
    }
    async setItem(key: string, value: string) {
      this.setItemKeys.push(key);
      this.data.set(key, value);
    }
    async multiSet(pairs: [string, string][]) {
      this.multiSetKeys.push(pairs.map(([key]) => key));
      for (const [key, value] of pairs) this.data.set(key, value);
    }
  }
  return { SQLiteStorage };
});

// The row store (W3-3): expo-sqlite has no native module under jest, so the
// app port opens a memory RowDb. The port opens ONE database for the whole
// file; it gets a RowDb that passes every call on to `mockRows.db`, which is
// a new, empty one before every test (see the top-level beforeEach).
const mockRows: { db: MemoryRowDb | null } = { db: null };
jest.mock('./storage/rowStore', () => {
  const actual = jest.requireActual<typeof import('./storage/rowStore')>('./storage/rowStore');
  const current = () => {
    if (!mockRows.db) throw new Error('no row db');
    return mockRows.db;
  };
  const delegate: RowDb = {
    ensureSchema: () => current().ensureSchema(),
    hasRows: () => current().hasRows(),
    readMeta: () => current().readMeta(),
    readTableJson: (t) => current().readTableJson(t),
    readTableTexts: (t) => current().readTableTexts(t),
    write: (d, m) => current().write(d, m),
    writeRevlog: (r) => current().writeRevlog(r),
    readRevlog: (c) => current().readRevlog(c),
  };
  return { ...actual, openRowDb: async () => delegate };
});

beforeEach(() => {
  mockRows.db = createMemoryRowDb();
});

// The share sheet (expo-sharing) for the crash screen's "Save a copy" test.
// Each test sets what the two calls do; the default is "sharing works".
const mockSharing = {
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async (_uri: string, _options?: unknown) => undefined),
};
jest.mock('expo-sharing', () => ({
  isAvailableAsync: () => mockSharing.isAvailableAsync(),
  shareAsync: (uri: string, options?: unknown) => mockSharing.shareAsync(uri, options),
}));

// The boot reconcile, with a switch that makes it throw (a bug in old data
// that the sanitize step missed). Off, it is the real reducer step.
let mockReconcileThrows = false;
jest.mock('./reducer', () => {
  const actual = jest.requireActual<typeof import('./reducer')>('./reducer');
  return {
    __esModule: true,
    ...actual,
    reconcileOnBoot: (...args: Parameters<typeof actual.reconcileOnBoot>) => {
      if (mockReconcileThrows) throw new Error('reconcile bug');
      return actual.reconcileOnBoot(...args);
    },
  };
});

interface FakeKv {
  data: Map<string, string>;
  setItemKeys: string[];
  multiSetKeys: string[][];
}
/** The app's kv-store (the mock above). */
const kv = () => getKvStore() as unknown as FakeKv;

describe('classifyStored', () => {
  test('null or empty → first-boot', () => {
    expect(classifyStored(null).kind).toBe('first-boot');
    expect(classifyStored('').kind).toBe('first-boot');
  });

  test('a valid stored document → loaded', () => {
    const out = classifyStored(serialize(buildSeedState(0)));
    expect(out.kind).toBe('loaded');
    if (out.kind === 'loaded') expect(out.state.collections).toHaveLength(3);
  });

  test('a truncated/unparseable blob → corrupt, carrying the raw for backup', () => {
    const out = classifyStored('{"cards":[1,2,3'); // truncated mid-write
    expect(out.kind).toBe('corrupt');
    if (out.kind === 'corrupt') expect(out.raw).toContain('cards');
  });

  test('a structurally invalid document → corrupt, never loaded', () => {
    // Parses as JSON but lacks person/settings — must not be adopted as state.
    const out = classifyStored(JSON.stringify({ cards: [], decks: [] }));
    expect(out.kind).toBe('corrupt');
  });
});

describe('parseStored / serialize', () => {
  test('serialize → parseStored round-trips the document', () => {
    const state = buildSeedState(0);
    expect(parseStored(serialize(state))).toEqual(state);
  });

  test('parseStored returns null for garbage / absent input', () => {
    expect(parseStored('not json')).toBeNull();
    expect(parseStored(null)).toBeNull();
    expect(parseStored('')).toBeNull();
  });
});

describe('isValidState', () => {
  test('accepts a full state, rejects partials and non-objects', () => {
    expect(isValidState(buildSeedState(0))).toBe(true);
    expect(isValidState({ cards: [], decks: [], person: {} })).toBe(false); // no settings
    expect(isValidState(null)).toBe(false);
    expect(isValidState('x')).toBe(false);
  });
});

describe('inProgressSession marker (M5 — survives a reload; old docs still load)', () => {
  test('a state carrying an in-flight session round-trips through serialize/parse', () => {
    const withMarker: DataState = {
      ...buildSeedState(0),
      inProgressSession: {
        kind: 'deck',
        label: 'German A1',
        counts: { again: 1, hard: 0, good: 3, easy: 1 },
        total: 5,
        bestRun: 4,
        durationSec: 120,
        fastAnswers: 2,
      },
    };
    // The marker must survive a kill-and-relaunch so the boot reconciler sees it.
    expect(parseStored(serialize(withMarker))).toEqual(withMarker);
  });

  test('a pre-M5 document with no inProgressSession field still loads', () => {
    const legacy: Record<string, unknown> = { ...buildSeedState(0) };
    delete legacy.inProgressSession; // older persisted shape
    expect(classifyStored(JSON.stringify(legacy)).kind).toBe('loaded');
  });
});

describe('persistErrorMessage (M15 — a failed load/save must not be silent)', () => {
  test('null → no message', () => {
    expect(persistErrorMessage(null)).toBeNull();
  });

  test('read and write produce distinct, user-facing messages', () => {
    const read = persistErrorMessage('read');
    const write = persistErrorMessage('write');
    expect(read).toBeTruthy();
    expect(write).toBeTruthy();
    expect(read).not.toBe(write);
    // The read message reassures that intact data won't be overwritten (C1).
    expect(read).toMatch(/restart/i);
    expect(write).toMatch(/sav/i);
  });

  test('too-new and migrate have their own messages, and say nothing was changed (spec §3.1, §3.10)', () => {
    const tooNew = persistErrorMessage('too-new');
    const migrateMsg = persistErrorMessage('migrate');
    expect(tooNew).toBe('This data was saved by a newer version of Maranki. Please update the app. Nothing was changed.');
    expect(migrateMsg).toBe("We couldn't update your data to this version. Nothing was changed.");
    const all = (['read', 'too-new', 'migrate', 'write'] as const).map(persistErrorMessage);
    expect(new Set(all).size).toBe(4);
  });
});

/* ------------------------------------------------------------ decideLoad */

const NOW = localTime('2026-07-08', '09:00');

describe('decideLoad (W1-1)', () => {
  test('nothing stored → first-boot', () => {
    expect(decideLoad(null, NOW)).toEqual({ kind: 'first-boot' });
    expect(decideLoad('', NOW)).toEqual({ kind: 'first-boot' });
  });

  test.each([
    ['truncated JSON', '{"cards":[1,2,3'],
    ['a JSON list', '[1,2]'],
    ['JSON without person and settings', '{"cards":[],"decks":[]}'],
    ['a JSON text', '"hello"'],
  ])('%s → corrupt, carrying the raw text', (_label, raw) => {
    expect(decideLoad(raw, NOW)).toEqual({ kind: 'corrupt', raw });
  });

  test.each(STATE_FIXTURES)('the real fixture %s → loaded, migrated to a valid schema-3 state', (name) => {
    const out = decideLoad(stateFixtureRaw(name), NOW);
    expect(out.kind).toBe('loaded');
    if (out.kind !== 'loaded') return;
    expect(out.from).toBe(name.startsWith('v0') ? 0 : 1);
    expect(out.state.schemaVersion).toBe(3);
    expect(stateProblemsV3(out.state)).toEqual([]);
  });

  test('a too-new document → blocked("too-new"), never corrupt', () => {
    expect(decideLoad(JSON.stringify({ schemaVersion: 9, minReaderVersion: 9 }), NOW)).toEqual({
      kind: 'blocked',
      reason: 'too-new',
    });
  });

  test('a migrate() that throws → blocked("migrate"), never corrupt', () => {
    const throwing = () => {
      throw new Error('bug in a migration step');
    };
    for (const name of STATE_FIXTURES) {
      expect(decideLoad(stateFixtureRaw(name), NOW, throwing)).toEqual({ kind: 'blocked', reason: 'migrate' });
    }
  });

  test('a migrate() that says invalid → corrupt (a copy is kept, then the seed)', () => {
    const raw = JSON.stringify(makeState());
    expect(decideLoad(raw, NOW, () => ({ kind: 'invalid' }))).toEqual({ kind: 'corrupt', raw });
  });

  test('save → load gives back the same state (30 seeded random v3 states)', () => {
    const rnd = createRandom('decideLoad-roundtrip');
    for (let i = 0; i < 30; i++) {
      const state = randomStateV3(rnd);
      const out = decideLoad(serialize(state), NOW);
      expect(out).toEqual({ kind: 'loaded', state, from: 3, repaired: [] });
    }
  });
});

/* -------------------------------------------------- premigrate.ts copies */

/** A BackupFolder in memory: name → text. */
function memoryFolder(initial: Record<string, string> = {}): BackupFolder & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    names: () => [...files.keys()],
    write: (name, text) => {
      files.set(name, text);
    },
    remove: (name) => {
      files.delete(name);
    },
  };
}

describe('premigrate.ts — safety copies', () => {
  const T1 = Date.UTC(2026, 6, 7, 8, 10, 0, 0);

  test('file names: a sortable UTC stamp, and the jump in the name', () => {
    expect(fileStamp(T1)).toBe('2026-07-07T08-10-00-000Z');
    expect(premigrateFileName(0, 2, T1)).toBe('premigrate-v0-to-v2-2026-07-07T08-10-00-000Z.json');
    expect(corruptFileName(T1)).toBe('corrupt-2026-07-07T08-10-00-000Z.json');
    expect(parsePremigrateName(premigrateFileName(1, 2, T1))).toEqual({
      from: 1,
      to: 2,
      stamp: '2026-07-07T08-10-00-000Z',
    });
    expect(parsePremigrateName(corruptFileName(T1))).toBeNull();
  });

  test('the pre-migration copy is written once per version jump', () => {
    const folder = memoryFolder();
    expect(writePremigrateCopy('RAW-1', 0, 2, T1, folder)).toBe(premigrateFileName(0, 2, T1));
    // The app was killed before the migrated document was saved: the next boot
    // migrates the same document again — no second copy.
    expect(writePremigrateCopy('RAW-1', 0, 2, T1 + 60_000, folder)).toBeNull();
    expect([...folder.files.entries()]).toEqual([[premigrateFileName(0, 2, T1), 'RAW-1']]);
    // Another jump gets its own copy.
    expect(writePremigrateCopy('RAW-2', 2, 3, T1 + 120_000, folder)).toBe(premigrateFileName(2, 3, T1 + 120_000));
    expect(folder.files.size).toBe(2);
  });

  test('only the newest 3 pre-migration copies are kept; other files are never touched', () => {
    const day = 86_400_000;
    const folder = memoryFolder({
      [premigrateFileName(0, 1, T1 - 4 * day)]: 'a',
      [premigrateFileName(1, 2, T1 - 3 * day)]: 'b',
      [premigrateFileName(2, 3, T1 - 2 * day)]: 'c',
      [premigrateFileName(3, 4, T1 - 1 * day)]: 'd',
      [corruptFileName(T1 - 9 * day)]: 'corrupt',
      'auto-2026-01-01.json': 'auto',
    });
    writePremigrateCopy('new', 4, 5, T1, folder);
    expect(folder.names().sort()).toEqual(
      [
        premigrateFileName(2, 3, T1 - 2 * day),
        premigrateFileName(3, 4, T1 - 1 * day),
        premigrateFileName(4, 5, T1),
        corruptFileName(T1 - 9 * day),
        'auto-2026-01-01.json',
      ].sort(),
    );
  });

  test('an old copy that cannot be deleted does not fail the new copy', () => {
    const folder = memoryFolder({
      [premigrateFileName(0, 1, T1 - 3)]: 'a',
      [premigrateFileName(1, 2, T1 - 2)]: 'b',
      [premigrateFileName(2, 3, T1 - 1)]: 'c',
    });
    folder.remove = () => {
      throw new Error('read-only');
    };
    expect(writePremigrateCopy('new', 3, 4, T1, folder)).toBe(premigrateFileName(3, 4, T1));
    expect(folder.files.get(premigrateFileName(3, 4, T1))).toBe('new');
  });

  test('a failed write throws (the caller decides what it means)', () => {
    const folder = memoryFolder();
    folder.write = () => {
      throw new Error('disk full');
    };
    expect(() => writePremigrateCopy('raw', 0, 2, T1, folder)).toThrow('disk full');
    expect(() => writeCorruptCopy('raw', T1, folder)).toThrow('disk full');
  });

  test('the corrupt copy keeps the exact text', () => {
    const folder = memoryFolder();
    expect(writeCorruptCopy('{"cards":[1,', T1, folder)).toBe(corruptFileName(T1));
    expect(folder.files.get(corruptFileName(T1))).toBe('{"cards":[1,');
  });

  test('the real folder is Paths.document/backups (on the jest-expo in-memory file system)', () => {
    const dir = new Directory(Paths.document, BACKUP_DIR);
    if (dir.exists) dir.delete();
    const folder = documentBackupFolder();
    expect(folder.names()).toEqual([]);
    folder.write('x.json', 'hello');
    expect(folder.names()).toEqual(['x.json']);
    expect(new File(dir, 'x.json').textSync()).toBe('hello');
    folder.remove('x.json');
    folder.remove('missing.json'); // no error
    expect(folder.names()).toEqual([]);
  });
});

/* ------------------------------------------------ the real DataProvider */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Data = ReturnType<typeof useData>;

/** Hands the provider's latest value to the test (from an effect, never during render). */
function Probe({ onData }: { onData: (data: Data) => void }) {
  const data = useData();
  useEffect(() => {
    onData(data);
  }, [data, onData]);
  return null;
}

/** Mount <DataProvider> and wait until its boot load finished. */
async function mount() {
  let latest: Data | null = null;
  const onData = (data: Data) => {
    latest = data;
  };
  let renderer: ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(DataProvider, null, React.createElement(Probe, { onData })),
    );
  });
  await act(async () => {});
  const data = (): Data => {
    if (!latest) throw new Error('DataProvider gave no value');
    return latest;
  };
  if (!data().ready) throw new Error('DataProvider did not become ready');
  return {
    data,
    /** Unmounting flushes a pending save (M16), like the app going away. */
    unmount: () =>
      act(async () => {
        renderer?.unmount();
      }),
  };
}

/** One user action, then let React commit. */
const tap = (fn: () => void) =>
  act(async () => {
    fn();
  });

/** Let time pass on the fake clock (this fires the 400 ms debounced save). */
async function pass(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await act(async () => {});
}

const backups = () => documentBackupFolder().names().sort();
const backupText = (name: string) => new File(new Directory(Paths.document, BACKUP_DIR), name).textSync();
/** The live document: what the row store holds (W3-3), or null when it is empty. */
async function storedDoc(): Promise<Record<string, unknown> | null> {
  const db = mockRows.db!;
  if (!(await db.hasRows())) return null;
  const port = createRowPort({
    open: async () => db,
    kv: createMemoryKv(),
    now: () => NOW,
    legacy: { readKv: async () => null, readAsyncStorage: async () => null },
  });
  const loaded = await port.load();
  return loaded.kind === 'doc' ? (loaded.value as Record<string, unknown>) : null;
}
/** A throwaway kv-store for reading the rows above (it is never written). */
function createMemoryKv() {
  const data = new Map<string, string>();
  return {
    getItem: async (key: string) => data.get(key) ?? null,
    setItem: async (key: string, value: string) => void data.set(key, value),
    multiSet: async (pairs: [string, string][]) => pairs.forEach(([k, v]) => data.set(k, v)),
  };
}
/** The row store's own meta rows, parsed (copiedFrom, bootOkCount …). */
const rowMeta = () => new Map(mockRows.db!.snapshot().meta.map(([k, v]) => [k, JSON.parse(v) as unknown]));
/** `state` as the row store loads it: every row table is a list (an older state shape gets the missing ones). */
const asLoaded = (state: object) => ({ ...Object.fromEntries(ROW_TABLES.map(({ key }) => [key, []])), ...state });
/** The old AsyncStorage copy (`maranki.state.v1`): only ever READ by this build. */
const oldCopy = () => AsyncStorage.getItem(STORAGE_KEY);
/** Put a text under the OLD AsyncStorage key, as an old build left it, and forget that call. */
async function storeRaw(raw: string) {
  await AsyncStorage.setItem(STORAGE_KEY, raw);
  jest.mocked(AsyncStorage.setItem).mockClear();
}
/** The write transactions of the live document (the row store). */
const rowWrites = () => mockRows.db!.writes;
/** The kv corrupt copy and the file corrupt copy of the kv port (storage/kvStoragePort.ts). */
const kvCorruptKey = (now: number) => `${KV_CORRUPT_PREFIX}${backupStamp(new Date(now))}`;
const kvCorruptFile = (now: number) => `corrupt-${backupStamp(new Date(now))}.json`;

describe('DataProvider — safe load and save (W1-1)', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    await AsyncStorage.clear();
    jest.clearAllMocks();
    kv().data.clear();
    kv().setItemKeys.length = 0;
    kv().multiSetKeys.length = 0;
    const dir = new Directory(Paths.document, BACKUP_DIR);
    if (dir.exists) dir.delete();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('first boot: the seed is saved in schema 3, and no safety copy is made', async () => {
    const app = await mount();
    expect(app.data().persistError).toBeNull();
    await pass(500);
    const saved = (await storedDoc())!;
    expect(saved.schemaVersion).toBe(3);
    expect(saved.minReaderVersion).toBe(3);
    expect(backups()).toEqual([]);
    await app.unmount();
  });

  test('a v2.0.2 document opens migrated, is saved as schema 3, and its raw text is kept once', async () => {
    const raw = stateFixtureRaw('v0-v2.0.2');
    await storeRaw(raw);
    const app = await mount();
    const { state, persistError } = app.data();
    expect(persistError).toBeNull();
    expect(state.schemaVersion).toBe(3);
    // The note model: every card has a note (its text) and keeps its raw v0 copy.
    expect(state.cards.every((c) => c.legacy && state.notes.some((n) => n.id === c.noteId))).toBe(true);
    const stunde = state.cards.find((c) => c.legacy?.base === 'Stunde')!;
    expect(state.notes.find((n) => n.id === stunde.noteId)?.fields[0]).toBe('die Stunde');
    // The killed session's marker was banked silently, exactly once (M5).
    expect(state.sessions).toHaveLength(2);
    expect(state.inProgressSession).toBeNull();
    expect(app.data().lastCompletion).toBeNull();

    // The pre-migration copy: one file, the exact old text.
    const copies = backups();
    expect(copies).toEqual([premigrateFileName(0, CURRENT_SCHEMA, NOW)]);
    expect(backupText(copies[0])).toBe(raw);

    // The debounced save writes schema 3 — into the row store, with the
    // record of the copy (W3-3). Nothing goes into the kv file, and the old
    // AsyncStorage copy is still there, unchanged (spec §3.1 rule 3).
    await pass(500);
    const saved = (await storedDoc())!;
    expect(saved.schemaVersion).toBe(3);
    expect(stateProblemsV3(saved as unknown as DataState)).toEqual([]); // the rows hold a v3 document
    expect(rowMeta().get('copiedFrom')).toMatchObject({ source: 'asyncStorage', key: STORAGE_KEY, length: raw.length });
    expect(kv().multiSetKeys).toEqual([]);
    expect(kv().data.has(KV_STATE_KEY)).toBe(false);
    expect(await oldCopy()).toBe(raw);
    await app.unmount();

    // Next boot: the stored document is schema 3 now — no new copy, nothing banked twice.
    jest.setSystemTime(NOW + 60_000);
    const again = await mount();
    expect(backups()).toEqual(copies);
    expect(again.data().state.sessions).toHaveLength(2);
    expect(again.data().state.cards).toEqual(state.cards);
    await again.unmount();
  });

  test('killed before the first save: the next boot migrates again but writes no second copy', async () => {
    const raw = stateFixtureRaw('v1-main-1333d48');
    await storeRaw(raw);
    // A4 (spec §3.10 step 3): the boot itself copies into the rows. A kill in
    // the middle of that transaction rolls it back, as this failed write does.
    mockRows.db!.failWrites = 1;
    const first = await mount();
    expect(first.data().state.schemaVersion).toBe(3);
    expect(rowWrites()).toBe(0); // killed now: the copy never committed
    // (no unmount: an OS kill runs no cleanup)
    jest.setSystemTime(NOW + 60_000);
    const second = await mount();
    expect(second.data().persistError).toBeNull();
    expect(backups()).toEqual([premigrateFileName(1, CURRENT_SCHEMA, NOW)]);
    await second.unmount();
    await first.unmount();
  });

  test('a corrupt text is copied to the kv-store and to backups/corrupt-{stamp}.json before the seed', async () => {
    const raw = '{"cards":[{"id":"c1","front":"Hal';
    await storeRaw(raw);
    const app = await mount();
    expect(app.data().persistError).toBeNull();
    expect(app.data().state.cards).toEqual([]);
    // W2-1: the two copies are the kv port's (spec §3.10): a kv key and a file.
    expect(kv().data.get(kvCorruptKey(NOW))).toBe(raw);
    expect(backups()).toEqual([kvCorruptFile(NOW)]);
    expect(backupText(kvCorruptFile(NOW))).toBe(raw);
    await pass(500);
    expect((await storedDoc())!.schemaVersion).toBe(3); // the seed, now writable (in the rows)
    expect(await oldCopy()).toBe(raw); // the old copy is never changed
    await app.unmount();
  });

  test('a too-new document blocks every write: the stored text never changes', async () => {
    const raw = JSON.stringify({ schemaVersion: 9, minReaderVersion: 9, notes: [{ id: 'n1' }] });
    await storeRaw(raw);
    const app = await mount();
    expect(app.data().persistError).toBe('too-new');
    await tap(() => app.data().actions.updateAppSettings({ hapticsEnabled: false }));
    await tap(() => app.data().actions.setLimits({ dailyNewLimit: 3 }));
    await pass(2000);
    await app.unmount(); // the unmount flush is gated too
    // Nothing was written: the row store is still empty (W3-3: nothing is
    // copied before migrate() could read it), the kv file has no copy, and
    // the old copy is untouched.
    expect(await storedDoc()).toBeNull();
    expect(rowWrites()).toBe(0);
    expect(kv().data.has(KV_STATE_KEY)).toBe(false);
    expect(await oldCopy()).toBe(raw);
    expect(backups()).toEqual([]);
  });

  test('a read failure blocks every write (C1)', async () => {
    await storeRaw(JSON.stringify(makeState({ onboarded: true })));
    jest.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('CursorWindow'));
    const app = await mount();
    expect(app.data().persistError).toBe('read');
    await tap(() => app.data().actions.markOnboarded());
    await pass(2000);
    await app.unmount();
    expect(rowWrites()).toBe(0);
  });

  test('restore replaces the state, re-enables saving and saves at once', async () => {
    jest.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('CursorWindow'));
    const app = await mount();
    expect(app.data().persistError).toBe('read');

    const out = migrate(JSON.parse(stateFixtureRaw('v1-main-1333d48')), NOW);
    if (out.kind !== 'ok') throw new Error('fixture did not migrate');
    const backup: DataState = { ...out.state, inProgressSession: null };

    await tap(() => app.data().actions.restore(backup));
    expect(app.data().state).toStrictEqual(backup);
    expect(app.data().persistError).toBeNull();
    // Saved at once: no timer has run yet (one replace-all transaction).
    expect(rowWrites()).toBe(1);
    expect(await storedDoc()).toEqual(asLoaded(JSON.parse(serialize(backup))));

    // Saving stays on for the next change.
    await tap(() => app.data().actions.setGoals(5, 5));
    await pass(500);
    expect(((await storedDoc())!.person as DataState['person']).goalReviews).toBe(5);
    await app.unmount();
  });

  test('restore wins over a change that was still waiting for its debounced save', async () => {
    const app = await mount();
    await tap(() => app.data().actions.setGoals(1, 1));
    const backup: DataState = { ...buildSeedState(NOW), onboarded: true };
    await tap(() => app.data().actions.restore(backup));
    await pass(1000);
    expect(await storedDoc()).toEqual(asLoaded(JSON.parse(serialize(backup))));
    await app.unmount();
  });

  test('setLimits clamps the review limit to ≥ 10 and never touches the goals', async () => {
    const app = await mount();
    const srs = () => app.data().state.settings.srs;
    await tap(() => app.data().actions.setLimits({ dailyReviewLimit: 0 }));
    expect(srs().dailyReviewLimit).toBe(10);
    await tap(() => app.data().actions.setLimits({ dailyNewLimit: 5.4 }));
    expect(srs()).toMatchObject({ dailyNewLimit: 5, dailyReviewLimit: 10 });
    await tap(() => app.data().actions.setLimits({ dailyReviewLimit: Number.NaN, dailyNewLimit: 5000 }));
    expect(srs()).toMatchObject({ dailyNewLimit: 999, dailyReviewLimit: 10 });
    await tap(() => app.data().actions.setLimits({ dailyReviewLimit: 250 }));
    expect(srs().dailyReviewLimit).toBe(250);
    const { goalReviews, goalNew } = app.data().state.person;
    // The first-run goals, unchanged: the seed's pace (seed.ts DEFAULT_PACE, the tour's middle
    // answer: 30 reviews and 10 new a day again since wave 5d; wave 5c had 20 / 6).
    const seed = buildSeedState(NOW).person;
    expect([goalReviews, goalNew]).toEqual([seed.goalReviews, seed.goalNew]);
    expect([goalReviews, goalNew]).toEqual([30, 10]);
    // …and setGoals never writes the limits.
    await tap(() => app.data().actions.setGoals(0, 0));
    expect(srs()).toMatchObject({ dailyNewLimit: 999, dailyReviewLimit: 250 });
    await app.unmount();
  });
});

/* ------------------------- DataProvider: effect re-runs and boot errors (W2-1) */

/** Catches a render error like the root layout's ErrorBoundary export does. */
class Boundary extends React.Component<
  { onError: (error: unknown) => void; children?: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

describe('DataProvider — an effect that runs twice, and boot errors (W2-1 review)', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    await AsyncStorage.clear();
    jest.clearAllMocks();
    kv().data.clear();
    kv().setItemKeys.length = 0;
    kv().multiSetKeys.length = 0;
    mockReconcileThrows = false;
  });

  afterEach(() => {
    mockReconcileThrows = false;
    jest.useRealTimers();
  });

  test('inside React.StrictMode (setup → cleanup → setup): ready, and a change is saved once', async () => {
    let latest: Data | null = null;
    const onData = (data: Data) => {
      latest = data;
    };
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(DataProvider, null, React.createElement(Probe, { onData })),
        ),
      );
    });
    await act(async () => {});
    const data = (): Data => {
      if (!latest) throw new Error('DataProvider gave no value');
      return latest;
    };
    // Before the fix: the cleanup disposed the engine, the second setup's
    // boot() was rejected in silence, and `ready` never came (endless splash).
    expect(data().ready).toBe(true);
    await tap(() => data().actions.setGoals(13, 3));
    await pass(2000);
    // One write: the boot's seed and the change are saved together (debounce).
    expect(rowWrites()).toBe(1);
    expect(((await storedDoc())!.person as DataState['person']).goalReviews).toBe(13);
    await act(async () => {
      renderer?.unmount();
    });
  });

  test('a bug in the boot reconcile reaches the error boundary (the crash screen), not an endless splash', async () => {
    mockReconcileThrows = true;
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined); // React logs the caught error
    const errors: unknown[] = [];
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          Boundary,
          { onError: (error: unknown) => errors.push(error) },
          React.createElement(DataProvider, null, React.createElement(Probe, { onData: () => undefined })),
        ),
      );
    });
    await act(async () => {});
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('reconcile bug');
    await act(async () => {
      renderer?.unmount();
    });
    quiet.mockRestore();
  });
});

/* ------------------------------------- the crash screen's "Save a copy" line */

/** All the text inside a rendered element. */
function textOf(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node;
  return node.children.map(textOf).join('');
}

describe('ErrorScreen — "Save a copy of my data" says what happened (W2-1 review)', () => {
  const INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    jest.clearAllMocks();
    kv().data.clear();
    kv().data.set(KV_STATE_KEY, '{"the":"raw text"}');
    const dir = new Directory(Paths.document, BACKUP_DIR);
    if (dir.exists) dir.delete();
  });

  afterEach(() => {
    mockSharing.isAvailableAsync.mockImplementation(async () => true);
    mockSharing.shareAsync.mockImplementation(async () => undefined);
    jest.useRealTimers();
  });

  /** Render the crash screen, press "Save a copy of my data", and return the result line. */
  async function pressSaveACopy(): Promise<string | null> {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            SafeAreaInsetsContext.Provider,
            { value: INSETS },
            React.createElement(ErrorScreen, { error: new Error('boom'), retry: async () => undefined }),
          ),
        ),
      );
    });
    const root = renderer!.root;
    const button = root.findAll((n) => typeof n.props.onPress === 'function' && textOf(n) === CRASH_COPY.rescue)[0];
    await act(async () => {
      button.props.onPress();
    });
    await act(async () => {});
    const line = root.findAll((n) => n.props.accessibilityLiveRegion === 'polite');
    const text = line.length > 0 ? textOf(line[0]) : null;
    await act(async () => {
      renderer?.unmount();
    });
    return text;
  }

  test('sharing works but the share sheet fails → "the share sheet did not open", never "not available"', async () => {
    mockSharing.shareAsync.mockImplementation(async () => {
      throw new Error('share sheet busy');
    });
    const line = await pressSaveACopy();
    const file = rescueFileName(NOW);
    expect(line).toBe(`The share sheet did not open, so the copy was saved inside Maranki as ${file}.`);
    expect(backupText(file)).toBe('{"the":"raw text"}');
  });

  test('no share sheet on this device → "Sharing is not available"', async () => {
    mockSharing.isAvailableAsync.mockImplementation(async () => false);
    const line = await pressSaveACopy();
    expect(line).toBe(
      `Sharing is not available, so the copy was saved inside Maranki as ${rescueFileName(NOW)}.`,
    );
    expect(mockSharing.shareAsync).not.toHaveBeenCalled();
  });

  test('the share sheet opened → no line (the sheet itself was the answer)', async () => {
    expect(await pressSaveACopy()).toBeNull();
    expect(mockSharing.shareAsync).toHaveBeenCalledTimes(1);
  });
});

/* --------------------------------------- the theme in the kv-store (W2-1) */

type Theme = ReturnType<typeof useTheme>;

/** Hands every theme value to the test (from an effect, never during render). */
function ThemeProbe({ onTheme }: { onTheme: (theme: Theme) => void }) {
  const theme = useTheme();
  useEffect(() => {
    onTheme(theme);
  }, [theme, onTheme]);
  return null;
}

/** Mount <ThemeProvider> and keep every value it gave, in order. */
async function mountTheme() {
  const seen: Theme[] = [];
  const onTheme = (theme: Theme) => {
    seen.push(theme);
  };
  let renderer: ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(ThemeProvider, null, React.createElement(ThemeProbe, { onTheme })),
    );
  });
  await act(async () => {});
  return {
    first: () => seen[0],
    latest: () => seen[seen.length - 1],
    unmount: () =>
      act(async () => {
        renderer?.unmount();
      }),
  };
}

const themeReads = () => jest.mocked(AsyncStorage.getItem).mock.calls.filter(([key]) => key === THEME_KEY);

describe('ThemeProvider — the theme lives in the kv-store (W2-1)', () => {
  // Every theme write waits for the app port's FIRST load (afterAppStorageLoad,
  // storage/index.ts): the copy-forward may write the kv file then. In the app,
  // DataProvider always makes that load. Make it here too, on empty storage
  // (so nothing is written), so these tests do not depend on an earlier
  // DataProvider test: they pass alone (`-t ThemeProvider`) and in any order.
  beforeAll(async () => {
    await AsyncStorage.clear();
    kv().data.clear();
    await appStoragePort()
      .load()
      .catch(() => undefined);
  });

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    kv().data.clear();
    kv().setItemKeys.length = 0;
  });

  test('a saved theme is read synchronously: the very first value is the real one (no light flash)', async () => {
    kv().data.set(THEME_KEY, 'dark');
    const app = await mountTheme();
    expect(app.first()).toMatchObject({ mode: 'dark', resolved: 'dark', hydrated: true });
    expect(themeReads()).toEqual([]); // the old AsyncStorage key is not looked at
    await app.unmount();
  });

  test('the old AsyncStorage choice is copied into the kv-store ONCE, and the old key stays', async () => {
    await AsyncStorage.setItem(THEME_KEY, 'system');
    const first = await mountTheme();
    expect(first.first()).toMatchObject({ mode: 'light', hydrated: false }); // waits for the old read
    expect(first.latest()).toMatchObject({ mode: 'system', hydrated: true });
    expect(kv().data.get(THEME_KEY)).toBe('system');
    expect(await AsyncStorage.getItem(THEME_KEY)).toBe('system');
    await first.unmount();

    jest.mocked(AsyncStorage.getItem).mockClear();
    const second = await mountTheme();
    expect(second.first()).toMatchObject({ mode: 'system', hydrated: true });
    expect(themeReads()).toEqual([]);
    await second.unmount();
  });

  test('no old choice either: the default is written, so the next run does not look again', async () => {
    const app = await mountTheme();
    expect(app.latest()).toMatchObject({ mode: 'light', hydrated: true });
    expect(kv().data.get(THEME_KEY)).toBe('light');
    await app.unmount();
  });

  test('setMode saves the choice in the kv-store', async () => {
    kv().data.set(THEME_KEY, 'light');
    const app = await mountTheme();
    await act(async () => {
      app.latest().setMode('dark');
    });
    expect(app.latest()).toMatchObject({ mode: 'dark', resolved: 'dark' });
    expect(kv().data.get(THEME_KEY)).toBe('dark');
    await app.unmount();
  });
});
