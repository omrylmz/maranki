/**
 * The facet engine (spec §4.3): the FILTER GROUPS that the data really has,
 * with counts, for the FacetSheet ("Filters").
 *
 * A filter group ("facet") is one way to narrow a card list: Level, Section,
 * Deck, Card type, Direction, Tags, and the built-in Status / Due / Markers /
 * Hard / Recent / Leech. Nothing is hard-coded per language: a field is a
 * group because its VALUES look like one (fieldFacetSpecs, libraryIndex.ts),
 * and a group with no data in the scope does not exist.
 *
 * Inputs of `deriveFacets(pool, scope, selection, ctx)`:
 *   pool       the cards to look at (usually every card)
 *   scope      where you are (a deck, a list, "All"): applied in full
 *   selection  the chips you added: counted "disjunctively" (below)
 *
 * DISJUNCTIVE COUNTS (why "No matches" cannot happen). The count of value v
 * of group F = cards in scope that match every selected group EXCEPT F, and
 * have v. So after picking Level A1 you still see A2's real count, and can
 * pick A1 + A2. It is computed in ONE pass, not one pass per group: for each
 * card, test every selected group once;
 *   fails 0 groups  → add the card to every group's value counts;
 *   fails 1 group G → add it to G's value counts only;
 *   fails 2 or more → skip it.
 * Cost O(cards × groups). (flags is an AND: each flag is its own group.)
 *
 * When is a group SHOWN:
 *   field      ≥ 2 values with count > 0. With exactly one value that covers
 *              every counted card it becomes an INFO line: "All cards here are B1."
 *   section    the counted cards are in ≥ 2 sections. The deck root is NOT a
 *              section: 2 notes in "Verbs" + 2 at the root is ONE section → no group.
 *   deck       ≥ 2 decks
 *   noteType   ≥ 2 card types ("Card type")
 *   direction  ≥ 2 ords whose labels differ (cloze ords share one template name),
 *              and not when the ords split the cards exactly like a shown
 *              field, section level or card type (it would add nothing)
 *   tag        some tag exists and it is not one single tag on every card
 *   built-ins  always: Status, Due, Markers, Hard, Recent, Leech
 * A group with a SELECTED value is always shown, and a selected value stays
 * visible with count 0, so it can be removed. Other values with count 0 are hidden.
 *
 * LABELS. A field group is labelled with the field's label (a label a card
 * type chose, like the German pack's "Verb type", wins; else the field name
 * made readable: "WordType" → "Word Type", never the raw name), but never
 * with the label of another group: a field called "Tags" next to the note
 * tags ("Tags") becomes "Tags (German Verbs)" — the card type that has it
 * (fieldGroupLabel). The label is only text: the group is found by its key
 * (`field:<folded name>`). Direction values are "German → English" when the
 * languages are known: from the fields' `lang`, and for card types made in
 * the app or from CSV (no Anki model) from the deck's `language` /
 * `meaningLanguage` (spec §3.4), when every deck agrees. When card types
 * with different template names share a direction, every direction is named
 * by its role: "Front → Back" / "Back → Front" (directionLabels).
 * Labels come from the SCOPED cards, so they do not change while the user picks.
 *
 * FIELD NAMES ARE USER DATA (see query.ts): a selection is read with
 * `ownValue` and written with `fieldRecord`, so a field called "Constructor"
 * works like any other.
 *
 * EQUIVALENCE COLLAPSE: when two groups split the scoped cards into exactly
 * the same parts, only the higher one is shown: field > section > noteType.
 * Coding: Category == section → only Category. German: card type == the first
 * section level → card type hidden. Spanish: Level == section → only Level.
 * It never hides a choice the user still needs (canHideBehind):
 *   - field > section compares the field with the FULL section paths (the
 *     finest parts of the tree). A field that equals only the first level
 *     ("Core" / "DP") keeps the tree, so "Core › Topic Alpha" can be picked.
 *   - section > noteType compares the card type with each tree level, but
 *     only when the section group is really shown.
 *   - a part that cannot be picked in the higher group (cards with no field
 *     value, cards at the deck root) must not be pickable in the lower group.
 *
 * VALUE ORDER: ordinal values by rank (A1 < A2 < B1, ordinal.ts), otherwise
 * count (largest first), then label. Tree levels use the same rule. Decks keep
 * the deck order; directions keep ord order; the built-ins keep their fixed order.
 *
 * Facet order in the result = the FacetSheet order of spec §8.3: Status, Due,
 * Markers, Hard, Recent, Leech, then Deck, Section, fields (ordinal groups
 * like Level first, then by label), Tags, Card type, Direction. The same in
 * every library and scope.
 *
 * Budget (spec §4.3): < 150 ms for 16,000 cards in node (facets.perf.test.ts).
 * The UI computes counts only while the FacetSheet is open, memoized on
 * (scope, selection, cards, index).
 *
 * SPEED (unit P1; the release build needed 94–133 ms per opening on 16,260
 * cards, budget 80). What a count reads of a NOTE (its section and tag
 * prefixes, its field values, its "part" for the collapse) is made once per
 * note object (NoteFacets), not again on every count. The equivalence
 * collapse looks at one card per distinct (deck, note part, direction)
 * (ScopedPart) instead of every card — it only asks which pairs of keys
 * occur, so the answer is the same. The flag tests are written out. The
 * result is exactly the one before (facets.test.ts pins it).
 *
 * Pure: no React, no clock (`ctx.now`).
 */
import type { LibraryIndex } from './libraryIndex';
import { fieldFacetSpecs, pathPrefixes } from './libraryIndex';
import { isBuried, life, LIFE_KEYS, LIFE_LABELS } from './life';
import type { Card, Deck, FacetFieldSpec, FlagKey, Id, LifeKey, Note, NoteType, Query, TemplateDef } from './model';
import { compareLabels, detectOrdinal, type Ordinal, type OrdinalKind, sortByOrdinalOrCount } from './ordinal';
import type { GroupId, MatchCtx } from './query';
import {
  compileGroups,
  compileQuery,
  endOfLocalDay,
  fieldRecord,
  FLAG_KEYS,
  isHard,
  isLeech,
  isYoung,
  ownValue,
  sanitizeQuery,
} from './query';
import { humanizeFieldName, resolveFieldLang } from './render';
import { foldText } from './text';

/* Re-exported so callers find the whole facet API in this file (spec §4.3). */
export { detectOrdinal, fieldFacetSpecs };
export type { OrdinalKind };

/**
 * The key of one facet. `field:<folded name>` for field groups.
 * 'hard' | 'young' | 'leech' are the three toggles (spec: "plus Hard / Recent
 * / Leech toggles") — added to the spec's union so each toggle chip can open
 * its own facet.
 */
export type FacetKey =
  | 'life'
  | 'due'
  | 'flags'
  | 'deck'
  | 'section'
  | 'noteType'
  | 'direction'
  | 'tag'
  | 'hard'
  | 'young'
  | 'leech'
  | `field:${string}`;

export interface FacetValue {
  /** What `toggleFacetValue` puts in the query (a deck id, a folded value, a section value …). */
  value: string;
  label: string;
  count: number;
  selected: boolean;
  /** The ordinal rank (ordinal.ts) when the facet is ordinal. */
  rank?: number;
  /** Tree facets (section, tag): the child nodes. */
  children?: FacetValue[];
}

export interface Facet {
  key: FacetKey;
  label: string;
  kind: 'list' | 'tree';
  ordinal: OrdinalKind | null;
  values: FacetValue[];
  /** True when the facet needs a search box (more than 30 tags). */
  searchable: boolean;
  /**
   * Set when the "group" has only one value that covers every card: the UI
   * shows this line ("All cards here are B1.") instead of a selectable group.
   */
  info?: string;
}

