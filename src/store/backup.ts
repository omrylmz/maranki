/**
 * Data safety you can see (spec §8.4, §8.8, unit W2-2): the store side of
 *   - "Export a backup"          → one backup file, then the share sheet;
 *   - the Erase sheet's "Export a backup first" → a backup KEPT on this phone,
 *                                  then the share sheet (`exportAndKeepBackup`);
 *   - "Restore a backup"         → read a file, migrate it, say what is in it,
 *                                  then the safe order of `performRestore`;
 *   - the copy made before a restore (`before-restore-<stamp>.json`): the
 *     newest 3 are always kept, and no copy younger than 30 days is deleted;
 *   - "Export study history"     → a sessions CSV, then the share sheet;
 *   - the list of backup files kept on this phone (Settings › Your data),
 *     and "Delete" for an export or a before-restore copy in that list.
 *
 * WHY: the old "Export a backup" wrote a private file that nobody could open,
 * and "Restore" only showed a snackbar (audit M1, spec §7 rows 10–13). Now a
 * backup goes through the system share sheet, so the user can keep it in
 * Files, Drive or an email, and any backup file can be restored.
 *
 * How the parts fit:
 *   - The backup FORMAT (the envelope) is src/platform/backupFile.ts.
 *   - The FILE and SHARE calls are src/platform/files.ts and share.ts. Here
 *     they are reached through `BackupIO`, a small interface, so the tests
 *     use a fake disk and a fake share sheet (`deviceBackupIO` is the real one).
 *   - A restore uses the SAME `migrate()` as the boot load
 *     (src/store/migrate.ts), so every backup ever made restores, also v0
 *     backups with `word`/`tr` cards (spec §3.1 rule 5).
 *   - Every word the user sees is in this file (RESTORE_COPY and the message
 *     functions), so autoBackup.test.ts can pin it.
 *
 * The review history and the images (W4-5, spec §8.4): an exported backup
 * carries the uncapped review history (`revlog`, from the row store) and,
 * when "Include images in backups" is on and they fit in 50 MB, the deck
 * images. A restore writes the history IN its replace-all transaction (so
 * no kill or failed write can leave the table empty in between), and the
 * images after that save committed. The copy made before a restore keeps
 * the CURRENT history (the restore replaces the history table, so that copy
 * is the way back). These parts are reached through optional members of
 * `BackupIO`; `fullBackupIO(revlog)` adds them to the real disk. A BackupIO without them (the tests' fake
 * disk) writes backups without history and images. The WEEKLY backup
 * (autoBackup.ts) carries the history too (wave 5) — only its images are
 * left out, so restoring it never empties the history.
 *
 * Nothing here throws to a screen: the export and history functions resolve
 * an outcome, `readBackup` returns a result and `performRestore` resolves a
 * `RestoreResult`. Only `writeBeforeRestoreCopy` throws, on purpose: when the
 * safety copy cannot be written, the restore must stop.
 *
 * WHY the Erase sheet keeps a copy on the phone: the share sheet cannot tell
 * us whether the user saved the file or closed the sheet (on Android,
 * `Sharing.shareAsync` resolves the same way for both). A file that only
 * lives in the cache folder may be cleaned by the system. So "Backup saved ✓"
 * is shown only after the backup is written to Paths.document/backups/.
 *
 * Example ("Export a backup"):
 *   const outcome = await exportBackup(state, Date.now());
 *   const message = exportMessage(outcome);   // null when the share sheet opened
 *   if (message) show(message);
 */
import Constants from 'expo-constants';

import type { Id, RevlogRow } from '../domain/model';
import { plural } from '../domain/text';
import { type AppSettings, DAY, type DataState, type SessionRecord } from '../domain/types';
import {
  BACKUP_PREFIX,
  type BackupKind,
  type BackupMedia,
  type BackupMeta,
  decodeBackup,
  type DecodeResult,
  encodeBackup,
  type MigrateFn,
} from '../platform/backupFile';
import { toCsv } from '../platform/csv';
import {
  type BackupFileInfo,
  deleteBackup,
  deleteCacheFiles,
  listBackups,
  type SavedFile,
  writeCacheFile,
  writeDocumentFile,
} from '../platform/files';
import { mediaForBackup, writeBackupMedia } from '../platform/media';
import { SHARE_BACKUP, SHARE_HISTORY_CSV, SHARE_HISTORY_ZIP, shareFile, type ShareKind } from '../platform/share';
import type { FlushResult } from './actions';
import { migrate } from './migrate';
import { cleanRevlogRow, type RevlogStore } from './storage/revlogStore';

/* ------------------------------------------------------------- stamps */

/**
 * A file-name-safe time stamp, 'YYYY-MM-DD-HH-mm-ss' in UTC. NEVER use it
 * for a new file the learner sees: those are named in LOCAL time
 * (`localFileStamp`, `localBackupFileName`). It is still needed for two
 * things only:
 *   - the names the learner never sees: the storage ports' copies of
 *     corrupt data (kvStoragePort.ts, a kv key and a file inside the app);
 *   - READING the names that builds before wave 5b wrote: they were UTC
 *     stamps of this very form (`utcStampTimeOf`, `backupTimeOf`).
 *
 *   backupStamp(new Date(Date.UTC(2026, 9, 24, 7, 28, 30))) → '2026-10-24-07-28-30'
 */
export function backupStamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

/** Two digits: 7 → '07'. */
const two = (n: number): string => String(n).padStart(2, '0');

/**
 * A file-name-safe time stamp in the phone's LOCAL time (wave 5b L8):
 * 'YYYY-MM-DD-HH-mm-ss'. Every file the learner sees is named with it: the
 * backups (export, weekly, before a restore), the history files and the
 * rescue copy ("Save a copy of my data", rescueExport.ts).
 *
 * WHY local: the learner reads the name in the Files app or the share
 * sheet. A backup made at 09:28 in Berlin was called
 * 'maranki-backup-2026-10-24-07-28-30.json' (UTC), which looks like the
 * wrong time. Order is not a problem: the app sorts backups by the TIME it
 * reads back from the name (`stampTimeOf`), not by the text.
 *
 *   localFileStamp(new Date(2026, 9, 24, 9, 28, 30).getTime()) → '2026-10-24-09-28-30'
 */
export function localFileStamp(now: number): string {
  const d = new Date(now);
  const date = `${String(d.getFullYear()).padStart(4, '0')}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  return `${date}-${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
}

/** For example localBackupFileName('auto', now) → 'auto-2026-10-24-09-28-30.json' (local time). */
export function localBackupFileName(kind: BackupKind, now: number): string {
  return `${BACKUP_PREFIX[kind]}${localFileStamp(now)}.json`;
}

const STAMP_IN_NAME = /(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})\.(?:json|csv|zip)$/;

/**
 * The time written in a file name by `localFileStamp()`, as epoch ms, or
 * null. The stamp is read as LOCAL time.
 * Example: 'auto-2026-10-21-18-04-07.json' → new Date(2026, 9, 21, 18, 4, 7).
 * A stamp that is not a real local moment (month 13, or 02:30 on the night
 * the clocks jump forward) gives null; the caller then uses the file date.
 *
 * Files named before wave 5b have a UTC stamp. The name alone cannot say
 * which kind it is, so a backup FILE's time is `backupTimeOf`: it also
 * looks at the file's own date and reads an old name as UTC (wave 5c).
 */
export function stampTimeOf(name: string): number | null {
  const m = STAMP_IN_NAME.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const ms = new Date(y, mo - 1, d, h, mi, s).getTime();
  // The Date constructor quietly moves a bad date (month 13 → next year), so
  // check that the moment gives back the very same stamp.
  return Number.isFinite(ms) && localFileStamp(ms) === m[0].slice(0, 19) ? ms : null;
}

