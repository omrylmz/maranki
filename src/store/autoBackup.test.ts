/**
 * Tests for "data safety you can see" (spec §8.4, §8.8, unit W2-2):
 *   - autoBackup.ts — when a weekly backup is written, which old ones are
 *     deleted, and when NOTHING may happen (off, read-blocked, empty library);
 *   - backup.ts     — "Export a backup" and "Export study history" (file →
 *     share sheet, or kept on the phone), the Erase sheet's export (always
 *     kept on the phone), the Restore flow's reading and its SAFE ORDER
 *     (performRestore: copy → restore → save), the copy made before a restore
 *     (newest 3 kept), and the list of backups on the phone.
 *
 * W2 hardening adds: a failed cache write has its own reason (never "the
 * share sheet failed"); copies made before a restore are deleted only when
 * they are beyond the newest 3 AND older than 30 days (4 restores in a row
 * keep the first copy); a flush that RESOLVES `{ ok: false }` is a failed
 * restore; "Delete" for an export or a before-restore copy.
 *
 * Review round 1 of that hardening: `flush` is REQUIRED and strict — only
 * `{ ok: true }` is a save (a flush that answers nothing is a failure, and
 * does not compile); the Delete sheet's line starts with a noun phrase for
 * each kind ("This copy made before a restore (…), 2.8 MB, is removed …").
 *
 * The disk and the share sheet are a fake `BackupIO` (no native module is
 * touched). A restore is read with the REAL migrate() — the one the boot load
 * uses — on the saved fixtures, so "every backup ever made restores" is tested
 * on real old data.
 *
 * The hook `useAutoBackup()` is tested at the end with react-test-renderer
 * and fake timers. For it, three modules are replaced (`jest.mock` below):
 *   - ./DataContext — `useData()` returns `mockData`, which each test sets;
 *   - ../platform/files — the real disk of `deviceBackupIO` becomes the
 *     in-memory folder `mockDocs`;
 *   - ./storage — the review history (`appRevlogStore`) is `mockRevlogRows`.
 *
 * Wave 5: a weekly backup carries the review history, so a restore of it
 * never empties the history. `runAutoBackup` is async now (it reads the
 * history), so its tests await it, and the hook tests let the promises run
 * after each timer step (`pass`).
 *
 * Wave 5b (the device walkthrough): every file name the learner sees is in
 * LOCAL time (L8; the names in these tests come from `localFileStamp`), and
 * a restore of a backup without review history keeps the phone's (R2,
 * `historyToKeep`). Both have their own blocks at the end of the file.
 */
// '@jest/globals' first: the jest.mock factories below use its `jest`.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import type { RevlogRow } from '../domain/model';
import { DAY, HOUR, type DataState } from '../domain/types';
import { BACKUP_FORMAT } from '../platform/backupFile';
import type { BackupFileInfo, SavedFile } from '../platform/files';
import { SHARE_BACKUP, SHARE_HISTORY_CSV, type ShareKind } from '../platform/share';
import { localTime } from '../test/clock';
import { makeSessionRecord, stateFixtureRaw } from '../test/factories';
// W3-1: the live library is the v3 note model (factories.ts builds old v2 documents).
import {
  makeDeckV3 as makeDeck,
  makePersonV3 as makePerson,
  makeStateV3 as makeState,
  noteWithCards,
  stateOfV3,
} from '../test/factoriesV3';
import {
  AUTO_BACKUP_DELAY_MS,
  AUTO_BACKUP_KEEP,
  autoBackupsToDelete,
  backupSettingsPatch,
  isAutoBackupDue,
  newestAutoBackupAt,
  readBackupSettings,
  runAutoBackup,
  useAutoBackup,
} from './autoBackup';
import {
  BACKUP_KIND_LABEL,
  type BackupEntry,
  backupKindOf,
  type BackupIO,
  BEFORE_RESTORE_KEEP,
  BEFORE_RESTORE_MIN_AGE_MS,
  beforeRestoreCopiesToDelete,
  canDeleteBackup,
  DELETE_BACKUP_COPY,
  deleteBackupLine,
  deleteKeptBackup,
  exportAndKeepBackup,
  exportBackup,
  exportHistory,
  EXPORT_ROW_COPY,
  exportMessage,
  exportRowSub,
  formatBackupDate,
  formatBytes,
  getBackupList,
  historyFileName,
  historyMessage,
  historyToKeep,
  historyZipFileName,
  localBackupFileName,
  keptExportMessage,
  keptHistoryCount,
  localFileStamp,
  oldBackupsToDelete,
  performRestore,
  readBackup,
  readBackupList,
  refreshBackupList,
  RESTORE_COPY,
  restoredMessage,
  restoreHistoryRows,
  restoreProblem,
  restoreResultMessage,
  type RestoreSteps,
  restoreSummary,
  restoreSummaryLine,
  SESSIONS_CSV_HEADER,
  sessionsCsv,
  SHARE_COPY,
  stampTimeOf,
  subscribeBackupList,
  writeBeforeRestoreCopy,
} from './backup';
import type { FlushResult, PersistError } from './actions';
import { migrate } from './migrate';

/* ----------------------------------------------- module mocks (the hook) */

/** What `useData()` returns in the hook tests. */
interface MockData {
  ready: boolean;
  state: DataState;
  persistError: PersistError;
  actions: { updateAppSettings: jest.Mock };
}
let mockData: MockData;

jest.mock('./DataContext', () => ({ useData: () => mockData }));

/**
 * The review history behind the hook's disk (`fullBackupIO(appRevlogStore())`):
 * `all()` resolves `mockRevlogRows`, or waits for `mockRevlogGate` when a test sets one.
 */
let mockRevlogRows: unknown[] = [];
let mockRevlogGate: Promise<void> | null = null;
jest.mock('./storage', () => ({
  appRevlogStore: () => ({
    forCard: async () => [],
    all: async () => {
      if (mockRevlogGate) await mockRevlogGate;
      return mockRevlogRows;
    },
    write: async (rows: readonly unknown[]) => rows.length,
  }),
}));

/** The fake Paths.document/backups/ folder behind `deviceBackupIO`: name → text. */
const mockDocs = new Map<string, string>();

jest.mock('../platform/files', () => ({
  BACKUPS_FOLDER: 'backups',
  writeCacheFile: (name: string) => ({ name, uri: `file:///cache/${name}` }),
  deleteCacheFiles: () => [],
  writeDocumentFile: (name: string, content: string) => {
    mockDocs.set(name, content);
    return { name, uri: `file:///files/backups/${name}` };
  },
  listBackups: (prefix = '') =>
    [...mockDocs.keys()]
      .filter((name) => name.startsWith(prefix))
      .map((name) => ({ name, uri: `file:///files/backups/${name}`, size: 1, modifiedAt: null })),
  deleteBackup: (name: string) => {
    mockDocs.delete(name);
  },
}));

/* ------------------------------------------------------------- fake disk */

interface FakeDisk {
  io: BackupIO;
  /** Paths.document/backups/ : name → text. */
  docs: Map<string, string>;
  /** Paths.cache : name → text. */
  cache: Map<string, string>;
  /** Every share sheet that opened. */
  shared: { uri: string; kind: ShareKind }[];
  /** Change how the fake behaves. */
  set: (patch: Partial<FakeFaults>) => void;
  /** How many times the folder was listed. */
  lists: () => number;
}

interface FakeFaults {
  shareAvailable: boolean;
  shareThrows: boolean;
  cacheFails: boolean;
  docFails: boolean;
  listFails: boolean;
  /** The old cache files cannot be deleted. */
  clearCacheFails: boolean;
  /** Names that cannot be deleted. */
  removeFails: string[];
}

function fakeDisk(files: Record<string, string> = {}, cacheFiles: Record<string, string> = {}): FakeDisk {
  const docs = new Map(Object.entries(files));
  const cache = new Map(Object.entries(cacheFiles));
  const shared: { uri: string; kind: ShareKind }[] = [];
  let listCount = 0;
  const faults: FakeFaults = {
    shareAvailable: true,
    shareThrows: false,
    cacheFails: false,
    docFails: false,
    listFails: false,
    clearCacheFails: false,
    removeFails: [],
  };
  const io: BackupIO = {
    writeCache(name, content): SavedFile {
      if (faults.cacheFails) throw new Error('cache full');
      cache.set(name, content);
      return { name, uri: `file:///cache/${name}` };
    },
    clearCache(prefix) {
      if (faults.clearCacheFails) throw new Error('cache busy');
      for (const name of [...cache.keys()]) if (name.startsWith(prefix)) cache.delete(name);
    },
    writeDocument(name, content): SavedFile {
      if (faults.docFails) throw new Error('disk full');
      docs.set(name, content);
      return { name, uri: `file:///files/backups/${name}` };
    },
    async share(uri, kind) {
      if (faults.shareThrows) throw new Error('share sheet failed');
      if (!faults.shareAvailable) return false;
      shared.push({ uri, kind });
      return true;
    },
    list(prefix = ''): BackupFileInfo[] {
      listCount += 1;
      if (faults.listFails) throw new Error('cannot read folder');
      return [...docs.keys()]
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name, uri: `file:///files/backups/${name}`, size: docs.get(name)!.length, modifiedAt: null }));
    },
    remove(name) {
      if (faults.removeFails.includes(name)) throw new Error('busy');
      docs.delete(name);
    },
  };
  return {
    io,
    docs,
    cache,
    shared,
    set: (patch) => Object.assign(faults, patch),
    lists: () => listCount,
  };
}

/* ---------------------------------------------------------------- helpers */

const NOW = localTime('2026-10-21', '18:04');

