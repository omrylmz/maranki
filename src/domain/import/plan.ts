/**
 * The import planner (spec §5.1, §5.4–§5.6, §5.9, unit W2-5). PURE:
 *
 *   planImport(collection, library, choices, ctx) → ImportPlan
 *
 * `collection` is what a reader produced (apkgRead.ts or csvRead.ts, the same
 * shape). `library` is the current state (card types, notes, cards, decks).
 * `choices` is what the learner picked on the import screen. The plan says
 * EXACTLY what will change; the reducer applies it in one step
 * (`applyImport`, W3-2) and the preview shows only numbers from
 * `plan.summary`, which are counted from the plan itself.
 *
 * What the planner decides, note by note (file order):
 *   1. Is the note in a chosen section? Its section is the subdeck of its
 *      lowest-ord card (`odid` when the card sits in a filtered deck).
 *   2. Its card type (`findReusableType`): an existing one is REUSED when it
 *      came from the same Anki model (same field names, every template; it
 *      keeps its own roles), or when it has the same CSV signature AND the
 *      same field mapping as the learner chose. A type made from an OLDER
 *      version of the same Anki model (the model got new fields, lost
 *      fields or got new directions, `findUpgradableType`) is UPGRADED in
 *      place (`upgradeNoteType`): it keeps its id and its own field roles,
 *      it gets the new fields, and it loses the lost ones, except a lost
 *      field that a note the file does not update still has text in (it is
 *      kept, after the others). The reducer moves the values of ALL its
 *      notes to the new field order. Otherwise a new NoteType is
 *      built from the model and the learner's field mapping
 *      (`choices.types[mid]`), so a choice on the Fields screen is never
 *      silently ignored for a CSV. For a CSV the columns chosen as Front
 *      and Back (`csvFrontBack`) give the directions and the sort field.
 *   3. Duplicates (§5.6), in this order:
 *      - a second note with the same guid IN THE FILE gets its own guid,
 *        `m-<guid>~<k>` (`fileGuids`). It is derived, not random, so the
 *        same file imported again finds that note again (rules 2/3 below run
 *        on the derived guid) instead of adding it on every run;
 *      - same guid in the TARGET deck → update fields and tags (and the
 *        section, with `choices.followSections`), keep every card and its
 *        progress, add cards for newly enabled directions;
 *      - same guid in ANOTHER deck → `choices.elsewhere`: update it where it
 *        is, import a copy, or skip. A copy gets the DERIVED guid
 *        `m-<guid>~copy-<deck id>` (`copyGuid`), not a random one, so a later
 *        import into the deck that holds the copy finds it (as if it had the
 *        file's guid there) and updates it instead of adding it again;
 *      - no guid (CSV) → skipped when the target deck has a note of the same
 *        card type with the same folded sort field ("already here"; a blank
 *        sort field compares every field instead, `alreadyHereKey`). For a
 *        CSV, "the same card type" is any CSV card type with a field of the
 *        same NAME as the Front column, compared on THAT field
 *        (`hereBucket`): the same sheet imported again with another Front
 *        column, or with a column added, still finds its rows;
 *      - same headword in another deck with a different guid → imported,
 *        counted in `summary.overlap` (or skipped with `choices.skipOverlap`).
 *   4. Its cards: one card per enabled direction that the file has a card for
 *      (a cloze note: every cloze card). For a CSV the question side must not
 *      be blank (Anki's rule; today's "a card must have a front"). Anki
 *      progress is mapped by ankiSrs.ts (or reset), new cards get
 *      `choices.arrival`, and "Where do you start?" (`choices.placement`)
 *      marks the easier levels Known or leaves them Not started. By section,
 *      the LAST level of the section path is ranked ("Vocabulary::A1" → A1).
 *
 * Images (§5.8): the images of the added notes go to the target deck's
 * folder; a note updated where it is (another deck) gets its images in THAT
 * deck's folder. So `plan.media` is a list of folders. A folder never gets a
 * second picture under a name it has (`ctx.mediaName`): such a file gets its
 * own name, and the `<img src>` of the notes the plan writes into that
 * folder are rewritten to it (`ImportMediaFolder.renamed`).
 *
 * Sections (§5.4): the longest common "::" prefix of the chosen subdecks is
 * the deck root (and the suggested deck name); the rest of each path is
 * `note.section`. One subdeck chosen → section ''. Anki's "Default" deck is
 * the root itself (like anki.ts `ankiDeckName`): its notes get section '' and
 * do not change the deck name; only "Default" → the file name.
 *
 * New-card order (`sourceOrder`): Anki keeps the new-card position in `due`
 * of a new card (and, since Anki 2.1.55, in `cards.data` of a studied card),
 * and genanki decks set it to 0 for every card. So the planner RANKS the
 * chosen notes by (Anki new position, then note id) and uses the rank as
 * `note.order` and as `newPos` of every card of the note (siblings share it).
 * A note whose position is unknown (studied in an older Anki) stays next to
 * its neighbours by note id, never at the end. Into an existing deck, the new
 * notes come after its current cards.
 *
 * Keys from the file (H2): model ids, deck ids and field names are untrusted
 * text. A record is only read by its OWN keys (`ownValue`), and the records
 * the planner makes have no prototype, so "constructor" or "__proto__" is an
 * ordinary name and never Object's built-in function or prototype.
 *
 * Two helpers come in through `ctx` instead of imports, because other units
 * own them (W2-4, built at the same time): `fieldFacetSpecs` (which fields
 * are filter groups, for "Filters found") and `detectOrdinal` (CEFR, JLPT …
 * value order, for "Where do you start?"). The field roles come in
 * `choices.types`; from roles.ts the planner uses only `modelTemplates`, to
 * read the directions of an upgraded card type with its own field roles.
 *
 * Hermes-safe: no String.normalize / replaceAll / lookbehind. No clock and no
 * random: time is `ctx.now`, ids come from `ctx.newId()`.
 */
import { stripHtml } from '../anki';
import { unwrapCloze } from '../cloze';
import { deckNameFromFile } from '../importFile';
import { makeCard, makeDeck, makeNote, nextDeckOrder } from '../makeV3';
import type {
  AnkiCollection,
  Card,
  Deck,
  FacetFieldSpec,
  FieldDef,
  FieldRole,
  Id,
  ImportChoices,
  ImportMediaFolder,
  ImportPlan,
  ImportSkips,
  ImportSummary,
  Note,
  NoteType,
  NoteTypeUpgrade,
  SourceKind,
  SrsSettings,
  TemplateDef,
} from '../model';
import { fieldHasText, remapFields } from '../noteOps';
import { modelTemplates } from '../roles';
import { foldText } from '../text';
import { hasAnkiProgress, isMarkedTag, mapAnkiCard } from './ankiSrs';
import { csvSignature, csvTemplates } from './csvRead';
import {
  archiveNameOf,
  imageRefs,
  isImageName,
  isSafeMediaName,
  mediaFolder,
  planDeckMedia,
  renameImageRefs,
  soundRefs,
  type DeckMediaInput,
} from './mediaPlan';

/* ------------------------------------------------------------------ types */

/** The parts of the state the planner reads (a DataStateV3 fits). */
export interface PlanLibrary {
  noteTypes: readonly NoteType[];
  notes: readonly Note[];
  cards: readonly Card[];
  decks: readonly Deck[];
}

/** An ordinal value set, e.g. CEFR: rank('A1') < rank('B2'). W2-4's `detectOrdinal` returns one. */
export interface OrdinalRanker {
  rank(value: string): number;
}

export interface PlanCtx {
  now: number;
  /** A fresh unique id on every call (notes, cards, card types, the deck, fresh guids). */
  newId: () => string;
  srs: Pick<SrsSettings, 'startingEase' | 'maxIntervalDays'>;
  /** W2-4 `fieldFacetSpecs`: which fields are filter groups (§4.3). Used for "Filters found" and placement. */
  fieldFacetSpecs: (types: NoteType[], notes: Note[]) => ReadonlyMap<string, FacetFieldSpec>;
  /** W2-4 `detectOrdinal`: null when the labels have no natural order. Used for "Where do you start?". */
  detectOrdinal: (labels: string[]) => OrdinalRanker | null;
  /**
   * Where the file came from: the new deck's `source`/`sourceKey` and each
   * note's `source.kind`/`ref`. Default: kind 'csv' for a CSV, else 'apkg';
   * ref = the file name; sourceKey 'file:<fileName>'.
   */
  origin?: { kind: SourceKind; ref?: string; sourceKey?: string };
  /**
   * The name the archive image `name` gets in the folder of deck `deckId`:
   * `name` itself when the folder has no file of that name (or one with the
   * same bytes), else a name of its own (mediaPlan.ts `freeImageName`). The
   * import screen reads the phone's folders (importFile.ts
   * `importMediaNamer`). Absent = every image keeps its name (tests, starter
   * decks: a starter deck's folder holds only its own file's images).
   */
  mediaName?: (deckId: Id, name: string) => string;
}

/** One subdeck of the file, for the "Choose sections" stage. */
export interface CollectionSection {
  /** Anki deck id ('' = notes whose deck is unknown, shown as "(Other)"). */
  did: string;
  /** Full name, e.g. "German::Verbs::B1". */
  name: string;
  /** The name split on "::". */
  path: string[];
  /** Notes whose home is this subdeck. */
  notes: number;
  /** Card rows of those notes. */
  cards: number;
}

type AnkiNote = AnkiCollection['notes'][number];
type AnkiCard = AnkiCollection['cards'][number];
type AnkiModel = AnkiCollection['models'][string];

/**
 * `record[key]` only when `key` is the record's OWN key, else undefined.
 * Model ids and deck ids come from the file: on a plain object,
 * `models['constructor']` is Object's built-in function and
 * `models['__proto__']` is Object.prototype, and reading `.flds` of either
 * would crash the import.
 *
 *   ownValue({ a: 1 }, 'a')           → 1
 *   ownValue({ a: 1 }, 'constructor') → undefined
 */
export function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/* ------------------------------------------------------- sections and names */

/**
 * A subdeck name → its path. Anki's "Default" deck is the container of
 * notes that have no deck of their own, so a leading "Default" segment is
 * dropped, like anki.ts `ankiDeckName`: "Default::Sub" → [Sub], and
 * "Default" alone → [] (the root: no deck name, no section).
 */