/**
 * The time written in a file name, read as UTC: how the builds before wave
 * 5b named their backups (`backupStamp`). Epoch ms, or null for a name with
 * no stamp or a stamp that is no real moment (month 13).
 *   utcStampTimeOf('auto-2026-10-21-07-28-30.json') → Date.UTC(2026, 9, 21, 7, 28, 30)
 */
export function utcStampTimeOf(name: string): number | null {
  const m = STAMP_IN_NAME.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  return Number.isFinite(ms) && backupStamp(new Date(ms)) === m[0].slice(0, 19) ? ms : null;
}

/* ------------------------------------------------------- app and state */

/**
 * Which build writes a backup: `{ variant, version }` for the envelope.
 * The variant is 'generic' until the German build variant exists (wave 5).
 */
export function appInfo(): { variant: string; version: string } {
  const config = Constants.expoConfig;
  const variant = config?.extra?.variant;
  return {
    variant: typeof variant === 'string' && variant !== '' ? variant : 'generic',
    version: typeof config?.version === 'string' ? config.version : 'unknown',
  };
}

/**
 * True when the state holds something worth a backup: a deck, a card or a
 * finished session. The blank first-run state (only the three built-in
 * collections) is not worth one — and an automatic backup of it would push a
 * real, older backup out of the newest 3.
 */
export function hasData(state: DataState): boolean {
  return state.decks.length > 0 || state.cards.length > 0 || state.sessions.length > 0;
}

/* ------------------------------------------------------ backup settings */

/** The two backup settings (named as in the v3 AppSettings, spec §3.4). */
export interface BackupSettings {
  /** "Automatic backups" switch. Default true. */
  autoBackup: boolean;
  /** When the last automatic backup was written, epoch ms. null = never. */
  lastAutoBackupAt: number | null;
}

/**
 * Read the backup settings from `state.settings`, with their defaults (moved
 * here from autoBackup.ts in wave 5, so the "Automatic backups" switch does
 * not load the storage module that the weekly backup needs).
 */
export function readBackupSettings(settings: AppSettings): BackupSettings {
  const raw = settings as AppSettings & { autoBackup?: unknown; lastAutoBackupAt?: unknown };
  const last = raw.lastAutoBackupAt;
  return {
    autoBackup: typeof raw.autoBackup === 'boolean' ? raw.autoBackup : true,
    lastAutoBackupAt: typeof last === 'number' && Number.isFinite(last) ? last : null,
  };
}

/**
 * A patch for `actions.updateAppSettings` that writes backup settings. The
 * cast is the ONE place where the wave-2 settings type is widened (see
 * autoBackup.ts); it goes away when types.ts becomes v3.
 */
export function backupSettingsPatch(patch: Partial<BackupSettings>): Partial<AppSettings> {
  return { ...patch } as Partial<AppSettings>;
}

/* ---------------------------------------------------------- disk + share */

/** The file and share calls this module needs. Tests pass a fake one. */
export interface BackupIO {
  /** Write a file to the cache folder (for sharing). Throws on failure. */
  writeCache(name: string, content: string): SavedFile;
  /** Delete the cache files whose name starts with `prefix` (old shared exports). Throws on failure. */
  clearCache(prefix: string): void;
  /** Write a file to Paths.document/backups/. Throws on failure. */
  writeDocument(name: string, content: string): SavedFile;
  /** Open the share sheet. Resolves false when sharing is not available. May reject. */
  share(uri: string, kind: ShareKind): Promise<boolean>;
  /** The files in Paths.document/backups/ (with `prefix`: only those). Throws on failure. */
  list(prefix?: string): BackupFileInfo[];
  /** Delete one file in Paths.document/backups/. Throws on failure. */
  remove(name: string): void;

  /*
   * Optional (W4-5): the review history and the images. Without them a
   * backup has no history and no images, and a restore writes none.
   */
  /**
   * Every review-history row, oldest first. Rejects when the history cannot
   * be read. (There is no "write" here on purpose: a restore hands its
   * history to `actions.restore`, which writes it in the replace-all's own
   * transaction — never in a second write after it, final review.)
   */
  readRevlog?(): Promise<RevlogRow[]>;
  /** The images of these decks as backup items, only when together they are at most `maxBytes`. */
  readMedia?(deckIds: readonly Id[], maxBytes: number): Promise<{ items: BackupMedia[]; tooBig: boolean }>;
  /** Write a backup's images (after the restore was saved). `failed` = the names not written. */
  writeMedia?(items: readonly BackupMedia[]): { written: number; failed: string[] };
  /** Write bytes (a zip) to the cache folder, for sharing. Throws on failure. */
  writeCacheBytes?(name: string, bytes: Uint8Array): SavedFile;
}

/** The real disk (expo-file-system) and share sheet (expo-sharing). */
export const deviceBackupIO: BackupIO = {
  writeCache: (name, content) => writeCacheFile(name, content),
  clearCache: (prefix) => {
    deleteCacheFiles(prefix);
  },
  writeDocument: (name, content) => writeDocumentFile(name, content),
  share: (uri, kind) => shareFile(uri, kind),
  list: (prefix) => listBackups(prefix),
  remove: (name) => deleteBackup(name),
  writeCacheBytes: (name, bytes) => writeCacheFile(name, bytes),
};

/**
 * The real disk WITH the review history and the images (W4-5): what the
 * Settings › Your data rows, the Erase sheet and the Restore flow use.
 * `revlog` is the app's history store (`appRevlogStore()` from
 * src/store/storage). It is passed in, so this file does not import the
 * storage module (the storage imports this file).
 *
 *   const io = fullBackupIO(appRevlogStore());
 *   await exportBackup(state, Date.now(), io, { images: state.settings.backupImages });
 */
export function fullBackupIO(revlog: RevlogStore, base: BackupIO = deviceBackupIO): BackupIO {
  return {
    ...base,
    readRevlog: () => revlog.all(),
    readMedia: async (deckIds, maxBytes) => {
      const found = await mediaForBackup(deckIds, maxBytes);
      return { items: found.items, tooBig: found.tooBig };
    },
    writeMedia: (items) => {
      const report = writeBackupMedia(items);
      return { written: report.written, failed: report.failed };
    },
  };
}

/** Images go into a backup only when together they are at most this big (spec §8.4: 50 MB). */
export const BACKUP_MEDIA_MAX_BYTES = 50 * 1024 * 1024;

/** The history and images of a backup, and whether the images were left out because they are too big. */
export interface BackupExtras {
  meta: Pick<BackupMeta, 'revlog' | 'media'>;
  imagesLeftOut: boolean;
}

/**
 * Collect what a backup carries besides the state (spec §8.4):
 *   - the review history, when `io` can read it (REJECTS when it cannot: a
 *     backup the user trusts must not quietly lose the history);
 *   - the images of every deck, when `images` is on and `io` can read them,
 *     only when together they are at most 50 MB (else `imagesLeftOut`).
 */
export async function backupExtras(
  state: DataState,
  io: BackupIO,
  opts: { images?: boolean } = {},
): Promise<BackupExtras> {
  const meta: BackupExtras['meta'] = {};
  if (io.readRevlog) meta.revlog = await io.readRevlog();
  let imagesLeftOut = false;
  if (opts.images === true && io.readMedia && state.decks.length > 0) {
    const found = await io.readMedia(
      state.decks.map((d) => d.id),
      BACKUP_MEDIA_MAX_BYTES,
    );
    if (found.tooBig) imagesLeftOut = true;
    else if (found.items.length > 0) meta.media = found.items;
  }
  return { meta, imagesLeftOut };
}

