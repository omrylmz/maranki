/**
 * Search syntax (spec §4.2): typed text → a flat Query, and back.
 *
 *   parseSearch('haus tag:b1 level:a2 -is:suspended', ctx)
 *     → query { text: 'haus', tags: ['b1'], fields: { level: ['a2'] }, notFlags: ['suspended'] }
 *
 * | You type                                   | Becomes                                         |
 * |--------------------------------------------|-------------------------------------------------|
 * | haus küche                                 | text (every word must match, any field)         |
 * | "die stunde"                               | one phrase                                      |
 * | deck:german  deck:"German Verbs"           | decks (folded name PREFIX; several → all)       |
 * | section:verbs::b1                          | sections (deck = the only Deck chip, else every |
 * |                                            |   deck that has the section)                    |
 * | tag:algo  -tag:leech                   | tags / notTags                                  |
 * | level:b1  type:verb  category:"core …"     | fields — only when that facet field exists in   |
 * |                                            |   scope; else text + hint "No field called …"   |
 * | is:new is:notstarted is:learning is:review | life                                            |
 * |   is:mastered is:known                     |                                                 |
 * | is:due  is:duetoday                        | due                                             |
 * | is:fav is:flagged is:suspended is:buried   | flags; with '-' → notFlags                      |
 * |   is:paused                                |                                                 |
 * | is:hard  is:young  is:leech                | the boolean groups                              |
 * | dir:1 (ord + 1)                            | directions                                      |
 *
 * Rules:
 *   - A token needs a word start before it: `hashtag:x` is NOT `tag:x` (it is
 *     a field token for a field called "hashtag", which does not exist → text).
 *   - In a field name or a section, '_' may stand for a space:
 *     `example_translation:x`, `section:core_patterns` ("Core Patterns").
 *   - A field is also found by the name its chip shows (fieldKeyFor, wave
 *     5c): the chip "Word Type: noun" (field "WordType") works as
 *     `word_type:noun`, `wordtype:noun` or `word-type:noun`; "Example"
 *     (field "MarankiExample") as `example:…`; "Verb type" as `verb_type:…`.
 *   - In a tag it is the other way round: a space stands for '_'. Anki tags
 *     have no spaces, and the tag tree shows '_' as a space, so people type
 *     what they see: `tag:"topic alpha"` is the tag `topic_alpha`. The
 *     tree shows only the LAST part of a nested tag, so a value that is not
 *     a tag itself is read as the last part(s) of a tag path:
 *     `tag:"topic alpha"` finds Algo::Core_Patterns::Topic_Alpha
 *     (searchTags). A tag that no note in the scope has still becomes a
 *     chip, with the hint "No tag called 'x' here." (so 0 results are
 *     explained).
 *   - A field value works the same way: `level:b3` is a chip with the hint
 *     "No Level 'b3' here." when no note in the scope has B3, and '_' may
 *     stand for a space (`category:core_patterns` → "Core Patterns").
 *   - Small aliases: `is:favorite` = `is:fav`, `is:recent` = `is:young`
 *     ("Recent" is the chip label), `is:not-started` = `is:notstarted`.
 *   - Tokens repeat: `tag:b1 tag:verb` keeps both (tags is an OR group).
 *   - Everything folds accents and case: `uber` finds `über`.
 *   - Every typed token becomes a chip; there is no OR across groups, so no
 *     "custom search" escape is needed.
 *
 * Also here: `chipsOf` (one chip per query group, with its label),
 * `removeChip`, `mergeQueries` (add parsed tokens to the chips already there),
 * `formatSearch` (a query back to text; parse(format(q)) gives q again) and
 * `chipOnlyPart` (the chips that text cannot say exactly, kept as chips).
 *
 * FIELD NAMES ARE USER DATA (see query.ts): fields are collected in a Map and
 * written with `fieldRecord`; the `is:` words are Maps, so `is:constructor`
 * is an unknown filter, not the inherited `Object` function.
 *
 * Pure: no React, no I/O.
 */
import {
  type DirectionSources,
  directionLabel,
  directionLabels,
  DUE_LABELS,
  type FacetKey,
  fieldGroupLabel,
  fieldShownName,
  FLAG_LABELS,
} from './facets';
import { fieldKey, foldPath, foldTag, pathPrefixes } from './libraryIndex';
import { LIFE_LABELS } from './life';
import type { Card, Deck, FacetFieldSpec, FlagKey, Id, LifeKey, Note, Query } from './model';
import { fieldRecord, type MatchCtx, sameQuery, sanitizeQuery } from './query';
import { foldText } from './text';

/* ------------------------------------------------------------- context */