/* ------------------------------------------------------------- constants */

/** The tag group gets a search box above this many tags (spec §4.3). */
export const TAG_SEARCH_MIN = 30;

const FACET_LABELS: Record<Exclude<FacetKey, `field:${string}`>, string> = {
  deck: 'Deck',
  section: 'Section',
  noteType: 'Card type',
  direction: 'Direction',
  tag: 'Tags',
  life: 'Status',
  due: 'Due',
  flags: 'Markers',
  hard: 'Hard',
  young: 'Recent',
  leech: 'Leech',
};

/** UI labels of the flags (spec §4.3 "Markers"). */
export const FLAG_LABELS: Readonly<Record<FlagKey, string>> = Object.freeze({
  fav: 'Favorite',
  flagged: 'Flagged',
  suspended: 'Suspended',
  buried: 'Buried',
  paused: 'In a paused deck',
});

/** UI labels of the Due values. */
export const DUE_LABELS: Readonly<Record<'now' | 'today', string>> = Object.freeze({
  now: 'Due now',
  today: 'Due today',
});

/**
 * Language names for direction labels ("German → English"). Base subtag →
 * English name. A Map: the subtag comes from imported data ({{tts …}}), and on
 * an object 'constructor' would find the inherited `Object` function.
 */
const LANG_NAMES: ReadonlyMap<string, string> = new Map([
  ['ar', 'Arabic'], ['cs', 'Czech'], ['da', 'Danish'], ['de', 'German'], ['el', 'Greek'], ['en', 'English'],
  ['es', 'Spanish'], ['fi', 'Finnish'], ['fr', 'French'], ['he', 'Hebrew'], ['hi', 'Hindi'], ['hu', 'Hungarian'],
  ['it', 'Italian'], ['ja', 'Japanese'], ['ko', 'Korean'], ['nb', 'Norwegian'], ['nl', 'Dutch'], ['no', 'Norwegian'],
  ['pl', 'Polish'], ['pt', 'Portuguese'], ['ro', 'Romanian'], ['ru', 'Russian'], ['sv', 'Swedish'], ['tr', 'Turkish'],
  ['uk', 'Ukrainian'], ['zh', 'Chinese'],
]);

/**
 * Folded labels that a FIELD group may not use as they are: the labels of
 * the other groups, and the chip words of other groups ("Tag: …", "List: …",
 * "Text: …", "Not tagged: …"). See fieldGroupLabel.
 */
const RESERVED_LABELS: ReadonlySet<string> = new Set(
  [...Object.values(FACET_LABELS), 'Tag', 'Not tagged', 'List', 'Text'].map((l) => foldText(l).trim()),
);

/** A label folded for comparing: lower case, no accents, single spaces. */
function foldLabel(label: string): string {
  return foldText(label).replace(/\s+/g, ' ').trim();
}

/**
 * The card types that own a field group, so its label can name them (spec
 * §4.3, walkthrough M8). `spec` is the group (FacetFieldSpec: which card
 * types have the field, and where); `typeById` finds the card types.
 */
export interface FieldLabelOwner {
  spec: Pick<FacetFieldSpec, 'fieldIndexByType'>;
  typeById: ReadonlyMap<Id, NoteType>;
}

/** At most this many card type names go into a field group label: "Tags (German Verbs, Spanish Verbs)". */
const MAX_OWNER_NAMES = 2;

/**
 * A card type name without a trailing "(…)" note, for a group label:
 * "German Verbs (bidirectional)" → "German Verbs". A name that is only a
 * note stays as it is.
 */
function shortTypeName(name: string): string {
  const short = name.replace(/\s*\([^()]*\)\s*$/, '').trim();
  return short !== '' ? short : name.trim();
}

/**
 * The label of a field group (FacetSheet group and chip). Three rules:
 *
 * 1. A label someone CHOSE wins (walkthrough M8): when one of the card
 *    types that own the field gives it a label of its own (`FieldDef.label`,
 *    not just its name — the German pack names the Verbs field "Tags"
 *    "Verb type"), the group uses that label as it is.
 * 2. Else the label is the field's NAME, made readable like everywhere else
 *    in the app (render.ts humanizeFieldName, walkthrough L3 / R6): a known
 *    app prefix is dropped and CamelCase becomes words, so "WordType" shows
 *    as "Word Type" and "MarankiExample" as "Example". The raw name is never
 *    shown.
 * 3. A label that is also the label of another group ("Tags", "Deck",
 *    "Status" …) would show two groups with the same name. Then the group
 *    names its card types: "Tags (German Verbs)". Without `owner` (or with
 *    more than two card types) it says " (field)".
 *
 * ONLY THE TEXT CHANGES. The group is still found by its KEY (the folded
 * field name, `field:wordtype`): the query, the chip id and a tap in the
 * FacetSheet use the key, never this label. In the search box both work:
 * `wordtype:noun` (the key) and `word_type:noun` (the name the chip shows,
 * fieldShownName; searchParse fieldKeyFor).
 *
 *   fieldGroupLabel('Level')                         → 'Level'
 *   fieldGroupLabel('WordType')                      → 'Word Type'
 *   fieldGroupLabel('Tags')                          → 'Tags (field)'
 *   fieldGroupLabel('MarankiTags')                   → 'Tags (field)'
 *   fieldGroupLabel('Tags', { spec, typeById })      → 'Tags (German Verbs)'
 *   fieldGroupLabel('Tags', … a type labels it 'Verb type') → 'Verb type'
 *   fieldGroupLabel('deck')                          → 'deck (field)'
 */
export function fieldGroupLabel(label: string, owner?: FieldLabelOwner): string {
  const { own, typeNames } = fieldNameParts(label, owner);
  if (!RESERVED_LABELS.has(foldLabel(own))) return own;
  if (typeNames.length > 0 && typeNames.length <= MAX_OWNER_NAMES) return `${own} (${typeNames.join(', ')})`;
  return `${own} (field)`;
}

/**
 * The readable name of a field group: rules 1 and 2 of fieldGroupLabel (the
 * label a card type chose, else the field's name made readable), WITHOUT the
 * card type note of rule 3. It is the word a learner reads in front of the
 * chip's ":" and may type in the search box (searchParse fieldKeyFor).
 *
 *   fieldShownName('WordType')                            → 'Word Type'
 *   fieldShownName('MarankiExample')                      → 'Example'
 *   fieldShownName('Tags', … a type labels it 'Verb type') → 'Verb type'
 *   fieldShownName('Tags', { spec, typeById })            → 'Tags'   (the group says 'Tags (German Verbs)')
 */
export function fieldShownName(label: string, owner?: FieldLabelOwner): string {
  return fieldNameParts(label, owner).own;
}

/** Rules 1 and 2 of fieldGroupLabel (the readable name), and the short names of the card types that own the field. */
function fieldNameParts(label: string, owner?: FieldLabelOwner): { own: string; typeNames: string[] } {
  let own = label;
  let chosen = false;
  const typeNames: string[] = [];
  if (owner) {
    for (const [typeId, at] of owner.spec.fieldIndexByType) {
      const type = owner.typeById.get(typeId);
      if (!type) continue;
      const def = type.fields[at];
      const explicit = def?.label?.trim();
      // The first card type (in the group's order) with a label of its own wins.
      if (!chosen && def && explicit && foldLabel(explicit) !== foldLabel(def.name)) {
        own = explicit;
        chosen = true;
      }
      const name = shortTypeName(type.name);
      if (name !== '' && !typeNames.includes(name)) typeNames.push(name);
    }
  }
  // Rule 2: nobody chose a label, so `own` is the field's name: make it readable.
  if (!chosen) own = humanizeFieldName(own);
  return { own, typeNames };
}

