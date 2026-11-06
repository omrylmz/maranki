/**
 * The backup file format (spec §8.4) — PURE: no file system, no clock.
 *
 * A backup is one JSON text, the "envelope":
 *   { format: 'maranki-backup', version: 1, schemaVersion, exportedAt,
 *     app: { variant, version }, data: <the whole state>, revlog?, media? }
 * The type is `BackupEnvelope` in src/domain/model.ts.
 *
 * Reading a backup (`decodeBackup`) accepts two kinds of files:
 *   1. an envelope written by this module;
 *   2. an OLD export: the raw state JSON that src/store/backup.ts wrote before
 *      wave 2 (no envelope at all), from any build since v2.0.0.
 *
 * In both cases the state itself goes through `migrate()` — the SAME function
 * the app uses at boot — so every backup ever made restores, also v0 backups
 * with `word`/`tr` cards (spec §3.1 rule 5). `migrate` is passed in as an
 * argument ("injected"): this module never imports src/store/migrate.ts, so it
 * stays small and the tests can use a fake migrate.
 *
 * Example (restore flow, spec §8.4):
 *   const picked = await pickJsonFile();
 *   if (!picked) return;                               // the user cancelled
 *   const result = decodeBackup(picked.text, migrate, Date.now());
 *   if (result.kind === 'invalid') show('This file is not a Maranki backup.');
 *   if (result.kind === 'too-new') show('This backup was made by a newer version of Maranki. Update the app first.');
 *   if (result.kind === 'ok') confirmRestore(result.state, result.info);
 */
import type { BackupEnvelope, Id, ReviewBucket, RevlogRow } from '../domain/model';
import type { DataState, Rating } from '../domain/types';

/** The `format` value that marks an envelope. */
export const BACKUP_FORMAT = 'maranki-backup';

/** The envelope layout version this build writes and reads. */
export const BACKUP_VERSION = 1;

/** One imported image inside a backup. */
export type BackupMedia = NonNullable<BackupEnvelope['media']>[number];

/* ---------------------------------------------------------------- write */

/** Everything an envelope needs besides the state. */
export interface BackupMeta {
  /** When the backup is written, epoch ms. */
  exportedAt: number;
  /** Which build writes it, e.g. { variant: 'generic', version: '2.2.0' }. */
  app: { variant: string; version: string };
  /** The uncapped review history (from wave 3). Left out when not given. */
  revlog?: RevlogRow[];
  /** Imported images (only when "Include images" is on and they fit). Left out when not given. */
  media?: BackupMedia[];
}

/**
 * Build the envelope around a state. `schemaVersion` is copied from the
 * state, so the file says which data model it holds. Optional parts that are
 * not given are left out (no key holds `undefined`).
 */
export function makeBackupEnvelope<S extends { schemaVersion: number }>(
  data: S,
  meta: BackupMeta,
): BackupEnvelope<S> {
  const envelope: BackupEnvelope<S> = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    schemaVersion: data.schemaVersion,
    exportedAt: meta.exportedAt,
    app: { variant: meta.app.variant, version: meta.app.version },
    data,
  };
  if (meta.revlog) envelope.revlog = meta.revlog;
  if (meta.media) envelope.media = meta.media;
  return envelope;
}

/** The backup file text (compact JSON: a big library is several MB). */
export function encodeBackup<S extends { schemaVersion: number }>(data: S, meta: BackupMeta): string {
  return JSON.stringify(makeBackupEnvelope(data, meta));
}

/* ----------------------------------------------------------------- read */

/**
 * What `migrate(doc, now)` returns (spec §3.2). Written out here so this module
 * does not import src/store/migrate.ts; its `MigrateOutcome` fits this type.
 */
export type MigrateResult<S> =
  | { kind: 'ok'; state: S; from: number; repaired: string[] }
  | { kind: 'too-new'; version: number }
  | { kind: 'invalid' };

/** The migrate function the caller passes in (the real one: `migrate` from src/store/migrate.ts). */
export type MigrateFn<S> = (doc: unknown, now: number) => MigrateResult<S>;