/** What the parser needs to know about the current scope. */
export interface SearchCtx {
  /** Every deck (`deck:` resolves by folded name prefix). */
  decks: readonly Deck[];
  /** The facet fields that exist in the scope (`level:` works only when 'level' is here). */
  fieldSpecs: ReadonlyMap<string, FacetFieldSpec>;
  /**
   * The names a learner may type for a field of `fieldSpecs`, written
   * `typedName()` (folded, no spaces, '_' or '-') → the field's key: its key
   * and the readable name its chip shows (facets fieldShownName, with the
   * label a card type chose). A name two fields share is left out. Absent =
   * built from `fieldSpecs` without the chosen labels (fieldKeyFor).
   */
  fieldNames?: ReadonlyMap<string, string>;
  /**
   * Field key (of `fieldSpecs`) → every folded value the notes in the scope
   * have (multi-value fields: each token). `level:b3` adds the hint
   * "No Level 'b3' here." when b3 is not here, and `category:core_patterns`
   * finds "Core Patterns" ('_' for a space, like `section:`). Absent = not
   * known: no hint, no '_' rule.
   */
  fieldValues?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Deck id → every folded section path (and each parent path) that has cards in the scope. */
  sectionsByDeck: ReadonlyMap<Id, ReadonlySet<string>>;
  /**
   * Every folded tag of the notes in the scope, and every parent of one
   * ('algo', 'algo::core_patterns'). `tag:x` adds a hint when x is not
   * here. Absent = not known: no hint.
   */
  tags?: ReadonlySet<string>;
  /** The card types of the cards in the scope (chip labels of Direction use only these). */
  typeIds?: ReadonlySet<Id>;
  /**
   * Direction ord → card type → the decks with cards of that type and ord,
   * in the scope. The Direction chip label is built from it exactly like the
   * FacetSheet value (incl. the deck languages of card types made in the app).
   */
  directionSources?: DirectionSources;
  /** The chips already applied. `section:` uses their Deck chip when there is exactly one. */
  base?: Query;
}

/**
 * Build the SearchCtx of a scope from its cards: the facet fields of the card
 * types in the pool, the sections each deck has there, the tags, and where
 * each direction comes from.
 */
export function buildSearchCtx(pool: readonly Card[], ctx: MatchCtx, base?: Query): SearchCtx {
  const { index } = ctx;
  const typesInScope = new Set<Id>();
  const sectionsByDeck = new Map<Id, Set<string>>();
  const tags = new Set<string>();
  const valuesByField = new Map<string, Set<string>>();
  const seenNotes = new Set<Note>();
  const directionSources = new Map<number, Map<Id, Set<Id>>>();
  for (const card of pool) {
    const note = index.noteById.get(card.noteId);
    if (!note) continue;
    typesInScope.add(note.typeId);
    let byType = directionSources.get(card.ord);
    if (!byType) directionSources.set(card.ord, (byType = new Map()));
    let deckIds = byType.get(note.typeId);
    if (!deckIds) byType.set(note.typeId, (deckIds = new Set()));
    deckIds.add(card.deckId);
    // Tags belong to the note: read them once per note, not once per card.
    if (!seenNotes.has(note)) {
      seenNotes.add(note);
      for (const tag of index.noteTags(note)) for (const prefix of pathPrefixes(tag)) tags.add(prefix);
      for (const [key, values] of index.facetValues(note)) {
        let set = valuesByField.get(key);
        if (!set) valuesByField.set(key, (set = new Set()));
        for (const v of values) set.add(v);
      }
    }
    const path = index.sectionPath(note);
    if (path === '') continue;
    let set = sectionsByDeck.get(card.deckId);
    if (!set) sectionsByDeck.set(card.deckId, (set = new Set()));
    for (const prefix of pathPrefixes(path)) set.add(prefix);
  }
  const fieldSpecs = new Map<string, FacetFieldSpec>();
  const fieldValues = new Map<string, ReadonlySet<string>>();
  for (const [key, spec] of index.fieldSpecs) {
    for (const typeId of spec.fieldIndexByType.keys()) {
      if (typesInScope.has(typeId)) {
        fieldSpecs.set(key, spec);
        fieldValues.set(key, valuesByField.get(key) ?? new Set());
        break;
      }
    }
  }
  return {
    decks: [...ctx.decks.values()],
    fieldSpecs,
    fieldValues,
    fieldNames: typedFieldNames(fieldSpecs, (spec) => fieldShownName(spec.label, { spec, typeById: index.typeById })),
    sectionsByDeck,
    tags,
    typeIds: typesInScope,
    directionSources,
    ...(base ? { base } : {}),
  };
}

/* ------------------------------------------------------- field names */

/**
 * A field name as the search box compares it: folded (lower case, no
 * accents), with every space, '_' and '-' removed. So the chip name
 * "Word Type", the field name "WordType" and the typed `word_type` are all
 * 'wordtype'.
 */
export function typedName(name: string): string {
  return foldText(name).replace(/[\s_-]+/g, '');
}

/**
 * typedName() → field key for every field of `fieldSpecs`: its key and its
 * readable name (`shownName`). A name that two fields share is left out (it
 * would be a guess).
 */
function typedFieldNames(
  fieldSpecs: ReadonlyMap<string, FacetFieldSpec>,
  shownName: (spec: FacetFieldSpec) => string,
): Map<string, string> {
  const out = new Map<string, string>();
  const shared = new Set<string>();
  for (const [key, spec] of fieldSpecs) {
    for (const name of new Set([typedName(key), typedName(shownName(spec))])) {
      if (name === '' || shared.has(name)) continue;
      const other = out.get(name);
      if (other === undefined) out.set(name, key);
      else if (other !== key) {
        out.delete(name);
        shared.add(name);
      }
    }
  }
  return out;
}

