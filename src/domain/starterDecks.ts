/**
 * Starter decks (spec §5.10, §9.4, unit W3-8): the `.apkg` files a content
 * pack ships inside the app. They go through the SAME import pipeline as a
 * file the user picks, so a starter deck keeps every field, both directions,
 * the sections, the filters and the images:
 *
 *   bundled .apkg ─ loadStarterBytes (expo-asset → expo-file-system `File`, read once)
 *                 ─ readApkg          (import/apkgRead.ts: unzip + SQLite → collectionFromRows)
 *                 ─ suggestMapping    (roles.ts, with the pack's card-type presets)
 *                 ─ planImport        (import/plan.ts)
 *                 ─ applyImport       (the store: one reducer step, one save)
 *                 ─ flush             (the save commits)
 *                 ─ writeMedia        (the images, after the commit, §5.8)
 *
 * IDEMPOTENT. The deck made from a starter deck gets
 * `sourceKey = 'pack:<pack id>:<key>'` (`starterSourceKey`). Adding it again
 * targets THAT deck, and the planner matches every note by its Anki `guid`
 * (§5.6 rule 2): fields and tags are updated, every card keeps its progress,
 * nothing is added twice. So:
 *   - add, then add again           → no new deck, every note matched → 'upToDate' ("Already up to date.");
 *   - a newer bundled file          → notes whose field VALUES or tags changed are updated, new notes
 *     (pack `version` bump)           are added to the same deck, progress stays → 'update';
 *   - the deck was deleted with     → its notes are gone, so it is added again as a new deck → 'add';
 *     its cards ('delete')
 *   - the deck was deleted, but its → there is no starter deck, but every note is still in the library
 *     cards were kept ('keep' →       (§5.6 rule 3, "Update them where they are"), so no deck is made
 *     "Unfiled cards", or 'move')     → 'elsewhere'. The answer names the decks that hold the notes
 *                                     (`elsewhereDecks`), so the screen can say where the cards are.
 *                                     "Add as a new deck" is the same add with `elsewhere: 'copy'`;
 *   - the deck was renamed or moved → still found: the match is the sourceKey, never the name.
 *
 * A NEWER FILE WITH OTHER FIELDS. When the card type of a newer file has new
 * fields (the German vocabulary deck version 2 added `Type` and `Plural`,
 * §9.6), lost fields (version 3 removed `MarankiExample`: its sentence is one
 * of the Examples now) or more directions than the card type in the library,
 * the planner UPGRADES that card type (plan.ts `upgradeNoteType`): it keeps
 * its id and its own field settings, it gets the new fields, it loses the
 * lost ones, and every note of it gets the new values. So the deck keeps ONE
 * card type, and the add is an 'update', never "Already up to date." (before,
 * the new fields were dropped and only the new notes got a second card type).
 * No text is lost: a lost field stays (last, on no side of the card) while a
 * note the file does not update — a retired note, the learner's own card —
 * still has text in it.
 *
 * NOTES THAT A NEWER FILE MOVED to another subdeck (the German vocabulary
 * update moved 62 words to another level, for example B1 → A2) move to that
 * section (`ImportChoices.followSections`): after an update every note has
 * the section a fresh add of the file gives, so the Section and Level filters
 * still agree. Its cards stay in the deck, with their progress.
 *
 * NOTES THAT A NEWER FILE DROPPED (`retiredNotesOf`). A note of the starter
 * deck that came from this starter file (`source.ref` 'pack:<pack>:<key>@…')
 * and whose Anki guid is not in the newer file any more (the German
 * vocabulary update dropped 245 duplicates and broken entries) is RETIRED:
 * it stays, with its cards and their progress, but every card is suspended
 * and the note gets the tag RETIRED_TAG ("not in new version" in the Tags
 * filter). So it leaves the study queue, and the learner can find it to
 * delete it or to unsuspend it. Rules:
 *   - once: a note that has the tag is never retired again, so a learner who
 *     unsuspends it keeps studying it;
 *   - only the starter deck itself, and only notes with the file's own Anki
 *     guid: never the learner's own cards in the deck, never copies made by
 *     "Add as a new deck" (their guid is 'm-…', no file has it), never notes
 *     in other decks;
 *   - a note that a later file brings back is updated like any other (its
 *     tags become the file's tags again); its cards stay suspended until the
 *     learner unsuspends them.
 * A file picked on the import screen never retires anything: there the
 * learner chooses sections, so a note that is not imported was not dropped.
 *
 * Images (§5.8). The plan lists the image files per deck folder. After the
 * save commits, `addStarterDeck` gives them to `deps.writeMedia`, with a
 * reader that unpacks one file at a time from the bundled archive. A plan
 * that changes nothing still gives them (after a save), so an image that is
 * missing on the disk comes back with one more "Add". When the save fails,
 * no image is written: the files would belong to a state that is not on the
 * disk. `writeStarterImages` is the retry of the images alone (after
 * 'skipped' or 'failed'), for a row that already says "Added ✓".
 *
 * "Where do you start?" is given by VALUE (`StarterPlacement`, e.g. 'B1'),
 * never by an index into one plan's values: `starterPlacementRank` finds the
 * value in THIS deck's own levels (a deck without A1 still works).
 *
 * Signatures vs spec §10 W3-8 / §5.10:
 *   - `planStarterDeck(pack, key, state, bytes)` works as the spec writes it;
 *     `ctx` (time + ids) and `opts` are optional extra parameters;
 *   - `addStarterDeck(pack, key, deps, opts?, rule?)`: the spec's
 *     `addStarterDeck(pack, key)` plus `deps` (the store's getState /
 *     applyImport / flush and the image writer), because this module does
 *     not import the engine (the screen passes `useData().actions`), and the
 *     caller's optional arrival rule (wave 5c).
 *
 * Two layers, so the logic is tested without a phone:
 *   - `planStarterDeckFrom` — PURE: (pack, key, library, collection, ctx) → plan.
 *     `planStarterDeck` is the same from the file bytes (it runs readApkg).
 *   - `addStarterDeck` — the I/O: read the bundled file, plan on the CURRENT
 *     state, apply, save, write the images. The store and the file writer
 *     come in as plain functions (`deps`), so this module does not import the
 *     engine or the media writer.
 *
 * Used by: the AddSheet "Starter decks" rows (`starterDeckRows`,
 * `addStarterDeck`, `writeStarterImages`) and onboarding's "Start with
 * German" (`addStarterDeck`). Both go through the SAME `addStarterDeck`
 * (wave 5c): the AddSheet only adds its own rule for how a new deck's cards
 * start (`StarterArrivalRule`, spec §5.9 D3), so the steps above live in one
 * place and the two callers cannot behave differently. The generic pack has
 * no starter decks.
 *
 * Not done here: the INSTALLED version of a starter deck is not recorded.
 * `state.pack` (starter key → deckId) is not read or written: the deck's
 * sourceKey is the one place that says "this deck is that starter deck"
 * (§5.10), so a deck can never be found under two keys. Notes that a file
 * ADDS get `source.ref = 'pack:<pack>:<key>@<version>'`, but updated notes
 * keep their old ref and the deck has no version field, so the state cannot
 * say which version is installed. The "Update {title} (keeps your progress)"
 * row (§5.10) needs a place for the version in the model and a reducer step
 * that writes it (wave 4).
 */
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';