function pathOf(name: string): string[] {
  const parts = name.split('::').map((s) => s.trim());
  if (parts[0].toLowerCase() === 'default') parts.shift();
  // A trailing "::" ("German::") leaves an empty last part: drop it.
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** The longest common prefix of several paths. */
function commonPrefix(paths: string[][]): string[] {
  if (paths.length === 0) return [];
  const out: string[] = [];
  const first = paths[0];
  for (let i = 0; i < first.length; i++) {
    if (paths.every((p) => p[i] === first[i])) out.push(first[i]);
    else break;
  }
  return out;
}

/** Card rows by note id, sorted by ord, one row per ord (the first one wins). */
function cardsByNote(collection: AnkiCollection): Map<string, AnkiCard[]> {
  const out = new Map<string, AnkiCard[]>();
  for (const c of collection.cards) {
    let list = out.get(c.nid);
    if (!list) out.set(c.nid, (list = []));
    if (!list.some((x) => x.ord === c.ord)) list.push(c);
  }
  for (const list of out.values()) list.sort((a, b) => a.ord - b.ord);
  return out;
}

/**
 * The home subdeck of every note: the deck of its lowest-ord card (`odid`
 * when the card is in a filtered deck). '' when the note has no card or the
 * deck is not in the file.
 */
export function noteHomeDids(collection: AnkiCollection): Map<string, string> {
  const rows = cardsByNote(collection);
  const out = new Map<string, string>();
  for (const n of collection.notes) {
    const first = rows.get(n.id)?.[0];
    const raw = first ? (first.odid && first.odid !== '0' ? first.odid : first.did) : '';
    out.set(n.id, raw !== '' && typeof ownValue(collection.decks, raw) === 'string' ? raw : '');
  }
  return out;
}

/**
 * The notes of the chosen sections, by source model id, in file order (the
 * Fields stage shows one card per model that has notes here, with its item
 * count and its samples).
 */
export function chosenNotesByMid(collection: AnkiCollection, sections: ReadonlySet<string>): Map<string, AnkiNote[]> {
  const home = noteHomeDids(collection);
  const out = new Map<string, AnkiNote[]>();
  for (const n of collection.notes) {
    if (!sections.has(home.get(n.id) ?? '')) continue;
    let list = out.get(n.mid);
    if (!list) out.set(n.mid, (list = []));
    list.push(n);
  }
  return out;
}

/** The card ords of every note of the file, ascending, each once (nid → ords). */
export function cardOrdsByNote(collection: AnkiCollection): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const [nid, rows] of cardsByNote(collection)) out.set(nid, rows.map((r) => r.ord));
  return out;
}

