/**
 * The library index (spec §4.4): everything search and the facet engine need
 * to know about NOTES, computed once and cached.
 *
 * WHY: a card does not carry its text. The text, the tags and the section live
 * on its note (spec §3.4). Search and filters read them for every card, many
 * times per second while the user types. So this module builds the lookups
 * once per library:
 *
 *   noteById / typeById        id → object
 *   searchText(note)           folded text of every field (HTML removed) + tags + section
 *   facetValues(note)          folded field name → folded values ('level' → ['b1'])
 *   fieldSpecs                 which fields are filter groups (the data rule of §4.3)
 *
 * and a second, smaller lookup over CARDS (`CardLookup`: card by id, card ids
 * by note), rebuilt when the cards array changes.
 *
 * Memo rule (spec §4.4): the index depends only on `(notes, noteTypes)`. A
 * rating changes only `cards`, so the index is NOT rebuilt after a rating
 * (`libraryIndexMemo` below keeps that promise; selectors.ts uses it in W3-4).
 * Per-note values are cached in WeakMaps keyed by the note OBJECT. The store
 * never edits a note in place, so an edited note is a new object and gets
 * fresh values. The facet values (and the section and tag labels) of a note
 * are kept across a NEW index too, when its filter fields are the same
 * (fieldValueReaderFor, unit P1): one edited card then makes only that note's
 * values again, not those of all 16,000.
 *
 * Folding: `foldText` (src/domain/text.ts) — lower case, accents removed,
 * Hermes-safe. HTML is removed by `plainText` below, in linear time (a field
 * with 200,000 '<' characters cannot freeze the app).
 *
 * Pure: no React, no I/O.
 */
import { unwrapCloze } from './cloze';
import { decodeHtmlEntities } from './htmlLines';
import type { Card, FacetFieldSpec, Id, Note, NoteType } from './model';
import { detectOrdinal } from './ordinal';
import { foldText } from './text';

/* ------------------------------------------------------------------ types */

export interface LibraryIndex {
  noteById: Map<Id, Note>;
  typeById: Map<Id, NoteType>;
  /** Folded fields (HTML removed) + tags + section, one per line. Cached per Note object. */
  searchText: (note: Note) => string;
  /**
   * Folded field name → folded values (multi-value fields split). Only facet
   * fields (`fieldSpecs`) and only non-empty values. Cached per Note object.
   * The returned Map is shared: do not change it.
   */
  facetValues: (note: Note) => Map<string, string[]>;
  /** Which fields are filter groups, from `fieldFacetSpecs`. */
  fieldSpecs: Map<string, FacetFieldSpec>;
  /*
   * Additions to the spec's interface (§4.4), used by query.ts, facets.ts and
   * searchParse.ts. All derived from the notes, all cached.
   */
  /** The note's section, folded, with '::' parts trimmed: 'Verbs :: B1' → 'verbs::b1'. '' = deck root. */
  sectionPath: (note: Note) => string;
  /** The note's tags, cleaned and folded by `foldTag` ('Algo::' → 'algo'), without duplicates. */
  noteTags: (note: Note) => string[];
  /** Display text of a folded facet value: ('level', 'b1') → 'B1'. Unknown → the folded value. */
  valueLabel: (key: string, folded: string) => string;
  /** Display path of a folded section path: 'verbs::b1' → 'Verbs::B1'. Unknown → the folded path. */
  sectionLabel: (foldedPath: string) => string;
  /** Display text of a folded tag (or tag parent): 'algo::core_patterns' → 'Algo::Core_Patterns'. */
  tagLabel: (foldedTag: string) => string;
  /**
   * Make the lookups of valueLabel, sectionLabel and tagLabel a part at a
   * time (unit P1 review: scope.ts warmLibraryCaches calls it while the phone
   * is idle). `stop()` is asked after every LABEL_NOTES_PER_STOP notes; when
   * it says yes, this returns false and the next call goes on where it
   * stopped. True when all three are made. The labels are the same as when
   * a reader makes them in one go.
   */
  warmLabels: (stop: () => boolean) => boolean;
}

/** Card lookups, rebuilt when the cards ARRAY changes (one O(N) pass, ~3 ms at 16k). */
export interface CardLookup {
  cardById: Map<Id, Card>;
  /** Card IDS per note, never Card objects: siblings are read live via cardById. */
  cardIdsByNote: Map<Id, Id[]>;
}

/* -------------------------------------------------------------- plain text */

/** Tags that end a line or a block: they become a space, so the words on both sides stay apart. */
const BLOCK_TAGS = new Set([
  'br', 'div', 'p', 'li', 'ul', 'ol', 'tr', 'td', 'th', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'img', 'blockquote', 'pre', 'section', 'article', 'dt', 'dd',
]);

/** The tag name right after '<' (and an optional '/'), lower case: '<BR/>' → 'br'. */
function tagName(s: string, lt: number, gt: number): string {
  let i = lt + 1;
  if (s[i] === '/') i += 1;
  let name = '';
  while (i < gt) {
    const ch = s[i];
    if (!/[A-Za-z0-9]/.test(ch)) break;
    name += ch;
    i += 1;
  }
  return name.toLowerCase();
}