/**
 * The field a typed key means (the part before ':', folded), or null when
 * the scope has no such field (spec §4.2). In this order, so a real field
 * name always wins:
 *   1. the key itself, the folded field name: `level`, `wordtype`;
 *   2. '_' for a space: `example_translation` → the field "Example translation";
 *   3. the name the field's chip shows, with spaces, '_' and '-' left out
 *      (typedName, wave 5c): the chip "Word Type: noun" (field "WordType")
 *      → `word_type`, `word-type`; "CEFR Level" → `cefr_level`; "Example"
 *      (field "MarankiExample") → `example`; "Verb type" (the German Verbs
 *      field "Tags") → `verb_type`.
 * libraryState asks it too, to know whether a token's value is half-typed.
 *
 *   fieldKeyFor('word_type', sctx)   → 'wordtype'
 *   fieldKeyFor('colour', sctx)      → null   ("No field called 'colour' here.")
 */
export function fieldKeyFor(typed: string, ctx: Pick<SearchCtx, 'fieldSpecs' | 'fieldNames'>): string | null {
  if (ctx.fieldSpecs.has(typed)) return typed;
  const spaced = fieldKey(typed.replace(/_/g, ' '));
  if (ctx.fieldSpecs.has(spaced)) return spaced;
  const names = ctx.fieldNames ?? typedFieldNames(ctx.fieldSpecs, (spec) => fieldShownName(spec.label));
  const key = names.get(typedName(typed));
  return key !== undefined && ctx.fieldSpecs.has(key) ? key : null;
}

/* ------------------------------------------------------------ tokenize */

interface Token {
  /** The text exactly as typed (for `rest`). */
  raw: string;
  /** A "quoted phrase" (no key). */
  phrase: boolean;
  /** Leading '-' on a key:value token. */
  neg: boolean;
  /** The folded key of a key:value token, else null. */
  key: string | null;
  /** The key as typed (for the hint text). */
  keyRaw: string;
  /** The value (quotes removed), or the phrase / word. */
  value: string;
}

/**
 * A key: a letter first, then letters, digits, '_' or '-' (folded, so lower
 * case). The range U+00C0 to U+FFFF is every character from 'À' up, so a
 * field name in another script ('уровень:') is a key too. The range is
 * written with escapes: the literal U+FFFF is invisible and an editor can
 * damage it (the same rule as text.ts).
 */
const KEY = /^[a-z\u00C0-\uFFFF][a-z0-9_\-\u00C0-\uFFFF]*$/;
const SPACE = /\s/;

/** Split the input into words, "quoted phrases" and key:value / key:"quoted value" tokens. */
function tokenize(s: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && SPACE.test(s[i])) i += 1;
    if (i >= s.length) break;
    const start = i;
    if (s[i] === '"') {
      const end = s.indexOf('"', i + 1);
      i = end === -1 ? s.length : end + 1;
      const value = s.slice(start + 1, end === -1 ? s.length : end);
      out.push({ raw: s.slice(start, i), phrase: true, neg: false, key: null, keyRaw: '', value });
      continue;
    }
    let j = i;
    while (j < s.length && !SPACE.test(s[j])) {
      if (s[j] === ':' && s[j + 1] === '"') {
        // key:"quoted value" — the value may hold spaces; the token ends at the closing quote.
        const end = s.indexOf('"', j + 2);
        j = end === -1 ? s.length : end + 1;
        break;
      }
      j += 1;
    }
    out.push(classify(s.slice(i, j)));
    i = j;
  }
  return out;
}

/** A word → a key:value token when it looks like one, else a plain word. */
function classify(raw: string): Token {
  const word: Token = { raw, phrase: false, neg: false, key: null, keyRaw: '', value: raw };
  const colon = raw.indexOf(':');
  if (colon <= 0) return word;
  const neg = raw[0] === '-';
  const keyRaw = raw.slice(neg ? 1 : 0, colon);
  const key = foldText(keyRaw);
  if (!KEY.test(key)) return word;
  let value = raw.slice(colon + 1);
  if (value.startsWith('"')) value = value.slice(1, value.endsWith('"') && value.length > 1 ? -1 : undefined);
  // 'note:' alone, or a link ('http://…'), is text.
  if (value.trim() === '' || value.startsWith('/')) return word;
  return { raw, phrase: false, neg, key, keyRaw, value };
}

/* --------------------------------------------------------------- parse */

/** Folded, trimmed, white space collapsed. */
function foldWord(s: string): string {
  return foldText(s).replace(/\s+/g, ' ').trim();
}

/*
 * The `is:` words. Maps, not objects: the word is typed by the user, and on
 * an object `is:constructor` would find the inherited `Object` function.
 */
const LIFE_WORDS: ReadonlyMap<string, LifeKey> = new Map([
  ['new', 'new'],
  ['notstarted', 'notStarted'],
  ['learning', 'learning'],
  ['review', 'review'],
  ['mastered', 'mastered'],
  ['known', 'known'],
]);
const FLAG_WORDS: ReadonlyMap<string, FlagKey> = new Map([
  ['fav', 'fav'],
  ['favorite', 'fav'],
  ['flagged', 'flagged'],
  ['suspended', 'suspended'],
  ['buried', 'buried'],
  ['paused', 'paused'],
]);
const BOOL_WORDS: ReadonlyMap<string, 'hard' | 'young' | 'leech'> = new Map([
  ['hard', 'hard'],
  ['young', 'young'],
  ['recent', 'young'],
  ['leech', 'leech'],
]);