/** The two share-sheet problems, in words (also used by the backup rows' "Share"). */
export const SHARE_COPY = {
  /** `Sharing.isAvailableAsync()` said no. */
  unavailable: 'Sharing is not available on this phone.',
  /** The share sheet itself failed (for example a second tap while it opens). */
  failed: "We couldn't open the share sheet.",
} as const;

/** Why a file could not go through the share sheet. */
export type ShareProblem = 'unavailable' | 'share-failed';

/**
 * Why an export was kept on the phone instead of shared: a share-sheet
 * problem, or 'cache-failed' — the file for sharing could not be written to
 * the cache folder, so the share sheet was never tried.
 */
export type KeepReason = ShareProblem | 'cache-failed';

/**
 * What one export did:
 *   - shared — the file was written and the share sheet opened;
 *   - saved  — the file was kept in Paths.document/backups/ instead (spec
 *              §8.4), and `because` says why: sharing is not available here
 *              ('unavailable'), the share sheet failed ('share-failed'), or
 *              the cache copy for sharing could not be written
 *              ('cache-failed', the share sheet was never tried);
 *   - failed — no file could be written at all.
 */
export type ShareOutcome =
  | { kind: 'shared'; name: string }
  | { kind: 'saved'; name: string; because: KeepReason }
  | { kind: 'failed' };

/**
 * What "Export a backup" did: a ShareOutcome, plus two facts (W4-5):
 *   - `imagesLeftOut` — "Include images" is on, but the images are larger
 *     than 50 MB together, so the backup has none;
 *   - `{ kind: 'failed', because: 'history' }` — the review history could
 *     not be read, so NO backup was made (one without it would be a quiet loss).
 */
export type ExportOutcome =
  | (Extract<ShareOutcome, { kind: 'shared' | 'saved' }> & { imagesLeftOut?: true })
  | { kind: 'failed'; because?: 'history' };

/** Delete old shared files in the cache. A failure only leaves an old file behind, so it is ignored. */
function clearCacheQuietly(io: BackupIO, prefix: string): void {
  try {
    io.clearCache(prefix);
  } catch {
    // Ignored: an old cache file does no harm.
  }
}

/**
 * Write `content` to the cache folder and share it. When that is not possible,
 * keep it in Paths.document/backups/ instead, so the press still saves
 * something (the same order of tries as rescueExport.ts). Never rejects.
 *
 * The cache folder does not grow: the files whose name starts with
 * `cachePrefix` (older exports that were already shared) are deleted before
 * the new one is written, and the new cache file is deleted again when it was
 * not shared (then only the kept copy remains).
 */
export async function shareOrKeep(
  io: BackupIO,
  name: string,
  content: string,
  kind: ShareKind,
  cachePrefix: string,
): Promise<ShareOutcome> {
  clearCacheQuietly(io, cachePrefix);
  // Each reason is set where its failure happens, so the message never
  // blames the share sheet for a cache write that failed before it.
  let because: KeepReason = 'cache-failed';
  let file: SavedFile | null = null;
  try {
    file = io.writeCache(name, content);
  } catch {
    // The share sheet was never tried: `because` stays 'cache-failed'.
  }
  if (file !== null) {
    try {
      if (await io.share(file.uri, kind)) return { kind: 'shared', name };
      because = 'unavailable';
    } catch {
      because = 'share-failed';
    }
  }
  // Nothing will read the cache copy now.
  clearCacheQuietly(io, cachePrefix);
  try {
    io.writeDocument(name, content);
    refreshBackupList(io);
    return { kind: 'saved', name, because };
  } catch {
    return { kind: 'failed' };
  }
}

/* -------------------------------------------------------------- export */

/**
 * The backup file text of `state`, made now by this build. `extras` = the
 * review history and the images (`backupExtras`); without it the backup has
 * neither. Spec §8.4 leaves out only the IMAGES of the weekly automatic
 * backup ("an envelope (no media)"), never its history: autoBackup.ts passes
 * `{ revlog }`, so a restore of a weekly backup keeps the review history.
 */
export function backupText(state: DataState, now: number, extras?: BackupExtras['meta']): string {
  return encodeBackup(state, { exportedAt: now, app: appInfo(), ...extras });
}

/**
 * "Export a backup" (Settings › Your data): the whole state in one envelope,
 * with the review history and (when `opts.images` is on and they fit) the
 * images — `maranki-backup-<stamp>.json` in the cache folder, then the share
 * sheet with the title "Save your Maranki backup". Never rejects.
 */
export async function exportBackup(
  state: DataState,
  now: number,
  io: BackupIO = deviceBackupIO,
  opts: { images?: boolean } = {},
): Promise<ExportOutcome> {
  let extras: BackupExtras;
  try {
    extras = await backupExtras(state, io, opts);
  } catch {
    return { kind: 'failed', because: 'history' };
  }
  let text: string;
  try {
    text = backupText(state, now, extras.meta);
  } catch {
    return { kind: 'failed' };
  }
  const outcome = await shareOrKeep(io, localBackupFileName('export', now), text, SHARE_BACKUP, BACKUP_PREFIX.export);
  if (outcome.kind !== 'failed' && extras.imagesLeftOut) return { ...outcome, imagesLeftOut: true };
  return outcome;
}

/** "The backup is on this phone, and here is why it was not shared." */
function keptMessage(name: string, because: KeepReason): string {
  if (because === 'unavailable') return `Sharing is not available, so the backup was saved inside Maranki as ${name}.`;
  if (because === 'cache-failed') {
    return `We couldn't prepare the file for sharing, so the backup was saved inside Maranki as ${name}.`;
  }
  return `We couldn't open the share sheet, so the backup was saved inside Maranki as ${name}.`;
}

const WRITE_FAILED = "We couldn't write the backup. Your phone may be out of storage.";

/** The review history could not be read, so no backup was made. */
const HISTORY_READ_FAILED = "We couldn't read your review history, so no backup was made. Please try again.";

/** Said when "Include images" is on but the images are too big for a backup. */
export const IMAGES_LEFT_OUT = 'The backup has no images: together they are larger than 50 MB.';

/** The snackbar line after "Export a backup", or null when the share sheet was the whole answer. */
export function exportMessage(outcome: ShareOutcome | ExportOutcome): string | null {
  if (outcome.kind === 'failed') {
    return 'because' in outcome && outcome.because === 'history' ? HISTORY_READ_FAILED : WRITE_FAILED;
  }
  const imagesNote = 'imagesLeftOut' in outcome && outcome.imagesLeftOut === true ? IMAGES_LEFT_OUT : null;
  if (outcome.kind === 'shared') return imagesNote;
  const kept = keptMessage(outcome.name, outcome.because);
  return imagesNote ? `${kept} ${imagesNote}` : kept;
}

/**
 * What the Erase sheet's export did:
 *   - kept   — the backup is in Paths.document/backups/ (listed in Settings ›
 *              Your data as "Saved export"); `share` says whether the share
 *              sheet then opened ('opened'), was not available, or failed;
 *   - failed — the backup could not be written to the phone; nothing was shared.
 */
export type KeptExportOutcome =
  | { kind: 'kept'; name: string; share: 'opened' | ShareProblem }
  | { kind: 'failed'; because?: 'history' };

/**
 * The Erase sheet's "Export a backup first" (spec §7 row 13, §8.6). The
 * button then reads "Backup saved ✓", so that must be TRUE on this phone,
 * whatever the user does in the share sheet:
 *   1. the envelope is written to Paths.document/backups/maranki-backup-<stamp>.json
 *      (and the list in Settings › Your data is read again);
 *   2. only then is that same file shared, for a copy off the phone.
 * No cache file is needed: the share sheet can read the document folder.
 * Never rejects.
 */