/**
 * The character after '<' that starts a tag, like an HTML parser: a letter
 * ('<b>'), '/' ('</b>'), '!' ('<!-- -->') or '?' ('<?xml ?>'). After any
 * other character ('a < b', '<3', '<=') the '<' is plain text.
 */
const TAG_START = /[A-Za-z/!?]/;

/**
 * Remove HTML tags. Linear time: each character is scanned at most twice
 * (`indexOf` from the current position). When no '>' follows a tag start, no
 * later tag can close, so the rest is kept as text and the scan stops.
 *
 *   stripTags('die <b>St</b>unde')  → 'die Stunde'
 *   stripTags('a < b and c > d')    → 'a < b and c > d'   ('< ' starts no tag)
 */
function stripTags(s: string): string {
  const parts: string[] = [];
  // `copied`: the text before it is already in `parts`. `from`: where the next '<' search starts.
  let copied = 0;
  let from = 0;
  while (from < s.length) {
    const lt = s.indexOf('<', from);
    if (lt === -1) break;
    if (!TAG_START.test(s.charAt(lt + 1))) {
      // A '<' that starts no tag is text: keep it and look further.
      from = lt + 1;
      continue;
    }
    const gt = s.indexOf('>', lt + 1);
    if (gt === -1) break;
    parts.push(s.slice(copied, lt));
    // "die <b>St</b>unde" must stay one word; "<br>" and "</div>" separate words.
    if (BLOCK_TAGS.has(tagName(s, lt, gt))) parts.push(' ');
    copied = gt + 1;
    from = copied;
  }
  parts.push(s.slice(copied));
  return parts.join('');
}

/** '[sound:x.mp3]' tokens are not text. Bounded, so an unclosed token is scanned once. */
const SOUND = /\[sound:[^\]]{0,500}\]/g;

/**
 * Raw field text (may hold Anki HTML) → one plain line: cloze answers kept,
 * sound tokens and tags removed, entities decoded, white space collapsed.
 *
 *   plainText('<div>Wir haben kein <b>Bad</b>.</div>') → 'Wir haben kein Bad.'
 *   plainText('A&nbsp;&amp;&nbsp;B<br>C')               → 'A & B C'
 *
 * It is NOT the renderer (that is htmlLines.ts, W2-3): it only feeds search
 * and filter values, so it keeps text and drops everything else. Entities are
 * decoded by the RENDERER's decoder (htmlLines `decodeHtmlEntities`), so the
 * search text has exactly the characters the card shows:
 *
 *   plainText('2 &times; 3, &auml;rger') → '2 × 3, ärger'   (searching "×" or "arger" finds it)
 */