/**
 * The folded tag that `tag:<value>` means. A space stands for '_' (a real Anki
 * tag has no space; the tag tree shows '_' as a space), unless a tag WITH the
 * space exists in the scope (one made in the app).
 *
 *   searchTag('Topic Alpha')                   → 'topic_alpha'
 *   searchTag('Algo :: Core Patterns')      → 'algo::core_patterns'
 *   searchTag('my tag', new Set(['my tag']))    → 'my tag'
 */
function searchTag(value: string, known?: ReadonlySet<string>): string {
  const folded = foldTag(value);
  if (known?.has(folded)) return folded;
  return folded.replace(/ /g, '_');
}

/**
 * The tags that `tag:<value>` means in the scope (an OR group). A tag that
 * exists (or a parent of one) is itself. Otherwise the value is read as the
 * LAST part(s) of a tag path, which is what the tag tree shows: the tree
 * shows "Topic Alpha" for 'Algo::Core_Patterns::Topic_Alpha', so
 * `tag:"topic alpha"` means that full path (spec §4.1 matching is
 * unchanged: a tag matches itself and its children). Every path that ends
 * so is in the group; a path under another one found is left out (the
 * parent already covers it). No such path, or a scope that does not know its
 * tags → the value as searchTag reads it (a chip that finds nothing).
 *
 *   searchTags('topic alpha', tags)               → ['algo::core_patterns::topic_alpha']
 *   searchTags('core_patterns::topic_alpha', tags) → ['algo::core_patterns::topic_alpha']
 *   searchTags('algo', tags)                    → ['algo']
 *   searchTags('nope', tags)                        → ['nope']   (+ the hint "No tag called 'nope' here.")
 */
function searchTags(value: string, known?: ReadonlySet<string>): { tags: string[]; found: boolean } {
  const tag = searchTag(value, known);
  if (tag === '' || !known) return { tags: [tag], found: true };
  if (known.has(tag)) return { tags: [tag], found: true };
  // '_' for a space (an Anki tag), or the spaces as typed (a tag made in the app).
  const asTyped = `::${foldTag(value)}`;
  const underscored = `::${tag}`;
  const ends = [...known].filter((path) => path.endsWith(underscored) || path.endsWith(asTyped)).sort();
  const top = ends.filter((path) => !ends.some((other) => other !== path && path.startsWith(`${other}::`)));
  return top.length > 0 ? { tags: top, found: true } : { tags: [tag], found: false };
}

export interface ParsedSearch {
  /** The chips the input asks for (text included as `text`). */
  query: Query;
  /**
   * The free text exactly as typed, with every token that became a chip
   * removed: what stays in the search box while the user types.
   */
  rest: string;
  /** Short messages for tokens that could not become chips ("No field called 'level' here."). */
  hints: string[];
}

/**
 * Parse typed search text into a flat query (see the file header). A token
 * that cannot become a chip stays TEXT (so the search still runs) and adds a
 * hint; it never throws.
 *
 * `hold` (optional): a token for which it returns true (it gets the token as
 * typed) stays TEXT in its place, with no hint. The Library uses it for a
 * HALF-typed token (`level:b`): the box keeps it where the learner typed it,
 * between the words around it, while the complete tokens become chips
 * (libraryState parseForList, wave 5c).
 *
 *   parseSearch('level:b haus is:due', ctx, (raw) => raw === 'level:b').rest   → 'level:b haus'
 */