/** The name of an automatic backup made `daysAgo` days before NOW. */
const autoName = (daysAgo: number) => `auto-${localFileStamp(NOW - daysAgo * DAY)}.json`;

/** A library with one deck, two cards (two Basic notes) and one session — something worth a backup. */
function library(overrides: Partial<DataState> = {}): DataState {
  const deck = makeDeck({ id: 'd1', name: 'Capitals' });
  const groups = ['c1', 'c2'].map((id) => noteWithCards({ deckId: 'd1', note: { id: `n-${id}` }, card: { id } }));
  return stateOfV3({
    decks: [deck],
    groups,
    overrides: {
      sessions: [makeSessionRecord({ id: 's1' })],
      person: makePerson({ streak: 12 }),
      ...overrides,
    },
  });
}

/** The state inside a backup text, read back with the real migrate(). */
function stateIn(text: string): DataState {
  const read = readBackup(text, NOW);
  if (read.kind !== 'ok') throw new Error(`not a backup: ${read.kind}`);
  return read.state;
}

/** One review-history row (the row store's `revlog` table). */
function revlogRow(seq: number, cardId: string): RevlogRow {
  return {
    seq,
    cardId,
    deckId: 'd1',
    atMs: NOW - seq * HOUR,
    rating: 'good',
    bucket: 'review',
    ivlBefore: 2,
    ivlAfter: 5,
    easeAfter: 2.5,
    durationMs: 1200,
  };
}

const ready = (state: DataState, extra: Partial<Parameters<typeof runAutoBackup>[0]> = {}) => ({
  state,
  ready: true,
  persistError: null,
  now: NOW,
  ...extra,
});

/* ------------------------------------------------------- backup settings */

describe('backup settings (extra keys in the v2 settings)', () => {
  test('a state without them: automatic backups ON, never made', () => {
    expect(readBackupSettings(makeState().settings)).toEqual({ autoBackup: true, lastAutoBackupAt: null });
  });

  test('a patch is read back; wrong types fall back to the defaults', () => {
    const settings = makeState().settings;
    const off = { ...settings, ...backupSettingsPatch({ autoBackup: false, lastAutoBackupAt: NOW }) };
    expect(readBackupSettings(off)).toEqual({ autoBackup: false, lastAutoBackupAt: NOW });
    const broken = { ...settings, autoBackup: 'yes', lastAutoBackupAt: Number.NaN } as unknown as typeof settings;
    expect(readBackupSettings(broken)).toEqual({ autoBackup: true, lastAutoBackupAt: null });
  });

  test('migrate() keeps them (unknown settings keys survive), so a restore keeps them too', () => {
    const state = library();
    state.settings = { ...state.settings, ...backupSettingsPatch({ autoBackup: false, lastAutoBackupAt: NOW }) };
    const out = migrate(JSON.parse(JSON.stringify(state)), NOW);
    if (out.kind !== 'ok') throw new Error(out.kind);
    expect(readBackupSettings(out.state.settings)).toEqual({ autoBackup: false, lastAutoBackupAt: NOW });
  });
});

/* -------------------------------------------------------------- the rules */

describe('when an automatic backup is due', () => {
  test('due when there was never one, or the newest is 7 days old or older', () => {
    expect(isAutoBackupDue(null, NOW)).toBe(true);
    expect(isAutoBackupDue(NOW - 7 * DAY + HOUR, NOW)).toBe(false);
    expect(isAutoBackupDue(NOW - 7 * DAY, NOW)).toBe(true);
    expect(isAutoBackupDue(NOW - 30 * DAY, NOW)).toBe(true);
  });

  test('the age comes from the stamp in the newest automatic backup name', () => {
    const files: BackupFileInfo[] = [autoName(9), autoName(2), 'before-restore-x.json'].map((name) => ({
      name,
      uri: name,
      size: 1,
      modifiedAt: NOW, // the file date is NOT used when the name has a stamp
    }));
    expect(newestAutoBackupAt(files, NOW)).toBe(stampTimeOf(autoName(2)));
  });

  test('a name without a stamp falls back to the file date', () => {
    expect(newestAutoBackupAt([{ name: 'auto-old.json', uri: 'x', size: 1, modifiedAt: NOW - DAY }], NOW)).toBe(
      NOW - DAY,
    );
  });

  test('a backup "from the future" (the clock was wrong) is not trusted', () => {
    const files = [{ name: autoName(-40), uri: 'x', size: 1, modifiedAt: null }];
    expect(newestAutoBackupAt(files, NOW)).toBeNull();
  });
});

describe('which automatic backups are deleted (keep the newest 3)', () => {
  const info = (name: string): BackupFileInfo => ({ name, uri: name, size: 1, modifiedAt: null });

  test('the oldest beyond 3 go; other kinds of backups are never touched', () => {
    const files = [autoName(1), autoName(8), autoName(15), autoName(22), autoName(29), 'before-restore-a.json'].map(
      info,
    );
    expect(AUTO_BACKUP_KEEP).toBe(3);
    expect(autoBackupsToDelete(files, NOW)).toEqual([autoName(22), autoName(29)]);
  });

  test('a backup "from the future" counts as the oldest', () => {
    const files = [autoName(-400), autoName(1), autoName(8), autoName(15)].map(info);
    expect(autoBackupsToDelete(files, NOW)).toEqual([autoName(-400)]);
  });
});

/* ------------------------------------------------------------- the runner */

describe('runAutoBackup', () => {
  test('never made → writes auto-<stamp>.json, a full envelope without images', async () => {
    const disk = fakeDisk();
    const state = library();
    const result = await runAutoBackup(ready(state), disk.io);
    expect(result).toEqual({
      kind: 'written',
      file: { name: `auto-${localFileStamp(NOW)}.json`, uri: `file:///files/backups/auto-${localFileStamp(NOW)}.json` },
      removed: [],
    });
    const text = disk.docs.get(`auto-${localFileStamp(NOW)}.json`)!;
    const envelope = JSON.parse(text) as Record<string, unknown>;
    expect(envelope.format).toBe(BACKUP_FORMAT);
    expect(envelope.exportedAt).toBe(NOW);
    expect(envelope).not.toHaveProperty('media');
    expect(envelope).not.toHaveProperty('revlog');
    expect(stateIn(text)).toEqual(state);
  });

  test('the newest is 3 days old → nothing; 8 days old → a new one', async () => {
    const fresh = fakeDisk({ [autoName(3)]: '{}' });
    expect(await runAutoBackup(ready(library()), fresh.io)).toEqual({ kind: 'skipped', reason: 'not-due' });
    expect([...fresh.docs.keys()]).toEqual([autoName(3)]);

    const stale = fakeDisk({ [autoName(8)]: '{}' });
    expect((await runAutoBackup(ready(library()), stale.io)).kind).toBe('written');
    expect([...stale.docs.keys()].sort()).toEqual([autoName(0), autoName(8)].sort());
  });

  test('keeps the newest 3 automatic backups, and never deletes a copy made before a restore', async () => {
    const disk = fakeDisk({
      [autoName(8)]: '{}',
      [autoName(15)]: '{}',
      [autoName(22)]: '{}',
      'before-restore-2026-01-01-00-00-00.json': '{}',
    });
    const result = await runAutoBackup(ready(library()), disk.io);
    expect(result.kind === 'written' && result.removed).toEqual([autoName(22)]);
    expect([...disk.docs.keys()].sort()).toEqual(
      [autoName(0), autoName(8), autoName(15), 'before-restore-2026-01-01-00-00-00.json'].sort(),
    );
  });

  test('"Automatic backups" off → nothing is read or written', async () => {
    const disk = fakeDisk();
    const state = library();
    state.settings = { ...state.settings, ...backupSettingsPatch({ autoBackup: false }) };
    expect(await runAutoBackup(ready(state), disk.io)).toEqual({ kind: 'skipped', reason: 'off' });
    expect(disk.docs.size).toBe(0);
    expect(disk.lists()).toBe(0);
  });

  test('read-blocked (read / too-new / migrate) → nothing: the state in memory is not the real data', async () => {
    for (const persistError of ['read', 'too-new', 'migrate'] as const) {
      const disk = fakeDisk({ [autoName(30)]: 'real old backup' });
      expect(await runAutoBackup(ready(library(), { persistError }), disk.io)).toEqual({
        kind: 'skipped',
        reason: 'blocked',
      });
      expect([...disk.docs.entries()]).toEqual([[autoName(30), 'real old backup']]);
    }
  });

  test('a failed SAVE ("write") does not block it: the data in memory is real', async () => {
    const disk = fakeDisk();
    expect((await runAutoBackup(ready(library(), { persistError: 'write' }), disk.io)).kind).toBe('written');
  });

  test('not loaded yet → nothing', async () => {
    const disk = fakeDisk();
    expect(await runAutoBackup(ready(library(), { ready: false }), disk.io)).toEqual({
      kind: 'skipped',
      reason: 'not-ready',
    });
    expect(disk.docs.size).toBe(0);
  });

  test('an empty library → nothing, so the old real backups stay (for example after "Erase everything")', async () => {
    const disk = fakeDisk({ [autoName(10)]: 'a', [autoName(20)]: 'b', [autoName(30)]: 'c' });
    expect(await runAutoBackup(ready(makeState()), disk.io)).toEqual({ kind: 'skipped', reason: 'empty' });
    expect(disk.docs.size).toBe(3);
  });

  test('the write fails → nothing is deleted', async () => {
    const disk = fakeDisk({ [autoName(10)]: 'a', [autoName(20)]: 'b', [autoName(30)]: 'c' });
    disk.set({ docFails: true });
    expect(await runAutoBackup(ready(library()), disk.io)).toEqual({ kind: 'failed', step: 'write' });
    expect(disk.docs.size).toBe(3);
  });

  test('the folder cannot be read → nothing is written', async () => {
    const disk = fakeDisk();
    disk.set({ listFails: true });
    expect(await runAutoBackup(ready(library()), disk.io)).toEqual({ kind: 'failed', step: 'list' });
    expect(disk.docs.size).toBe(0);
  });

  test('an old backup that cannot be deleted is kept; the new one is still written', async () => {
    const disk = fakeDisk({ [autoName(8)]: 'a', [autoName(15)]: 'b', [autoName(22)]: 'c' });
    disk.set({ removeFails: [autoName(22)] });
    const result = await runAutoBackup(ready(library()), disk.io);
    expect(result.kind === 'written' && result.removed).toEqual([]);
    expect(disk.docs.has(autoName(0))).toBe(true);
    expect(disk.docs.has(autoName(22))).toBe(true);
  });

  /* The review history (wave 5): a weekly backup carries it, so a restore never empties it. */

  test('the weekly backup carries the review history (no images), and restoring it writes the history back', async () => {
    const disk = fakeDisk();
    const rows = [revlogRow(1, 'c1'), revlogRow(2, 'c2')];
    const readMedia = jest.fn(async () => ({ items: [], tooBig: false }));
    disk.io.readRevlog = jest.fn(async () => rows);
    disk.io.readMedia = readMedia;
    const state = library();
    expect((await runAutoBackup(ready(state), disk.io)).kind).toBe('written');
    const text = disk.docs.get(autoName(0))!;
    const envelope = JSON.parse(text) as Record<string, unknown>;
    expect(envelope.revlog).toEqual(rows);
    expect(envelope).not.toHaveProperty('media');
    expect(readMedia).not.toHaveBeenCalled();
    // Settings › Your data › Weekly backup › Restore: the history comes back (it was emptied before).
    const read = readBackup(text, NOW);
    if (read.kind !== 'ok') throw new Error(read.kind);
    expect(read.state).toEqual(state);
    expect(read.revlog).toEqual(rows);
    const written: unknown[] = [];
    const restoreDisk = fakeDisk();
    restoreDisk.io.readRevlog = async () => [];
    const result = await performRestore({
      current: library(),
      next: read.state,
      now: NOW,
      // The replace-all writes the history in its own transaction.
      restore: (_state, history) => void written.push(...history),
      flush: async (): Promise<FlushResult> => ({ ok: true }),
      extras: { revlog: read.revlog, media: read.media },
      io: restoreDisk.io,
    });
    expect(result).toBe('restored');
    expect(written).toEqual(rows);
  });

  test('the history is read ONLY when a backup is due (the check on every app start stays cheap)', async () => {
    const readRevlog = jest.fn(async () => [revlogRow(1, 'c1')]);
    const notDue = fakeDisk({ [autoName(3)]: '{}' });
    notDue.io.readRevlog = readRevlog;
    expect(await runAutoBackup(ready(library()), notDue.io)).toEqual({ kind: 'skipped', reason: 'not-due' });
    const empty = fakeDisk();
    empty.io.readRevlog = readRevlog;
    expect(await runAutoBackup(ready(makeState()), empty.io)).toEqual({ kind: 'skipped', reason: 'empty' });
    expect(readRevlog).not.toHaveBeenCalled();
  });

  test('the history cannot be read → no backup at all and nothing deleted (a backup without it would push out a full one)', async () => {
    const disk = fakeDisk({ [autoName(8)]: 'a', [autoName(15)]: 'b', [autoName(22)]: 'c' });
    disk.io.readRevlog = async () => {
      throw new Error('database locked');
    };
    expect(await runAutoBackup(ready(library()), disk.io)).toEqual({ kind: 'failed', step: 'history' });
    expect([...disk.docs.keys()].sort()).toEqual([autoName(8), autoName(15), autoName(22)].sort());
  });
});

