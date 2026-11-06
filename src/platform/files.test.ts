/**
 * Tests for the backup file helpers (src/platform/files.ts, spec §8.4).
 *
 * expo-file-system has no real implementation under jest, so it is replaced by
 * a small in-memory file tree (the `jest.mock` below). It copies the SDK 56
 * behaviour the helpers rely on: `File` / `Directory` objects made from parts,
 * `create`, `write`, `moveSync` (which also moves the object's `uri`),
 * `delete`, `list()`, `size`, `lastModified`, `text()` and the static
 * `File.pickFileAsync()` with its `{ canceled, result }` answer.
 *
 * What is pinned here:
 *   - every write is atomic (through `<name>.tmp`) and never escapes its folder;
 *   - listBackups() lists complete `.json` files only, newest first — also the
 *     OLD exports that v2.0.x wrote to the root of Paths.document, which
 *     readBackupFile() can read and deleteBackup() never deletes;
 *   - deleteCacheFiles() removes only the old shared files with one prefix;
 *   - pickJsonFile() returns the file's DATE (`modifiedAt`), which the Restore
 *     flow shows for an old export that has no date inside (wave-1 review);
 *   - a huge file is never read into memory;
 *   - (wave 5c) the time Settings › Your data shows and sorts by for a listed
 *     backup (src/store/backup.ts `backupTimeOf`, read through this file's
 *     `listBackups`): a name from before wave 5b (a UTC stamp) is read as
 *     UTC when the file date says so.
 */
// '@jest/globals' must be imported FIRST: the jest.mock factory below uses
// its `jest`, and it runs when expo-file-system is imported.
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as FileSystem from 'expo-file-system';

import {
  backupStamp,
  backupTimeOf,
  deviceBackupIO,
  localFileStamp,
  oldBackupsToDelete,
  readBackupList,
  stampTimeOf,
  utcStampTimeOf,
} from '../store/backup';
import {
  BACKUPS_FOLDER,
  type BackupFileInfo,
  deleteBackup,
  deleteCacheFiles,
  listBackups,
  MAX_JSON_FILE_BYTES,
  pickJsonFile,
  readBackupFile,
  writeCacheFile,
  writeDocumentFile,
} from './files';

/* ------------------------------------------------------------ module mock */

interface FakeEntry {
  text: string;
  /** When it was last written (null = the system does not say). */
  modifiedAt: number | null;
  /** A size to report instead of the text length (for "too big" files). */
  size?: number;
}

interface FakeFs {
  files: Map<string, FakeEntry>;
  dirs: Set<string>;
  /** The "clock" of the fake disk: each write gets the next number. */
  tick: { now: number };
  /** Text that makes `write` throw (a full disk). */
  failWrites: Set<string>;
  /** How many times `text()` was called. */
  reads: { count: number };
  /** What the next pickFileAsync resolves (a uri of a fake file, or 'cancel'). */
  pick: { next: string | 'cancel'; options: unknown[] };
}