/** Separator inside a section value: deck id + path (neither can contain it). */
const SECTION_SEP = '\u001f';

/* ------------------------------------------------------ section values */

/** The FacetValue.value of a section node: deck + folded path. */
export function sectionValue(deckId: Id, path: string): string {
  return `${deckId}${SECTION_SEP}${path}`;
}

/** The deck and path of a section value (inverse of sectionValue). */
export function parseSectionValue(value: string): { deckId: Id; path: string } {
  const at = value.indexOf(SECTION_SEP);
  return at === -1 ? { deckId: value, path: '' } : { deckId: value.slice(0, at), path: value.slice(at + 1) };
}

/* ------------------------------------------------- facet value → query */

/** A copy of `list` with `item` added (no duplicate) or removed. */
function toggled<T>(list: readonly T[] | undefined, item: T, same: (a: T, b: T) => boolean = (a, b) => a === b): T[] {
  const current = list ?? [];
  return current.some((x) => same(x, item)) ? current.filter((x) => !same(x, item)) : [...current, item];
}

/**
 * The selection with one facet value switched on or off (what a tap in the
 * FacetSheet does). OR groups gain or lose the value; flags gain or lose the
 * flag; Due switches between 'now', 'today' and none; toggles switch.
 */
export function toggleFacetValue(selection: Query, key: FacetKey, value: string): Query {
  const q: Query = { ...sanitizeQuery(selection) };
  switch (key) {
    case 'deck':
      q.decks = toggled(q.decks, value);
      break;
    case 'section': {
      const s = parseSectionValue(value);
      q.sections = toggled(q.sections, s, (a, b) => a.deckId === b.deckId && a.path === b.path);
      break;
    }
    case 'noteType':
      q.noteTypes = toggled(q.noteTypes, value);
      break;
    case 'direction':
      q.directions = toggled(q.directions, Number(value));
      break;
    case 'tag':
      q.tags = toggled(q.tags, value);
      break;
    case 'life':
      q.life = toggled(q.life, value as LifeKey);
      break;
    case 'due':
      q.due = q.due === value ? undefined : (value as 'now' | 'today');
      break;
    case 'flags':
      q.flags = toggled(q.flags, value as FlagKey);
      break;
    case 'hard':
    case 'young':
    case 'leech':
      q[key] = q[key] ? undefined : true;
      break;
    default: {
      // A Map, not {}: the field name is user data ('constructor', '__proto__').
      const field = key.slice('field:'.length);
      const fields = new Map(Object.entries(q.fields ?? {}));
      fields.set(field, toggled(fields.get(field), value));
      q.fields = fieldRecord(fields);
    }
  }
  return sanitizeQuery(q);
}

/**
 * True when `selection` holds this facet value (the opposite question of
 * toggleFacetValue). The FacetSheet draws a tapped chip as selected AT ONCE
 * with it, while the counts of a big library are still being made.
 *
 *   isFacetValueSelected({ fields: { level: ['b1'] } }, 'field:level', 'b1')   // true
 */
export function isFacetValueSelected(selection: Query, key: FacetKey, value: string): boolean {
  const q = sanitizeQuery(selection);
  switch (key) {
    case 'deck':
      return (q.decks ?? []).includes(value);
    case 'section': {
      const s = parseSectionValue(value);
      return (q.sections ?? []).some((x) => x.deckId === s.deckId && x.path === s.path);
    }
    case 'noteType':
      return (q.noteTypes ?? []).includes(value);
    case 'direction':
      return (q.directions ?? []).includes(Number(value));
    case 'tag':
      return (q.tags ?? []).includes(value);
    case 'life':
      return (q.life ?? []).includes(value as LifeKey);
    case 'due':
      return q.due === value;
    case 'flags':
      return (q.flags ?? []).includes(value as FlagKey);
    case 'hard':
    case 'young':
    case 'leech':
      return q[key] === true;
    default:
      // ownValue: the field name is user data ('constructor' must not find Object).
      return (ownValue(q.fields, key.slice('field:'.length)) ?? []).includes(value);
  }
}

/* -------------------------------------------------------------- helpers */

/** A Map counter. */
function inc<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/* ------------------------------------------- per-note facet data (unit P1) */

/**
 * What deriveFacets reads of one note, made ONCE per note object and library
 * index. Before (the release pass, 16,260 cards: 94–133 ms per FacetSheet
 * opening) every count made the tag and section prefixes of every note again,
 * and read the note's values through four caches per card.
 */
interface NoteFacets {
  /** index.sectionPath(note): the folded section path, '' = the deck root. */
  sectionPath: string;
  /** Every prefix of the section path ('verbs::b1' → ['verbs', 'verbs::b1']). */
  sectionPrefixes: string[];
  /** Every prefix of every tag of the note, without duplicates. */
  tagPrefixes: string[];
  /** index.facetValues(note) as two aligned arrays, in the Map's order. */
  fieldKeys: string[];
  fieldValues: string[][];
  /**
   * The note's PART for the equivalence collapse: two notes get the same
   * number exactly when they have the same card type, the same section path
   * and the same first value (or none) in every single-value field group —
   * everything the collapse compares about a note.
   */
  part: number;
  /** Deck id → the section values of the note's cards in that deck, made on first use (sectionValuesIn). */
  sectionValues: Map<Id, DeckSectionValues>;
}

/** The section values (sectionValue) of a note's cards in one deck. */
interface DeckSectionValues {
  /** One value per prefix of the section path (sectionPrefixes), in the same order. */
  prefixes: string[];
  /**
   * The value of the FULL section path: what the "≥ 2 sections" rule counts.
   * Usually the last prefix value, but not always: a path that starts with
   * '::' (a first segment that folding made empty, e.g. a lone accent
   * '\u0301::Verbs' → '::verbs') has the prefixes ['', 'verbs'], and its
   * full path '::verbs' is none of them (unit P1 review 2).
   */
  leaf: string;
}

/** The note data of one set of field groups, and the part numbers handed out so far. */
interface IndexFacets {
  notes: WeakMap<Note, NoteFacets>;
  parts: Map<string, number>;
  /** The single-value field groups (no multiSep): the only ones the collapse compares. */
  singleKeys: string[];
}

/*
 * Keyed by the index's `facetValues` function: libraryIndex.ts gives the SAME
 * function to every index with the same field groups (fieldValueReaderFor),
 * so the data of the notes an edit did not touch is kept across the new
 * index. The data depends only on the note object (its section, tags and
 * field values) and the field groups, so it can never be stale: a changed
 * note is a new object, and other field groups give another function.
 */
const noteFacetsCache = new WeakMap<LibraryIndex['facetValues'], IndexFacets>();

/** One part of a part text: its length, then the text (so no user text can look like a separator). */
const partPiece = (text: string | undefined | null): string => (text == null ? '-' : `${text.length}:${text}`);