import type { FlushResult } from '../store/actions';
import type { ContentPack, StarterDeck } from '../variants/types';
import { readApkg } from './import/apkgRead';
import { collectionSections, fileGuids, ownValue, planImport, type PlanCtx, type PlanLibrary } from './import/plan';
import { fieldFacetSpecs } from './libraryIndex';
import { ApkgError } from './importApkg';
import type {
  AnkiCollection,
  Deck,
  Id,
  ImportChoices,
  ImportMediaFolder,
  ImportPlan,
  ImportResult,
  SrsSettings,
} from './model';
import { RETIRED_TAG } from './noteOps';
import { detectOrdinal } from './ordinal';
import { suggestMapping } from './roles';
import { foldText } from './text';

/* ------------------------------------------------------------------ types */

/** The parts of the state a starter deck plan reads (a DataStateV3 fits). */
export type StarterLibrary = PlanLibrary & {
  settings: { srs: Pick<SrsSettings, 'startingEase' | 'maxIntervalDays'> };
};

/**
 * What a starter deck plan does:
 *   'add'       → it makes a new deck (the first add, or the deck was deleted with its cards);
 *   'update'    → the starter deck exists; no new deck, but notes are updated or added (a newer bundled file);
 *   'upToDate'  → the starter deck exists, and nothing changes ("Already up to date.");
 *   'elsewhere' → there is NO starter deck, and none is made, because the notes of the file are
 *                 already in other decks (for example "Unfiled cards" after a delete that kept
 *                 the cards). Those notes are updated where they are (when the file changed
 *                 them). `elsewhereDecks` says which decks hold them; the same add with
 *                 `elsewhere: 'copy'` makes the starter deck again ("Add as a new deck").
 */
export type StarterKind = 'add' | 'update' | 'upToDate' | 'elsewhere';

/**
 * A deck OTHER than the starter deck that holds notes of the starter file
 * (matched by guid, like the planner, §5.6 rule 3).
 */
export interface StarterElsewhereDeck {
  deckId: Id;
  /** The deck's name now, e.g. "Unfiled cards". */
  deckName: string;
  /** How many notes of the file are in this deck. */
  notes: number;
}

/**
 * "Where do you start?" for a starter deck, by VALUE (onboarding, wave 4):
 * the learner picks a level from a fixed list ("B1"), for several decks at
 * once. The cards of the easier values get `below`.
 *
 * WHY by value, not by the planner's `fromRank`: `fromRank` is an index into
 * the values of ONE plan (`summary.placementGroups`), which the caller of
 * `addStarterDeck` never sees. For a deck whose levels are [A2, B1, B2] (no
 * A1), index 2 of the list A1 … C2 ("B1") would be "B2" there, and the B1
 * cards would be marked Known too (W3-8 hardening).
 */
export interface StarterPlacement {
  /** The placement group: 'field:<key>' (a field such as Level) or 'section'. */
  facet: string;
  /** The value to start at, e.g. 'B1'. Every value below it is "easier". */
  fromValue: string;
  /** What the cards of the easier values get: 'known' ("I know them") or 'notStarted'. */
  below: 'known' | 'notStarted';
}