jest.mock('expo-file-system', () => {
  const fs = {
    files: new Map(),
    dirs: new Set(),
    tick: { now: 1_000 },
    failWrites: new Set(),
    reads: { count: 0 },
    pick: { next: 'cancel', options: [] },
  } as unknown as FakeFs;
  const uriOf = (parts: unknown[]) =>
    parts.map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri).replace(/\/+$/, '')).join('/');
  const parentOf = (uri: string) => uri.slice(0, uri.lastIndexOf('/'));
  const nameOf = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);

  class File {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = uriOf(parts);
    }
    get name() {
      return nameOf(this.uri);
    }
    get exists() {
      return fs.files.has(this.uri);
    }
    get size() {
      const entry = fs.files.get(this.uri);
      return entry ? (entry.size ?? entry.text.length) : 0;
    }
    get lastModified() {
      return fs.files.get(this.uri)?.modifiedAt ?? null;
    }
    create() {
      if (!fs.dirs.has(parentOf(this.uri))) throw new Error(`no folder for ${this.uri}`);
      fs.files.set(this.uri, { text: '', modifiedAt: (fs.tick.now += 1) });
    }
    write(text: string) {
      if (fs.failWrites.has(text)) throw new Error('disk full');
      fs.files.set(this.uri, { text, modifiedAt: (fs.tick.now += 1) });
    }
    moveSync(dest: { uri: string }) {
      const entry = fs.files.get(this.uri);
      if (!entry) throw new Error(`no file ${this.uri}`);
      fs.files.delete(this.uri);
      fs.files.set(dest.uri, entry);
      this.uri = dest.uri;
    }
    delete() {
      if (!fs.files.delete(this.uri)) throw new Error(`no file ${this.uri}`);
    }
    async text() {
      fs.reads.count += 1;
      const entry = fs.files.get(this.uri);
      if (!entry) throw new Error(`no file ${this.uri}`);
      return entry.text;
    }
    static async pickFileAsync(options: unknown) {
      fs.pick.options.push(options);
      if (fs.pick.next === 'cancel') return { canceled: true, result: null };
      return { canceled: false, result: new File(fs.pick.next) };
    }
  }

  class Directory {
    readonly uri: string;
    constructor(...parts: unknown[]) {
      this.uri = uriOf(parts);
    }
    get exists() {
      return fs.dirs.has(this.uri);
    }
    create() {
      fs.dirs.add(this.uri);
    }
    list() {
      const out: (File | Directory)[] = [];
      for (const uri of fs.files.keys()) if (parentOf(uri) === this.uri) out.push(new File(uri));
      for (const uri of fs.dirs) if (parentOf(uri) === this.uri) out.push(new Directory(uri));
      return out;
    }
  }

  const Paths = {
    get document() {
      return new Directory('file:///app/files');
    },
    get cache() {
      return new Directory('file:///app/cache');
    },
  };
  return { File, Directory, Paths, __fs: fs };
});

const fs = (FileSystem as unknown as { __fs: FakeFs }).__fs;
const DOC = 'file:///app/files';
const CACHE = 'file:///app/cache';
const BACKUPS = `${DOC}/${BACKUPS_FOLDER}`;

/** Put a file on the fake disk. */
function put(uri: string, text: string, modifiedAt: number | null, size?: number) {
  fs.dirs.add(uri.slice(0, uri.lastIndexOf('/')));
  fs.files.set(uri, { text, modifiedAt, size });
}

beforeEach(() => {
  fs.files.clear();
  fs.dirs.clear();
  fs.dirs.add(DOC);
  fs.dirs.add(CACHE);
  fs.failWrites.clear();
  fs.reads.count = 0;
  fs.pick.next = 'cancel';
  fs.pick.options.length = 0;
});

/* ------------------------------------------------------------------ writes */

describe('writeCacheFile / writeDocumentFile', () => {
  test('a cache file holds the whole text, and no .tmp file is left', () => {
    const saved = writeCacheFile('maranki-backup-x.json', '{"a":1}');
    expect(saved).toEqual({ name: 'maranki-backup-x.json', uri: `${CACHE}/maranki-backup-x.json` });
    expect(fs.files.get(`${CACHE}/maranki-backup-x.json`)?.text).toBe('{"a":1}');
    expect([...fs.files.keys()].filter((uri) => uri.endsWith('.tmp'))).toEqual([]);
  });

  test('a document file creates the backups folder and replaces an older file', () => {
    expect(fs.dirs.has(BACKUPS)).toBe(false);
    writeDocumentFile('auto-1.json', 'old');
    writeDocumentFile('auto-1.json', 'new');
    expect(fs.dirs.has(BACKUPS)).toBe(true);
    expect(fs.files.get(`${BACKUPS}/auto-1.json`)?.text).toBe('new');
  });

  test('a failed write leaves neither the file nor a .tmp, and throws', () => {
    fs.failWrites.add('BROKEN');
    expect(() => writeDocumentFile('auto-2.json', 'BROKEN')).toThrow('disk full');
    expect([...fs.files.keys()].filter((uri) => uri.startsWith(BACKUPS))).toEqual([]);
  });

  test('a name with a folder in it is refused, and nothing is written', () => {
    for (const bad of ['../escape.json', 'a/b.json', '', '..']) {
      expect(() => writeCacheFile(bad, 'x')).toThrow('Unsafe file name');
      expect(() => writeDocumentFile(bad, 'x')).toThrow('Unsafe file name');
    }
    expect(() => writeDocumentFile('ok.json', 'x', '../outside')).toThrow('Unsafe file name');
    expect(fs.files.size).toBe(0);
  });
});