/** The NoteFacets of a note in this index (made once, then a lookup). */
function noteFacetsReader(index: LibraryIndex): (note: Note) => NoteFacets {
  let cache = noteFacetsCache.get(index.facetValues);
  if (!cache) {
    const singleKeys: string[] = [];
    for (const spec of index.fieldSpecs.values()) if (spec.multiSep === undefined) singleKeys.push(spec.key);
    cache = { notes: new WeakMap(), parts: new Map(), singleKeys };
    noteFacetsCache.set(index.facetValues, cache);
  }
  const { notes, parts, singleKeys } = cache;
  return (note) => {
    const hit = notes.get(note);
    if (hit) return hit;
    const sectionPath = index.sectionPath(note);
    const tags = new Set<string>();
    for (const tag of index.noteTags(note)) for (const p of pathPrefixes(tag)) tags.add(p);
    const values = index.facetValues(note);
    // An exact text of the part: card type, section path, the first value of each single-value group.
    let partText = `${partPiece(note.typeId)}${partPiece(sectionPath)}`;
    for (const k of singleKeys) partText += partPiece(values.get(k)?.[0]);
    let part = parts.get(partText);
    if (part === undefined) {
      part = parts.size;
      parts.set(partText, part);
    }
    const made: NoteFacets = {
      sectionPath,
      sectionPrefixes: pathPrefixes(sectionPath),
      tagPrefixes: [...tags],
      fieldKeys: [...values.keys()],
      fieldValues: [...values.values()],
      part,
      sectionValues: new Map(),
    };
    notes.set(note, made);
    return made;
  };
}

/**
 * Make the per-note data deriveFacets reads, ahead of time (scope.ts
 * warmLibraryCaches calls it while the phone is idle): the first FacetSheet
 * opening then only counts.
 */
export function facetNoteWarmer(index: LibraryIndex): (note: Note) => void {
  const read = noteFacetsReader(index);
  return (note) => {
    read(note);
  };
}

/**
 * The section values of a note's cards in one deck: deck + each prefix, and
 * deck + the full path (`leaf`). Made once per note and deck. (Below, '␟'
 * stands for the separator SECTION_SEP.)
 *
 *   sectionValuesIn(info of 'verbs::b1', 'd1')  → { prefixes: ['d1␟verbs', 'd1␟verbs::b1'], leaf: 'd1␟verbs::b1' }
 *   sectionValuesIn(info of '::verbs', 'd1')    → { prefixes: ['d1␟', 'd1␟verbs'], leaf: 'd1␟::verbs' }
 */
function sectionValuesIn(info: NoteFacets, deckId: Id): DeckSectionValues {
  let hit = info.sectionValues.get(deckId);
  if (!hit) {
    const prefixes = info.sectionPrefixes.map((prefix) => sectionValue(deckId, prefix));
    const last = prefixes.length - 1;
    // The last prefix IS the full path in the usual case: reuse its value.
    const leaf = last >= 0 && info.sectionPrefixes[last] === info.sectionPath ? prefixes[last] : sectionValue(deckId, info.sectionPath);
    hit = { prefixes, leaf };
    info.sectionValues.set(deckId, hit);
  }
  return hit;
}

/**
 * One distinct part of the scoped cards for the equivalence collapse: a deck,
 * a note part (NoteFacets.part) and a direction. Every partition key the
 * collapse compares is a function of these three, and canHideBehind only
 * looks at WHICH pairs of keys occur — so checking one card per distinct
 * part gives the same answer as checking every card, with far less work.
 */
interface ScopedPart {
  deckId: Id;
  ord: number;
  /** A note with this part (all such notes have the same keys), or undefined: a card without a note. */
  note: Note | undefined;
  info: NoteFacets | undefined;
}

/** The last '::' part of a path. */
function lastSegment(path: string): string {
  const at = path.lastIndexOf('::');
  return at === -1 ? path : path.slice(at + 2);
}

/** The template of a card type for one ord (a cloze type has ONE template for every ord). */
function templateFor(type: NoteType | undefined, ord: number) {
  if (!type) return undefined;
  if (type.kind === 'cloze') return type.templates[0];
  return type.templates.find((t) => t.ord === ord);
}

/** 'de-DE' / 'de_DE' → 'German'; unknown → null. */
function langName(lang: string | undefined): string | null {
  if (!lang) return null;
  const base = lang.split(/[-_]/)[0].toLowerCase();
  return LANG_NAMES.get(base) ?? null;
}

/**
 * Where the cards of each direction come from: ord → card type id → the ids
 * of the decks that have cards of that type and ord. deriveFacets builds it
 * from the scoped cards, buildSearchCtx (searchParse.ts) from the scope pool.
 */
export type DirectionSources = ReadonlyMap<number, ReadonlyMap<Id, ReadonlySet<Id>>>;

/** The decks that give card types made in the app their languages (spec §3.4 Deck.language). */
export interface DirectionDecks {
  /** Every deck by id. */
  decks: ReadonlyMap<Id, Deck>;
  /** Card type id → the decks of its cards (one entry of DirectionSources). */
  decksByType: ReadonlyMap<Id, Iterable<Id>>;
}

/**
 * "German → English" for one template, or null when a language is missing
 * or both sides have the same one. `deck` gives the fallback languages of a
 * card type that is not from Anki (resolveFieldLang, render.ts).
 */
function langPair(type: NoteType, t: TemplateDef, deck?: Deck): string | null {
  const promptDef = type.fields[t.prompt[0]];
  const answerDef = type.fields[t.answer[0]];
  const from = promptDef ? langName(resolveFieldLang(promptDef, type, deck)) : null;
  const to = answerDef ? langName(resolveFieldLang(answerDef, type, deck)) : null;
  return from && to && from !== to ? `${from} → ${to}` : null;
}

/**
 * The label of direction `ord` over the card types in scope: "German →
 * English" when every card type (in every one of its decks) gives the same
 * two languages; else the template names ("DE-EN / Grammar Card"); else
 * "Direction 2".
 *
 * Languages come from the fields (`FieldDef.lang`). With `withDecks`, a card
 * type made in the app or from CSV (no `source.ankiMid`) also takes them from
 * its decks: `deck.language` for term/example fields, `deck.meaningLanguage`
 * for meaning fields (spec §3.4). A Basic + reverse deck with 'de-DE' /
 * 'en-US' gives "German → English" and "English → German".
 */
export function directionLabel(
  ord: number,
  typeIds: Iterable<Id>,
  typeById: ReadonlyMap<Id, NoteType>,
  withDecks?: DirectionDecks,
): string {
  return directionInfo(ord, typeIds, typeById, withDecks).label;
}

/**
 * The label of one direction AND where it came from: 'lang' (the languages
 * agree: "German → English"), 'name' (one template name: "DE-EN"), 'names'
 * (card types with DIFFERENT template names: "Forward / DE-EN / Grammar Card")
 * or 'none' ("Direction 2").
 */
export interface DirectionInfo {
  label: string;
  kind: 'lang' | 'name' | 'names' | 'none';
}

/**
 * directionLabel with its kind (DirectionInfo). The Library's rows use the
 * kind: a row says its languages ('lang') itself, and otherwise the name the
 * Direction group gives (libraryState directionLabeler).
 */
export function directionInfo(
  ord: number,
  typeIds: Iterable<Id>,
  typeById: ReadonlyMap<Id, NoteType>,
  withDecks?: DirectionDecks,
): DirectionInfo {
  const names: string[] = [];
  const langLabels = new Set<string>();
  let allLangs = true;
  const add = (pair: string | null) => {
    if (pair) langLabels.add(pair);
    else allLangs = false;
  };
  for (const typeId of typeIds) {
    const type = typeById.get(typeId);
    const t = templateFor(type, ord);
    if (!type || !t) continue;
    if (!names.includes(t.name)) names.push(t.name);
    // An Anki card type names its languages itself; the deck is no fallback for it.
    const deckIds = withDecks && !type.source?.ankiMid ? [...(withDecks.decksByType.get(typeId) ?? [])] : [];
    if (deckIds.length === 0) add(langPair(type, t));
    else for (const deckId of deckIds) add(langPair(type, t, withDecks?.decks.get(deckId)));
  }
  if (allLangs && langLabels.size === 1) return { label: [...langLabels][0], kind: 'lang' };
  if (names.length > 0) return { label: names.join(' / '), kind: names.length > 1 ? 'names' : 'name' };
  return { label: `Direction ${ord + 1}`, kind: 'none' };
}