/** Choices a caller may change. Everything else is fixed: the whole file, every direction, Anki progress kept. */
export interface StarterPlanOptions {
  /**
   * What the NEW cards get. Default: the target deck's `options.newArrival`,
   * and 'queued' for a new deck (Study brings them in a few a day), so no
   * card is left Not started before "Choose what to learn" exists (wave 4).
   */
  arrival?: ImportChoices['arrival'];
  /** "Where do you start?" (onboarding, wave 4), by value: see StarterPlacement. */
  placement?: StarterPlacement;
  /**
   * A note of the file that is already in ANOTHER deck. Default 'update'
   * ("Update them where they are").
   *
   * After an 'elsewhere' answer, 'copy' is "Add as a new deck": the starter
   * deck is made again with copies (new guids), and the cards in the other
   * deck stay as they are. A later version of the file still matches the
   * ORIGINAL notes by guid, so it updates them where they are, not the copies.
   */
  elsewhere?: ImportChoices['elsewhere'];
}

/** Time and ids for the plan. `newId` must give a new unique id on every call. */
export interface StarterCtx {
  now: number;
  newId: () => string;
}

export interface StarterDeckPlan {
  starter: StarterDeck;
  /** 'pack:<pack id>:<key>'. */
  sourceKey: string;
  kind: StarterKind;
  /** The deck that already holds this starter deck (the plan's target), or null (no starter deck yet). */
  existingDeckId: Id | null;
  /**
   * The other decks that hold notes of the file (not the starter deck), most
   * notes first. Empty when every note is new or in the starter deck. The
   * notes add up to `plan.summary.inOtherDecks`.
   */
  elsewhereDecks: StarterElsewhereDeck[];
  /** Give it to `applyImport` as it is. */
  plan: ImportPlan;
}

/**
 * Reads one image of the bundled archive by its file name ("haus.webp"),
 * unpacked only now. null = the archive does not have that image.
 */
export type StarterMediaBytes = (name: string) => Uint8Array | null;

/** The store functions `addStarterDeck` needs (the engine's actions fit), and the image writer. */
export interface StarterDeps {
  /** The CURRENT state. Read after the file is loaded, right before planning. */
  getState(): StarterLibrary;
  /** One reducer step (spec §3.6). */
  applyImport(plan: ImportPlan): ImportResult;
  /**
   * Saves now and says whether the save committed (spec §5.9 "Saving {n}
   * cards"). The engine's `flush()` fits: it never rejects, it RESOLVES a
   * FlushResult (`{ ok: false, reason: 'write' | 'blocked' }` when the data
   * is not on the disk).
   */
  flush(): Promise<FlushResult>;
  /**
   * Writes the images of the plan after the save committed (§5.8): every
   * file of every folder, to `Paths.document/<deckFolder>/<name>` (the
   * media writer of src/platform/media.ts). `bytesOf(name)` unpacks one
   * file; null = skip that file. A file may already exist (an earlier add
   * wrote it): the writer keeps it or writes it again, never fails on it.
   * Called only when there is at least one file.
   */
  writeMedia(folders: ImportMediaFolder[], bytesOf: StarterMediaBytes): Promise<void>;
  now(): number;
  /** Default: `starterIds(now())`. */
  newId?: () => string;
  /** Default: `loadStarterBytes`. Tests pass the bytes of a test file. */
  loadBytes?: (starter: StarterDeck) => Promise<Uint8Array>;
  /**
   * Reads the loaded bytes into a collection. Default: `readApkg` (the
   * import's .apkg reader). Tests pass a fake that counts its reads.
   */
  readFile?: (bytes: Uint8Array, fileName: string) => Promise<AnkiCollection>;
  /** Plans the deck. Default: `planStarterDeckFrom`. Tests pass a wrapper that counts its plans. */
  planDeck?: typeof planStarterDeckFrom;
}

/**
 * A caller's own rule for how the NEW cards of a NEW starter deck start,
 * decided from the file itself (wave 5c). The AddSheet passes the import's
 * rule (spec §5.9, decision D3): more than 1,000 new cards → Not started,
 * fewer → the study queue. `addStarterDeck` uses it only when the caller
 * gave no `arrival` AND the plan makes a new deck; an existing deck keeps
 * its own "new cards start" setting.
 *
 * Two steps, so the file is read ONCE and (when the guess is right) planned
 * ONCE (wave 5b R5: 3 MB German_Vocabulary was unzipped and planned twice):
 *   1. `guess(collection)` — from the file alone, before any plan (for
 *      example from its number of card rows);
 *   2. `fromPlan(planned)` — the real answer, from the plan made with the
 *      guess (a plan's number of new cards does not depend on the arrival).
 *      undefined = keep the guess. Only a different answer plans once more,
 *      from the same read.
 */
export interface StarterArrivalRule {
  guess(collection: AnkiCollection): ImportChoices['arrival'];
  fromPlan(planned: StarterDeckPlan): ImportChoices['arrival'] | undefined;
}

/**
 * What happened to the images of the starter deck (§5.8):
 *   'none'    → the notes use no image of the file: nothing to write;
 *   'written' → `writeMedia` wrote them;
 *   'skipped' → not written, because the save did not commit (`saved.ok` is
 *               false);
 *   'failed'  → `writeMedia` threw (`imagesError`). The cards are saved.
 * After 'skipped' or 'failed' the row already says "Added ✓" (the deck is in
 * the library), so it does not invite another "Add". WAVE 4 MUST offer a
 * retry there: `writeStarterImages(pack, key, deps)` writes only the images,
 * after a save that commits (W3-8 hardening: else they could stay missing).
 */
export type StarterImages = 'none' | 'written' | 'skipped' | 'failed';