/* ---------------------------------------------------------------- listing */

describe('listBackups / deleteBackup', () => {
  test('no backups folder yet → an empty list', () => {
    expect(listBackups()).toEqual([]);
  });

  test('complete .json files only, newest first, with size and date', () => {
    put(`${BACKUPS}/auto-a.json`, 'aa', 100);
    put(`${BACKUPS}/auto-b.json`, 'bbbb', 300);
    put(`${BACKUPS}/before-restore-c.json`, 'c', 200);
    put(`${BACKUPS}/auto-d.json.tmp`, 'half', 400); // an interrupted write
    put(`${BACKUPS}/notes.txt`, 'x', 500);
    fs.dirs.add(`${BACKUPS}/sub.json`); // a folder is never listed

    expect(listBackups().map((b) => b.name)).toEqual(['auto-b.json', 'before-restore-c.json', 'auto-a.json']);
    expect(listBackups('auto-')).toEqual([
      { name: 'auto-b.json', uri: `${BACKUPS}/auto-b.json`, size: 4, modifiedAt: 300 },
      { name: 'auto-a.json', uri: `${BACKUPS}/auto-a.json`, size: 2, modifiedAt: 100 },
    ]);
  });

  test('an unknown date sorts by name (our names end with a time stamp)', () => {
    put(`${BACKUPS}/auto-2026-01-01-00-00-00.json`, 'x', null);
    put(`${BACKUPS}/auto-2026-02-01-00-00-00.json`, 'x', null);
    expect(listBackups().map((b) => [b.name, b.modifiedAt])).toEqual([
      ['auto-2026-02-01-00-00-00.json', null],
      ['auto-2026-01-01-00-00-00.json', null],
    ]);
  });

  test('deleteBackup removes one file; a missing file is no error', () => {
    put(`${BACKUPS}/auto-a.json`, 'x', 1);
    deleteBackup('auto-a.json');
    expect(fs.files.has(`${BACKUPS}/auto-a.json`)).toBe(false);
    expect(() => deleteBackup('auto-a.json')).not.toThrow();
    expect(() => deleteBackup('../x')).toThrow('Unsafe file name');
  });
});

/* ------------------------------------- old exports (v2.0.x, wave 1) */

