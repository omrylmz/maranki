/**
 * Tests for copy-forward (spec §3.7 + §3.10, unit W1-2) and the native
 * adapters around it: the kv port, the AsyncStorage port, the RKStorage
 * rescue and createStoragePort().
 *
 * The copy-forward rules are tested with injected fakes. The native modules
 * have no real implementation under jest, so they are replaced here:
 *   - AsyncStorage        → its official jest mock (an in-memory object),
 *   - expo-sqlite/kv-store → a tiny in-memory SQLiteStorage that records its db name,
 *   - expo-sqlite         → `openDatabaseAsync` as a jest.fn (for the rescue),
 *   - expo-file-system    → a small in-memory file tree (for the rescue and corrupt files),
 *   - ./rowStore          → the real module, but openRowDb() opens a memory RowDb
 *                           (W3-3: createStoragePort() is the row store on a phone).
 * The rescue itself must still be proven on the emulator (check E2b).
 */
// '@jest/globals' must be imported FIRST: the jest.mock factories below use
// its `jest`, and they run when the mocked modules are imported.
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { openDatabaseAsync } from 'expo-sqlite';
import { Platform } from 'react-native';

import { FIXED_NOW } from '../../test/clock';
import { makeState, stateFixtureRaw, type StateV2 } from '../../test/factories';
import { backupStamp } from '../backup';
import { createPersistController } from '../persistController';
import { BACKUP_KEY, STORAGE_KEY } from '../persistence';
import type { StoragePort } from '../storagePort';
import { createAsyncStoragePort, readLegacyAsyncStorage } from './asyncStoragePort';
import {
  createCopyForwardPort,
  KV_COPIED_FROM_KEY,
  LegacyReadError,
  readCopiedFrom,
  type CopiedFrom,
  type LegacySources,
} from './copyForward';
import { createStoragePort } from './index';
import {
  createKvStoragePort,
  getKvStore,
  KV_CORRUPT_PREFIX,
  KV_DB_NAME,
  KV_STATE_KEY,
  writeCorruptBackupFile,
} from './kvStoragePort';
import { createMemoryStore, type MemoryStore } from './memoryPort';
import { rescueRkStorage, RK_FILES } from './rkRescue';
import type { RowDb } from './rowStore';

/* ------------------------------------------------------------ module mocks */

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('expo-sqlite/kv-store', () => {
  class SQLiteStorage {
    static instances: SQLiteStorage[] = [];
    readonly databaseName: string;
    readonly data = new Map<string, string>();
    constructor(databaseName: string) {
      this.databaseName = databaseName;
      SQLiteStorage.instances.push(this);
    }
    async getItem(key: string) {
      return this.data.get(key) ?? null;
    }
    async setItem(key: string, value: string) {
      this.data.set(key, value);
    }
    async multiSet(pairs: [string, string][]) {
      for (const [key, value] of pairs) this.data.set(key, value);
    }
  }
  return { SQLiteStorage };
});

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

/** The row database of createStoragePort() (W3-3): a new memory RowDb per port. */
const mockOpenRowDb = jest.fn(async (): Promise<RowDb> =>
  jest.requireActual<typeof import('./rowStore')>('./rowStore').createMemoryRowDb(),
);
jest.mock('./rowStore', () => ({
  ...jest.requireActual<object>('./rowStore'),
  openRowDb: () => mockOpenRowDb(),
}));

