/**
 * The RKStorage rescue (spec §3.11, unit W1-2): read the old AsyncStorage
 * document on Android when AsyncStorage itself cannot read it.
 *
 * WHY: AsyncStorage on Android keeps its data in the SQLite file
 * `databases/RKStorage`, table `catalystLocalStorage(key, value)`. It reads a
 * value through an Android "CursorWindow" of about 2 MB, so a bigger document
 * (2.9 MB for German_Complete) makes `getItem` reject. The user's data is
 * still in the file. expo-sqlite reads TEXT with its own SQLite (no
 * CursorWindow), so it can read the big value.
 *
 * SAFETY: two SQLite libraries must not open the same live file in one
 * process (their POSIX file locks can break each other). So we never open the
 * live file: we COPY `RKStorage` and its side files (`-journal`, `-wal`,
 * `-shm`) to `Paths.cache/rk-rescue/` with expo-file-system (no SQLite), open
 * the copy, read the one value, close it and delete the copy.
 *
 * Android only. Resolves null on ANY failure (and on other platforms), so the
 * app then stays read-blocked, which is safe. Must be proven on the emulator
 * (check E2b) before release. Not wired yet: W2-1 passes it to copy-forward.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { Platform } from 'react-native';

import { STORAGE_KEY } from '../persistence';

/** The AsyncStorage database file and its side files, in copy order. */
export const RK_FILES = ['RKStorage', 'RKStorage-journal', 'RKStorage-wal', 'RKStorage-shm'] as const;
/** The folder in `Paths.cache` that holds the copy while we read it. */
export const RK_RESCUE_DIR = 'rk-rescue';

/**
 * Read `key` (default: today's `maranki.state.v1`) from a copy of RKStorage.
 * `os` is only for tests; the app uses the default.
 */
export async function rescueRkStorage(
  key: string = STORAGE_KEY,
  os: string = Platform.OS,
): Promise<string | null> {
  if (os !== 'android') return null;
  let tmp: Directory | null = null;
  let db: SQLiteDatabase | null = null;
  try {
    // Paths.document is <app data>/files/, so its parent holds `databases/`.
    const dbDir = new Directory(Paths.document.parentDirectory, 'databases');
    if (!new File(dbDir, RK_FILES[0]).exists) return null;

    tmp = new Directory(Paths.cache, RK_RESCUE_DIR);
    // Files left by an earlier try must not mix with this copy.
    if (tmp.exists) tmp.delete();
    tmp.create({ idempotent: true, intermediates: true });
    for (const name of RK_FILES) {
      const source = new File(dbDir, name);
      // copy() is async in SDK 56: wait for every file BEFORE opening the copy.
      if (source.exists) await source.copy(new File(tmp, name));
    }

    // A new connection, so we never reuse a cached one for this path.
    db = await openDatabaseAsync(RK_FILES[0], { useNewConnection: true }, tmp.uri);
    const row = await db.getFirstAsync<{ value: unknown }>(
      'SELECT value FROM catalystLocalStorage WHERE key = ?',
      key,
    );
    return typeof row?.value === 'string' && row.value !== '' ? row.value : null;
  } catch {
    // Any failure → null: the caller stays read-blocked (safe).
    return null;
  } finally {
    // Clean up on every path. A failure here must not change the result.
    if (db) await db.closeAsync().catch(() => undefined);
    try {
      if (tmp?.exists) tmp.delete();
    } catch {
      // The cache folder is cleaned by the system later anyway.
    }
  }
}