describe('old exports in the root of Paths.document (review round 1)', () => {
  // v2.0.0–v2.0.2 and wave 1 wrote "Export a backup" to
  // `new File(Paths.document, 'maranki-backup-<stamp>.json')`. The system
  // picker cannot open app-private storage, so the app must list them itself.
  const OLD = 'maranki-backup-2026-06-30-21-04-07.json';

  test('a root maranki-backup-*.json is listed (with the backups folder) and readable', async () => {
    put(`${DOC}/${OLD}`, '{"cards":[]}', 50);
    put(`${BACKUPS}/auto-2026-10-21-18-04-07.json`, '{}', 900);
    expect(listBackups()).toEqual([
      { name: 'auto-2026-10-21-18-04-07.json', uri: `${BACKUPS}/auto-2026-10-21-18-04-07.json`, size: 2, modifiedAt: 900 },
      // W2 hardening: marked, so the list offers no "Delete" for it.
      { name: OLD, uri: `${DOC}/${OLD}`, size: 12, modifiedAt: 50, oldExport: true },
    ]);
    await expect(readBackupFile(OLD)).resolves.toEqual({
      name: OLD,
      uri: `${DOC}/${OLD}`,
      size: 12,
      modifiedAt: 50,
      tooBig: false,
      text: '{"cards":[]}',
    });
  });

  test('listed even when the backups folder does not exist yet', () => {
    put(`${DOC}/${OLD}`, '{}', 50);
    expect(fs.dirs.has(BACKUPS)).toBe(false);
    expect(listBackups().map((b) => b.uri)).toEqual([`${DOC}/${OLD}`]);
  });

  test('other root files are never listed or read as backups', async () => {
    put(`${DOC}/maranki-raw-data-2026-01-01-00-00-00.json`, '{}', 1);
    put(`${DOC}/settings.json`, '{}', 2);
    put(`${DOC}/maranki-backup-x.json.tmp`, 'half', 3);
    fs.dirs.add(`${DOC}/maranki-backup-folder.json`); // a folder
    expect(listBackups()).toEqual([]);
    await expect(readBackupFile('settings.json')).rejects.toThrow('No backup named');
  });

  test('a prefix filter applies to them too (weekly-backup pruning never sees them)', () => {
    put(`${DOC}/${OLD}`, '{}', 50);
    expect(listBackups('auto-')).toEqual([]);
    expect(listBackups('maranki-backup-').map((b) => b.name)).toEqual([OLD]);
  });

  test('the same name in the backups folder wins (one row per name)', async () => {
    put(`${DOC}/${OLD}`, 'root', 50);
    put(`${BACKUPS}/${OLD}`, 'folder', 60);
    expect(listBackups().map((b) => b.uri)).toEqual([`${BACKUPS}/${OLD}`]);
    expect((await readBackupFile(OLD)).text).toBe('folder');
  });

  test('deleteBackup never deletes an old root export', () => {
    put(`${DOC}/${OLD}`, '{}', 50);
    deleteBackup(OLD);
    expect(fs.files.has(`${DOC}/${OLD}`)).toBe(true);
  });

  test('only a root export is marked oldExport; a file in the backups folder never is (W2 hardening)', () => {
    const KEPT = 'maranki-backup-2026-10-21-18-04-07.json';
    put(`${DOC}/${OLD}`, 'root', 50);
    put(`${BACKUPS}/${KEPT}`, 'kept', 60);
    put(`${BACKUPS}/before-restore-2026-10-20-08-00-00.json`, 'copy', 40);
    expect(listBackups().map((b) => [b.name, b.oldExport === true])).toEqual([
      [KEPT, false],
      [OLD, true],
      ['before-restore-2026-10-20-08-00-00.json', false],
    ]);
    // The same name in both places: the folder file wins, and it is not marked.
    put(`${BACKUPS}/${OLD}`, 'folder', 70);
    expect(listBackups().find((b) => b.name === OLD)?.oldExport).toBeUndefined();
  });
});

/* ------------------------------------------------------------ cache files */

describe('deleteCacheFiles', () => {
  test('deletes the cache files with the prefix (and their .tmp), nothing else', () => {
    put(`${CACHE}/maranki-backup-a.json`, 'a', 1);
    put(`${CACHE}/maranki-backup-b.json.tmp`, 'b', 2);
    put(`${CACHE}/maranki-history-c.csv`, 'c', 3);
    put(`${DOC}/maranki-backup-d.json`, 'd', 4);
    fs.dirs.add(`${CACHE}/maranki-backup-dir`);
    expect(deleteCacheFiles('maranki-backup-').sort()).toEqual(['maranki-backup-a.json', 'maranki-backup-b.json.tmp']);
    expect([...fs.files.keys()].sort()).toEqual([`${CACHE}/maranki-history-c.csv`, `${DOC}/maranki-backup-d.json`]);
    expect(fs.dirs.has(`${CACHE}/maranki-backup-dir`)).toBe(true);
  });

  test('an empty prefix would match every cache file → it throws and deletes nothing', () => {
    put(`${CACHE}/x.json`, 'x', 1);
    expect(() => deleteCacheFiles('')).toThrow();
    expect(fs.files.has(`${CACHE}/x.json`)).toBe(true);
  });

  test('no cache folder → nothing to delete', () => {
    fs.dirs.delete(CACHE);
    expect(deleteCacheFiles('maranki-backup-')).toEqual([]);
  });
});