export async function exportAndKeepBackup(
  state: DataState,
  now: number,
  io: BackupIO = deviceBackupIO,
  opts: { images?: boolean } = {},
): Promise<KeptExportOutcome> {
  // The erase deletes the review history too, so the backup must carry it.
  let extras: BackupExtras;
  try {
    extras = await backupExtras(state, io, opts);
  } catch {
    return { kind: 'failed', because: 'history' };
  }
  let file: SavedFile;
  try {
    file = io.writeDocument(localBackupFileName('export', now), backupText(state, now, extras.meta));
  } catch {
    return { kind: 'failed' };
  }
  refreshBackupList(io);
  try {
    const opened = await io.share(file.uri, SHARE_BACKUP);
    return { kind: 'kept', name: file.name, share: opened ? 'opened' : 'unavailable' };
  } catch {
    return { kind: 'kept', name: file.name, share: 'share-failed' };
  }
}

/** The line under the Erase sheet's export button. */
export function keptExportMessage(outcome: KeptExportOutcome): string {
  if (outcome.kind === 'failed') return outcome.because === 'history' ? HISTORY_READ_FAILED : WRITE_FAILED;
  if (outcome.share === 'opened') return 'A copy is also kept on this phone, in Settings › Your data.';
  return keptMessage(outcome.name, outcome.share);
}

/* ------------------------------------------------------------- restore */

/** Every fixed text of the Restore flow (spec §8.4, exact). */
export const RESTORE_COPY = {
  title: 'Restore this backup?',
  replaces: 'This replaces everything on this phone. We save a backup of your current data first.',
  hold: 'Hold to restore',
  cancel: 'Cancel',
  notBackup: 'This file is not a Maranki backup.',
  tooNew: 'This backup was made by a newer version of Maranki. Update the app first.',
  /** The file could not be opened or read at all. */
  unreadable: "We couldn't open this file. Nothing was changed.",
  /** migrate() threw: a bug, not a broken file (spec §3.1 rule 7). */
  migrateFailed: "We couldn't read this backup. Nothing was changed.",
  /** The safety copy of the current data could not be written, so nothing was restored. */
  copyFailed: "We couldn't save a copy of your current data, so nothing was restored.",
  /** `actions.restore` itself threw (a bug). */
  restoreFailed: 'Something went wrong during the restore. Please try again.',
  /**
   * The data was replaced in the app, but its save did NOT commit (W2
   * hardening leftover, W4-5): say that the RESTORE is not saved — not only
   * "your latest changes". The disk still holds the old data.
   *
   * It does NOT promise "Maranki will try to save it again" (review round 1):
   * the next save writes the restored decks, cards and review history again
   * (the row port keeps the history rows for that retry, final review), but
   * never the backup's images, because performRestore writes them only after
   * a save that worked. Only a new restore brings them back, so the line
   * asks for that. A new restore is safe: it reads the history table again,
   * and that table still holds the phone's history (or the restored one).
   */
  notSaved: 'The restore was not saved — your phone may be out of storage. Free some space, then restore the backup again.',
  /** Saved, but some review history or images of the backup could not be written. */
  incomplete: 'Some review history or images could not be restored.',
  /**
   * The confirm sheet's line for a backup WITHOUT review history (wave 5b
   * R2), for example a weekly backup written before wave 5. Such a restore
   * keeps the review history of this phone (`performRestore`).
   */
  keepsHistory: 'This backup has no review history, so your current review history is kept.',
} as const;

/** What a backup holds, for the confirm sheet and the "Restored" line. */
export interface RestoreSummary {
  /** When the backup was made (or the file date of an old export). null = unknown. */
  at: number | null;
  decks: number;
  cards: number;
  streak: number;
  /**
   * True when the backup has NO review history and the restore writes this
   * phone's history back (`historyToKeep`): the confirm sheet says so
   * (RESTORE_COPY.keepsHistory, wave 5b R2). Left out = nothing to say.
   */
  keepsHistory?: boolean;
}

/**
 * What a backup holds. `keptHistoryRows` (the Restore flow passes
 * `keptHistoryCount(…)`: the rows of this phone's history TABLE that the
 * restore writes back) sets `keepsHistory` when it is above 0.
 *
 *   restoreSummary(state, at, 1240).keepsHistory → true
 */
export function restoreSummary(state: DataState, at: number | null, keptHistoryRows = 0): RestoreSummary {
  const summary: RestoreSummary = { at, decks: state.decks.length, cards: state.cards.length, streak: state.person.streak };
  if (keptHistoryRows > 0) summary.keepsHistory = true;
  return summary;
}