/* -------------------------------------------------------- export + share */

describe('exportBackup ("Export a backup")', () => {
  test('writes maranki-backup-<stamp>.json to the cache and opens the share sheet', async () => {
    const disk = fakeDisk();
    const state = library();
    const outcome = await exportBackup(state, NOW, disk.io);
    const name = `maranki-backup-${localFileStamp(NOW)}.json`;
    expect(outcome).toEqual({ kind: 'shared', name });
    expect(disk.shared).toEqual([{ uri: `file:///cache/${name}`, kind: SHARE_BACKUP }]);
    expect(SHARE_BACKUP.dialogTitle).toBe('Save your Maranki backup');
    expect(stateIn(disk.cache.get(name)!)).toEqual(state);
    expect(disk.docs.size).toBe(0);
    expect(exportMessage(outcome)).toBeNull();
  });

  test('sharing not available → kept in the backups folder, and the message names the file', async () => {
    const disk = fakeDisk();
    disk.set({ shareAvailable: false });
    const outcome = await exportBackup(library(), NOW, disk.io);
    const name = `maranki-backup-${localFileStamp(NOW)}.json`;
    expect(outcome).toEqual({ kind: 'saved', name, because: 'unavailable' });
    expect(disk.docs.has(name)).toBe(true);
    expect(exportMessage(outcome)).toBe(
      `Sharing is not available, so the backup was saved inside Maranki as ${name}.`,
    );
  });

  test('the share sheet or the cache fails → still kept in the backups folder', async () => {
    const shareFails = fakeDisk();
    shareFails.set({ shareThrows: true });
    expect((await exportBackup(library(), NOW, shareFails.io)).kind).toBe('saved');

    const cacheFails = fakeDisk();
    cacheFails.set({ cacheFails: true });
    expect((await exportBackup(library(), NOW, cacheFails.io)).kind).toBe('saved');
  });

  test('a failed CACHE write has its own reason: the share sheet was never tried (W2 hardening)', async () => {
    const disk = fakeDisk();
    disk.set({ cacheFails: true });
    const outcome = await exportBackup(library(), NOW, disk.io);
    const name = `maranki-backup-${localFileStamp(NOW)}.json`;
    expect(outcome).toEqual({ kind: 'saved', name, because: 'cache-failed' });
    expect(disk.shared).toEqual([]); // never opened
    expect(disk.docs.has(name)).toBe(true);
    expect(exportMessage(outcome)).toBe(
      `We couldn't prepare the file for sharing, so the backup was saved inside Maranki as ${name}.`,
    );
    expect(exportMessage(outcome)).not.toContain('share sheet');
  });

  test('only an error of the share sheet itself is "share-failed"; the cache copy was written first (W2 hardening)', async () => {
    const disk = fakeDisk();
    disk.set({ shareThrows: true });
    let cachedAtShare = false;
    const share = disk.io.share;
    disk.io.share = async (uri, kind) => {
      cachedAtShare = disk.cache.size === 1;
      return share(uri, kind);
    };
    const outcome = await exportBackup(library(), NOW, disk.io);
    expect(cachedAtShare).toBe(true);
    expect(outcome).toMatchObject({ kind: 'saved', because: 'share-failed' });
  });

  test('a share sheet that FAILS is not called "not available" (review round 1)', async () => {
    const disk = fakeDisk();
    disk.set({ shareThrows: true });
    const outcome = await exportBackup(library(), NOW, disk.io);
    const name = `maranki-backup-${localFileStamp(NOW)}.json`;
    expect(outcome).toEqual({ kind: 'saved', name, because: 'share-failed' });
    expect(exportMessage(outcome)).toBe(
      `We couldn't open the share sheet, so the backup was saved inside Maranki as ${name}.`,
    );
  });

  test('the cache does not grow: old exports go first, and an unshared cache copy is deleted (review round 1)', async () => {
    const oldExport = `maranki-backup-${localFileStamp(NOW - DAY)}.json`;
    const other = 'maranki-raw-data-x.json';
    const disk = fakeDisk({}, { [oldExport]: 'old', [other]: 'not ours to delete' });
    await exportBackup(library(), NOW, disk.io);
    expect([...disk.cache.keys()].sort()).toEqual([`maranki-backup-${localFileStamp(NOW)}.json`, other].sort());

    // Sharing not available: the file is kept in the backups folder, and the
    // cache copy (that nobody will read) is deleted.
    disk.set({ shareAvailable: false });
    await exportBackup(library(), NOW + DAY, disk.io);
    expect([...disk.cache.keys()]).toEqual([other]);
    expect(disk.docs.has(`maranki-backup-${localFileStamp(NOW + DAY)}.json`)).toBe(true);
  });

  test('old cache files that cannot be deleted never stop an export', async () => {
    const disk = fakeDisk();
    disk.set({ clearCacheFails: true });
    expect((await exportBackup(library(), NOW, disk.io)).kind).toBe('shared');
  });

  test('nothing can be written → failed, with an honest message', async () => {
    const disk = fakeDisk();
    disk.set({ cacheFails: true, docFails: true });
    const outcome = await exportBackup(library(), NOW, disk.io);
    expect(outcome).toEqual({ kind: 'failed' });
    expect(exportMessage(outcome)).toBe("We couldn't write the backup. Your phone may be out of storage.");
  });
});