jest.mock('expo-file-system', () => {
  // A tiny in-memory file tree. URIs never end with '/'.
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const log: string[] = [];
  const uriOf = (parts: unknown[]) =>
    parts.map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri).replace(/\/+$/, '')).join('/');
  const parentOf = (uri: string) => uri.slice(0, uri.lastIndexOf('/'));

  class Directory {
    readonly uri: string;
    constructor(...parts: unknown[]) {
      this.uri = uriOf(parts);
    }
    get exists() {
      return dirs.has(this.uri);
    }
    get parentDirectory() {
      return new Directory(parentOf(this.uri));
    }
    create() {
      log.push(`mkdir ${this.uri}`);
      dirs.add(this.uri);
    }
    delete() {
      log.push(`rm ${this.uri}`);
      dirs.delete(this.uri);
      for (const key of [...files.keys()]) if (key.startsWith(`${this.uri}/`)) files.delete(key);
    }
  }

  class File {
    readonly uri: string;
    constructor(...parts: unknown[]) {
      this.uri = uriOf(parts);
    }
    get exists() {
      return files.has(this.uri);
    }
    create() {
      if (!dirs.has(parentOf(this.uri))) throw new Error(`no folder for ${this.uri}`);
      files.set(this.uri, '');
    }
    write(text: string) {
      files.set(this.uri, text);
    }
    async copy(dest: { uri: string }) {
      if (!dirs.has(parentOf(dest.uri))) throw new Error(`no folder for ${dest.uri}`);
      log.push(`copy ${this.uri} → ${dest.uri}`);
      files.set(dest.uri, files.get(this.uri) ?? '');
    }
  }

  const Paths = {
    get document() {
      return new Directory('file:///data/app/files');
    },
    get cache() {
      return new Directory('file:///data/app/cache');
    },
  };
  return { Directory, File, Paths, __fs: { files, dirs, log } };
});

/* ---------------------------------------------------------------- helpers */

type S = StateV2;

interface FakeFs {
  files: Map<string, string>;
  dirs: Set<string>;
  log: string[];
}
const fakeFs = (jest.requireMock('expo-file-system') as { __fs: FakeFs }).__fs;
const kvStoreMock = jest.requireMock('expo-sqlite/kv-store') as {
  SQLiteStorage: { instances: { databaseName: string; data: Map<string, string> }[] };
};
const openDb = openDatabaseAsync as unknown as jest.Mock<(...args: unknown[]) => Promise<unknown>>;

/** Every AsyncStorage method that could change or delete data. */
const ASYNC_WRITES = ['setItem', 'multiSet', 'removeItem', 'multiRemove', 'clear', 'mergeItem', 'multiMerge'] as const;
function asyncStorageWriteCalls(): number {
  const mock = AsyncStorage as unknown as Record<string, jest.Mock>;
  return ASYNC_WRITES.reduce((sum, name) => sum + mock[name].mock.calls.length, 0);
}

/** Fake old sources that record every read. They have no write method at all. */
function fakeLegacy(
  asyncValue: string | null | Error,
  rescueValue?: string | null | Error,
): LegacySources & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readAsyncStorage: async () => {
      reads.push('asyncStorage');
      if (asyncValue instanceof Error) throw asyncValue;
      return asyncValue;
    },
    rescue:
      rescueValue === undefined
        ? undefined
        : async () => {
            reads.push('rescue');
            if (rescueValue instanceof Error) throw rescueValue;
            return rescueValue;
          },
  };
}

/** A kv store whose reads (or writes) fail. */
function brokenKv(inner: MemoryStore, fail: 'get' | 'multiSet') {
  return {
    getItem: async (key: string) => {
      if (fail === 'get') throw new Error('kv read failed');
      return inner.getItem(key);
    },
    setItem: (key: string, value: string) => inner.setItem(key, value),
    multiSet: async (pairs: [string, string][]) => {
      if (fail === 'multiSet') throw new Error('kv write failed');
      return inner.multiSet(pairs);
    },
  };
}

function copyForward(kv: Parameters<typeof createCopyForwardPort>[0]['kv'], legacy: LegacySources) {
  return createCopyForwardPort<S>({ kv, legacy, now: () => FIXED_NOW, corruptFile: () => undefined });
}

const V0_RAW = stateFixtureRaw('v0-v2.0.2');
const V1_RAW = stateFixtureRaw('v1-main-1333d48');
const STAMP = backupStamp(new Date(FIXED_NOW));

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks(); // call counts start at zero (implementations stay)
  fakeFs.files.clear();
  fakeFs.dirs.clear();
  fakeFs.log.length = 0;
  for (const instance of kvStoreMock.SQLiteStorage.instances) instance.data.clear();
});

