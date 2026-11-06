/**
 * The side-effect half of an import that is not reading the file:
 *   - ApkgError + apkgErrorMessage — every way an .apkg can fail, with the
 *     words the user sees. The reader (import/apkgRead.ts `readApkg`) throws
 *     these; the import screen shows `apkgErrorMessage(err)`.
 *   - expoMediaDisk — writes an import's IMAGE files to the phone, AFTER the
 *     save commits (spec §5.8): `Paths.document/media/<deckId>/<name>`,
 *     through `<name>.tmp` and a move (an app kill never leaves half an
 *     image). It also reads what a folder holds, so the planner never puts a
 *     second picture under a name the folder has (importFile.ts
 *     `importMediaNamer`). The loop that decides what to write is pure
 *     (importFile.ts `writeImportImages`); this file is only the disk.
 *
 * Until wave 3 this file also read the .apkg (`parseApkg`) and mapped every
 * note to ONE flat v2 card. That lossy path is gone (unit W3-5): the lossless
 * reader is import/apkgRead.ts, the planner import/plan.ts.
 *
 * Why the disk is HERE and not in src/platform/media.ts: that file belongs to
 * unit W3-3, which is built in the same wave. So the import screen calls the
 * images through ONE helper (`writeImportImages` + this disk). When both
 * units are merged, this adapter can call media.ts instead, in one place.
 *
 * Only the legacy `collection.anki2` / `collection.anki21` (schema 11) format
 * is supported. Modern Anki's Zstd-compressed `collection.anki21b` (schema 18)
 * throws ApkgError 'newer-format', so the user can re-export with "Support
 * older Anki versions" on (spec §7 row 62).
 *
 * Wave 4 (unit W4-3) adds three PURE helpers the import screen needs, from
 * the emulator findings of wave 3:
 *   - pickedFileName — the real name of a picked file. On Android the
 *     system picker gives a `content://` URI whose last part is a document
 *     id ("msf:96"), and expo-file-system's `File.name` is that last part.
 *     The deck's `sourceKey` ('file:<name>') and the deck page line
 *     "Imported from German_Complete.apkg" need the real name.
 *   - guidHomeDeck — the deck that already holds the file's items (by Anki
 *     guid, spec §5.6), so a re-import updates that deck by default.
 *   - agreedLanguages / withDeckLanguages — the new deck's `language` and
 *     `meaningLanguage` from the card types' read-aloud languages ({{tts}}),
 *     when every card type of the import agrees.
 */
import { Directory, File, Paths } from 'expo-file-system';

import { fnv1a } from './hash';
import { chosenNotesByMid } from './import/plan';
import type { MediaFolderReader } from './importFile';
import { normalizeLang } from './lang/bcp47';
import type { AnkiCollection, DataStateV3, Deck, FieldDef, FieldRole, Id, ImportPlan } from './model';
import { cardLookupOf } from './scope';

export type ApkgErrorCode = 'newer-format' | 'no-collection' | 'empty' | 'corrupt';

export class ApkgError extends Error {
  code: ApkgErrorCode;
  constructor(code: ApkgErrorCode, message: string) {
    super(message);
    this.name = 'ApkgError';
    this.code = code;
  }
}

/** User-facing message for each failure mode. */
export function apkgErrorMessage(err: unknown): string {
  const code = err instanceof ApkgError ? err.code : 'corrupt';
  switch (code) {
    case 'newer-format':
      return "This .apkg uses Anki's newer format. In Anki, re-export with “Support older Anki versions” checked, then import that file.";
    case 'no-collection':
      return "That .apkg has no readable collection — it may be a media-only or damaged export.";
    case 'empty':
      return 'No cards found in that .apkg.';
    default:
      return 'Could not read that .apkg. Try re-exporting it from Anki.';
  }
}

/* ------------------------------------------------------------------ images */

/**
 * Where an import writes its image files. `folder` is a deck folder of the
 * plan ('media/<deckId>', relative to the app's document folder) and `name`
 * a plain file name. Both are checked by `writeImportImages` before they get
 * here. Both methods THROW on failure.
 */
export interface MediaDisk {
  /** Create the folder (and its parents) when it is missing. */
  ensureFolder(folder: string): void;
  /** Write (or replace) one file in the folder. */
  writeFile(folder: string, name: string, bytes: Uint8Array): void;
}

/** 'media/deck-1' → the Directory Paths.document/media/deck-1. */
function folderDirectory(folder: string): Directory {
  return new Directory(Paths.document, ...folder.split('/'));
}

/**
 * The phone's disk (expo-file-system, SDK 56 `Directory` / `File` API).
 *
 * `writeFile` writes `<name>.tmp` and then moves it over `<name>`, so the
 * final file is always whole (before, `create({ overwrite: true })` emptied
 * the old file first, and a kill during the write left a broken picture).
 * It may replace a file only with the SAME picture: the planner gives a
 * picture whose name is taken by another one its own name
 * (`importMediaNamer`), so a picture other cards show is never replaced.
 */