/** Which side a direction asks: the front (term) or the back (meaning). */
type DirectionRole = 'front' | 'back';

/** The labels of a direction by its role (walkthrough M8). */
export const DIRECTION_ROLE_LABELS: Readonly<Record<DirectionRole, string>> = Object.freeze({
  front: 'Front → Back',
  back: 'Back → Front',
});

/**
 * The role of one template of a card type:
 *   - its question field is the term → 'front'; the meaning → 'back';
 *   - else the type's FIRST template is 'front', and a template that asks
 *     another field than the first one is 'back';
 *   - else (a cloze type, or no way to tell) null.
 */
function templateRole(type: NoteType, t: TemplateDef): DirectionRole | null {
  if (type.kind === 'cloze') return null;
  const asked = t.prompt[0];
  const role = asked === undefined ? undefined : type.fields[asked]?.role;
  if (role === 'term') return 'front';
  if (role === 'meaning') return 'back';
  let first: TemplateDef | undefined;
  for (const x of type.templates) if (!first || x.ord < first.ord) first = x;
  if (!first || first.ord === t.ord) return 'front';
  return asked !== undefined && asked !== first.prompt[0] ? 'back' : null;
}

/** The ONE role of direction `ord` over these card types, or null when they do not agree. */
function commonRole(ord: number, typeIds: Iterable<Id>, typeById: ReadonlyMap<Id, NoteType>): DirectionRole | null {
  let out: DirectionRole | null = null;
  for (const typeId of typeIds) {
    const type = typeById.get(typeId);
    const t = templateFor(type, ord);
    if (!type || !t) continue;
    const role = templateRole(type, t);
    if (role === null || (out !== null && out !== role)) return null;
    out = role;
  }
  return out;
}

/** The labels of a Direction group, and whether they name the directions by role. */
export interface DirectionGroupNames {
  /** ord → its label in the group. */
  labels: Map<number, string>;
  /** True when the labels are the role labels ("Front → Back" / "Back → Front"). */
  byRole: boolean;
}

/**
 * The labels of EVERY direction of a scope, decided for the whole Direction
 * group (spec §4.3, walkthrough M8). `sources` says which card types (and
 * decks) have cards of each ord (deriveFacets and buildSearchCtx build it).
 *
 * Each direction gets its own label first (directionLabel). But when card
 * types with DIFFERENT template names share an ord, that label is a list of
 * names ("Forward / DE-EN / Grammar Card" next to "EN-DE") that says nothing
 * clear. Then every direction is named by its ROLE instead:
 *
 *   ord 0  Vocabulary "DE-EN", Verbs "Forward", Grammar "Grammar Card"  → "Front → Back"
 *   ord 1  Vocabulary "EN-DE", Verbs "Reverse"                         → "Back → Front"
 *
 * The role labels are used only when every direction has one role and no
 * two directions share it; otherwise the names stay (nothing is hidden).
 */
export function directionLabels(
  sources: DirectionSources,
  typeById: ReadonlyMap<Id, NoteType>,
  decks?: ReadonlyMap<Id, Deck>,
): Map<number, string> {
  return directionGroupNames(sources, typeById, decks).labels;
}

/** directionLabels, and whether the group chose the role labels (`byRole`). */
export function directionGroupNames(
  sources: DirectionSources,
  typeById: ReadonlyMap<Id, NoteType>,
  decks?: ReadonlyMap<Id, Deck>,
): DirectionGroupNames {
  const infos = new Map<number, DirectionInfo>();
  for (const [ord, byType] of sources) {
    infos.set(ord, directionInfo(ord, byType.keys(), typeById, decks ? { decks, decksByType: byType } : undefined));
  }
  const out = new Map<number, string>();
  if ([...infos.values()].some((info) => info.kind === 'names')) {
    const roles = new Map<number, DirectionRole>();
    for (const [ord, byType] of sources) {
      const role = commonRole(ord, byType.keys(), typeById);
      if (role === null) break;
      roles.set(ord, role);
    }
    if (roles.size === sources.size && new Set(roles.values()).size === roles.size) {
      for (const [ord, role] of roles) out.set(ord, DIRECTION_ROLE_LABELS[role]);
      return { labels: out, byRole: true };
    }
  }
  for (const [ord, info] of infos) out.set(ord, info.label);
  return { labels: out, byRole: false };
}

/**
 * The start of a partition key for a part of the cards that the user can NOT
 * pick in that group: cards with no value in a field (a field group has no
 * "empty" value), cards at the deck root (the section tree has no root node),
 * cards without a note. A control character, so it never equals a real key.
 */
const NO_PICK = '\u0000';

/**
 * True when group LOW can be hidden behind group HIGH without losing a choice
 * (the equivalence collapse). `low(i)` and `high(i)` are the partition keys
 * of item i in each group.
 *   1. Both groups split the items into exactly the same parts: the keys map
 *      one to one.
 *   2. Every part that the user can pick in LOW can also be picked in HIGH:
 *      a NO_PICK part of HIGH must be a NO_PICK part of LOW.
 * Example of rule 2: notes with no Level are exactly the notes in section
 * "Misc". The parts are the same, but hiding the section would make "Misc"
 * impossible to pick (Level has no "empty" value). So the section stays.
 */
function canHideBehind(n: number, low: (i: number) => string, high: (i: number) => string): boolean {
  const lowToHigh = new Map<string, string>();
  const highToLow = new Map<string, string>();
  for (let i = 0; i < n; i++) {
    const a = low(i);
    const b = high(i);
    const x = lowToHigh.get(a);
    if (x === undefined) {
      // A new pair of parts: check rule 2 once for it.
      if (b.startsWith(NO_PICK) && !a.startsWith(NO_PICK)) return false;
      lowToHigh.set(a, b);
    } else if (x !== b) return false;
    const y = highToLow.get(b);
    if (y === undefined) highToLow.set(b, a);
    else if (y !== a) return false;
  }
  return true;
}

/** The number of '::' parts of a folded path ('' → 0). */
function pathDepth(path: string): number {
  return path === '' ? 0 : path.split('::').length;
}

/** The first `depth` parts of a folded path ('' stays ''). */
function pathAtDepth(path: string, depth: number): string {
  if (path === '') return '';
  let at = -1;
  for (let d = 0; d < depth; d++) {
    at = path.indexOf('::', at + 2);
    if (at === -1) return path;
  }
  return path.slice(0, at);
}

/**
 * Build a sorted tree of FacetValues from node counts (+ selected nodes, kept
 * at 0). `parentOf` returns null for a top-level node. A node whose parent is
 * not in the tree (a selected node with no cards) becomes a root.
 */