export interface StarterDeckOutcome {
  kind: StarterKind;
  starter: StarterDeck;
  /**
   * What applyImport applied, or null when the plan changed nothing (it was
   * not applied). The Done lines come from here (§5.9).
   */
  result: ImportResult | null;
  /**
   * The deck that holds the starter deck now: the new deck or the existing
   * one. null for 'elsewhere' (there is no starter deck).
   */
  deckId: Id | null;
  /**
   * What `deps.flush()` said: `{ ok: true }` = on the disk. `{ ok: false }` =
   * the change is only in memory: show the "not saved" state ('write': the
   * next save tries again; 'blocked': saving is not allowed now). null =
   * nothing was saved, because nothing changed and there were no images.
   */
  saved: FlushResult | null;
  /** The images step. */
  images: StarterImages;
  /** The error of `writeMedia`, only when `images` is 'failed'. */
  imagesError?: unknown;
  /**
   * The plan's `elsewhereDecks`. For 'elsewhere' this is where the cards
   * are: "These cards are in Unfiled cards" (wave 4), with "Add as a new
   * deck" (`elsewhere: 'copy'`).
   */
  elsewhereDecks: StarterElsewhereDeck[];
  /**
   * What the new cards got when a `StarterArrivalRule` chose it (a new deck
   * only). Left out = the caller's `opts.arrival`, or the planner's own
   * default (an existing deck's setting, else 'queued').
   */
  arrival?: ImportChoices['arrival'];
}

/**
 * One row of the AddSheet "Starter decks" list (§8.10): "Added ✓" when
 * `deckId` is set, else "Add". A starter deck deleted with its cards kept
 * has no `deckId`, so its row says "Add"; the tap then answers 'elsewhere'
 * (see StarterKind).
 */
export interface StarterDeckRow {
  starter: StarterDeck;
  deckId: Id | null;
}

/* ------------------------------------------------------------------ keys */

/** The `Deck.sourceKey` of a starter deck: starterSourceKey('german', 'vocabulary') → 'pack:german:vocabulary'. */
export function starterSourceKey(packId: string, key: string): string {
  return `pack:${packId}:${key}`;
}

/** The starter deck `key` of `pack`. Throws when the pack has none (a programming error). */
export function starterDeckOf(pack: ContentPack, key: string): StarterDeck {
  const starter = pack.starterDecks.find((s) => s.key === key);
  if (!starter) throw new Error(`The "${pack.id}" pack has no starter deck "${key}".`);
  return starter;
}

/** The deck made from the starter deck `key` of the pack `packId`, found by its sourceKey (never by name). */
export function findStarterDeck(decks: readonly Deck[], packId: string, key: string): Deck | undefined {
  const sourceKey = starterSourceKey(packId, key);
  return decks.find((d) => d.sourceKey === sourceKey);
}

/** Every starter deck of the pack, in pack order, with the deck that holds it (or null). */
export function starterDeckRows(pack: ContentPack, decks: readonly Deck[]): StarterDeckRow[] {
  return pack.starterDecks.map((starter) => ({
    starter,
    deckId: findStarterDeck(decks, pack.id, starter.key)?.id ?? null,
  }));
}

/**
 * The file name the reader gets: the starter title + '.apkg'. It is only a
 * fallback name (a card type without a name gets it); the deck is named by
 * the starter title anyway. The same name on every path keeps the plans equal.
 */
function starterFileName(starter: StarterDeck): string {
  return `${starter.title}.apkg`;
}

/**
 * How many id makers `starterIds` made in this JS runtime. Every call takes
 * the next number, so two id makers never share it.
 */
let starterSeq = 0;

/**
 * Ids for one starter deck import: 'p-<time>-<seq><salt>-<n>'.
 *   - 'p-' keeps them apart from the ids of the engine ('n-…', 'c-…', 'd-…');
 *   - <seq> is a new number on every call (`starterSeq`), so two imports in
 *     the same millisecond (onboarding may add 3 starter decks with
 *     Promise.all) never get the same ids, by construction;
 *   - <time> and the random <salt> keep different app launches apart (there
 *     <seq> starts at 1 again). The salt always has 4 characters, so
 *     "<seq><salt>" can be read only one way;
 *   - <n> counts the ids of this one import.
 *
 *   starterIds(now)() → 'p-mq7py740-1a3f0-1', then 'p-mq7py740-1a3f0-2' …
 */
export function starterIds(now: number): () => string {
  const stamp = Math.max(0, Math.trunc(now)).toString(36);
  starterSeq += 1;
  const seq = starterSeq.toString(36);
  const salt = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  let n = 0;
  return () => {
    n += 1;
    return `p-${stamp}-${seq}${salt}-${n}`;
  };
}

/* --------------------------------------------------------------- planning */

/**
 * True when applying the plan changes the library. `plan.media` does not
 * count: images are files on the disk, not part of the library state.
 */
function changesLibrary(plan: ImportPlan): boolean {
  return (
    plan.deck !== null ||
    plan.noteTypes.add.length > 0 ||
    plan.noteTypes.upgrade.length > 0 ||
    plan.notes.add.length > 0 ||
    plan.notes.update.length > 0 ||
    plan.notes.retire.length > 0 ||
    plan.cards.add.length > 0
  );
}

/**
 * The notes a newer bundled file RETIRES (see the top of the file): notes of
 * the starter deck `deckId` that came from this starter file (`source.ref`
 * starts with '<sourceKey>@'), with an Anki guid (not '' and not an app-made
 * 'm-…' guid) that the file does not have any more, and without the tag
 * RETIRED_TAG yet. A note's deck is the deck of its first card (all cards of
 * a note are in one deck). PURE.
 */
