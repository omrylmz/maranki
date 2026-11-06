/**
 * Safety copies of the stored text, written as files to
 * `Paths.document/backups/` before the app changes what is stored
 * (spec §3.1 rule 3 "Never destroy the source", §3.10):
 *
 *   - `premigrate-v{from}-to-v{to}-{stamp}.json` — the raw document, written
 *     ONCE per version jump, before the first save in the new schema. Only the
 *     newest 3 of these files are kept.
 *   - `corrupt-{stamp}.json` — a stored text that could not be read, written
 *     before the app starts again from the seed. Never deleted by the app.
 *
 * The file work goes through a tiny `BackupFolder` interface, so the rules
 * (once per jump, keep 3) are tested with a fake folder. The real folder uses
 * the SDK 56 `expo-file-system` API (`Directory`, `File`, `Paths`), which is
 * synchronous and THROWS on failure — callers catch it.
 *
 * Example: `writePremigrateCopy(raw, 0, 2, Date.now())` →
 * `'premigrate-v0-to-v2-2026-07-07T08-10-00-000Z.json'` (or null when a copy
 * of that jump exists already).
 */
import { Directory, File, Paths } from 'expo-file-system';

/** The folder name under `Paths.document`. */
export const BACKUP_DIR = 'backups';
/** How many pre-migration copies are kept (spec §3.1 rule 3). */
export const PREMIGRATE_KEEP = 3;

/** The few file operations the copies need. Every method may throw. */
export interface BackupFolder {
  /** Names of the files in the folder ([] when the folder does not exist yet). */
  names(): string[];
  /** Create or replace the file `name` with `text` (creates the folder when needed). */
  write(name: string, text: string): void;
  /** Delete the file `name` (no error when it does not exist). */
  remove(name: string): void;
}

/** The real folder: `Paths.document/backups/`. */
export function documentBackupFolder(): BackupFolder {
  const dir = new Directory(Paths.document, BACKUP_DIR);
  return {
    names: () => (dir.exists ? dir.list().filter((entry) => entry instanceof File).map((entry) => entry.name) : []),
    write: (name, text) => {
      dir.create({ idempotent: true, intermediates: true });
      const file = new File(dir, name);
      file.create({ overwrite: true });
      file.write(text);
    },
    remove: (name) => {
      const file = new File(dir, name);
      if (file.exists) file.delete();
    },
  };
}

/**
 * A time stamp that is safe in a file name and sorts like the time:
 * `2026-07-07T08-10-00-000Z` (UTC, `:` and `.` replaced by `-`).
 */
export function fileStamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

export function premigrateFileName(from: number, to: number, now: number): string {
  return `premigrate-v${from}-to-v${to}-${fileStamp(now)}.json`;
}

export function corruptFileName(now: number): string {
  return `corrupt-${fileStamp(now)}.json`;
}

const PREMIGRATE_NAME = /^premigrate-v(\d+)-to-v(\d+)-(.+)\.json$/;

/** The parts of a pre-migration file name, or null for any other file. */
export function parsePremigrateName(name: string): { from: number; to: number; stamp: string } | null {
  const m = PREMIGRATE_NAME.exec(name);
  return m ? { from: Number(m[1]), to: Number(m[2]), stamp: m[3] } : null;
}

/**
 * Keep the raw document before the first save in schema `to`. Written once per
 * version jump: when a copy for `from → to` exists already (e.g. the app was
 * killed before the migrated document was saved, so the next boot migrates
 * the same document again), nothing is written and the result is null.
 * Otherwise returns the new file name, then deletes the oldest pre-migration
 * copies so only the newest `PREMIGRATE_KEEP` stay (the new one always stays).
 * Throws when the copy cannot be written.
 */
export function writePremigrateCopy(
  raw: string,
  from: number,
  to: number,
  now: number,
  folder: BackupFolder = documentBackupFolder(),
): string | null {
  const copies = folder
    .names()
    .map((name) => ({ name, parts: parsePremigrateName(name) }))
    .filter((c): c is { name: string; parts: NonNullable<ReturnType<typeof parsePremigrateName>> } => !!c.parts);
  if (copies.some((c) => c.parts.from === from && c.parts.to === to)) return null;

  const name = premigrateFileName(from, to, now);
  folder.write(name, raw);

  // Housekeeping: newest first by stamp; the new copy counts as one of the kept.
  const older = copies.filter((c) => c.name !== name).sort((a, b) => b.parts.stamp.localeCompare(a.parts.stamp));
  for (const old of older.slice(PREMIGRATE_KEEP - 1)) {
    try {
      folder.remove(old.name);
    } catch {
      // An old copy that cannot be deleted does no harm; the new copy is written.
    }
  }
  return name;
}

/**
 * Keep an unreadable stored text as `corrupt-{stamp}.json`, so the learner (or
 * support) can still recover it after the app starts again from the seed.
 * Returns the file name. Throws when the copy cannot be written.
 */
export function writeCorruptCopy(raw: string, now: number, folder: BackupFolder = documentBackupFolder()): string {
  const name = corruptFileName(now);
  folder.write(name, raw);
  return name;
}