/* ----------------------------------------------------------- copy-forward */

describe('copy-forward', () => {
  test('kv present → use it (the old sources are not even read)', async () => {
    const kv = createMemoryStore({ [KV_STATE_KEY]: V1_RAW });
    const legacy = fakeLegacy(V0_RAW, 'rescued');
    const loaded = await copyForward(kv, legacy).load();

    expect(loaded).toEqual({ kind: 'doc', value: JSON.parse(V1_RAW), raw: V1_RAW });
    expect(legacy.reads).toEqual([]);
    expect(kv.writes).toBe(0);
  });

  test('else AsyncStorage readable → raw copied to kv + copiedFrom, AsyncStorage never deleted', async () => {
    const kv = createMemoryStore();
    const legacy = fakeLegacy(V0_RAW);
    const loaded = await copyForward(kv, legacy).load();

    expect(loaded).toEqual({ kind: 'doc', value: JSON.parse(V0_RAW), raw: V0_RAW });
    const copiedFrom: CopiedFrom = { source: 'asyncStorage', key: STORAGE_KEY, at: FIXED_NOW, length: V0_RAW.length };
    // Byte for byte, BEFORE migration, and both keys in ONE write (one transaction).
    expect(kv.snapshot()).toEqual({ [KV_STATE_KEY]: V0_RAW, [KV_COPIED_FROM_KEY]: JSON.stringify(copiedFrom) });
    expect(kv.writes).toBe(1);
    await expect(readCopiedFrom(kv)).resolves.toEqual(copiedFrom);
    // The old source is read-only by its type: it has no method that writes.
    expect(Object.keys(legacy).sort()).toEqual(['readAsyncStorage', 'reads', 'rescue']);

    // The next boot finds kv and does not copy again.
    const reboot = await copyForward(kv, legacy).load();
    expect(reboot.kind).toBe('doc');
    expect(legacy.reads).toEqual(['asyncStorage']);
    expect(kv.writes).toBe(1);
  });

  test('AsyncStorage rejects → rescue; the rescued text is copied with source "rkRescue"', async () => {
    const kv = createMemoryStore();
    const legacy = fakeLegacy(new Error('Row too big to fit into CursorWindow'), V0_RAW);
    const loaded = await copyForward(kv, legacy).load();

    expect(legacy.reads).toEqual(['asyncStorage', 'rescue']);
    expect(loaded.kind === 'doc' && loaded.raw).toBe(V0_RAW);
    expect(kv.snapshot()[KV_STATE_KEY]).toBe(V0_RAW);
    await expect(readCopiedFrom(kv)).resolves.toMatchObject({ source: 'rkRescue', key: STORAGE_KEY });
  });

  test('rescue null → read-blocked (load rejects); nothing is written', async () => {
    const kv = createMemoryStore();
    const legacy = fakeLegacy(new Error('Row too big'), null);
    await expect(copyForward(kv, legacy).load()).rejects.toBeInstanceOf(LegacyReadError);
    expect(kv.writes).toBe(0);

    // Through the controller: blocked with reason 'read', still nothing written, never a seed.
    const controller = createPersistController<S>(copyForward(kv, legacy), {
      now: () => FIXED_NOW,
      decode: (value) => ({ kind: 'ok', state: value as S }),
      seed: (now) => makeState({}, now),
    });
    const boot = await controller.load();
    expect(boot.kind === 'blocked' && boot.reason).toBe('read');
    controller.scheduleSave(makeState());
    await controller.flush();
    expect(kv.writes).toBe(0);
  });

  test('a rescue that throws counts as "nothing found" → read-blocked', async () => {
    const legacy = fakeLegacy(new Error('Row too big'), new Error('rescue bug'));
    await expect(copyForward(createMemoryStore(), legacy).load()).rejects.toBeInstanceOf(LegacyReadError);
  });

  test('no rescue on this platform (iOS) and AsyncStorage rejects → read-blocked', async () => {
    const legacy = fakeLegacy(new Error('native error'));
    await expect(copyForward(createMemoryStore(), legacy).load()).rejects.toBeInstanceOf(LegacyReadError);
    expect(legacy.reads).toEqual(['asyncStorage']);
  });

  test('kv read failure → read-blocked even if legacy is readable', async () => {
    const legacy = fakeLegacy(V0_RAW);
    const kv = brokenKv(createMemoryStore(), 'get');
    await expect(copyForward(kv, legacy).load()).rejects.toThrow('kv read failed');
    // Never fall back to the old copy: it may be older than the kv data.
    expect(legacy.reads).toEqual([]);
  });

  test('corrupt legacy → corrupt path (nothing copied; the controller keeps a copy, then seeds)', async () => {
    const corrupt = V0_RAW.slice(0, 500); // cut off mid-write
    const kv = createMemoryStore();
    const port = copyForward(kv, fakeLegacy(corrupt));
    await expect(port.load()).resolves.toEqual({ kind: 'corrupt', raw: corrupt });
    expect(kv.writes).toBe(0);

    const controller = createPersistController<S>(copyForward(kv, fakeLegacy(corrupt)), {
      now: () => FIXED_NOW,
      decode: (value) => ({ kind: 'ok', state: value as S }),
      seed: (now) => makeState({}, now),
    });
    const boot = await controller.load();
    expect(boot.kind).toBe('corrupt');
    if (boot.kind === 'corrupt') controller.scheduleSave(boot.state);
    await controller.flush();
    expect(kv.snapshot()).toEqual({
      [`${KV_CORRUPT_PREFIX}${STAMP}`]: corrupt,
      [KV_STATE_KEY]: JSON.stringify(makeState({}, FIXED_NOW)),
    });
  });

  test('nothing anywhere → empty (a genuine first boot), nothing written', async () => {
    const kv = createMemoryStore();
    await expect(copyForward(kv, fakeLegacy(null)).load()).resolves.toEqual({ kind: 'empty' });
    await expect(copyForward(kv, fakeLegacy('')).load()).resolves.toEqual({ kind: 'empty' });
    expect(kv.writes).toBe(0);
    await expect(readCopiedFrom(kv)).resolves.toBeNull();
  });

  test('the copy write fails → read-blocked; the next boot tries the copy again', async () => {
    const inner = createMemoryStore();
    const legacy = fakeLegacy(V0_RAW);
    await expect(copyForward(brokenKv(inner, 'multiSet'), legacy).load()).rejects.toThrow('kv write failed');
    expect(inner.snapshot()).toEqual({});

    const retry = await copyForward(inner, legacy).load();
    expect(retry.kind).toBe('doc');
    expect(inner.snapshot()[KV_STATE_KEY]).toBe(V0_RAW);
  });

  test('saves go to the kv key only', async () => {
    const kv = createMemoryStore();
    const port = copyForward(kv, fakeLegacy(V1_RAW));
    await port.load();
    const next = makeState({ onboarded: true });
    await port.save(next, null);
    expect(kv.snapshot()[KV_STATE_KEY]).toBe(JSON.stringify(next));
  });

  test('readRaw: the kv text; else the old text; null when the kv read fails or nothing is readable', async () => {
    await expect(copyForward(createMemoryStore({ [KV_STATE_KEY]: V1_RAW }), fakeLegacy(V0_RAW)).readRaw()).resolves.toBe(
      V1_RAW,
    );
    await expect(copyForward(createMemoryStore(), fakeLegacy(V0_RAW)).readRaw()).resolves.toBe(V0_RAW);
    await expect(copyForward(createMemoryStore(), fakeLegacy(new Error('x'), V0_RAW)).readRaw()).resolves.toBe(V0_RAW);
    await expect(copyForward(createMemoryStore(), fakeLegacy(new Error('x'), null)).readRaw()).resolves.toBeNull();
    // The live data is in kv but unreadable: do not hand out the OLDER copy as the user's data.
    await expect(copyForward(brokenKv(createMemoryStore(), 'get'), fakeLegacy(V0_RAW)).readRaw()).resolves.toBeNull();
  });

  test('readCopiedFrom: null for a missing, unreadable or broken record', async () => {
    await expect(readCopiedFrom(createMemoryStore())).resolves.toBeNull();
    await expect(readCopiedFrom(createMemoryStore({ [KV_COPIED_FROM_KEY]: '{bad' }))).resolves.toBeNull();
    await expect(readCopiedFrom(brokenKv(createMemoryStore(), 'get'))).resolves.toBeNull();
  });
});

