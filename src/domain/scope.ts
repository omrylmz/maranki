/**
 * One scope for every count and every queue (spec §4.5 "scope.ts", unit W3-4).
 *
 * A SCOPE is a Query (§4.1): "All" is `{}`, a deck is `{ decks: [id] }`, a
 * list is `{ list: id }`, the Library is its chips. This file is the ONLY
 * place that turns a scope into cards, a count or a session queue:
 *
 *   scopePool(state, q, ctx, 'browse')   every card that matches q (paused decks too)
 *   scopePool(state, q, ctx, 'study')    … and that Study may show (studyEligible)
 *   readyFor(state, q, ctx)              the numbers on the "Study N" button of q
 *   dueAndReadyFor(state, q, ctx)        … and the "{n} due" of q, from the same run
 *   isLaunchable(ready)                is that button live? (the session has ≥ 1 card)
 *   buildSessionQueue(params, state, ctx) the cards of the session that button opens
 *
 * (W5-3: the old queue.ts facade is deleted. Its last useful function,
 * isLaunchable, lives here now.)
 *
 * WHY one file: the number on a Study button must be EXACTLY the length of
 * the session it opens. Both go through the same two steps here — the same
 * pool (scopePool 'study') and the same scheduler (selectScheduled) — so
 *
 *   readyFor(state, q, ctx).total === buildSessionQueue({ kind: 'scheduled', q }, state, ctx).length
 *
 * holds BY CONSTRUCTION (scope.test.ts checks it on random states and queries).
 *
 * Browse vs study (the "favorite in a paused deck" case of report 1):
 *   - browse: every matching card. A card of a paused deck is listed (the
 *     Library shows it with a "paused" dot).
 *   - study: a paused deck's cards are left out, UNLESS the scope names that
 *     deck (`explicitDecks`: the deck page, a deck chip, a section, a list
 *     with a deck). So "Favorites" lists 2 cards but studies 1, and the
 *     Markers filter group says "In a paused deck (1)".
 *
 * Also here: the cached lookups every scope needs (the library index, card
 * lookup, decks and lists by id), `matchCtxOf` (the MatchCtx of a state),
 * `sortScopeCards` (the ONE sort of the Library and of Practice, with
 * `warmLibraryOrder`, its idle step) and `deckStatsMap` (every deck row in
 * ONE pass over the cards).
 *
 * Unit P4: the Level, Section and Card type groups of a scope are answered
 * from note lookups made once per library index (`warmNoteSets`; one Set
 * lookup per card, exactly the query test's result), `browsePool` gives the
 * Library's "no filter" list the store's own cards array, Deck order of a
 * library stored in that order is the pool itself in the Library
 * (`sortScopeRows`; `sortScopeCards` gives a copy), and `warmLibraryOrderOf` lets the
 * shared warm-up make the Deck order ahead of time.
 *
 * Unit P4 review: a filter makes only the lookup PART it needs (a Level
 * chip: the Level part), `sortScopeRows` gives the Library's list with no
 * copy at all when it already is in order, and `warmDeckOrder` makes the
 * warm-up's Deck order a part at a time (schedule.ts sourceOrderJob).
 *
 * Unit U2: a field sort (Level) computes the rank of each VALUE once per
 * library index (rankCache), not once per card, so the first Level sort of
 * a whole library has room under the 30 ms 'filter' budget (see
 * sortKeyFor). The keys are the same.
 *
 * Pure: no React, no clock (the caller passes `now` in the MatchCtx).
 */
import { faceHeadline, faceSortKeyOf } from './face';
import { facetNoteWarmer } from './facets';
import {
  buildCardLookup,
  buildLibraryIndex,
  type CardLookup,
  type LibraryIndex,
  warmNoteLabels,
} from './libraryIndex';
import { LIFE_KEYS, life } from './life';
import { listsById } from './lists';
import type {
  Card,
  DataStateV3,
  Deck,
  Id,
  LifeKey,
  ListDef,
  Note,
  NoteType,
  Query,
  ReadyCounts,
  ScheduleCtx,
  SortSpec,
} from './model';
import { detectOrdinal, type Ordinal } from './ordinal';
import { compileQuery, explicitDecks, type MatchCtx, ownValue, sanitizeQuery } from './query';
import {
  NO_SORT_KEY,
  orderCards,
  orderPositions,
  planQueue,
  readyCounts,
  repairPositions,
  selectAhead,
  selectPractice,
  selectScheduled,
  selectScheduledWithDue,
  sortCards,
  type SortCtx,
  sortFieldsOf,
  sortIsStrict,
  type SourceOrderStep,
  sourceOrderJob,
  studyEligible,
} from './schedule';

/** The parts of the app state a scope reads. A whole DataStateV3 fits. */
export type ScopeState = Pick<
  DataStateV3,
  'cards' | 'notes' | 'noteTypes' | 'decks' | 'lists' | 'person' | 'settings'
>;

/** What a pool is for: 'browse' = every matching card; 'study' = only cards Study may show. */
export type ScopePurpose = 'browse' | 'study';

/**
 * What a session is made of (spec §6.1). The session screen builds its queue
 * ONCE, in its useState initializer, with buildSessionQueue(params, …).
 *
 *   { kind: 'scheduled', q }   Study: learning, due reviews, checks, new (changes the schedule)
 *   { kind: 'ahead', q }       Study ahead: reviews that are not due yet, soonest first
 *   { kind: 'practice', q }    Practice: the scope's cards, `sort` order (never changes the schedule)
 *   { kind: 'practice', sel }  Practice these cards (a selection, e.g. "the {n} you missed"), in this order
 */
export type SessionParams =
  | { kind: 'scheduled'; q: Query }
  | { kind: 'ahead'; q: Query }
  | { kind: 'practice'; q: Query; sort?: SortSpec | null }
  | { kind: 'practice'; sel: readonly Id[]; sort?: SortSpec | null };

/* ------------------------------------------------------------------ cached lookups */

/*
 * The store never changes an array in place: a change makes a new array. So
 * a lookup built from an array stays right as long as the SAME array object
 * is passed, and these caches (WeakMaps keyed by the array) can hand it out
 * again for free. A rating changes only `cards`, so the library index (notes
 * and card types) is NOT built again after a rating (spec §4.4).
 */

/** Stand-ins for a missing array in damaged data, so a WeakMap key is always an object. */
const NO_NOTES: readonly Note[] = Object.freeze([]);
const NO_TYPES: readonly NoteType[] = Object.freeze([]);
const NO_CARDS: readonly Card[] = Object.freeze([]);
const NO_DECKS: readonly Deck[] = Object.freeze([]);
const NO_LISTS: readonly ListDef[] = Object.freeze([]);

const indexCache = new WeakMap<readonly Note[], WeakMap<readonly NoteType[], LibraryIndex>>();
const lookupCache = new WeakMap<readonly Card[], CardLookup>();
const decksCache = new WeakMap<readonly Deck[], ReadonlyMap<Id, Deck>>();
const listsCache = new WeakMap<readonly ListDef[], ReadonlyMap<string, ListDef>>();

/**
 * The library index (spec §4.4) of these notes and card types. The same two
 * arrays always give the same index object.
 */
export function libraryIndexOf(state: Pick<ScopeState, 'notes' | 'noteTypes'>): LibraryIndex {
  const notes = state.notes ?? NO_NOTES;
  const types = state.noteTypes ?? NO_TYPES;
  let byTypes = indexCache.get(notes);
  if (!byTypes) {
    byTypes = new WeakMap();
    indexCache.set(notes, byTypes);
  }
  let index = byTypes.get(types);
  if (!index) {
    index = buildLibraryIndex(notes, types);
    byTypes.set(types, index);
  }
  return index;
}