export function parseSearch(input: string, ctx: SearchCtx, hold?: (raw: string) => boolean): ParsedSearch {
  const q: Query = {};
  // A Map, not {}: the field name is user data ('constructor'). Written to q at the end.
  const fields = new Map<string, string[]>();
  const hints: string[] = [];
  const textParts: string[] = [];
  const restParts: string[] = [];
  const pendingSections: { path: string; raw: string }[] = [];
  const addHint = (hint: string) => {
    if (!hints.includes(hint)) hints.push(hint);
  };
  const keepAsText = (t: Token, hint?: string) => {
    textParts.push(t.phrase ? `"${foldWord(t.value)}"` : foldWord(t.raw));
    restParts.push(t.raw);
    if (hint) addHint(hint);
  };
  const unknown = (t: Token) => `Unknown filter '${t.raw}'.`;

  for (const t of tokenize(input ?? '')) {
    if (t.key === null || (hold !== undefined && hold(t.raw))) {
      keepAsText(t);
      continue;
    }
    const value = foldWord(t.value);
    switch (t.key) {
      case 'deck': {
        if (t.neg) {
          keepAsText(t, unknown(t));
          break;
        }
        const ids = ctx.decks.filter((d) => foldWord(d.name).startsWith(value)).map((d) => d.id);
        if (ids.length === 0) keepAsText(t, `No deck called '${t.value}'.`);
        else q.decks = [...(q.decks ?? []), ...ids];
        break;
      }
      case 'section':
        if (t.neg) keepAsText(t, unknown(t));
        else pendingSections.push({ path: foldPath(t.value), raw: t.raw });
        break;
      case 'tag': {
        // The full tag path(s): `tag:"topic alpha"` finds Algo::Core_Patterns::Topic_Alpha.
        const { tags, found } = searchTags(t.value, ctx.tags);
        if (t.neg) q.notTags = [...(q.notTags ?? []), ...tags];
        else {
          q.tags = [...(q.tags ?? []), ...tags];
          // Still a chip (spec §4.2), but say why it finds nothing. (A '-tag:'
          // of a missing tag excludes nothing, so it needs no hint.)
          if (!found) addHint(`No tag called '${t.value.trim()}' here.`);
        }
        break;
      }
      case 'is': {
        const word = value.replace(/[\s_-]/g, '');
        const flag = FLAG_WORDS.get(word);
        const lifeKey = LIFE_WORDS.get(word);
        const toggle = BOOL_WORDS.get(word);
        if (flag) {
          if (t.neg) q.notFlags = [...(q.notFlags ?? []), flag];
          else q.flags = [...(q.flags ?? []), flag];
        } else if (t.neg) {
          keepAsText(t, unknown(t));
        } else if (lifeKey) {
          q.life = [...(q.life ?? []), lifeKey];
        } else if (word === 'due') {
          q.due = 'now';
        } else if (word === 'duetoday') {
          q.due = 'today';
        } else if (toggle) {
          q[toggle] = true;
        } else {
          keepAsText(t, unknown(t));
        }
        break;
      }
      case 'dir': {
        const n = /^\d+$/.test(value) ? Number(value) : 0;
        if (t.neg || n < 1) keepAsText(t, unknown(t));
        else q.directions = [...(q.directions ?? []), n - 1];
        break;
      }
      default: {
        // A field: 'level', 'example_translation' for the field "Example translation",
        // or the name its chip shows ('word_type' for "Word Type"): fieldKeyFor.
        const key = fieldKeyFor(t.key, ctx);
        if (key === null) keepAsText(t, `No field called '${t.keyRaw}' here.`);
        else if (t.neg) keepAsText(t, unknown(t));
        else {
          // The value as the notes have it: as typed, else '_' for a space
          // (`category:core_patterns` → "Core Patterns", like `section:`).
          const known = ctx.fieldValues?.get(key);
          let v = value;
          if (known && !known.has(v) && v.includes('_')) {
            const spaced = foldWord(v.replace(/_/g, ' '));
            if (known.has(spaced)) v = spaced;
          }
          fields.set(key, [...(fields.get(key) ?? []), v]);
          // Still a chip (like a missing tag), but say why it finds nothing.
          if (known && v !== '' && !known.has(v)) {
            const label = fieldShownName(ctx.fieldSpecs.get(key)?.label ?? key);
            addHint(`No ${label} '${t.value.trim()}' here.`);
          }
        }
      }
    }
  }
  if (fields.size > 0) q.fields = fieldRecord(fields);

  // Sections: the only Deck chip if there is one, else every deck that has the section.
  if (pendingSections.length > 0) {
    const deckChips = new Set([...(ctx.base?.decks ?? []), ...(q.decks ?? [])]);
    for (const pending of pendingSections) {
      const { raw } = pending;
      const candidates = deckChips.size === 1 ? [...deckChips] : [...ctx.sectionsByDeck.keys()];
      const having = (p: string) => candidates.filter((deckId) => ctx.sectionsByDeck.get(deckId)?.has(p));
      // Exact path first; else '_' typed for a space ('section:core_patterns' → "Core Patterns").
      let path = pending.path;
      let found = having(path);
      if (found.length === 0 && path.includes('_')) {
        path = foldPath(path.replace(/_/g, ' '));
        found = having(path);
      }
      if (found.length === 0) {
        textParts.push(foldWord(raw));
        restParts.push(raw);
        addHint(`No section called '${raw.slice(raw.indexOf(':') + 1).replace(/"/g, '')}' here.`);
      } else {
        q.sections = [...(q.sections ?? []), ...found.map((deckId) => ({ deckId, path }))];
      }
    }
  }

  const text = textParts.filter((p) => p !== '' && p !== '""').join(' ');
  if (text !== '') q.text = text;
  return { query: sanitizeQuery(q), rest: restParts.join(' '), hints };
}

/* -------------------------------------------------------------- merge */

/**
 * Add the chips of `extra` (a parsed search) to `q`: OR groups and flags gain
 * the new values, text words are added, `due` and `list` take the new value.
 */
export function mergeQueries(q: Query, extra: Query): Query {
  const a = sanitizeQuery(q);
  const b = sanitizeQuery(extra);
  const union = <T>(x: readonly T[] | undefined, y: readonly T[] | undefined): T[] | undefined =>
    x || y ? [...(x ?? []), ...(y ?? [])] : undefined;
  // A Map, not {}: field names are user data.
  const fields = new Map<string, string[]>(Object.entries(a.fields ?? {}));
  for (const [k, v] of Object.entries(b.fields ?? {})) fields.set(k, [...(fields.get(k) ?? []), ...v]);
  return sanitizeQuery({
    list: b.list ?? a.list,
    decks: union(a.decks, b.decks),
    sections: union(a.sections, b.sections),
    fields: fieldRecord(fields),
    noteTypes: union(a.noteTypes, b.noteTypes),
    directions: union(a.directions, b.directions),
    tags: union(a.tags, b.tags),
    notTags: union(a.notTags, b.notTags),
    life: union(a.life, b.life),
    due: b.due ?? a.due,
    flags: union(a.flags, b.flags),
    notFlags: union(a.notFlags, b.notFlags),
    hard: a.hard || b.hard,
    young: a.young || b.young,
    leech: a.leech || b.leech,
    text: [a.text, b.text].filter(Boolean).join(' '),
  });
}