describe('exportAndKeepBackup (the Erase sheet\'s "Export a backup first")', () => {
  // The share sheet cannot tell "saved" from "closed" (Android resolves
  // shareAsync the same way for both), so "Backup saved ✓" must rest on a copy
  // ON THE PHONE, listed in Settings › Your data (review round 1).
  const name = `maranki-backup-${localFileStamp(NOW)}.json`;

  beforeEach(() => {
    refreshBackupList(fakeDisk().io);
  });

  test('the share sheet opened → the backup ALSO exists in the backups folder and is listed', async () => {
    const disk = fakeDisk();
    const state = library();
    const outcome = await exportAndKeepBackup(state, NOW, disk.io);
    expect(outcome).toEqual({ kind: 'kept', name, share: 'opened' });
    expect(stateIn(disk.docs.get(name)!)).toEqual(state);
    // The file that was shared IS the kept file (no extra cache copy).
    expect(disk.shared).toEqual([{ uri: `file:///files/backups/${name}`, kind: SHARE_BACKUP }]);
    expect(disk.cache.size).toBe(0);
    expect(getBackupList().files.map((f) => [f.kind, f.name])).toEqual([['export', name]]);
    expect(BACKUP_KIND_LABEL.export).toBe('Saved export');
    expect(keptExportMessage(outcome)).toBe('A copy is also kept on this phone, in Settings › Your data.');
  });

  test('the copy is written BEFORE the share sheet opens', async () => {
    const disk = fakeDisk();
    const seenAtShare: boolean[] = [];
    const share = disk.io.share;
    disk.io.share = async (uri, kind) => {
      seenAtShare.push(disk.docs.has(name));
      return share(uri, kind);
    };
    await exportAndKeepBackup(library(), NOW, disk.io);
    expect(seenAtShare).toEqual([true]);
  });

  test('sharing not available, or the share sheet fails → still kept, with an honest line', async () => {
    const unavailable = fakeDisk();
    unavailable.set({ shareAvailable: false });
    const a = await exportAndKeepBackup(library(), NOW, unavailable.io);
    expect(a).toEqual({ kind: 'kept', name, share: 'unavailable' });
    expect(unavailable.docs.has(name)).toBe(true);
    expect(keptExportMessage(a)).toBe(`Sharing is not available, so the backup was saved inside Maranki as ${name}.`);

    const fails = fakeDisk();
    fails.set({ shareThrows: true });
    const b = await exportAndKeepBackup(library(), NOW, fails.io);
    expect(b).toEqual({ kind: 'kept', name, share: 'share-failed' });
    expect(fails.docs.has(name)).toBe(true);
    expect(keptExportMessage(b)).toBe(
      `We couldn't open the share sheet, so the backup was saved inside Maranki as ${name}.`,
    );
  });

  test('the phone copy cannot be written → failed, and nothing is shared (never "Backup saved ✓")', async () => {
    const disk = fakeDisk();
    disk.set({ docFails: true });
    const outcome = await exportAndKeepBackup(library(), NOW, disk.io);
    expect(outcome).toEqual({ kind: 'failed' });
    expect(disk.shared).toEqual([]);
    expect(keptExportMessage(outcome)).toBe("We couldn't write the backup. Your phone may be out of storage.");
  });

  test('the kept export restores to the very same state', async () => {
    const disk = fakeDisk();
    const state = library();
    await exportAndKeepBackup(state, NOW, disk.io);
    const read = readBackup(disk.docs.get(name)!, NOW);
    expect(read.kind === 'ok' && read.state).toEqual(state);
  });
});

/* -------------------------------------------------------- history CSV */

describe('Settings › Your data: the two export rows', () => {
  test('"Preparing…" shows ONLY under the export that runs; the other row keeps its own line', () => {
    expect(exportRowSub('backup', null)).toBe('Everything: decks, cards, progress, settings.');
    expect(exportRowSub('history', null)).toBe('Your sessions and every review, in one .zip');
    // "Export study history (CSV)" runs: its row says so, "Export a backup" does not.
    expect(exportRowSub('history', 'history')).toBe(EXPORT_ROW_COPY.busy);
    expect(exportRowSub('backup', 'history')).toBe(EXPORT_ROW_COPY.backup);
    // And the other way round.
    expect(exportRowSub('backup', 'backup')).toBe('Preparing…');
    expect(exportRowSub('history', 'backup')).toBe(EXPORT_ROW_COPY.history);
  });
});

describe('study history CSV (Progress ⤓)', () => {
  test('the header is exactly the spec §8.8 columns', () => {
    expect(SESSIONS_CSV_HEADER.join(',')).toBe('date,kind,mode,cards,again,hard,good,easy,minutes,xp');
  });

  test('one row per session, oldest first, with a BOM; no mode or minutes stored yet → empty cells', () => {
    const late = makeSessionRecord({
      id: 'b',
      atMs: localTime('2026-10-21', '20:00'),
      kind: 'cram',
      counts: { again: 0, hard: 0, good: 4, easy: 1 },
      xp: 12,
    });
    const early = makeSessionRecord({
      id: 'a',
      atMs: localTime('2026-10-20', '08:00'),
      counts: { again: 2, hard: 1, good: 3, easy: 0 },
      xp: 40,
    });
    expect(sessionsCsv([late, early])).toBe(
      '﻿date,kind,mode,cards,again,hard,good,easy,minutes,xp\r\n' +
        '2026-10-20,scheduled,,6,2,1,3,0,,40\r\n' +
        '2026-10-21,cram,,5,0,0,4,1,,12\r\n',
    );
  });

  test('a session that stores its mode (v3) fills the mode column', () => {
    const v3 = { ...makeSessionRecord({ id: 'm' }), mode: 'type' as const };
    expect(sessionsCsv([v3]).split('\r\n')[1].split(',')[2]).toBe('type');
  });

  test('no session yet → nothing is written, and the message says why', async () => {
    const disk = fakeDisk();
    const outcome = await exportHistory(makeState(), NOW, disk.io);
    expect(outcome).toBeNull();
    expect(disk.cache.size + disk.docs.size).toBe(0);
    expect(historyMessage(outcome)).toBe('No study history yet. Finish a session first.');
  });

  test('sessions → maranki-history-<stamp>.csv is shared as text/csv', async () => {
    const disk = fakeDisk();
    const state = library();
    const outcome = await exportHistory(state, NOW, disk.io);
    const name = historyFileName(NOW);
    expect(name).toBe(`maranki-history-${localFileStamp(NOW)}.csv`);
    expect(outcome).toEqual({ kind: 'shared', name });
    expect(disk.shared).toEqual([{ uri: `file:///cache/${name}`, kind: SHARE_HISTORY_CSV }]);
    expect(disk.cache.get(name)).toBe(sessionsCsv(state.sessions));
    expect(historyMessage(outcome)).toBeNull();
  });

  test('sharing not available → no hidden copy is kept, and the message does not say "saved" (review round 1)', async () => {
    const disk = fakeDisk();
    disk.set({ shareAvailable: false });
    const outcome = await exportHistory(library(), NOW, disk.io);
    expect(outcome).toEqual({ kind: 'unavailable' });
    expect(disk.docs.size).toBe(0);
    expect(disk.cache.size).toBe(0);
    expect(historyMessage(outcome)).toBe('Sharing is not available on this phone.');
  });

  test('a share sheet that fails has its own message (not "not available")', async () => {
    const disk = fakeDisk();
    disk.set({ shareThrows: true });
    const outcome = await exportHistory(library(), NOW, disk.io);
    expect(outcome).toEqual({ kind: 'share-failed' });
    expect(disk.docs.size + disk.cache.size).toBe(0);
    expect(historyMessage(outcome)).toBe("We couldn't open the share sheet.");
    expect(SHARE_COPY.failed).not.toBe(SHARE_COPY.unavailable);
  });

  test('the file cannot be written → failed; older history files in the cache are removed first', async () => {
    const oldHistory = `maranki-history-${localFileStamp(NOW - DAY)}.csv`;
    const disk = fakeDisk({}, { [oldHistory]: 'old' });
    await exportHistory(library(), NOW, disk.io);
    expect([...disk.cache.keys()]).toEqual([historyFileName(NOW)]);

    const full = fakeDisk();
    full.set({ cacheFails: true });
    const outcome = await exportHistory(library(), NOW, full.io);
    expect(outcome).toEqual({ kind: 'failed' });
    expect(full.shared).toEqual([]);
    expect(historyMessage(outcome)).toBe("We couldn't write the history file. Your phone may be out of storage.");
  });
});

/* ---------------------------------------------------------------- restore */