/** Card by id and card ids by note (§4.4). The same cards array always gives the same object. */
export function cardLookupOf(cards: readonly Card[]): CardLookup {
  const key = cards ?? NO_CARDS;
  let lookup = lookupCache.get(key);
  if (!lookup) {
    lookup = buildCardLookup(key);
    lookupCache.set(key, lookup);
  }
  return lookup;
}

/** Every deck by id. The same decks array always gives the same Map. */
export function decksById(decks: readonly Deck[]): ReadonlyMap<Id, Deck> {
  const key = decks ?? NO_DECKS;
  let map = decksCache.get(key);
  if (!map) {
    map = new Map(key.map((d) => [d.id, d]));
    decksCache.set(key, map);
  }
  return map;
}

/** The built-in lists + the user's lists by id (lists.ts listsById). The same array gives the same Map. */
export function listsOf(lists: readonly ListDef[]): ReadonlyMap<string, ListDef> {
  const key = lists ?? NO_LISTS;
  let map = listsCache.get(key);
  if (!map) {
    map = listsById(key);
    listsCache.set(key, map);
  }
  return map;
}

/**
 * The MatchCtx (§4.1) of a state at the moment `now`. Its parts are the
 * cached lookups above, so making one is cheap.
 */
export function matchCtxOf(state: Pick<ScopeState, 'notes' | 'noteTypes' | 'decks' | 'lists'>, now: number): MatchCtx {
  return {
    now,
    index: libraryIndexOf(state),
    decks: decksById(state.decks),
    lists: listsOf(state.lists),
  };
}

/* ------------------------------------------------------------------ sort keys */

/** Per index: folded field name → the ordinal kind of its values (or null). */
const ordinalCache = new WeakMap<LibraryIndex, Map<string, Ordinal | null>>();

/** The ordinal kind (CEFR, JLPT, numbers …) of every value of one field group, or null. */
function fieldOrdinal(index: LibraryIndex, key: string): Ordinal | null {
  let byKey = ordinalCache.get(index);
  if (!byKey) {
    byKey = new Map();
    ordinalCache.set(index, byKey);
  }
  if (byKey.has(key)) return byKey.get(key) ?? null;
  const labels = new Set<string>();
  for (const note of index.noteById.values()) {
    for (const value of index.facetValues(note).get(key) ?? []) labels.add(index.valueLabel(key, value));
  }
  const ordinal = detectOrdinal([...labels]);
  byKey.set(key, ordinal);
  return ordinal;
}

/**
 * Per index: folded field name → folded value → the value's ordinal rank,
 * `fieldOrdinal(index, key).rank(index.valueLabel(key, value))` (unit U2).
 *
 * This number depends ONLY on the index, the field and the value, so it can
 * be kept for as long as the index lives:
 *   - an index object never changes (a note edit makes a new index);
 *   - valueLabel finishes its label pass before it answers
 *     (libraryIndex.ts), so it gives the same label for the same value every
 *     time, also while the warm-up is still making the labels;
 *   - fieldOrdinal is kept per index too (ordinalCache above), and rank() is
 *     pure (ordinal.ts: one regular expression, no state).
 * sortKeyFor fills it, one value at a time, the first time it needs a value.
 */
const rankCache = new WeakMap<LibraryIndex, Map<string, Map<string, number>>>();

/** The kept ranks of one field group of `index` (see rankCache). Empty at first. */
function fieldRanks(index: LibraryIndex, key: string): Map<string, number> {
  let byKey = rankCache.get(index);
  if (!byKey) {
    byKey = new Map();
    rankCache.set(index, byKey);
  }
  let ranks = byKey.get(key);
  if (!ranks) {
    ranks = new Map();
    byKey.set(key, ranks);
  }
  return ranks;
}

/**
 * The text sort keys of a library, for SortSpec 'az' and 'field' (the
 * scheduler's `ScheduleCtx.sortKey`, used by selectPractice):
 *   'az'    the question headline, A–Z by the word (spec §9.2: a German term
 *           sorts by the word, not by its article: "die Abfahrt" under A);
 *   'field' the card's value of one filter group (`sort.field`, a folded
 *           field name): its ordinal rank when the group is ordinal (A1 < A2 < B1),
 *           else the value text. A card without a value gets NO_SORT_KEY:
 *           it comes last, in both directions (schedule.ts sortCards).
 *
 * FAST FOR A WHOLE LIBRARY (unit U2). The release device printed
 * "[perf] filter 32.3 ms" for the first Level sort of 16,264 cards (budget
 * 30 ms). In node --jitless (about the speed of the device for this code)
 * the key loop took 21–25 ms, but only 5.8 ms of it was the walk over the
 * notes and their values. The rest was one rank per card — a label lookup
 * and a regular expression, 16,032 times for only 6 different values — and
 * one fieldOrdinal lookup per card. Now:
 *   - the field's ordinal kind and its kept ranks are looked up only when
 *     `sort.field` changes (lastKey), not once per card. A sort asks for the
 *     key of every card with the same field. A new function is made for
 *     every scheduleCtxOf / sortCtxOf call, so each one starts empty;
 *   - the rank of a value is computed once per index (rankCache), the first
 *     time a card has it, with the same formula as before.
 * The whole first Level sort of the device's data in node --jitless (the
 * Library's 'filter' work after the warm-up): 29.5–36.7 ms before, 17.9–22.6
 * ms now. Every key is EXACTLY the number it was before (fieldSortRank.test.ts).
 */
function sortKeyFor(index: LibraryIndex, decks: ReadonlyMap<Id, Deck>): NonNullable<ScheduleCtx['sortKey']> {
  // The field of the last 'field' key, its ordinal kind (or null) and its kept ranks.
  let lastKey: string | null = null;
  let lastOrdinal: Ordinal | null = null;
  let lastRanks: Map<string, number> = new Map();
  return (card, sort) => {
    if (sort.by === 'field') {
      const key = sort.field ?? '';
      if (key !== lastKey) {
        lastKey = key;
        lastOrdinal = fieldOrdinal(index, key);
        lastRanks = fieldRanks(index, key);
      }
      const note = index.noteById.get(card.noteId);
      const values = note ? index.facetValues(note).get(key) : undefined;
      const ordinal = lastOrdinal;
      if (ordinal) {
        const ranks = lastRanks;
        let best = NO_SORT_KEY;
        if (values) {
          // An index loop, not for…of: a for…of makes an iterator for every card.
          for (let k = 0; k < values.length; k++) {
            const v = values[k];
            let rank = ranks.get(v);
            if (rank === undefined) {
              rank = ordinal.rank(index.valueLabel(key, v));
              ranks.set(v, rank);
            }
            best = Math.min(best, rank);
          }
        }
        // A rank that is not a number (a broken ordinal) counts as "no value".
        return Number.isFinite(best) ? best : NO_SORT_KEY;
      }
      return values && values.length > 0 ? values[0] : NO_SORT_KEY;
    }
    // The ONE A–Z key (face.ts faceSortKey): the headline's text (for a
    // dictation card: the word it reads aloud, not the speaker); only a
    // 'term' field uses the language rules of §9.2 ("das Anliegen" under A).
    // faceSortKeyOf gives exactly that value without building the whole
    // face, cached per note (unit P1).
    return faceSortKeyOf(card, index, decks);
  };
}

/* ------------------------------------------------------------------ the scheduler's ctx */

/**
 * The `life` and `flags` groups of a practice query, with the groups of its
 * list too (so practising the "Suspended" list keeps its suspended cards).
 * selectPractice reads only these (ScheduleCtx.scope, §6.6).
 */
