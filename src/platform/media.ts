/**
 * Imported images on the phone (spec §5.8, §8.4, unit W3-3), via
 * expo-file-system (the SDK 56 `File` / `Directory` / `Paths` API).
 *
 * Where they live: `Paths.document/media/<deckId>/<name>`, one folder per
 * deck (`mediaFolder(deckId)` in src/domain/import/mediaPlan.ts). The card
 * renderer shows them with expo-image from `mediaFileUri(deckId, name)`.
 *
 * WHEN they are written or deleted — always AFTER the save transaction
 * commits, so the files never point at data that is not saved:
 *   - import:          the images of the import, after `actions.flush()`
 *                      resolved `{ ok: true }` — `writeAfterSave(flush, write)`
 *                      runs the write only then (a failed save is tried
 *                      again first; it never writes for a save that did not
 *                      commit, so no folder is left that no saved deck owns);
 *   - delete a deck:   `deleteDeckMedia(deckId)` after the delete was saved;
 *   - duplicate deck:  `copyDeckMedia(fromId, toId)` after the copy was saved;
 *   - the engine:      DataContext gives it `deleteDeckMedia` and
 *                      `mergeDeckMedia` (engine.ts `DeckMedia`), and the
 *                      engine decides WHEN they run (deleteDeck,
 *                      duplicateDeck, and moveNotes with only the moved
 *                      cards' image names);
 *   - backup:          `mediaForBackup(deckIds, maxBytes)` reads them as
 *                      base64 for the envelope (≤ 50 MB, "Include images");
 *   - restore:         `writeBackupMedia(envelope.media)` after the restore
 *                      was saved (Restore flow step 5).
 *
 * SAFETY: a file name comes from a downloaded deck, so it is untrusted. A
 * name or a deck id that could leave its folder ("../x", "a/b", hidden
 * ".x") is never written (isSafeMediaName). Every file is written through
 * `<name>.tmp` and then moved, so an app kill never leaves half an image.
 *
 * The calls are synchronous where the SDK 56 API is synchronous. They never
 * throw for one bad file: each report lists what was written and what was
 * not, so one broken image never stops the others.
 */
import { Directory, File, Paths } from 'expo-file-system';

import {
  archiveNameIn,
  freeImageName,
  isImageName,
  isSafeMediaName,
  mediaFolder,
  sameBytes,
  type FolderProbe,
} from '../domain/import/mediaPlan';
import type { BackupEnvelope, Id, ImportMediaFolder } from '../domain/model';
import type { FlushResult } from '../store/actions';

/** The folder in Paths.document that holds every deck's images. */
export const MEDIA_ROOT = 'media';

/** One image inside a backup envelope. */
export type BackupMediaItem = NonNullable<BackupEnvelope['media']>[number];

/** What a write did. */
export interface MediaWriteReport {
  /** Files written. */
  written: number;
  /** Bytes written (decoded size). */
  bytes: number;
  /** Names the source had no bytes for. */
  missing: string[];
  /** Names that were unsafe or could not be written. */
  failed: string[];
}

const emptyReport = (): MediaWriteReport => ({ written: 0, bytes: 0, missing: [], failed: [] });

/** Throw when `deckId` cannot be a folder name. */
function assertSafeDeckId(deckId: Id): void {
  if (!isSafeMediaName(deckId)) throw new Error(`Unsafe deck id for a media folder: ${JSON.stringify(deckId)}`);
}

/** The images folder of one deck (it may not exist yet). Throws for an unsafe deck id. */
export function deckMediaDirectory(deckId: Id): Directory {
  assertSafeDeckId(deckId);
  return new Directory(Paths.document, MEDIA_ROOT, deckId);
}

/** The deck id of a plan folder 'media/<deckId>', or null when it is not one. */
export function deckIdOfFolder(deckFolder: string): Id | null {
  const prefix = `${MEDIA_ROOT}/`;
  if (!deckFolder.startsWith(prefix)) return null;
  const id = deckFolder.slice(prefix.length);
  return isSafeMediaName(id) && mediaFolder(id) === deckFolder ? id : null;
}

/** Make the folder of one deck (and `media/`). */
function ensureDeckDirectory(deckId: Id): Directory {
  const dir = deckMediaDirectory(deckId);
  dir.create({ idempotent: true, intermediates: true });
  return dir;
}