describe('the Restore flow (reading a backup)', () => {
  test('the words are exactly spec §8.4', () => {
    expect(RESTORE_COPY.title).toBe('Restore this backup?');
    expect(RESTORE_COPY.replaces).toBe(
      'This replaces everything on this phone. We save a backup of your current data first.',
    );
    expect(RESTORE_COPY.hold).toBe('Hold to restore');
    expect(RESTORE_COPY.cancel).toBe('Cancel');
    expect(RESTORE_COPY.notBackup).toBe('This file is not a Maranki backup.');
    expect(RESTORE_COPY.tooNew).toBe('This backup was made by a newer version of Maranki. Update the app first.');
  });

  test('the confirm line and the "Restored" line', () => {
    const summary = { at: localTime('2026-10-12', '21:04'), decks: 3, cards: 1240, streak: 12 };
    expect(formatBackupDate(summary.at)).toBe('12 Oct 2026, 21:04');
    expect(restoreSummaryLine(summary)).toBe('From 12 Oct 2026, 21:04 · 3 decks · 1,240 cards · 12-day streak.');
    expect(restoredMessage(summary)).toBe('Restored — 3 decks, 1,240 cards.');
    expect(restoreSummaryLine({ at: null, decks: 1, cards: 1, streak: 0 })).toBe('1 deck · 1 card · no streak.');
    expect(restoredMessage({ at: null, decks: 1, cards: 1, streak: 0 })).toBe('Restored — 1 deck, 1 card.');
  });

  test('restoreSummary counts the backup state', () => {
    expect(restoreSummary(library(), NOW)).toEqual({ at: NOW, decks: 1, cards: 2, streak: 12 });
  });

  test('our own export restores to the very same state, with its date', async () => {
    const disk = fakeDisk();
    const state = library();
    await exportBackup(state, NOW, disk.io);
    const read = readBackup(disk.cache.get(`maranki-backup-${localFileStamp(NOW)}.json`)!, NOW);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.state).toEqual(state);
    expect(read.info.exportedAt).toBe(NOW);
    expect(restoreProblem(read)).toBeNull();
  });

  test('an old v2.0.2 export (raw v0 state, word/tr cards) restores through migrate()', () => {
    const read = readBackup(stateFixtureRaw('v0-v2.0.2'), NOW);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.info).toEqual({ format: 'raw', exportedAt: null, app: null, schemaVersion: null });
    expect(read.state.cards.length).toBeGreaterThan(0);
    // W3-1: migrated to the note model — every card's text is in its note.
    for (const card of read.state.cards) expect(read.state.notes.some((n) => n.id === card.noteId)).toBe(true);
  });

  test('a hand-made too-new file (schemaVersion 9, minReaderVersion 9) → "made by a newer version"', () => {
    for (const text of [
      JSON.stringify({ schemaVersion: 9, minReaderVersion: 9 }),
      JSON.stringify({
        format: BACKUP_FORMAT,
        version: 1,
        schemaVersion: 9,
        exportedAt: NOW,
        app: { variant: 'generic', version: '9.0.0' },
        data: { schemaVersion: 9, minReaderVersion: 9, cards: [], decks: [] },
      }),
    ]) {
      const read = readBackup(text, NOW);
      expect(read.kind).toBe('too-new');
      expect(restoreProblem(read)).toBe(RESTORE_COPY.tooNew);
    }
  });

  test('not JSON, or JSON that is not Maranki → "This file is not a Maranki backup."', () => {
    for (const text of ['', 'hello', '[1,2]', JSON.stringify({ songs: [] })]) {
      expect(restoreProblem(readBackup(text, NOW))).toBe(RESTORE_COPY.notBackup);
    }
  });

  test('a migrate() that throws is a bug: nothing is restored, and it is never called "not a backup"', () => {
    const read = readBackup(JSON.stringify(library()), NOW, () => {
      throw new Error('bug');
    });
    expect(read).toEqual({ kind: 'error' });
    expect(restoreProblem(read)).toBe(RESTORE_COPY.migrateFailed);
  });
});

describe('the copy made before a restore', () => {
  test('keeps the CURRENT data as before-restore-<stamp>.json', () => {
    const disk = fakeDisk();
    const current = library();
    const file = writeBeforeRestoreCopy(current, NOW, disk.io);
    expect(file?.name).toBe(`before-restore-${localFileStamp(NOW)}.json`);
    expect(stateIn(disk.docs.get(file!.name)!)).toEqual(current);
  });

  test('an empty library has nothing to keep → no file', () => {
    const disk = fakeDisk();
    expect(writeBeforeRestoreCopy(makeState(), NOW, disk.io)).toBeNull();
    expect(disk.docs.size).toBe(0);
  });

  test('the copy cannot be written → it THROWS, so the restore stops', () => {
    const disk = fakeDisk();
    disk.set({ docFails: true });
    expect(() => writeBeforeRestoreCopy(library(), NOW, disk.io)).toThrow('disk full');
  });

  // W2 hardening: the old copies here are OLDER than 30 days (31–34 days
  // ago). A copy younger than 30 days is never deleted (see the next tests).
  test('only the newest 3 copies are kept; weekly backups and exports are never touched (review round 1)', () => {
    const copy = (daysAgo: number) => `before-restore-${localFileStamp(NOW - daysAgo * DAY)}.json`;
    const disk = fakeDisk({
      [copy(31)]: 'a',
      [copy(32)]: 'b',
      [copy(33)]: 'c',
      [copy(34)]: 'd',
      [autoName(30)]: 'weekly',
      [`maranki-backup-${localFileStamp(NOW - 40 * DAY)}.json`]: 'export',
    });
    expect(BEFORE_RESTORE_KEEP).toBe(3);
    const file = writeBeforeRestoreCopy(library(), NOW, disk.io);
    expect([...disk.docs.keys()].sort()).toEqual(
      [file!.name, copy(31), copy(32), autoName(30), `maranki-backup-${localFileStamp(NOW - 40 * DAY)}.json`].sort(),
    );
  });

  test('pruning problems never undo the copy: unreadable folder or a busy old file', () => {
    const copy = (daysAgo: number) => `before-restore-${localFileStamp(NOW - daysAgo * DAY)}.json`;
    const busy = fakeDisk({ [copy(31)]: 'a', [copy(32)]: 'b', [copy(33)]: 'c' });
    busy.set({ removeFails: [copy(33)] });
    const kept = writeBeforeRestoreCopy(library(), NOW, busy.io);
    expect(busy.docs.has(kept!.name)).toBe(true);
    expect(busy.docs.has(copy(33))).toBe(true);

    const unreadable = fakeDisk({ [copy(31)]: 'a', [copy(32)]: 'b', [copy(33)]: 'c' });
    unreadable.set({ listFails: true });
    const written = writeBeforeRestoreCopy(library(), NOW, unreadable.io);
    expect(unreadable.docs.size).toBe(4);
    expect(unreadable.docs.has(written!.name)).toBe(true);
  });

  test('4 restores in a row keep the FIRST copy: the data from before the first restore stays (W2 hardening)', () => {
    const disk = fakeDisk();
    const original = library(); // C0: what the user had before trying backups
    const tries = [
      original,
      library({ decks: [makeDeck({ id: 'dA', name: 'Backup A' })] }),
      library({ decks: [makeDeck({ id: 'dB', name: 'Backup B' })] }),
      library({ decks: [makeDeck({ id: 'dC', name: 'Backup C' })] }),
    ];
    // Each restore keeps the data on the phone at that moment, a few minutes apart.
    const names = tries.map((current, i) => writeBeforeRestoreCopy(current, NOW + i * 5 * 60_000, disk.io)!.name);
    expect(new Set(names).size).toBe(4);
    expect([...disk.docs.keys()].sort()).toEqual([...names].sort());
    expect(stateIn(disk.docs.get(names[0])!)).toEqual(original);
  });

  test('a copy goes only when it is beyond the newest 3 AND older than 30 days; unknown or future times stay', () => {
    const info = (name: string): BackupFileInfo => ({ name, uri: name, size: 1, modifiedAt: null });
    const copy = (daysAgo: number) => `before-restore-${localFileStamp(NOW - daysAgo * DAY)}.json`;
    expect(BEFORE_RESTORE_MIN_AGE_MS).toBe(30 * DAY);
    const future = `before-restore-${localFileStamp(NOW + 400 * DAY)}.json`;
    const names = [copy(1), copy(2), copy(3), copy(29), copy(31), copy(90), future, 'before-restore-x.json', autoName(60)];
    // Beyond the newest 3: 29, 31, 90 days, the future one and the unknown one.
    // Only the two that are surely older than 30 days go.
    expect(beforeRestoreCopiesToDelete(names.map(info), NOW).sort()).toEqual([copy(31), copy(90)].sort());
    // Only 3 copies: nothing goes, however old.
    expect(beforeRestoreCopiesToDelete([copy(200), copy(300), copy(400)].map(info), NOW)).toEqual([]);
  });

  test('the ranking is shared with the weekly backups: unknown or future times go first', () => {
    const info = (name: string): BackupFileInfo => ({ name, uri: name, size: 1, modifiedAt: null });
    const future = `before-restore-${localFileStamp(NOW + 400 * DAY)}.json`;
    const files = [future, 'before-restore-latest.json', `before-restore-${localFileStamp(NOW - DAY)}.json`, autoName(1)].map(
      info,
    );
    expect(oldBackupsToDelete(files, 'before-restore-', NOW, 1).sort()).toEqual(
      [future, 'before-restore-latest.json'].sort(),
    );
  });
});