function practiceScope(q: Query, ctx: MatchCtx): Pick<Query, 'life' | 'flags'> {
  const n = sanitizeQuery(q);
  const lifeKeys = [...(n.life ?? [])];
  const flags = [...(n.flags ?? [])];
  const def = n.list !== undefined ? ctx.lists.get(n.list) : undefined;
  if (def) {
    const inner = sanitizeQuery(def.query);
    for (const k of inner.life ?? []) if (!lifeKeys.includes(k)) lifeKeys.push(k);
    for (const f of inner.flags ?? []) if (!flags.includes(f)) flags.push(f);
  }
  return { life: lifeKeys, flags };
}

/**
 * The ScheduleCtx (model.ts) of a state: decks, today's tallies, the
 * settings, the sibling lookup over ALL cards, the card type of a card
 * (for the deck's directions) and the A–Z / field sort keys.
 * `practiceQuery`: only for a practice session over a query (§6.6).
 *
 * The person's dayDone is passed as it is: the scheduler reads a dayDone of
 * another day as "nothing done yet today" (the day roll-over).
 */
export function scheduleCtxOf(state: ScopeState, ctx: MatchCtx, practiceQuery?: Query): ScheduleCtx {
  const { index } = ctx;
  const sctx: ScheduleCtx = {
    now: ctx.now,
    decks: ctx.decks,
    typeIdOf: (card) => index.noteById.get(card.noteId)?.typeId,
    done: state.person.dayDone,
    settings: state.settings,
    lookup: cardLookupOf(state.cards),
    sortKey: sortKeyFor(index, ctx.decks),
  };
  if (practiceQuery) sctx.scope = practiceScope(practiceQuery, ctx);
  return sctx;
}

/* ------------------------------------------------------------------ pools, counts, queues */

/**
 * The cards of a scope, in state order (spec §4.5):
 *   'browse' → every card that matches `q` (paused decks included);
 *   'study'  → every card that matches `q` AND `studyEligible`: its deck
 *              exists and is active OR named by `q` (explicitDecks), its
 *              direction is on, it is not suspended and not buried.
 */
export function scopePool(state: ScopeState, q: Query, ctx: MatchCtx, purpose: ScopePurpose): Card[] {
  const cards = state.cards ?? NO_CARDS;
  const match = compileScopeQuery(q, ctx);
  if (purpose === 'browse') return cards.filter((card) => match(card));
  const sctx = scheduleCtxOf(state, ctx);
  const named = explicitDecks(q, ctx);
  return cards.filter((card) => match(card) && studyEligible(card, sctx, named));
}

/**
 * The cards of `scopePool(state, q, ctx, 'browse')` for a list that is only
 * READ (the Library's rows, unit P4): the same cards in the same order. When
 * `q` has no group at all (the Library with no filter), it is the state's
 * own cards array — no copy of 16,000 cards on every opening. The caller
 * must never change the array (the store never does either).
 *
 *   browsePool(state, {}, ctx) === state.cards                       // true
 *   browsePool(state, { decks: ['d1'] }, ctx)                        // = scopePool(…, 'browse')
 */
export function browsePool(state: ScopeState, q: Query, ctx: MatchCtx): readonly Card[] {
  if (Object.keys(sanitizeQuery(q)).length === 0) return state.cards ?? NO_CARDS;
  return scopePool(state, q, ctx, 'browse');
}

/* ------------------------------------------------------------------ the note groups, fast (unit P4) */

/*
 * WHY (the release device, 16,260 cards): a list with a Level chip took
 * 36–54 ms (budget 30), with a Section or Card type chip too, while a Deck
 * or status chip took about 4 ms. The other sorts looked faster only
 * because they re-sorted the pool that "Deck order" had already filtered
 * (the Library keeps the pool per query): "Deck order" is the default sort,
 * so its line was always the FIRST list of a new filter. The time was in
 * the filter, not in the sort: in node --jitless the Level filter of the
 * device's library takes 6.6 ms and the Deck order cut 1.0 ms.
 *
 * A Level, Section or Card type chip tests the card's NOTE. For every card
 * the query test (query.ts compileGroups) finds the note by its id, then
 * its field values or section (caches per note object), then compares —
 * on Hermes about 9 times the cost of a Deck chip, which compares a value
 * of the card itself. So these three groups are answered here from lookups
 * made ONCE per library index (a rating does not change the index): for
 * each field value, card type and section path, the ids of its notes. A
 * card is then tested with one Set lookup of its note id, like a Deck chip.
 *
 * EXACTLY the same result as the query test, because the lookups are made
 * from the index's own `noteById` (the note a card's `noteId` finds) and its
 * own values: "the card's note has value v" ⟺ "the note's id is in the set
 * of v". scope.test.ts checks it on random libraries and queries.
 */

/*
 * ONLY THE PART A FILTER NEEDS (unit P4 review): when the index is new —
 * after any note edit, or before the warm-up has run — the first list with
 * a Level chip made ALL the lookups (every field group, the card types and
 * the sections of 8,737 notes) inside the Library's timed 'filter' line:
 * 8.2 → 15.5 ms in node --jitless for the first "Level B1" after an edit.
 * Now each lookup is a PART of its own: a Level chip makes only the Level
 * part (one pass over the notes that reads one field group), a Card type
 * chip only the card types, a Section chip only the sections. The warm-up's
 * pass (warmNoteSets) still makes every part, a slice at a time. Study n
 * and Practice n of the same render reuse the part the list made.
 *
 * The parts and the warm-up's pass fill the SAME sets, with the same note
 * ids: a Set keeps an id once, so a part made first and then walked again
 * by the pass (or the other way round) holds exactly the same ids.
 */

/** The note lookups of one library index. */
interface NoteSets {
  /** Folded field key → folded value → the ids of the notes that have it (index.facetValues). */
  fields: Map<string, Map<string, Set<Id>>>;
  /** Card type id → the ids of its notes. */
  types: Map<Id, Set<Id>>;
  /** A note's folded section path (index.sectionPath) → the ids of the notes in exactly that section. */
  paths: Map<string, Set<Id>>;
  /** A section of a query (its folded path) → the notes in it or below it. Made from a complete `paths` on first use. */
  sections: Map<string, ReadonlySet<Id>>;
  /** The warm-up's pass over `index.noteById` that fills ALL the lookups above; null when it is done. */
  pass: Iterator<[Id, Note]> | null;
  /**
   * The parts that are complete although the pass is not done yet (a filter
   * needed them first): TYPES_PART, PATHS_PART, or fieldPart(key).
   */
  parts: Set<string>;
}

const noteSetsCache = new WeakMap<LibraryIndex, NoteSets>();

/** warmNoteSets asks `stop()` after this many notes (like the 64 cards of warmLibraryCaches). */
const NOTES_PER_STOP = 64;

/** The names of the parts in NoteSets.parts. A field key is user data: its part name has a prefix, so it never meets the other two. */
const TYPES_PART = 'types';
const PATHS_PART = 'paths';
const fieldPart = (key: string): string => `field:${key}`;

function noteSetsOf(index: LibraryIndex): NoteSets {
  let sets = noteSetsCache.get(index);
  if (!sets) {
    // The index is never changed after it is made, so its Map can be walked a part at a time.
    sets = {
      fields: new Map(),
      types: new Map(),
      paths: new Map(),
      sections: new Map(),
      pass: index.noteById.entries(),
      parts: new Set(),
    };
    noteSetsCache.set(index, sets);
  }
  return sets;
}

/** Add `id` to the set of `key` in `map` (made when missing). */
function addTo<K>(map: Map<K, Set<Id>>, key: K, id: Id): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(id);
}

