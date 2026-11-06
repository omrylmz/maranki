/**
 * One query, one evaluator (spec §4.1).
 *
 * A `Query` (type in ./model.ts) is the ONE filter language of the app:
 * Library chips, saved Lists, every "Study N" number and every session use it.
 * It is FLAT and "chip-normal": an AND of groups, an OR inside a group, and
 * every group is one removable chip.
 *
 *   { decks: ['d1'], fields: { level: ['b1', 'b2'] }, life: ['new'] }
 *   = deck d1  AND  (Level B1 OR B2)  AND  status New
 *
 * `compileQuery(q, ctx)` turns a query into a fast test `(card) => boolean`.
 * It builds the closures ONCE (sets, folded words, the resolved list), so
 * testing 16,000 cards does no repeated work. The facet engine (facets.ts)
 * uses the same groups through `compileGroups`, so a count can never disagree
 * with the list it opens.
 *
 * Group semantics (a card matches when ALL present groups match):
 *   list        the card matches the saved list's query (one level only)
 *   decks       card.deckId is one of them
 *   sections    same deck, and the note's section is the path or below it ('::' boundary)
 *   fields      for every field: one of the note's values is chosen
 *   noteTypes   the note's card type is one of them
 *   directions  card.ord is one of them
 *   tags        a note tag is one of them or a child of one ('algo' ⊇ 'algo::core_patterns')
 *   notTags     no note tag matches any of them (same prefix rule)
 *   life        life(card) is one of them (§4.5)
 *   due         'now': isDueNow; 'today': the same, due before the end of the local day
 *   flags       EVERY flag holds (fav, flagged, suspended, buried, paused deck)
 *   notFlags    NO listed flag holds
 *   hard        reps > 0, ease ≤ 2.2, not Known
 *   young       reps > 0, interval ≤ 7 days, not Known
 *   leech       lapses ≥ 8
 *   text        every word (a "quoted phrase" is one word) is in the note's search text
 *
 * An EMPTY group (an empty array, '' text, `hard: false`) is the same as no
 * group: it never narrows the result. An UNKNOWN list id matches nothing (a
 * deleted list must never widen a session to the whole library).
 *
 * FIELD NAMES ARE USER DATA. They come from imported decks, so a field can be
 * called "Constructor" or "__proto__". On a normal object, `obj['constructor']`
 * is NOT undefined: it is the inherited `Object` function. So in this module
 * (and in searchParse.ts / facets.ts):
 *   - names and values are collected in a `Map`, never in `{}`;
 *   - every `Query.fields` object is made by `fieldRecord`: it has NO
 *     prototype (`Object.create(null)`), so any name is a plain key;
 *   - a value is read with `ownValue(record, key)`, never `record[key]`;
 *   - a record is never copied with `{ ...fields, [k]: v }`: babel-preset-expo
 *     compiles a spread to `Object.assign({}, …)`, and `Object.assign` runs
 *     the `__proto__` SETTER of the new `{}`, so a "__proto__" field is lost
 *     (it becomes the prototype). Copy with `new Map(Object.entries(fields))`
 *     and write back with `fieldRecord`.
 *
 * Pure: no React, no clock (the caller passes `now` in MatchCtx).
 */
import { isBuried, isDueNow, life, LIFE_KEYS } from './life';
import type { LibraryIndex } from './libraryIndex';
import { foldPath, foldTag } from './libraryIndex';
import type { Card, Deck, FlagKey, Id, LifeKey, ListDef, Query } from './model';
import { foldText } from './text';

/** Everything a query needs besides the card (spec §4.1). */
export interface MatchCtx {
  now: number;
  /** §4.4. */
  index: LibraryIndex;
  decks: ReadonlyMap<Id, Deck>;
  /** User lists + built-in lists (lists.ts `listsById`). */
  lists: ReadonlyMap<string, ListDef>;
}

/** Every flag, in the order the UI lists them. */
export const FLAG_KEYS: readonly FlagKey[] = Object.freeze(['fav', 'flagged', 'suspended', 'buried', 'paused']);