/* ------------------------------------------------- AsyncStorage (jest mock) */

describe('AsyncStorage port (official jest mock)', () => {
  test('readLegacyAsyncStorage reads the old key maranki.state.v1', async () => {
    await AsyncStorage.setItem(STORAGE_KEY, V0_RAW);
    await expect(readLegacyAsyncStorage()).resolves.toBe(V0_RAW);
    await AsyncStorage.removeItem(STORAGE_KEY);
    await expect(readLegacyAsyncStorage()).resolves.toBeNull();
  });

  test('createAsyncStoragePort: save/load under maranki.state.v1; a corrupt copy goes to BACKUP_KEY', async () => {
    const files: string[] = [];
    const port: StoragePort<S> = createAsyncStoragePort<S>({ now: () => FIXED_NOW, corruptFile: (raw) => void files.push(raw) });
    const state = makeState();
    await port.save(state, null);
    await expect(AsyncStorage.getItem(STORAGE_KEY)).resolves.toBe(JSON.stringify(state));
    await expect(port.load()).resolves.toEqual({ kind: 'doc', value: state, raw: JSON.stringify(state) });

    await port.preserveCorrupt('{"broken');
    await expect(AsyncStorage.getItem(BACKUP_KEY)).resolves.toBe('{"broken');
    expect(files).toEqual(['{"broken']);
    await expect(AsyncStorage.getItem(STORAGE_KEY)).resolves.toBe(JSON.stringify(state)); // live key untouched
  });

  test('end to end: copy-forward from the real AsyncStorage never writes or deletes it', async () => {
    await AsyncStorage.setItem(STORAGE_KEY, V0_RAW);
    jest.clearAllMocks(); // forget the test's own setItem

    const kv = createMemoryStore();
    const port = createCopyForwardPort<S>({
      kv,
      legacy: { readAsyncStorage: () => readLegacyAsyncStorage() },
      now: () => FIXED_NOW,
      corruptFile: () => undefined,
    });
    const controller = createPersistController<S>(port, {
      now: () => FIXED_NOW,
      decode: (value) => ({ kind: 'ok', state: value as S }),
      seed: (now) => makeState({}, now),
    });
    const boot = await controller.load();
    expect(boot.kind).toBe('loaded');
    controller.scheduleSave(makeState({ onboarded: true }));
    await controller.flush();

    expect(asyncStorageWriteCalls()).toBe(0);
    await expect(AsyncStorage.getItem(STORAGE_KEY)).resolves.toBe(V0_RAW); // the old copy, byte for byte
    expect(kv.snapshot()[KV_STATE_KEY]).toBe(JSON.stringify(makeState({ onboarded: true })));
  });
});

