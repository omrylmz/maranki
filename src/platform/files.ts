/**
 * File helpers for backups and exports (spec §8.4), via expo-file-system
 * (the SDK 56 `File` / `Directory` / `Paths` API).
 *
 * Two places on the phone:
 *   - Paths.cache    — for a file we only SHARE (backup export, history CSV).
 *                      The system may clean this folder when space is low.
 *                      Before a new export is written there, the older ones
 *                      with the same name prefix are deleted
 *                      (`deleteCacheFiles`), so the folder does not grow.
 *   - Paths.document — private app storage that the system keeps. Backups live
 *                      in its `backups/` folder: the weekly automatic backups,
 *                      the copy made before a restore, and an export kept on
 *                      the phone (when sharing is not available, and always
 *                      for the Erase sheet's "Export a backup first").
 *
 * OLD EXPORTS: v2.0.0–v2.0.2 and the wave-1 builds wrote "Export a backup" to
 * the ROOT of Paths.document (`maranki-backup-<stamp>.json`), not to
 * `backups/`. The system file picker cannot open app-private storage, so
 * those files are listed and read from where they are (`listBackups`,
 * `readBackupFile`). They are never moved and never deleted by the app.
 *
 * Every write is "atomic": the text goes to `<name>.tmp` first, and only a
 * complete file is moved to `<name>`. So an app kill in the middle of a write
 * never leaves a half-written backup that looks real (listBackups() lists
 * `.json` files only, never `.tmp`).
 *
 * File names must be plain names (`isSafeFileName`): a name with '/' or '..'
 * throws, so a write can never land outside its folder.
 *
 * Used by the backup export, the automatic backups and the Restore flow
 * (src/store/backup.ts, src/store/autoBackup.ts, src/components/data/). The
 * calls are synchronous where the SDK 56 API is synchronous; they THROW on
 * failure, so a caller can never report a backup that was not written.
 *
 * The names are made by src/store/backup.ts (`localBackupFileName`): a
 * prefix and a time stamp in the phone's LOCAL time, so the learner reads
 * the right time in the Files app (wave 5b).
 *
 * Example:
 *   const saved = writeDocumentFile(localBackupFileName('auto', now), encodeBackup(state, meta));
 *   const autos = listBackups(BACKUP_PREFIX.auto);   // newest first
 *   autos.slice(3).forEach((b) => deleteBackup(b.name));
 */
import { Directory, File, Paths } from 'expo-file-system';

import { BACKUP_PREFIX, isSafeFileName } from './backupFile';

/** The folder in Paths.document that holds backups. */
export const BACKUPS_FOLDER = 'backups';

/**
 * The biggest file pickJsonFile() reads (128 MB). A real backup is far
 * smaller: the state is a few MB, and images are only included up to 50 MB
 * (≈ 67 MB as base64 text). Reading a huge wrong file (a video) into one
 * string could crash the app.
 */
export const MAX_JSON_FILE_BYTES = 128 * 1024 * 1024;

/** The picker filter of the Restore flow (spec §8.4): JSON, or any file. */
const JSON_PICKER_TYPES = ['application/json', '*/*'];

/** A file that was written. */
export interface SavedFile {
  /** The file name, e.g. 'auto-2026-10-21-18-04-07.json'. */
  name: string;
  /** Its file:// URI (for sharing). */
  uri: string;
}

/** A backup file found in Paths.document/backups/ (or an old export in Paths.document). */
export interface BackupFileInfo extends SavedFile {
  /** Size in bytes. */
  size: number;
  /** Last change, epoch ms. null when the system does not say. */
  modifiedAt: number | null;
  /**
   * True for an OLD export in the ROOT of Paths.document (v2.0.x, see the
   * file comment), not in the backups folder. The app never deletes such a
   * file, so the list offers no "Delete" for it. Missing = in the backups folder.
   */
  oldExport?: boolean;
}