export function retiredNotesOf(
  collection: AnkiCollection,
  library: Pick<StarterLibrary, 'notes' | 'cards'>,
  deckId: Id,
  sourceKey: string,
): Id[] {
  const inFile = new Set(fileGuids(collection.notes).map((g) => g.guid));
  const deckOfNote = new Map<Id, Id>();
  for (const c of library.cards) if (!deckOfNote.has(c.noteId)) deckOfNote.set(c.noteId, c.deckId);
  const prefix = `${sourceKey}@`;
  return library.notes
    .filter(
      (n) =>
        deckOfNote.get(n.id) === deckId &&
        n.source?.kind === 'pack' &&
        typeof n.source.ref === 'string' &&
        n.source.ref.startsWith(prefix) &&
        n.guid !== '' &&
        !n.guid.startsWith('m-') &&
        !inFile.has(n.guid) &&
        !n.tags.includes(RETIRED_TAG),
    )
    .map((n) => n.id);
}

/**
 * The decks other than `targetDeckId` that hold notes of the file, matched by
 * guid the SAME way as the planner (plan.ts, §5.6 rules 1–3):
 *   - the file's guids are the ones after `fileGuids` (a repeated guid gets its derived guid);
 *   - a library note counts only when it has a card, and its deck is the deck of its FIRST card;
 *   - a match in the target deck wins (that note is not "elsewhere");
 *   - a note whose card type is missing in the file is skipped (the planner skips it too).
 * `targetDeckId` null = there is no starter deck yet. Sorted by notes (most
 * first), then by name, like the planner's overlap list.
 */
function elsewhereDecksOf(
  collection: AnkiCollection,
  library: StarterLibrary,
  targetDeckId: Id | null,
): StarterElsewhereDeck[] {
  const deckOfNote = new Map<Id, Id>();
  for (const c of library.cards) if (!deckOfNote.has(c.noteId)) deckOfNote.set(c.noteId, c.deckId);
  // guid → the decks of the library notes with that guid, in library order.
  const decksByGuid = new Map<string, Id[]>();
  for (const n of library.notes) {
    const deckId = deckOfNote.get(n.id);
    if (!n.guid || deckId === undefined) continue;
    let list = decksByGuid.get(n.guid);
    if (!list) decksByGuid.set(n.guid, (list = []));
    list.push(deckId);
  }
  const counts = new Map<Id, number>();
  const guids = fileGuids(collection.notes);
  collection.notes.forEach((n, i) => {
    const model = ownValue(collection.models, n.mid);
    if (!model || model.flds.length === 0) return;
    const guid = guids[i].guid;
    const decks = guid === '' ? undefined : decksByGuid.get(guid);
    if (!decks || (targetDeckId !== null && decks.includes(targetDeckId))) return;
    counts.set(decks[0], (counts.get(decks[0]) ?? 0) + 1);
  });
  const nameOf = new Map<Id, string>(library.decks.map((d) => [d.id, d.name]));
  return [...counts.entries()]
    .map(([deckId, notes]) => ({ deckId, deckName: nameOf.get(deckId) ?? '', notes }))
    .sort((a, b) => b.notes - a.notes || (a.deckName < b.deckName ? -1 : a.deckName > b.deckName ? 1 : 0));
}

/**
 * The pack's marks on a plan: new card types get `source.packId`, and a new
 * deck gets the pack's deck defaults (read-aloud languages, German article
 * colours). `noteTypes.reuse` has no prototype (H2), so it is passed on as
 * it is, never spread.
 */
function withPackMarks(plan: ImportPlan, pack: ContentPack): ImportPlan {
  const defaults = pack.deckDefaults ?? {};
  let deck = plan.deck;
  if (deck !== null) {
    deck = { ...deck };
    if (defaults.language !== undefined) deck.language = defaults.language;
    if (defaults.meaningLanguage !== undefined) deck.meaningLanguage = defaults.meaningLanguage;
    if (defaults.genderColors !== undefined) deck.genderColors = defaults.genderColors;
  }
  return {
    ...plan,
    noteTypes: {
      add: plan.noteTypes.add.map((t) => ({ ...t, source: { ...t.source, packId: pack.id } })),
      reuse: plan.noteTypes.reuse,
      // An upgraded card type keeps its own source (it may have come from a file import).
      upgrade: plan.noteTypes.upgrade,
    },
    deck,
  };
}

/**
 * The planner's `fromRank` for a placement given by VALUE (StarterPlacement),
 * from the placement groups of a plan of THIS deck
 * (`plan.summary.placementGroups`: each group's values in ordinal order).
 * fromRank = the index of the first value at or above `fromValue`, compared
 * on one ordinal scale (detectOrdinal over the values and `fromValue`), so a
 * level the deck does not have still works:
 *
 *   values [A2, B1, B2], 'B1' → 1   (only A2 is easier)
 *   values [A2, B1, B2], 'A1' → 0   (nothing is easier)
 *   values [A2, B1, B2], 'C1' → 3   (every value is easier)
 *
 * When `fromValue` is not on the group's scale, only the same value (case
 * and accents ignored) counts. null = no such group, or no match: then there
 * is no placement (nothing is marked).
 */