/* ------------------------------------------------------------------ kv port */

describe('kv port', () => {
  test('uses new SQLiteStorage("maranki-kv.db") and the key "maranki.state"', async () => {
    const port = createKvStoragePort<S>({ now: () => FIXED_NOW, corruptFile: () => undefined });
    const state = makeState();
    await port.save(state, null);

    const store = getKvStore() as unknown as { databaseName: string; data: Map<string, string> };
    expect(KV_DB_NAME).toBe('maranki-kv.db');
    expect(store.databaseName).toBe('maranki-kv.db');
    expect(kvStoreMock.SQLiteStorage.instances).toHaveLength(1); // one shared instance
    expect(getKvStore()).toBe(getKvStore());
    expect([...store.data.keys()]).toEqual(['maranki.state']);
    await expect(port.load()).resolves.toEqual({ kind: 'doc', value: state, raw: JSON.stringify(state) });
  });

  test('a corrupt copy: kv key maranki.state.corrupt.{stamp} AND the file backups/corrupt-{stamp}.json', async () => {
    const port = createKvStoragePort<S>({ now: () => FIXED_NOW }); // default file writer
    await port.preserveCorrupt('{"broken');
    const store = getKvStore() as unknown as { data: Map<string, string> };
    expect(store.data.get(`maranki.state.corrupt.${STAMP}`)).toBe('{"broken');
    expect(fakeFs.files.get(`file:///data/app/files/backups/corrupt-${STAMP}.json`)).toBe('{"broken');
  });

  test('writeCorruptBackupFile creates the backups folder when needed', () => {
    writeCorruptBackupFile('raw text', 'stamp');
    expect(fakeFs.dirs.has('file:///data/app/files/backups')).toBe(true);
    expect(fakeFs.files.get('file:///data/app/files/backups/corrupt-stamp.json')).toBe('raw text');
  });
});