describe('performRestore (spec §8.4 step 5, the safe order)', () => {
  const summary = restoreSummary(library(), NOW);

  /**
   * A fake data layer that writes down every step, in order. Its flush says
   * `{ ok: true }` like the engine's, or throws ('rejects').
   */
  function layer(disk: FakeDisk, opts: { flush?: 'resolves' | 'rejects'; restoreThrows?: boolean } = {}) {
    const steps: string[] = [];
    const restored: DataState[] = [];
    const restore = (state: DataState) => {
      steps.push(`restore (copy on disk: ${[...disk.docs.keys()].some((n) => n.startsWith('before-restore-'))})`);
      if (opts.restoreThrows) throw new Error('bug');
      restored.push(state);
    };
    const mode = opts.flush ?? 'resolves';
    const flush = async (): Promise<FlushResult> => {
      steps.push('flush');
      if (mode === 'rejects') throw new Error('disk full');
      return { ok: true };
    };
    return { steps, restored, restore, flush };
  }

  test('the copy is written FIRST, then restore, then the save is awaited → "Restored — …"', async () => {
    const disk = fakeDisk();
    const current = library();
    const next = library({ decks: [makeDeck({ id: 'd9', name: 'Rivers' })], cards: [] });
    const data = layer(disk);
    const result = await performRestore({ current, next, now: NOW, ...data, io: disk.io });
    expect(result).toBe('restored');
    expect(data.steps).toEqual(['restore (copy on disk: true)', 'flush']);
    expect(data.restored).toEqual([next]);
    expect(stateIn(disk.docs.get(`before-restore-${localFileStamp(NOW)}.json`)!)).toEqual(current);
    expect(restoreResultMessage(result, summary)).toBe('Restored — 1 deck, 2 cards.');
  });

  test('the copy cannot be written → restore is NEVER called, nothing is saved', async () => {
    const disk = fakeDisk();
    disk.set({ docFails: true });
    const data = layer(disk);
    const result = await performRestore({ current: library(), next: makeState(), now: NOW, ...data, io: disk.io });
    expect(result).toBe('copy-failed');
    expect(data.steps).toEqual([]);
    expect(data.restored).toEqual([]);
    expect(restoreResultMessage(result, summary)).toBe(RESTORE_COPY.copyFailed);
  });

  test('the save rejects → write-failed, never "Restored"', async () => {
    const disk = fakeDisk();
    const data = layer(disk, { flush: 'rejects' });
    const result = await performRestore({ current: library(), next: library(), now: NOW, ...data, io: disk.io });
    expect(result).toBe('write-failed');
    expect(data.steps).toEqual(['restore (copy on disk: true)', 'flush']);
    // W4-5: the message says that the RESTORE itself was not saved, and asks
    // for a new restore (the backup's history and images are not retried).
    expect(restoreResultMessage(result, summary)).toBe(
      'The restore was not saved — your phone may be out of storage. Free some space, then restore the backup again.',
    );
  });

  test('a flush that RESOLVES { ok: false } (the engine never rejects) → write-failed, never "Restored" (W2 hardening)', async () => {
    const failures = [
      { ok: false as const, reason: 'write' as const, cause: new Error('SQLITE_FULL') },
      { ok: false as const, reason: 'blocked' as const },
    ];
    for (const saved of failures) {
      const disk = fakeDisk();
      const restored: DataState[] = [];
      const next = library({ decks: [makeDeck({ id: 'd9', name: 'Rivers' })] });
      const result = await performRestore({
        current: library(),
        next,
        now: NOW,
        restore: (state) => {
          restored.push(state);
        },
        flush: async () => saved,
        io: disk.io,
      });
      expect(result).toBe('write-failed');
      expect(restored).toEqual([next]);
      // The way back is still on the phone.
      expect(disk.docs.has(`before-restore-${localFileStamp(NOW)}.json`)).toBe(true);
      expect(restoreResultMessage(result, summary)).not.toContain('Restored');
    }
  });

  test('a flush that resolves { ok: true } → restored', async () => {
    const disk = fakeDisk();
    const result = await performRestore({
      current: library(),
      next: library(),
      now: NOW,
      restore: () => {},
      flush: async () => ({ ok: true as const }),
      io: disk.io,
    });
    expect(result).toBe('restored');
  });

  test('"Restored" is said only AFTER the save has finished', async () => {
    const disk = fakeDisk();
    let finishSave: () => void = () => {};
    const saved = new Promise<FlushResult>((resolve) => {
      finishSave = () => resolve({ ok: true });
    });
    let settled = false;
    const done = performRestore({
      current: library(),
      next: library(),
      now: NOW,
      restore: () => {},
      flush: () => saved,
      io: disk.io,
    }).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    finishSave();
    await expect(done).resolves.toBe('restored');
  });

  test('a flush that answers NOTHING, or no flush at all, is never "Restored" (review round 1)', async () => {
    // The class of bug this guards against: a wrapper that drops the
    // engine's answer. It must not compile …
    const engineFlush = async (): Promise<FlushResult> => ({ ok: false, reason: 'write' });
    const dropsTheAnswer = async () => {
      await engineFlush();
    };
    const restoreWith = (flush: RestoreSteps['flush']) => {
      const disk = fakeDisk();
      const restored: DataState[] = [];
      const done = performRestore({
        current: library(),
        next: library(),
        now: NOW,
        restore: (state) => {
          restored.push(state);
        },
        flush,
        io: disk.io,
      });
      return { done, restored, disk };
    };

    // @ts-expect-error: Promise<void> is not Promise<FlushResult>, so the wrapper does not compile.
    const silent = restoreWith(dropsTheAnswer);
    // … and if a cast hides it, the missing answer still is not a save.
    await expect(silent.done).resolves.toBe('write-failed');
    expect(silent.restored).toHaveLength(1);
    expect(silent.disk.docs.has(`before-restore-${localFileStamp(NOW)}.json`)).toBe(true);
    expect(restoreResultMessage('write-failed', summary)).not.toContain('Restored');

    // `flush` is required: leaving it out does not compile, and at run time
    // (a JavaScript caller) the missing function is a failed save too.
    const disk = fakeDisk();
    // @ts-expect-error: `flush` is missing.
    const missing = performRestore({ current: library(), next: library(), now: NOW, restore: () => {}, io: disk.io });
    await expect(missing).resolves.toBe('write-failed');
  });

  test('an empty library has nothing to keep: the restore still runs', async () => {
    const disk = fakeDisk();
    const data = layer(disk);
    const next = library();
    const result = await performRestore({ current: makeState(), next, now: NOW, ...data, io: disk.io });
    expect(result).toBe('restored');
    expect(data.restored).toEqual([next]);
    expect(disk.docs.size).toBe(0);
  });

  test('restore() throws (a bug) → restore-failed, and the flush is not called', async () => {
    const disk = fakeDisk();
    const data = layer(disk, { restoreThrows: true });
    const result = await performRestore({ current: library(), next: library(), now: NOW, ...data, io: disk.io });
    expect(result).toBe('restore-failed');
    expect(data.steps).toEqual(['restore (copy on disk: true)']);
    expect(restoreResultMessage(result, summary)).toBe(RESTORE_COPY.restoreFailed);
  });
});

/* ------------------------------------------------- backups on this phone */

describe('the list of backups on this phone', () => {
  beforeEach(() => {
    refreshBackupList(fakeDisk().io);
  });

  test('kinds come from the name; other files (pre-migration copies, CSVs) are not listed', () => {
    expect(backupKindOf('auto-x.json')).toBe('auto');
    expect(backupKindOf('before-restore-x.json')).toBe('beforeRestore');
    expect(backupKindOf('maranki-backup-x.json')).toBe('export');
    expect(backupKindOf('premigrate-v0-to-v2-x.json')).toBeNull();
    expect(backupKindOf('corrupt-x.json')).toBeNull();
  });

  test('newest first, by the stamp in the name', () => {
    const disk = fakeDisk({
      [autoName(8)]: 'a',
      [`before-restore-${localFileStamp(NOW - 2 * DAY)}.json`]: 'bb',
      [`premigrate-v0-to-v2-${localFileStamp(NOW)}.json`]: 'c',
      [autoName(1)]: 'd',
    });
    const list = readBackupList(disk.io);
    expect(list.failed).toBe(false);
    // NOW is a whole minute, so the stamps (whole seconds) give it back exactly.
    expect(list.files.map((f) => [f.kind, f.at])).toEqual([
      ['auto', NOW - DAY],
      ['beforeRestore', NOW - 2 * DAY],
      ['auto', NOW - 8 * DAY],
    ]);
  });

  test('a folder that cannot be read → an empty list marked failed', () => {
    const disk = fakeDisk();
    disk.set({ listFails: true });
    expect(readBackupList(disk.io)).toEqual({ files: [], failed: true });
  });

  test('a refresh tells the subscribers; the snapshot stays the same object until then', () => {
    const disk = fakeDisk({ [autoName(1)]: 'x' });
    const heard = jest.fn();
    const stop = subscribeBackupList(heard);
    const before = getBackupList();
    expect(getBackupList()).toBe(before);
    runAutoBackup(ready(library(), { now: NOW + 10 * DAY }), disk.io); // writes → refreshes
    expect(heard).toHaveBeenCalled();
    expect(getBackupList()).not.toBe(before);
    expect(getBackupList().files.length).toBe(2);
    stop();
  });

  test('stamps and sizes for the rows', () => {
    // Wave 5b (L8): the stamp is LOCAL time.
    expect(stampTimeOf('auto-2026-10-21-18-04-07.json')).toBe(new Date(2026, 9, 21, 18, 4, 7).getTime());
    expect(stampTimeOf('auto-2026-13-21-18-04-07.json')).toBeNull();
    expect(stampTimeOf('auto-latest.json')).toBeNull();
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(860_160)).toBe('840 KB');
    expect(formatBytes(3_040_870)).toBe('2.9 MB');
  });
});

/* ------------------------------------------------------- useAutoBackup() */