export function plainText(raw: string): string {
  if (!raw) return '';
  let s = String(raw);
  if (s.indexOf('{{c') !== -1) s = unwrapCloze(s);
  if (s.indexOf('[sound:') !== -1) s = s.replace(SOUND, ' ');
  if (s.indexOf('<') !== -1) s = stripTags(s);
  if (s.indexOf('&') !== -1) s = decodeHtmlEntities(s);
  return s.replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------- names and paths */

/** A field name as a Query.fields key: folded, spaces collapsed. 'Example  Translation' → 'example translation'. */
export function fieldKey(name: string): string {
  return foldText(name).replace(/\s+/g, ' ').trim();
}

/** A section or tag path with each '::' part trimmed and empty parts dropped: ' Verbs :: B1 ' → 'Verbs::B1'. */
export function normalizePath(path: string): string {
  if (!path) return '';
  return path
    .split('::')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('::');
}

/** A path, normalized and folded: 'Verbs :: B1' → 'verbs::b1'. */
export function foldPath(path: string): string {
  return foldText(normalizePath(path));
}

/**
 * A tag, cleaned like a section path (each '::' part trimmed, empty parts
 * dropped) and with every run of white space made one space:
 *
 *   normalizeTag('Algo::')                 → 'Algo'
 *   normalizeTag(' Algo :: Topic  Alpha') → 'Algo::Topic Alpha'
 *
 * WHY: note tags and query tags must be cleaned the SAME way, or the tag
 * tree shows a node the query cannot find (an empty row for 'Algo::').
 */
export function normalizeTag(tag: string): string {
  return normalizePath(String(tag ?? '').replace(/\s+/g, ' '));
}

/**
 * A tag, normalized and folded: the one form that note tags (`noteTags`) and
 * query tags (`sanitizeQuery`) are compared in. 'Algo :: Core_Patterns' → 'algo::core_patterns'.
 */
export function foldTag(tag: string): string {
  return foldText(normalizeTag(tag));
}

/** Every prefix of a '::' path, shortest first: 'a::b::c' → ['a', 'a::b', 'a::b::c']. '' → []. */
export function pathPrefixes(path: string): string[] {
  if (!path) return [];
  const parts = path.split('::');
  const out: string[] = [];
  let acc = '';
  for (const part of parts) {
    acc = acc === '' ? part : `${acc}::${part}`;
    out.push(acc);
  }
  return out;
}

/* ------------------------------------------------------- field values */

export type MultiSep = ',' | ';' | '|';

/** The separators the multi-value rule tries (spec §4.3 rule 2). */
const MULTI_SEPS: readonly MultiSep[] = [',', ';', '|'];

/**
 * The values of one raw field: display text and folded text, aligned, without
 * empty values and without folded duplicates. With `sep`, the field is split
 * ("regular, separable" → ['regular', 'separable']).
 */
export function fieldValues(raw: string, sep?: MultiSep): { display: string[]; folded: string[] } {
  const text = plainText(raw);
  if (text === '') return { display: [], folded: [] };
  const pieces = sep ? text.split(sep) : [text];
  const display: string[] = [];
  const folded: string[] = [];
  for (const piece of pieces) {
    const d = piece.trim();
    if (d === '') continue;
    const f = foldText(d);
    if (folded.includes(f)) continue;
    display.push(d);
    folded.push(f);
  }
  return { display, folded };
}

/* --------------------------------------------- which fields are facets */

/** At most this many distinct values (spec §4.3 rule 1). */
export const FACET_MAX_VALUES = 24;
/** Filled in at least this share of the notes whose type has the field. */
export const FACET_MIN_FILLED = 0.5;
/** No value longer than this many characters. */
export const FACET_MAX_LENGTH = 40;
/** Multi-value rule: more than this many tokens per filled value on average. */
export const FACET_MIN_TOKENS_PER_VALUE = 1.2;
/**
 * Values must REPEAT: at most this share of the notes may have a ONE-OFF
 * value (a value that no other note has).
 *
 * NOT IN THE SPEC TEXT (rule 1 of §4.3 is only ≤ 24 / ≥ 50% / ≤ 40). It
 * rejects only columns where MOST values are one-offs:
 *   - a "Word" field on a small deck (20 notes, 20 words: each value would
 *     match one card);
 *   - German Verbs `CaseInfo` in the 20-note test sample (10 filled notes,
 *     8 values). On the real deck it has 176 values, so rule 1 rejects it
 *     anyway; without this check the fixture test of spec §10 W2-4 ("German →
 *     Level + Section + Verb tags") could not pass.
 * A normal small category column stays a group, as the spec says: 8 notes
 * with Arrays, Graphs, Trees, DP, Strings (2 one-offs of 8) is a group. On the
 * real decks it changes nothing (Level: 6 values over 6,845 notes).
 *
 * An ORDINAL column (every value is a CEFR / JLPT / HSK level, a number, or
 * "Unit 2"-like, see ordinal.ts) needs less: one value that repeats is
 * enough. So a level column on a very small deck stays a group (7 notes: A1
 * twice, A2 … C2 once), but an id column (1, 2, 3 … each once) does not.
 */
export const FACET_MAX_ONE_OFF_SHARE = 0.5;

/** One FieldDef group (same folded name in one or more card types) while the rule runs. */
interface FieldGroup {
  key: string;
  /** Card type id → field index (a MEMBER of the group), in card type order. */
  fieldIndexByType: Map<Id, number>;
  /** Card type id → the label of that type's FieldDef. */
  labelByType: Map<Id, string>;
  /** The members whose FieldDef has facet 'on' (the data rule is skipped for them). */
  forcedTypes: Set<Id>;
  sep?: MultiSep;
}

/** Running totals of the multi-value rule for one separator. */
interface MultiTally {
  sep: MultiSep;
  alive: boolean;
  tokens: number;
  /** Folded token → how many notes have it. */
  counts: Map<string, number>;
}

/** Add one note's folded value (or token) to a value → note count map. */
function countValue(counts: Map<string, number>, folded: string): void {
  counts.set(folded, (counts.get(folded) ?? 0) + 1);
}

/**
 * The "values repeat" check (FACET_MAX_ONE_OFF_SHARE) on a value → note
 * count map (one entry per distinct folded value).
 *   Normal values:  the notes with a one-off value are at most half of all.
 *   Ordinal values: some value is used twice (fewer values than notes).
 *
 *   { arrays: 2, graphs: 2, trees: 2, dp: 1, strings: 1 }  → true   (2 one-offs of 8 notes)
 *   { w1: 1, w2: 1, w3: 1, w4: 1 }                         → false  (4 of 4)
 */
function valuesRepeat(counts: ReadonlyMap<string, number>): boolean {
  let uses = 0;
  let oneOffs = 0;
  for (const n of counts.values()) {
    uses += n;
    if (n === 1) oneOffs += 1;
  }
  if (oneOffs <= FACET_MAX_ONE_OFF_SHARE * uses) return true;
  return counts.size < uses && detectOrdinal([...counts.keys()]) !== null;
}

/** The data rule's running totals for the notes of one or more card types. */
interface RuleTally {
  /** The notes whose type has the field. */
  total: number;
  /** Of those, the notes with a value. */
  filled: number;
  singleAlive: boolean;
  /** Folded value → how many notes have it. */
  singles: Map<string, number>;
  /** One tally per separator the multi-value rule tries (the same list for every member of a group). */
  multis: MultiTally[];
}

/**
 * The data rule's totals for ONE member of a group: the notes of one card
 * type, read at `index`. `sep` is the group's FieldDef separator, if any.
 *
 * Stops early when no rule can pass any more (the "Word" field of a 6,000-note
 * deck is rejected after ~25 notes). A stopped tally has no rule alive, so it
 * can never pass, alone or merged.
 */
function tallyMember(notes: readonly Note[], index: number, sep: MultiSep | undefined): RuleTally {
  const tally: RuleTally = {
    total: notes.length,
    filled: 0,
    singleAlive: sep === undefined,
    singles: new Map<string, number>(),
    multis: (sep ? [sep] : MULTI_SEPS).map((s) => ({ sep: s, alive: true, tokens: 0, counts: new Map<string, number>() })),
  };
  const { singles, multis } = tally;
  for (const note of notes) {
    const text = plainText(note.fields[index] ?? '');
    if (text === '') continue;
    tally.filled += 1;
    const folded = foldText(text);
    if (tally.singleAlive) {
      if (text.length > FACET_MAX_LENGTH) tally.singleAlive = false;
      else {
        countValue(singles, folded);
        if (singles.size > FACET_MAX_VALUES) tally.singleAlive = false;
      }
    }
    for (const m of multis) {
      if (!m.alive) continue;
      if (text.indexOf(m.sep) === -1) {
        // No separator (the common case): the whole value is one token.
        if (text.length > FACET_MAX_LENGTH) {
          m.alive = false;
          continue;
        }
        m.tokens += 1;
        countValue(m.counts, folded);
      } else {
        // A token counts once per note: "regular, regular" is one use of 'regular'.
        const inNote = new Set<string>();
        for (const piece of text.split(m.sep)) {
          const token = piece.trim();
          if (token === '') continue;
          if (token.length > FACET_MAX_LENGTH) {
            m.alive = false;
            break;
          }
          m.tokens += 1;
          inNote.add(foldText(token));
        }
        if (!m.alive) continue;
        for (const token of inNote) countValue(m.counts, token);
      }
      if (m.counts.size > FACET_MAX_VALUES) m.alive = false;
    }
    if (!tally.singleAlive && multis.every((m) => !m.alive)) break;
  }
  return tally;
}

/** Two value → note count maps added together. */
function addCounts(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map(a);
  for (const [value, n] of b) out.set(value, (out.get(value) ?? 0) + n);
  return out;
}

/**
 * The totals of two tallies together, as if one pass had read both. A rule
 * that is dead in one of them stays dead (a value longer than 40 characters,
 * or more than 24 values, stays so in the union). Cheap: the maps hold at
 * most 25 values while their rule is alive.
 */
function mergeTallies(a: RuleTally, b: RuleTally): RuleTally {
  const singles = a.singleAlive && b.singleAlive ? addCounts(a.singles, b.singles) : new Map<string, number>();
  return {
    total: a.total + b.total,
    filled: a.filled + b.filled,
    singleAlive: a.singleAlive && b.singleAlive && singles.size <= FACET_MAX_VALUES,
    singles,
    multis: a.multis.map((m, i) => {
      const o = b.multis[i];
      const alive = m.alive && o.alive;
      const counts = alive ? addCounts(m.counts, o.counts) : new Map<string, number>();
      return { sep: m.sep, alive: alive && counts.size <= FACET_MAX_VALUES, tokens: m.tokens + o.tokens, counts };
    }),
  };
}

/**
 * Decide from a tally whether its notes make a filter group, and whether it
 * is multi-value (spec §4.3 rules 1–2), over the notes whose type has the field.
 *
 *   multi-value (checked first): split on ',' ';' or '|' → ≤ 24 distinct
 *                 tokens, > 1.2 tokens per filled value on average, no token
 *                 longer than 40 characters, filled in ≥ 50%, tokens repeat.
 *                 German Verbs `Tags`: 84 raw values → 20 tokens.
 *   single-value: ≤ 24 distinct folded values, filled in ≥ 50% of the notes,
 *                 no value longer than 40 characters, values repeat (at most
 *                 half of the notes have a one-off value; for an ordinal
 *                 column: some value is used twice).
 * A FieldDef with `multiSep` set (`fixedSep`) skips the single-value test and
 * the 1.2 average.
 *
 * WHY multi-value first (spec rule 2 says "when the raw values have > 24
 * distinct values"): values that are lists ("regular, separable") are split
 * on a small deck too. The 20-note German Verbs sample has only 13 raw `Tags`
 * values, and spec §10 W2-4 still wants "Verb tags (multi)" there. The 1.2
 * average keeps a column with only a few commas single-value.
 */
function ruleVerdict(tally: RuleTally, fixedSep: boolean): { ok: false } | { ok: true; multiSep?: MultiSep } {
  const { total, filled, singles, multis } = tally;
  if (total === 0) return { ok: false };
  if (filled < FACET_MIN_FILLED * total) return { ok: false };

  // Multi-value first: values that are LISTS are split. The separator with the most tokens wins.
  let best: MultiTally | null = null;
  for (const m of multis) {
    if (!m.alive || m.counts.size === 0) continue;
    if (!valuesRepeat(m.counts)) continue;
    if (!fixedSep && m.tokens / filled <= FACET_MIN_TOKENS_PER_VALUE) continue;
    if (!best || m.tokens > best.tokens) best = m;
  }
  if (best) return { ok: true, multiSep: best.sep };
  if (tally.singleAlive && singles.size > 0 && valuesRepeat(singles)) return { ok: true };
  return { ok: false };
}

/**
 * Which members of an 'auto' group pass the data rule, and the group's
 * separator. Returns the passing members (card type id → separator, in card
 * type order of the group) and their separator, or null when none passes.
 *
 * The rule runs PER CARD TYPE (per member), not on the union of all types:
 *   1. a member that passes alone is in the group;
 *   2. a member that fails alone is in the group only when the union of the
 *      members of step 1 plus this member still passes (a small deck of 3
 *      notes with A1, B1, C1 joins the German Level group; a 40-note word
 *      list with 30 "Lesson n" values does not);
 *   3. members that fail both are left out — they never remove the others.
 *
 * WHY not one rule on the union (the old way): one unrelated card type could
 * remove the group from EVERY deck. A CSV with a free-text `Level` column
 * removed the German Level filter, its `level:` search and every saved List
 * that used it ("B1 verbs" silently matched 0 cards). Four valid level
 * columns (CEFR, JLPT, HSK, TOPIK: 25 values together) removed each other.
 */
function passingMembers(
  group: FieldGroup,
  notesByType: ReadonlyMap<Id, Note[]>,
): { members: Map<Id, MultiSep | undefined>; filledByType: Map<Id, number> } | null {
  const fixedSep = group.sep !== undefined;
  const passed = new Map<Id, MultiSep | undefined>();
  const filledByType = new Map<Id, number>();
  const failed: [Id, RuleTally][] = [];
  let union: RuleTally | null = null;
  for (const [typeId, index] of group.fieldIndexByType) {
    if (group.forcedTypes.has(typeId)) continue;
    const tally = tallyMember(notesByType.get(typeId) ?? [], index, group.sep);
    const verdict = ruleVerdict(tally, fixedSep);
    if (verdict.ok) {
      passed.set(typeId, verdict.multiSep);
      filledByType.set(typeId, tally.filled);
      union = union ? mergeTallies(union, tally) : tally;
    } else failed.push([typeId, tally]);
  }
  if (!union) return null;
  const joined = new Map<Id, MultiSep | undefined>();
  for (const [typeId, tally] of failed) {
    const verdict = ruleVerdict(mergeTallies(union, tally), fixedSep);
    if (verdict.ok) {
      joined.set(typeId, verdict.multiSep);
      filledByType.set(typeId, tally.filled);
    }
  }
  // Card type order, like fieldIndexByType.
  const members = new Map<Id, MultiSep | undefined>();
  for (const typeId of group.fieldIndexByType.keys()) {
    if (passed.has(typeId)) members.set(typeId, passed.get(typeId));
    else if (joined.has(typeId)) members.set(typeId, joined.get(typeId));
  }
  return { members, filledByType };
}

/**
 * Which fields are filter groups across the whole library (spec §4.3).
 *
 * Fields with the same FOLDED name in different card types are ONE group (all
 * three German card types have `Level` → one Level group). A FieldDef with
 * `facet: 'off'` is never part of a group; one with `facet: 'on'` is always a
 * member (the data rule is skipped for it); the other members must pass the
 * data rule, per card type (passingMembers). The group exists when it has a
 * member, and `fieldIndexByType` lists only its members — so a field that
 * fails the rule never gives a value, and never removes the others.
 *
 * The separator: a FieldDef `multiSep`, else the one the data rule found for
 * the passing member with the most filled notes (members almost always
 * agree; when they do not, the biggest one decides).
 *
 * Whether a group is SHOWN is decided later, per scope (≥ 2 values there), by
 * deriveFacets. Memoize on `notes` (buildLibraryIndex does).
 */
export function fieldFacetSpecs(types: readonly NoteType[], notes: readonly Note[]): Map<string, FacetFieldSpec> {
  const groups = new Map<string, FieldGroup>();
  for (const type of types) {
    type.fields.forEach((def, index) => {
      if (def.facet === 'off') return;
      const key = fieldKey(def.name);
      if (key === '') return;
      let group = groups.get(key);
      if (!group) {
        group = { key, fieldIndexByType: new Map(), labelByType: new Map(), forcedTypes: new Set() };
        groups.set(key, group);
      }
      // A type with two fields of the same folded name: the first one counts.
      if (!group.fieldIndexByType.has(type.id)) {
        group.fieldIndexByType.set(type.id, index);
        group.labelByType.set(type.id, (def.label ?? def.name).trim() || def.name);
      }
      if (def.facet === 'on') group.forcedTypes.add(type.id);
      if (def.multiSep && !group.sep) group.sep = def.multiSep;
    });
  }

  const notesByType = new Map<Id, Note[]>();
  for (const note of notes) {
    const list = notesByType.get(note.typeId);
    if (list) list.push(note);
    else notesByType.set(note.typeId, [note]);
  }

  const specs = new Map<string, FacetFieldSpec>();
  for (const group of groups.values()) {
    const auto = passingMembers(group, notesByType);
    if (group.forcedTypes.size === 0 && !auto) continue;
    const fieldIndexByType = new Map<Id, number>();
    let label: string | undefined;
    for (const [typeId, index] of group.fieldIndexByType) {
      if (!group.forcedTypes.has(typeId) && !auto?.members.has(typeId)) continue;
      fieldIndexByType.set(typeId, index);
      label ??= group.labelByType.get(typeId);
    }
    let multiSep = group.sep;
    if (multiSep === undefined && auto) {
      let most = -1;
      for (const [typeId, sep] of auto.members) {
        const filled = auto.filledByType.get(typeId) ?? 0;
        if (filled > most) {
          most = filled;
          multiSep = sep;
        }
      }
    }
    specs.set(group.key, {
      key: group.key,
      label: label ?? group.key,
      fieldIndexByType,
      forced: group.forcedTypes.size > 0,
      ...(multiSep ? { multiSep } : {}),
    });
  }
  return specs;
}

/* --------------------------------------------- per-note caches (shared) */

/*
 * These values depend only on the note object, so one cache serves every
 * index (an import rebuilds the index, the old notes keep their cache).
 */
const searchTextCache = new WeakMap<Note, string>();
const sectionCache = new WeakMap<Note, string>();
const tagsCache = new WeakMap<Note, string[]>();

function noteSectionPath(note: Note): string {
  let hit = sectionCache.get(note);
  if (hit === undefined) {
    hit = foldPath(note.section ?? '');
    sectionCache.set(note, hit);
  }
  return hit;
}

function noteFoldedTags(note: Note): string[] {
  let hit = tagsCache.get(note);
  if (hit === undefined) {
    const out: string[] = [];
    for (const tag of note.tags ?? []) {
      const folded = foldTag(String(tag));
      if (folded !== '' && !out.includes(folded)) out.push(folded);
    }
    hit = out;
    tagsCache.set(note, hit);
  }
  return hit;
}

/** [folded, display] of every section prefix of a note, shortest first ('Verbs::B1' → verbs, verbs::b1). */
const sectionLabelsCache = new WeakMap<Note, [string, string][]>();
/** [folded, display] of every prefix of every tag of a note, cleaned like noteTags. */
const tagLabelsCache = new WeakMap<Note, [string, string][]>();

/**
 * The display text of each section prefix of a note, with its folded form
 * (sectionLabel's one pass over the notes reads it). Cached per note: a new
 * index after an edit reads the other notes from the cache (unit P1).
 */
function noteSectionLabels(note: Note): [string, string][] {
  let hit = sectionLabelsCache.get(note);
  if (hit === undefined) {
    hit = pathPrefixes(normalizePath(note.section ?? '')).map((prefix): [string, string] => [foldText(prefix), prefix]);
    sectionLabelsCache.set(note, hit);
  }
  return hit;
}

/** The same for the note's tags (tagLabel's one pass). */
function noteTagLabels(note: Note): [string, string][] {
  let hit = tagLabelsCache.get(note);
  if (hit === undefined) {
    hit = [];
    for (const tag of note.tags ?? []) {
      // Cleaned like noteTags, so every folded tag (and parent) has its label.
      for (const prefix of pathPrefixes(normalizeTag(String(tag)))) hit.push([foldText(prefix), prefix]);
    }
    tagLabelsCache.set(note, hit);
  }
  return hit;
}

/**
 * Make the section and tag labels of one note ahead of time (scope.ts
 * warmLibraryCaches calls it for the note of each card, in its small
 * slices). The label lookups of an index (warmLabels) then only read them.
 */
export function warmNoteLabels(note: Note): void {
  noteSectionLabels(note);
  noteTagLabels(note);
}

/** A line of folded text, white space collapsed. */
function foldLine(text: string): string {
  return foldText(text).replace(/\s+/g, ' ').trim();
}

/**
 * The text that free-text search looks in, one part per line (so a phrase
 * never matches across two fields): every field (hidden ones too: "stored and
 * searchable"), each tag, and the section. Tags and the section are added a
 * second time with '::' and '_' as spaces, so "topic alpha" finds the tag
 * Algo::Core_Patterns::Topic_Alpha.
 */
function noteSearchText(note: Note): string {
  let hit = searchTextCache.get(note);
  if (hit !== undefined) return hit;
  const parts: string[] = [];
  for (const raw of note.fields ?? []) {
    const line = foldLine(plainText(typeof raw === 'string' ? raw : String(raw ?? '')));
    if (line !== '') parts.push(line);
  }
  for (const tag of noteFoldedTags(note)) {
    parts.push(tag);
    const spaced = foldLine(tag.replace(/::|_/g, ' '));
    if (spaced !== tag) parts.push(spaced);
  }
  const section = noteSectionPath(note);
  if (section !== '') {
    parts.push(section);
    const spaced = foldLine(section.replace(/::|_/g, ' '));
    if (spaced !== section) parts.push(spaced);
  }
  hit = parts.join('\n');
  searchTextCache.set(note, hit);
  return hit;
}

/* ------------------------------------------------------------- the index */

/** One facet field of a card type: where it is and how it splits. */
interface Extractor {
  key: string;
  index: number;
  sep?: MultiSep;
}

/** The facet values of one note: folded (index.facetValues) and as shown (valueLabel), key by key. */
interface NoteFieldValues {
  folded: Map<string, string[]>;
  display: Map<string, string[]>;
}

/**
 * A reader of the facet values of notes, for one set of extractors (card type
 * → its facet fields), cached per note object. Only fields with a value are in it.
 */
function makeFieldValueReader(extractorsByType: ReadonlyMap<Id, readonly Extractor[]>): (note: Note) => NoteFieldValues {
  const cache = new WeakMap<Note, NoteFieldValues>();
  const none: NoteFieldValues = { folded: new Map(), display: new Map() };
  return (note) => {
    const hit = cache.get(note);
    if (hit !== undefined) return hit;
    const extractors = extractorsByType.get(note.typeId);
    let out = none;
    if (extractors) {
      out = { folded: new Map(), display: new Map() };
      for (const ex of extractors) {
        const { display, folded } = fieldValues(note.fields[ex.index] ?? '', ex.sep);
        if (folded.length > 0) {
          out.folded.set(ex.key, folded);
          out.display.set(ex.key, display);
        }
      }
      if (out.folded.size === 0) out = none;
    }
    cache.set(note, out);
    return out;
  };
}

/**
 * The value readers of recent indexes, by their extractors (unit P1). WHY:
 * every change of the notes (one edited card, an undo, an import) builds a
 * new index. Its facet values were made again for EVERY note on the next
 * FacetSheet opening or Level filter — ~16,000 notes of HTML. The values of a
 * note depend only on the note object and the extractors, so an index with
 * the same extractors (the usual case: an edit does not change which fields
 * are filter groups) shares the reader, and only the changed notes are read again.
 */
const fieldValueReaders = new Map<string, (note: Note) => NoteFieldValues>();
/** How many extractor sets keep their reader (the newest ones). */
const FIELD_VALUE_READERS_KEPT = 4;
/** The `facetValues` function of each reader (the same function for every index that shares the reader). */
const facetValuesByReader = new WeakMap<(note: Note) => NoteFieldValues, (note: Note) => Map<string, string[]>>();

/** The shared reader of these extractors (see fieldValueReaders). */
function fieldValueReaderFor(extractorsByType: ReadonlyMap<Id, readonly Extractor[]>): (note: Note) => NoteFieldValues {
  // An exact text of the extractors, in their order: the same text ⇔ the same values for every note.
  const signature = JSON.stringify(
    [...extractorsByType].map(([typeId, list]) => [typeId, list.map((ex) => [ex.key, ex.index, ex.sep ?? null])]),
  );
  let reader = fieldValueReaders.get(signature);
  if (reader) fieldValueReaders.delete(signature);
  else reader = makeFieldValueReader(extractorsByType);
  fieldValueReaders.set(signature, reader);
  while (fieldValueReaders.size > FIELD_VALUE_READERS_KEPT) fieldValueReaders.delete(fieldValueReaders.keys().next().value as string);
  return reader;
}

/** warmLabels asks `stop()` after this many notes (like the 64 cards of scope.ts warmLibraryCaches). */
export const LABEL_NOTES_PER_STOP = 64;

/**
 * One pass over the notes, in note order, that fills one label lookup (unit
 * P1 review). It can stop between two notes and go on later: `next` is the
 * next note. WHY: the three lookups were made in one go — about 14–25 ms in
 * node on 16,000 cards, so about 45–85 ms on the phone, with no chance to stop.
 * A pass gives the same lookup whether it runs in one go or in parts (the
 * notes come in the same order, and the first one seen wins).
 */
interface LabelPass {
  next: number;
  visit: (note: Note) => void;
}

/** Run a pass to its end (a reader needs the whole lookup now). */
function finishPass(pass: LabelPass, notes: readonly Note[]): void {
  while (pass.next < notes.length) {
    pass.visit(notes[pass.next]);
    pass.next += 1;
  }
}

/**
 * Build the index for one library. O(notes) for the maps; the per-note values
 * are computed lazily, on first use, and cached.
 */
export function buildLibraryIndex(notes: readonly Note[], noteTypes: readonly NoteType[]): LibraryIndex {
  const noteById = new Map<Id, Note>();
  for (const note of notes) noteById.set(note.id, note);
  const typeById = new Map<Id, NoteType>();
  for (const type of noteTypes) typeById.set(type.id, type);
  const fieldSpecs = fieldFacetSpecs(noteTypes, notes);

  // Card type → its facet fields, so a note reads only its own fields.
  const extractorsByType = new Map<Id, Extractor[]>();
  for (const spec of fieldSpecs.values()) {
    for (const [typeId, index] of spec.fieldIndexByType) {
      const list = extractorsByType.get(typeId) ?? [];
      list.push({ key: spec.key, index, ...(spec.multiSep ? { sep: spec.multiSep } : {}) });
      extractorsByType.set(typeId, list);
    }
  }

  // Facet values depend on the extractors (from fieldSpecs): an index with the
  // same extractors shares one cache per note (fieldValueReaderFor).
  const readValues = fieldValueReaderFor(extractorsByType);
  // ONE function per reader: an index with the same extractors gives the same
  // facetValues function, so facets.ts can keep its per-note data across indexes.
  let facetValues = facetValuesByReader.get(readValues);
  if (!facetValues) {
    const fn = (note: Note): Map<string, string[]> => readValues(note).folded;
    facetValuesByReader.set(readValues, fn);
    facetValues = fn;
  }

  // Display labels: ONE pass over the notes per lookup (first seen wins).
  // A reader finishes its pass on first use; warmLabels makes the passes a
  // part at a time while the phone is idle (see LabelPass). A reader never
  // sees a half-made lookup: it finishes the pass first.
  const valueLabels = new Map<string, Map<string, string>>();
  const valuePass: LabelPass = {
    next: 0,
    visit: (note) => {
      // The note's values in extractor order, only the fields with a value (as fieldValues gives them).
      const { folded: foldedByKey, display: displayByKey } = readValues(note);
      for (const [groupKey, fs] of foldedByKey) {
        const display = displayByKey.get(groupKey) ?? fs;
        let byValue = valueLabels.get(groupKey);
        if (!byValue) {
          byValue = new Map();
          valueLabels.set(groupKey, byValue);
        }
        fs.forEach((f, i) => {
          if (!byValue.has(f)) byValue.set(f, display[i]);
        });
      }
    },
  };
  const valueLabel = (key: string, folded: string): string => {
    finishPass(valuePass, notes);
    return valueLabels.get(key)?.get(folded) ?? folded;
  };

  const sectionLabels = new Map<string, string>();
  const sectionPass: LabelPass = {
    next: 0,
    visit: (note) => {
      for (const [f, prefix] of noteSectionLabels(note)) if (!sectionLabels.has(f)) sectionLabels.set(f, prefix);
    },
  };
  const sectionLabel = (foldedPath: string): string => {
    finishPass(sectionPass, notes);
    return sectionLabels.get(foldedPath) ?? foldedPath;
  };

  const tagLabels = new Map<string, string>();
  const tagPass: LabelPass = {
    next: 0,
    visit: (note) => {
      for (const [f, prefix] of noteTagLabels(note)) if (!tagLabels.has(f)) tagLabels.set(f, prefix);
    },
  };
  const tagLabel = (foldedTag: string): string => {
    finishPass(tagPass, notes);
    return tagLabels.get(foldedTag) ?? foldedTag;
  };

  // The three passes one after the other, LABEL_NOTES_PER_STOP notes between
  // two questions to `stop` (counted over all three, so a slice never does more).
  const labelPasses = [valuePass, sectionPass, tagPass];
  const warmLabels = (stop: () => boolean): boolean => {
    let visited = 0;
    for (const pass of labelPasses) {
      while (pass.next < notes.length) {
        // Asked only when there is more to do, so every call moves on.
        if (visited === LABEL_NOTES_PER_STOP) {
          if (stop()) return false;
          visited = 0;
        }
        pass.visit(notes[pass.next]);
        pass.next += 1;
        visited += 1;
      }
    }
    return true;
  };

  return {
    noteById,
    typeById,
    searchText: noteSearchText,
    facetValues,
    fieldSpecs,
    sectionPath: noteSectionPath,
    noteTags: noteFoldedTags,
    valueLabel,
    sectionLabel,
    tagLabel,
    warmLabels,
  };
}

/** Card by id and card ids by note, in one pass. */
export function buildCardLookup(cards: readonly Card[]): CardLookup {
  const cardById = new Map<Id, Card>();
  const cardIdsByNote = new Map<Id, Id[]>();
  for (const card of cards) {
    cardById.set(card.id, card);
    const ids = cardIdsByNote.get(card.noteId);
    if (ids) ids.push(card.id);
    else cardIdsByNote.set(card.noteId, [card.id]);
  }
  return { cardById, cardIdsByNote };
}

/* ----------------------------------------------------------------- memos */

/**
 * A function that returns the same LibraryIndex until `notes` or `noteTypes`
 * is a different ARRAY (identity check, like React's memo). A rating changes
 * only `cards`, so it never rebuilds the index.
 *
 *   const indexOf = libraryIndexMemo();
 *   indexOf(state.notes, state.noteTypes) === indexOf(state.notes, state.noteTypes)  // true
 */
export function libraryIndexMemo(): (notes: readonly Note[], noteTypes: readonly NoteType[]) => LibraryIndex {
  let lastNotes: readonly Note[] | null = null;
  let lastTypes: readonly NoteType[] | null = null;
  let last: LibraryIndex | null = null;
  return (notes, noteTypes) => {
    if (last === null || notes !== lastNotes || noteTypes !== lastTypes) {
      last = buildLibraryIndex(notes, noteTypes);
      lastNotes = notes;
      lastTypes = noteTypes;
    }
    return last;
  };
}

/** The same for CardLookup: rebuilt only when `cards` is a different array. */
export function cardLookupMemo(): (cards: readonly Card[]) => CardLookup {
  let lastCards: readonly Card[] | null = null;
  let last: CardLookup | null = null;
  return (cards) => {
    if (last === null || cards !== lastCards) {
      last = buildCardLookup(cards);
      lastCards = cards;
    }
    return last;
  };
}