/** `hard`: ease at or below this (spec §3.4). */
export const HARD_EASE = 2.2;
/** `young`: interval at or below this many days. */
export const YOUNG_INTERVAL_DAYS = 7;
/** `leech`: at least this many lapses. */
export const LEECH_LAPSES = 8;

/* ------------------------------------------------------- user-data keys */

/**
 * The value of `record[key]` only when the record has its OWN property `key`;
 * else undefined. An inherited member ('constructor', 'toString', '__proto__')
 * never counts.
 *
 *   ownValue({ level: ['b1'] }, 'level')       → ['b1']
 *   ownValue({ level: ['b1'] }, 'constructor') → undefined   ({}['constructor'] would be Object)
 */
export function ownValue<T>(record: Readonly<Record<string, T>> | null | undefined, key: string): T | undefined {
  return record != null && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/**
 * A `Query.fields` object from (field name, values) pairs, for example a Map.
 * It has NO prototype, so every field name is a plain key: "constructor" or
 * "__proto__" can never reach Object.prototype, even when a later reader
 * forgets `ownValue`. Later pairs with the same name replace earlier ones.
 * JSON, `Object.keys` and `Object.entries` work on it as on any object. Do
 * not copy it with `{ ...spread }` (see the file header: '__proto__' is lost).
 *
 *   fieldRecord(new Map([['level', ['b1']]])) → { level: ['b1'] }
 */
export function fieldRecord(entries: Iterable<readonly [string, string[]]>): Record<string, string[]> {
  const out = Object.create(null) as Record<string, string[]>;
  // Assignment is safe here: an object without a prototype has no '__proto__' setter.
  for (const [key, values] of entries) out[key] = values;
  return out;
}

/* ------------------------------------------------------------ normalize */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Non-empty strings of `v` (an array), mapped by `f`, without duplicates and without ''. */
function stringList(v: unknown, f: (s: string) => string = (s) => s): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const s = f(item);
    if (s !== '' && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Folded and trimmed, white space collapsed. */
function foldWord(s: string): string {
  return foldText(s).replace(/\s+/g, ' ').trim();
}

/**
 * A clean Query from ANY value: unknown keys and wrong types are dropped,
 * text values are folded, duplicates removed, empty groups removed. Used on
 * route params and stored lists, so a damaged value never crashes a screen.
 *
 *   sanitizeQuery({ tags: ['B1', 'b1', 3], hard: false, x: 1 }) → { tags: ['b1'] }
 */
export function sanitizeQuery(raw: unknown): Query {
  if (!isObj(raw)) return {};
  const q: Query = {};

  if (typeof raw.list === 'string' && raw.list.trim() !== '') q.list = raw.list.trim();

  const decks = stringList(raw.decks);
  if (decks.length) q.decks = decks;

  if (Array.isArray(raw.sections)) {
    const sections: { deckId: Id; path: string }[] = [];
    for (const s of raw.sections) {
      if (!isObj(s) || typeof s.deckId !== 'string' || s.deckId === '' || typeof s.path !== 'string') continue;
      const path = foldPath(s.path);
      if (!sections.some((x) => x.deckId === s.deckId && x.path === path)) sections.push({ deckId: s.deckId, path });
    }
    if (sections.length) q.sections = sections;
  }

  if (isObj(raw.fields)) {
    // A Map, not {}: a field name is user data ('constructor', '__proto__').
    const fields = new Map<string, string[]>();
    for (const [name, values] of Object.entries(raw.fields)) {
      const key = foldWord(name);
      if (key === '') continue;
      const list = stringList(values, foldWord);
      if (list.length === 0) continue;
      const merged = fields.get(key) ?? [];
      for (const v of list) if (!merged.includes(v)) merged.push(v);
      fields.set(key, merged);
    }
    if (fields.size > 0) q.fields = fieldRecord(fields);
  }

  const noteTypes = stringList(raw.noteTypes);
  if (noteTypes.length) q.noteTypes = noteTypes;

  if (Array.isArray(raw.directions)) {
    const ords: number[] = [];
    for (const d of raw.directions) {
      if (typeof d === 'number' && Number.isInteger(d) && d >= 0 && !ords.includes(d)) ords.push(d);
    }
    if (ords.length) q.directions = ords;
  }

  // Tags are folded like the note tags they are compared with (libraryIndex `foldTag`).
  const tags = stringList(raw.tags, foldTag);
  if (tags.length) q.tags = tags;
  const notTags = stringList(raw.notTags, foldTag);
  if (notTags.length) q.notTags = notTags;

  const lifeKeys = stringList(raw.life).filter((k): k is LifeKey => (LIFE_KEYS as readonly string[]).includes(k));
  if (lifeKeys.length) q.life = lifeKeys;

  if (raw.due === 'now' || raw.due === 'today') q.due = raw.due;

  const isFlag = (k: string): k is FlagKey => (FLAG_KEYS as readonly string[]).includes(k);
  const flags = stringList(raw.flags).filter(isFlag);
  if (flags.length) q.flags = flags;
  const notFlags = stringList(raw.notFlags).filter(isFlag);
  if (notFlags.length) q.notFlags = notFlags;

  if (raw.hard === true) q.hard = true;
  if (raw.young === true) q.young = true;
  if (raw.leech === true) q.leech = true;

  if (typeof raw.text === 'string') {
    const text = foldWord(raw.text);
    if (text !== '') q.text = text;
  }
  return q;
}

/** The same query, cleaned (see sanitizeQuery). Idempotent. */
export function normalizeQuery(q: Query): Query {
  return sanitizeQuery(q);
}

/** True when the query has no group that narrows anything (`{}`, empty arrays, '' text …). */
export function isEmptyQuery(q: Query): boolean {
  return Object.keys(sanitizeQuery(q)).length === 0;
}

/** A stable text form for comparison: keys sorted, array items sorted. */
function canonical(q: Query): string {
  const n = sanitizeQuery(q) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(n).sort()) {
    const v = n[key];
    if (key === 'sections') {
      out[key] = (v as { deckId: Id; path: string }[]).map((s) => `${s.deckId}\u001f${s.path}`).sort();
    } else if (key === 'fields') {
      // (name, values) pairs, not an object: a field called '__proto__' must
      // stay a key of the text (on `{}` it would set the prototype instead).
      const fields = v as Record<string, string[]>;
      out[key] = Object.keys(fields)
        .sort()
        .map((k) => [k, [...fields[k]].sort()]);
    } else if (Array.isArray(v)) {
      out[key] = [...v].sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
    } else out[key] = v;
  }
  return JSON.stringify(out);
}

/**
 * True when two queries select the same cards BY CONSTRUCTION (same groups,
 * same values, any order). Library uses it for "Update list" (chips changed).
 */
export function sameQuery(a: Query, b: Query): boolean {
  return canonical(a) === canonical(b);
}

/**
 * The Library route param `q` (spec §2.2: a Query as JSON) → a clean Query.
 * Anything broken (not JSON, not an object, wrong types) gives `{}`, never a crash.
 * expo-router may pass an array for a repeated param: the first value is used.
 */
export function parseQueryParam(param: unknown): Query {
  const raw = Array.isArray(param) ? param[0] : param;
  if (typeof raw !== 'string' || raw.trim() === '') return isObj(raw) ? sanitizeQuery(raw) : {};
  try {
    return sanitizeQuery(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** A Query → the route param string (clean JSON). `parseQueryParam(serializeQuery(q))` equals `normalizeQuery(q)`. */
export function serializeQuery(q: Query): string {
  return JSON.stringify(sanitizeQuery(q));
}

/* ---------------------------------------------------------------- text */

/**
 * The search words of a text: folded; a "quoted phrase" is one word; a stray
 * quote mark is ignored; an unclosed quote runs to the end.
 *
 *   textWords('Haus "die  Stunde"') → ['haus', 'die stunde']
 */
export function textWords(text: string): string[] {
  const words: string[] = [];
  const re = /"([^"]*)("|$)|(\S+)/g;
  const folded = foldText(text ?? '');
  let m: RegExpExecArray | null;
  while ((m = re.exec(folded)) !== null) {
    const word = (m[1] ?? m[3].replace(/"/g, '')).replace(/\s+/g, ' ').trim();
    if (word !== '' && !words.includes(word)) words.push(word);
    if (m[0] === '') re.lastIndex += 1;
  }
  return words;
}

/* -------------------------------------------------------------- matching */

/** The end of the local calendar day of `now` (23:59:59.999), like dayKeyOf uses local time. */
export function endOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/** True when tag list `tags` (folded) has `prefix` or a child of it: 'algo' ⊇ 'algo::x'. */
function hasTagPrefix(tags: readonly string[], prefix: string): boolean {
  for (const t of tags) {
    if (t === prefix || (t.length > prefix.length && t.startsWith(prefix) && t.startsWith('::', prefix.length))) {
      return true;
    }
  }
  return false;
}

/** Does `flag` hold for the card? `paused` = its deck is paused. */
export function flagHolds(card: Card, flag: FlagKey, now: number, decks: ReadonlyMap<Id, Deck>): boolean {
  switch (flag) {
    case 'fav':
      return card.fav === true;
    case 'flagged':
      return card.flagged === true;
    case 'suspended':
      return card.suspended === true;
    case 'buried':
      return isBuried(card, now);
    case 'paused':
      return decks.get(card.deckId)?.active === false;
  }
}

/** `hard`: studied, low ease, not Known. */
export function isHard(card: Card): boolean {
  return card.reps > 0 && card.ease <= HARD_EASE && card.knownAt == null;
}

/** `young` ("Recent" in the UI): studied, short interval, not Known. */
export function isYoung(card: Card): boolean {
  return card.reps > 0 && card.intervalDays <= YOUNG_INTERVAL_DAYS && card.knownAt == null;
}

/** `leech`: forgotten many times. */
export function isLeech(card: Card): boolean {
  return card.lapses >= LEECH_LAPSES;
}

/** Due before the end of today: like isDueNow (studiable, not New/Known), with the later limit. */
export function isDueToday(card: Card, now: number, endOfDay: number = endOfLocalDay(now)): boolean {
  const key = life(card);
  if (key !== 'learning' && key !== 'review' && key !== 'mastered') return false;
  return card.due <= endOfDay && !card.suspended && !isBuried(card, now);
}

/** The id of one group of a query. Flags get one group EACH, because `flags` is an AND. */
export type GroupId =
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
  | `flag:${FlagKey}`
  | `notFlag:${FlagKey}`
  | 'hard'
  | 'young'
  | 'leech'
  | 'text';

/** One compiled group: its id and its test. */
export interface QueryGroup {
  id: GroupId;
  test: (card: Card) => boolean;
}

/**
 * Compile every present group of `q` into a test. The order is fixed (cheap
 * card-only tests first, text last), so `compileQuery` fails fast.
 *
 * The facet engine counts with these groups ("disjunctive" counts, §4.3), so
 * each AND part is its own group: every flag in `flags` and every key in
 * `fields` is a separate group.
 */
export function compileGroups(q: Query, ctx: MatchCtx): QueryGroup[] {
  const n = sanitizeQuery(q);
  const { index, now, decks } = ctx;
  const groups: QueryGroup[] = [];
  const noteOf = (card: Card) => index.noteById.get(card.noteId);

  if (n.decks) {
    const set = new Set(n.decks);
    groups.push({ id: 'decks', test: (c) => set.has(c.deckId) });
  }
  if (n.directions) {
    const set = new Set(n.directions);
    groups.push({ id: 'directions', test: (c) => set.has(c.ord) });
  }
  if (n.life) {
    const set = new Set<LifeKey>(n.life);
    groups.push({ id: 'life', test: (c) => set.has(life(c)) });
  }
  if (n.due === 'now') groups.push({ id: 'due', test: (c) => isDueNow(c, now) });
  if (n.due === 'today') {
    const end = endOfLocalDay(now);
    groups.push({ id: 'due', test: (c) => isDueToday(c, now, end) });
  }
  for (const flag of n.flags ?? []) {
    groups.push({ id: `flag:${flag}`, test: (c) => flagHolds(c, flag, now, decks) });
  }
  for (const flag of n.notFlags ?? []) {
    groups.push({ id: `notFlag:${flag}`, test: (c) => !flagHolds(c, flag, now, decks) });
  }
  if (n.hard) groups.push({ id: 'hard', test: isHard });
  if (n.young) groups.push({ id: 'young', test: isYoung });
  if (n.leech) groups.push({ id: 'leech', test: isLeech });

  if (n.noteTypes) {
    const set = new Set(n.noteTypes);
    groups.push({
      id: 'noteTypes',
      test: (c) => {
        const note = noteOf(c);
        return note !== undefined && set.has(note.typeId);
      },
    });
  }
  if (n.sections) {
    // deckId → folded paths.
    const byDeck = new Map<Id, string[]>();
    for (const s of n.sections) {
      const list = byDeck.get(s.deckId) ?? [];
      list.push(s.path);
      byDeck.set(s.deckId, list);
    }
    groups.push({
      id: 'sections',
      test: (c) => {
        const paths = byDeck.get(c.deckId);
        if (!paths) return false;
        const note = noteOf(c);
        if (!note) return false;
        const section = index.sectionPath(note);
        for (const p of paths) {
          if (section === p) return true;
          if (p !== '' && section.length > p.length && section.startsWith(p) && section.startsWith('::', p.length)) {
            return true;
          }
        }
        return false;
      },
    });
  }
  for (const [key, values] of Object.entries(n.fields ?? {})) {
    const set = new Set(values);
    groups.push({
      id: `field:${key}`,
      test: (c) => {
        const note = noteOf(c);
        if (!note) return false;
        const have = index.facetValues(note).get(key);
        if (!have) return false;
        for (const v of have) if (set.has(v)) return true;
        return false;
      },
    });
  }
  if (n.tags) {
    const wanted = n.tags;
    groups.push({
      id: 'tags',
      test: (c) => {
        const note = noteOf(c);
        if (!note) return false;
        const tags = index.noteTags(note);
        return wanted.some((p) => hasTagPrefix(tags, p));
      },
    });
  }
  if (n.notTags) {
    const unwanted = n.notTags;
    groups.push({
      id: 'notTags',
      test: (c) => {
        const note = noteOf(c);
        // A card without a note has no tags, so it holds none of them.
        if (!note) return true;
        const tags = index.noteTags(note);
        return !unwanted.some((p) => hasTagPrefix(tags, p));
      },
    });
  }
  if (n.list !== undefined) {
    const def = ctx.lists.get(n.list);
    if (!def) groups.push({ id: 'list', test: () => false });
    else {
      // One level only: a list's own `list` key is ignored (saveList strips it).
      const inner = compileQuery({ ...def.query, list: undefined }, ctx);
      groups.push({ id: 'list', test: inner });
    }
  }
  if (n.text !== undefined) {
    const words = textWords(n.text);
    if (words.length > 0) {
      groups.push({
        id: 'text',
        test: (c) => {
          const note = noteOf(c);
          if (!note) return false;
          const hay = index.searchText(note);
          for (const w of words) if (!hay.includes(w)) return false;
          return true;
        },
      });
    }
  }
  return groups;
}

/**
 * Compile a query into one fast test. The closures are built once; call the
 * returned function for every card.
 *
 *   const match = compileQuery({ fields: { level: ['b1'] } }, ctx);
 *   const b1Cards = cards.filter(match);
 */
export function compileQuery(q: Query, ctx: MatchCtx): (card: Card) => boolean {
  const groups = compileGroups(q, ctx);
  if (groups.length === 0) return () => true;
  if (groups.length === 1) return groups[0].test;
  return (card) => {
    for (const g of groups) if (!g.test(card)) return false;
    return true;
  };
}

/**
 * The decks a query NAMES — in `decks`, in `sections`, or inside its list
 * (one level). A paused deck named here can still be studied (§4.5
 * eligibility: "an explicit deck bypasses pause").
 */
export function explicitDecks(q: Query, ctx: MatchCtx): Set<Id> {
  const out = new Set<Id>();
  const add = (query: Query) => {
    const n = sanitizeQuery(query);
    for (const id of n.decks ?? []) out.add(id);
    for (const s of n.sections ?? []) out.add(s.deckId);
  };
  add(q);
  if (typeof q.list === 'string') {
    const def = ctx.lists.get(q.list.trim());
    if (def) add({ ...def.query, list: undefined });
  }
  return out;
}