/* ----------------------------------------------------------- createStoragePort */

describe('createStoragePort', () => {
  // W3-3: on a phone createStoragePort() is the ROW store. It reads the old
  // AsyncStorage copy through the legacy chain, and the first save copies it
  // into the rows (legacyChain.test.ts); nothing is copied into the kv file.
  test('native: the row store reads the old AsyncStorage copy; nothing is copied into the kv-store', async () => {
    await AsyncStorage.setItem(STORAGE_KEY, V1_RAW);
    const port = createStoragePort<S>(() => FIXED_NOW);
    const loaded = await port.load();
    expect(loaded.kind === 'doc' && loaded.raw).toBe(V1_RAW);
    expect(mockOpenRowDb).toHaveBeenCalledTimes(1);
    const store = getKvStore() as unknown as { databaseName: string; data: Map<string, string> };
    expect(store.databaseName).toBe(KV_DB_NAME);
    expect(store.data.has(KV_STATE_KEY)).toBe(false);
    await expect(AsyncStorage.getItem(STORAGE_KEY)).resolves.toBe(V1_RAW);
  });

  test('web: a memory port (nothing reaches the kv-store)', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'web');
    try {
      const port = createStoragePort<S>(() => FIXED_NOW);
      await port.save(makeState(), null);
      const store = getKvStore() as unknown as { data: Map<string, string> };
      expect(store.data.size).toBe(0);
      await expect(port.load()).resolves.toMatchObject({ kind: 'doc' });
      expect(asyncStorageWriteCalls()).toBe(0);
    } finally {
      os.restore();
    }
  });
});

/* ------------------------------------------------------------ RKStorage rescue */

const APP = 'file:///data/app';
const DB_DIR = `${APP}/databases`;
const TMP = `${APP}/cache/rk-rescue`;

/** A fake opened database that answers the one rescue query. */
function fakeDb(value: unknown, fail = false) {
  return {
    getFirstAsync: jest.fn(async (_sql: string, _key: string) => {
      if (fail) throw new Error('no such table: catalystLocalStorage');
      return value === undefined ? null : { value };
    }),
    closeAsync: jest.fn(async () => undefined),
  };
}

function putRkFiles(names: readonly string[]) {
  fakeFs.dirs.add(DB_DIR);
  for (const name of names) fakeFs.files.set(`${DB_DIR}/${name}`, `bytes of ${name}`);
}