/** A file the user picked (or a backup file the app keeps), with its text. */
export interface PickedFile extends SavedFile {
  /** Size in bytes (0 when the system does not say). */
  size: number;
  /**
   * When the file was last changed, epoch ms. null when the system does not
   * say. An OLD export (the raw state JSON, written before wave 2) has no
   * `exportedAt` inside, so the Restore flow shows this date instead
   * (`BackupInfo.exportedAt` in src/platform/backupFile.ts says so).
   */
  modifiedAt: number | null;
  /** True when the file is bigger than MAX_JSON_FILE_BYTES. Then `text` is '' and was not read. */
  tooBig: boolean;
  /** The whole file as text. Give it to decodeBackup(). */
  text: string;
}

/** Throw when `name` is not one plain file or folder name. */
function assertSafeName(name: string): void {
  if (!isSafeFileName(name)) throw new Error(`Unsafe file name: ${JSON.stringify(name)}`);
}

function backupsDirectory(): Directory {
  return new Directory(Paths.document, BACKUPS_FOLDER);
}

/**
 * True for the name of an OLD export in the root of Paths.document:
 * 'maranki-backup-<stamp>.json' (v2.0.x and wave 1). Other files there (the
 * app's own data, fonts …) are never listed or read as backups.
 */
function isLegacyExportName(name: string): boolean {
  return name.startsWith(BACKUP_PREFIX.export) && name.endsWith('.json');
}

/**
 * A file's "last changed" time as epoch ms, or null. The value comes from the
 * system; for a picked file (an Android `content://` URI) some file managers
 * do not give it, and a broken value (0, NaN, an error) also becomes null.
 */
