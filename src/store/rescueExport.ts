/**
 * "Save a copy of my data" / "Save a copy of the raw data" (spec W1-4, §3.10).
 *
 * Copies the RAW stored text — exactly the string on disk, not the app state in
 * memory — into a file and opens the share sheet. It is the escape hatch of the
 * ErrorScreen and the DataProblemScreen, so it must work when the rest of the
 * app does not:
 *   - it never uses the DataProvider (the root ErrorScreen has none),
 *   - it never parses or migrates the text (the text may be what is broken),
 *   - it never writes the live data (C1): it only reads it,
 *   - it never rejects: every failure becomes a RescueOutcome the screen shows.
 *
 * Where the text comes from (since W2-1): `readRaw()` of the app's live
 * StoragePort (`appStoragePort()`, storage/index.ts) — the kv-store on a
 * phone, with the old AsyncStorage copy before the first copy-forward; the
 * memory port on the web preview. The files are written with
 * src/platform/files.ts and shared with src/platform/share.ts.
 *
 * `rescueReportWith(io, now)` holds the decisions and is tested with a fake
 * `io` (problemCopy.test.ts, engine.integration.test.ts). `rescueExport()`
 * plugs in the real storage, disk and share sheet. Both screens show its
 * result with `rescueReportMessage`, so each one says WHY a copy was kept
 * inside the app (no share sheet, or a share that failed):
 *
 *   setMessage(rescueReportMessage(await rescueExport()));          // ErrorScreen
 *   setMessage(rescueReportMessage(await rescueExport(), 'read'));  // DataProblemScreen
 */
import { writeCacheFile, writeDocumentFile } from '../platform/files';
import { shareFile, type ShareKind } from '../platform/share';
import { localFileStamp } from './backup';
import { rescueMessage, type DataProblem, type RescueOutcome } from './problemCopy';
import { appStoragePort } from './storage';

/** Title of the Android share dialog. */
export const RESCUE_DIALOG_TITLE = 'Save a copy of your Maranki data';

/** How the raw copy is described to the share sheet. */
export const SHARE_RAW_DATA: ShareKind = {
  mimeType: 'application/json', // Android
  UTI: 'public.json', // iOS
  dialogTitle: RESCUE_DIALOG_TITLE, // Android
};

/** The input/output a rescue needs. Tests pass a fake one. */
export interface RescueIO {
  /**
   * The raw stored text. Resolves null when nothing could be read. MAY reject
   * when the read fails (→ 'read-failed'). The device IO uses the live port,
   * whose readRaw() never rejects: there, null can mean "nothing stored" OR
   * "the read failed" (see rescueReportMessage).
   */
  readRaw(): Promise<string | null>;
  /**
   * Write `text` to a new file named `name` and return its file:// URI.
   * 'cache' = the app's cache folder (for sharing; the OS may clear it later).
   * 'backups' = `Paths.document/backups/` (kept until the app is uninstalled).
   * Throws when the file cannot be written.
   */
  writeFile(place: 'cache' | 'backups', name: string, text: string): string;
  /**
   * Optional: true when this device can open a share sheet for a file. Leave
   * it out when `share` checks this itself (then `share` resolves false).
   */
  shareAvailable?(): Promise<boolean>;
  /**
   * Open the share sheet for the file at `uri`. Resolves `false` (and shares
   * nothing) when sharing is not available here; rejects when the share
   * sheet fails.
   */
  share(uri: string): Promise<void | boolean>;
}

/**
 * What one press did, with the reason when the copy was kept INSIDE the app
 * instead of shared ('saved'):
 *   - 'no-share-sheet' — sharing is not available on this device;
 *   - 'share-failed'   — sharing should work, but preparing the file or the
 *                        share sheet itself failed.
 */
export interface RescueReport {
  outcome: RescueOutcome;
  savedBecause?: 'no-share-sheet' | 'share-failed';
}

/**
 * File name of a rescue copy, e.g. "maranki-raw-data-2026-10-23-21-04-07.json",
 * in the phone's LOCAL time: the learner sees this name in the share sheet,
 * like the backups (wave 5b L8, backup.ts `localFileStamp`).
 */
export function rescueFileName(now: number): string {
  return `maranki-raw-data-${localFileStamp(now)}.json`;
}