export function expoMediaDisk(): MediaDisk & MediaFolderReader {
  return {
    ensureFolder(folder) {
      folderDirectory(folder).create({ intermediates: true, idempotent: true });
    },
    writeFile(folder, name, bytes) {
      const dir = folderDirectory(folder);
      const tmp = new File(dir, `${name}.tmp`);
      try {
        tmp.create({ overwrite: true });
        tmp.write(bytes);
        tmp.moveSync(new File(dir, name), { overwrite: true });
      } catch (error) {
        try {
          if (tmp.exists) tmp.delete();
        } catch {
          // The write error below is the one that matters.
        }
        throw error;
      }
    },
    fileSize(folder, name) {
      const file = new File(folderDirectory(folder), name);
      return file.exists ? (file.size ?? 0) : null;
    },
    readFile(folder, name) {
      const file = new File(folderDirectory(folder), name);
      return file.exists ? file.bytesSync() : null;
    },
  };
}

/* ------------------------------------------------------------ file names */

/** A name that ends in a file extension ("German.apkg", "words.csv"). */
function hasExtension(name: string): boolean {
  return /\.[a-z0-9]{1,6}$/i.test(name);
}

/** decodeURIComponent that never throws (a broken % sequence keeps the text as it is). */
function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The file name inside a picker name or URI part. A document id can hold a
 * path ('primary:Download/German.apkg', 'raw:/storage/emulated/0/Download/x.csv');
 * a bare id ('msf:96', 'document:1234') holds no name.
 *
 *   nameIn('primary%3ADownload%2FGerman.apkg') → 'German.apkg'
 *   nameIn('msf:96')                           → null
 */
function nameIn(part: string): string | null {
  const decoded = safeDecode(part.trim());
  const afterSlash = decoded.slice(decoded.lastIndexOf('/') + 1);
  // 'primary:German.apkg' (no folder) → the part after the volume.
  const afterColon = afterSlash.slice(afterSlash.lastIndexOf(':') + 1).trim();
  if (afterColon !== '' && hasExtension(afterColon)) return afterColon;
  return null;
}

/**
 * The real name of a file from the system picker, or null when the picker
 * gave only a document id.
 *
 * Why: expo-file-system's `File.name` is the last part of the file's URI. On
 * iOS that is the real name. On Android it is often the content provider's
 * document id, for example "msf:96" (the Downloads provider). SDK 56 gives no
 * display name to JavaScript, so this reads what the URI holds:
 *
 *   pickedFileName({ name: 'German.apkg', uri: 'file:///…/German.apkg' })          → 'German.apkg'
 *   pickedFileName({ name: 'primary:Download/German.apkg', uri: 'content://…' })  → 'German.apkg'
 *   pickedFileName({ name: 'msf:96', uri: 'content://…/document/msf%3A96' })       → null
 */