/** One note of the pass: its field values, its card type and its section. */
function visitNote(sets: NoteSets, index: LibraryIndex, id: Id, note: Note): void {
  for (const [key, values] of index.facetValues(note)) {
    let byValue = sets.fields.get(key);
    if (!byValue) {
      byValue = new Map();
      sets.fields.set(key, byValue);
    }
    for (const value of values) addTo(byValue, value, id);
  }
  addTo(sets.types, note.typeId, id);
  addTo(sets.paths, index.sectionPath(note), id);
}

/**
 * Make the note lookups of `index` (see above) a part at a time, so the
 * first Level, Section or Card type chip finds them ready. `stop()` is
 * asked after every 64 notes; when it says yes, this returns false and the
 * next call goes on from there. True when the lookups are complete (at
 * once, when they already were). The Library's shared warm-up calls it
 * while the phone is idle (store/libraryWarmup.ts); a filter that needs
 * a lookup before that makes only ITS part, in one pass (noteSetsWith).
 *
 *   while (!warmNoteSets(index, () => clock() - start > 8)) …   // again later
 */
export function warmNoteSets(index: LibraryIndex, stop: () => boolean): boolean {
  const sets = noteSetsOf(index);
  const pass = sets.pass;
  if (pass === null) return true;
  for (let n = 1; ; n++) {
    const step = pass.next();
    if (step.done) {
      sets.pass = null;
      return true;
    }
    visitNote(sets, index, step.value[0], step.value[1]);
    if (n % NOTES_PER_STOP === 0 && stop()) return false;
  }
}

/** True when ALL the note lookups of `index` are complete (warmNoteSets has nothing left to do; a filter's part alone is not enough). */
export function noteSetsReady(index: LibraryIndex): boolean {
  return noteSetsCache.get(index)?.pass === null;
}

/**
 * The note lookups of `index` with the part `part` complete: at once when
 * the warm-up's pass is done or the part was made before; else ONE pass
 * over the notes runs `visit` for each of them (only what this part reads).
 */
function noteSetsWith(index: LibraryIndex, part: string, visit: (sets: NoteSets, id: Id, note: Note) => void): NoteSets {
  const sets = noteSetsOf(index);
  if (sets.pass === null || sets.parts.has(part)) return sets;
  for (const [id, note] of index.noteById) visit(sets, id, note);
  sets.parts.add(part);
  return sets;
}

/** The card type part: card type id → the ids of its notes. */
function typeSets(index: LibraryIndex): ReadonlyMap<Id, ReadonlySet<Id>> {
  return noteSetsWith(index, TYPES_PART, (sets, id, note) => addTo(sets.types, note.typeId, id)).types;
}

/** The section part (see sectionNotes for a query's path). */
function pathSets(index: LibraryIndex): NoteSets {
  return noteSetsWith(index, PATHS_PART, (sets, id, note) => addTo(sets.paths, index.sectionPath(note), id));
}

/**
 * The part of ONE field group (`key`, a folded field name such as 'level'):
 * folded value → the ids of the notes that have it. Undefined when no note
 * has a value in that group (then a chip of it matches nothing).
 */
function fieldSets(index: LibraryIndex, key: string): ReadonlyMap<string, ReadonlySet<Id>> | undefined {
  const sets = noteSetsWith(index, fieldPart(key), (all, id, note) => {
    const values = index.facetValues(note).get(key);
    if (!values) return;
    let byValue = all.fields.get(key);
    if (!byValue) {
      byValue = new Map();
      all.fields.set(key, byValue);
    }
    for (const value of values) addTo(byValue, value, id);
  });
  return sets.fields.get(key);
}

/**
 * The notes in the section `path` (a query's folded path) or below it: the
 * query test's rule (query.ts compileGroups 'sections'), applied once to
 * each distinct section path of the library instead of once per card.
 */
function sectionNotes(sets: NoteSets, path: string): ReadonlySet<Id> {
  const hit = sets.sections.get(path);
  if (hit) return hit;
  const parts: Set<Id>[] = [];
  for (const [section, ids] of sets.paths) {
    const inside =
      section === path ||
      (path !== '' && section.length > path.length && section.startsWith(path) && section.startsWith('::', path.length));
    if (inside) parts.push(ids);
  }
  let out: ReadonlySet<Id>;
  if (parts.length === 1) out = parts[0];
  else {
    const union = new Set<Id>();
    for (const ids of parts) for (const id of ids) union.add(id);
    out = union;
  }
  sets.sections.set(path, out);
  return out;
}

/** A card test: true when the card's note id is in one of `sets` (none: always false). */
function noteIn(sets: readonly (ReadonlySet<Id> | undefined)[]): (card: Card) => boolean {
  const list = sets.filter((set): set is ReadonlySet<Id> => set !== undefined && set.size > 0);
  if (list.length === 0) return () => false;
  if (list.length === 1) {
    const only = list[0];
    return (card) => only.has(card.noteId);
  }
  // An index loop: this runs for every card, and Hermes has no JIT for `for…of`.
  return (card) => {
    for (let k = 0; k < list.length; k++) if (list[k].has(card.noteId)) return true;
    return false;
  };
}

/**
 * The test of `q` for scopePool: query.ts compileQuery, but the Card type,
 * Section and field groups (Level …) are answered from the note lookups
 * (one Set lookup per card). Only the parts this query needs are made (see
 * above). Every other group — and a list's own query — is compileQuery's.
 * The groups are ANDed, so the order does not change the result; the Set
 * tests come first (they are the cheapest).
 */
function compileScopeQuery(q: Query, ctx: MatchCtx): (card: Card) => boolean {
  const clean = sanitizeQuery(q);
  const { fields, noteTypes, sections, ...rest } = clean;
  if (!fields && !noteTypes && !sections) return compileQuery(clean, ctx);
  const { index } = ctx;
  const tests: ((card: Card) => boolean)[] = [];
  if (noteTypes) {
    const types = typeSets(index);
    tests.push(noteIn(noteTypes.map((typeId) => types.get(typeId))));
  }
  if (sections) {
    const sets = pathSets(index);
    // deckId → the notes of its sections: a card passes when ITS deck has a section with its note.
    const byDeck = new Map<Id, ReadonlySet<Id>[]>();
    for (const { deckId, path } of sections) {
      const list = byDeck.get(deckId) ?? [];
      list.push(sectionNotes(sets, path));
      byDeck.set(deckId, list);
    }
    const inDeck = new Map<Id, (card: Card) => boolean>();
    for (const [deckId, list] of byDeck) inDeck.set(deckId, noteIn(list));
    tests.push((card) => inDeck.get(card.deckId)?.(card) ?? false);
  }
  if (fields) {
    // A field name is user data ('constructor'): the record has no prototype, and is read with ownValue.
    for (const key of Object.keys(fields)) {
      const byValue = fieldSets(index, key);
      tests.push(noteIn((ownValue(fields, key) ?? []).map((value) => byValue?.get(value))));
    }
  }
  const others = compileQuery(rest, ctx);
  return (card) => {
    for (let k = 0; k < tests.length; k++) if (!tests[k](card)) return false;
    return others(card);
  };
}

/**
 * The numbers on the "Study N" button of scope `q`: `total` is the length of
 * the session `buildSessionQueue({ kind: 'scheduled', q })` opens.
 */
export function readyFor(state: ScopeState, q: Query, ctx: MatchCtx): ReadyCounts {
  return readyCounts(selectScheduled(scopePool(state, q, ctx, 'study'), scheduleCtxOf(state, ctx)));
}