/**
 * Copy the raw stored text to a file and share it.
 *
 * Order of tries:
 *   1. Read the raw text. A read failure or an empty store stops here.
 *   2. If sharing works: write the copy to the cache folder and open the share
 *      sheet → 'shared'.
 *   3. Else (or if step 2 failed): keep the copy in `backups/` inside the app
 *      → 'saved', so the user still gets a copy that survives (spec §8.4: "If
 *      Sharing.isAvailableAsync() is false, write to Paths.document/backups/
 *      and show the file name").
 */
export async function rescueReportWith(io: RescueIO, now: number): Promise<RescueReport> {
  let raw: string | null;
  try {
    raw = await io.readRaw();
  } catch {
    return { outcome: { kind: 'read-failed' } };
  }
  if (raw == null || raw === '') return { outcome: { kind: 'nothing' } };

  const fileName = rescueFileName(now);

  let canShare = true;
  if (io.shareAvailable) {
    try {
      canShare = await io.shareAvailable();
    } catch {
      canShare = false;
    }
  }
  let savedBecause: RescueReport['savedBecause'] = 'no-share-sheet';
  if (canShare) {
    try {
      const uri = io.writeFile('cache', fileName, raw);
      if ((await io.share(uri)) !== false) return { outcome: { kind: 'shared', fileName } };
      // false: this device cannot share after all → keep the copy in the app.
    } catch {
      // The cache write or the share sheet failed: keep the copy inside the
      // app instead, so the press still saves something.
      savedBecause = 'share-failed';
    }
  }

  try {
    io.writeFile('backups', fileName, raw);
    return { outcome: { kind: 'saved', fileName }, savedBecause };
  } catch {
    return { outcome: { kind: 'write-failed' } };
  }
}

/** `rescueReportWith` without the reason: the outcome only. */
export async function rescueExportWith(io: RescueIO, now: number): Promise<RescueOutcome> {
  return (await rescueReportWith(io, now)).outcome;
}

/**
 * The line for a 'nothing' outcome when we cannot know WHY no text came
 * back. It never says that no data exists: the cards may still be on the
 * phone (and a user who believes they are gone may uninstall the app).
 */
export const RESCUE_NOTHING_FOUND_LINE = "We couldn't find saved data to copy. Your cards were not changed.";

/**
 * The line to show under the buttons after a press, or null when the share
 * sheet itself was the answer. Like `rescueMessage` (problemCopy.ts), plus:
 *   - 'saved' after a FAILED share says so, instead of "Sharing is not available";
 *   - 'nothing' never says "there is no saved data". Both screens read through
 *     the live port, and its readRaw() resolves null for "nothing stored" AND
 *     for a read that FAILED, so the reason is unknown:
 *       - on the DataProblemScreen for a read failure (`problem === 'read'`)
 *         the read failure is the likely reason → the 'read-failed' line;
 *       - everywhere else (the crash screen, `problem` undefined; 'too-new'
 *         and 'migrate') → RESCUE_NOTHING_FOUND_LINE.
 */
export function rescueReportMessage(report: RescueReport, problem?: DataProblem): string | null {
  const { outcome } = report;
  if (outcome.kind === 'saved' && report.savedBecause === 'share-failed') {
    return `The share sheet did not open, so the copy was saved inside Maranki as ${outcome.fileName}.`;
  }
  if (outcome.kind === 'nothing') {
    return problem === 'read' ? rescueMessage({ kind: 'read-failed' }) : RESCUE_NOTHING_FOUND_LINE;
  }
  return rescueMessage(outcome);
}

/** The real storage (the live port), disk (platform/files.ts) and share sheet (platform/share.ts). */
const deviceIO: RescueIO = {
  readRaw: () => appStoragePort().readRaw(),
  writeFile: (place, name, text) => (place === 'cache' ? writeCacheFile(name, text) : writeDocumentFile(name, text)).uri,
  // shareFile() checks Sharing.isAvailableAsync() itself and resolves false.
  share: (uri) => shareFile(uri, SHARE_RAW_DATA),
};

/**
 * "Save a copy" on this device (both problem screens), with the reason for a
 * 'saved' result. Never rejects. Show it with `rescueReportMessage`.
 */
export function rescueExport(): Promise<RescueReport> {
  return rescueReportWith(deviceIO, Date.now());
}