export function pickedFileName(file: { name?: string | null; uri?: string | null }): string | null {
  const fromName = file.name ? nameIn(file.name) : null;
  if (fromName) return fromName;
  const uri = (file.uri ?? '').split(/[?#]/)[0];
  const last = uri.slice(uri.lastIndexOf('/') + 1);
  return last ? nameIn(last) : null;
}

/**
 * The name to use for a picked file when the picker gave no real name. An
 * .apkg is named after its root deck ("German.apkg"); a text file gets a
 * plain name (its deck name then comes from the file's deck column, or
 * "Imported deck"). It is a MADE-UP name: the import keys the deck with it
 * plus a hash of the content (`namelessSourceKey`), so a second import of
 * the same file finds its deck again. The deck page's header does not show
 * a made-up name as the file's name: for such a key it says "Imported"
 * (wave 5b L15). The imported items carry the nameless key without 'file:'
 * as their `source.ref`: the made-up name plus '#<hash>'
 * ("German.apkg#1x2b9k", importFile.ts `importOrigin`, since wave 5g), not
 * the made-up name alone. That ref ends in no file extension, so the deck
 * page never reads it as a real file name.
 *
 *   fallbackFileName('apkg', 'German') → 'German.apkg'
 *   fallbackFileName('csv', '')        → 'Imported deck.csv'
 */
export function fallbackFileName(kind: 'apkg' | 'csv', deckName: string): string {
  if (kind === 'csv') return 'Imported deck.csv';
  const base = deckName.replace(/[/\\\0:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Imported deck';
  return `${base}.apkg`;
}

/**
 * The deck `sourceKey` of a file the picker gave no name for. Such files get
 * made-up names (`fallbackFileName`: "Imported deck.csv", "Default.apkg"),
 * so the key adds a hash of the file's content (`text`: a CSV's first 4 KB,
 * or an .apkg's note guids): the same file finds its deck again, another
 * file does not (it would otherwise be imported into the first one by
 * default).
 *
 * The made-up name in the key is not shown as the file's name: the deck
 * page's header says just "Imported" for such a key (deckPageLogic.ts
 * `deckSourceLine` and `madeUpKeyName`, wave 5b L15), because the real file
 * name is not known. (Before wave 5b it said "Imported from a file".) A key
 * with a real name ('file:German_Complete.apkg') says "Imported from
 * German_Complete.apkg".
 *
 *   namelessSourceKey('Imported deck.csv', 'Word,Translation\n…') → 'file:Imported deck.csv#1x2b9k'
 */
export function namelessSourceKey(fileName: string, text: string): string {
  return `file:${fileName}#${fnv1a(text.slice(0, 4096)).toString(36)}`;
}

/* ------------------------------------------------------------ re-import target */

/**
 * The deck that already holds the items of this import (spec §5.6: the same
 * Anki `guid` means the same item), or null. When the items are in several
 * decks, the deck with the most of them wins (the others are "Already in
 * other decks" on the Preview). Only the chosen sections count.
 *
 * Why: before, a re-import found its deck only by `sourceKey` — and the
 * Android picker's "msf:96" names made a second import look like a new
 * file, so the Preview offered "New deck" with the same name. Now the
 * Preview starts on "Existing deck: German", and every item is an update.
 */
export function guidHomeDeck(
  collection: AnkiCollection,
  sections: ReadonlySet<string>,
  library: Pick<DataStateV3, 'notes' | 'cards' | 'decks'>,
): Id | null {
  const guids = new Set<string>();
  for (const notes of chosenNotesByMid(collection, sections).values()) {
    for (const n of notes) if (n.guid) guids.add(n.guid);
  }
  if (guids.size === 0) return null;
  const decks = new Set(library.decks.map((d) => d.id));
  const { cardById, cardIdsByNote } = cardLookupOf(library.cards);
  const counts = new Map<Id, number>();
  for (const note of library.notes) {
    if (!note.guid || !guids.has(note.guid)) continue;
    const firstId = cardIdsByNote.get(note.id)?.[0];
    const deckId = firstId ? cardById.get(firstId)?.deckId : undefined;
    if (deckId && decks.has(deckId)) counts.set(deckId, (counts.get(deckId) ?? 0) + 1);
  }
  let best: Id | null = null;
  let most = 0;
  for (const [deckId, n] of counts) {
    if (n > most) {
      best = deckId;
      most = n;
    }
  }
  return best;
}

/* ------------------------------------------------------------ deck languages */

/** The deck languages an import can set. */
export interface DeckLanguages {
  language?: string;
  meaningLanguage?: string;
}

/**
 * The deck's front and back languages from the import's card types (spec
 * §3.4 `Deck.language` / `meaningLanguage`): the read-aloud language of each
 * card type's FIRST field with the role — 'term' for the front, 'meaning' for
 * the back — but only when EVERY card type that has that role names the same
 * language. A card type without a language for it (no {{tts}}) means "no
 * agreement", so nothing is set: a German deck whose grammar questions are in
 * English never gets a German front language by accident.
 *
 *   agreedLanguages([{ fields: [Word (term, de_DE), Meaning (meaning, en_US)] }])
 *   → { language: 'de-DE', meaningLanguage: 'en-US' }
 */
export function agreedLanguages(types: readonly { fields: readonly Pick<FieldDef, 'role' | 'lang'>[] }[]): DeckLanguages {
  const side = (role: FieldRole): string | undefined => {
    const langs = new Set<string>();
    let missing = false;
    for (const t of types) {
      const field = t.fields.find((f) => f.role === role);
      if (!field) continue;
      const lang = field.lang ? normalizeLang(field.lang) : null;
      if (lang) langs.add(lang);
      else missing = true;
    }
    return langs.size === 1 && !missing ? [...langs][0] : undefined;
  };
  const out: DeckLanguages = {};
  const language = side('term');
  const meaningLanguage = side('meaning');
  if (language) out.language = language;
  if (meaningLanguage) out.meaningLanguage = meaningLanguage;
  return out;
}

/**
 * The plan with the agreed languages on its NEW deck (a language the deck
 * already has stays). The same plan object when nothing changes.
 */
export function withDeckLanguages(plan: ImportPlan, langs: DeckLanguages): ImportPlan {
  const deck = plan.deck;
  if (!deck) return plan;
  const patch = missingDeckLanguages(deck, langs);
  if (Object.keys(patch).length === 0) return plan;
  return { ...plan, deck: { ...deck, ...patch } };
}

/**
 * The languages a deck should get after an import into it: only the ones it
 * does not have yet. {} = nothing to change.
 */
export function missingDeckLanguages(deck: Pick<Deck, 'language' | 'meaningLanguage'>, langs: DeckLanguages): DeckLanguages {
  const out: DeckLanguages = {};
  if (langs.language && !deck.language) out.language = langs.language;
  if (langs.meaningLanguage && !deck.meaningLanguage) out.meaningLanguage = langs.meaningLanguage;
  return out;
}