/**
 * readyFor, plus `dueNow`: the "{n} due" of scope `q`, from the SAME
 * scheduler run (schedule.ts selectScheduledWithDue) — the rule of the deck
 * rows (deckStatsMap), for any scope (a Today list row). So "{n} due" never
 * counts a card that Study cannot show: not a card with a broken due time,
 * not the second direction of an item (one card per note), not a review
 * whose sibling was studied today (spaceSiblings). `ready` is exactly
 * readyFor(state, q, ctx).
 *
 *   dueNow >= ready.learning + ready.due, and equal when no daily review
 *   limit and no session size cuts the run.
 */
export function dueAndReadyFor(state: ScopeState, q: Query, ctx: MatchCtx): { dueNow: number; ready: ReadyCounts } {
  const run = selectScheduledWithDue(scopePool(state, q, ctx, 'study'), scheduleCtxOf(state, ctx));
  return { dueNow: run.dueNow, ready: readyCounts(run.selection) };
}

/**
 * Should a "Study N" button be live? True when the session it opens has at
 * least one card (`ready.total > 0`). Every launch control decides with THIS,
 * never with the "{n} due" count (H1), because the two can differ:
 *   - a deck of brand-new cards has 0 due, but its session has new cards:
 *     it IS launchable (the "freshly added deck shows a checkmark" bug);
 *   - a deck with overdue cards whose daily review limit is used up has
 *     "{n} due" > 0, but its session is empty: it is NOT launchable (no
 *     "Study 0" button that opens an empty session).
 *
 *   isLaunchable(readyFor(state, { decks: [id] }, ctx))
 *   isLaunchable(deckStatsMap(state, ctx).get(id)!.ready)   // the same answer
 */
export function isLaunchable(ready: Pick<ReadyCounts, 'total'>): boolean {
  return ready.total > 0;
}

/** The cards of a selection (`sel` ids), in the given order, each once; ids that no longer exist are skipped. */
function selectionCards(state: ScopeState, ids: readonly Id[]): Card[] {
  const { cardById } = cardLookupOf(state.cards);
  const seen = new Set<Id>();
  const out: Card[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const card = cardById.get(id);
    if (card) out.push(card);
  }
  return out;
}

/**
 * The cards of a new session (spec §6.1), every kind capped by the session
 * size (`settings.sessionLimit`):
 *   scheduled → planQueue(selectScheduled(scopePool(q, 'study')))
 *   ahead     → selectAhead(scopePool(q, 'study'))
 *   practice  → selectPractice(scopePool(q, 'browse'), sort)  — or the `sel` cards
 */
export function buildSessionQueue(params: SessionParams, state: ScopeState, ctx: MatchCtx): Card[] {
  switch (params.kind) {
    case 'scheduled':
      return planQueue(selectScheduled(scopePool(state, params.q, ctx, 'study'), scheduleCtxOf(state, ctx)));
    case 'ahead':
      return selectAhead(scopePool(state, params.q, ctx, 'study'), scheduleCtxOf(state, ctx));
    case 'practice':
      if ('sel' in params) {
        // A selection has no query: selectPractice removes Known, Not started, suspended and buried cards.
        return selectPractice(selectionCards(state, params.sel), params.sort ?? null, scheduleCtxOf(state, ctx));
      }
      return selectPractice(
        scopePool(state, params.q, ctx, 'browse'),
        params.sort ?? null,
        scheduleCtxOf(state, ctx, params.q),
      );
  }
}

/**
 * `cards` in the order of `sort` (a new array) — the ONE sort of the Library
 * sort menu (Deck order, Due date, A–Z, Recently added, Hardest first, a
 * field such as Level) and of Practice: buildSessionQueue({ kind: 'practice',
 * q, sort }) gives its cards in exactly this order. A–Z is by the word, not
 * by its article ("das Anliegen" under A, face.ts faceSortKey), with the one
 * key comparison of schedule.ts compareSortKeys.
 *
 *   const rows = sortScopeCards(scopePool(state, q, ctx, 'browse'), { by: 'az' }, state, ctx);
 *
 * FAST ON A BIG LIBRARY (unit P1; the release build sorted 16,000 cards on
 * every filter: "Deck German + New" 61 ms, A–Z 150–237 ms). The order is
 * always exactly `sortCards(cards, sort, …)` (schedule.ts), but it is made
 * in one of these cheaper ways:
 *   - a list of at least 1/8 of the library, when the library's order for
 *     this sort is kept (libraryOrder below) or can be REPAIRED cheaply (a
 *     rating changed a few cards): the list is that order with the other
 *     cards left out — no sort at all, one pass;
 *   - the whole library without a usable kept order: its order is made
 *     now (the same work as sorting the list) and kept;
 *   - any other list (shorter, or no usable order): sorted on its own with
 *     schedule.ts orderCards — never more work than the list itself. The
 *     Library then makes the library's order while the phone is idle
 *     (warmLibraryOrder below), so the next lists are a cut again (unit P1
 *     review 2: "Due date" on a Level chip sorted all 16,000 cards after
 *     each rating, where sorting the 2,500 cards of the list was cheaper).
 * Cutting one order down to a subset gives the subset's own sorted order
 * because no two cards compare as equal (ids are unique; sortIsStrict
 * checks it, and a library where it fails is sorted list by list — with
 * sortCards itself when two cards share one id).
 *
 * Unit P4: when the library's order IS the order of the cards in the store
 * (the usual case for "Deck order": the store keeps cards in import order),
 * the list is already in order — a copy of it is the result, with no pass
 * over the order. For the whole library that is one native copy
 * (`slice()`). The Library's list, which is only read, takes no copy at
 * all (sortScopeRows below).
 */
export function sortScopeCards(cards: readonly Card[], sort: SortSpec, state: ScopeState, ctx: MatchCtx): Card[] {
  const rows = orderScope(cards, sort, state, ctx);
  // Always a NEW array (a caller may keep or change it): a copy when the cards already were in order.
  return rows === cards ? cards.slice() : (rows as Card[]);
}

/**
 * sortScopeCards for a list that is only READ — the Library's rows (unit P4
 * review): the same cards in the same order, but when `cards` already IS
 * in the order of `sort` (Deck order of a library stored in that order),
 * the result is `cards` itself — no array of 16,000 cards is made. So the
 * Library's "no filter" opening (browsePool: the state's own array) makes
 * no big array at all, and a Deck order list with a filter is its pool.
 * The caller must never change the result (the store never does either).
 *
 *   sortScopeRows(state.cards, { by: 'source' }, state, ctx) === state.cards   // a library stored in Deck order
 *   ids(sortScopeRows(pool, sort, state, ctx)) === ids(sortScopeCards(pool, sort, state, ctx))   // always
 */
export function sortScopeRows(cards: readonly Card[], sort: SortSpec, state: ScopeState, ctx: MatchCtx): readonly Card[] {
  return orderScope(cards, sort, state, ctx);
}