describe('"Delete" on a backup row (W2 hardening)', () => {
  const exportName = `maranki-backup-${localFileStamp(NOW - DAY)}.json`;
  const copyName = `before-restore-${localFileStamp(NOW - 2 * DAY)}.json`;
  const entry = (name: string, extra: Partial<BackupEntry> = {}): BackupEntry => ({
    name,
    uri: `file:///files/backups/${name}`,
    size: 3 * 1024 * 1024,
    modifiedAt: null,
    kind: backupKindOf(name)!,
    at: stampTimeOf(name),
    ...extra,
  });

  test('offered for an export and a before-restore copy in the backups folder only', () => {
    expect(canDeleteBackup(entry(exportName))).toBe(true);
    expect(canDeleteBackup(entry(copyName))).toBe(true);
    // Weekly backups are pruned by the app; an OLD root export is never deleted.
    expect(canDeleteBackup(entry(autoName(1)))).toBe(false);
    expect(canDeleteBackup(entry(exportName, { oldExport: true }))).toBe(false);
  });

  test('deletes the file and reads the list again', () => {
    const disk = fakeDisk({ [exportName]: 'x', [copyName]: 'y', [autoName(1)]: 'z' });
    refreshBackupList(disk.io);
    expect(getBackupList().files).toHaveLength(3);
    expect(deleteKeptBackup(entry(exportName), disk.io)).toBe(true);
    expect([...disk.docs.keys()].sort()).toEqual([copyName, autoName(1)].sort());
    expect(getBackupList().files.map((f) => f.name).sort()).toEqual([copyName, autoName(1)].sort());
  });

  test('a failed delete says so and keeps the file; a weekly backup or an old export is never touched', () => {
    const disk = fakeDisk({ [exportName]: 'x', [autoName(1)]: 'z' });
    disk.set({ removeFails: [exportName] });
    expect(deleteKeptBackup(entry(exportName), disk.io)).toBe(false);
    expect(disk.docs.has(exportName)).toBe(true);

    const removed: string[] = [];
    const io: BackupIO = {
      ...disk.io,
      remove: (name) => {
        removed.push(name);
      },
    };
    expect(deleteKeptBackup(entry(autoName(1)), io)).toBe(false);
    expect(deleteKeptBackup(entry(exportName, { oldExport: true }), io)).toBe(false);
    expect(removed).toEqual([]);
  });

  test('the words', () => {
    expect(DELETE_BACKUP_COPY).toEqual({
      button: 'Delete this backup',
      title: 'Delete this backup?',
      confirm: 'Delete backup',
      cancel: 'Cancel',
      deleted: 'Backup deleted.',
      failed: "We couldn't delete this backup.",
    });
    expect(deleteBackupLine(entry(exportName))).toBe(
      `This saved export (${formatBackupDate(NOW - DAY)}), 3.0 MB, is removed from this phone. This cannot be undone.`,
    );
    // A noun phrase for each kind, so the sentence reads well (review round 1).
    expect(deleteBackupLine(entry(copyName, { size: 2_936_013 }))).toBe(
      `This copy made before a restore (${formatBackupDate(NOW - 2 * DAY)}), 2.8 MB, is removed from this phone. This cannot be undone.`,
    );
    expect(deleteBackupLine(entry(autoName(1)))).toBe(
      `This weekly backup (${formatBackupDate(NOW - DAY)}), 3.0 MB, is removed from this phone. This cannot be undone.`,
    );
    expect(deleteBackupLine(entry('maranki-backup-x.json', { at: null, size: 512 }))).toBe(
      'This saved export, 512 B, is removed from this phone. This cannot be undone.',
    );
  });
});

describe('useAutoBackup (mounted once in the tabs layout)', () => {
  let renderer: ReactTestRenderer | null = null;
  let appStateListener: ((next: AppStateStatus) => void) | null = null;

  function Probe() {
    useAutoBackup();
    return null;
  }

  const mount = () =>
    act(() => {
      renderer = TestRenderer.create(React.createElement(Probe));
    });

  /** Move the fake clock, then let the backup's promises (the history read) finish. */
  const pass = (ms: number) =>
    act(async () => {
      jest.advanceTimersByTime(ms);
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    mockDocs.clear();
    mockRevlogRows = [];
    mockRevlogGate = null;
    mockData = {
      ready: true,
      state: library(),
      persistError: null,
      actions: { updateAppSettings: jest.fn() },
    };
    appStateListener = null;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      appStateListener = listener as (next: AppStateStatus) => void;
      return { remove: () => (appStateListener = null) } as ReturnType<typeof AppState.addEventListener>;
    });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('writes one backup a few seconds after the data is loaded, then stores lastAutoBackupAt', async () => {
    mount();
    await pass(AUTO_BACKUP_DELAY_MS - 1);
    expect(mockDocs.size).toBe(0); // never during the first screen
    await pass(1);
    expect([...mockDocs.keys()]).toEqual([`auto-${localFileStamp(NOW + AUTO_BACKUP_DELAY_MS)}.json`]);
    expect(mockData.actions.updateAppSettings).toHaveBeenCalledWith({
      lastAutoBackupAt: NOW + AUTO_BACKUP_DELAY_MS,
    });
    await pass(60 * 60 * 1000);
    expect(mockDocs.size).toBe(1); // once, not on a timer loop
  });

  test('read-blocked → never, however long the app stays open', async () => {
    mockData.persistError = 'read';
    mount();
    await pass(10 * AUTO_BACKUP_DELAY_MS);
    appStateListener?.('active');
    await pass(10 * AUTO_BACKUP_DELAY_MS);
    expect(mockDocs.size).toBe(0);
    expect(mockData.actions.updateAppSettings).not.toHaveBeenCalled();
  });

  test('"Automatic backups" off → never', async () => {
    mockData.state = {
      ...mockData.state,
      settings: { ...mockData.state.settings, ...backupSettingsPatch({ autoBackup: false }) },
    };
    mount();
    await pass(10 * AUTO_BACKUP_DELAY_MS);
    expect(mockDocs.size).toBe(0);
  });

  test('waits for the load: nothing while not ready, a backup once it is', async () => {
    mockData.ready = false;
    mount();
    await pass(10 * AUTO_BACKUP_DELAY_MS);
    expect(mockDocs.size).toBe(0);
    mockData = { ...mockData, ready: true };
    act(() => renderer?.update(React.createElement(Probe)));
    await pass(AUTO_BACKUP_DELAY_MS);
    expect(mockDocs.size).toBe(1);
  });

  test('coming back to the front a week later makes the next weekly backup', async () => {
    mount();
    await pass(AUTO_BACKUP_DELAY_MS);
    expect(mockDocs.size).toBe(1);
    jest.setSystemTime(NOW + 8 * DAY);
    appStateListener?.('active');
    await pass(AUTO_BACKUP_DELAY_MS);
    expect(mockDocs.size).toBe(2);
    appStateListener?.('active'); // the same day again: not due
    await pass(AUTO_BACKUP_DELAY_MS);
    expect(mockDocs.size).toBe(2);
  });

  test('leaving before the delay → nothing is written later', async () => {
    mount();
    act(() => renderer?.unmount());
    renderer = null;
    await pass(10 * AUTO_BACKUP_DELAY_MS);
    expect(mockDocs.size).toBe(0);
  });

  test('the weekly backup carries the app’s review history (wave 5)', async () => {
    mockRevlogRows = [revlogRow(1, 'c1'), revlogRow(2, 'c2')];
    mount();
    await pass(AUTO_BACKUP_DELAY_MS);
    const text = mockDocs.get(`auto-${localFileStamp(NOW + AUTO_BACKUP_DELAY_MS)}.json`);
    expect(text).toBeDefined();
    const read = readBackup(text!, NOW);
    if (read.kind !== 'ok') throw new Error(read.kind);
    expect(read.revlog).toEqual(mockRevlogRows);
  });

  test('one check at a time: while the history is still being read, a second check writes no second backup', async () => {
    let openGate: () => void = () => undefined;
    mockRevlogGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    mount();
    await pass(AUTO_BACKUP_DELAY_MS); // the first check waits for the history
    expect(mockDocs.size).toBe(0);
    appStateListener?.('active');
    await pass(AUTO_BACKUP_DELAY_MS); // a second check while the first still runs: skipped
    openGate();
    mockRevlogGate = null;
    await pass(0);
    expect(mockDocs.size).toBe(1);
    expect(mockData.actions.updateAppSettings).toHaveBeenCalledTimes(1);
    // Once it ended, checks work again: a week later, the next backup.
    jest.setSystemTime(NOW + 8 * DAY);
    appStateListener?.('active');
    await pass(AUTO_BACKUP_DELAY_MS);
    expect(mockDocs.size).toBe(2);
  });
});

/* ===================================================== wave 5b (walkthrough) */

describe('file names are in LOCAL time (wave 5b L8)', () => {
  /** 09:28:30 on the phone's clock, whatever the time zone of the test machine. */
  const AT = localTime('2026-10-24', '09:28') + 30_000;

  test('the stamp is the wall-clock time of the phone', () => {
    expect(localFileStamp(AT)).toBe('2026-10-24-09-28-30');
    // One second before local midnight is still that local day.
    expect(localFileStamp(localTime('2026-10-24', '23:59') + 59_000)).toBe('2026-10-24-23-59-59');
    expect(localBackupFileName('export', AT)).toBe('maranki-backup-2026-10-24-09-28-30.json');
    expect(historyFileName(AT)).toBe('maranki-history-2026-10-24-09-28-30.csv');
    expect(historyZipFileName(AT)).toBe('maranki-history-2026-10-24-09-28-30.zip');
  });

  test('every backup the app writes is named in local time, and the time reads back from the name', async () => {
    const disk = fakeDisk();
    await exportBackup(library(), AT, disk.io);
    expect([...disk.cache.keys()]).toEqual(['maranki-backup-2026-10-24-09-28-30.json']);
    const weekly = await runAutoBackup(ready(library(), { now: AT }), disk.io);
    expect(weekly).toMatchObject({ kind: 'written', file: { name: 'auto-2026-10-24-09-28-30.json' } });
    expect(writeBeforeRestoreCopy(library(), AT, disk.io)?.name).toBe('before-restore-2026-10-24-09-28-30.json');
    expect(stampTimeOf('auto-2026-10-24-09-28-30.json')).toBe(AT);
    expect(readBackupList(disk.io).files.map((f) => [f.name, f.at])).toEqual([
      ['before-restore-2026-10-24-09-28-30.json', AT],
      ['auto-2026-10-24-09-28-30.json', AT],
    ]);
    // The confirm and Delete sheets show the same wall-clock time as the name.
    expect(formatBackupDate(AT)).toBe('24 Oct 2026, 09:28');
  });

  test('the next weekly backup counts 7 days from the LOCAL stamp', async () => {
    const disk = fakeDisk({ [`auto-${localFileStamp(AT)}.json`]: 'a' });
    expect(await runAutoBackup(ready(library(), { now: AT + 6 * DAY }), disk.io)).toEqual({ kind: 'skipped', reason: 'not-due' });
    expect(await runAutoBackup(ready(library(), { now: AT + 7 * DAY }), disk.io)).toMatchObject({ kind: 'written' });
  });

  test('a name from before wave 5b (a UTC stamp) is still listed; its stamp is read as local time', () => {
    const old = 'auto-2026-10-21-18-04-07.json';
    const disk = fakeDisk({ [old]: 'a' });
    expect(readBackupList(disk.io).files.map((f) => [f.name, f.at])).toEqual([[old, localTime('2026-10-21', '18:04') + 7_000]]);
    // A stamp that is no real moment (month 13) has no time: the file date is used instead.
    expect(stampTimeOf('auto-2026-13-21-18-04-07.json')).toBeNull();
  });
});