/** Write one file through `<name>.tmp`, so the final file is always complete. */
function writeFileAtomically(dir: Directory, name: string, content: string | Uint8Array, base64: boolean): void {
  const tmp = new File(dir, `${name}.tmp`);
  const target = new File(dir, name);
  try {
    tmp.create({ overwrite: true });
    if (base64) tmp.write(content as string, { encoding: 'base64' });
    else tmp.write(content);
    tmp.moveSync(target, { overwrite: true });
  } catch (error) {
    try {
      if (tmp.exists) tmp.delete();
    } catch {
      // The original error below is the one that matters.
    }
    throw error;
  }
}

/**
 * The file:// URI of one image of a deck, or null when the deck id or the
 * name is unsafe, or the file is not there (the renderer then shows the
 * field's text without the image).
 */
export function mediaFileUri(deckId: Id, name: string): string | null {
  if (!isSafeMediaName(deckId) || !isSafeMediaName(name)) return null;
  const file = new File(deckMediaDirectory(deckId), name);
  return file.exists ? file.uri : null;
}

/**
 * Write the image files of an import plan (spec §5.8), after the import was
 * saved. `bytesOf(name)` gives a file's bytes from the opened archive
 * (`AnkiCollection.mediaBytes`); null = the archive does not have it.
 */
export function writeImportMedia(
  folders: readonly ImportMediaFolder[],
  bytesOf: (name: string) => Uint8Array | null,
): MediaWriteReport {
  const report = emptyReport();
  for (const folder of folders) {
    const deckId = deckIdOfFolder(folder.deckFolder);
    if (deckId === null) {
      report.failed.push(...folder.files);
      continue;
    }
    let dir: Directory;
    try {
      dir = ensureDeckDirectory(deckId);
    } catch {
      report.failed.push(...folder.files);
      continue;
    }
    for (const name of folder.files) {
      if (!isSafeMediaName(name)) {
        report.failed.push(name);
        continue;
      }
      let bytes: Uint8Array | null;
      try {
        bytes = bytesOf(archiveNameIn(folder, name)); // a renamed file (its name was taken) by its archive name
      } catch {
        bytes = null;
      }
      if (!bytes) {
        report.missing.push(name);
        continue;
      }
      try {
        writeFileAtomically(dir, name, bytes, false);
        report.written += 1;
        report.bytes += bytes.length;
      } catch {
        report.failed.push(name);
      }
    }
  }
  return report;
}

/** What `writeAfterSave` did. */
export interface WriteAfterSave<T> {
  /** The LAST answer of flush(). `{ ok: true }` = the state that uses the files is on the disk. */
  saved: FlushResult;
  /** What `write()` returned, or null: it did not run, because the save did not commit. */
  written: T | null;
  /** How many times flush() was called (1 = the first save committed). */
  tries: number;
}

/** Waits `ms` milliseconds (the pause between two save tries). */
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Save first, then write files that belong to the saved state (spec §5.8:
 * images are written AFTER the save commits).
 *
 * `flush` is the engine's `actions.flush()`. It never rejects; it says
 * whether the newest state is on the disk (FlushResult). `write` runs ONLY
 * after `{ ok: true }`. Why: files written for a state that never reaches the
 * disk would sit in `media/<deckId>/` with no saved deck that owns them, so
 * the deck-delete clean-up could never remove them (W3-5 hardening).
 *   - `{ ok: false, reason: 'write' }` (the save failed, M15): flush() is
 *     called again — the controller saves the same state again — up to
 *     `tries` times in all (default 3), with a pause of `waitMs` (default
 *     500 ms) before each new try.
 *   - `{ ok: false, reason: 'blocked' }` (no write is allowed now, C1): not
 *     tried again, and nothing is written.
 * The caller shows `saved` and may offer to try again later (the import's
 * Done stage: "Copy images"). An error of `write` is passed on.
 *
 *   const { saved, written } = await writeAfterSave(actions.flush, () => writeImages());
 *   if (written === null) show('Images not copied yet, because saving failed.');
 */