/** Facts about the backup file itself, for the restore confirmation ("From 12 Oct 2026, 21:04"). */
export interface BackupInfo {
  /** 'envelope' = written by this module; 'raw' = an old export (state JSON only). */
  format: 'envelope' | 'raw';
  /** When it was exported. null for an old export (it has no date; use the file date). */
  exportedAt: number | null;
  /** The build that wrote it. null when unknown. */
  app: { variant: string; version: string } | null;
  /** The envelope's `schemaVersion`. null for an old export. */
  schemaVersion: number | null;
}

export type DecodeResult<S = DataState> =
  | {
      kind: 'ok';
      /** The migrated state, ready for `actions.restore(state)`. */
      state: S;
      /** The schema version the data had before migration. */
      from: number;
      /** What `migrate` repaired (for a log line; never shown as an error). */
      repaired: string[];
      info: BackupInfo;
      /** Review-history rows to write after the restore. [] when the backup has none. */
      revlog: RevlogRow[];
      /** Images to write after the restore. [] when the backup has none. */
      media: BackupMedia[];
      /** Rows / images left out because they were broken or unsafe (see `decodeBackup`). */
      skipped: { revlog: number; media: number };
    }
  /**
   * Made by a newer Maranki. Nothing may be restored ("Update the app first").
   * `version` = the schema version that is too new (for a newer envelope
   * layout without a schemaVersion: the envelope version).
   */
  | { kind: 'too-new'; version: number }
  /** Not JSON, or not a Maranki backup ("This file is not a Maranki backup."). */
  | { kind: 'invalid' };

/**
 * Read a backup file's text.
 *
 * Steps:
 *   1. Not JSON (or empty) → `invalid`. A UTF-8 BOM at the start is allowed.
 *   2. JSON that is not an object (a number, a list, null …) → `invalid`.
 *   3. An envelope (`format === 'maranki-backup'`):
 *        - `version` above BACKUP_VERSION → `too-new`: a newer app wrote a
 *          layout this build may misread, so it is never guessed (spec §3.1 rule 6);
 *        - a broken envelope (no version, `data` is not an object) → `invalid`;
 *        - else `migrate(data, now)`.
 *      Anything else is an old raw export → `migrate(document, now)`.
 *   4. migrate's `too-new` and `invalid` are returned as they are.
 *
 * `migrate` is called at most once. If it THROWS, the error is not caught
 * here: a throw is a bug, not a broken file (spec §3.1 rule 7), and nothing
 * was changed yet, so the caller shows its own error.
 *
 * Safety: review-history rows with a wrong shape, and images whose deck id or
 * file name could leave the media folder (for example "../../x"), are left out
 * and counted in `skipped`. The state itself is never filtered here — that is
 * migrate's job ("repair, never drop").
 */
export function decodeBackup<S = DataState>(text: string, migrate: MigrateFn<S>, now: number): DecodeResult<S> {
  const doc = parseJson(text);
  if (!isPlainObject(doc)) return { kind: 'invalid' };

  if (doc.format !== BACKUP_FORMAT) {
    // An old export: the whole document IS the state.
    const raw: BackupInfo = { format: 'raw', exportedAt: null, app: null, schemaVersion: null };
    return withMigrated(migrate(doc, now), raw, [], []);
  }

  const version = doc.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return { kind: 'invalid' };
  const schemaVersion = finiteOrNull(doc.schemaVersion);
  if (version > BACKUP_VERSION) return { kind: 'too-new', version: schemaVersion ?? version };
  if (!isPlainObject(doc.data)) return { kind: 'invalid' };

  const info: BackupInfo = {
    format: 'envelope',
    exportedAt: finiteOrNull(doc.exportedAt),
    app: readApp(doc.app),
    schemaVersion,
  };
  return withMigrated(migrate(doc.data, now), info, asList(doc.revlog), asList(doc.media));
}

/** Combine migrate's answer with the file's other parts. */
function withMigrated<S>(
  outcome: MigrateResult<S>,
  info: BackupInfo,
  revlogIn: unknown[],
  mediaIn: unknown[],
): DecodeResult<S> {
  if (outcome.kind !== 'ok') return outcome;
  const revlog: RevlogRow[] = [];
  for (const row of revlogIn) {
    const read = readRevlogRow(row);
    if (read) revlog.push(read);
  }
  const media = mediaIn.filter(isSafeMedia);
  return {
    kind: 'ok',
    state: outcome.state,
    from: outcome.from,
    repaired: outcome.repaired,
    info,
    revlog,
    media,
    skipped: { revlog: revlogIn.length - revlog.length, media: mediaIn.length - media.length },
  };
}