export function starterPlacementRank(
  groups: readonly { facet: string; values: readonly string[] }[],
  placement: Pick<StarterPlacement, 'facet' | 'fromValue'>,
): number | null {
  const group = groups.find((g) => g.facet === placement.facet);
  if (!group) return null;
  const target = placement.fromValue.trim();
  if (target === '') return null;
  const ordinal = detectOrdinal([...group.values, target]);
  if (ordinal) {
    const rank = ordinal.rank(target);
    const at = group.values.findIndex((v) => ordinal.rank(v) >= rank);
    return at < 0 ? group.values.length : at;
  }
  const at = group.values.findIndex((v) => foldText(v) === foldText(target));
  return at < 0 ? null : at;
}

/**
 * Plan adding (or updating) the starter deck `key` of `pack` from its
 * collection. PURE: the same inputs and the same `ctx.newId` sequence give
 * the same plan. With `opts.placement` it plans twice (the first plan says
 * where the value is in this deck, see starterPlacementRank).
 *
 * Fixed choices: the whole file (every section), the field roles and
 * directions of `suggestMapping` with the pack's presets (every direction
 * on), Anki progress kept, images on. The target is the deck whose sourceKey
 * is 'pack:<pack>:<key>', else a new deck named by the starter title, with
 * that sourceKey, `source: 'pack'` and the pack's deck defaults. Every new
 * note gets `source: { kind: 'pack', ref: 'pack:<pack>:<key>@<version>' }`
 * (which file version added it).
 *
 * `kind` (StarterKind): a new deck → 'add'; else no starter deck, but notes
 * matched in other decks → 'elsewhere'; else 'update' when the plan changes
 * the library, 'upToDate' when it does not.
 *
 * Throws when the pack has no starter deck `key`.
 */
export function planStarterDeckFrom(
  pack: ContentPack,
  key: string,
  library: StarterLibrary,
  collection: AnkiCollection,
  ctx: StarterCtx,
  opts: StarterPlanOptions = {},
): StarterDeckPlan {
  const starter = starterDeckOf(pack, key);
  const sourceKey = starterSourceKey(pack.id, key);
  const existing = findStarterDeck(library.decks, pack.id, key);

  // The import screen's first guess, with the pack presets. The record has
  // no prototype: model ids come from the file (H2).
  const types = Object.create(null) as ImportChoices['types'];
  for (const t of suggestMapping(collection, pack.cardTypePresets).types) {
    types[t.mid] = { fields: t.fields, ords: t.ords, templates: t.templates };
  }

  const choices: ImportChoices = {
    sections: new Set(collectionSections(collection).map((s) => s.did)),
    target: existing
      ? { kind: 'existing', deckId: existing.id }
      : { kind: 'new', name: starter.title, icon: pack.deckDefaults?.icon ?? '' },
    types,
    progress: 'keep',
    arrival: opts.arrival ?? existing?.options.newArrival ?? 'queued',
    elsewhere: opts.elsewhere ?? 'update',
    images: true,
    // The file is always imported whole: its subdecks are the deck's sections,
    // so an update moves a note the newer file moved (B1 → A2) to its new section.
    followSections: true,
  };

  const planCtx: PlanCtx = {
    now: ctx.now,
    newId: ctx.newId,
    srs: { startingEase: library.settings.srs.startingEase, maxIntervalDays: library.settings.srs.maxIntervalDays },
    fieldFacetSpecs,
    detectOrdinal,
    origin: { kind: 'pack', ref: `${sourceKey}@${starter.version}`, sourceKey },
  };
  let plan = withPackMarks(planImport(collection, library, choices, planCtx), pack);
  // "Where do you start?" by value: THIS plan's placement group says which
  // index the value has in this deck; then plan again with that index.
  if (opts.placement) {
    const fromRank = starterPlacementRank(plan.summary.placementGroups, opts.placement);
    if (fromRank !== null) {
      choices.placement = { facet: opts.placement.facet, fromRank, below: opts.placement.below };
      plan = withPackMarks(planImport(collection, library, choices, planCtx), pack);
    }
  }
  // The notes of the starter deck that this (newer) file dropped (see the top of the file).
  const retire = existing ? retiredNotesOf(collection, library, existing.id, sourceKey) : [];
  if (retire.length > 0) {
    plan = { ...plan, notes: { ...plan.notes, retire }, summary: { ...plan.summary, notesRetired: retire.length } };
  }
  let kind: StarterKind;
  if (plan.deck !== null) kind = 'add';
  // No starter deck, and the planner made none: the notes it found are in
  // other decks. Without this kind, the row would say "Add" and every tap
  // "Already up to date.", with no way out.
  else if (!existing && plan.summary.inOtherDecks > 0) kind = 'elsewhere';
  else kind = changesLibrary(plan) ? 'update' : 'upToDate';
  const elsewhereDecks = elsewhereDecksOf(collection, library, existing?.id ?? null);
  return { starter, sourceKey, kind, existingDeckId: existing?.id ?? null, elsewhereDecks, plan };
}

/**
 * `planStarterDeckFrom` from the bytes of the bundled `.apkg` (it reads them
 * with `readApkg`, the import's reader). Throws ApkgError for a bad file,
 * and an Error when the pack has no starter deck `key` (before reading).
 *
 * `ctx` is optional, so the spec's call `planStarterDeck(pack, key, state,
 * bytes)` (§10 W3-8) works: then the time is now and the ids come from
 * `starterIds` (read when the file was read, not at the call). Tests pass a
 * fixed `ctx` to get the same plan every time.
 */