/* ---------------------------------------------------------------- reading */

describe('pickJsonFile', () => {
  test('Cancel → null', async () => {
    await expect(pickJsonFile()).resolves.toBeNull();
  });

  test('asks for JSON or any file (Android may not know .json)', async () => {
    await pickJsonFile();
    expect(fs.pick.options).toEqual([{ mimeTypes: ['application/json', '*/*'] }]);
  });

  test('returns the text, the size and the file DATE (for an old export with no date inside)', async () => {
    const uri = 'content://downloads/maranki-backup-2026-06-30.json';
    put(uri, '{"cards":[]}', 1_782_000_000_000);
    fs.pick.next = uri;
    await expect(pickJsonFile()).resolves.toEqual({
      name: 'maranki-backup-2026-06-30.json',
      uri,
      size: 12,
      modifiedAt: 1_782_000_000_000,
      tooBig: false,
      text: '{"cards":[]}',
    });
  });

  test('a file manager that gives no date → modifiedAt null', async () => {
    put('content://x/backup.json', '{}', null);
    fs.pick.next = 'content://x/backup.json';
    expect((await pickJsonFile())?.modifiedAt).toBeNull();
  });

  test('a file over 128 MB is never read into memory', async () => {
    put('content://x/video.mp4', 'not read', 5, MAX_JSON_FILE_BYTES + 1);
    fs.pick.next = 'content://x/video.mp4';
    const picked = await pickJsonFile();
    expect(picked?.tooBig).toBe(true);
    expect(picked?.text).toBe('');
    expect(fs.reads.count).toBe(0);
  });
});

describe('readBackupFile', () => {
  test('reads a backup of the backups folder, with its date', async () => {
    put(`${BACKUPS}/auto-2026-10-21-18-04-07.json`, '{"format":"maranki-backup"}', 777);
    await expect(readBackupFile('auto-2026-10-21-18-04-07.json')).resolves.toEqual({
      name: 'auto-2026-10-21-18-04-07.json',
      uri: `${BACKUPS}/auto-2026-10-21-18-04-07.json`,
      size: 27,
      modifiedAt: 777,
      tooBig: false,
      text: '{"format":"maranki-backup"}',
    });
  });

  test('a missing file rejects; a name with a folder in it throws', async () => {
    await expect(readBackupFile('auto-gone.json')).rejects.toThrow('No backup named');
    await expect(readBackupFile('../secret.json')).rejects.toThrow('Unsafe file name');
  });
});

/* ------------------------------ the time of a listed backup (wave 5c) */

/**
 * Builds before wave 5b named their backups in UTC; this build names them in
 * LOCAL time (src/store/backup.ts `localFileStamp`). The two kinds look the
 * same, so `backupTimeOf` reads an old name as UTC when the FILE DATE (what
 * `listBackups` gives) says so. The list goes through the real file helpers
 * of this file (`deviceBackupIO.list` → `listBackups` → the fake disk).
 *
 * Every expected value is built from the same moment `T`, so the tests hold
 * in every time zone. The old reading (a UTC name read as local time) is off
 * by the phone's offset from UTC (`offset`): 2 hours in Berlin in summer, 0
 * on a machine that runs in UTC (there the two readings are the same).
 */