function lastModifiedOf(file: File): number | null {
  try {
    const value = file.lastModified;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Read a whole file as text, unless it is bigger than MAX_JSON_FILE_BYTES
 * (then `tooBig` is true and `text` is ''). A read error rejects.
 */
async function readTextFile(file: File): Promise<PickedFile> {
  const size = file.size;
  const tooBig = size > MAX_JSON_FILE_BYTES;
  const text = tooBig ? '' : await file.text();
  return { name: file.name, uri: file.uri, size, modifiedAt: lastModifiedOf(file), tooBig, text };
}

/** Write `content` to `dir/name` through `name.tmp`, so the final file is always complete. */
function writeAtomically(dir: Directory, name: string, content: string | Uint8Array): SavedFile {
  assertSafeName(name);
  const tmp = new File(dir, `${name}.tmp`);
  const target = new File(dir, name);
  try {
    tmp.create({ overwrite: true });
    tmp.write(content);
    tmp.moveSync(target, { overwrite: true });
  } catch (error) {
    try {
      if (tmp.exists) tmp.delete();
    } catch {
      // Ignored: the original error below is the one that matters.
    }
    throw error;
  }
  return { name, uri: target.uri };
}

/**
 * Write a file to the cache folder, for sharing (spec §8.4: the backup export
 * is `new File(Paths.cache, 'maranki-backup-<stamp>.json')`). Text is written
 * as UTF-8. An existing file with the same name is replaced.
 */
export function writeCacheFile(name: string, content: string | Uint8Array): SavedFile {
  return writeAtomically(Paths.cache, name, content);
}

/**
 * Delete every file in the cache folder whose name starts with `prefix`
 * (e.g. 'maranki-backup-'): old exports that were already shared, and their
 * `.tmp` leftovers. Returns the deleted names. Folders are never touched.
 * An empty prefix throws (it would match every file in the cache).
 *
 * Example (before a new export is written):
 *   deleteCacheFiles(BACKUP_PREFIX.export);
 */
export function deleteCacheFiles(prefix: string): string[] {
  if (prefix === '') throw new Error('deleteCacheFiles needs a name prefix');
  const dir = Paths.cache;
  if (!dir.exists) return [];
  const deleted: string[] = [];
  for (const item of dir.list()) {
    if (!(item instanceof File) || !item.name.startsWith(prefix)) continue;
    item.delete();
    deleted.push(item.name);
  }
  return deleted;
}

/**
 * Write a file to Paths.document/<folder>/ (default: the backups folder). The
 * folder is created when it does not exist yet. An existing file with the
 * same name is replaced.
 */
export function writeDocumentFile(
  name: string,
  content: string | Uint8Array,
  folder: string = BACKUPS_FOLDER,
): SavedFile {
  assertSafeName(folder);
  const dir = new Directory(Paths.document, folder);
  dir.create({ idempotent: true, intermediates: true });
  return writeAtomically(dir, name, content);
}

/** The facts of one listed file. */
function infoOf(file: File): BackupFileInfo {
  return { name: file.name, uri: file.uri, size: file.size, modifiedAt: lastModifiedOf(file) };
}

/**
 * The backup files in Paths.document/backups/, NEWEST FIRST. Only complete
 * `.json` files are listed. With `prefix` (e.g. BACKUP_PREFIX.auto), only the
 * files whose name starts with it. No folder yet → [].
 *
 * The OLD exports in the root of Paths.document ('maranki-backup-*.json',
 * see the file comment) are listed too, when they match `prefix`. If the
 * backups folder has a file with the same name, that one wins (one row per
 * name).
 */
export function listBackups(prefix = ''): BackupFileInfo[] {
  const found = new Map<string, BackupFileInfo>();
  const dir = backupsDirectory();
  if (dir.exists) {
    for (const item of dir.list()) {
      if (!(item instanceof File)) continue;
      const name = item.name;
      if (!name.endsWith('.json') || !name.startsWith(prefix)) continue;
      found.set(name, infoOf(item));
    }
  }
  const root = Paths.document;
  if (root.exists) {
    for (const item of root.list()) {
      if (!(item instanceof File)) continue;
      const name = item.name;
      if (!isLegacyExportName(name) || !name.startsWith(prefix) || found.has(name)) continue;
      found.set(name, { ...infoOf(item), oldExport: true });
    }
  }
  // Newest first. Same time (or unknown) → by name, and our names end with a time stamp.
  return [...found.values()].sort(
    (a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0) || b.name.localeCompare(a.name),
  );
}

/**
 * Delete one file from the backups folder (to keep only the newest 3).
 * Missing file → nothing happens. An old export in the root of Paths.document
 * is NEVER deleted here (it may be the only copy of data that was erased).
 */
export function deleteBackup(name: string): void {
  assertSafeName(name);
  const file = new File(backupsDirectory(), name);
  if (file.exists) file.delete();
}

/**
 * Let the user pick a backup file and read it (spec §8.4, Restore flow step 1).
 * Resolves null when the user cancels the picker.
 *
 * The MIME type list also allows ANY file, on purpose: Android file managers
 * often do not know that a .json file is 'application/json', so a strict
 * filter would hide the user's backup. decodeBackup() checks the content.
 */
export async function pickJsonFile(): Promise<PickedFile | null> {
  const picked = await File.pickFileAsync({ mimeTypes: JSON_PICKER_TYPES });
  if (picked.canceled) return null;
  return readTextFile(picked.result);
}

/**
 * Read one file of the backups folder (an automatic backup, the copy made
 * before a restore …), for "Restore" in Settings › Your data. Same result as
 * pickJsonFile(). An OLD export that is not in the backups folder is read from
 * the root of Paths.document (where v2.0.x wrote it). Rejects when the file
 * does not exist or cannot be read.
 */
export async function readBackupFile(name: string): Promise<PickedFile> {
  assertSafeName(name);
  const inFolder = new File(backupsDirectory(), name);
  if (inFolder.exists) return readTextFile(inFolder);
  if (isLegacyExportName(name)) {
    const inRoot = new File(Paths.document, name);
    if (inRoot.exists) return readTextFile(inRoot);
  }
  throw new Error(`No backup named ${JSON.stringify(name)}`);
}