export async function planStarterDeck(
  pack: ContentPack,
  key: string,
  library: StarterLibrary,
  bytes: Uint8Array,
  ctx?: StarterCtx,
  opts: StarterPlanOptions = {},
): Promise<StarterDeckPlan> {
  const starter = starterDeckOf(pack, key);
  const collection = await readApkg(bytes, starterFileName(starter));
  const now = ctx?.now ?? Date.now();
  return planStarterDeckFrom(pack, key, library, collection, ctx ?? { now, newId: starterIds(now) }, opts);
}

/* -------------------------------------------------------------------- I/O */

/**
 * The bytes of a bundled starter deck. `downloadAsync()` copies the packaged
 * file to the cache folder (for a bundled asset this is a local copy, not a
 * network download); the bytes are read once with `File`. The cache copy may
 * be cleared later by the system; it is never needed again.
 *
 * Rejects with the platform's own error when the file cannot be read;
 * `addStarterDeck` turns that into an ApkgError.
 */
export async function loadStarterBytes(starter: StarterDeck): Promise<Uint8Array> {
  const asset = Asset.fromModule(starter.asset);
  await asset.downloadAsync();
  return new File(asset.localUri ?? asset.uri).bytes();
}

/** True when at least one folder has a file to write. */
function hasMediaFiles(folders: readonly ImportMediaFolder[]): boolean {
  return folders.some((f) => f.files.length > 0);
}

/**
 * The collection of a bundled starter deck: load the bytes (`deps.loadBytes`
 * or `loadStarterBytes`) and read them (`deps.readFile` or `readApkg`). A
 * load that fails becomes ApkgError 'corrupt' (one error type for the
 * caller); a bad file is an ApkgError of the reader.
 */
async function readStarter(
  starter: StarterDeck,
  deps: Pick<StarterDeps, 'loadBytes' | 'readFile'>,
): Promise<AnkiCollection> {
  let bytes: Uint8Array;
  try {
    bytes = await (deps.loadBytes ?? loadStarterBytes)(starter);
  } catch (e) {
    if (e instanceof ApkgError) throw e;
    // A missing or unreadable bundled file: one error type for the caller.
    const why = e instanceof Error ? e.message : String(e);
    throw new ApkgError('corrupt', `The starter deck "${starter.title}" could not be loaded: ${why}`);
  }
  return (deps.readFile ?? readApkg)(bytes, starterFileName(starter));
}

/**
 * The plan of an add, with the caller's arrival rule (StarterArrivalRule)
 * for a NEW deck. PURE (no await), so `addStarterDeck` can apply the plan
 * in the same synchronous step.
 *   - no rule, a caller's `arrival`, or a starter deck in the library → one
 *     plan with `opts`, as always;
 *   - else one plan with `rule.guess`. A new deck ('add') → check the guess
 *     with `rule.fromPlan`, and plan once more only when the answer differs;
 *     no new deck after all ('elsewhere': the notes are in other decks) →
 *     plan once more with `opts`, so the guess never changes a deck that is
 *     not new.
 * Returns the plan and the arrival the rule chose (only for a new deck).
 */
function planWithRule(
  pack: ContentPack,
  key: string,
  library: StarterLibrary,
  collection: AnkiCollection,
  ctx: StarterCtx,
  opts: StarterPlanOptions,
  rule: StarterArrivalRule | undefined,
  planDeck: typeof planStarterDeckFrom,
): { planned: StarterDeckPlan; arrival?: ImportChoices['arrival'] } {
  if (!rule || opts.arrival !== undefined || findStarterDeck(library.decks, pack.id, key)) {
    return { planned: planDeck(pack, key, library, collection, ctx, opts) };
  }
  const guess = rule.guess(collection);
  const first = planDeck(pack, key, library, collection, ctx, { ...opts, arrival: guess });
  if (first.kind !== 'add') return { planned: planDeck(pack, key, library, collection, ctx, opts) };
  const arrival = rule.fromPlan(first) ?? guess;
  if (arrival === guess) return { planned: first, arrival };
  return { planned: planDeck(pack, key, library, collection, ctx, { ...opts, arrival }), arrival };
}

/**
 * Add (or update) the starter deck `key` of `pack`: read the bundled file,
 * plan on the CURRENT state, apply it in one step, save, then write the
 * images (§5.8).
 *
 * The plan is made AFTER the file is read (`deps.getState()` then) and
 * applied in the same synchronous step, so nothing can change in between:
 * two quick taps on "Add" make ONE deck (the second finds it by sourceKey and
 * is 'upToDate'). A plan that changes nothing is not applied ('upToDate', or
 * 'elsewhere' when the notes in the other decks need no change).
 *
 * 'elsewhere' (no starter deck; the notes are in other decks): changes to
 * those notes are applied and saved like any other change; `deckId` is null,
 * and `elsewhereDecks` says where the cards are.
 *
 * Saving and images:
 *   - something was applied, or the plan lists images → `deps.flush()`. Its
 *     answer is `outcome.saved`. A save that did not commit does NOT throw:
 *     the outcome still says what was applied (it is in memory), and
 *     `saved.ok` is false.
 *   - the images are written only after a save that committed
 *     (`outcome.images`). An 'upToDate' plan still lists the images of its
 *     notes, so this also writes an image that is missing on the disk.
 *   - an error of `writeMedia` does not throw either: the cards are saved,
 *     so the outcome says 'failed' (with `imagesError`).
 *
 * `rule` (optional, wave 5c): the caller's way to choose how the NEW cards of
 * a NEW deck start (StarterArrivalRule; the AddSheet's D3). It is used only
 * when `opts.arrival` is not given and the plan makes a new deck; the
 * outcome's `arrival` then says what the rule chose. The file is still read
 * once. This is the ONE add of a starter deck: the AddSheet and onboarding
 * both call it, so a fix of these steps reaches every caller.
 *
 * Throws ApkgError when the bundled file cannot be loaded or read (a failed
 * load becomes ApkgError 'corrupt'), and an Error when the pack has no
 * starter deck `key`. The library is unchanged then.
 */