function buildTree(
  counts: Map<string, number>,
  selected: Set<string>,
  parentOf: (key: string) => string | null,
  labelOf: (key: string, isRoot: boolean) => string,
): { roots: FacetValue[] } {
  const nodes = new Map<string, FacetValue>();
  const keys = new Set<string>();
  for (const [key, count] of counts) if (count > 0) keys.add(key);
  for (const key of selected) keys.add(key);

  for (const key of keys) {
    nodes.set(key, { value: key, label: '', count: counts.get(key) ?? 0, selected: selected.has(key) });
  }
  const roots: FacetValue[] = [];
  for (const [key, node] of nodes) {
    const parentKey = parentOf(key);
    const parent = parentKey === null ? undefined : nodes.get(parentKey);
    node.label = labelOf(key, parent === undefined);
    if (parent) (parent.children ??= []).push(node);
    else roots.push(node);
  }
  // Sort every level: ordinal when all labels of the level fit one kind.
  const sortLevel = (level: FacetValue[]) => {
    const ordinal = detectOrdinal(level.map((v) => v.label));
    sortByOrdinalOrCount(level, ordinal);
    for (const v of level) {
      if (ordinal) v.rank = ordinal.rank(v.label);
      if (v.children) sortLevel(v.children);
    }
  };
  sortLevel(roots);
  return { roots };
}

/** A sorted list of FacetValues from counts (+ selected values, kept at 0). */
function buildList(
  counts: Map<string, number>,
  selected: Iterable<string>,
  labelOf: (value: string) => string,
): FacetValue[] {
  const selectedSet = new Set(selected);
  const out: FacetValue[] = [];
  for (const [value, count] of counts) {
    if (count > 0) out.push({ value, label: labelOf(value), count, selected: selectedSet.has(value) });
  }
  for (const value of selectedSet) {
    if ((counts.get(value) ?? 0) === 0) out.push({ value, label: labelOf(value), count: 0, selected: true });
  }
  return out;
}

/* ------------------------------------------------------- deriveFacets */

/**
 * The filter groups of `pool` within `scope`, with disjunctive counts for
 * `selection` (see the file header). Pure: the same inputs give the same
 * facets, in the same order.
 */