/* ------------------------------------------------------------ file names */

/**
 * The name prefix of each kind of backup file (spec §8.4).
 *
 * The whole NAME is made in src/store/backup.ts, in the phone's LOCAL time
 * (`localBackupFileName`, `localFileStamp`, wave 5b L8):
 *
 *   localBackupFileName('auto', now) → 'auto-2026-10-24-09-28-30.json'   (09:28:30 on the phone)
 *
 * Do NOT add a UTC time stamp for a file name here again (wave 5d, L8).
 * This module had one (`fileStamp`, an ISO time in UTC), and every name it made
 * looked like the wrong time to the learner (09:28 in Berlin was named
 * 07-28). The names do not need UTC to sort: the app sorts backups by the
 * TIME it reads back from the name (backup.ts `stampTimeOf`, `backupTimeOf`).
 * UTC is only READ, for the names that builds before wave 5b wrote
 * (backup.ts `utcStampTimeOf`).
 */
export const BACKUP_PREFIX = {
  /** "Export a backup": written to the cache folder, then shared. */
  export: 'maranki-backup-',
  /** The weekly automatic backup in Paths.document/backups/. */
  auto: 'auto-',
  /** The copy of the current data made right before a restore. */
  beforeRestore: 'before-restore-',
} as const;

export type BackupKind = keyof typeof BACKUP_PREFIX;

/**
 * True when `name` is ONE plain file or folder name: not empty, at most 255
 * characters, no '/' or '\', no NUL character, and not '.' or '..'. Such a
 * name can never point outside the folder it is joined to ("path traversal").
 */
export function isSafeFileName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 255 &&
    name !== '.' &&
    name !== '..' &&
    !/[/\\\0]/.test(name)
  );
}

/* --------------------------------------------------------------- helpers */

/** JSON.parse that returns undefined instead of throwing. Removes a leading BOM. */
function parseJson(text: string): unknown {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readApp(value: unknown): BackupInfo['app'] {
  if (!isPlainObject(value)) return null;
  const { variant, version } = value;
  return typeof variant === 'string' && typeof version === 'string' ? { variant, version } : null;
}

const RATINGS: readonly Rating[] = ['again', 'hard', 'good', 'easy'];
const BUCKETS: readonly ReviewBucket[] = ['new', 'review', 'check'];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isId(value: unknown): value is Id {
  return typeof value === 'string' && value.length > 0;
}

/**
 * One review-history row, or null when it cannot be written to the revlog
 * table. Every column is NOT NULL except duration_ms (spec §3.8), so a
 * missing `durationMs` becomes null ("unknown"). The result is a NEW object
 * with only the RevlogRow keys.
 */
function readRevlogRow(value: unknown): RevlogRow | null {
  if (!isPlainObject(value)) return null;
  const { seq, cardId, deckId, atMs, rating, bucket, ivlBefore, ivlAfter, easeAfter } = value;
  const durationMs = value.durationMs ?? null;
  const ok =
    isFiniteNumber(seq) &&
    Number.isInteger(seq) &&
    isId(cardId) &&
    isId(deckId) &&
    isFiniteNumber(atMs) &&
    RATINGS.includes(rating as Rating) &&
    BUCKETS.includes(bucket as ReviewBucket) &&
    isFiniteNumber(ivlBefore) &&
    isFiniteNumber(ivlAfter) &&
    isFiniteNumber(easeAfter) &&
    (durationMs === null || isFiniteNumber(durationMs));
  if (!ok) return null;
  return {
    seq,
    cardId,
    deckId,
    atMs,
    rating: rating as Rating,
    bucket: bucket as ReviewBucket,
    ivlBefore,
    ivlAfter,
    easeAfter,
    durationMs,
  };
}

/** An image whose deck id and name are plain names, with base64 text. */
function isSafeMedia(value: unknown): value is BackupMedia {
  if (!isPlainObject(value)) return false;
  return isSafeFileName(value.deckId) && isSafeFileName(value.name) && typeof value.base64 === 'string';
}