/** The confirm sheet's line about the review history, or null when there is nothing to say (wave 5b R2). */
export function restoreHistoryNote(summary: RestoreSummary): string | null {
  return summary.keepsHistory === true ? RESTORE_COPY.keepsHistory : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A moment as "12 Oct 2026, 21:04" (local time, 24 h), like spec §8.4. */
export function formatBackupDate(ms: number): string {
  const d = new Date(ms);
  const hh = `${d.getHours()}`.padStart(2, '0');
  const mm = `${d.getMinutes()}`.padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;
}

/**
 * The confirm sheet's line: "From 12 Oct 2026, 21:04 · 3 decks · 1,240 cards ·
 * 12-day streak." Without a date the "From …" part is left out; without a
 * streak it says "no streak".
 */
export function restoreSummaryLine(s: RestoreSummary): string {
  const parts = [plural(s.decks, 'deck'), plural(s.cards, 'card')];
  parts.push(s.streak > 0 ? `${s.streak.toLocaleString('en-US')}-day streak` : 'no streak');
  if (s.at !== null) parts.unshift(`From ${formatBackupDate(s.at)}`);
  return `${parts.join(' · ')}.`;
}

/** The snackbar after a restore: "Restored — 3 decks, 1,240 cards." */
export function restoredMessage(s: RestoreSummary): string {
  return `Restored — ${plural(s.decks, 'deck')}, ${plural(s.cards, 'card')}.`;
}

/** `decodeBackup`'s result, plus 'error' when migrate() threw (a bug: nothing is restored). */
export type RestoreRead = DecodeResult<DataState> | { kind: 'error' };

/**
 * Read a backup file's text: decodeBackup() with the boot's migrate(). A
 * migrate() that throws becomes `{ kind: 'error' }`, never a crash and never
 * "not a backup" (spec §3.1 rule 7). `migrateFn` is only for tests.
 */
export function readBackup(text: string, now: number, migrateFn: MigrateFn<DataState> = migrate): RestoreRead {
  try {
    return decodeBackup(text, migrateFn, now);
  } catch {
    return { kind: 'error' };
  }
}

/** The snackbar line for a backup that cannot be restored, or null when it can. */
export function restoreProblem(read: RestoreRead): string | null {
  if (read.kind === 'invalid') return RESTORE_COPY.notBackup;
  if (read.kind === 'too-new') return RESTORE_COPY.tooNew;
  if (read.kind === 'error') return RESTORE_COPY.migrateFailed;
  return null;
}

/** How many copies made before a restore are ALWAYS kept (each one is a whole library). */
export const BEFORE_RESTORE_KEEP = 3;

/** A copy made before a restore is never deleted while it is younger than this (30 days). */
export const BEFORE_RESTORE_MIN_AGE_MS = 30 * DAY;

/**
 * The copies made before a restore that may be deleted now: a copy goes only
 * when it is BOTH beyond the newest BEFORE_RESTORE_KEEP (3) AND older than
 * BEFORE_RESTORE_MIN_AGE_MS (30 days).
 *
 * WHY the age rule (W2 hardening): a user who tries several backups to find
 * the right one makes one copy per try. With "keep the newest 3" only, the
 * 4th try deleted the FIRST copy — the only copy of the data from before the
 * first restore. The confirm sheet promises "We save a backup of your current
 * data first", so that way back must stay. Spec §8.4 asks for "keep the
 * newest 3" only for the weekly backups.
 *
 * A copy whose time is unknown, or "from the future" (the clock was wrong),
 * has no known age, so it is kept. The user can delete any copy by hand
 * (Settings › Your data, `deleteKeptBackup`).
 *
 * Example: 4 restores today → 4 copies, none deleted. Copies from 31, 32, 33
 * and 34 days ago plus a new one → the copies from 33 and 34 days ago go.
 */
export function beforeRestoreCopiesToDelete(files: readonly BackupFileInfo[], now: number): string[] {
  const byName = new Map(files.map((file) => [file.name, file]));
  return oldBackupsToDelete(files, BACKUP_PREFIX.beforeRestore, now, BEFORE_RESTORE_KEEP).filter((name) => {
    const file = byName.get(name);
    const at = file ? backupTimeOf(file) : null;
    return at !== null && !isFromTheFuture(at, now) && now - at >= BEFORE_RESTORE_MIN_AGE_MS;
  });
}

/**
 * Before a restore, keep the CURRENT data as
 * `Paths.document/backups/before-restore-<stamp>.json` (spec §8.4 step 5), so
 * a wrong restore can be undone from Settings › Your data.
 * Then old copies are deleted by `beforeRestoreCopiesToDelete` (beyond the
 * newest 3 AND older than 30 days), so many restores over months cannot fill
 * the phone, but a quick series of restores never loses the first copy. The
 * new copy is written FIRST; an old copy that cannot be deleted is simply kept.
 * Returns the file, or null when there is nothing to keep (an empty library).
 * THROWS when the copy cannot be written: then the caller must not restore.
 */
export function writeBeforeRestoreCopy(
  state: DataState,
  now: number,
  io: BackupIO = deviceBackupIO,
  revlog?: RevlogRow[],
): SavedFile | null {
  if (!hasData(state) && !(revlog && revlog.length > 0)) return null;
  const extras = revlog ? { revlog } : undefined;
  const file = io.writeDocument(localBackupFileName('beforeRestore', now), backupText(state, now, extras));
  try {
    const copies = io.list(BACKUP_PREFIX.beforeRestore);
    // The new copy counts as one of the kept ones (it may be missing from a
    // slow listing; its name may equal an old one written in the same second).
    const all = copies.some((f) => f.name === file.name)
      ? copies
      : [...copies, { name: file.name, uri: file.uri, size: 0, modifiedAt: now }];
    for (const name of beforeRestoreCopiesToDelete(all, now)) {
      if (name === file.name) continue;
      try {
        io.remove(name);
      } catch {
        // An old copy that cannot be deleted does no harm.
      }
    }
  } catch {
    // The folder could not be read: nothing is deleted; the new copy is written.
  }
  refreshBackupList(io);
  return file;
}

/**
 * What a restore did (`performRestore`):
 *   - restored       — the copy was kept (or there was nothing to keep), and
 *                      the data was replaced and saved;
 *   - copy-failed    — the safety copy could not be written: NOTHING was restored;
 *   - restore-failed — `restore` threw (a bug);
 *   - write-failed   — the data was replaced in the app, but the save failed:
 *                      `flush` did not resolve `{ ok: true }`. The disk
 *                      still holds the OLD data (with its history), and the
 *                      before-restore copy is kept. The next save writes the
 *                      restored state again (M15) with its history rows (the
 *                      port keeps them), but the backup's images are NOT
 *                      written then. So the message says the RESTORE was not
 *                      saved and asks for a new restore (W4-5);
 *   - restored-incomplete — saved, but some review-history rows of the
 *                      backup could not be used (`cleanRevlogRow`), or some
 *                      images could not be written (W4-5).
 */
export type RestoreResult = 'restored' | 'restored-incomplete' | 'copy-failed' | 'restore-failed' | 'write-failed';

/** What `performRestore` needs. The screen passes `actions.restore` and `actions.flush`. */
export interface RestoreSteps {
  /** The data on this phone now. It is kept as before-restore-<stamp>.json first. */
  current: DataState;
  /** The backup's state, already read with readBackup() (so already migrated). */
  next: DataState;
  now: number;
  /**
   * Replace everything with `next` (`actions.restore(state, history)`).
   * `history` = the review history the restored library gets
   * (`restoreHistoryRows`): the backup's rows, or this phone's kept rows.
   * It MUST be written in the replace-all's own transaction (the row port
   * does): a second write after it would leave the history table empty when
   * the app is killed in between, or when the replace-all fails and a later
   * save finishes it (final review).
   */
  restore: (state: DataState, history: readonly RevlogRow[]) => void;
  /**
   * Save now and say whether it worked: `actions.flush`, which resolves a
   * FlushResult (actions.ts). REQUIRED and strict (W2 hardening, review
   * round 1): only `{ ok: true }` counts as saved. `{ ok: false }`, a flush
   * that throws, and a flush that resolves nothing all give 'write-failed'.
   *
   * WHY strict: a wrapper that drops the answer, for example
   * `flush: async () => { await engine.flush(); }`, would otherwise turn a
   * failed replace-all into "Restored — …" again. Now it does not compile
   * (Promise<void> is not Promise<FlushResult>), and if a cast hides it, the
   * missing answer is still a failure. Pass the engine's flush as it is:
   * `flush: () => actions.flush()`.
   */
  flush: () => Promise<FlushResult>;
  /**
   * The backup's review history and images (`readBackup`'s `revlog` and
   * `media`), spec §8.4 step 5. Left out = none. The history goes to
   * `restore` (one transaction with the replace-all); the images are
   * written through `io.writeMedia` after the save committed. A backup
   * WITHOUT review history (no `extras`, or `revlog` is empty) keeps the
   * phone's current history (wave 5b R2, `historyToKeep`).
   */
  extras?: { revlog: readonly RevlogRow[]; media: readonly BackupMedia[] };
  io?: BackupIO;
}

/**
 * Spec §8.4 step 5, in its SAFE ORDER:
 *   1. write the before-restore copy of the current data, WITH the current
 *      review history when `io` can read it — if reading or writing fails,
 *      stop: `restore` is never called;
 *   2. `restore(next, history)` — replace everything, the review history
 *      too, in ONE transaction. `history` = the backup's review history,
 *      or — for a backup WITHOUT review history (a weekly backup written
 *      before wave 5, an old export) — the phone's CURRENT history
 *      (`historyToKeep`, wave 5b R2): a restore must never quietly delete
 *      the learner's review history, and the confirm sheet says so
 *      (RESTORE_COPY.keepsHistory). It is never a second write after the
 *      replace-all (final review): a kill between the two writes, or a
 *      failed replace-all that a later save finished, left the history
 *      table EMPTY;
 *   3. wait for `flush()`, so "Restored — …" is only said after the save,
 *      and ONLY when the save worked: anything but `{ ok: true }` gives
 *      'write-failed' (the engine's flush never rejects; it reports a failed
 *      replace-all as `{ ok: false }`);
 *   4. write the backup's images (`extras.media`), only now: they belong to
 *      the restored data.
 * Never rejects.
 *
 * Example (RestoreFlow.tsx, after the 1-second hold):
 *   const result = await performRestore({ current: state, next, now: Date.now(),
 *     restore: (s, history) => actions.restore(s, history), flush, extras, io });
 *   show(restoreResultMessage(result, summary));
 */
export async function performRestore(steps: RestoreSteps): Promise<RestoreResult> {
  const { current, next, now, restore, flush, extras, io = deviceBackupIO } = steps;
  let history: RevlogRow[] | undefined;
  try {
    // The restore's replace-all replaces the history table: the copy keeps the CURRENT history.
    history = io.readRevlog ? await io.readRevlog() : undefined;
    writeBeforeRestoreCopy(current, now, io, history);
  } catch {
    return 'copy-failed';
  }
  let complete: boolean;
  try {
    // The history of the restored library, written by the replace-all itself.
    const restored = restoreHistoryRows(history, next, extras);
    complete = restored.complete;
    restore(next, restored.rows);
  } catch {
    return 'restore-failed';
  }
  // `flush` is typed as always there and always answering. A JavaScript
  // caller or a cast can still break that, so the answer is read with `?.`
  // and checked for `ok === true`: a missing flush throws a TypeError (caught
  // below), and a missing answer (undefined) is not a save.
  let saved: FlushResult | undefined;
  try {
    saved = await flush();
  } catch {
    return 'write-failed';
  }
  if (saved?.ok !== true) return 'write-failed';
  const mediaWritten = writeRestoreMedia(io, extras);
  return complete && mediaWritten ? 'restored' : 'restored-incomplete';
}

/**
 * The review history a restore of `next` writes, in its replace-all's own
 * transaction (`RestoreSteps.restore`):
 *   - the backup HAS review history → its rows (`complete` is false when
 *     some of them cannot be written: no usable seq or card id);
 *   - else → this phone's rows that the restored log does not have already
 *     (`historyToKeep`, wave 5b R2).
 *
 *   restoreHistoryRows(phoneRows, state, { revlog: [r7, r8], media: [] }) → { rows: [r7, r8], complete: true }
 *   restoreHistoryRows(phoneRows, state, { revlog: [], media: [] })       → { rows: historyToKeep(…), complete: true }
 */
export function restoreHistoryRows(
  current: readonly RevlogRow[] | undefined,
  next: Pick<DataState, 'reviewLog'>,
  extras: RestoreSteps['extras'],
): { rows: RevlogRow[]; complete: boolean } {
  if (extras && extras.revlog.length > 0) {
    const rows: RevlogRow[] = [];
    for (const row of extras.revlog) {
      const clean = cleanRevlogRow(row);
      if (clean) rows.push(clean);
    }
    return { rows, complete: rows.length === extras.revlog.length };
  }
  return { rows: historyToKeep(current, next, extras), complete: true };
}

/**
 * The CURRENT review history that a restore writes back (wave 5b R2): every
 * review of this phone when the backup carries no review history, else none.
 *
 * The replace-all writes one row for each rating in the restored state's
 * own review log (the undo window, at most 400), in the same transaction as
 * these rows. So:
 *   - a phone row of the SAME review (same card, same time) is left out: the
 *     table has it already (a backup made on this phone);
 *   - every other phone row is kept. When its number (`seq`, the key of the
 *     table) is taken by ANOTHER rating of the restored log — a backup from
 *     another phone, or an old export whose log was numbered only by the
 *     migration — the kept rows get NEW numbers after the highest number of
 *     the restored log, in their old order. Writing them under their old
 *     numbers would replace the restored rows ('replace' mode), and leaving
 *     them out would lose this phone's reviews although the confirm sheet
 *     says "your current review history is kept". (New ratings then get
 *     higher numbers again: the engine asks the table for its highest seq.)
 *
 *   historyToKeep(rows 1–3, log [seq 2 = the same review as row 2], none) → rows 1, 3
 *   historyToKeep(rows 1–3, log [seq 2 = another review], none)           → rows 1, 2, 3 as seq 3, 4, 5
 *   historyToKeep(rows 1–5, state, backup with history)                    → []
 */
export function historyToKeep(
  current: readonly RevlogRow[] | undefined,
  next: Pick<DataState, 'reviewLog'>,
  extras: RestoreSteps['extras'],
): RevlogRow[] {
  if (!current || current.length === 0) return [];
  if (extras && extras.revlog.length > 0) return [];
  const restoredReviews = new Set<string>();
  const takenSeqs = new Set<number>();
  let top = 0;
  for (const entry of next.reviewLog) {
    restoredReviews.add(reviewKey(entry.cardId, entry.atMs));
    takenSeqs.add(entry.seq);
    if (Number.isFinite(entry.seq) && entry.seq > top) top = entry.seq;
  }
  const kept = current.filter((row) => !restoredReviews.has(reviewKey(row.cardId, row.atMs)));
  if (!kept.some((row) => takenSeqs.has(row.seq))) return kept;
  return [...kept].sort((a, b) => a.seq - b.seq).map((row, i) => ({ ...row, seq: top + 1 + i }));
}

/** One review, by what it is: the card and the moment it was rated. */
function reviewKey(cardId: unknown, atMs: unknown): string {
  return `${String(cardId)}|${String(atMs)}`;
}

/**
 * How many rows of the phone's review history a restore of `next` would
 * write back (`historyToKeep`), read from the history TABLE — the same rows
 * `performRestore` reads, not the state's undo window (wave 5b R2). The
 * confirm sheet says "your current review history is kept" only when this
 * is above 0. A table that cannot be read counts 0 (the restore itself then
 * stops at its safety copy, 'copy-failed'). Never rejects.
 *
 *   await keptHistoryCount(read.state, { revlog: read.revlog, media: read.media }, fullBackupIO(appRevlogStore()))
 */
export async function keptHistoryCount(
  next: Pick<DataState, 'reviewLog'>,
  extras: RestoreSteps['extras'],
  io: Pick<BackupIO, 'readRevlog'> = deviceBackupIO,
): Promise<number> {
  if (extras && extras.revlog.length > 0) return 0; // the backup's own history wins: nothing to read
  try {
    return io.readRevlog ? historyToKeep(await io.readRevlog(), next, extras).length : 0;
  } catch {
    return 0;
  }
}

/**
 * Step 5's last part: write the backup's images. Only after the restore's
 * save committed: they belong to the restored data. True when every image
 * was written (or there was none). Never throws.
 */
function writeRestoreMedia(io: BackupIO, extras: RestoreSteps['extras']): boolean {
  if (!extras || extras.media.length === 0) return true;
  try {
    const report = io.writeMedia ? io.writeMedia(extras.media) : null;
    return report !== null && report.failed.length === 0;
  } catch {
    return false;
  }
}

/** The snackbar line after `performRestore`. */
export function restoreResultMessage(result: RestoreResult, summary: RestoreSummary): string {
  if (result === 'copy-failed') return RESTORE_COPY.copyFailed;
  if (result === 'restore-failed') return RESTORE_COPY.restoreFailed;
  if (result === 'write-failed') return RESTORE_COPY.notSaved;
  if (result === 'restored-incomplete') return `${restoredMessage(summary)} ${RESTORE_COPY.incomplete}`;
  return restoredMessage(summary);
}

/* ------------------------------------------------------ study history */

/** The columns of the sessions CSV (spec §8.8, wave 2). */
export const SESSIONS_CSV_HEADER = [
  'date',
  'kind',
  'mode',
  'cards',
  'again',
  'hard',
  'good',
  'easy',
  'minutes',
  'xp',
] as const;

/**
 * The sessions CSV (spec §8.8): one row per finished session, oldest first.
 *   - date  = the study day (YYYY-MM-DD) the session counts for;
 *   - mode  = the study mode; empty for sessions saved before v3 (they do not
 *             store it);
 *   - minutes = empty: a session record does not store its length yet (the
 *             review history of wave 3 has the seconds per review).
 * Text cells are guarded against spreadsheet formulas (src/platform/csv.ts).
 */
export function sessionsCsv(sessions: readonly SessionRecord[]): string {
  const rows = [...sessions]
    .sort((a, b) => a.atMs - b.atMs)
    .map((s) => {
      const mode = (s as SessionRecord & { mode?: unknown }).mode;
      return [
        s.dayKey,
        s.kind,
        typeof mode === 'string' ? mode : '',
        s.total,
        s.counts?.again,
        s.counts?.hard,
        s.counts?.good,
        s.counts?.easy,
        '',
        s.xp,
      ];
    });
  return toCsv(SESSIONS_CSV_HEADER, rows, { guardFormulas: true });
}

/** The name prefix of the history file. */
export const HISTORY_PREFIX = 'maranki-history-';

/** For example 'maranki-history-2026-10-21-18-04-07.csv' (local time, `localFileStamp`). */
export function historyFileName(now: number): string {
  return `${HISTORY_PREFIX}${localFileStamp(now)}.csv`;
}

/**
 * The name of the history zip (spec §8.8): 'maranki-history-<stamp>.zip' in
 * local time (wave 5b L8). Both history exports use it: Progress ⤓
 * (progressLogic.ts) and Settings › Your data (`exportHistoryZip`).
 */
export function historyZipFileName(now: number): string {
  return `${HISTORY_PREFIX}${localFileStamp(now)}.zip`;
}

/**
 * What "Export study history" did:
 *   - shared       — the CSV was written to the cache and the share sheet opened;
 *   - unavailable  — sharing is not available on this phone;
 *   - share-failed — the share sheet failed to open;
 *   - failed       — the file could not be written.
 * The history is never kept inside the app: a CSV there could not be seen,
 * shared or opened, so a message that says "saved" would not be true.
 */
export type HistoryOutcome =
  | { kind: 'shared'; name: string }
  | { kind: 'unavailable' }
  | { kind: 'share-failed' }
  | { kind: 'failed' };

/**
 * "Export study history" (Progress ⤓): the sessions CSV, then the share sheet.
 * Resolves null without writing anything when there is no session yet.
 * Older history files in the cache are deleted first, and the new one is
 * deleted again when it could not be shared. Never rejects.
 */
export async function exportHistory(
  state: DataState,
  now: number,
  io: BackupIO = deviceBackupIO,
): Promise<HistoryOutcome | null> {
  if (state.sessions.length === 0) return null;
  let text: string;
  try {
    text = sessionsCsv(state.sessions);
  } catch {
    return { kind: 'failed' };
  }
  const name = historyFileName(now);
  clearCacheQuietly(io, HISTORY_PREFIX);
  let file: SavedFile;
  try {
    file = io.writeCache(name, text);
  } catch {
    return { kind: 'failed' };
  }
  let outcome: HistoryOutcome;
  try {
    if (await io.share(file.uri, SHARE_HISTORY_CSV)) return { kind: 'shared', name };
    outcome = { kind: 'unavailable' };
  } catch {
    outcome = { kind: 'share-failed' };
  }
  // Nobody will read the file now: delete it, so no hidden copy stays behind.
  clearCacheQuietly(io, HISTORY_PREFIX);
  return outcome;
}

/** The snackbar line after "Export study history" (null outcome = no sessions yet). */
export function historyMessage(outcome: HistoryOutcome | null): string | null {
  if (outcome === null) return 'No study history yet. Finish a session first.';
  if (outcome.kind === 'shared') return null;
  if (outcome.kind === 'unavailable') return SHARE_COPY.unavailable;
  if (outcome.kind === 'share-failed') return SHARE_COPY.failed;
  return "We couldn't write the history file. Your phone may be out of storage.";
}

/* ------------------------------------------- the two export rows */

/** The two exports of Settings › Your data: "Export a backup" and "Export study history (CSV)". */
export type ExportKind = 'backup' | 'history';

/** The line under each export row (spec §8.6), and the line while it runs. */
export const EXPORT_ROW_COPY = {
  backup: 'Everything: decks, cards, progress, settings.',
  history: 'Your sessions and every review, in one .zip',
  busy: 'Preparing…',
} as const;

/**
 * The line under one export row. "Preparing…" only under the export that
 * RUNS: the screen keeps which one runs (one guard for both, so two exports
 * never run together), and the other row keeps its own line.
 *
 *   exportRowSub('backup', 'history') → 'Everything: decks, cards, progress, settings.'
 *   exportRowSub('history', 'history') → 'Preparing…'
 */
export function exportRowSub(row: ExportKind, running: ExportKind | null): string {
  return running === row ? EXPORT_ROW_COPY.busy : EXPORT_ROW_COPY[row];
}

/**
 * The bytes of a state's history zip (src/store/history.ts builds them). The
 * maker gives no name: the file is always named `historyZipFileName(now)`,
 * in local time (wave 5b L8).
 */
export type HistoryZipMaker = (state: DataState, now: number) => Promise<{ bytes: Uint8Array }>;

/**
 * "Export study history" from wave 3 on (spec §8.8): the sessions CSV AND the
 * review CSV in ONE zip, then the share sheet. `makeZip` builds the zip
 * (history.ts `historyFiles` + `historyZip`; passed in, because history.ts
 * imports this file). The file is named `historyZipFileName(now)` (local
 * time). Resolves null without writing anything when there is no session
 * yet. The cache copy is deleted again when it was not shared. Never rejects.
 *
 *   await exportHistoryZip(state, Date.now(), async (s) => ({
 *     bytes: historyZip(await historyFiles(s)),
 *   }));
 */
export async function exportHistoryZip(
  state: DataState,
  now: number,
  makeZip: HistoryZipMaker,
  io: BackupIO = deviceBackupIO,
): Promise<HistoryOutcome | null> {
  if (state.sessions.length === 0) return null;
  if (!io.writeCacheBytes) return { kind: 'failed' };
  let bytes: Uint8Array;
  try {
    bytes = (await makeZip(state, now)).bytes;
  } catch {
    return { kind: 'failed' };
  }
  // The name the learner sees, in local time (see HistoryZipMaker).
  const name = historyZipFileName(now);
  clearCacheQuietly(io, HISTORY_PREFIX);
  let file: SavedFile;
  try {
    file = io.writeCacheBytes(name, bytes);
  } catch {
    return { kind: 'failed' };
  }
  let outcome: HistoryOutcome;
  try {
    if (await io.share(file.uri, SHARE_HISTORY_ZIP)) return { kind: 'shared', name };
    outcome = { kind: 'unavailable' };
  } catch {
    outcome = { kind: 'share-failed' };
  }
  clearCacheQuietly(io, HISTORY_PREFIX);
  return outcome;
}

/* ----------------------------------------------- backups on this phone */

/** The backup files the app lists (others in the folder, like pre-migration copies, are not listed). */
export type ListedKind = BackupKind;

/** How each kind of file is named in Settings › Your data. */
export const BACKUP_KIND_LABEL: Record<ListedKind, string> = {
  auto: 'Weekly backup',
  beforeRestore: 'Before a restore',
  export: 'Saved export',
};

/** One backup file in the list, newest first. */
export interface BackupEntry extends BackupFileInfo {
  kind: ListedKind;
  /** When it was made: the stamp in its name, else the file date. null = unknown. */
  at: number | null;
}

/**
 * A backup whose time is more than this far in the FUTURE was written while
 * the phone's clock was wrong. It is not trusted as "the newest", and it is
 * the first to be deleted.
 */
const FUTURE_SLACK_MS = DAY;

/** True when `at` lies in the future by more than a day (the clock was wrong when it was written). */
export function isFromTheFuture(at: number, now: number): boolean {
  return at - now > FUTURE_SLACK_MS;
}

/**
 * When a backup file was made: the stamp in its name, else the file date.
 * null = unknown. Every list, sort and rule of the backups uses this time
 * (Settings › Your data, the weekly backup, the old copies to delete).
 *
 * The stamp is read as LOCAL time (`stampTimeOf`): the names since wave 5b.
 * The builds before wave 5b named their files in UTC (wave 5c fix). Both
 * kinds look the same, so the FILE DATE decides: a backup is written in the
 * same second its name is made, so its file date is next to the right
 * reading. The UTC reading (`utcStampTimeOf`) is used when the file date is
 * nearer to it than half of the distance between the two readings. That
 * distance is the phone's offset from UTC (for example 2 hours in Berlin in
 * summer), and a write takes a second or two. In every other case the local
 * reading stays: no file date, a phone on UTC (both readings are the same),
 * or a file date far from both (the file was copied later). Example, a
 * phone in Berlin (UTC+2):
 *
 *   'auto-2026-10-21-07-28-30.json', file date 21 Oct 09:28:31 Berlin → 09:28:30 Berlin (an old UTC name)
 *   'auto-2026-10-21-09-28-30.json', file date 21 Oct 09:28:31 Berlin → 09:28:30 Berlin (a local name)
 *   'auto-2026-10-21-07-28-30.json', no file date                     → 07:28:30 Berlin (read as local)
 */
export function backupTimeOf(file: BackupFileInfo): number | null {
  const local = stampTimeOf(file.name);
  const written = file.modifiedAt;
  if (local !== null && written !== null) {
    const utc = utcStampTimeOf(file.name);
    if (utc !== null && Math.abs(written - utc) * 2 < Math.abs(utc - local)) return utc;
  }
  return local ?? written;
}

/**
 * The backups whose name starts with `prefix` that must be deleted so that
 * only the newest `keep` stay. Newest = latest time. A file with an unknown
 * time, or a time "from the future", counts as the OLDEST (so a wrong clock
 * can never keep a stale file and delete the real new ones). Files with
 * another prefix are never in the result.
 *
 * Example: oldBackupsToDelete(files, BACKUP_PREFIX.beforeRestore, now, 3)
 */
export function oldBackupsToDelete(
  files: readonly BackupFileInfo[],
  prefix: string,
  now: number,
  keep: number,
): string[] {
  const rank = (file: BackupFileInfo): number => {
    const at = backupTimeOf(file);
    return at === null || isFromTheFuture(at, now) ? -Infinity : at;
  };
  return files
    .filter((file) => file.name.startsWith(prefix))
    .sort((a, b) => rank(b) - rank(a) || b.name.localeCompare(a.name))
    .slice(keep)
    .map((file) => file.name);
}

/** The kind of a backup file, from its name prefix, or null for any other file. */
export function backupKindOf(name: string): ListedKind | null {
  for (const kind of Object.keys(BACKUP_PREFIX) as ListedKind[]) {
    if (name.startsWith(BACKUP_PREFIX[kind])) return kind;
  }
  return null;
}

/** A file size as "2.9 MB", "840 KB" or "512 B". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes) || 0)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The list of backups and whether reading the folder failed. */
export interface BackupList {
  files: BackupEntry[];
  failed: boolean;
}

/**
 * Read the backups folder (and the OLD v2.0.x exports in the root of the
 * document folder, which `listBackups` adds as 'export'): the listed kinds
 * only, newest first. Never throws.
 */
export function readBackupList(io: BackupIO = deviceBackupIO): BackupList {
  try {
    const files: BackupEntry[] = [];
    for (const info of io.list()) {
      const kind = backupKindOf(info.name);
      // The same time as every rule of the backups (an old UTC name is read as UTC, wave 5c).
      if (kind) files.push({ ...info, kind, at: backupTimeOf(info) });
    }
    files.sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || b.name.localeCompare(a.name));
    return { files, failed: false };
  } catch {
    return { files: [], failed: true };
  }
}