describe('the time of a listed backup: a name from before wave 5b (UTC) is read as UTC (wave 5c)', () => {
  /** 21 Oct 2026, 07:28:30 UTC (09:28:30 in Berlin). */
  const T = Date.UTC(2026, 9, 21, 7, 28, 30);
  const MIN = 60_000;
  const DAY = 24 * 60 * MIN;
  /** A name of this build (local time) and of a build before wave 5b (UTC), for the moment `at`. */
  const localName = (prefix: string, at: number) => `${prefix}${localFileStamp(at)}.json`;
  const utcName = (prefix: string, at: number) => `${prefix}${backupStamp(new Date(at))}.json`;
  /** The phone's offset from UTC at T: a local name read as UTC is this much later. */
  const offset = utcStampTimeOf(localName('auto-', T))! - T;
  const info = (name: string, modifiedAt: number | null): BackupFileInfo => ({
    name,
    uri: `${BACKUPS}/${name}`,
    size: 2,
    modifiedAt,
  });

  test('utcStampTimeOf reads the stamp as UTC; a stamp that is no real moment gives null', () => {
    expect(utcStampTimeOf('auto-2026-10-21-07-28-30.json')).toBe(T);
    expect(utcStampTimeOf(utcName('before-restore-', T))).toBe(T);
    expect(utcStampTimeOf('auto-2026-13-21-07-28-30.json')).toBeNull(); // month 13
    expect(utcStampTimeOf('auto-2026-02-30-07-28-30.json')).toBeNull(); // 30 February
    expect(utcStampTimeOf('auto-latest.json')).toBeNull();
    // The local reading of the same name (wave 5b) is off by the offset.
    expect(stampTimeOf('auto-2026-10-21-07-28-30.json')).toBe(T - offset);
  });

  test('an old weekly backup (UTC name) is listed with its REAL time, written a second after its name', () => {
    const old = utcName('auto-', T);
    put(`${BACKUPS}/${old}`, '{}', T + 1000);
    const { files, failed } = readBackupList(deviceBackupIO);
    expect(failed).toBe(false);
    expect(files.map((f) => [f.name, f.at])).toEqual([[old, T]]);
    expect(backupTimeOf(files[0])).toBe(T);
  });

  test('a backup of this build (local name) keeps its local reading', () => {
    const name = localName('auto-', T);
    put(`${BACKUPS}/${name}`, '{}', T + 1000);
    expect(readBackupList(deviceBackupIO).files.map((f) => [f.name, f.at])).toEqual([[name, T]]);
  });

  test('old and new names in one list sort by their real time, newest first', () => {
    const weekly = utcName('auto-', T + 30 * MIN); // the newest, named by an old build
    const copy = utcName('before-restore-', T - 3 * DAY);
    const exported = localName('maranki-backup-', T); // named by this build
    put(`${BACKUPS}/${weekly}`, '{}', T + 30 * MIN + 1000);
    put(`${BACKUPS}/${copy}`, '{}', T - 3 * DAY + 2000);
    put(`${BACKUPS}/${exported}`, '{}', T + 500);
    expect(readBackupList(deviceBackupIO).files.map((f) => [f.name, f.at])).toEqual([
      [weekly, T + 30 * MIN],
      [exported, T],
      [copy, T - 3 * DAY],
    ]);
  });

  test('the rules of the backups use the same time: "keep the newest" keeps the really newest file', () => {
    const olderLocal = localName('auto-', T);
    const newerUtc = utcName('auto-', T + 30 * MIN);
    const files = [info(olderLocal, T + 1000), info(newerUtc, T + 30 * MIN + 1000)];
    expect(oldBackupsToDelete(files, 'auto-', T + DAY, 1)).toEqual([olderLocal]);
  });

  test('no file date, or a file date far from both readings: the name is read as LOCAL time (as before)', () => {
    const old = utcName('auto-', T);
    // No file date: nothing says the name is old.
    expect(backupTimeOf(info(old, null))).toBe(stampTimeOf(old));
    // A file copied three days later: its date says nothing about the name.
    expect(backupTimeOf(info(old, T + 3 * DAY))).toBe(stampTimeOf(old));
    expect(backupTimeOf(info(localName('auto-', T), T + 3 * DAY))).toBe(T);
    // A name without a stamp: the file date.
    expect(backupTimeOf(info('auto-latest.json', T))).toBe(T);
    expect(backupTimeOf(info('auto-latest.json', null))).toBeNull();
  });
});