/** The work of sortScopeCards: `cards` in the order of `sort` — `cards` ITSELF when it already is in that order. */
function orderScope(cards: readonly Card[], sort: SortSpec, state: ScopeState, ctx: MatchCtx): readonly Card[] {
  const all = state.cards ?? NO_CARDS;
  const sctx = sortCtxOf(all, ctx.index, ctx.decks);
  // Two cards with one id (damaged data; checkIntegrity gives one a new id
  // on load): only the comparator sort itself gives its order — it keeps one
  // A–Z key per id, so the twin of another note sorts by the first one's key.
  if (sctx.lookup.cardById.size !== all.length) return sortCards(cards, sort, sctx);
  if (cards.length < all.length * LIBRARY_ORDER_MIN_SHARE) return orderCards(cards, sort, sctx);
  // Make a new library order only when the list is the whole library (the same cost as sorting it).
  const memo = libraryOrder(all, sort, ctx.index, ctx.decks, sctx, cards.length >= all.length);
  const positions = memo?.positions;
  if (!memo || !positions) return orderCards(cards, sort, sctx);
  // The whole library itself (the list of "no filter"): its order, nothing to leave out (unit P2).
  if (cards === all) {
    if (memo.inOrder) return all;
    const out = new Array<Card>(positions.length);
    for (let k = 0; k < positions.length; k++) out[k] = all[positions[k]];
    return out;
  }
  // Where the cards are in the library. They must be a PART of it, in its
  // order (scopePool keeps the order of the state); else the list is sorted
  // on its own (a list from elsewhere, or a card twice). Only object
  // identity is compared: no text keys, no hashing.
  const inList = new Uint8Array(all.length);
  let found = 0;
  for (let i = 0; i < all.length && found < cards.length; i++) {
    if (all[i] === cards[found]) {
      inList[i] = 1;
      found += 1;
    }
  }
  if (found < cards.length) return orderCards(cards, sort, sctx);
  // A part of the library in the library's order, and that order is the sort's: already sorted (unit P4).
  if (memo.inOrder) return cards;
  const out: Card[] = [];
  for (let k = 0; k < positions.length; k++) if (inList[positions[k]] === 1) out.push(all[positions[k]]);
  return out;
}

/**
 * What the Library's sort reads (unit P4): the decks, the A–Z / field key
 * and the card lookup (unique ids) — a part of scheduleCtxOf, without the
 * tallies and settings a sort never reads. So the shared warm-up, which has
 * only the cards, the index and the decks (warmLibraryOrderOf), makes
 * exactly the order a list would make.
 */
type LibrarySortCtx = SortCtx & Pick<ScheduleCtx, 'lookup'>;

function sortCtxOf(cards: readonly Card[], index: LibraryIndex, decks: ReadonlyMap<Id, Deck>): LibrarySortCtx {
  return { decks, sortKey: sortKeyFor(index, decks), lookup: cardLookupOf(cards) };
}

/* ------------------------------------------------------------------ the library's sort orders (unit P1) */

/** A list of at least this share of the library is cut from the library's order (sortScopeCards). */
export const LIBRARY_ORDER_MIN_SHARE = 1 / 8;
/**
 * A kept order is repaired (not made again) when at most this share of the
 * cards changed a value the sort reads (libraryOrder). Placing k cards costs
 * about k·log₂N comparisons: at 1/20 that is still less than sorting the
 * smallest list that is cut from the order (1/8 of the library).
 */
export const LIBRARY_ORDER_REPAIR_MAX_SHARE = 1 / 20;
/** How many sort orders of one library are kept (the sort menu has about 6 entries). */
const ORDERS_KEPT = 8;

/** One sort order of the whole library, and what it was made from. */
interface LibraryOrderMemo {
  cards: readonly Card[];
  decks: ReadonlyMap<Id, Deck>;
  /**
   * The order of the sort as positions in `cards`: cards[positions[0]] comes
   * first. Positions, not cards, so a new cards array can reuse or repair
   * them (see libraryOrder). Null when the sort is no strict order here
   * (sortIsStrict, or two cards with one id).
   */
  positions: readonly number[] | null;
  /**
   * True when `positions` are 0, 1, 2 … — the cards are in the sort's order
   * already (unit P4: usually "Deck order"). sortScopeCards then copies a
   * list instead of cutting it out of the order.
   */
  inOrder: boolean;
}

/** True when `positions` are 0, 1, 2 … (one pass; it stops at the first other number). */
function isIdentity(positions: readonly number[] | null): boolean {
  if (!positions) return false;
  for (let k = 0; k < positions.length; k++) if (positions[k] !== k) return false;
  return true;
}

/** Per library index (notes + card types): sort key → its order. A Map keeps insertion order: oldest first. */
const orderCache = new WeakMap<LibraryIndex, Map<string, LibraryOrderMemo>>();

/** The key of a sort in orderCache. */
const orderKeyOf = (sort: SortSpec): string => JSON.stringify([sort.by, sort.field ?? null, sort.dir ?? null]);

/**
 * The positions where `next` has a card that differs from the card of
 * `prev` in a value the sort reads (`fields`; the id is one of them), in
 * position order. Null when the lengths differ or more than `limit`
 * positions changed (then a repair would not be cheap). One pass; a card
 * object that did not change is skipped at once.
 *
 *   changedPositions(before, afterOneRating, DUE_FIELDS, 800)   → [10]
 */
function changedPositions(
  prev: readonly Card[],
  next: readonly Card[],
  fields: readonly (keyof Card)[],
  limit: number,
): number[] | null {
  if (prev.length !== next.length) return null;
  const out: number[] = [];
  for (let i = 0; i < next.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (a === b) continue;
    for (const f of fields) {
      if (a[f] !== b[f]) {
        if (out.length >= limit) return null;
        out.push(i);
        break;
      }
    }
  }
  return out;
}

/**
 * The kept order `hit` for a NEW cards array of the same library (the same
 * index and decks), without sorting again — or null when that is not cheap
 * or not safe. Nothing a sort reads changed (a flag, or a rating under
 * "Deck order"): the kept positions are reused in one pass. A few cards
 * changed (a rating under "Due date"): schedule.ts repairPositions puts only
 * those cards at their new places. More than LIBRARY_ORDER_REPAIR_MAX_SHARE
 * of the cards, another length, a new id twice, or a changed card that
 * breaks the strict order (sortIsStrict): null.
 */
function repairedOrder(
  hit: LibraryOrderMemo,
  cards: readonly Card[],
  sort: SortSpec,
  sctx: LibrarySortCtx,
): LibraryOrderMemo | null {
  if (!hit.positions) return null;
  const limit = Math.floor(cards.length * LIBRARY_ORDER_REPAIR_MAX_SHARE);
  const changed = changedPositions(hit.cards, cards, sortFieldsOf(sort), limit);
  if (!changed) return null;
  if (changed.length === 0) return { cards, decks: hit.decks, positions: hit.positions, inOrder: hit.inOrder };
  // The same two promises as makeLibraryOrder: unique ids (an id can change
  // at a changed position) and a strict order. The cards that did not
  // change kept the values that were checked when the order was made.
  if (sctx.lookup.cardById.size !== cards.length) return null;
  if (!sortIsStrict(changed.map((i) => cards[i]), sort, sctx)) return null;
  const positions = repairPositions(cards, hit.positions, changed, sort, sctx);
  return { cards, decks: hit.decks, positions, inOrder: isIdentity(positions) };
}

/**
 * Every card of the library in the order of `sort` (orderCards), kept per
 * (notes, card types, decks, cards). A new cards array of the same library
 * reuses or REPAIRS the kept order (repairedOrder): after a rating, a flag
 * or an undo only the changed cards are placed again, also for "Due date"
 * and "Hardest first", which read the schedule. When no kept order can be
 * reused or repaired, a new one is made only with `make` (sortScopeCards:
 * the list is the whole library, so making the order costs the same as
 * sorting the list; warmLibraryOrder: the phone is idle); else the result is
 * null and the caller sorts its list on its own.
 *
 * The memo's `positions` are null when the sort is no strict order on these
 * cards (sortIsStrict, or two cards with one id): then sortScopeCards sorts
 * each list on its own.
 *
 * Never stale: notes or card types → another index (another cache);
 * decks → `memo.decks` differs; a card value the sort reads → that card is
 * placed again (repairPositions), or the order is made again.
 */
function libraryOrder(
  cards: readonly Card[],
  sort: SortSpec,
  index: LibraryIndex,
  decks: ReadonlyMap<Id, Deck>,
  sctx: LibrarySortCtx,
  make: boolean,
): LibraryOrderMemo | null {
  const hit = orderCache.get(index)?.get(orderKeyOf(sort));
  let memo: LibraryOrderMemo | null = null;
  if (hit && hit.decks === decks) memo = hit.cards === cards ? hit : repairedOrder(hit, cards, sort, sctx);
  if (!memo) {
    if (!make) return null;
    memo = makeLibraryOrder(cards, sort, decks, sctx);
  }
  keepOrder(index, sort, memo);
  return memo;
}