export async function addStarterDeck(
  pack: ContentPack,
  key: string,
  deps: StarterDeps,
  opts: StarterPlanOptions = {},
  rule?: StarterArrivalRule,
): Promise<StarterDeckOutcome> {
  const starter = starterDeckOf(pack, key);
  const collection = await readStarter(starter, deps);

  // From here to applyImport: no await.
  const now = deps.now();
  const { planned, arrival } = planWithRule(
    pack,
    key,
    deps.getState(),
    collection,
    { now, newId: deps.newId ?? starterIds(now) },
    opts,
    rule,
    deps.planDeck ?? planStarterDeckFrom,
  );
  const applied = changesLibrary(planned.plan) ? deps.applyImport(planned.plan) : null;
  const { kind, elsewhereDecks } = planned;
  // 'elsewhere': there is no starter deck, whatever deck the result names.
  const deckId = kind === 'elsewhere' ? null : applied ? applied.deckId : planned.existingDeckId;
  // When something was applied, its result is the truth (§5.1); it echoes plan.media.
  const media = applied ? applied.media : planned.plan.media;
  const withMedia = hasMediaFiles(media);
  // The rule's answer is part of the outcome only when the rule chose it.
  const chosen = arrival === undefined ? {} : { arrival };
  if (applied === null && !withMedia) {
    return { kind, starter, result: null, deckId, saved: null, images: 'none', elsewhereDecks, ...chosen };
  }

  // The images go to the disk only after the state that uses them is there.
  const saved = await deps.flush();
  const outcome: StarterDeckOutcome = {
    kind,
    starter,
    result: applied,
    deckId,
    saved,
    images: 'none',
    elsewhereDecks,
    ...chosen,
  };
  if (!withMedia) return outcome;
  if (!saved.ok) return { ...outcome, images: 'skipped' };
  try {
    await deps.writeMedia(media, collection.mediaBytes ?? (() => null));
    return { ...outcome, images: 'written' };
  } catch (e) {
    return { ...outcome, images: 'failed', imagesError: e };
  }
}

/** What `writeStarterImages` did. */
export interface StarterImagesOutcome {
  /** The starter deck whose images were looked at; null = there is no starter deck (nothing to do). */
  deckId: Id | null;
  /** What `deps.flush()` said; null = it was not called (no starter deck, or no image to write). */
  saved: FlushResult | null;
  /** 'none', 'written', 'skipped' (the save did not commit) or 'failed' (the writer threw). */
  images: StarterImages;
  /** The error of `writeMedia`, only when `images` is 'failed'. */
  imagesError?: unknown;
}

/**
 * Write ONLY the images of a starter deck that is already in the library:
 * the retry after an add whose outcome said `images` 'skipped' or 'failed'
 * (W3-8 hardening). The row then says "Added ✓", so wave 4 offers this as
 * its own action; without it the images could stay missing for good.
 *
 * It reads the bundled file and plans on the CURRENT state, but applies
 * NOTHING (a newer bundled file is the "Update" row's job). It writes the
 * image files that plan lists, only after `deps.flush()` says the state is on
 * the disk (§5.8): the starter deck's folder, and the folders of other decks
 * that hold notes of the file. A file that is already there is written again.
 *
 *   const out = await writeStarterImages(pack, 'vocabulary', deps);
 *   if (out.images === 'skipped') show('Saving failed. Try again in a moment.');
 *
 * Throws like `addStarterDeck` (ApkgError for a file that cannot be loaded or
 * read, an Error for an unknown key). With no starter deck it reads nothing.
 */
export async function writeStarterImages(
  pack: ContentPack,
  key: string,
  deps: Pick<StarterDeps, 'getState' | 'flush' | 'writeMedia' | 'now' | 'newId' | 'loadBytes' | 'readFile' | 'planDeck'>,
): Promise<StarterImagesOutcome> {
  const starter = starterDeckOf(pack, key);
  if (!findStarterDeck(deps.getState().decks, pack.id, key)) return { deckId: null, saved: null, images: 'none' };
  const collection = await readStarter(starter, deps);
  const now = deps.now();
  // The state may have changed while the file was read: plan on the state of NOW.
  const planned = (deps.planDeck ?? planStarterDeckFrom)(pack, key, deps.getState(), collection, {
    now,
    newId: deps.newId ?? starterIds(now),
  });
  const deckId = planned.existingDeckId;
  if (deckId === null) return { deckId: null, saved: null, images: 'none' };
  const media = planned.plan.media;
  if (!hasMediaFiles(media)) return { deckId, saved: null, images: 'none' };
  const saved = await deps.flush();
  if (!saved.ok) return { deckId, saved, images: 'skipped' };
  try {
    await deps.writeMedia(media, collection.mediaBytes ?? (() => null));
    return { deckId, saved, images: 'written' };
  } catch (e) {
    return { deckId, saved, images: 'failed', imagesError: e };
  }
}