describe('RKStorage rescue', () => {
  test('not Android → null, nothing touched', async () => {
    putRkFiles(['RKStorage']);
    await expect(rescueRkStorage(STORAGE_KEY, 'ios')).resolves.toBeNull();
    expect(fakeFs.log).toEqual([]);
    expect(openDb).not.toHaveBeenCalled();
  });

  test('no RKStorage file → null, nothing opened', async () => {
    await expect(rescueRkStorage(STORAGE_KEY, 'android')).resolves.toBeNull();
    expect(openDb).not.toHaveBeenCalled();
  });

  test('copies RKStorage (+ the side files that exist) to cache/rk-rescue BEFORE opening the copy', async () => {
    putRkFiles(['RKStorage', 'RKStorage-wal', 'RKStorage-shm']);
    const db = fakeDb(V0_RAW);
    openDb.mockImplementation(async () => {
      // At open time every copy is already in the rescue folder.
      fakeFs.log.push('open');
      return db;
    });

    await expect(rescueRkStorage(STORAGE_KEY, 'android')).resolves.toBe(V0_RAW);

    expect(fakeFs.log).toEqual([
      `mkdir ${TMP}`,
      `copy ${DB_DIR}/RKStorage → ${TMP}/RKStorage`,
      `copy ${DB_DIR}/RKStorage-wal → ${TMP}/RKStorage-wal`,
      `copy ${DB_DIR}/RKStorage-shm → ${TMP}/RKStorage-shm`,
      'open',
      `rm ${TMP}`,
    ]);
    // It opens the COPY (the rescue folder), never the live databases/ folder.
    expect(openDb).toHaveBeenCalledWith('RKStorage', { useNewConnection: true }, TMP);
    expect(db.getFirstAsync).toHaveBeenCalledWith('SELECT value FROM catalystLocalStorage WHERE key = ?', STORAGE_KEY);
    expect(db.closeAsync).toHaveBeenCalledTimes(1);
    // The live files are untouched, the copy is gone.
    expect(fakeFs.files.get(`${DB_DIR}/RKStorage`)).toBe('bytes of RKStorage');
    expect([...fakeFs.files.keys()].filter((k) => k.startsWith(TMP))).toEqual([]);
    expect(RK_FILES).toEqual(['RKStorage', 'RKStorage-journal', 'RKStorage-wal', 'RKStorage-shm']);
  });

  test('an old rescue folder is removed first, so old files never mix with the new copy', async () => {
    putRkFiles(['RKStorage']);
    fakeFs.dirs.add(TMP);
    fakeFs.files.set(`${TMP}/RKStorage-wal`, 'stale wal from an earlier try');
    let walAtOpen: string | undefined = 'not checked';
    openDb.mockImplementation(async () => {
      walAtOpen = fakeFs.files.get(`${TMP}/RKStorage-wal`);
      return fakeDb(V0_RAW);
    });
    await expect(rescueRkStorage(STORAGE_KEY, 'android')).resolves.toBe(V0_RAW);
    expect(walAtOpen).toBeUndefined();
  });

  test('the key is missing or empty → null', async () => {
    putRkFiles(['RKStorage']);
    openDb.mockImplementation(async () => fakeDb(undefined));
    await expect(rescueRkStorage(STORAGE_KEY, 'android')).resolves.toBeNull();
    openDb.mockImplementation(async () => fakeDb(''));
    await expect(rescueRkStorage(STORAGE_KEY, 'android')).resolves.toBeNull();
  });

  test('any failure → null, and the copy is still closed and deleted', async () => {
    putRkFiles(['RKStorage']);
    const db = fakeDb(null, true);
    openDb.mockImplementation(async () => db);
    await expect(rescueRkStorage(STORAGE_KEY, 'android')).resolves.toBeNull();
    expect(db.closeAsync).toHaveBeenCalledTimes(1);
    expect(fakeFs.dirs.has(TMP)).toBe(false);

    openDb.mockImplementation(async () => {
      throw new Error('cannot open');
    });
    await expect(rescueRkStorage(STORAGE_KEY, 'android')).resolves.toBeNull();
    expect(fakeFs.dirs.has(TMP)).toBe(false);
  });
});