/*
 * A tiny "external store" for the list, so a screen can show it with React's
 * useSyncExternalStore: the list is read from disk once, kept here, and read
 * again only when this app writes or deletes a backup (refreshBackupList).
 * Screens never touch the disk while rendering.
 */
let listCache: BackupList | null = null;
const listListeners = new Set<() => void>();

/** The current list (read from disk the first time). The same object until a refresh. */
export function getBackupList(): BackupList {
  if (listCache === null) listCache = readBackupList();
  return listCache;
}

/** Read the folder again and tell every subscriber. Call it after writing or deleting a backup. */
export function refreshBackupList(io: BackupIO = deviceBackupIO): void {
  listCache = readBackupList(io);
  for (const listener of listListeners) listener();
}

/** Be told when the list changes. Returns the function that stops it. */
export function subscribeBackupList(listener: () => void): () => void {
  listListeners.add(listener);
  return () => {
    listListeners.delete(listener);
  };
}

/* ------------------------------------------- deleting a kept backup */

/**
 * The words of "Delete" on a backup row (Settings › Your data). The spec has
 * no exact copy for it; these follow the card editor's guarded delete.
 */
export const DELETE_BACKUP_COPY = {
  /** The row button's screen-reader label (the button shows a trash icon). */
  button: 'Delete this backup',
  title: 'Delete this backup?',
  confirm: 'Delete backup',
  cancel: 'Cancel',
  deleted: 'Backup deleted.',
  failed: "We couldn't delete this backup.",
} as const;