/** The subdecks that hold notes, sorted by name (the "Choose sections" list). */
export function collectionSections(collection: AnkiCollection): CollectionSection[] {
  const home = noteHomeDids(collection);
  const rows = cardsByNote(collection);
  const byDid = new Map<string, CollectionSection>();
  for (const n of collection.notes) {
    const did = home.get(n.id) ?? '';
    let s = byDid.get(did);
    if (!s) {
      const name = did === '' ? '(Other)' : (ownValue(collection.decks, did) ?? '');
      s = { did, name, path: name.split('::').map((p) => p.trim()), notes: 0, cards: 0 };
      byDid.set(did, s);
    }
    s.notes += 1;
    s.cards += rows.get(n.id)?.length ?? 0;
  }
  return [...byDid.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The deck root of the chosen subdecks: their longest common path prefix.
 * Notes at the root (Anki's "Default" deck, or a deck the file does not
 * name) have the empty path; they are left out here, so they do not cut the
 * root short. Like `ankiDeckName`, which skips "Default":
 *   "Default" + "German::A1" + "German::A2" → root [German]
 *   (the Default notes get section '', the others A1 and A2).
 */
function rootOf(collection: AnkiCollection, dids: Iterable<string>): string[] {
  const paths: string[][] = [];
  for (const did of dids) {
    const path = did === '' ? [] : pathOf(ownValue(collection.decks, did) ?? '');
    if (path.length > 0) paths.push(path);
  }
  return commonPrefix(paths);
}

/**
 * The suggested name of a new deck: the common part of the chosen subdecks
 * joined with spaces ("German::Verbs::A1" + "German::Verbs::B1" → "German
 * Verbs"; one subdeck → its full name). No common part → the file name, so a
 * deck exported from Anki's "Default" deck is named after the file, as today.
 */
export function suggestDeckName(collection: AnkiCollection, sections?: ReadonlySet<string>): string {
  const home = noteHomeDids(collection);
  const dids = new Set<string>();
  for (const did of home.values()) if (!sections || sections.has(did)) dids.add(did);
  const name = rootOf(collection, dids).join(' ').replace(/\s+/g, ' ').trim();
  return name || deckNameFromFile(collection.fileName);
}

/**
 * How many segments of `path` (a note's subdeck in the file) were the deck
 * root when its section `section` was cut from it, or null when the section
 * is not a tail of the path (the learner chose another section).
 *
 *   sectionCut(['German', 'Verbs', 'A1'], '')   → 3   (root German::Verbs::A1)
 *   sectionCut(['German', 'Verbs', 'A1'], 'A1') → 2   (root German::Verbs)
 *   sectionCut(['German', 'Verbs', 'A1'], 'B2') → null
 */
export function sectionCut(path: readonly string[], section: string): number | null {
  if (section === '') return path.length;
  const parts = section.split('::').map((p) => p.trim());
  if (parts.length > path.length) return null;
  const cut = path.length - parts.length;
  return parts.every((p, i) => p === path[cut + i]) ? cut : null;
}

/** The last level of a section path ("Vocabulary::A1" → "A1"; "A1" → "A1"). */
function lastLevel(section: string): string {
  const parts = section.split('::');
  return parts[parts.length - 1].trim();
}

/* ------------------------------------------------------------ source order */

/**
 * The Anki new-card position of one note, or undefined when the file does not
 * keep it. A NEW card (type 0) has its position in `due`. A studied card has
 * lost it there (`due` is now a date), but Anki 2.1.55+ keeps it in
 * `originalPos` (`cards.data`). Siblings normally share one position; the
 * lowest one wins.
 */
function notePosition(cards: readonly AnkiCard[]): number | undefined {
  let best: number | undefined;
  for (const c of cards) {
    const pos = c.type === 0 ? c.due : c.originalPos;
    if (pos !== undefined && Number.isFinite(pos) && (best === undefined || pos < best)) best = pos;
  }
  return best;
}

/**
 * Notes in source order (spec §3.4 `Note.order`: "Anki new position or note
 * id order"): by Anki's new-card position, then by note id.
 *
 * A note whose position is unknown (`positionOf` → undefined: all its cards
 * were studied in an Anki that did not keep the position) is NOT put at the
 * end. It takes the position of the note just before it in note-id order (a
 * note id is its creation time, so: the note added just before it); when no
 * earlier note has a position, the position of the first note after it. The
 * note-id tie-break then puts it right next to that neighbour.
 * Why: a learner who studied the first 500 words of a frequency deck in Anki
 * and imports it with "reset" must get those words first, in deck order, not
 * after the other 8,000 words.
 *
 *   positions by note id: n1 ?, n2 ?, n3 7, n4 8, n5 ?, n6 3
 *   → n6, n1, n2, n3, n4, n5      (n1, n2 sit at 7 before n3; n5 sits at 8 after n4)
 */
export function sourceOrder<T extends { id: string }>(
  notes: readonly T[],
  positionOf: (note: T) => number | undefined,
): T[] {
  const byId = [...notes].sort((a, b) => compareIdText(a.id, b.id));
  const known = byId.map((n) => {
    const pos = positionOf(n);
    return pos !== undefined && Number.isFinite(pos) ? pos : undefined;
  });
  // Before the first known position, "the note before" does not exist yet:
  // start from the first known position (0 when no note has one: id order).
  let last = known.find((pos) => pos !== undefined) ?? 0;
  const keyed = byId.map((note, idRank) => {
    const pos = known[idRank];
    if (pos !== undefined) last = pos;
    return { note, at: pos ?? last, idRank };
  });
  keyed.sort((a, b) => (a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.idRank - b.idRank));
  return keyed.map((k) => k.note);
}

/* ----------------------------------------------------------- in-file guids */

/**
 * The guid each note of the file gets (§5.6 rule 1). Decided over the WHOLE
 * file, in file order, so the answer does not depend on the chosen sections.
 *
 * The first note with a guid keeps it. A later note with the same guid gets
 * the DERIVED guid `m-<guid>~<k>` (k = 1 for the first repeat, 2 for the
 * next …); a value that is already a guid in the file is skipped, so every
 * guid stays unique. Derived, not random: the same file imported again gives
 * the same guids, so the repeat finds its earlier copy (rules 2/3) instead of
 * being added again on every import. A note without a guid keeps ''.
 *
 *   fileGuids([{ guid: 'a' }, { guid: 'a' }, { guid: '' }])
 *   → [{ guid: 'a', renamed: false }, { guid: 'm-a~1', renamed: true }, { guid: '', renamed: false }]
 */
export function fileGuids(notes: readonly { guid: string }[]): { guid: string; renamed: boolean }[] {
  const original = new Set(notes.map((n) => n.guid));
  const used = new Set<string>();
  const repeats = new Map<string, number>(); // guid → the last k it used
  return notes.map(({ guid }) => {
    if (guid === '') return { guid, renamed: false };
    if (!used.has(guid)) {
      used.add(guid);
      return { guid, renamed: false };
    }
    let k = repeats.get(guid) ?? 0;
    let derived: string;
    do {
      k += 1;
      derived = `m-${guid}~${k}`;
    } while (original.has(derived) || used.has(derived));
    repeats.set(guid, k);
    used.add(derived);
    return { guid: derived, renamed: true };
  });
}

/* ------------------------------------------------------------ copy guids */

/** What a copy guid has between the file's guid and the deck id. */
const COPY_MARK = '~copy-';

/**
 * The guid of a COPY of the file's note `guid` made in deck `deckId`
 * ("Import as copies here" on the import screen, "Add as a new deck" for a
 * starter deck, §5.6 rule 3). Derived, not random: the copy still says which
 * note of the file it is (`copyOrigin`), so the next import into that deck
 * finds it and updates it, instead of adding every note of the file again.
 *
 *   copyGuid('Ab3', 'd-1') → 'm-Ab3~copy-d-1'
 */
export function copyGuid(guid: string, deckId: Id): string {
  return `m-${guid}${COPY_MARK}${deckId}`;
}

/**
 * The file guid a copy guid was made from (`copyGuid`), or null when `guid`
 * is not a copy guid. A suffix after the deck id ("~2", when the guid was
 * taken) does not matter.
 *
 *   copyOrigin('m-Ab3~copy-d-1') → 'Ab3'
 *   copyOrigin('Ab3')            → null
 */
export function copyOrigin(guid: string): string | null {
  if (!guid.startsWith('m-')) return null;
  const at = guid.lastIndexOf(COPY_MARK);
  return at > 2 ? guid.slice(2, at) : null;
}

/* ------------------------------------------------------ fields and templates */

/** Today's positions as roles (CSV without a header, and any card type without a mapping). */
const POSITION_ROLES: FieldRole[] = ['term', 'meaning', 'example', 'detail'];

/**
 * Default field mapping by position: 0 term, 1 meaning, 2 example, 3+ detail.
 * Free-text fields (term, meaning, example) are never filter groups; the
 * others are left to the data rule ('auto'). A generic 4th CSV column
 * ("Field 4") gets the label "Notes", as today.
 */
export function positionalFieldDefs(names: string[]): FieldDef[] {
  return names.map((name, i) => {
    const role = POSITION_ROLES[i] ?? 'detail';
    return {
      name,
      role,
      facet: role === 'detail' ? 'auto' : 'off',
      ...(i === 3 && /^Field \d+$/.test(name) ? { label: 'Notes' } : {}),
    };
  });
}

/** True when a field is drawn on the card (badges are pills, hidden fields are never shown). */
const isShownRole = (f: FieldDef | undefined): boolean => f !== undefined && f.role !== 'badge' && f.role !== 'hidden';

/**
 * The CSV columns the learner chose as Front and Back (spec §5.9: each
 * column gets Front / Back / Example / Show on back / Filter / Tags / Ignore).
 * Front = role 'term', Back = role 'meaning'.
 *
 *   - `front` is the question of "Front → Back" (ord 0) and the card type's
 *     sort field, so the "already here" check (§5.6 rule 4) and the headword
 *     overlap (rule 5) compare the Front column.
 *   - `back` is the question of "Back → Front" (ord 1, "Also make a reverse
 *     card") and the answer headline of ord 0.
 *
 * No 'term' field → the first shown field (else column 0). No 'meaning'
 * field → the first other shown field (else the first other column). With
 * one column, `back` = `front` (there is no reverse direction then).
 * Today's positions (no header) give front 0 and back 1, as before.
 *
 *   csvFrontBack(fields of "Level=Filter, Word=Front, Meaning=Back") → { front: 1, back: 2 }
 */
export function csvFrontBack(fields: readonly FieldDef[]): { front: number; back: number } {
  const all = fields.map((_, i) => i);
  const firstOf = (list: number[]) => (list.length > 0 ? list[0] : undefined);
  const front =
    firstOf(all.filter((i) => fields[i].role === 'term')) ?? firstOf(all.filter((i) => isShownRole(fields[i]))) ?? 0;
  const others = all.filter((i) => i !== front);
  const back =
    firstOf(others.filter((i) => fields[i].role === 'meaning')) ??
    firstOf(others.filter((i) => isShownRole(fields[i]))) ??
    firstOf(others) ??
    front;
  return { front, back };
}

/** Field index by name: exact first, then ignoring case and accents. -1 when absent. */
function fieldIndex(names: readonly string[], name: string): number {
  const exact = names.indexOf(name);
  if (exact >= 0) return exact;
  const folded = foldText(name.trim());
  return names.findIndex((n) => foldText(n.trim()) === folded);
}

/** Filters after which the field is NOT shown as text (audio only). `type:` is handled on its own. */
const HIDDEN_FILTERS = new Set(['tts']);

/** Where a template is read: its question side (qfmt) or its answer side (afmt). */
export interface TemplateSide {
  /** Default 'question'. */
  side?: 'question' | 'answer';
  /**
   * Answer side only: the typing field of the QUESTION side. `{{FrontSide}}`
   * repeats the question, and Anki shows the typed-answer check (with the
   * correct answer) where the question had its `{{type:F}}`, so F is shown.
   */
  questionTypeField?: number;
}

/**
 * The fields one Anki template shows, in order (spec §5.3, without running
 * Anki's template engine): `{{F}}`, `{{{F}}}`, `{{text:F}}`, `{{cloze:F}}` …
 * `{{#F}}`/`{{^F}}`/`{{/F}}` only open and close a condition (the fields
 * inside are read on their own), `{{tts …:F}}` is audio only.
 *
 * `{{type:F}}` makes F the typing target (`typeField`). On the QUESTION side
 * it is only the typing box, so F is not shown there (F is the answer). On
 * the ANSWER side Anki prints the correct answer in its place, so F counts
 * as shown there ("Basic (type in the answer)" has no other answer field).
 *
 * `{{FrontSide}}` is ignored (the answer side always echoes the prompt
 * small), except that it brings in `questionTypeField` on the answer side.
 *
 *   templateFieldRefs('{{Front}} {{type:Back}}', ['Front', 'Back'])
 *   → { shown: [0], typeField: 1 }
 *   templateFieldRefs('{{Front}}<hr id=answer>{{type:Back}}', ['Front', 'Back'], { side: 'answer' })
 *   → { shown: [0, 1], typeField: 1 }
 */
export function templateFieldRefs(
  fmt: string,
  names: readonly string[],
  where: TemplateSide = {},
): { shown: number[]; typeField?: number } {
  const answerSide = where.side === 'answer';
  const shown: number[] = [];
  const show = (idx: number) => {
    if (!shown.includes(idx)) shown.push(idx);
  };
  let typeField: number | undefined;
  const re = /\{\{\{?([^{}]*)\}?\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fmt ?? '')) !== null) {
    const inner = m[1].trim();
    if (inner === 'FrontSide') {
      if (answerSide && where.questionTypeField !== undefined) show(where.questionTypeField);
      continue;
    }
    if (!inner || /^[#^/]/.test(inner)) continue;
    const colon = inner.lastIndexOf(':');
    const field = colon >= 0 ? inner.slice(colon + 1).trim() : inner;
    const filters = colon >= 0 ? inner.slice(0, colon).split(':').map((f) => f.trim().split(/\s+/)[0].toLowerCase()) : [];
    const idx = fieldIndex(names, field);
    if (idx < 0) continue;
    if (filters.includes('type')) {
      if (typeField === undefined) typeField = idx;
      if (answerSide) show(idx);
      continue;
    }
    if (filters.some((f) => HIDDEN_FILTERS.has(f))) continue;
    show(idx);
  }
  return { shown, ...(typeField !== undefined ? { typeField } : {}) };
}

/**
 * The directions of a new card type, read from the model's templates and the
 * final field roles: prompt = question fields that are not badges or hidden;
 * answer = answer fields not in the prompt and not badges or hidden (a
 * `{{type:F}}` on the answer side counts: Anki shows F there). A template
 * whose prompt would be empty keeps its raw question fields (else the sort
 * field), so no card has an empty question.
 */
export function templatesFromModel(model: AnkiModel, fields: readonly FieldDef[], sortField: number): TemplateDef[] {
  const names = model.flds.map((f) => f.name);
  const visible = (i: number) => isShownRole(fields[i]);
  return model.tmpls.map((t) => {
    const q = templateFieldRefs(t.qfmt, names);
    const a = templateFieldRefs(t.afmt, names, { side: 'answer', questionTypeField: q.typeField });
    let prompt = q.shown.filter(visible);
    if (prompt.length === 0) prompt = q.shown.length > 0 ? q.shown : [sortField];
    const answer = a.shown.filter((i) => visible(i) && !prompt.includes(i));
    const typeField = q.typeField ?? a.typeField;
    return {
      ord: t.ord,
      name: t.name,
      prompt,
      answer,
      ...(typeField !== undefined ? { typeField } : {}),
      qfmt: t.qfmt,
      afmt: t.afmt,
    };
  });
}

/* --------------------------------------------------------------- utilities */

/**
 * Plain text, trimmed, case kept (for labels). Cloze deletions are read by
 * cloze.ts, the one cloze parser: "{{c1::Paris}} is…" → "Paris is…"
 * (stripHtml leaves cloze markup alone, see anki.ts).
 */
function plain(value: string | undefined): string {
  const raw = value ?? '';
  return stripHtml(raw.indexOf('{{c') >= 0 ? unwrapCloze(raw) : raw);
}

/** Plain, folded text for comparing values ("<b>Die</b>&nbsp;Stunde" → "die stunde"). */
function folded(value: string | undefined): string {
  return foldText(plain(value));
}

/** True when a field has nothing to show: no text, no image, no sound. */
function isBlank(value: string | undefined): boolean {
  if (!value) return true;
  if (/<img\b|\[sound:/i.test(value)) return false;
  return plain(value) === '';
}

function sameArray<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Anki note ids are big whole numbers as text: compare by length, then by text. */
function compareIdText(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Copy a FieldDef list (the plan never shares arrays with `choices`). */
const copyFields = (fields: readonly FieldDef[]): FieldDef[] => fields.map((f) => ({ ...f }));
const copyTemplates = (ts: readonly TemplateDef[]): TemplateDef[] =>
  ts.map((t) => ({ ...t, prompt: [...t.prompt], answer: [...t.answer] }));

/* ------------------------------------------------------------ card-type reuse */

type TypeChoice = ImportChoices['types'][string];

/** The field mapping a new card type gets: the learner's choice when it fits the model, else today's positions. */
function chosenFields(choice: TypeChoice | undefined, names: string[]): readonly FieldDef[] {
  return choice && choice.fields.length === names.length ? choice.fields : positionalFieldDefs(names);
}

/**
 * True when two field lists are mapped the same way: same role, filter
 * setting, label, language and multi-value separator for every field.
 * Labels compare ignoring case and accents ("WORD" = "Word").
 */
function sameFieldMapping(a: readonly FieldDef[], b: readonly FieldDef[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((f, i) => {
    const g = b[i];
    return (
      f.role === g.role &&
      f.facet === g.facet &&
      foldText(f.label ?? f.name) === foldText(g.label ?? g.name) &&
      (f.lang ?? '') === (g.lang ?? '') &&
      (f.multiSep ?? '') === (g.multiSep ?? '')
    );
  });
}

/** True when every wanted direction exists in `have` with the same question, answer and typing field. */
function sameDirections(have: readonly TemplateDef[], want: readonly TemplateDef[]): boolean {
  return want.every((w) => {
    const h = have.find((t) => t.ord === w.ord);
    return h !== undefined && sameArray(h.prompt, w.prompt) && sameArray(h.answer, w.answer) && h.typeField === w.typeField;
  });
}

/** The CSV signature of one card type of a CSV collection (with the card-type name when the file has a notetype column). */
function csvTypeSignature(collection: AnkiCollection, model: AnkiModel): string {
  const names = model.flds.map((f) => f.name);
  return csvSignature(names, collection.csv?.notetypeCol !== undefined ? model.name : undefined);
}

/**
 * The library card type that the file's card type `mid` reuses, or
 * undefined (the import makes a new one).
 *
 *   - An Anki model: the type made from the same model id, with the same
 *     field names and every template ord. It keeps its OWN roles: a
 *     re-import (or a newer pack version) must not split one deck over two
 *     card types. `choice` is not used, so the Fields screen should show this
 *     type's roles (W3-5).
 *   - A CSV card type: a type with the same CSV signature (the same columns)
 *     AND the same field mapping as `choice` (and the same directions when
 *     `choice.templates` is given). When the learner changed the mapping, no
 *     type is reused and the new one gets the learner's roles. A file
 *     without a header has the names "Field 1 … Field N", so this rule is
 *     what keeps two different headerless files of the same width apart.
 *     Without `choice`, the first type with the signature is returned: the
 *     Fields screen can call it that way to start from that type's roles.
 */
export function findReusableType(
  collection: AnkiCollection,
  mid: string,
  noteTypes: readonly NoteType[],
  choice?: TypeChoice,
): NoteType | undefined {
  const model = ownValue(collection.models, mid);
  if (!model || model.flds.length === 0) return undefined;
  const names = model.flds.map((f) => f.name);
  const kind: NoteType['kind'] = model.type === 1 ? 'cloze' : 'standard';
  const fits = (t: NoteType) => t.kind === kind && t.fields.length === names.length;
  if (collection.csv === undefined) {
    return noteTypes.find((t) => fits(t) && t.source?.ankiMid === mid && sameModelShape(t, names, model));
  }
  const signature = csvTypeSignature(collection, model);
  const candidates = noteTypes.filter((t) => fits(t) && t.source?.csvSignature === signature);
  if (!choice) return candidates[0];
  const wanted = chosenFields(choice, names);
  const templates = choice.templates;
  return candidates.find(
    (t) => sameFieldMapping(t.fields, wanted) && (templates === undefined || sameDirections(t.templates, templates)),
  );
}

/**
 * True when a library card type has the model's shape: the same field names
 * in the same order, and a direction for every template of the model. Such a
 * type is reused as it is (findReusableType).
 */
function sameModelShape(t: NoteType, names: readonly string[], model: AnkiModel): boolean {
  return (
    t.fields.length === names.length &&
    t.fields.every((f, i) => f.name === names[i]) &&
    model.tmpls.every((tm) => t.templates.some((tt) => tt.ord === tm.ord))
  );
}

/** True when no two names are the same (a field is found by its name). */
const uniqueNames = (names: readonly string[]): boolean => new Set(names).size === names.length;

/**
 * The library card type that a NEWER version of the file's Anki model `mid`
 * upgrades, or undefined (spec §5.6 rule 2, §9.6). That is a type made from
 * the same model id (`source.ankiMid`) that findReusableType does not reuse
 * as it is, because the model CHANGED: it has new fields (the German
 * vocabulary deck version 2 added `Type` and `Plural`), it lost fields
 * (version 3 removed `MarankiExample`), its fields are in another order, or
 * it has new directions. The type's sort field (the headword) must still be
 * in the model: it is what makes it the same card type.
 *
 * Why an upgrade and not a second card type: a newer version of a deck (a
 * starter deck update, or the same .apkg imported again) must keep ONE card
 * type per deck, and the notes already in the library must get the new
 * fields. Before, their new values were dropped, and only the NEW notes got a
 * second card type with every field.
 *
 * A field the model lost is removed only when no text is lost: see
 * upgradeNoteType `keep` and the reducer (`applyImport`).
 *
 * Not upgraded (a new card type is made, as before): a CSV; a model without
 * the type's sort field; another kind (standard / cloze); field names that
 * are not unique (a field is found by its name).
 */
export function findUpgradableType(
  collection: AnkiCollection,
  mid: string,
  noteTypes: readonly NoteType[],
): NoteType | undefined {
  if (collection.csv !== undefined) return undefined;
  const model = ownValue(collection.models, mid);
  if (!model || model.flds.length === 0) return undefined;
  const names = model.flds.map((f) => f.name);
  if (!uniqueNames(names)) return undefined;
  const kind: NoteType['kind'] = model.type === 1 ? 'cloze' : 'standard';
  return noteTypes.find((t) => {
    if (t.kind !== kind || t.source?.ankiMid !== mid || t.fields.length === 0) return false;
    const own = t.fields.map((f) => f.name);
    const sortName = own[t.sortField];
    return uniqueNames(own) && sortName !== undefined && names.includes(sortName) && !sameModelShape(t, names, model);
  });
}

/**
 * The library card type `existing` upgraded to the file's Anki model `mid`
 * (see findUpgradableType). null when the model is unknown or has no fields.
 *   - fields: the MODEL's fields, in the model's order. A field the type
 *     already has keeps its own definition (role, label, language, filter:
 *     the learner may have changed them on the deck page). A new field gets
 *     the learner's choice for it (`choice.fields`: the Fields stage, or the
 *     pack presets of a starter deck), else today's positions;
 *   - a field the model LOST is removed, except the ones in `keep` (the
 *     planner keeps a lost field while a note that the file does not update
 *     still has text in it). A kept field comes after the model's fields, in
 *     its old order, and is on no side of the card: the model's templates do
 *     not name it;
 *   - directions: read again from the model's templates with these fields
 *     (roles.ts `modelTemplates`: the same rules as for a new card type);
 *   - the sort field stays the same field (found by its name);
 *   - id, name, kind, source and createdAt stay; updatedAt = now.
 * The notes of the type get their values moved by name (noteOps
 * `remapFields`): the reducer does that for EVERY note of the type when it
 * applies the plan, so Note.fields stays aligned with NoteType.fields.
 *
 *   upgradeNoteType(v2, mid, vocabularyType, choice, now).fields.map((f) => f.name)
 *   → ['Word', 'Grammar', 'VerbForms', 'Examples', 'Translation', 'MarankiExample', 'Level', 'Type', 'Plural']
 *   upgradeNoteType(v3, mid, vocabularyTypeV2, choice, now).fields.map((f) => f.name)
 *   → ['Word', 'Grammar', 'VerbForms', 'Examples', 'Translation', 'Level', 'Type', 'Plural']
 *   upgradeNoteType(v3, mid, vocabularyTypeV2, choice, now, ['MarankiExample']).fields.map((f) => f.name)
 *   → ['Word', 'Grammar', 'VerbForms', 'Examples', 'Translation', 'Level', 'Type', 'Plural', 'MarankiExample']
 */
export function upgradeNoteType(
  collection: AnkiCollection,
  mid: string,
  existing: NoteType,
  choice: TypeChoice | undefined,
  now: number,
  keep: readonly string[] = [],
): NoteType | null {
  const model = ownValue(collection.models, mid);
  if (!model || model.flds.length === 0) return null;
  const names = model.flds.map((f) => f.name);
  const chosen = chosenFields(choice, names);
  const kept = existing.fields.filter((f) => keep.includes(f.name) && !names.includes(f.name));
  const fields = [
    ...names.map((name, i) => ({ ...(existing.fields.find((f) => f.name === name) ?? chosen[i]) })),
    ...kept.map((f) => ({ ...f })),
  ];
  const sortName = existing.fields[existing.sortField]?.name;
  const at = sortName === undefined ? -1 : names.indexOf(sortName);
  return {
    ...existing,
    fields,
    templates: modelTemplates(model, fields),
    sortField: at >= 0 ? at : Math.min(Math.max(0, model.sortf), names.length - 1),
    updatedAt: now,
  };
}

/**
 * The NEW card type the planner makes for the file's card type `mid` (when no
 * library type is reused, see findReusableType), or null when the model is
 * unknown or has no fields. The learner's field mapping (`choice.fields`, or
 * today's positions) and directions (`choice.templates`, or read from the
 * model) are used. For a CSV the columns chosen as Front and Back give the
 * directions and the sort field (`csvFrontBack`).
 *
 * The import screen (W3-5) calls it too, to draw the Fields stage's sample
 * card with EXACTLY the card type the import will make.
 *
 *   buildNoteType(csv, 'csv', { fields: [Level=badge, Word=term, Meaning=meaning], ords: [0] }, 't1', now)
 *   → { id: 't1', sortField: 1, templates: [{ ord: 0, prompt: [1], answer: [2] }, …], source: { csvSignature } … }
 */
export function buildNoteType(
  collection: AnkiCollection,
  mid: string,
  choice: TypeChoice | undefined,
  id: Id,
  now: number,
): NoteType | null {
  const model = ownValue(collection.models, mid);
  if (!model || model.flds.length === 0) return null;
  const isCsv = collection.csv !== undefined;
  const names = model.flds.map((f) => f.name);
  const fields = copyFields(chosenFields(choice, names));
  // A CSV has no real templates or sort field: the reader wrote today's
  // columns 0 and 1. Here the learner's Front and Back decide both, so
  // the question, the "already here" check and the overlap count all
  // use the column chosen as Front. An Anki model keeps its own, and so
  // does a CSV CLOZE type (csvRead.ts `clozeColumn`): its one template asks
  // the cloze column, and its cards are the cloze numbers of that column.
  let sortField = Math.min(Math.max(0, model.sortf), names.length - 1);
  let source = model;
  if (isCsv && model.type !== 1) {
    const { front, back } = csvFrontBack(fields);
    sortField = front;
    source = { ...model, tmpls: csvTemplates(names, front, back) };
  }
  return {
    id,
    name: model.name || deckNameFromFile(collection.fileName),
    kind: model.type === 1 ? 'cloze' : 'standard',
    fields,
    templates: choice?.templates ? copyTemplates(choice.templates) : templatesFromModel(source, fields, sortField),
    sortField,
    source: isCsv ? { csvSignature: csvTypeSignature(collection, model) } : { ankiMid: mid },
    createdAt: now,
    updatedAt: now,
  };
}

/** Where the Fields stage of the import screen starts, for one card type of the file (W3-5). */
export interface TypeStart {
  /** Source model id (the key of ImportChoices.types). */
  mid: string;
  /** The field roles to start from (a copy). */
  fields: FieldDef[];
  /** The directions to start with. */
  ords: number[];
  /**
   * The library card type this file's card type reuses, or null.
   * An Anki model imported before keeps its OWN roles (the planner ignores
   * `fields` then), so the screen shows them and lets the learner change
   * only the directions. A CSV card type with the same columns is reused only
   * while the roles stay the same.
   *
   * A library type made from an OLDER version of the model (findUpgradableType)
   * is given here AS IT WILL BE after the import (upgradeNoteType): its own
   * roles, plus the suggested roles of the new fields (`addedFields`).
   */
  reused: NoteType | null;
  /**
   * The names of the fields the import adds to `reused` (a newer version of
   * its Anki model). Absent or empty = no new field.
   */
  addedFields?: string[];
  /**
   * The names of the fields the newer model no longer has (the import removes
   * them, or keeps one where a card that the file does not update still has
   * text in it). Absent or empty = none.
   */
  removedFields?: string[];
}

/**
 * The starting point of the Fields stage for each card type of the draft
 * (roles.ts `suggestMapping`):
 *   - a card type the library already has (findReusableType without a
 *     choice) starts from THAT type's roles, so an unchanged mapping reuses
 *     it and a re-import never splits one deck over two card types;
 *   - a card type the library has from an OLDER version of the same model
 *     (findUpgradableType) starts from the type as the import will upgrade
 *     it: its own roles, the suggested roles for the new fields;
 *   - otherwise the suggested roles;
 *   - directions: every one of an Anki model (Anki behaviour, spec §5.9);
 *     a CSV only "Front → Back" ("Also make a reverse card" adds ord 1).
 *
 *   startingTypes(germanVerbs, suggestMapping(germanVerbs), [])[0]
 *   → { mid: '1700000002', fields: [Word=term, …], ords: [0, 1], reused: null }
 */
export function startingTypes(
  collection: AnkiCollection,
  draft: { types: readonly { mid: string; fields: readonly FieldDef[]; ords: readonly number[] }[] },
  noteTypes: readonly NoteType[],
): TypeStart[] {
  const isCsv = collection.csv !== undefined;
  return draft.types.map((t) => {
    const ords = isCsv ? [0] : [...t.ords];
    const reused = findReusableType(collection, t.mid, noteTypes) ?? null;
    if (reused) return { mid: t.mid, fields: copyFields(reused.fields), ords, reused };
    const older = findUpgradableType(collection, t.mid, noteTypes);
    const upgraded = older
      ? upgradeNoteType(collection, t.mid, older, { fields: copyFields(t.fields), ords }, older.updatedAt)
      : null;
    if (older && upgraded) {
      const had = new Set(older.fields.map((f) => f.name));
      const now = new Set(upgraded.fields.map((f) => f.name));
      const addedFields = upgraded.fields.filter((f) => !had.has(f.name)).map((f) => f.name);
      const removedFields = older.fields.filter((f) => !now.has(f.name)).map((f) => f.name);
      return {
        mid: t.mid,
        fields: copyFields(upgraded.fields),
        ords,
        reused: upgraded,
        addedFields,
        ...(removedFields.length > 0 ? { removedFields } : {}),
      };
    }
    return { mid: t.mid, fields: copyFields(t.fields), ords, reused: null };
  });
}

/**
 * Where the "already here" check (§5.6 rule 4) looks for a note of card type
 * `t` with the key `key` (`alreadyHereKey`):
 *   - an Anki card type: its own notes ('id:<type id>');
 *   - a CSV card type, key by its Front ('s:…'): the notes of EVERY CSV card
 *     type in the deck that has a field with the same folded NAME as this
 *     type's Front, keyed on that field ('name:<field name>'). So the same
 *     sheet imported again with another Front column (a new card type, Front
 *     = Translation) or with one more column (a new signature) still finds
 *     the rows it added before. Before, the keys were the OLD type's Front
 *     values under its column signature, and every row was added again;
 *   - a CSV card type, key by every field ('f:…', a blank Front): card types
 *     with the same columns ('csv:<signature>'), because the key lists the
 *     fields in column order.
 */
function hereBucket(t: NoteType, key: string): string {
  const signature = t.source?.csvSignature;
  if (signature === undefined) return `id:${t.id}`;
  if (key.startsWith('s:')) return `name:${foldText((t.fields[t.sortField]?.name ?? '').trim())}`;
  return `csv:${signature}`;
}

/**
 * The value the "already here" check (§5.6 rule 4) compares for one note:
 * its folded sort field ('s:…').
 *
 * When the sort field is BLANK, every field counts instead ('f:…'). Each
 * field is folded the SAME plain-text way as the sort field (`fieldKeyText`:
 * HTML and entities read, case and accents folded), so "<b>house</b>" and
 * "house&nbsp;" give the same key. A field with no text but an image or a
 * sound counts by its file names ("img:a.png"), so an image-only row is
 * still found again.
 * Why: a CSV row with an empty Front gets no "Front → Back" card, but with
 * "Also make a reverse card" it still gets "Back → Front", so it is imported.
 * With an empty key it would never be "already here", and every import of
 * the same file would add it again. With every field as the key, the same
 * row finds itself. '' = nothing to compare (no field has text or media).
 *
 *   alreadyHereKey(['<b>Haus</b>', 'house'], 0)    → 's:haus'
 *   alreadyHereKey(['', '<i>House</i>&nbsp;'], 0)  → 'f:\u001fhouse'
 *   alreadyHereKey(['', '<img src="a.png">'], 0)   → 'f:\u001fimg:a.png'
 *   alreadyHereKey(['', ''], 0)                    → ''
 */
export function alreadyHereKey(fields: readonly string[], sortField: number): string {
  const sort = folded(fields[sortField]);
  if (sort) return `s:${sort}`;
  const all = fields.map(fieldKeyText);
  return all.some((v) => v !== '') ? `f:${all.join('\u001f')}` : '';
}

/**
 * One field as the blank-sort-field key compares it: its folded plain text;
 * a field without text gives its images and sounds instead ("img:a.png
 * sound:b.mp3"), because stripHtml drops them.
 */
function fieldKeyText(value: string | undefined): string {
  const text = folded(value);
  if (text !== '') return text;
  const raw = value ?? '';
  const media = [...imageRefs(raw).map((n) => `img:${n}`), ...soundRefs(raw).map((n) => `sound:${n}`)];
  return media.join(' ');
}

/* -------------------------------------------------------------- the planner */

/** One source card type, resolved against the library. */
interface ResolvedType {
  type: NoteType;
  /** Enabled directions; null = every card (a cloze type). */
  ords: Set<number> | null;
  /** The field names of the file's model (for an update by field NAME). */
  srcNames: string[];
}

/** A note the plan adds, with its cards (placement is applied at the end). */
interface Pending {
  note: Note;
  cards: Card[];
  /** The note's field values as in the FILE (archive image names), for the media plan. */
  raw: string[];
}

/**
 * Plan an import. Pure: the same inputs (and the same `ctx.newId` sequence)
 * give the same plan.
 * Throws only when `choices.target` names a deck that does not exist.
 */
export function planImport(
  collection: AnkiCollection,
  library: PlanLibrary,
  choices: ImportChoices,
  ctx: PlanCtx,
): ImportPlan {
  const { now, srs } = ctx;
  const isCsv = collection.csv !== undefined;
  const origin: NonNullable<PlanCtx['origin']> = ctx.origin ?? { kind: isCsv ? 'csv' : 'apkg' };
  const ref = origin.ref ?? collection.fileName;

  /* ---- library indexes */
  const deckById = new Map<Id, Deck>(library.decks.map((d) => [d.id, d]));
  const typeById = new Map<Id, NoteType>(library.noteTypes.map((t) => [t.id, t]));
  const libCardsByNote = new Map<Id, Card[]>();
  for (const c of library.cards) {
    let list = libCardsByNote.get(c.noteId);
    if (!list) libCardsByNote.set(c.noteId, (list = []));
    list.push(c);
  }
  const deckOfNote = (noteId: Id): Id | undefined => libCardsByNote.get(noteId)?.[0]?.deckId;
  const notesByGuid = new Map<string, Note[]>();
  // The copies the app made of a file note (`copyGuid`), by the file note's guid.
  const copiesByGuid = new Map<string, Note[]>();
  for (const n of library.notes) {
    if (!n.guid || deckOfNote(n.id) === undefined) continue;
    let list = notesByGuid.get(n.guid);
    if (!list) notesByGuid.set(n.guid, (list = []));
    list.push(n);
    const origin = copyOrigin(n.guid);
    if (origin === null) continue;
    let copies = copiesByGuid.get(origin);
    if (!copies) copiesByGuid.set(origin, (copies = []));
    copies.push(n);
  }

  /* ---- the target deck */
  let targetId: Id;
  let newDeckId: Id | null = null;
  if (choices.target.kind === 'existing') {
    targetId = choices.target.deckId;
    if (!deckById.has(targetId)) throw new Error(`planImport: target deck ${targetId} does not exist`);
  } else {
    newDeckId = ctx.newId();
    targetId = newDeckId;
  }
  const targetExisting = newDeckId === null;

  /* ---- the chosen notes, their sections and their order */
  const home = noteHomeDids(collection);
  const rows = cardsByNote(collection);
  const chosen = collection.notes.filter((n) => choices.sections.has(home.get(n.id) ?? ''));
  // The section root is decided below (`root`), once the notes this file
  // already has in the target deck are known.
  // Source order: Anki's new-card position, then note id (`sourceOrder`).
  const ranked = sourceOrder(chosen, (n) => notePosition(rows.get(n.id) ?? []));
  let orderBase = 0;
  if (targetExisting) {
    for (const c of library.cards) if (c.deckId === targetId && Number.isFinite(c.newPos)) orderBase = Math.max(orderBase, c.newPos + 1);
  }
  const orderOf = new Map<string, number>(ranked.map((n, i) => [n.id, orderBase + i]));

  /* ---- card types */
  const typesAdd: NoteType[] = [];
  // No prototype: a model id "__proto__" is an ordinary key here.
  const reuse = Object.create(null) as Record<string, Id>;

  /**
   * The library note a file guid finds (§5.6 rules 2/3): the one in the target
   * deck first — the note itself, or a COPY of it made earlier (`copyGuid`:
   * "Import as copies here", "Add as a new deck"). So a copy is updated where
   * it is, and never added a second time, also after the original is gone.
   */
  const matchOf = (guid: string): { match: Note; inTarget: boolean } | null => {
    if (guid === '') return null;
    const matches = notesByGuid.get(guid) ?? [];
    const inTarget =
      matches.find((m) => deckOfNote(m.id) === targetId) ??
      (copiesByGuid.get(guid) ?? []).find((m) => deckOfNote(m.id) === targetId);
    const match = inTarget ?? matches[0];
    return match ? { match, inTarget: inTarget !== undefined } : null;
  };
  const guids = fileGuids(collection.notes);

  /* ---- the section root (§5.4) */
  // A new deck: the common prefix of the chosen subdecks. An EXISTING deck
  // that already holds notes of this file: their subdecks count too, and so
  // does the root their sections were cut from (`sectionCut`). So "A1 now,
  // A2 later" gives sections A1 and A2 (not '' twice), "B1 again, into the
  // deck that has the other levels" gives B1 (not ''), and the deck's
  // sections stay one consistent tree.
  const pathOfNote = (n: AnkiNote): string[] => {
    const did = home.get(n.id) ?? '';
    return did === '' ? [] : pathOf(ownValue(collection.decks, did) ?? '');
  };
  const earlier: { note: Note; path: string[]; cut: number | null }[] = [];
  if (targetExisting) {
    collection.notes.forEach((n, i) => {
      const found = matchOf(guids[i].guid);
      const path = found?.inTarget ? pathOfNote(n) : [];
      if (found && path.length > 0) earlier.push({ note: found.match, path, cut: sectionCut(path, found.match.section) });
    });
  }
  const rootPaths: string[][] = [];
  for (const did of new Set(chosen.map((n) => home.get(n.id) ?? ''))) {
    const path = did === '' ? [] : pathOf(ownValue(collection.decks, did) ?? '');
    if (path.length > 0) rootPaths.push(path);
  }
  for (const e of earlier) {
    rootPaths.push(e.path);
    // The root that note's section was cut from (may be [] = the whole path is its section).
    if (e.cut !== null) rootPaths.push(e.path.slice(0, e.cut));
  }
  const root = commonPrefix(rootPaths);
  const sectionOf = (n: AnkiNote): string => pathOfNote(n).slice(root.length).join('::');
  // A note of this file in the target deck whose section was cut from a
  // DEEPER root (an earlier import of fewer subdecks: A1 only → section '')
  // moves to its section under the deck's root now ('A1'). A section the
  // learner chose (not a tail of the file's path) is kept.
  const rerooted = new Map<Id, string>();
  for (const e of earlier) {
    if (e.cut !== null && e.cut > root.length) rerooted.set(e.note.id, e.path.slice(root.length).join('::'));
  }
  const walked = new Set<Id>(); // the library notes the walk below handles
  // The library notes this file updates in place (the walk below: same guid in
  // the target deck, or in another deck with "update").
  const covered = new Set<Id>();
  for (let i = 0; i < collection.notes.length; i++) {
    const n = collection.notes[i];
    if (!orderOf.has(n.id) || !(ownValue(collection.models, n.mid)?.flds.length ?? 0)) continue;
    const found = matchOf(guids[i].guid);
    if (found && (found.inTarget || choices.elsewhere === 'update')) covered.add(found.match.id);
  }

  // Upgrades first, before any note is read (they need no new id): a note
  // matched by guid may belong to a card type that a LATER model of the file
  // upgrades, and its update must be written in the upgraded field order.
  // An upgrade stays in the plan only when a note of the file lands on the
  // type (added, updated or matched: `usedUpgrades`).
  // A field the newer model LOST is removed, unless a note that this file
  // does not update (a retired note, the learner's own note) has text in it:
  // then it is kept (`keep`), so no text is ever lost. The notes the file
  // updates lose it either way: the newer version has no such field.
  const typesUpgrade: NoteTypeUpgrade[] = [];
  const upgradeOfMid = new Map<string, NoteType>();
  const upgradedById = new Map<Id, NoteType>(); // the library type id (it does not change) → the upgraded type
  const lostById = new Map<Id, Set<string>>(); // the library type id → the names of the fields its model lost
  const usedUpgrades = new Set<Id>();
  for (const mid of new Set(chosen.map((n) => n.mid))) {
    const choice = ownValue(choices.types, mid);
    if (findReusableType(collection, mid, library.noteTypes, choice)) continue;
    const older = findUpgradableType(collection, mid, library.noteTypes);
    if (!older || upgradedById.has(older.id)) continue;
    const modelNames = new Set((ownValue(collection.models, mid)?.flds ?? []).map((f) => f.name));
    const lost = older.fields.map((f, i) => ({ name: f.name, i })).filter((f) => !modelNames.has(f.name));
    const keep = lost
      .filter(({ i }) =>
        library.notes.some((n) => n.typeId === older.id && !covered.has(n.id) && fieldHasText(n.fields[i])),
      )
      .map((f) => f.name);
    const upgraded = upgradeNoteType(collection, mid, older, choice, now, keep);
    if (!upgraded) continue;
    if (
      JSON.stringify(upgraded.fields) === JSON.stringify(older.fields) &&
      upgraded.templates.every((ut) => older.templates.some((ot) => ot.ord === ut.ord))
    ) {
      // Nothing to change: the type already is this model plus the lost
      // fields it must keep (an earlier upgrade). Reused as it is; an import
      // after the last text there is gone removes them.
      upgradeOfMid.set(mid, older);
      continue;
    }
    upgradeOfMid.set(mid, upgraded);
    upgradedById.set(older.id, upgraded);
    lostById.set(older.id, new Set(lost.map((f) => f.name)));
    typesUpgrade.push({ type: upgraded, fromFields: older.fields.map((f) => f.name) });
  }

  const resolved = new Map<string, ResolvedType | null>();
  const resolveType = (mid: string): ResolvedType | null => {
    if (resolved.has(mid)) return resolved.get(mid) ?? null;
    const model = ownValue(collection.models, mid);
    if (!model || model.flds.length === 0) {
      resolved.set(mid, null);
      return null;
    }
    const names = model.flds.map((f) => f.name);
    const kind: NoteType['kind'] = model.type === 1 ? 'cloze' : 'standard';
    const choice = ownValue(choices.types, mid);
    const existing = findReusableType(collection, mid, library.noteTypes, choice) ?? upgradeOfMid.get(mid);
    let type: NoteType;
    if (existing) {
      type = existing;
      reuse[mid] = existing.id;
    } else {
      // The model has fields (checked above), so buildNoteType returns a type.
      type = buildNoteType(collection, mid, choice, ctx.newId(), now) as NoteType;
      typesAdd.push(type);
    }
    const defaultOrds = isCsv ? [0] : model.tmpls.map((t) => t.ord);
    const ords = kind === 'cloze' ? null : new Set(choice ? choice.ords : defaultOrds);
    const out = { type, ords, srcNames: names };
    resolved.set(mid, out);
    return out;
  };

  /* ---- duplicate lookups (built once) */
  const targetSortKeys = new Map<string, Set<string>>(); // hereBucket → alreadyHereKey of the target deck's notes
  const addHereKey = (bucket: string, key: string) => {
    let set = targetSortKeys.get(bucket);
    if (!set) targetSortKeys.set(bucket, (set = new Set()));
    set.add(key);
  };
  // folded headword → the decks (other than the target) that hold it, with the guids there.
  const headwords = new Map<string, { deckId: Id; guid: string }[]>();
  for (const n of library.notes) {
    const deckId = deckOfNote(n.id);
    const t = typeById.get(n.typeId);
    if (deckId === undefined || !t) continue;
    if (deckId === targetId) {
      const key = alreadyHereKey(n.fields, t.sortField);
      if (t.source?.csvSignature !== undefined) {
        // A CSV note counts under EVERY field name, keyed on that field (hereBucket).
        t.fields.forEach((f, i) => {
          const value = folded(n.fields[i]);
          if (value) addHereKey(`name:${foldText(f.name.trim())}`, `s:${value}`);
        });
        if (key.startsWith('f:')) addHereKey(hereBucket(t, key), key);
      } else if (key) {
        addHereKey(hereBucket(t, key), key);
      }
    } else {
      const key = folded(n.fields[t.sortField]);
      if (!key) continue;
      let list = headwords.get(key);
      if (!list) headwords.set(key, (list = []));
      list.push({ deckId, guid: n.guid });
    }
  }

  /** A copy guid for the file guid in the target deck that no library note has yet ("~2", "~3" … when taken). */
  const taken = new Set(library.notes.map((n) => n.guid));
  const freeCopyGuid = (fileGuid: string): string => {
    const base = copyGuid(fileGuid, targetId);
    let out = base;
    for (let k = 2; taken.has(out); k++) out = `${base}~${k}`;
    taken.add(out);
    return out;
  };

  /* ---- image names in the deck folders (ctx.mediaName) */
  const listed = new Set<string>();
  for (const key of Object.keys(collection.media)) {
    const name = collection.media[key];
    if (typeof name === 'string' && name) listed.add(name);
  }
  const renamesByDeck = new Map<Id, Map<string, string>>(); // deck → archive name → its name in the deck folder
  /** File values → the values a note in deck `deckId` stores: an image whose name is taken there points at its own name. */
  const inFolderOf = (deckId: Id) => (value: string): string => {
    const mediaName = ctx.mediaName;
    if (!mediaName || value.indexOf('<') < 0) return value;
    return renameImageRefs(value, (ref) => {
      const name = archiveNameOf(ref, listed);
      if (!listed.has(name) || !isSafeMediaName(name) || !isImageName(name)) return undefined;
      const there = mediaName(deckId, name);
      if (there === name || !isSafeMediaName(there)) return undefined;
      let renames = renamesByDeck.get(deckId);
      if (!renames) renamesByDeck.set(deckId, (renames = new Map()));
      renames.set(name, there);
      return there;
    });
  };

  /* ---- walk the notes */
  const skipped: ImportSkips = { alreadyHere: 0, elsewhere: 0, overlap: 0, empty: 0 };
  const pending: Pending[] = [];
  const updates: ImportPlan['notes']['update'] = [];
  const newCardsOfUpdates: Card[] = [];
  const matchedFields = new Map<Id, string[]>(); // deck → field values of the notes matched by guid there (media)
  const updatedDeckIds: Id[] = [];
  const overlapByDeck = new Map<Id, number>();
  let inTargetDeck = 0;
  let inOtherDecks = 0;
  let notesUnchanged = 0;
  // The notes matched by guid that the file leaves as they are, and the CSV
  // rows that are already here: they still count for "Filters found" (the
  // file HAS those filter groups).
  const unchangedNotes: Note[] = [];
  let cardsUpdated = 0;
  let guidsRenamed = 0;
  let progressCards = 0;

  /** The cards a note gets: enabled directions that the file has (CSV: with a non-blank question). */
  const sourceCards = (n: AnkiNote, rt: ResolvedType, fields: readonly string[]): AnkiCard[] =>
    (rows.get(n.id) ?? []).filter((c) => {
      if (rt.ords === null) return true; // cloze: every card of the note
      if (!rt.ords.has(c.ord)) return false;
      const tmpl = rt.type.templates.find((t) => t.ord === c.ord);
      if (!tmpl) return false;
      if (isCsv && tmpl.prompt.length > 0 && tmpl.prompt.every((i) => isBlank(fields[i]))) return false;
      return true;
    });

  /** One new card from a file card row. Counts the rows that carry Anki progress (before 'reset'). */
  const buildCard = (
    note: Pick<Note, 'id' | 'order'>,
    row: AnkiCard,
    deckId: Id,
    marked: boolean,
    newPos: number,
  ): Card => {
    if (hasAnkiProgress(row)) progressCards += 1;
    const mapped = mapAnkiCard(row, {
      crt: collection.crt,
      progress: choices.progress,
      arrival: choices.arrival,
      newPos,
      marked,
      srs,
      now,
    });
    return makeCard(note, row.ord, deckId, srs, now, { id: ctx.newId(), ...mapped });
  };

  for (let noteIdx = 0; noteIdx < collection.notes.length; noteIdx++) {
    const n = collection.notes[noteIdx];
    if (!orderOf.has(n.id)) continue; // not in a chosen section
    const rt = resolveType(n.mid);
    if (!rt) {
      skipped.empty += 1;
      continue;
    }
    const type = rt.type;
    const marked = n.tags.some(isMarkedTag);
    const tags = n.tags.filter((t) => !isMarkedTag(t));
    const fields = type.fields.map((_, i) => n.flds[i] ?? '');

    // 1. In-file duplicate guid → the derived guid of `fileGuids` (counted
    //    in guidsRenamed only when the note is really added). The library
    //    checks below use it, so a re-import finds the earlier copy.
    const fileGuid = guids[noteIdx].guid;
    const renamed = guids[noteIdx].renamed;
    let guid = fileGuid;

    // 2./3. Same guid in the library.
    let asCopy = false;
    if (guid !== '') {
      const found = matchOf(guid);
      if (found) {
        const { match, inTarget } = found;
        if (inTarget) inTargetDeck += 1;
        else inOtherDecks += 1;
        if (!inTarget && choices.elsewhere === 'skip') {
          skipped.elsewhere += 1;
          continue;
        }
        if (inTarget || choices.elsewhere === 'update') {
          // Update in place: fields + tags; cards and progress stay.
          // Same card type → field by field. Another type → by field NAME; a
          // field the file lacks keeps its value. (A note whose type is gone
          // keeps all its fields: checkIntegrity repairs it, not the import.)
          // A type this plan upgrades counts in its NEW field order: the
          // reducer moves the note there first (`before`), then writes this.
          // A field its model LOST gets '' here (the newer version has no
          // text for it); a field kept by an EARLIER upgrade keeps its value.
          const libraryType = typeById.get(match.typeId);
          const upgraded = upgradedById.get(match.typeId);
          const lost = lostById.get(match.typeId);
          const existingType = upgraded ?? libraryType;
          const before =
            upgraded && libraryType
              ? remapFields(
                  match.fields,
                  libraryType.fields.map((f) => f.name),
                  upgraded.fields.map((f) => f.name),
                )
              : match.fields;
          if (upgraded) usedUpgrades.add(upgraded.id);
          const sameType = existingType?.id === type.id;
          const srcNames = rt.srcNames;
          const matchDeck = deckOfNote(match.id) as Id;
          // The file's values in that deck's folder (an image whose name is
          // taken there by another picture points at its own name, which this
          // import writes). With "Include images" off nothing is written, so
          // an updated note keeps the name it has (most likely its own older
          // picture), instead of pointing at a file that never comes.
          const fileValue = inFolderOf(matchDeck);
          const nextOf = (val: (v: string) => string): string[] =>
            sameType
              ? fields.map((v, i) => (i < srcNames.length || lost ? val(v) : (before[i] ?? '')))
              : existingType
                ? existingType.fields.map((f, i) => {
                    const j = fieldIndex(srcNames, f.name);
                    if (j >= 0) return val(n.flds[j] ?? '');
                    return lost?.has(f.name) ? '' : (before[i] ?? '');
                  })
                : match.fields;
          const nextRaw = nextOf((v) => v);
          const nextFields = ctx.mediaName && choices.images ? nextOf(fileValue) : nextRaw;
          // Text in a lost field is a change even when the upgraded type has
          // no place for it: the reducer removes a field only from notes that
          // are updated or have no text in it.
          const losesText =
            lost !== undefined &&
            libraryType !== undefined &&
            libraryType.fields.some((f, i) => lost.has(f.name) && fieldHasText(match.fields[i]));
          const ownCards = libCardsByNote.get(match.id) ?? [];
          if (sameType && existingType) {
            const have = new Set(ownCards.map((c) => c.ord));
            const sharedPos = ownCards[0]?.newPos ?? match.order;
            for (const row of sourceCards(n, rt, nextFields)) {
              if (have.has(row.ord)) continue;
              newCardsOfUpdates.push(buildCard(match, row, matchDeck, marked, sharedPos));
            }
          }
          // A starter deck follows its file's subdecks (choices.followSections): a
          // note that the file moved to another subdeck moves to that section.
          // An import into the deck that holds an earlier import of fewer
          // subdecks moves it under the deck's root (`rerooted`).
          walked.add(match.id);
          const section =
            choices.followSections && inTarget ? sectionOf(n) : ((inTarget ? rerooted.get(match.id) : undefined) ?? match.section);
          if (!losesText && sameArray(nextFields, before) && sameArray(tags, match.tags) && section === match.section) {
            notesUnchanged += 1;
            unchangedNotes.push({ ...match, fields: [...before] });
          } else {
            updates.push({
              id: match.id,
              fields: [...nextFields],
              tags: [...tags],
              ...(section !== match.section ? { section } : {}),
            });
            cardsUpdated += ownCards.length;
            if (!updatedDeckIds.includes(matchDeck)) updatedDeckIds.push(matchDeck);
          }
          let deckValues = matchedFields.get(matchDeck);
          if (!deckValues) matchedFields.set(matchDeck, (deckValues = []));
          deckValues.push(...nextRaw);
          continue;
        }
        asCopy = true; // 'copy': a new note with a copy guid (below)
      }
    }

    // 4. No guid: already here when the target deck has the same sort field
    //    (every field, when the sort field is blank: `alreadyHereKey`).
    if (guid === '') {
      const key = alreadyHereKey(fields, type.sortField);
      if (key && targetSortKeys.get(hereBucket(type, key))?.has(key)) {
        skipped.alreadyHere += 1;
        // Still a row of the file (only for "Filters found"; never applied).
        unchangedNotes.push(makeNote({ id: '', typeId: type.id, fields, tags, section: sectionOf(n), guid: '' }, now));
        continue;
      }
    }

    // A new note. No card → nothing to import.
    const cardRows = sourceCards(n, rt, fields);
    if (cardRows.length === 0) {
      skipped.empty += 1;
      continue;
    }

    // 5. Same headword in another deck with a different guid.
    const hw = folded(fields[type.sortField]);
    let overlaps = false;
    if (hw) {
      const seenDecks = new Set<Id>();
      for (const h of headwords.get(hw) ?? []) {
        if (h.guid === fileGuid || seenDecks.has(h.deckId)) continue;
        seenDecks.add(h.deckId);
        overlapByDeck.set(h.deckId, (overlapByDeck.get(h.deckId) ?? 0) + 1);
        overlaps = true;
      }
    }
    if (overlaps && choices.skipOverlap) {
      skipped.overlap += 1;
      continue;
    }

    if (renamed) guidsRenamed += 1;
    if (guid === '') guid = `m-${ctx.newId()}`;
    else if (asCopy) guid = freeCopyGuid(guid);
    const order = orderOf.get(n.id) as number;
    const note = makeNote(
      {
        id: ctx.newId(),
        typeId: type.id,
        fields: ctx.mediaName ? fields.map(inFolderOf(targetId)) : fields,
        tags,
        section: sectionOf(n),
        guid,
        order,
        source: { kind: origin.kind, ref, ...(isCsv ? {} : { ankiNoteId: n.id }) },
      },
      now,
    );
    const cards = cardRows.map((row) => buildCard(note, row, targetId, marked, order));
    pending.push({ note, cards, raw: fields });
    if (upgradedById.has(type.id)) usedUpgrades.add(type.id);
  }
  const upgrade = typesUpgrade.filter((u) => usedUpgrades.has(u.type.id));

  // The notes of this file in the target deck that are NOT in the chosen
  // sections, but whose section moves under the deck's root (`rerooted`):
  // only their section changes (fields in the order of an upgrade of this plan).
  const libNoteById = new Map<Id, Note>(library.notes.map((n) => [n.id, n]));
  for (const [noteId, section] of rerooted) {
    const note = libNoteById.get(noteId);
    if (walked.has(noteId) || !note || section === note.section) continue;
    walked.add(noteId);
    const libraryType = typeById.get(note.typeId);
    const upgraded = upgradedById.get(note.typeId);
    const fields =
      upgraded && libraryType && usedUpgrades.has(upgraded.id)
        ? remapFields(
            note.fields,
            libraryType.fields.map((f) => f.name),
            upgraded.fields.map((f) => f.name),
          )
        : note.fields;
    updates.push({ id: note.id, fields: [...fields], tags: [...note.tags], section });
    cardsUpdated += libCardsByNote.get(note.id)?.length ?? 0;
    if (!updatedDeckIds.includes(targetId)) updatedDeckIds.push(targetId);
  }

  /* ---- filter groups and "Where do you start?" */
  // Upgraded types in their new form: the updated notes are in its field order.
  const upgradedNow = new Map<Id, NoteType>(upgrade.map((u) => [u.type.id, u.type]));
  const allTypes = [...library.noteTypes.map((t) => upgradedNow.get(t.id) ?? t), ...typesAdd];
  const addedNotes = pending.map((p) => p.note);
  const updatedById = new Map(updates.map((u) => [u.id, u]));
  const upgradeFrom = new Map<Id, { from: readonly string[]; to: string[] }>(
    upgrade.map((u) => [u.type.id, { from: u.fromFields, to: u.type.fields.map((f) => f.name) }]),
  );
  const updatedNotes: Note[] = [];
  // The library as it is AFTER this import: updated notes with their new
  // values, notes of an upgraded type with their values moved by name (the
  // reducer does the same, applyImport), then the added notes.
  const libraryAfter: Note[] = [];
  for (const n of library.notes) {
    const u = updatedById.get(n.id);
    if (u) {
      const updated = { ...n, fields: u.fields, tags: u.tags, section: u.section ?? n.section };
      updatedNotes.push(updated);
      libraryAfter.push(updated);
      continue;
    }
    const up = upgradeFrom.get(n.typeId);
    libraryAfter.push(up ? { ...n, fields: remapFields(n.fields, up.from, up.to) } : n);
  }
  libraryAfter.push(...addedNotes);
  // Every note of the file that lands in the library: added, updated, or
  // matched and unchanged. "Filters found" describes the FILE, so a re-import
  // that changes nothing still finds its Level filter (it was 'none').
  const importedNotes = [...addedNotes, ...updatedNotes, ...unchangedNotes];
  // The filter groups the Library WILL have: the data rule runs over the
  // whole library after the import (as buildLibraryIndex does), not over the
  // imported notes alone. Otherwise the Preview could promise a group ("Filters
  // found: Level") that the Library does not show, or the other way round.
  // Which groups are SHOWN still depends on the imported notes (≥ 2 values, below).
  const specs = ctx.fieldFacetSpecs(allTypes, libraryAfter);
  const valueIn = (spec: FacetFieldSpec, note: Note): string | undefined => {
    const idx = spec.fieldIndexByType.get(note.typeId);
    return idx === undefined ? undefined : plain(note.fields[idx]);
  };

  // The partition a group makes of the imported notes (for the equivalence collapse, §4.3).
  const sameSplit = (a: (n: Note) => string, b: (n: Note) => string): boolean => {
    const ab = new Map<string, string>();
    const ba = new Map<string, string>();
    for (const n of importedNotes) {
      const x = a(n);
      const y = b(n);
      if ((ab.has(x) && ab.get(x) !== y) || (ba.has(y) && ba.get(y) !== x)) return false;
      ab.set(x, y);
      ba.set(y, x);
    }
    return true;
  };

  const filtersFound: string[] = [];
  // One entry per label: a field named "Tags" and the notes' Anki tags would
  // otherwise both say "Tags" ("Filters found: Level, Tags, Tags").
  const addFilter = (label: string) => {
    const key = foldText(label.trim());
    if (!filtersFound.some((l) => foldText(l.trim()) === key)) filtersFound.push(label);
  };
  const placementGroups: ImportSummary['placementGroups'] = [];
  const shownFieldGroups: FacetFieldSpec[] = [];
  for (const spec of specs.values()) {
    // A group needs ≥ 2 values in the imported notes (§4.3 rule 3).
    const values = new Set<string>();
    for (const n of importedNotes) {
      const v = valueIn(spec, n);
      if (v === undefined || v === '') continue;
      if (spec.multiSep) for (const part of v.split(spec.multiSep)) values.add(foldText(part.trim()));
      else values.add(foldText(v));
      if (values.size >= 2) break;
    }
    if (values.size < 2) continue;
    addFilter(spec.label);
    shownFieldGroups.push(spec);
    if (spec.multiSep) continue;
    const labels = new Map<string, string>(); // folded → first spelling
    for (const n of addedNotes) {
      const v = valueIn(spec, n);
      if (v && !labels.has(foldText(v))) labels.set(foldText(v), v);
    }
    const ordinal = labels.size >= 2 ? ctx.detectOrdinal([...labels.values()]) : null;
    if (ordinal) {
      const sorted = [...labels.values()].sort((x, y) => ordinal.rank(x) - ordinal.rank(y));
      placementGroups.push({ facet: `field:${spec.key}`, label: spec.label, values: sorted });
    }
  }
  const sectionsAdded = new Set(addedNotes.map((n) => n.section).filter((s) => s !== ''));
  const sectionsFound = new Set(importedNotes.map((n) => n.section).filter((s) => s !== ''));
  const sectionLikeField = shownFieldGroups.some(
    (spec) => !spec.multiSep && sameSplit((n) => n.section, (n) => foldText(valueIn(spec, n) ?? '')),
  );
  if (sectionsFound.size >= 2 && !sectionLikeField) {
    addFilter('Section');
    // "Where do you start?" by section ranks the LAST level of each path
    // ("Vocabulary::A1", "Verbs::A2" → A1, A2), so nested sections can offer
    // it too (§4.3: section tree levels use the ordinal sort). A flat
    // section is its own last level.
    const levels = new Map<string, string>(); // folded → first spelling
    for (const s of sectionsAdded) {
      const level = lastLevel(s);
      if (level !== '' && !levels.has(foldText(level))) levels.set(foldText(level), level);
    }
    const ordinal = levels.size >= 2 ? ctx.detectOrdinal([...levels.values()]) : null;
    if (ordinal) {
      const sorted = [...levels.values()].sort((x, y) => ordinal.rank(x) - ordinal.rank(y));
      placementGroups.push({ facet: 'section', label: 'Section', values: sorted });
    }
  }
  if (importedNotes.some((n) => n.tags.length > 0)) addFilter('Tags');

  /* ---- apply placement (only to the NEW cards of added notes) */
  // placeRank(note) = the note's index in the chosen group's values, or undefined.
  let placeRank: ((note: Note) => number | undefined) | null = null;
  const placement = choices.placement;
  const group = placement ? placementGroups.find((g) => g.facet === placement.facet) : undefined;
  if (
    placement &&
    group &&
    Number.isInteger(placement.fromRank) &&
    placement.fromRank >= 0 &&
    placement.fromRank <= group.values.length
  ) {
    const rankOfValue = new Map(group.values.map((v, i) => [foldText(v), i]));
    if (group.facet === 'section') {
      placeRank = (note) => rankOfValue.get(foldText(lastLevel(note.section)));
    } else {
      const spec = [...specs.values()].find((s) => `field:${s.key}` === group.facet);
      if (spec) placeRank = (note) => rankOfValue.get(foldText(valueIn(spec, note) ?? ''));
    }
  }
  const cardsAdd: Card[] = [];
  for (const p of pending) {
    const r = placement && placeRank ? placeRank(p.note) : undefined;
    const mode = placement && r !== undefined && r < placement.fromRank ? placement.below : null;
    for (const c of p.cards) {
      if (mode === 'known' && c.reps === 0) cardsAdd.push({ ...c, knownAt: now });
      else if (mode === 'notStarted' && c.reps === 0) cardsAdd.push({ ...c, newState: 'notStarted' });
      else cardsAdd.push(c);
    }
  }
  cardsAdd.push(...newCardsOfUpdates);

  /* ---- the deck and the images */
  const deck: Deck | null =
    newDeckId !== null && pending.length > 0
      ? makeDeck(
          {
            id: newDeckId,
            name: (choices.target.kind === 'new' ? choices.target.name.trim() : '') || suggestDeckName(collection, choices.sections),
            icon: (choices.target.kind === 'new' ? choices.target.icon : '') || undefined,
            source: origin.kind,
            sourceKey: origin.sourceKey ?? `file:${collection.fileName}`,
            order: nextDeckOrder(library.decks),
            options: { newArrival: choices.arrival },
          },
          now,
        )
      : null;
  const landsInTarget = targetExisting || deck !== null;
  // The target deck first (added notes + notes matched there), then every
  // other deck that holds a note updated where it is.
  const mediaDecks: DeckMediaInput[] = [];
  if (landsInTarget) {
    const values: string[] = [];
    for (const p of pending) values.push(...p.raw);
    values.push(...(matchedFields.get(targetId) ?? []));
    mediaDecks.push({ deckId: targetId, fieldValues: values });
  }
  for (const [deckId, values] of matchedFields) if (deckId !== targetId) mediaDecks.push({ deckId, fieldValues: values });
  const media = planDeckMedia({
    decks: mediaDecks,
    manifest: collection.media,
    sizeOf: (name) => collection.mediaSize?.(name) ?? collection.mediaBytes?.(name)?.length ?? null,
    include: choices.images,
  });
  // A file whose name is taken in its folder is written under its own name.
  const mediaFolders: ImportMediaFolder[] = [];
  for (const deckId of new Set(mediaDecks.map((d) => d.deckId))) {
    const folder = media.folders.find((f) => f.deckFolder === mediaFolder(deckId));
    if (!folder) continue;
    const renames = renamesByDeck.get(deckId);
    const renamed: { name: string; from: string }[] = [];
    const files = folder.files.map((name) => {
      const there = renames?.get(name);
      if (there === undefined) return name;
      renamed.push({ name: there, from: name });
      return there;
    });
    mediaFolders.push(renamed.length > 0 ? { deckFolder: folder.deckFolder, files, renamed } : { deckFolder: folder.deckFolder, files });
  }

  /* ---- the summary, counted from the plan */
  const overlap = [...overlapByDeck.entries()]
    .map(([deckId, count]) => ({ deckId, deckName: deckById.get(deckId)?.name ?? '', notes: count }))
    .sort((a, b) => b.notes - a.notes || (a.deckName < b.deckName ? -1 : a.deckName > b.deckName ? 1 : 0));
  const notesSkipped = skipped.alreadyHere + skipped.elsewhere + skipped.overlap + skipped.empty;
  const summary: ImportSummary = {
    notesAdded: pending.length,
    cardsAdded: cardsAdd.length,
    sections: sectionsAdded.size,
    filtersFound,
    inTargetDeck,
    inOtherDecks,
    notesUpdated: updates.length,
    notesUnchanged,
    cardsUpdated,
    // Distinct names: two decks may share a name, and the Done line lists each name once.
    updatedDecks: [...new Set(updatedDeckIds.map((id) => deckById.get(id)?.name ?? ''))],
    cardTypesUpdated: upgrade.length,
    // The planner never retires a note: only a starter deck update does (starterDecks.ts).
    notesRetired: 0,
    notesSkipped,
    skipped,
    guidsRenamed,
    overlap,
    progressCards,
    suspended: cardsAdd.filter((c) => c.suspended).length,
    newCards: cardsAdd.filter((c) => c.reps === 0).length,
    notStarted: cardsAdd.filter((c) => c.reps === 0 && c.knownAt == null && c.newState === 'notStarted').length,
    markedKnown: cardsAdd.filter((c) => c.knownAt != null).length,
    placementGroups,
    images: media.folders.reduce((sum, f) => sum + f.files.length, 0),
    imageBytes: media.bytes,
    imagesFound: media.found,
    imagesFoundBytes: media.foundBytes,
    imagesAskFirst: media.askFirst,
    audioClips: media.audioClips,
  };

  // A new card type whose notes were all skipped or matched is not added.
  const usedTypeIds = new Set(addedNotes.map((n) => n.typeId));
  return {
    noteTypes: { add: typesAdd.filter((t) => usedTypeIds.has(t.id)), reuse, upgrade },
    notes: { add: addedNotes, update: updates, retire: [] },
    cards: { add: cardsAdd },
    deck,
    media: mediaFolders,
    summary,
  };
}