/* ------------------------------------------------------------- format */

/** A value as one token: quoted when it holds a space (quote marks inside are dropped). */
function quote(v: string): string {
  return /[\s"]/.test(v) ? `"${v.replace(/"/g, '')}"` : v;
}

const LIFE_TOKENS: Record<LifeKey, string> = {
  notStarted: 'notstarted',
  new: 'new',
  learning: 'learning',
  review: 'review',
  mastered: 'mastered',
  known: 'known',
};

/**
 * What formatSearch and chipOnlyPart need to know about the scope: the same
 * things parseSearch uses. A SearchCtx (buildSearchCtx) has them all; pass
 * the SAME object to formatSearch, chipOnlyPart and parseSearch.
 */
export type FormatScope = Pick<
  SearchCtx,
  'decks' | 'fieldSpecs' | 'fieldNames' | 'fieldValues' | 'sectionsByDeck' | 'tags' | 'base'
>;

/** A query split into the tokens text can say and the chips it cannot. */
interface TextSplit {
  /** What formatSearch writes, in a fixed order. */
  tokens: string[];
  /** What chipOnlyPart returns (sanitized). */
  kept: Query;
}

const NO_DECKS: ReadonlyMap<Id, Deck> = new Map();

/**
 * Split a query into text tokens and chips that must stay chips.
 *
 * With a `scope`, a token is written only when parseSearch (in that scope)
 * gives back EXACTLY its chip; everything else is kept as a chip. The check
 * runs parseSearch itself on the token, so it can never disagree with it:
 *   - `deck:<name>` matches by folded name PREFIX (spec §4.2): `deck:German`
 *     also gives "German Verbs". Such a deck is written only when every deck
 *     it gives back is a Deck chip of the query too; else it stays a chip.
 *   - `section:p` goes to "the only Deck chip" when the parser sees exactly
 *     one (scope.base + the written Deck tokens), else to EVERY deck of the
 *     scope that has p. A section chip of one deck ("German › Verbs" while
 *     "Español › Verbs" exists) would widen, so it stays a chip.
 *   - a field, tag or text token that would parse into another group (a field
 *     called "Deck", a name with ':' or '"', text like 'is:new') stays a chip.
 * `list` and `noteTypes` have no syntax: always chips. Deck names come from
 * `scope.decks`, the same list parseSearch matches against.
 *
 * Without a scope every token is written (deck names from `deckById`). The
 * text may then widen a Deck or a Section chip, as described above.
 */
function splitForText(q: Query, deckById: ReadonlyMap<Id, Deck>, scope?: FormatScope): TextSplit {
  const n = sanitizeQuery(q);
  const tokens: string[] = [];
  const keptDecks: Id[] = [];
  const keptSections: { deckId: Id; path: string }[] = [];
  // A Map, not {}: field names are user data ('constructor').
  const keptFields = new Map<string, string[]>();
  const keptTags: string[] = [];
  const keptNotTags: string[] = [];
  let keptText: string | undefined;

  // The parser's view: the scope, plus the Deck chips it will have seen (for `section:`).
  const seenDecks = new Set<Id>(scope?.base?.decks ?? []);
  const parsed = (token: string): Query =>
    scope
      ? parseSearch(token, {
          decks: scope.decks,
          fieldSpecs: scope.fieldSpecs,
          ...(scope.fieldNames ? { fieldNames: scope.fieldNames } : {}),
          ...(scope.fieldValues ? { fieldValues: scope.fieldValues } : {}),
          sectionsByDeck: scope.sectionsByDeck,
          ...(scope.tags ? { tags: scope.tags } : {}),
          base: { decks: [...seenDecks] },
        }).query
      : {};
  /** Write `token` when it parses back to exactly `chip` (always, without a scope). */
  const say = (token: string, chip: Query): boolean => {
    if (scope && !sameQuery(parsed(token), chip)) return false;
    tokens.push(token);
    return true;
  };

  // Decks (first: the Deck tokens decide where `section:` goes).
  const deckChips = new Set(n.decks ?? []);
  const named = scope ? new Map(scope.decks.map((d) => [d.id, d])) : deckById;
  for (const id of n.decks ?? []) {
    const deck = named.get(id);
    if (!deck) {
      // A deck the parser does not know (deleted): only a chip can hold it.
      if (scope) keptDecks.push(id);
      continue;
    }
    const token = `deck:${quote(deck.name)}`;
    if (!scope) {
      tokens.push(token);
      continue;
    }
    const back = parsed(token);
    const backDecks = back.decks ?? [];
    const exact = Object.keys(back).length === 1 && backDecks.includes(id) && backDecks.every((x) => deckChips.has(x));
    if (exact) {
      tokens.push(token);
      for (const x of backDecks) seenDecks.add(x);
    } else keptDecks.push(id);
  }

  // Sections: one token per path; parsing gives it back to every deck that has it (or the only Deck chip).
  const sectionsByPath = new Map<string, { deckId: Id; path: string }[]>();
  for (const s of n.sections ?? []) {
    const list = sectionsByPath.get(s.path) ?? [];
    list.push(s);
    sectionsByPath.set(s.path, list);
  }
  for (const [path, sections] of sectionsByPath) {
    if (!say(`section:${quote(path)}`, { sections })) keptSections.push(...sections);
  }

  for (const [key, values] of Object.entries(n.fields ?? {})) {
    for (const v of values) {
      if (!say(`${key.replace(/ /g, '_')}:${quote(v)}`, { fields: fieldRecord([[key, [v]]]) })) {
        keptFields.set(key, [...(keptFields.get(key) ?? []), v]);
      }
    }
  }
  for (const ord of n.directions ?? []) tokens.push(`dir:${ord + 1}`);
  for (const t of n.tags ?? []) if (!say(`tag:${quote(t)}`, { tags: [t] })) keptTags.push(t);
  for (const t of n.notTags ?? []) if (!say(`-tag:${quote(t)}`, { notTags: [t] })) keptNotTags.push(t);
  for (const k of n.life ?? []) tokens.push(`is:${LIFE_TOKENS[k]}`);
  if (n.due === 'now') tokens.push('is:due');
  if (n.due === 'today') tokens.push('is:duetoday');
  for (const f of n.flags ?? []) tokens.push(`is:${f}`);
  for (const f of n.notFlags ?? []) tokens.push(`-is:${f}`);
  if (n.hard) tokens.push('is:hard');
  if (n.young) tokens.push('is:young');
  if (n.leech) tokens.push('is:leech');
  if (n.text && !say(n.text, { text: n.text })) keptText = n.text;

  const kept = sanitizeQuery({
    list: n.list,
    decks: keptDecks,
    sections: keptSections,
    fields: fieldRecord(keptFields),
    noteTypes: n.noteTypes,
    tags: keptTags,
    notTags: keptNotTags,
    text: keptText,
  });
  return { tokens, kept };
}

/**
 * A query back to search text. `list` and `noteTypes` have no syntax (they
 * are chips only) and are left out.
 *
 * Pass the `scope` (a SearchCtx) and the text is EXACT: every token in it
 * parses back to its own chip, and whatever text cannot say exactly is left
 * out (see splitForText). `chipOnlyPart` returns everything that is left out,
 * so a screen that shows the query as text keeps those as chips:
 *
 *   const kept = chipOnlyPart(q, scope);
 *   const text = formatSearch(q, ctx, scope);
 *   // … the user edits the text …
 *   mergeQueries(kept, parseSearch(text, scope).query)   // = q when the text is unchanged
 *
 * Without a scope `parseSearch(formatSearch(q))` gives `q` again only when
 * no deck name is the start of another deck's name (`deck:German` also finds
 * "German Verbs"), no section chip is narrower than its path, and every
 * field name is made of letters, digits, spaces, '_' and '-'.
 */
export function formatSearch(q: Query, ctx: { decks: ReadonlyMap<Id, Deck> }, scope?: FormatScope): string {
  return splitForText(q, ctx.decks, scope).tokens.join(' ');
}

/**
 * The chips that `formatSearch(q, ctx, scope)` leaves out because text cannot
 * say them exactly: always `list` and `noteTypes`; with a scope also every
 * Deck, Section, field, tag or text chip that its token would widen or turn
 * into another group. `{}` when the whole query fits in text.
 *
 *   chipOnlyPart({ decks: ['d-de'] }, scope)
 *     → { decks: ['d-de'] } when the scope has "German" AND "German Verbs"
 *       ('deck:German' would give back both)
 *   chipOnlyPart({ sections: [{ deckId: 'd-de', path: 'verbs' }] }, scope)
 *     → the same section, when another deck of the scope also has 'verbs'
 */
export function chipOnlyPart(q: Query, scope?: FormatScope): Query {
  return splitForText(q, NO_DECKS, scope).kept;
}

/* --------------------------------------------------------------- chips */

/** One chip per query group (spec §4.2). */
export type ChipId =
  | 'list'
  | 'decks'
  | 'sections'
  | `field:${string}`
  | 'noteTypes'
  | 'directions'
  | 'tags'
  | 'notTags'
  | 'life'
  | 'due'
  | 'flags'
  | 'notFlags'
  | 'hard'
  | 'young'
  | 'leech'
  | 'text';

export interface ChipModel {
  id: ChipId;
  /** "Level: B1, B2", "Deck: German", "Not started", "Due now", "Text: haus". */
  label: string;
  /** The FacetSheet group a tap on the chip opens (null: list and text have none). */
  facet: FacetKey | null;
}

/** A display path: 'Verbs::B1' → 'Verbs › B1'. */
function arrowPath(display: string): string {
  return display.split('::').join(' › ');
}

/** What chipsOf may know about the scope. A SearchCtx (buildSearchCtx) has it. */
export interface ChipScope {
  /**
   * The card types of the cards in the scope. The Direction chip label is
   * built from these, like the FacetSheet value ("Front → Back" in a Basic
   * deck, not every template name of the whole library).
   */
  typeIds?: ReadonlySet<Id>;
  /**
   * Direction ord → card type → decks, in the scope. When every chosen ord is
   * here, the Direction label is EXACTLY the FacetSheet value: the group's
   * names (directionLabels), deck languages included ("German → English" for
   * a Basic + reverse deck with its languages set; "Back → Front" when card
   * types with different template names share the direction).
   */
  directionSources?: DirectionSources;
}

/**
 * The chips of a query, in a fixed order, each with its label. Unknown ids
 * (a deleted deck) show the id rather than disappear, so the chip can still
 * be removed. Pass the `scope` (a SearchCtx) so the Direction label names only
 * the card types in scope; without it, every card type of the library is used
 * (and only the languages the card types name themselves).
 *
 * This is the ONE place that names a chip (walkthrough M8): the Library's chip
 * row, its "No cards match …" line and its session labels (libraryState
 * libraryChips), and the triage title all read these labels, so a filter has
 * the same name everywhere — and the
 * same name as its FacetSheet group (a field group uses fieldGroupLabel with
 * its card types).
 */
export function chipsOf(q: Query, ctx: MatchCtx, scope?: ChipScope): ChipModel[] {
  const n = sanitizeQuery(q);
  const { index, decks, lists } = ctx;
  const chips: ChipModel[] = [];
  const join = (labels: string[]) => labels.join(', ');

  if (n.list !== undefined) chips.push({ id: 'list', label: `List: ${lists.get(n.list)?.name ?? n.list}`, facet: null });
  if (n.decks) chips.push({ id: 'decks', label: `Deck: ${join(n.decks.map((id) => decks.get(id)?.name ?? id))}`, facet: 'deck' });
  if (n.sections) {
    const manyDecks = new Set(n.sections.map((s) => s.deckId)).size >= 2;
    const labels = n.sections.map((s) => {
      const path = arrowPath(index.sectionLabel(s.path));
      return manyDecks ? `${decks.get(s.deckId)?.name ?? s.deckId} › ${path}` : path;
    });
    chips.push({ id: 'sections', label: `Section: ${join(labels)}`, facet: 'section' });
  }
  for (const [key, values] of Object.entries(n.fields ?? {})) {
    // The SAME label as the FacetSheet group (facets.ts deriveFacets): with
    // its card types, so a label a card type chose wins ("Verb type"), a
    // clash names the card types ("Tags (German Verbs)") and a raw name is
    // made readable ("Word Type"). The chip is still found by its key.
    const spec = index.fieldSpecs.get(key);
    const label = fieldGroupLabel(spec?.label ?? key, spec ? { spec, typeById: index.typeById } : undefined);
    chips.push({
      id: `field:${key}`,
      label: `${label}: ${join(values.map((v) => index.valueLabel(key, v)))}`,
      facet: `field:${key}`,
    });
  }
  if (n.noteTypes) {
    const names = n.noteTypes.map((id) => index.typeById.get(id)?.name ?? id);
    chips.push({ id: 'noteTypes', label: `Card type: ${join(names)}`, facet: 'noteType' });
  }
  if (n.directions) {
    // The Direction GROUP's names (facets.ts directionLabels, walkthrough
    // M8) when the scope knows where every chosen direction comes from:
    // "Back → Front" when card types with different template names share
    // the direction — the same words as the FacetSheet value.
    const sources = scope?.directionSources;
    const group = sources && n.directions.every((ord) => sources.has(ord)) ? directionLabels(sources, index.typeById, decks) : null;
    const types = [...(scope?.typeIds ?? index.typeById.keys())];
    const labels = n.directions.map((ord) => {
      const named = group?.get(ord);
      if (named !== undefined) return named;
      const own = sources?.get(ord);
      return own
        ? directionLabel(ord, own.keys(), index.typeById, { decks, decksByType: own })
        : directionLabel(ord, types, index.typeById);
    });
    chips.push({ id: 'directions', label: `Direction: ${join(labels)}`, facet: 'direction' });
  }
  const tagText = (t: string) => arrowPath(index.tagLabel(t)).replace(/_/g, ' ');
  if (n.tags) chips.push({ id: 'tags', label: `Tag: ${join(n.tags.map(tagText))}`, facet: 'tag' });
  if (n.notTags) chips.push({ id: 'notTags', label: `Not tagged: ${join(n.notTags.map(tagText))}`, facet: 'tag' });
  if (n.life) chips.push({ id: 'life', label: join(n.life.map((k) => LIFE_LABELS[k])), facet: 'life' });
  if (n.due) chips.push({ id: 'due', label: DUE_LABELS[n.due], facet: 'due' });
  if (n.flags) chips.push({ id: 'flags', label: join(n.flags.map((f) => FLAG_LABELS[f])), facet: 'flags' });
  if (n.notFlags) {
    chips.push({ id: 'notFlags', label: `Not ${join(n.notFlags.map((f) => FLAG_LABELS[f].toLowerCase()))}`, facet: 'flags' });
  }
  if (n.hard) chips.push({ id: 'hard', label: 'Hard', facet: 'hard' });
  if (n.young) chips.push({ id: 'young', label: 'Recent', facet: 'young' });
  if (n.leech) chips.push({ id: 'leech', label: 'Leech', facet: 'leech' });
  if (n.text !== undefined) chips.push({ id: 'text', label: `Text: ${n.text}`, facet: null });
  return chips;
}

/** The query without the group of chip `chipId` (the chip's ×). */
export function removeChip(q: Query, chipId: ChipId | string): Query {
  const n: Query = { ...sanitizeQuery(q) };
  if (chipId.startsWith('field:')) {
    const key = chipId.slice('field:'.length);
    n.fields = fieldRecord(Object.entries(n.fields ?? {}).filter(([name]) => name !== key));
  } else {
    delete (n as Record<string, unknown>)[chipId];
  }
  return sanitizeQuery(n);
}