/**
 * How the confirm sheet's line starts, for each kind. A NOUN phrase (review
 * round 1): the row labels (BACKUP_KIND_LABEL) do not all work as the subject
 * of a sentence. "Before a restore from 10 Oct 2026 is removed" is hard to
 * read, and it sounds as if the restore came "from" that date.
 */
export const DELETE_BACKUP_SUBJECT: Record<ListedKind, string> = {
  auto: 'This weekly backup',
  beforeRestore: 'This copy made before a restore',
  export: 'This saved export',
};

/**
 * The confirm sheet's line, for example "This copy made before a restore
 * (10 Oct 2026, 08:12), 2.8 MB, is removed from this phone. This cannot be
 * undone." Without a known date: "This saved export, 512 B, is removed …".
 */
export function deleteBackupLine(entry: BackupEntry): string {
  const when = entry.at !== null ? ` (${formatBackupDate(entry.at)})` : '';
  return `${DELETE_BACKUP_SUBJECT[entry.kind]}${when}, ${formatBytes(entry.size)}, is removed from this phone. This cannot be undone.`;
}

/**
 * True when the user may delete this backup from the list (W2 hardening):
 * an export or a copy made before a restore, in Paths.document/backups/.
 *   - Weekly backups are not offered: the app keeps the newest 3 by itself.
 *   - An OLD export in the root of the document folder (`oldExport`, written
 *     by v2.0.x) is never deleted: it may be the only copy of data that was
 *     erased, and `deleteBackup` (files.ts) never touches that folder anyway.
 *
 * WHY: every "Export a backup first" on the Erase sheet, and every export
 * made when sharing is not available, adds a full-library file (3–10 MB for
 * a big library). Without a Delete, the only way to free that space was to
 * uninstall the app.
 */
export function canDeleteBackup(entry: BackupEntry): boolean {
  return (entry.kind === 'export' || entry.kind === 'beforeRestore') && entry.oldExport !== true;
}

/**
 * "Delete" on a backup row: delete the file from Paths.document/backups/ and
 * read the list again. Returns true when it was deleted; false when it may
 * not be deleted (`canDeleteBackup`) or the delete failed. Never throws.
 */
export function deleteKeptBackup(entry: BackupEntry, io: BackupIO = deviceBackupIO): boolean {
  if (!canDeleteBackup(entry)) return false;
  let deleted = true;
  try {
    io.remove(entry.name);
  } catch {
    deleted = false;
  }
  // Read the folder again either way: the list then shows what is really there.
  refreshBackupList(io);
  return deleted;
}