export function deriveFacets(pool: readonly Card[], scope: Query, selection: Query, ctx: MatchCtx): Facet[] {
  const { index, now, decks } = ctx;
  const sel = sanitizeQuery(selection);
  const inScope = compileQuery(scope, ctx);
  const groups = compileGroups(sel, ctx);
  const groupCount = groups.length;
  const endOfDay = endOfLocalDay(now);
  const noteFacets = noteFacetsReader(index);
  const specs = index.fieldSpecs;
  // flagHolds(card, 'paused'): the card's deck exists and is paused. Read per card only when a deck is.
  let anyPaused = false;
  for (const deck of decks.values()) if (deck.active === false) anyPaused = true;

  // Counts per facet.
  const deckCounts = new Map<string, number>();
  const sectionCounts = new Map<string, number>(); // sectionValue(deck, prefix) → count
  const sectionLeaves = new Set<string>(); // sectionValue(deck, full path); the deck root is not one
  const fieldCounts = new Map<string, Map<string, number>>();
  const typeCounts = new Map<string, number>();
  // By the ord NUMBER while counting (no text per card); made text keys below, in the same order.
  const ordNumberCounts = new Map<number, number>();
  // ord → card type → decks, over the SCOPED cards (the labels do not change while the user picks).
  const ordSources = new Map<number, Map<Id, Set<Id>>>();
  const tagCounts = new Map<string, number>();
  const lifeCounts = new Map<string, number>();
  const dueCounts = new Map<string, number>();
  const flagCounts = new Map<string, number>();
  const toggleCounts = new Map<string, number>();

  // Base counts: cards that fail no group, and cards that fail only group G.
  let passAll = 0;
  const failOnly = new Map<GroupId, number>();

  // The distinct parts of the scoped cards (selection ignored), for the
  // equivalence collapse (ScopedPart): deck → (note part, ord) code → index.
  const parts: ScopedPart[] = [];
  const partIndex = new Map<Id, Map<number, number>>();
  const ordCodes = new Map<number, number>();
  // A code (note part + 1) × span + ord code is unique: there are at most pool.length distinct ords.
  const span = pool.length + 1;

  for (const card of pool) {
    if (!inScope(card)) continue;
    const note = index.noteById.get(card.noteId);
    const info = note ? noteFacets(note) : undefined;
    let ordCode = ordCodes.get(card.ord);
    if (ordCode === undefined) {
      ordCode = ordCodes.size;
      ordCodes.set(card.ord, ordCode);
    }
    let inDeck = partIndex.get(card.deckId);
    if (!inDeck) partIndex.set(card.deckId, (inDeck = new Map()));
    const code = (info ? info.part + 1 : 0) * span + ordCode;
    if (!inDeck.has(code)) {
      inDeck.set(code, parts.length);
      parts.push({ deckId: card.deckId, ord: card.ord, note, info });
    }
    if (note) {
      let byType = ordSources.get(card.ord);
      if (!byType) ordSources.set(card.ord, (byType = new Map()));
      let deckIds = byType.get(note.typeId);
      if (!deckIds) byType.set(note.typeId, (deckIds = new Set()));
      deckIds.add(card.deckId);
    }

    let failed = 0;
    let failedId: GroupId | null = null;
    for (let g = 0; g < groupCount; g++) {
      if (!groups[g].test(card)) {
        failed += 1;
        if (failed === 1) failedId = groups[g].id;
        else break;
      }
    }
    if (failed >= 2) continue;
    const all = failed === 0;
    if (all) passAll += 1;
    else failOnly.set(failedId!, (failOnly.get(failedId!) ?? 0) + 1);

    if (all || failedId === 'decks') inc(deckCounts, card.deckId);
    if (all || failedId === 'directions') inc(ordNumberCounts, card.ord);
    if (all || failedId === 'life' || failedId === 'due') {
      const key = life(card);
      if (all || failedId === 'life') inc(lifeCounts, key);
      if (all || failedId === 'due') {
        const studied = key === 'learning' || key === 'review' || key === 'mastered';
        if (studied && !card.suspended && !(card.buriedUntil != null && card.buriedUntil > now)) {
          if (card.due <= now) inc(dueCounts, 'now');
          if (card.due <= endOfDay) inc(dueCounts, 'today');
        }
      }
    }
    // Flags and toggles are AND groups (one group per flag): a card that fails
    // the group of flag f does not hold f, so it adds to no flag count. Only
    // cards that pass every group count here. Each test is query.ts
    // flagHolds(card, flag, now, decks), written out (five calls per card cost).
    if (all) {
      if (card.fav === true) inc(flagCounts, 'fav');
      if (card.flagged === true) inc(flagCounts, 'flagged');
      if (card.suspended === true) inc(flagCounts, 'suspended');
      if (isBuried(card, now)) inc(flagCounts, 'buried');
      if (anyPaused && decks.get(card.deckId)?.active === false) inc(flagCounts, 'paused');
      if (isHard(card)) inc(toggleCounts, 'hard');
      if (isYoung(card)) inc(toggleCounts, 'young');
      if (isLeech(card)) inc(toggleCounts, 'leech');
    }
    if (!note || !info) continue;

    if (all || failedId === 'noteTypes') inc(typeCounts, note.typeId);
    if (all || failedId === 'sections') {
      const values = sectionValuesIn(info, card.deckId);
      // The deck root ('') is no section (spec §4.3 "≥ 2 sections"). The leaf is the FULL path's value.
      if (info.sectionPath !== '') sectionLeaves.add(values.leaf);
      for (const value of values.prefixes) inc(sectionCounts, value);
    }
    if (all || failedId === 'tags') for (const p of info.tagPrefixes) inc(tagCounts, p);
    if (all) {
      const { fieldKeys, fieldValues } = info;
      for (let f = 0; f < fieldKeys.length; f++) {
        let counts = fieldCounts.get(fieldKeys[f]);
        if (!counts) fieldCounts.set(fieldKeys[f], (counts = new Map()));
        for (const v of fieldValues[f]) inc(counts, v);
      }
    } else if (failedId !== null && failedId.startsWith('field:')) {
      const key = failedId.slice('field:'.length);
      const at = info.fieldKeys.indexOf(key);
      if (at !== -1) {
        let counts = fieldCounts.get(key);
        if (!counts) fieldCounts.set(key, (counts = new Map()));
        for (const v of info.fieldValues[at]) inc(counts, v);
      }
    }
  }
  // The ord counts as text keys ('0', '1' …), in the order they were first counted.
  const ordCounts = new Map<string, number>();
  for (const [ord, count] of ordNumberCounts) {
    const key = String(ord);
    ordCounts.set(key, (ordCounts.get(key) ?? 0) + count);
  }

  /** Cards counted toward group G: they pass every other selected group. */
  const baseOf = (id: GroupId) => passAll + (failOnly.get(id) ?? 0);

  /* ------------------------------------------------------------ deck */

  let deckFacet: Facet | null = null;
  const deckValues = buildList(deckCounts, sel.decks ?? [], (id) => decks.get(id)?.name ?? id);
  // Decks keep the user's deck order (Deck.order), then the name.
  deckValues.sort((a, b) => {
    const oa = decks.get(a.value)?.order ?? Number.POSITIVE_INFINITY;
    const ob = decks.get(b.value)?.order ?? Number.POSITIVE_INFINITY;
    return oa !== ob ? (oa < ob ? -1 : 1) : compareLabels(a.label, b.label);
  });
  if (withCards(deckValues) >= 2 || (sel.decks?.length ?? 0) > 0) {
    deckFacet = listFacet('deck', deckValues);
  }

  /* --------------------------------------------------------- section */

  // Roots carry the deck name when the tree spans ≥ 2 decks.
  const selectedSections = new Set((sel.sections ?? []).map((s) => sectionValue(s.deckId, s.path)));
  const sectionDecks = new Set<string>();
  for (const [key, count] of sectionCounts) if (count > 0) sectionDecks.add(parseSectionValue(key).deckId);
  const sectionTree = buildTree(
    sectionCounts,
    selectedSections,
    (key) => {
      const { deckId, path } = parseSectionValue(key);
      const at = path.lastIndexOf('::');
      return at === -1 ? null : sectionValue(deckId, path.slice(0, at));
    },
    (key, isRoot) => {
      const { deckId, path } = parseSectionValue(key);
      const display = index.sectionLabel(path);
      // A root that is really nested (a selected section whose parent has no
      // cards) shows its whole path: "Verbs › B1".
      const text = isRoot && path.includes('::') ? display.split('::').join(' › ') : lastSegment(display);
      return isRoot && sectionDecks.size >= 2 ? `${decks.get(deckId)?.name ?? deckId} › ${text}` : text;
    },
  );
  // ≥ 2 sections (full paths; parents count through them: 'verbs' + 'verbs::b1' are 2).
  let sectionShown = selectedSections.size > 0 || sectionLeaves.size >= 2;

  /* ---------------------------------------------------------- fields */

  // Groups and info lines. A selected field key that is no facet any more (a
  // stale list) still gets a group, so its chip value stays visible (count 0)
  // and can be removed. Sorted at the end: ordinal groups first, then by label.
  const fieldKeys = [...specs.keys()];
  for (const key of Object.keys(sel.fields ?? {})) if (!specs.has(key)) fieldKeys.push(key);
  const fieldFacets: Facet[] = [];
  /** Single-value field groups that are shown: they take part in the equivalence collapse. */
  const partitionFields: string[] = [];
  for (const key of fieldKeys) {
    const spec = specs.get(key);
    const facetKey: FacetKey = `field:${key}`;
    // ownValue, not sel.fields[key]: a field called 'constructor' must not find Object.
    const selectedValues = ownValue(sel.fields, key) ?? [];
    const values = buildList(fieldCounts.get(key) ?? new Map(), selectedValues, (v) => index.valueLabel(key, v));
    const ordinal: Ordinal | null = detectOrdinal(values.map((v) => v.label));
    sortByOrdinalOrCount(values, ordinal);
    if (ordinal) for (const v of values) v.rank = ordinal.rank(v.label);
    const facet: Facet = {
      key: facetKey,
      label: fieldGroupLabel(spec?.label ?? key, spec ? { spec, typeById: index.typeById } : undefined),
      kind: 'list',
      ordinal: ordinal?.kind ?? null,
      values,
      searchable: false,
    };
    const live = values.filter((v) => v.count > 0);
    if (live.length >= 2 || selectedValues.length > 0) {
      fieldFacets.push(facet);
      if (spec && spec.multiSep === undefined) partitionFields.push(key);
    } else if (live.length === 1 && live[0].count === baseOf(`field:${key}`)) {
      // One value on every counted card: not a group, a line of information.
      fieldFacets.push({ ...facet, info: `All cards here are ${live[0].label}.` });
    }
  }
  // The same order in every library and scope: "Level" (ordinal) before "Type".
  fieldFacets.sort((a, b) => {
    const oa = a.ordinal ? 0 : 1;
    const ob = b.ordinal ? 0 : 1;
    return oa - ob || compareLabels(a.label, b.label) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });

  /* -------------------------------------------------------- card type */

  const typeValues = buildList(typeCounts, sel.noteTypes ?? [], (id) => index.typeById.get(id)?.name ?? id);
  sortByOrdinalOrCount(typeValues, null);
  let typeShown = withCards(typeValues) >= 2 || (sel.noteTypes?.length ?? 0) > 0;

  /* ---------------------------------------------- equivalence collapse */

  // Partition keys of the scoped cards (the selection is ignored, so the
  // groups do not jump while the user picks values). Built only when needed.
  // A key that starts with NO_PICK is a part the user cannot pick in that group.
  // `i` is a distinct part of the scoped cards (ScopedPart): the checks below
  // only look at which pairs of keys occur, so one card per part is enough.
  const n = parts.length;
  const pathOf = (i: number) => parts[i].info?.sectionPath ?? '';
  const typeKey = (i: number) => parts[i].note?.typeId ?? NO_PICK;
  const fieldKeyOf = (key: string) => (i: number) => {
    const info = parts[i].info;
    const at = info ? info.fieldKeys.indexOf(key) : -1;
    return (info && at !== -1 ? info.fieldValues[at][0] : undefined) ?? NO_PICK;
  };

  // The section as the group that is HIDDEN: its finest parts, the full
  // paths. Every node of the tree is a union of full paths, so when a field
  // splits the cards exactly like the full paths, each node is an OR of field
  // values and nothing is lost. (A field that equals only the FIRST level
  // would lose the finer levels: "Core › Topic Alpha" vs "Core › BFS".)
  const sectionLeafKey = (i: number) => {
    const path = pathOf(i);
    const key = sectionValue(parts[i].deckId, path);
    return path === '' ? NO_PICK + key : key;
  };

  // The section as the group that is KEPT: one tree level (depth). A part is
  // pickable only when it is a whole tree node: not the deck root, and not
  // "the notes right at 'Verbs'" while 'Verbs › B1' also has notes (the node
  // 'Verbs' picks both).
  let maxDepth = 0;
  for (let i = 0; i < n; i++) maxDepth = Math.max(maxDepth, pathDepth(pathOf(i)));
  /** sectionValue(deck, path) of every path that has a child path in scope. */
  const collectParents = () => {
    const out = new Set<string>();
    for (let i = 0; i < n; i++) {
      const prefixes = pathPrefixes(pathOf(i));
      for (let p = 0; p < prefixes.length - 1; p++) out.add(sectionValue(parts[i].deckId, prefixes[p]));
    }
    return out;
  };
  let parentPaths: Set<string> | null = null;
  const sectionKeyCache: string[][] = [];
  const sectionKeysAt = (depth: number) => {
    const parents = (parentPaths ??= collectParents());
    const keys = (sectionKeyCache[depth] ??= parts.map((part, i) => {
      const path = pathOf(i);
      const key = sectionValue(part.deckId, pathAtDepth(path, depth));
      if (path === '') return NO_PICK + key;
      return pathDepth(path) < depth && parents.has(key) ? NO_PICK + key : key;
    }));
    return (i: number) => keys[i];
  };

  // field > section: hide the section when a shown field splits the cards
  // exactly like the section's full paths.
  if (sectionShown && selectedSections.size === 0) {
    if (partitionFields.some((key) => canHideBehind(n, sectionLeafKey, fieldKeyOf(key)))) sectionShown = false;
  }
  // field > noteType, and section > noteType — the section only when it is
  // really shown (a hidden tree cannot stand in for the card type).
  if (typeShown && (sel.noteTypes?.length ?? 0) === 0) {
    let same = partitionFields.some((key) => canHideBehind(n, typeKey, fieldKeyOf(key)));
    for (let depth = 1; !same && sectionShown && depth <= maxDepth; depth++) {
      same = canHideBehind(n, typeKey, sectionKeysAt(depth));
    }
    if (same) typeShown = false;
  }

  /* -------------------------------------------------------- direction */

  // ≥ 2 ords whose labels (template names / languages) differ. The labels are
  // decided for the whole group (directionLabels): card types with different
  // template names make "Front → Back" / "Back → Front" (walkthrough M8). A
  // selected ord with no card in scope is labelled from every card type of
  // the scope (like its chip, chipsOf in searchParse.ts).
  let directionFacet: Facet | null = null;
  const groupOrdLabels = directionLabels(ordSources, index.typeById, decks);
  const ordLabel = (ord: number) => {
    const label = groupOrdLabels.get(ord);
    if (label !== undefined) return label;
    // In the order the scoped cards show them: the first card of each card type made a new part.
    const scopeTypes = new Set<Id>();
    for (const part of parts) if (part.note) scopeTypes.add(part.note.typeId);
    return directionLabel(ord, scopeTypes, index.typeById);
  };
  const ordValues = buildList(ordCounts, (sel.directions ?? []).map(String), (v) => ordLabel(Number(v)));
  ordValues.sort((a, b) => Number(a.value) - Number(b.value));
  const liveOrds = ordValues.filter((v) => v.count > 0);
  const labelsDiffer = new Set(liveOrds.map((v) => v.label)).size >= 2;
  const directionPicked = (sel.directions?.length ?? 0) > 0;
  if ((liveOrds.length >= 2 && labelsDiffer) || directionPicked) {
    directionFacet = listFacet('direction', ordValues);
  }
  // Hidden when it adds nothing (walkthrough M8): when the directions split
  // the scoped cards exactly like a SHOWN higher group (a field, a section
  // level, the card type), picking a direction is the same as picking there.
  if (directionFacet && !directionPicked) {
    const ordKey = (i: number) => String(parts[i].ord);
    let same = partitionFields.some((key) => canHideBehind(n, ordKey, fieldKeyOf(key)));
    for (let depth = 1; !same && sectionShown && depth <= maxDepth; depth++) {
      same = canHideBehind(n, ordKey, sectionKeysAt(depth));
    }
    if (!same && typeShown) same = canHideBehind(n, ordKey, typeKey);
    if (same) directionFacet = null;
  }

  /* ------------------------------------------------------------- tags */

  // Underscores show as spaces: Topic_Alpha → "Topic Alpha".
  let tagFacet: Facet | null = null;
  const selectedTags = new Set(sel.tags ?? []);
  const tagTree = buildTree(
    tagCounts,
    selectedTags,
    (key) => {
      const at = key.lastIndexOf('::');
      return at === -1 ? null : key.slice(0, at);
    },
    (key, isRoot) => {
      const display = index.tagLabel(key);
      const text = isRoot && key.includes('::') ? display.split('::').join(' › ') : lastSegment(display);
      return text.replace(/_/g, ' ');
    },
  );
  let tagNodes = 0;
  for (const count of tagCounts.values()) if (count > 0) tagNodes += 1;
  // One single tag on every counted card says nothing: no group.
  const oneTagEverywhere = tagNodes === 1 && tagTree.roots.length === 1 && tagTree.roots[0].count === baseOf('tags');
  if (selectedTags.size > 0 || (tagNodes > 0 && !oneTagEverywhere)) {
    tagFacet = {
      key: 'tag',
      label: FACET_LABELS.tag,
      kind: 'tree',
      ordinal: null,
      values: tagTree.roots,
      searchable: tagNodes > TAG_SEARCH_MIN,
    };
  }

  /* -------------------------------------------------------- built-ins */

  const builtins: Facet[] = [
    fixedFacet('life', LIFE_KEYS, lifeCounts, sel.life ?? [], (v) => LIFE_LABELS[v as LifeKey]),
    fixedFacet('due', ['now', 'today'], dueCounts, sel.due ? [sel.due] : [], (v) => DUE_LABELS[v as 'now' | 'today']),
    fixedFacet('flags', FLAG_KEYS, flagCounts, sel.flags ?? [], (v) => FLAG_LABELS[v as FlagKey]),
    ...(['hard', 'young', 'leech'] as const).map((key) =>
      fixedFacet(key, [key], toggleCounts, sel[key] ? [key] : [], () => FACET_LABELS[key]),
    ),
  ];

  // The FacetSheet order of spec §8.3: Status, Due, Markers (+ the Hard /
  // Recent / Leech toggles), Deck, Section, field groups (ordinal first),
  // Tags, Card type, Direction.
  const out: Facet[] = [...builtins];
  if (deckFacet) out.push(deckFacet);
  if (sectionShown) out.push({ key: 'section', label: FACET_LABELS.section, kind: 'tree', ordinal: null, values: sectionTree.roots, searchable: false });
  out.push(...fieldFacets);
  if (tagFacet) out.push(tagFacet);
  if (typeShown) out.push(listFacet('noteType', typeValues));
  if (directionFacet) out.push(directionFacet);
  return out;
}

/* ---------------------------------------------------- facet builders */

/** How many values have cards. */
function withCards(values: readonly FacetValue[]): number {
  let n = 0;
  for (const v of values) if (v.count > 0) n += 1;
  return n;
}

/** A plain list facet (no ordinal, no search box). */
function listFacet(key: 'deck' | 'noteType' | 'direction', values: FacetValue[]): Facet {
  return { key, label: FACET_LABELS[key], kind: 'list', ordinal: null, values, searchable: false };
}

/** A built-in facet: values in a fixed order; count-0 values hidden unless selected. */
function fixedFacet(
  key: 'life' | 'due' | 'flags' | 'hard' | 'young' | 'leech',
  order: readonly string[],
  counts: Map<string, number>,
  selected: readonly string[],
  labelOf: (v: string) => string,
): Facet {
  const selectedSet = new Set(selected);
  const values: FacetValue[] = [];
  for (const v of order) {
    const count = counts.get(v) ?? 0;
    if (count > 0 || selectedSet.has(v)) values.push({ value: v, label: labelOf(v), count, selected: selectedSet.has(v) });
  }
  return { key, label: FACET_LABELS[key], kind: 'list', ordinal: null, values, searchable: false };
}