describe('a backup WITHOUT review history keeps the phone history (wave 5b R2)', () => {
  const rows = [revlogRow(1, 'c1'), revlogRow(2, 'c2'), revlogRow(3, 'c1')];
  /** A restored state whose own review log (the undo window) holds these entries. */
  const log = (...entries: { seq: number; cardId: string; atMs: number }[]) =>
    ({ reviewLog: entries }) as unknown as Pick<DataState, 'reviewLog'>;
  /** The restored log entry of the SAME review as a phone row (same card, same time). */
  const sameAs = (row: RevlogRow, seq = row.seq) => ({ seq, cardId: row.cardId, atMs: row.atMs });
  const noLog = log();
  const none = { revlog: [], media: [] };
  const seqs = (list: readonly RevlogRow[]) => list.map((r) => r.seq);

  test('historyToKeep: every phone row, except the reviews the restored state wrote itself', () => {
    expect(seqs(historyToKeep(rows, noLog, none))).toEqual([1, 2, 3]);
    expect(seqs(historyToKeep(rows, noLog, undefined))).toEqual([1, 2, 3]);
    // seq 2 of the restored log is the SAME review as row 2 (a backup made on this phone):
    // the replace-all wrote that row already.
    expect(seqs(historyToKeep(rows, log(sameAs(rows[1])), none))).toEqual([1, 3]);
    // The same review under another number (an old export, numbered by the migration): not twice either.
    expect(seqs(historyToKeep(rows, log(sameAs(rows[1], 9)), none))).toEqual([1, 3]);
  });

  test('historyToKeep: a number taken by ANOTHER review → the kept rows get new numbers after the restored log, in order', () => {
    // A backup from another phone: its log holds seq 1 and 2, for other cards.
    const otherPhone = log({ seq: 1, cardId: 'x1', atMs: 5 }, { seq: 2, cardId: 'x2', atMs: 6 });
    const kept = historyToKeep(rows, otherPhone, none);
    // Nothing of this phone is lost, and no kept row writes over a restored one.
    expect(kept.map((r) => [r.seq, r.cardId, r.atMs])).toEqual([
      [3, 'c1', rows[0].atMs],
      [4, 'c2', rows[1].atMs],
      [5, 'c1', rows[2].atMs],
    ]);
    expect(kept.map(({ seq: _seq, ...rest }) => rest)).toEqual(rows.map(({ seq: _seq, ...rest }) => rest));
    expect(seqs(rows)).toEqual([1, 2, 3]); // the phone's rows are new objects; the old ones are not changed
    // No number is taken: the rows keep their own numbers.
    expect(seqs(historyToKeep(rows, log({ seq: 7, cardId: 'x1', atMs: 5 }), none))).toEqual([1, 2, 3]);
  });

  test('performRestore of an OLD export of this phone: every review of the phone is in the table exactly once', async () => {
    // The phone's table: reviews A–E as seq 1–5. The old export's log holds B, C, D, numbered
    // 1–3 by the migration (its numbers say nothing about the phone's).
    const phone = [revlogRow(1, 'cA'), revlogRow(2, 'cB'), revlogRow(3, 'cC'), revlogRow(4, 'cD'), revlogRow(5, 'cE')];
    const next = library({
      reviewLog: [sameAs(phone[1], 1), sameAs(phone[2], 2), sameAs(phone[3], 3)] as unknown as DataState['reviewLog'],
    });
    const table = new Map<number, RevlogRow>(phone.map((r) => [r.seq, r]));
    const io: BackupIO = { ...fakeDisk().io, readRevlog: async () => [...table.values()] };
    const result = await performRestore({
      current: library(),
      next,
      now: NOW,
      restore: (state, history) => {
        // The replace-all, ONE transaction like the row store: the table is emptied, the
        // restore's history rows are written ('replace' mode), then one row per rating of the
        // restored log where its seq has no row yet ('ignore' mode).
        table.clear();
        for (const row of history) table.set(row.seq, row);
        for (const e of state.reviewLog) {
          if (!table.has(e.seq)) table.set(e.seq, { ...revlogRow(e.seq, e.cardId), atMs: e.atMs });
        }
      },
      flush: async () => ({ ok: true as const }),
      extras: { revlog: [], media: [] },
      io,
    });
    expect(result).toBe('restored');
    const after = [...table.values()].sort((x, y) => x.seq - y.seq);
    expect(after.map((r) => [r.seq, r.cardId])).toEqual([
      [1, 'cB'],
      [2, 'cC'],
      [3, 'cD'],
      [4, 'cA'],
      [5, 'cE'],
    ]);
    // Exactly once each: the same review (card + time) is never in the table twice.
    expect(new Set(after.map((r) => `${r.cardId}|${r.atMs}`)).size).toBe(phone.length);
  });

  test('keptHistoryCount reads the history TABLE, not the undo window of the state', async () => {
    // migrate() dropped every log entry (no usable card id), but the table still has its rows.
    const io = { readRevlog: async () => rows };
    expect(await keptHistoryCount(noLog, none, io)).toBe(3);
    expect(restoreSummary(library(), NOW, 3).keepsHistory).toBe(true);
    // The same reviews are in the restored log: nothing is written back, so the sheet says nothing.
    expect(await keptHistoryCount(log(...rows.map((r) => sameAs(r))), none, io)).toBe(0);
    expect(restoreSummary(library(), NOW, 0)).not.toHaveProperty('keepsHistory');
    // A backup WITH history: its own history wins (the table is not even read).
    const readRevlog = jest.fn(async () => rows);
    expect(await keptHistoryCount(noLog, { revlog: [revlogRow(9, 'c1')], media: [] }, { readRevlog })).toBe(0);
    expect(readRevlog).not.toHaveBeenCalled();
    // A table that cannot be read, or no table: 0 (the restore stops at its safety copy then).
    expect(await keptHistoryCount(noLog, none, { readRevlog: async () => Promise.reject(new Error('locked')) })).toBe(0);
    expect(await keptHistoryCount(noLog, none, {})).toBe(0);
  });

  test('historyToKeep: nothing when the backup HAS history, or the phone has none', () => {
    expect(historyToKeep(rows, noLog, { revlog: [revlogRow(9, 'c1')], media: [] })).toEqual([]);
    expect(historyToKeep([], noLog, undefined)).toEqual([]);
    expect(historyToKeep(undefined, noLog, undefined)).toEqual([]);
  });

  test('performRestore hands the kept rows TO the replace-all (one transaction), never as a second write after it (final review)', async () => {
    // A second write after the replace-all left the table EMPTY when the app was killed in
    // between, or when the replace-all failed and a later save finished the restore.
    const steps: string[] = [];
    const disk = fakeDisk();
    const io: BackupIO = { ...disk.io, readRevlog: async () => rows };
    const base = {
      current: library(),
      next: library({ reviewLog: [] }),
      now: NOW,
      restore: (_state: DataState, history: readonly RevlogRow[]) => void steps.push(`restore ${history.map((x) => x.seq).join(',')}`),
      io,
    };
    const saved = await performRestore({ ...base, flush: async () => (steps.push('flush'), { ok: true as const }) });
    expect(saved).toBe('restored');
    expect(steps).toEqual(['restore 1,2,3', 'flush']);

    steps.length = 0;
    const failed = await performRestore({
      ...base,
      flush: async () => (steps.push('flush'), { ok: false as const, reason: 'write' as const, cause: new Error('full') }),
    });
    expect(failed).toBe('write-failed');
    // The rows rode with the replace-all (the port keeps them for its retry); nothing comes after.
    expect(steps).toEqual(['restore 1,2,3', 'flush']);
  });

  test('restoreHistoryRows: the backup history (only its usable rows), else the kept phone rows', () => {
    const backup = [revlogRow(7, 'c1'), revlogRow(8, 'c2')];
    expect(restoreHistoryRows(rows, noLog, { revlog: backup, media: [] })).toEqual({ rows: backup, complete: true });
    // A row without a card id cannot be written: left out, and the restore says it is incomplete.
    const broken = { ...revlogRow(9, 'c1'), cardId: '' };
    expect(restoreHistoryRows(rows, noLog, { revlog: [...backup, broken], media: [] })).toEqual({ rows: backup, complete: false });
    // No backup history: the phone rows the restored log does not have already.
    expect(restoreHistoryRows(rows, noLog, none)).toEqual({ rows, complete: true });
    expect(restoreHistoryRows(undefined, noLog, undefined)).toEqual({ rows: [], complete: true });
  });
});