/** Keep `memo` as the order of `sort` for `index`: the newest last; the oldest goes when there are too many. */
function keepOrder(index: LibraryIndex, sort: SortSpec, memo: LibraryOrderMemo): void {
  const key = orderKeyOf(sort);
  let byKey = orderCache.get(index);
  if (!byKey) {
    byKey = new Map();
    orderCache.set(index, byKey);
  }
  byKey.delete(key);
  byKey.set(key, memo);
  while (byKey.size > ORDERS_KEPT) byKey.delete(byKey.keys().next().value as string);
}

/**
 * Make the library's order for `sort` ready (reused, repaired or made), so
 * the next lists of this sort are a cut of it (sortScopeCards). The Library
 * screen calls it while the phone is idle, for the sort it shows: after a
 * list had to be sorted on its own (the first list of a sort, or after a big
 * change such as an import or a reset of many cards), the work of a new
 * order happens there, not while the learner waits for a list (unit P1
 * review 2). True when it did work; false when the kept order was already
 * the one of these cards.
 *
 *   warmLibraryOrder(state, { by: 'due' }, ctx);   // in an idle timer
 */
export function warmLibraryOrder(state: ScopeState, sort: SortSpec, ctx: MatchCtx): boolean {
  return warmLibraryOrderOf({ cards: state.cards ?? NO_CARDS, index: ctx.index, decks: ctx.decks }, sort);
}

/** The data of a library order: the store's cards array, its library index and its decks by id. */
export interface OrderTarget {
  cards: readonly Card[];
  index: LibraryIndex;
  decks: ReadonlyMap<Id, Deck>;
}

/** True when the kept order of `sort` is the one of exactly these cards and decks (warmLibraryOrderOf has nothing to do). */
export function libraryOrderReady(target: OrderTarget, sort: SortSpec): boolean {
  const hit = orderCache.get(target.index)?.get(orderKeyOf(sort));
  return hit !== undefined && hit.cards === target.cards && hit.decks === target.decks;
}

/**
 * warmLibraryOrder for the data of a warm-up (unit P4): the cards, the
 * index and the decks — all a sort reads. The Library's shared warm-up
 * (store/libraryWarmup.ts) makes the order of the Library's default sort,
 * Deck order, this way while the phone is idle, so the first opening of the
 * Library finds it ready (and after a rating, repaired). The same order
 * sortScopeCards makes: the same cache, the same rules. True when it did
 * work.
 *
 *   warmLibraryOrderOf(warmTargetOf(state), { by: 'source' });
 */
export function warmLibraryOrderOf(target: OrderTarget, sort: SortSpec): boolean {
  if (libraryOrderReady(target, sort)) return false;
  const { cards, index, decks } = target;
  libraryOrder(cards, sort, index, decks, sortCtxOf(cards, index, decks), true);
  return true;
}

/** "Deck order", the sort of warmDeckOrder: the Library's default sort. */
const DECK_ORDER: SortSpec = Object.freeze({ by: 'source' }) as SortSpec;

/** Per library index: the Deck order that warmDeckOrder is making a part at a time, and for which data. */
const deckOrderJobs = new WeakMap<
  LibraryIndex,
  { cards: readonly Card[]; decks: ReadonlyMap<Id, Deck>; next: (stop: () => boolean) => SourceOrderStep }
>();

/**
 * The library's "Deck order" for the shared warm-up, A PART AT A TIME (unit
 * P4 review): warmLibraryOrderOf(target, { by: 'source' }) made the whole
 * order in ONE step — one 26.7 ms slice in node --jitless (budget 8 ms)
 * when the cards are not stored in Deck order, for example after a card
 * was added to an older deck. Now:
 *   - a kept order that can be reused or repaired (a rating, a flag) is
 *     taken at once, as before (one quick pass);
 *   - else schedule.ts sourceOrderJob makes it: `stop()` is asked after
 *     the columns and after every 1,024 steps. When it says yes, this
 *     returns false, and the next call goes on from there.
 * True when the order is ready (at once, when it already was). It is
 * EXACTLY the order warmLibraryOrderOf makes (the same positions, kept in
 * the same cache), so the Library's first list finds it ready.
 *
 *   while (!warmDeckOrder(target, () => clock() - start > 8)) …   // again later
 */
export function warmDeckOrder(target: OrderTarget, stop: () => boolean): boolean {
  if (libraryOrderReady(target, DECK_ORDER)) return true;
  const { cards, index, decks } = target;
  const sctx = sortCtxOf(cards, index, decks);
  // A kept order of the same library: reused or repaired, without a new sort (null: not possible here).
  if (libraryOrder(cards, DECK_ORDER, index, decks, sctx, false)) return true;
  if (sctx.lookup.cardById.size !== cards.length) {
    // Two cards with one id: no strict order (makeLibraryOrder keeps null positions). Quick, no sort.
    libraryOrder(cards, DECK_ORDER, index, decks, sctx, true);
    return true;
  }
  let job = deckOrderJobs.get(index);
  if (!job || job.cards !== cards || job.decks !== decks) {
    job = { cards, decks, next: sourceOrderJob(cards, sctx) };
    deckOrderJobs.set(index, job);
  }
  const step = job.next(stop);
  if (!step.done) return false;
  deckOrderJobs.delete(index);
  keepOrder(index, DECK_ORDER, { cards, decks, positions: step.positions, inOrder: step.inOrder });
  return true;
}

/**
 * Make one library order (see libraryOrder). It needs a strict order AND
 * unique card ids (the card lookup has one entry per card): then no two
 * cards compare as equal, and the order of any subset is the same however
 * the subset is listed.
 */
function makeLibraryOrder(
  cards: readonly Card[],
  sort: SortSpec,
  decks: ReadonlyMap<Id, Deck>,
  sctx: LibrarySortCtx,
): LibraryOrderMemo {
  const unique = sctx.lookup.cardById.size === cards.length;
  // orderPositions makes the sortIsStrict checks in the same pass that reads the numbers (unit P2).
  const positions = unique ? orderPositions(cards, sort, sctx) : null;
  return { cards, decks, positions, inOrder: isIdentity(positions) };
}

/* ------------------------------------------------------------------ warming the Library's caches (units P1, P2) */

/**
 * The parts of the warm-up, MOST URGENT FIRST (unit P2). Each part is one
 * pass over the cards, one step per card:
 *   'searchText'  the note's search text (libraryIndex searchText): the
 *                 first search. The learner usually types first, so this
 *                 part comes first and does nothing else;
 *   'headlines'   the card's headline (face.ts faceHeadline): A–Z and the
 *                 headline rank of a search ("der Hund" first);
 *   'facets'      the note's facet data (facets.ts): the FacetSheet's counts;
 *   'noteLabels'  the note's section and tag labels (libraryIndex warmNoteLabels).
 * After them comes one more step, 'labels': the index's display labels.
 *
 * WHY passes (unit P2; the release device took 234 ms for the first search
 * 'zeit', budget 30 ms): the old warm-up did all four for one card before
 * the next card, so the search text of the LAST note was ready only at the
 * very end — about 1.5–4.5 s after the Library opened on Hermes, and a fast
 * learner typed before that.
 */
export const WARM_PASSES = ['searchText', 'headlines', 'facets', 'noteLabels'] as const;

/** One part of the warm-up: a pass of WARM_PASSES, or the last step 'labels'. */
export type WarmPart = (typeof WARM_PASSES)[number] | 'labels';