export async function writeAfterSave<T>(
  flush: () => Promise<FlushResult>,
  write: () => T | Promise<T>,
  opts: { tries?: number; waitMs?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<WriteAfterSave<T>> {
  const tries = Math.max(1, Math.floor(opts.tries ?? 3));
  const wait = opts.wait ?? pause;
  let saved = await flush();
  let count = 1;
  while (!saved.ok && saved.reason === 'write' && count < tries) {
    await wait(opts.waitMs ?? 500);
    saved = await flush();
    count += 1;
  }
  if (!saved.ok) return { saved, written: null, tries: count };
  return { saved, written: await write(), tries: count };
}

/**
 * Delete the images folder of a deck (spec §5.8: after the deck delete was
 * saved). Returns true when a folder was there. Throws when it cannot be
 * deleted (the caller may try again later; the data is already saved).
 */
export function deleteDeckMedia(deckId: Id): boolean {
  if (!isSafeMediaName(deckId)) return false;
  const dir = deckMediaDirectory(deckId);
  if (!dir.exists) return false;
  dir.delete();
  return true;
}

/** The image files of one deck: name and size, by name. [] when the deck has none. */
export function listDeckMedia(deckId: Id): { name: string; size: number }[] {
  if (!isSafeMediaName(deckId)) return [];
  const dir = deckMediaDirectory(deckId);
  if (!dir.exists) return [];
  const out: { name: string; size: number }[] = [];
  for (const item of dir.list()) {
    if (!(item instanceof File)) continue;
    const name = item.name;
    // A `.tmp` file is a write that never finished.
    if (name.endsWith('.tmp') || !isSafeMediaName(name)) continue;
    out.push({ name, size: item.size ?? 0 });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Copy every image of a deck into another deck's folder (duplicateDeck,
 * after the copy was saved). Resolves the number of files copied. A file
 * that cannot be copied is skipped.
 */
export async function copyDeckMedia(fromDeckId: Id, toDeckId: Id): Promise<number> {
  const files = listDeckMedia(fromDeckId);
  if (files.length === 0) return 0;
  const from = deckMediaDirectory(fromDeckId);
  const to = ensureDeckDirectory(toDeckId);
  let copied = 0;
  for (const { name } of files) {
    try {
      await new File(from, name).copy(new File(to, name), { overwrite: true });
      copied += 1;
    } catch {
      // Skip it: the card shows its text without this image.
    }
  }
  return copied;
}

/**
 * Copy every image of a deck into another deck's folder, for the engine
 * (engine.ts `DeckMedia.copyDeckFolder`): duplicateDeck, and deleteDeck when
 * the cards move to another deck. It is stricter than copyDeckMedia, because
 * the engine REMOVES the `from` folder after a deck delete:
 *   - a file that `to` already has is NEVER overwritten (the cards of `to`
 *     show it). When it has the same bytes, it counts as copied;
 *   - it THROWS when not every image of `from` is now in `to` (a disk error,
 *     or a file of the same name with other bytes). The engine then keeps
 *     the `from` folder, because it is the only copy of those images.
 * A deck with no images copies nothing and does not throw.
 *
 * `names` (optional): copy ONLY these files ("Move to deck…" passes the
 * images that the moved cards show, engine.ts imagesToCopy). The same rules
 * apply to them; a name that `from` does not have is skipped (the card
 * shows its text without it). Without `names`, every file is copied.
 *
 * `renamed` (optional, from `moveImageNames`): the file `name` goes into
 * `to` as `renamed.get(name)`, because `to` has another picture under
 * `name` (the engine already pointed the moved notes at the new name). It
 * is ALSO copied under that name into `from`, so an Undo of the move (the
 * cards back in `from`) still finds it. Never overwrites either.
 *
 *   await mergeDeckMedia('d1', 'd2'); // d2 now has every image of d1, or it threw
 *   await mergeDeckMedia('d1', 'd2', ['map.png']); // only map.png
 *   await mergeDeckMedia('d1', 'd2', ['map.png'], new Map([['map.png', 'map-1a2b3c4d.png']]));
 */
export async function mergeDeckMedia(
  fromDeckId: Id,
  toDeckId: Id,
  names?: readonly string[],
  renamed?: ReadonlyMap<string, string>,
): Promise<void> {
  const wanted = names ? new Set(names) : null;
  const files = listDeckMedia(fromDeckId).filter((f) => !wanted || wanted.has(f.name));
  if (files.length === 0) return;
  const from = deckMediaDirectory(fromDeckId);
  const to = ensureDeckDirectory(toDeckId);
  const notCopied: string[] = [];
  /** Copy `source` to `target` unless it is there already with the same bytes; false = another file is there. */
  const place = async (source: File, target: File): Promise<boolean> => {
    if (target.exists) return sameBytes(source.bytesSync(), target.bytesSync());
    await source.copy(target);
    return true;
  };
  for (const { name } of files) {
    const as = renamed?.get(name);
    const newName = as !== undefined && isSafeMediaName(as) ? as : name;
    const source = new File(from, name);
    try {
      if (!(await place(source, new File(to, newName)))) {
        notCopied.push(name);
        continue;
      }
      // The moved notes name the new file: keep it in `from` too (an Undo of the move).
      if (newName !== name && !(await place(source, new File(from, newName)))) notCopied.push(name);
    } catch {
      notCopied.push(name);
    }
  }
  if (notCopied.length > 0) {
    throw new Error(`${notCopied.length} images of deck ${fromDeckId} are not in deck ${toDeckId}: ${notCopied.join(', ')}`);
  }
}

/** A deck folder as mediaPlan.ts `freeImageName` reads it. */
function folderProbe(dir: Directory): FolderProbe {
  return {
    size: (name) => {
      const file = new File(dir, name);
      return file.exists ? (file.size ?? 0) : null;
    },
    read: (name) => {
      try {
        return new File(dir, name).bytesSync();
      } catch {
        return null;
      }
    },
  };
}

/**
 * The names the images of deck `fromDeckId` must get in deck `toDeckId`'s
 * folder when cards move there ("Move to deck…", or a deck delete that keeps
 * or moves its cards; engine.ts `DeckMedia.imageNames`). Synchronous.
 *
 * Only files that `to` ALREADY holds under the same name with OTHER bytes
 * are in the answer: each gets a name of its own (mediaPlan.ts
 * `freeImageName`, "map-1a2b3c4d.png"), free (or holding the very same
 * picture) in BOTH folders. A card shows the picture of its own deck's
 * folder, so without a new name the moved card would show `to`'s picture.
 * `names` limits the files looked at (the images the moved cards show);
 * without it, every file of `from`.
 *
 *   moveImageNames('d1', 'd2', ['map.png'])
 *   → Map { 'map.png' → 'map-1a2b3c4d.png' }   (d2 has another map.png)
 *   → Map {}                                     (d2 has none, or the same one)
 */
export function moveImageNames(fromDeckId: Id, toDeckId: Id, names?: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!isSafeMediaName(fromDeckId) || !isSafeMediaName(toDeckId) || fromDeckId === toDeckId) return out;
  const wanted = names ? new Set(names) : null;
  const files = listDeckMedia(fromDeckId).filter((f) => !wanted || wanted.has(f.name));
  if (files.length === 0) return out;
  const from = deckMediaDirectory(fromDeckId);
  const to = deckMediaDirectory(toDeckId);
  if (!to.exists) return out;
  const probes = [folderProbe(to), folderProbe(from)];
  for (const { name } of files) {
    try {
      const target = new File(to, name);
      if (!target.exists) continue;
      const bytes = new File(from, name).bytesSync();
      if (sameBytes(bytes, target.bytesSync())) continue;
      out.set(name, freeImageName(name, bytes, probes));
    } catch {
      // Unreadable: no new name. The copy keeps the never-overwrite rule for it.
    }
  }
  return out;
}

/**
 * The images of `deckIds` as backup items (base64), only when their total
 * size is at most `maxBytes` (spec §8.4: images are included up to 50 MB).
 * Over the limit → `{ items: [], tooBig: true }`, so the backup is written
 * without images. Files that cannot be read are counted in `skipped`.
 */
export async function mediaForBackup(
  deckIds: readonly Id[],
  maxBytes: number,
): Promise<{ items: BackupMediaItem[]; bytes: number; skipped: number; tooBig: boolean }> {
  const found: { deckId: Id; name: string; size: number }[] = [];
  for (const deckId of deckIds) for (const f of listDeckMedia(deckId)) found.push({ deckId, ...f });
  const bytes = found.reduce((sum, f) => sum + f.size, 0);
  if (bytes > maxBytes) return { items: [], bytes, skipped: 0, tooBig: true };
  const items: BackupMediaItem[] = [];
  let skipped = 0;
  for (const f of found) {
    try {
      const base64 = await new File(deckMediaDirectory(f.deckId), f.name).base64();
      items.push({ deckId: f.deckId, name: f.name, base64 });
    } catch {
      skipped += 1;
    }
  }
  return { items, bytes, skipped, tooBig: false };
}

/**
 * Write the images of a restored backup (Restore flow step 5), after the
 * restore was saved. Unsafe deck ids or names are not written.
 */
export function writeBackupMedia(items: readonly BackupMediaItem[]): MediaWriteReport {
  const report = emptyReport();
  for (const item of items) {
    const { deckId, name, base64 } = item;
    if (!isSafeMediaName(deckId) || !isSafeMediaName(name) || !isImageName(name) || typeof base64 !== 'string') {
      report.failed.push(String(name));
      continue;
    }
    try {
      writeFileAtomically(ensureDeckDirectory(deckId), name, base64, true);
      report.written += 1;
      report.bytes += Math.floor((base64.length * 3) / 4);
    } catch {
      report.failed.push(name);
    }
  }
  return report;
}