/**
 * The step at which `part` — and every part before it — is done for every
 * card: once warmLibraryCaches returned a step ≥ this, all those values are
 * in their caches.
 *
 *   warmDoneAt(cards, 'searchText')  → cards.length        (the first search reads no note)
 *   warmDoneAt(cards, 'headlines')   → 2 × cards.length
 *   warmDoneAt(cards, 'labels')      → warmLibrarySteps(cards)
 */
export function warmDoneAt(cards: readonly Card[], part: WarmPart): number {
  if (part === 'labels') return warmLibrarySteps(cards);
  return (WARM_PASSES.indexOf(part) + 1) * cards.length;
}

/**
 * Fill the per-note caches the Library reads, a slice at a time, so that
 * their first use costs nothing on the learner's path (the release pass:
 * the first search took 234 ms, the first A–Z sort 685 ms, the first
 * FacetSheet opening 162 ms — each time the values of every note were made
 * while the learner waited). The work has `warmLibrarySteps(cards)` steps:
 *   - one pass per part of WARM_PASSES, in that order, one step per card:
 *     steps 0 … N − 1 the search text, N … 2N − 1 the headlines, 2N … 3N − 1
 *     the facet data, 3N … 4N − 1 the note labels (N = cards.length);
 *   - the last step, 4N: the index's display labels of the field values,
 *     sections and tags (the FacetSheet's labels), made a part at a time
 *     too (libraryIndex warmLabels: the index keeps its place).
 * So the search text of EVERY note is ready after the first N steps
 * (warmDoneAt(cards, 'searchText')), long before the rest.
 *
 * Every value goes into the cache its normal reader uses, so nothing can
 * differ: the reader only finds it ready. `stop()` is asked after every 64
 * cards of a pass, before a new part when this call already did cards
 * (also before the labels), and after every 64 notes of the labels; when
 * it says yes, this returns the step to go on from. So one call does at
 * most about 64 cards' or 64 notes' work after a yes (unit P1 review: the
 * labels were one block of about 15–25 ms in node, 45–85 ms on the phone).
 * The return value is `warmLibrarySteps(cards)` when everything is done. A
 * second run over the same cards only finds cache hits.
 *
 *   let at = 0;
 *   at = warmLibraryCaches(cards, ctx, at, () => clock() - start > 8);   // again later, until at === warmLibrarySteps(cards)
 *
 * `until` (unit P4) ends the call at that step at the latest, with no
 * `stop()` question: the Library's search box got the focus, and the rest
 * of the search-text pass is done at once —
 *
 *   at = warmLibraryCaches(cards, ctx, at, () => false, warmDoneAt(cards, 'searchText'));
 */
export function warmLibraryCaches(
  cards: readonly Card[],
  ctx: Pick<MatchCtx, 'index' | 'decks'>,
  from: number,
  stop: () => boolean,
  until: number = Number.POSITIVE_INFINITY,
): number {
  const { index, decks } = ctx;
  const n = cards.length;
  const cardSteps = WARM_PASSES.length * n;
  // The facet data's reader, made only when its pass runs.
  let warmFacets: ((note: Note) => void) | null = null;
  /** The work of pass `pass` for one card (0 searchText, 1 headlines, 2 facets, 3 noteLabels: the order of WARM_PASSES). */
  const warmCard = (pass: number, card: Card): void => {
    if (pass === 1) {
      faceHeadline(card, index, decks);
      return;
    }
    const note = index.noteById.get(card.noteId);
    if (!note) return;
    if (pass === 0) index.searchText(note);
    else if (pass === 2) (warmFacets ??= facetNoteWarmer(index))(note);
    else warmNoteLabels(note);
  };
  let at = Math.max(0, from);
  // True once this call did a card step: a new part then asks stop() first.
  let worked = false;
  while (at < cardSteps) {
    if (at >= until) return at;
    const pass = Math.floor(at / n);
    if (worked && stop()) return at;
    // The end of this part, or `until` when it is inside the part.
    const end = Math.min(n, until - pass * n);
    for (let i = at - pass * n; i < end; i++) {
      warmCard(pass, cards[i]);
      if (i % 64 === 63 && i + 1 < n && i + 1 < end && stop()) return pass * n + i + 1;
    }
    at = pass * n + end;
    worked = true;
  }
  if (at >= until) return at;
  // The last step: the labels. When this call already did cards, ask first.
  if (worked && stop()) return cardSteps;
  return index.warmLabels(stop) ? warmLibrarySteps(cards) : cardSteps;
}

/**
 * How many steps warmLibraryCaches has for these cards: one per card in
 * each pass of WARM_PASSES, and one for the labels. It returns this number
 * when everything is done.
 *
 *   warmLibrarySteps([])         → 1   (the labels only)
 *   warmLibrarySteps(16k cards)  → 64,001
 */
export function warmLibrarySteps(cards: readonly Card[]): number {
  return WARM_PASSES.length * cards.length + 1;
}

/* ------------------------------------------------------------------ deck rows */

/** The numbers of one deck row (Today, deck page). */
export interface DeckSummary {
  /** Every card of the deck. */
  total: number;
  /** Cards per status (Not started · New · Learning · Review · Mastered · Known). */
  life: Record<LifeKey, number>;
  /**
   * Cards due now that Study can show from this deck: the "{n} due" label.
   * Not capped by the daily review limit or the session size, but only cards
   * of Study's own due buckets (schedule.ts selectScheduledWithDue): never a
   * card with a broken due time, never a review whose sibling waits for
   * another day. So `dueNow >= ready.learning + ready.due`, and equal when no
   * limit cuts the run.
   */
  dueNow: number;
  /** = readyFor(state, { decks: [deck.id] }, ctx): the deck's "Study N" button. */
  ready: ReadyCounts;
}

/** A status count with every key at 0. */
function zeroLife(): Record<LifeKey, number> {
  const out = {} as Record<LifeKey, number>;
  for (const key of LIFE_KEYS) out[key] = 0;
  return out;
}

/**
 * The row numbers of EVERY deck, in one pass over the cards (spec §8.1: it
 * replaces one `deckStats` call per deck in render). `ready` of a deck is
 * exactly `readyFor(state, { decks: [id] }, ctx)`: the deck's own row names
 * the deck, so a paused deck can still be studied from it.
 *
 * A card whose deck does not exist is in no row (checkIntegrity moves such
 * a card to "Unfiled cards" on load).
 */
export function deckStatsMap(state: ScopeState, ctx: MatchCtx): Map<Id, DeckSummary> {
  const sctx = scheduleCtxOf(state, ctx);
  interface Row {
    total: number;
    life: Record<LifeKey, number>;
    pool: Card[];
    named: ReadonlySet<Id>;
  }
  const rows = new Map<Id, Row>();
  for (const deck of state.decks ?? NO_DECKS) {
    if (!rows.has(deck.id)) rows.set(deck.id, { total: 0, life: zeroLife(), pool: [], named: new Set([deck.id]) });
  }
  for (const card of state.cards ?? NO_CARDS) {
    const row = rows.get(card.deckId);
    if (!row) continue;
    row.total += 1;
    row.life[life(card)] += 1;
    if (studyEligible(card, sctx, row.named)) row.pool.push(card);
  }
  const out = new Map<Id, DeckSummary>();
  for (const [id, row] of rows) {
    // ONE scheduler run gives both the "Study N" numbers and "{n} due".
    const run = selectScheduledWithDue(row.pool, sctx);
    out.set(id, {
      total: row.total,
      life: row.life,
      dueNow: run.dueNow,
      ready: readyCounts(run.selection),
    });
  }
  return out;
}
