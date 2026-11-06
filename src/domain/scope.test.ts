/**
 * One scope for every count and every queue (spec §4.5 scope.ts, unit W3-4).
 *
 * The promise these tests pin: the number on a Study button for a scope is
 * EXACTLY the session that scope opens, on every surface. In detail:
 *   1. Report 1's case: a favorite in a paused deck — browse 2, study 1, and
 *      the Markers filter group says "In a paused deck (1)".
 *   2. A scope that NAMES a deck (deck chip, section, list) studies it even
 *      when it is paused.
 *   3. A seeded property test (300 random libraries × random queries × session
 *      sizes × sibling settings × per-deck caps × Known / Not started mixes):
 *      readyFor(q).total === buildSessionQueue({ kind: 'scheduled', q }).length,
 *      and every queued card is in the scope and studiable.
 *   4. deckStatsMap (one pass) gives each deck exactly readyFor({ decks: [id] }).
 *   5. Practice and study ahead go through the same pools; the sort keys and
 *      the caches.
 *   6. W5-3: the cases of the deleted queue.ts facade tests, now on scope.ts
 *      (the launch count vs "{n} due", bury, the shared daily budget,
 *      isLaunchable, the bucket order, siblings, round robin, the session
 *      size), and a GREP GUARD: the old aliases and facade names never come
 *      back anywhere under src/.
 *   7. Unit P4: Level, Section and Card type chips answered from note
 *      lookups give EXACTLY the query test's cards (random libraries with
 *      real field groups, odd section paths, damaged data); the lookups are
 *      made in slices of 64 notes; browsePool, Deck order as a copy, the
 *      warm-up's Deck order (warmLibraryOrderOf), and warmLibraryCaches `until`.
 *   8. The P4 review: a chip makes only its own lookup PART (also in the
 *      middle of the warm-up's pass: the same cards), sortScopeRows (no copy
 *      when the rows are already in order; always sortScopeCards' rows), and
 *      warmDeckOrder (the Deck order a part at a time, the same order).
 *   9. Final pass: "Due date" puts the cards with no review date (New, Not
 *      started, Known) last; a change of ONLY knownAt ("I know it", "Learn")
 *      or ONLY reps moves a card between the two groups, and the kept
 *      library order is repaired for it (the old order every time).
 */
import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

import {
  deckStatsReader,
  facetsReader,
  memoOnInputs,
  readyReader,
  scopePoolReader,
  sessionLengthReader,
  sessionParamsKey,
  sortedPoolReader,
} from '../store/selectors';
import { FIXED_NOW } from '../test/clock';
import {
  lifeValues,
  makeDeckV3,
  noteWithCards,
  randomStateV3,
  stateOfV3,
  threeWayType,
} from '../test/factoriesV3';
import { createRandom, type Random } from '../test/random';
import { BUILTIN_TYPE_IDS, builtinType } from './builtinTypes';
import { deriveFacets } from './facets';
import { isBuried, LIFE_KEYS, life } from './life';
import { pathPrefixes } from './libraryIndex';
import { BUILTIN_LISTS } from './lists';
import { faceHeadline } from './face';
import type { Card, DataStateV3, Deck, FlagKey, Id, LifeKey, ListDef, Note, NoteType, Query, SortSpec } from './model';
import { compileQuery, explicitDecks, fieldRecord, type MatchCtx, serializeQuery } from './query';
import { isCheckSampled, minutesFor, sortCards, studyEligible } from './schedule';
import {
  browsePool,
  buildSessionQueue,
  cardLookupOf,
  decksById,
  deckStatsMap,
  isLaunchable,
  LIBRARY_ORDER_MIN_SHARE,
  LIBRARY_ORDER_REPAIR_MAX_SHARE,
  libraryIndexOf,
  libraryOrderReady,
  listsOf,
  matchCtxOf,
  noteSetsReady,
  readyFor,
  scheduleCtxOf,
  scopePool,
  type SessionParams,
  sortScopeCards,
  sortScopeRows,
  WARM_PASSES,
  warmDeckOrder,
  warmDoneAt,
  warmLibraryCaches,
  warmLibraryOrder,
  warmLibraryOrderOf,
  warmLibrarySteps,
  warmNoteSets,
} from './scope';
import { DAY, dayKeyOf, HOUR, MIN, NO_REVIEW_LIMIT } from './types';

const NOW = FIXED_NOW;
const ids = (cards: readonly Card[]) => cards.map((c) => c.id);
const sortedIds = (cards: readonly Card[]) => ids(cards).sort();

/** One Basic note in `deckId` with one card in status `kind` (+ card overrides). */
function basic(id: string, deckId: Id, kind: LifeKey, card: Partial<Card> = {}, note: Partial<Note> = {}) {
  return noteWithCards({
    deckId,
    typeId: BUILTIN_TYPE_IDS.basic,
    fields: [`front ${id}`, `back ${id}`, '', ''],
    note: { id: `n-${id}`, ...note },
    card: { id, ...lifeValues(kind, NOW), ...card },
  });
}

/** A review card due an hour ago. */
const DUE_REVIEW: Partial<Card> = { due: NOW - HOUR };

/* ================================================================== report 1 */

describe('browse vs study with a paused deck (report 1: a favorite in a paused deck)', () => {
  const active = makeDeckV3({ id: 'active', name: 'Active', order: 0 });
  const paused = makeDeckV3({ id: 'paused', name: 'Paused', order: 1, active: false });
  const state = stateOfV3({
    decks: [active, paused],
    groups: [
      basic('fav-active', 'active', 'new', { fav: true }),
      basic('fav-paused', 'paused', 'new', { fav: true }),
      basic('plain', 'active', 'new'),
    ],
  });
  const ctx = matchCtxOf(state, NOW);
  const favorites: Query = { flags: ['fav'] };

  it('browse 2: the Library lists both favorites (the paused one too)', () => {
    expect(sortedIds(scopePool(state, favorites, ctx, 'browse'))).toEqual(['fav-active', 'fav-paused']);
  });

  it('study 1: Study counts and opens only the favorite of the active deck', () => {
    expect(ids(scopePool(state, favorites, ctx, 'study'))).toEqual(['fav-active']);
    expect(readyFor(state, favorites, ctx).total).toBe(1);
    expect(ids(buildSessionQueue({ kind: 'scheduled', q: favorites }, state, ctx))).toEqual(['fav-active']);
  });

  it('the Markers filter group shows "In a paused deck (1)", so the difference is never hidden', () => {
    const facets = deriveFacets(state.cards, favorites, {}, ctx);
    const markers = facets.find((f) => f.key === 'flags');
    const pausedValue = markers?.values.find((v) => v.value === 'paused');
    expect(pausedValue).toMatchObject({ label: 'In a paused deck', count: 1 });
    expect(markers?.values.find((v) => v.value === 'fav')?.count).toBe(2);
  });

  it('the built-in Favorites list gives the same numbers', () => {
    const list: Query = { list: 'builtin:favorites' };
    expect(scopePool(state, list, ctx, 'browse')).toHaveLength(2);
    expect(readyFor(state, list, ctx).total).toBe(1);
  });
});

/* ================================================================== explicit decks */

describe('a scope that names a deck bypasses its pause', () => {
  const active = makeDeckV3({ id: 'active', name: 'Active', order: 0 });
  const paused = makeDeckV3({ id: 'paused', name: 'Paused', order: 1, active: false });
  const userList: ListDef = {
    id: 'list-paused',
    name: 'From the paused deck',
    icon: '🔖',
    query: { decks: ['paused'] },
    createdAt: NOW,
    updatedAt: NOW,
  };
  const state = stateOfV3({
    decks: [active, paused],
    groups: [
      basic('a1', 'active', 'review', DUE_REVIEW),
      basic('p1', 'paused', 'review', DUE_REVIEW, { section: 'Verbs::B1' }),
      basic('p2', 'paused', 'new'),
    ],
    overrides: { lists: [userList] },
  });
  const ctx = matchCtxOf(state, NOW);

  it('"All" leaves the paused deck out', () => {
    expect(ids(buildSessionQueue({ kind: 'scheduled', q: {} }, state, ctx))).toEqual(['a1']);
    expect(readyFor(state, {}, ctx).total).toBe(1);
  });

  it('the deck page ({ decks: [paused] }) studies it', () => {
    const q: Query = { decks: ['paused'] };
    expect(ids(buildSessionQueue({ kind: 'scheduled', q }, state, ctx))).toEqual(['p1', 'p2']);
    expect(readyFor(state, q, ctx).total).toBe(2);
  });

  it('a section of the paused deck, and a list naming it, study it too', () => {
    const section: Query = { sections: [{ deckId: 'paused', path: 'verbs' }] };
    expect(ids(buildSessionQueue({ kind: 'scheduled', q: section }, state, ctx))).toEqual(['p1']);
    const list: Query = { list: 'list-paused' };
    expect(readyFor(state, list, ctx).total).toBe(2);
    expect(buildSessionQueue({ kind: 'scheduled', q: list }, state, ctx)).toHaveLength(2);
  });

  it('naming ANOTHER deck does not unpause this one', () => {
    const q: Query = { decks: ['active'], flags: ['fav'] };
    expect(explicitDecks(q, ctx).has('paused')).toBe(false);
    expect(scopePool(state, { decks: ['active', 'paused'] }, ctx, 'study')).toHaveLength(3);
    expect(scopePool(state, { notFlags: ['suspended'] }, ctx, 'study').map((c) => c.deckId)).toEqual(['active']);
  });
});

/* ================================================================== browse vs study */

describe('browse vs study: what Study may never show', () => {
  const deck = makeDeckV3({
    id: 'd1',
    name: 'Deck',
    options: { directions: { [BUILTIN_TYPE_IDS.basicReverse]: [0] } },
  });
  const reverse = noteWithCards({
    deckId: 'd1',
    typeId: BUILTIN_TYPE_IDS.basicReverse,
    note: { id: 'n-rev' },
    card: (ord) => ({ id: `rev-${ord}`, ...lifeValues('review', NOW), due: NOW - HOUR }),
  });
  const state = stateOfV3({
    decks: [deck],
    groups: [
      basic('ok', 'd1', 'review', DUE_REVIEW),
      basic('susp', 'd1', 'review', { ...DUE_REVIEW, suspended: true }),
      basic('buried', 'd1', 'review', { ...DUE_REVIEW, buriedUntil: NOW + HOUR }),
      basic('waiting', 'd1', 'notStarted'),
      reverse,
    ],
  });
  const ctx = matchCtxOf(state, NOW);

  it('browse lists every card; study leaves out suspended, buried and turned-off directions', () => {
    expect(scopePool(state, {}, ctx, 'browse')).toHaveLength(6);
    // The card type of a card comes from its note (typeIdOf), so the deck's directions apply.
    expect(sortedIds(scopePool(state, {}, ctx, 'study'))).toEqual(['ok', 'rev-0', 'waiting']);
  });

  it('Study never feeds a Not started card, even when the scope asks for it', () => {
    const q: Query = { life: ['notStarted'] };
    expect(ids(scopePool(state, q, ctx, 'study'))).toEqual(['waiting']);
    expect(readyFor(state, q, ctx).total).toBe(0);
    expect(buildSessionQueue({ kind: 'scheduled', q }, state, ctx)).toEqual([]);
  });

  it('a scope never widens: an unknown list matches nothing', () => {
    expect(scopePool(state, { list: 'gone' }, ctx, 'browse')).toEqual([]);
    expect(readyFor(state, { list: 'gone' }, ctx).total).toBe(0);
  });
});

/* ================================================================== practice and ahead */

describe('practice and study ahead use the same pools', () => {
  const active = makeDeckV3({ id: 'active', name: 'Active', order: 0 });
  const paused = makeDeckV3({ id: 'paused', name: 'Paused', order: 1, active: false });
  const state = stateOfV3({
    decks: [active, paused],
    groups: [
      basic('soon', 'active', 'review', { due: NOW + DAY, ease: 2.0 }),
      basic('later', 'active', 'review', { due: NOW + 3 * DAY, ease: 1.6 }),
      basic('paused-later', 'paused', 'review', { due: NOW + 2 * DAY, ease: 1.4 }),
      basic('susp', 'active', 'review', { due: NOW + DAY, suspended: true, ease: 1.3 }),
      basic('known', 'active', 'known'),
      basic('waiting', 'active', 'notStarted'),
      basic('fresh', 'active', 'new'),
    ],
    overrides: { settings: { ...stateOfV3({ decks: [] }).settings, sessionLimit: 0 } },
  });
  const ctx = matchCtxOf(state, NOW);

  it('study ahead: not-yet-due reviews of the STUDY pool, soonest first', () => {
    expect(ids(buildSessionQueue({ kind: 'ahead', q: {} }, state, ctx))).toEqual(['soon', 'later']);
    expect(ids(buildSessionQueue({ kind: 'ahead', q: { decks: ['paused'] } }, state, ctx))).toEqual(['paused-later']);
  });

  it('practice: the BROWSE pool (paused decks too), without Known, Not started and suspended cards', () => {
    const queue = buildSessionQueue({ kind: 'practice', q: {}, sort: { by: 'hardest' } }, state, ctx);
    expect(ids(queue)).toEqual(['paused-later', 'later', 'soon', 'fresh']);
  });

  it('practice keeps what its query (or its list) asks for', () => {
    const suspendedList = buildSessionQueue({ kind: 'practice', q: { list: 'builtin:suspended' } }, state, ctx);
    expect(ids(suspendedList)).toEqual(['susp']);
    const known = buildSessionQueue({ kind: 'practice', q: { life: ['known'] } }, state, ctx);
    expect(ids(known)).toEqual(['known']);
  });

  it('practice of a selection: given order, each card once, missing ids skipped, the usual exclusions', () => {
    const queue = buildSessionQueue(
      { kind: 'practice', sel: ['later', 'gone', 'soon', 'later', 'known', 'susp'] },
      state,
      ctx,
    );
    expect(ids(queue)).toEqual(['later', 'soon']);
    expect(buildSessionQueue({ kind: 'practice', sel: [] }, state, ctx)).toEqual([]);
  });

  it('every kind is capped by the session size', () => {
    const small = { ...state, settings: { ...state.settings, sessionLimit: 1 } };
    for (const params of [
      { kind: 'scheduled' as const, q: {} },
      { kind: 'ahead' as const, q: {} },
      { kind: 'practice' as const, q: {} },
      { kind: 'practice' as const, sel: ['soon', 'later'] },
    ]) {
      expect(buildSessionQueue(params, small, ctx).length).toBeLessThanOrEqual(1);
    }
  });
});

describe('practice sort keys come from the notes (scope.ts injects them)', () => {
  it("A–Z sorts a German term by the word, not its article ('die Abfahrt' under A)", () => {
    const deck = makeDeckV3({ id: 'de', name: 'German', language: 'de-DE', meaningLanguage: 'en-US' });
    const words = ['der Zug', 'die Abfahrt', 'das Brot'];
    const state = stateOfV3({
      decks: [deck],
      groups: words.map((w, i) =>
        noteWithCards({
          deckId: 'de',
          typeId: BUILTIN_TYPE_IDS.basic,
          fields: [w, `meaning ${i}`, '', ''],
          note: { id: `n${i}` },
          card: { id: `c${i}`, ...lifeValues('review', NOW) },
        }),
      ),
    });
    const ctx = matchCtxOf(state, NOW);
    const queue = buildSessionQueue({ kind: 'practice', q: {}, sort: { by: 'az' } }, state, ctx);
    expect(ids(queue)).toEqual(['c1', 'c2', 'c0']); // Abfahrt, Brot, Zug
  });

  it('A–Z of dictation cards sorts by the word they read aloud, not by the speaker they show', () => {
    const dictation: NoteType = {
      id: 'nt-dictation',
      name: 'Dictation',
      kind: 'standard',
      fields: [
        { name: 'Word', role: 'term', lang: 'de-DE', facet: 'off' },
        { name: 'Meaning', role: 'meaning', facet: 'off' },
      ],
      templates: [{ ord: 0, name: 'Dictation', prompt: [], answer: [0, 1], typeField: 0 }],
      sortField: 0,
      source: { ankiMid: '42' },
      createdAt: NOW,
      updatedAt: NOW,
    };
    const deck = makeDeckV3({ id: 'd', name: 'D' });
    const state = stateOfV3({
      decks: [deck],
      types: [dictation],
      groups: ['die Zeit', 'das Auto', 'der Mond'].map((word, i) =>
        noteWithCards(
          { deckId: 'd', typeId: dictation.id, fields: [word, `m${i}`], note: { id: `n${i}` }, card: { id: `c${i}`, ...lifeValues('review', NOW) } },
          [dictation],
        ),
      ),
    });
    const ctx = matchCtxOf(state, NOW);
    const queue = buildSessionQueue({ kind: 'practice', q: {}, sort: { by: 'az' } }, state, ctx);
    expect(ids(queue)).toEqual(['c1', 'c2', 'c0']); // Auto, Mond, Zeit
  });

  it("a field sort uses the ordinal order of the group's values (A2 < B1 < C1); no value comes last", () => {
    const type = builtinType('legacyVocabDe', NOW);
    const levelAt = type.fields.findIndex((f) => f.name === 'Level');
    const deck = makeDeckV3({ id: 'd', name: 'D' });
    const levels = ['C1', 'A2', '', 'B1'];
    const state = stateOfV3({
      decks: [deck],
      types: [type],
      groups: levels.map((level, i) =>
        noteWithCards(
          {
            deckId: 'd',
            typeId: type.id,
            fields: type.fields.map((_, f) => (f === 0 ? `Wort ${i}` : f === levelAt ? level : '')),
            note: { id: `n${i}` },
            card: { id: `c${i}`, ...lifeValues('review', NOW) },
          },
          [type],
        ),
      ),
    });
    const ctx = matchCtxOf(state, NOW);
    const queue = buildSessionQueue({ kind: 'practice', q: {}, sort: { by: 'field', field: 'level' } }, state, ctx);
    expect(ids(queue)).toEqual(['c1', 'c3', 'c0', 'c2']);
    // dir 'desc' (W3-4 hardening): the card with no Level stays LAST, it does not jump to the front.
    const desc = buildSessionQueue({ kind: 'practice', q: {}, sort: { by: 'field', field: 'level', dir: 'desc' } }, state, ctx);
    expect(ids(desc)).toEqual(['c0', 'c3', 'c1', 'c2']); // C1, B1, A2, then no value
    expect(ids(sortScopeCards(state.cards, { by: 'field', field: 'level', dir: 'desc' }, state, ctx))).toEqual(ids(desc));
  });
});

describe('sortScopeCards — the ONE sort of the Library and of Practice', () => {
  /** A German deck with one Basic note per front (each card a review). */
  function fronts(words: string[]) {
    const deck = makeDeckV3({ id: 'de', name: 'German', language: 'de-DE', meaningLanguage: 'en-US' });
    return stateOfV3({
      decks: [deck],
      groups: words.map((w, i) =>
        noteWithCards({
          deckId: 'de',
          typeId: BUILTIN_TYPE_IDS.basic,
          fields: [w, `meaning ${i}`, '', ''],
          note: { id: `n${i}` },
          card: { id: `c${i}`, ...lifeValues('review', NOW) },
        }),
      ),
    });
  }
  const frontOf = (state: DataStateV3) => (card: Card) => state.notes.find((n) => n.id === card.noteId)!.fields[0];

  it("digits and punctuation: the Library order IS the practice order (code points, never localeCompare)", () => {
    const state = fronts(['_x', '10 apples', '2 pears', 'apple', '~tilde']);
    const ctx = matchCtxOf(state, NOW);
    const front = frontOf(state);
    for (const dir of ['asc', 'desc'] as const) {
      const library = sortScopeCards(scopePool(state, {}, ctx, 'browse'), { by: 'az', dir }, state, ctx);
      const practice = buildSessionQueue({ kind: 'practice', q: {}, sort: { by: 'az', dir } }, state, ctx);
      expect(ids(library)).toEqual(ids(practice));
    }
    const asc = sortScopeCards(state.cards, { by: 'az' }, state, ctx);
    expect(asc.map(front)).toEqual(['10 apples', '2 pears', '_x', 'apple', '~tilde']);
  });

  it("A–Z by the word, not the article: 'das Anliegen' sorts under A", () => {
    const state = fronts(['der Zug', 'das Anliegen', 'die Brücke', 'Abend']);
    const ctx = matchCtxOf(state, NOW);
    expect(sortScopeCards(state.cards, { by: 'az' }, state, ctx).map(frontOf(state))).toEqual(['Abend', 'das Anliegen', 'die Brücke', 'der Zug']);
  });

  it('every sort of the menu: a new array in the practice order; the input is not changed', () => {
    const state = fronts(['b', 'a', 'c']);
    const ctx = matchCtxOf(state, NOW);
    const before = ids(state.cards);
    for (const by of ['source', 'due', 'az', 'newest', 'hardest'] as const) {
      const sorted = sortScopeCards(state.cards, { by }, state, ctx);
      expect(sorted).not.toBe(state.cards);
      expect(ids(sorted)).toEqual(ids(buildSessionQueue({ kind: 'practice', q: {}, sort: { by } }, state, ctx)));
    }
    expect(ids(state.cards)).toEqual(before);
  });
});

/* ================================================================== unit P1: the kept library orders */

/** Every sort of the Library menu, both ways. */
const P1_SORTS: SortSpec[] = (['source', 'due', 'az', 'newest', 'hardest', 'field'] as const).flatMap((by) => [
  { by, ...(by === 'field' ? { field: 'level' } : {}) },
  { by, dir: 'desc' as const, ...(by === 'field' ? { field: 'level' } : {}) },
]);

/** The OLD path of the Library sort: the comparator sort of schedule.ts (sortCards), on the given list. */
function oldSort(cards: readonly Card[], sort: SortSpec, state: DataStateV3): Card[] {
  return sortCards(cards, sort, scheduleCtxOf(state, matchCtxOf(state, NOW)));
}

/** sortScopeCards gives exactly the old order, for the scope pools of these queries and the whole library. */
function expectOldOrder(state: DataStateV3, queries: readonly Query[], label: string): void {
  const ctx = matchCtxOf(state, NOW);
  for (const q of queries) {
    const pool = scopePool(state, q, ctx, 'browse');
    for (const sort of P1_SORTS) {
      expect([label, q, sort, ids(sortScopeCards(pool, sort, state, ctx))]).toEqual([label, q, sort, ids(oldSort(pool, sort, state))]);
    }
  }
  for (const sort of P1_SORTS) expect(ids(sortScopeCards(state.cards, sort, state, ctx))).toEqual(ids(oldSort(state.cards, sort, state)));
}

describe('unit P1 — sortScopeCards: a big list is cut out of ONE kept order of the library, never stale', () => {
  it('200 random libraries × 6 queries × every sort: exactly the rows of the old comparator sort', () => {
    for (let i = 0; i < 200; i++) {
      const rnd = createRandom(`p1-order-${i}`);
      const state = randomLibrary(rnd.fork('state'));
      // Cards out of deck order too (a card added to an older deck is at the end of the array).
      const shuffled = rnd.bool(0.5) ? { ...state, cards: rnd.sample(state.cards, state.cards.length) } : state;
      const queries = [{}, ...Array.from({ length: 5 }, () => randomQuery(rnd, shuffled))];
      expectOldOrder(shuffled, queries, `library ${i}`);
    }
  });

  it('after a rating, an edit, an undo, an import, a moved card, a new deck order and a deletion: the rows of the old sort every time', () => {
    const rnd = createRandom('p1-order-changes');
    const start = randomLibrary(rnd.fork('state'));
    const queries = [{}, { life: ['new', 'review'] as LifeKey[] }, { decks: [start.decks[0].id] }];
    const steps: [string, (s: DataStateV3) => DataStateV3][] = [
      // A rating changes the schedule of one card (a new cards array, the same order fields).
      ['rating', (s) => ({ ...s, cards: s.cards.map((c, i) => (i === 3 ? { ...c, reps: c.reps + 1, due: NOW + 9 * DAY, ease: 1.4, lapses: 3 } : c)) })],
      // An edit makes a new note object with another headline (A–Z changes).
      ['edit', (s) => ({ ...s, notes: s.notes.map((n, i) => (i === 0 ? { ...n, fields: ['Zzz last', ...n.fields.slice(1)] } : n)) })],
      // Undo: the arrays from before the edit come back.
      ['undo', () => start],
      // An import: a new deck with new notes and cards at the end.
      [
        'import',
        (s) => {
          const extra = randomLibrary(createRandom('p1-import'));
          const prefix = (id: string) => `imp-${id}`;
          return {
            ...s,
            decks: [...s.decks, ...extra.decks.map((d) => ({ ...d, id: prefix(d.id), order: 9 }))],
            noteTypes: [...s.noteTypes, ...extra.noteTypes.filter((t) => !s.noteTypes.some((x) => x.id === t.id))],
            notes: [...s.notes, ...extra.notes.map((n) => ({ ...n, id: prefix(n.id) }))],
            cards: [...s.cards, ...extra.cards.map((c) => ({ ...c, id: prefix(c.id), noteId: prefix(c.noteId), deckId: prefix(c.deckId) }))],
          };
        },
      ],
      // A card moved to another deck, and one put back in the new-card feed.
      ['move', (s) => ({ ...s, cards: s.cards.map((c, i) => (i === 1 ? { ...c, deckId: s.decks[s.decks.length - 1].id } : i === 2 ? { ...c, newPos: -5 } : c)) })],
      // A new deck order.
      ['deck order', (s) => ({ ...s, decks: s.decks.map((d, i) => ({ ...d, order: s.decks.length - i })) })],
      // A deletion.
      ['delete', (s) => ({ ...s, cards: s.cards.filter((_, i) => i % 5 !== 0) })],
    ];
    let state = start;
    expectOldOrder(state, queries, 'start');
    for (const [name, change] of steps) {
      state = change(state);
      expectOldOrder(state, queries, name);
    }
  });

  it('a list that is not a part of the library, or holds a card twice: sorted on its own — still the old order', () => {
    const rnd = createRandom('p1-order-foreign');
    const state = randomLibrary(rnd.fork('state'));
    const ctx = matchCtxOf(state, NOW);
    const foreign = state.cards.map((c) => ({ ...c })); // equal cards, but not the library's objects
    const twice = [...state.cards, state.cards[0]];
    for (const sort of P1_SORTS) {
      expect(ids(sortScopeCards(foreign, sort, state, ctx))).toEqual(ids(oldSort(foreign, sort, state)));
      expect(ids(sortScopeCards(twice, sort, state, ctx))).toEqual(ids(oldSort(twice, sort, state)));
    }
    expect(LIBRARY_ORDER_MIN_SHARE).toBeLessThanOrEqual(1);
  });

  it('damaged data (two cards with one id, a NaN position): no kept order — each list sorted on its own, the old order', () => {
    const rnd = createRandom('p1-order-damaged');
    const state = randomLibrary(rnd.fork('state'));
    const dup = { ...state, cards: [...state.cards, { ...state.cards[0], fav: !state.cards[0].fav }] };
    const nan = { ...state, cards: state.cards.map((c, i) => (i === 2 ? { ...c, newPos: Number.NaN, due: Number.NaN } : c)) };
    expectOldOrder(dup, [{}, { flags: ['fav'] }], 'two cards, one id');
    expectOldOrder(nan, [{}, { life: ['review'] as LifeKey[] }], 'NaN position');
  });

  it('an empty library and an empty list', () => {
    const empty = stateOfV3({ decks: [], groups: [] });
    const ctx = matchCtxOf(empty, NOW);
    for (const sort of P1_SORTS) expect(sortScopeCards([], sort, empty, ctx)).toEqual([]);
    const state = randomLibrary(createRandom('p1-empty-list'));
    for (const sort of P1_SORTS) expect(sortScopeCards([], sort, state, matchCtxOf(state, NOW))).toEqual([]);
  });
});

/* ================================================================== unit P1 review 2: repair, do not sort again */

/** A seeded library of 300 cards or more, in 3 decks (big enough that one rating is far under 1/20 of it). */
function biggerLibrary(seed: string): DataStateV3 {
  for (let k = 0; ; k++) {
    const state = randomStateV3(createRandom(`${seed}-${k}`), { now: NOW, maxDecks: 3, maxNotes: 400 });
    if (state.cards.length >= 300 && state.decks.length >= 2) return state;
  }
}

/** A rating of the card at position `i`: a new object with a new due time, ease and lapse count. */
function rateAt(state: DataStateV3, i: number, rnd: Random): DataStateV3 {
  return {
    ...state,
    cards: state.cards.map((c, k) =>
      k === i
        ? { ...c, reps: c.reps + 1, due: NOW + rnd.int(-3, 40) * DAY, ease: rnd.pick([1.3, 1.7, 2.5, 2.9]), lapses: rnd.int(0, 3) }
        : c,
    ),
  };
}

/** A part of the library (in library order) that is cut from the kept order: the cards of its first deck. */
function bigPart(state: DataStateV3): Card[] {
  const part = state.cards.filter((c) => c.deckId === state.decks[0].id);
  return part.length >= state.cards.length * LIBRARY_ORDER_MIN_SHARE ? part : state.cards.filter((_, i) => i % 3 !== 0);
}

/** The cards with a `due` that counts every read (to see which cards a sort looks at). */
function countingDue(cards: readonly Card[]): { cards: Card[]; reads: () => number } {
  let reads = 0;
  const out = cards.map((card) => {
    const due = card.due;
    const copy = { ...card };
    Object.defineProperty(copy, 'due', {
      enumerable: true,
      get: () => {
        reads += 1;
        return due;
      },
    });
    return copy;
  });
  return { cards: out, reads: () => reads };
}

describe('unit P1 review 2 — after a rating the kept order is REPAIRED (only the rated cards move), never sorted again for a smaller list', () => {
  const SCHEDULE_SORTS: SortSpec[] = [{ by: 'due' }, { by: 'due', dir: 'desc' }, { by: 'hardest' }, { by: 'hardest', dir: 'desc' }, { by: 'source' }, { by: 'az' }];

  it('40 ratings one after another, with an undo, an edit, a damaged due and a reset of many cards: the old order every time', () => {
    const rnd = createRandom('p1r2-ratings');
    let state = biggerLibrary('p1r2-ratings');
    const check = (label: string) => {
      const ctx = matchCtxOf(state, NOW);
      const part = bigPart(state);
      for (const sort of SCHEDULE_SORTS) {
        expect([label, sort, ids(sortScopeCards(part, sort, state, ctx))]).toEqual([label, sort, ids(oldSort(part, sort, state))]);
        expect([label, sort, ids(sortScopeCards(state.cards, sort, state, ctx))]).toEqual([label, sort, ids(oldSort(state.cards, sort, state))]);
      }
    };
    check('start');
    const history: DataStateV3[] = [];
    for (let step = 0; step < 40; step++) {
      history.push(state);
      if (step === 12) state = history[history.length - 2]; // an undo: the cards array from before comes back
      else if (step === 20) state = { ...state, notes: state.notes.map((n, i) => (i === 0 ? { ...n, fields: ['Zzz', ...n.fields.slice(1)] } : n)) };
      else if (step === 25) state = { ...state, cards: state.cards.map((c, i) => (i === 7 ? { ...c, due: Number.NaN } : c)) };
      else if (step === 26) state = rateAt(state, 7, rnd); // the damaged card gets a real due again
      else if (step === 30) {
        // A reset of a third of the cards: far more than 1/20 changed.
        state = { ...state, cards: state.cards.map((c, i) => (i % 3 === 0 ? { ...c, due: NOW, ease: 2.5, lapses: 0 } : c)) };
      } else state = rateAt(state, rnd.int(0, state.cards.length - 1), rnd);
      check(`step ${step}`);
    }
    expect(LIBRARY_ORDER_REPAIR_MAX_SHARE).toBeGreaterThan(0);
    expect(LIBRARY_ORDER_REPAIR_MAX_SHARE).toBeLessThanOrEqual(LIBRARY_ORDER_MIN_SHARE);
  });

  it('a rating under "Due date": the list reads the due time of a few cards only — no sort of the library, no sort of the list', () => {
    const base = biggerLibrary('p1r2-reads');
    const counting = countingDue(base.cards);
    const state: DataStateV3 = { ...base, cards: counting.cards };
    const n = state.cards.length;
    // The library's order for "Due date" exists (the whole list made it).
    expect(ids(sortScopeCards(state.cards, { by: 'due' }, state, matchCtxOf(state, NOW)))).toEqual(ids(oldSort(state.cards, { by: 'due' }, state)));
    // One rating: a new cards array in which one card changed.
    const rated = rateAt(state, 5, createRandom('p1r2-reads-rate'));
    const ctx = matchCtxOf(rated, NOW);
    const part = bigPart(rated);
    cardLookupOf(rated.cards); // made by every selector anyway; not part of the sort
    const before = counting.reads();
    const rows = sortScopeCards(part, { by: 'due' }, rated, ctx);
    const reads = counting.reads() - before;
    // A binary search for the rated card: about log₂(n) comparisons, each reads one kept card.
    expect(reads).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(n)) + 4);
    // The control: a sort of the list alone reads the due time of every card of it, several times.
    const sortBefore = counting.reads();
    const old = oldSort(part, { by: 'due' }, rated);
    expect(counting.reads() - sortBefore).toBeGreaterThan(part.length);
    expect(ids(rows)).toEqual(ids(old));
    // The order is ready for the next list: nothing left for the idle step.
    expect(warmLibraryOrder(rated, { by: 'due' }, ctx)).toBe(false);
  });

  it('a list without a usable kept order is sorted on its own; warmLibraryOrder then makes the order once (idle), and the next list is cut from it', () => {
    const state = biggerLibrary('p1r2-warm');
    const ctx = matchCtxOf(state, NOW);
    const part = bigPart(state);
    for (const sort of [{ by: 'due' }, { by: 'az', dir: 'desc' }, { by: 'field', field: 'level' }] as SortSpec[]) {
      // A part of the library: the right order, but NO library order is made on the learner's path …
      expect(ids(sortScopeCards(part, sort, state, ctx))).toEqual(ids(oldSort(part, sort, state)));
      // … so the idle step has work: it makes the order (true), then there is nothing left (false).
      expect(warmLibraryOrder(state, sort, ctx)).toBe(true);
      expect(warmLibraryOrder(state, sort, ctx)).toBe(false);
      expect(ids(sortScopeCards(part, sort, state, ctx))).toEqual(ids(oldSort(part, sort, state)));
      // After a rating: the idle step repairs it (true), once.
      const rated = rateAt(state, 3, createRandom(`p1r2-warm-${sort.by}`));
      const rctx = matchCtxOf(rated, NOW);
      expect(warmLibraryOrder(rated, sort, rctx)).toBe(true);
      expect(warmLibraryOrder(rated, sort, rctx)).toBe(false);
      expect(ids(sortScopeCards(bigPart(rated), sort, rated, rctx))).toEqual(ids(oldSort(bigPart(rated), sort, rated)));
    }
    // The whole library makes its order on the path (the same work as sorting it): nothing left for the idle step.
    const fresh = { ...state, decks: state.decks.map((d) => ({ ...d })) };
    const fctx = matchCtxOf(fresh, NOW);
    expect(ids(sortScopeCards(fresh.cards, { by: 'hardest' }, fresh, fctx))).toEqual(ids(oldSort(fresh.cards, { by: 'hardest' }, fresh)));
    expect(warmLibraryOrder(fresh, { by: 'hardest' }, fctx)).toBe(false);
    // An empty library: an empty order, made once.
    const empty = stateOfV3({ decks: [], groups: [] });
    const ectx = matchCtxOf(empty, NOW);
    expect(warmLibraryOrder(empty, { by: 'due' }, ectx)).toBe(true);
    expect(warmLibraryOrder(empty, { by: 'due' }, ectx)).toBe(false);
    expect(sortScopeCards([], { by: 'due' }, empty, ectx)).toEqual([]);
  });

  it('a change that gives a card the id of another card (damaged data): no repair, the comparator sort itself decides — the old order, A–Z too', () => {
    const state = biggerLibrary('p1r2-dup');
    const ctx = matchCtxOf(state, NOW);
    for (const sort of SCHEDULE_SORTS) sortScopeCards(state.cards, sort, state, ctx); // the kept orders
    const dup = { ...state, cards: state.cards.map((c, i) => (i === 4 ? { ...c, id: state.cards[9].id, due: NOW + 3 * DAY } : c)) };
    const dctx = matchCtxOf(dup, NOW);
    for (const sort of SCHEDULE_SORTS) {
      expect(ids(sortScopeCards(bigPart(dup), sort, dup, dctx))).toEqual(ids(oldSort(bigPart(dup), sort, dup)));
      expect(ids(sortScopeCards(dup.cards, sort, dup, dctx))).toEqual(ids(oldSort(dup.cards, sort, dup)));
    }
  });

  it('final pass — "Due date" after "I know it" and "Learn" (only knownAt changes) and a reps-only change: the kept order is repaired, the old order every time', () => {
    // "Due date" puts a card with no review date (New, Not started, Known) after the others. A
    // change of ONLY knownAt or ONLY reps moves a card between the two groups with its due
    // unchanged: the kept order must see it (schedule.ts DUE_FIELDS), or the card stays in its
    // old place.
    for (const sort of [{ by: 'due' }, { by: 'due', dir: 'desc' }] as SortSpec[]) {
      let state = biggerLibrary('final-due-known');
      // The whole library makes the kept order.
      expect(ids(sortScopeCards(state.cards, sort, state, matchCtxOf(state, NOW)))).toEqual(ids(oldSort(state.cards, sort, state)));
      // A studied card that is not Known: the soonest one (so the move is far, also for 'desc').
      const studied = state.cards
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => c.reps > 0 && c.knownAt == null)
        .sort((a, b) => a.c.due - b.c.due)[0];
      expect(studied).toBeDefined();
      const fresh = state.cards.findIndex((c) => c.reps === 0 && c.knownAt == null);
      expect(fresh).toBeGreaterThanOrEqual(0);
      const steps: [string, number, (c: Card) => Card][] = [
        ['I know it', studied.i, (c) => ({ ...c, knownAt: NOW })],
        ['Learn', studied.i, (c) => ({ ...c, knownAt: null })],
        // Not a real rating (a rating also moves the due time): it pins that `reps` is read too.
        ['reps only', fresh, (c) => ({ ...c, reps: 1, stepIndex: 0 })],
      ];
      for (const [label, at, edit] of steps) {
        const before = state;
        state = { ...state, cards: state.cards.map((c, k) => (k === at ? edit(c) : c)) };
        const ctx = matchCtxOf(state, NOW);
        // The card really changes its place (else this step would test nothing).
        expect([label, sort, ids(oldSort(state.cards, sort, state))]).not.toEqual([label, sort, ids(oldSort(before.cards, sort, before))]);
        expect([label, sort, ids(sortScopeCards(state.cards, sort, state, ctx))]).toEqual([label, sort, ids(oldSort(state.cards, sort, state))]);
        const part = bigPart(state);
        expect([label, sort, ids(sortScopeCards(part, sort, state, ctx))]).toEqual([label, sort, ids(oldSort(part, sort, state))]);
        // The kept order is the one of these cards now: nothing left for the idle step.
        expect([label, sort, warmLibraryOrder(state, sort, ctx)]).toEqual([label, sort, false]);
      }
    }
  });
});

describe('unit P1 — warmLibraryCaches: the first search, A–Z and count find their values ready', () => {
  /** A copy of the notes whose `fields` count every read. */
  function countingNotes(notes: readonly Note[]): { notes: Note[]; reads: () => number } {
    let reads = 0;
    const out = notes.map((note) => {
      const fields = note.fields;
      const copy = { ...note } as Note;
      Object.defineProperty(copy, 'fields', {
        enumerable: true,
        get: () => {
          reads += 1;
          return fields;
        },
      });
      return copy;
    });
    return { notes: out, reads: () => reads };
  }

  it('in slices (it stops when asked, every 64 cards), then the search, A–Z, the headline rank and the counts read no note again', () => {
    // The first seeded library with more than 130 cards.
    let base = randomStateV3(createRandom('p1-warm-0'), { now: NOW, maxDecks: 3, maxNotes: 200 });
    for (let seed = 1; base.cards.length <= 130; seed++) {
      base = randomStateV3(createRandom(`p1-warm-${seed}`), { now: NOW, maxDecks: 3, maxNotes: 200 });
    }
    const counting = countingNotes(base.notes);
    const state: DataStateV3 = { ...base, notes: counting.notes };
    const ctx = matchCtxOf(state, NOW); // the index reads the notes once (which fields are filter groups)
    expect(state.cards.length).toBeGreaterThan(130);
    // Stopped at the first chance: 64 cards, then 128 …, then done (warmLibrarySteps: the cards and the labels).
    expect(warmLibraryCaches(state.cards, ctx, 0, () => true)).toBe(64);
    expect(warmLibraryCaches(state.cards, ctx, 64, () => true)).toBe(128);
    let at = 128;
    while (at < warmLibrarySteps(state.cards)) at = warmLibraryCaches(state.cards, ctx, at, () => false);
    expect(at).toBe(warmLibrarySteps(state.cards));
    const warmed = counting.reads();
    // The first uses: a text search, A–Z (all cards and a part), the headline rank, the FacetSheet counts.
    scopePool(state, { text: 'a' }, ctx, 'browse');
    sortScopeCards(state.cards, { by: 'az' }, state, ctx);
    sortScopeCards(state.cards.slice(0, 5), { by: 'az', dir: 'desc' }, state, ctx);
    for (const card of state.cards) faceHeadline(card, ctx.index, ctx.decks);
    deriveFacets(state.cards, {}, { text: 'e' }, ctx);
    expect(counting.reads()).toBe(warmed);
    // A second warm-up only finds ready values.
    expect(warmLibraryCaches(state.cards, ctx, 0, () => false)).toBe(warmLibrarySteps(state.cards));
    expect(counting.reads()).toBe(warmed);
    // The control: without the warm-up, the first search DOES read the notes.
    const cold = countingNotes(base.notes);
    const coldState: DataStateV3 = { ...base, notes: cold.notes };
    const coldCtx = matchCtxOf(coldState, NOW);
    const beforeSearch = cold.reads();
    scopePool(coldState, { text: 'a' }, coldCtx, 'browse');
    expect(cold.reads()).toBeGreaterThan(beforeSearch);
  });

  it('unit P2: stopped right after the search-text pass, EVERY note has its search text — a search then reads no note; the other parts come later', () => {
    // The first seeded library with more than 130 cards (several slices per pass).
    let base = randomStateV3(createRandom('p2-search-first-0'), { now: NOW, maxDecks: 3, maxNotes: 200 });
    for (let seed = 1; base.cards.length <= 130; seed++) {
      base = randomStateV3(createRandom(`p2-search-first-${seed}`), { now: NOW, maxDecks: 3, maxNotes: 200 });
    }
    const counting = countingNotes(base.notes);
    const state: DataStateV3 = { ...base, notes: counting.notes };
    const ctx = matchCtxOf(state, NOW);
    const searchDone = warmDoneAt(state.cards, 'searchText');
    expect(searchDone).toBe(state.cards.length);
    // Slices that stop at every chance, until the search-text part is done: they stop EXACTLY at its end.
    let at = 0;
    let calls = 0;
    while (at < searchDone) {
      const next = warmLibraryCaches(state.cards, ctx, at, () => true);
      expect(next).toBeGreaterThan(at);
      expect(next - at).toBeLessThanOrEqual(64);
      at = next;
      calls += 1;
    }
    expect(at).toBe(searchDone);
    expect(calls).toBe(Math.ceil(state.cards.length / 64));
    const afterSearchPass = counting.reads();
    // Every note of a card has its search text: two searches read no note's fields.
    const noteIds = new Set(state.cards.map((c) => c.noteId));
    expect(noteIds.size).toBeGreaterThan(50);
    expect(scopePool(state, { text: 'a' }, ctx, 'browse').length).toBeGreaterThan(0);
    scopePool(state, { text: 'zz-nothing' }, ctx, 'browse');
    expect(counting.reads()).toBe(afterSearchPass);
    // The control, and the order: the headlines (the NEXT part) are not made yet — a headline still reads its note.
    faceHeadline(state.cards[state.cards.length - 1], ctx.index, ctx.decks);
    expect(counting.reads()).toBeGreaterThan(afterSearchPass);
    // The rest of the warm-up goes on from there and ends at the last step.
    while (at < warmLibrarySteps(state.cards)) at = warmLibraryCaches(state.cards, ctx, at, () => false);
    expect(at).toBe(warmLibrarySteps(state.cards));
  });

  it('unit P2: the parts run in the order of WARM_PASSES, each done for every card before the next one starts', () => {
    expect(WARM_PASSES).toEqual(['searchText', 'headlines', 'facets', 'noteLabels']);
    const state = randomLibrary(createRandom('p2-parts'));
    const n = state.cards.length;
    expect(n).toBeGreaterThan(0);
    expect(WARM_PASSES.map((part) => warmDoneAt(state.cards, part))).toEqual([n, 2 * n, 3 * n, 4 * n]);
    expect(warmDoneAt(state.cards, 'labels')).toBe(warmLibrarySteps(state.cards));
    expect(warmLibrarySteps(state.cards)).toBe(4 * n + 1);
    // A call with `stop()` always no, started in the middle of a part, finishes everything.
    const ctx = matchCtxOf(state, NOW);
    expect(warmLibraryCaches(state.cards, ctx, n + Math.floor(n / 2), () => false)).toBe(warmLibrarySteps(state.cards));
    // A call that did cards asks stop() before a new part: it stops at the part's start.
    const fresh = { ...state, notes: state.notes.map((note) => ({ ...note })) };
    const fctx = matchCtxOf(fresh, NOW);
    let asked = 0;
    const end = warmLibraryCaches(fresh.cards, fctx, 0, () => {
      asked += 1;
      return asked > Math.ceil(n / 64) - 1;
    });
    expect(end).toBe(n);
  });

  it('nothing to do for an empty library; a bad start position is clamped', () => {
    const empty = stateOfV3({ decks: [], groups: [] });
    // Only the labels' step, and it is done at once (unit P1 review: the end is warmLibrarySteps, not the length).
    expect(warmLibrarySteps([])).toBe(1);
    expect(warmLibraryCaches([], matchCtxOf(empty, NOW), 0, () => true)).toBe(warmLibrarySteps([]));
    const state = randomLibrary(createRandom('p1-warm-clamp'));
    expect(warmLibraryCaches(state.cards, matchCtxOf(state, NOW), -3, () => false)).toBe(warmLibrarySteps(state.cards));
    // Called again when done: still done, nothing read.
    expect(warmLibraryCaches(state.cards, matchCtxOf(state, NOW), warmLibrarySteps(state.cards), () => true)).toBe(
      warmLibrarySteps(state.cards),
    );
  });
});

describe('unit P1 review — the warm-up makes the labels in slices too (no long block at its end)', () => {
  /*
   * The review measured the last call of the warm-up at 14–25 ms in node
   * (45–85 ms on the phone): the label lookups of the index (field values,
   * sections, tags) were made in one go, over every note, after the cards.
   * Now a call stopped at its first chance reads at most 64 notes, also in
   * the labels' step.
   */

  /** What was read: the notes whose fields, section or tags were read, and the notes read from the notes ARRAY. */
  interface Reads {
    touched: Set<Id>;
    positions: number;
  }

  /** Copies of the notes whose fields, section and tags write into `reads` which note was read. */
  function watchNotes(notes: readonly Note[], reads: Reads): Note[] {
    return notes.map((note) => {
      const copy = { ...note } as Note;
      for (const key of ['fields', 'section', 'tags'] as const) {
        const value = note[key];
        Object.defineProperty(copy, key, {
          enumerable: true,
          get: () => {
            reads.touched.add(note.id);
            return value;
          },
        });
      }
      return copy;
    });
  }

  /**
   * The notes as an array that counts in `reads` every note read from it by
   * position. The index's label passes read the notes array; the card steps
   * find a note by its id (noteById), so they do not count here.
   */
  function countingArray(notes: Note[], reads: Reads): Note[] {
    return new Proxy(notes, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads.positions += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
  }

  /** The first seeded library with more than 130 cards and 130 notes (several slices per label pass). */
  function bigEnough(): DataStateV3 {
    for (let seed = 0; ; seed++) {
      const s = randomStateV3(createRandom(`p1-warm-labels-${seed}`), { now: NOW, maxDecks: 3, maxNotes: 200 });
      if (s.cards.length > 130 && s.notes.length > 130) return s;
    }
  }

  /**
   * The whole warm-up with `stop()` always yes. Every call may read at most
   * 64 notes. Returns how many calls the labels' step took, and every note
   * read during the warm-up.
   */
  function warmStoppedEachTime(state: DataStateV3, reads: Reads): { labelCalls: number; read: Set<Id> } {
    const ctx = matchCtxOf(state, NOW); // building the index reads the notes (which fields are filter groups): not counted
    const end = warmLibrarySteps(state.cards);
    const read = new Set<Id>();
    let at = 0;
    let labelCalls = 0;
    for (let calls = 0; at < end; calls++) {
      expect(calls).toBeLessThan(1000); // never stuck
      reads.touched.clear();
      reads.positions = 0;
      const from = at;
      at = warmLibraryCaches(state.cards, ctx, at, () => true);
      // About 64 notes' work at most per call, the label passes included.
      expect(reads.touched.size).toBeLessThanOrEqual(64);
      expect(reads.positions).toBeLessThanOrEqual(64);
      for (const id of reads.touched) read.add(id);
      // Unit P2: the cards have one pass per part (WARM_PASSES), so the labels' step is the LAST step, not cards.length.
      if (from >= warmDoneAt(state.cards, 'noteLabels')) labelCalls += 1;
      else expect(at).toBeGreaterThan(from);
    }
    expect(at).toBe(end);
    return { labelCalls, read };
  }

  it('stopped at every chance: at most 64 notes read per call, the labels as well; the labels are the ones made in one go', () => {
    const base = bigEnough();
    const reads: Reads = { touched: new Set(), positions: 0 };
    const state: DataStateV3 = { ...base, notes: countingArray(watchNotes(base.notes, reads), reads) };
    const { labelCalls } = warmStoppedEachTime(state, reads);
    // The labels' step: the three passes over the notes, 64 notes per call.
    expect(labelCalls).toBe(Math.ceil((3 * base.notes.length) / 64));
    // Every label equals the label of an index that made them in one go (the plain notes).
    const index = matchCtxOf(state, NOW).index;
    const plain = matchCtxOf(base, NOW).index;
    reads.touched.clear();
    reads.positions = 0;
    let labels = 0;
    for (const note of base.notes) {
      for (const [key, values] of plain.facetValues(note)) {
        for (const v of values) {
          expect(index.valueLabel(key, v)).toBe(plain.valueLabel(key, v));
          labels += 1;
        }
      }
      for (const p of pathPrefixes(plain.sectionPath(note))) {
        expect(index.sectionLabel(p)).toBe(plain.sectionLabel(p));
        labels += 1;
      }
      for (const t of plain.noteTags(note)) {
        for (const p of pathPrefixes(t)) {
          expect(index.tagLabel(p)).toBe(plain.tagLabel(p));
          labels += 1;
        }
      }
    }
    expect(labels).toBeGreaterThan(100);
    // Every label was ready: no note was read again.
    expect(reads.positions).toBe(0);
    expect(reads.touched.size).toBe(0);
  });

  it('after an edit (a new index over the same notes but one): sliced again, and only the edited note is read', () => {
    const base = bigEnough();
    const reads: Reads = { touched: new Set(), positions: 0 };
    const watched = watchNotes(base.notes, reads);
    warmStoppedEachTime({ ...base, notes: countingArray(watched, reads) }, reads);
    // The edit: one note is a new object (the store never edits in place), in a new notes array → a new index.
    const editedId = base.notes[3].id;
    const [edited] = watchNotes([{ ...base.notes[3], fields: [...base.notes[3].fields] }], reads);
    const after: DataStateV3 = { ...base, notes: countingArray(watched.map((note, i) => (i === 3 ? edited : note)), reads) };
    const { labelCalls, read } = warmStoppedEachTime(after, reads);
    // The new index makes its label lookups again, in slices; the other notes kept their per-note values.
    expect(labelCalls).toBe(Math.ceil((3 * base.notes.length) / 64));
    expect([...read]).toEqual([editedId]);
  });
});

/* ================================================================== unit P4: the note groups from lookups, Deck order as a copy */

/*
 * The release re-measure (16,260 cards): "Deck order" with a Level chip took
 * 36–54 ms. The time was in the FILTER — the Level, Section and Card type
 * tests read each card's note — not in the sort. scopePool now answers
 * these three groups from note lookups (scope.ts warmNoteSets), one Set
 * lookup per card. These tests pin that the result is EXACTLY the query
 * test's (query.ts compileQuery), on random libraries with real field
 * groups, odd section paths and damaged data; that the lookups are made in
 * slices and then read no note; and the other P4 paths (browsePool, the
 * in-order Deck order, warmLibraryOrderOf, warmLibraryCaches `until`).
 */

const P4_LEVELS = ['A1', 'A2', 'B1', 'B2', 'b1', ''];
const P4_TOPICS = ['food', 'travel', 'food, travel', 'work', ''];
const P4_ODD = ['x', 'y', ''];
/** Section paths as stored on notes, odd ones too (an empty part, ':::' and a leading '::'). */
const P4_SECTIONS = ['', 'Vocabulary', 'Vocabulary::B1', 'Vocabulary::B1::Extra', 'Verbs::B1', 'a:::b', 'a:', '::lead', 'Vocabulary::'];
/** Section paths of queries (folded, as sanitizeQuery makes them), also ones no note has. */
const P4_QUERY_PATHS = ['', 'vocabulary', 'vocabulary::b1', 'verbs', 'verbs::b1', 'a', 'a:', '::lead', 'lead', 'nothing'];

/** A card type with a Level group, a multi-value Topics group and a field called "constructor" (user data). */
function p4Type(id: string, topics: boolean): NoteType {
  const fields: NoteType['fields'] = [
    { name: 'Word', role: 'term', facet: 'off' },
    { name: 'Meaning', role: 'meaning', facet: 'off' },
    { name: 'Level', role: 'badge', facet: 'on' },
    { name: 'constructor', role: 'detail', facet: 'on' },
  ];
  if (topics) fields.push({ name: 'Topics', role: 'detail', facet: 'on', multiSep: ',' });
  return {
    id,
    name: `Type ${id}`,
    kind: 'standard',
    fields,
    templates: [
      { ord: 0, name: 'Forward', prompt: [0], answer: [1] },
      { ord: 1, name: 'Reverse', prompt: [1], answer: [0] },
    ],
    sortField: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/**
 * A random library for the note groups: two typed card types and Basic,
 * 2–3 decks (one may be paused), odd section paths, and damaged data — a
 * card whose note is gone, two notes with one id (the index keeps the
 * last), a note of a card type that does not exist.
 */
function p4Library(rnd: Random): DataStateV3 {
  const types = [p4Type('nt-p4-a', true), p4Type('nt-p4-b', false)];
  const decks = [
    makeDeckV3({ id: 'd1', name: 'One', order: 0 }),
    makeDeckV3({ id: 'd2', name: 'Two', order: 1, active: rnd.bool(0.7) }),
    ...(rnd.bool(0.5) ? [makeDeckV3({ id: 'd3', name: 'Three', order: 2 })] : []),
  ];
  const groups: { note: Note; cards: Card[] }[] = [];
  const count = rnd.int(4, 60);
  for (let i = 0; i < count; i++) {
    const roll = rnd.int(0, 9);
    const typeId = roll < 5 ? 'nt-p4-a' : roll < 8 ? 'nt-p4-b' : BUILTIN_TYPE_IDS.basic;
    const fields =
      typeId === BUILTIN_TYPE_IDS.basic
        ? [`front ${i}`, `back ${i}`, '', '']
        : [`word ${i}`, `meaning ${i}`, rnd.pick(P4_LEVELS), rnd.pick(P4_ODD), ...(typeId === 'nt-p4-a' ? [rnd.pick(P4_TOPICS)] : [])];
    groups.push(
      noteWithCards(
        {
          deckId: rnd.pick(decks).id,
          typeId,
          fields,
          note: { id: `p4n-${i}`, section: rnd.pick(P4_SECTIONS) },
          card: (ord) => ({ id: `p4c-${i}-${ord}`, ...lifeValues(rnd.pick(LIFE_KEYS), NOW), fav: rnd.bool(0.2) }),
        },
        types,
      ),
    );
  }
  const base = stateOfV3({ decks, groups, types });
  const notes = [...base.notes];
  const cards = [...base.cards];
  if (notes.length > 2 && rnd.bool(0.5)) {
    // Two notes with one id: the index keeps the LAST one (other values), so its cards follow that one.
    notes.push({ ...notes[1], fields: ['twin', 'twin', rnd.pick(P4_LEVELS), 'x', 'travel'], section: rnd.pick(P4_SECTIONS) });
  }
  if (rnd.bool(0.4)) cards.push({ ...cards[0], id: 'p4c-no-note', noteId: 'p4n-gone' });
  if (rnd.bool(0.3)) {
    notes.push({ ...notes[0], id: 'p4n-odd-type', typeId: 'nt-gone' });
    cards.push({ ...cards[0], id: 'p4c-odd-type', noteId: 'p4n-odd-type' });
  }
  return {
    ...base,
    notes,
    cards,
    lists: [
      { id: 'p4-list', name: 'B1 words', icon: '🔖', query: { fields: { level: ['b1'] }, sections: [{ deckId: 'd1', path: 'vocabulary' }] }, createdAt: NOW, updatedAt: NOW },
    ],
  };
}

/** A random query with the note groups (Level, Topics, "constructor", sections, card types) and some others. */
function p4Query(rnd: Random): Query {
  const fields = new Map<string, string[]>();
  if (rnd.bool(0.6)) fields.set('level', rnd.sample(['a1', 'a2', 'b1', 'b2', 'c2'], rnd.int(1, 2)));
  if (rnd.bool(0.25)) fields.set('topics', rnd.sample(['food', 'travel', 'work', 'none'], rnd.int(1, 2)));
  if (rnd.bool(0.15)) fields.set('constructor', [rnd.pick(['x', 'y', 'z'])]);
  if (rnd.bool(0.05)) fields.set('__proto__', ['x']);
  if (rnd.bool(0.05)) fields.set('meaning', ['meaning 1']); // not a filter group: matches nothing
  const q: Query = {};
  if (fields.size > 0) q.fields = fieldRecord(fields);
  if (rnd.bool(0.4)) {
    q.sections = Array.from({ length: rnd.int(1, 2) }, () => ({ deckId: rnd.pick(['d1', 'd2', 'd3', 'gone']), path: rnd.pick(P4_QUERY_PATHS) }));
  }
  if (rnd.bool(0.25)) q.noteTypes = rnd.sample(['nt-p4-a', 'nt-p4-b', BUILTIN_TYPE_IDS.basic, 'nt-gone', 'nt-none'], rnd.int(1, 2));
  if (rnd.bool(0.3)) q.decks = [rnd.pick(['d1', 'd2', 'd3'])];
  if (rnd.bool(0.2)) q.life = rnd.sample(LIFE_KEYS, rnd.int(1, 3));
  if (rnd.bool(0.15)) q.text = rnd.pick(['word', 'meaning 1', 'twin', 'zzz']);
  if (rnd.bool(0.1)) q.flags = ['fav'];
  if (rnd.bool(0.1)) q.list = rnd.pick(['p4-list', 'builtin:favorites']);
  return q;
}

/** The pool as the query test makes it (the code of scopePool before unit P4). */
function queryTestPool(state: DataStateV3, q: Query, ctx: MatchCtx, purpose: 'browse' | 'study'): Card[] {
  const match = compileQuery(q, ctx);
  if (purpose === 'browse') return state.cards.filter((card) => match(card));
  const sctx = scheduleCtxOf(state, ctx);
  const named = explicitDecks(q, ctx);
  return state.cards.filter((card) => match(card) && studyEligible(card, sctx, named));
}

/** Where each card of `pool` is in the state (the same OBJECTS, in state order, is the promise). */
const positionsIn = (state: DataStateV3, pool: readonly Card[]) => pool.map((card) => state.cards.indexOf(card));

describe('unit P4 — scopePool answers Level, Section and Card type chips from note lookups: EXACTLY the query test', () => {
  it('300 random libraries × 8 queries × browse / study: the same card objects in the same order; lookups made in slices or at once', () => {
    let narrowed = 0;
    let fieldHits = 0;
    let sectionHits = 0;
    for (let i = 0; i < 300; i++) {
      const rnd = createRandom(`p4-pool-${i}`);
      const state = p4Library(rnd.fork('state'));
      const ctx = matchCtxOf(state, NOW);
      // Half the libraries make the lookups in slices first (stop at every chance); the others at first use.
      const warmedFirst = rnd.bool(0.5);
      if (warmedFirst) {
        let calls = 0;
        while (!warmNoteSets(ctx.index, () => true)) calls += 1;
        expect(calls).toBeLessThanOrEqual(Math.ceil(ctx.index.noteById.size / 64));
      }
      const queries = Array.from({ length: 8 }, (_, k) => p4Query(rnd.fork(`q${k}`)));
      for (const q of queries) {
        for (const purpose of ['browse', 'study'] as const) {
          const expected = queryTestPool(state, q, ctx, purpose);
          const got = scopePool(state, q, ctx, purpose);
          expect({ i, q, purpose, at: positionsIn(state, got) }).toEqual({ i, q, purpose, at: positionsIn(state, expected) });
          if (purpose === 'browse' && expected.length > 0 && expected.length < state.cards.length) narrowed += 1;
          if (purpose === 'browse' && q.fields && expected.length > 0) fieldHits += 1;
          if (purpose === 'browse' && q.sections && expected.length > 0) sectionHits += 1;
        }
      }
      // Unit P4 review: a first use makes only the PARTS its chips need; the
      // warm-up's pass alone makes them all. After the parts, that pass walks
      // the same notes again (the same sets): every result is still the query test's.
      expect(noteSetsReady(ctx.index)).toBe(warmedFirst);
      if (!warmedFirst) {
        while (!warmNoteSets(ctx.index, () => true));
        for (const q of queries) {
          expect({ i, q, at: positionsIn(state, scopePool(state, q, ctx, 'browse')) }).toEqual({
            i,
            q,
            at: positionsIn(state, queryTestPool(state, q, ctx, 'browse')),
          });
        }
      }
      expect(noteSetsReady(ctx.index)).toBe(true);
    }
    // The random data really exercised the groups.
    expect(narrowed).toBeGreaterThan(600);
    expect(fieldHits).toBeGreaterThan(300);
    expect(sectionHits).toBeGreaterThan(80);
  });

  it('the counts and sessions built on the pool agree too: readyFor, the session, practice and ahead', () => {
    for (let i = 0; i < 60; i++) {
      const rnd = createRandom(`p4-counts-${i}`);
      const state = p4Library(rnd.fork('state'));
      const ctx = matchCtxOf(state, NOW);
      const q = p4Query(rnd.fork('q'));
      expect(readyFor(state, q, ctx).total).toBe(buildSessionQueue({ kind: 'scheduled', q }, state, ctx).length);
      const study = queryTestPool(state, q, ctx, 'study');
      expect(ids(buildSessionQueue({ kind: 'ahead', q }, state, ctx)).every((id) => study.some((c) => c.id === id))).toBe(true);
    }
  });

  it('in slices of 64 notes (stop() asked after each 64); then a Level, Section or Card type chip reads no note', () => {
    let base = p4Library(createRandom('p4-slices-0'));
    for (let seed = 1; base.notes.length < 130; seed++) {
      // Glue libraries together until there are enough notes for 3 slices.
      const more = p4Library(createRandom(`p4-slices-${seed}`));
      const tag = (id: string) => `s${seed}-${id}`;
      base = {
        ...base,
        notes: [...base.notes, ...more.notes.map((n) => ({ ...n, id: tag(n.id) }))],
        cards: [...base.cards, ...more.cards.map((c) => ({ ...c, id: tag(c.id), noteId: tag(c.noteId) }))],
      };
    }
    // Every read of a note's fields or section: how many, and which notes (a twin id counts once).
    let reads = 0;
    const touched = new Set<Note>();
    const notes = base.notes.map((note) => {
      const copy = { ...note } as Note;
      for (const key of ['fields', 'section'] as const) {
        const value = note[key];
        Object.defineProperty(copy, key, {
          enumerable: true,
          get: () => {
            reads += 1;
            touched.add(copy);
            return value;
          },
        });
      }
      return copy;
    });
    const state: DataStateV3 = { ...base, notes };
    const ctx = matchCtxOf(state, NOW); // building the index reads the notes (which fields are groups): not counted
    const size = ctx.index.noteById.size;
    let calls = 0;
    let asked = 0;
    for (;;) {
      touched.clear();
      calls += 1;
      const complete = warmNoteSets(ctx.index, () => {
        asked += 1;
        return true;
      });
      // At most 64 notes per call (their field values and their section).
      expect(touched.size).toBeLessThanOrEqual(64);
      expect(noteSetsReady(ctx.index)).toBe(complete);
      if (complete) break;
    }
    expect(calls).toBeGreaterThanOrEqual(Math.ceil(size / 64));
    expect(calls).toBeLessThanOrEqual(Math.ceil(size / 64) + 1);
    expect(asked).toBe(calls - 1);
    // Done: nothing more to do, and stop() is not asked.
    expect(warmNoteSets(ctx.index, () => true)).toBe(true);
    // The note groups now read no note: every value they need is in the lookups.
    const warmed = reads;
    expect(warmed).toBeGreaterThan(0);
    const queries: Query[] = [
      { fields: { level: ['b1'] } },
      { fields: { level: ['b1', 'a2'], topics: ['food'] }, noteTypes: ['nt-p4-a'] },
      { sections: [{ deckId: 'd1', path: 'vocabulary' }, { deckId: 'd2', path: 'verbs::b1' }] },
      { noteTypes: ['nt-p4-b'], decks: ['d1'] },
    ];
    for (const q of queries) {
      scopePool(state, q, ctx, 'browse');
      scopePool(state, q, ctx, 'study');
    }
    expect(reads).toBe(warmed);
    for (const q of queries) {
      expect(positionsIn(state, scopePool(state, q, ctx, 'browse'))).toEqual(positionsIn(state, queryTestPool(state, q, ctx, 'browse')));
    }
  });

  it('an empty library: the lookups are done at once, every note group matches nothing', () => {
    const empty = stateOfV3({ decks: [], groups: [] });
    const ctx = matchCtxOf(empty, NOW);
    expect(warmNoteSets(ctx.index, () => true)).toBe(true);
    expect(scopePool(empty, { fields: { level: ['b1'] }, noteTypes: ['x'], sections: [{ deckId: 'd', path: '' }] }, ctx, 'browse')).toEqual([]);
  });
});

describe('unit P4 — browsePool: the state’s own cards for "no filter", scopePool otherwise', () => {
  it('no group (also an empty text): the same array; any group: the cards of scopePool', () => {
    const state = randomLibrary(createRandom('p4-browse'));
    const ctx = matchCtxOf(state, NOW);
    expect(browsePool(state, {}, ctx)).toBe(state.cards);
    expect(browsePool(state, { text: '   ', life: [] }, ctx)).toBe(state.cards);
    for (const q of [{ life: ['new'] as LifeKey[] }, { decks: [state.decks[0].id] }, { list: 'gone' }, { text: 'meaning' }]) {
      expect(ids(browsePool(state, q, ctx))).toEqual(ids(scopePool(state, q, ctx, 'browse')));
    }
    const empty = stateOfV3({ decks: [], groups: [] });
    expect(browsePool(empty, {}, matchCtxOf(empty, NOW))).toEqual([]);
  });
});

describe('unit P4 — Deck order when the store is already in that order: a copy, the old rows, never the same array', () => {
  /** A random library whose cards are stored in Deck order (the usual case: import order). */
  function inDeckOrder(seed: string): DataStateV3 {
    const state = randomLibrary(createRandom(seed));
    return { ...state, cards: oldSort(state.cards, { by: 'source' }, state) };
  }

  it('the whole library and every list: the rows of the old comparator sort, in a new array', () => {
    for (let i = 0; i < 60; i++) {
      const rnd = createRandom(`p4-in-order-${i}`);
      const state = inDeckOrder(`p4-in-order-state-${i}`);
      const ctx = matchCtxOf(state, NOW);
      const all = sortScopeCards(state.cards, { by: 'source' }, state, ctx);
      expect(all).not.toBe(state.cards);
      expect(ids(all)).toEqual(ids(state.cards));
      for (const q of [{}, ...Array.from({ length: 4 }, () => randomQuery(rnd, state))]) {
        const pool = scopePool(state, q, ctx, 'browse');
        const rows = sortScopeCards(pool, { by: 'source' }, state, ctx);
        if (pool.length > 0) expect(rows).not.toBe(pool);
        expect(ids(rows)).toEqual(ids(oldSort(pool, { by: 'source' }, state)));
        // Z–A of the same pool is cut from the same kept order: still the old rows.
        expect(ids(sortScopeCards(pool, { by: 'source', dir: 'desc' }, state, ctx))).toEqual(ids(oldSort(pool, { by: 'source', dir: 'desc' }, state)));
      }
    }
  });

  it('after a rating, a moved card (now out of order) and a new deck order: the old rows every time', () => {
    const rnd = createRandom('p4-in-order-changes');
    let state = inDeckOrder('p4-in-order-changes-state');
    const queries = [{}, { life: ['new', 'review'] as LifeKey[] }, { decks: [state.decks[0].id] }];
    expectOldOrder(state, queries, 'in deck order');
    state = rateAt(state, 2, rnd);
    expectOldOrder(state, queries, 'rating');
    state = { ...state, cards: state.cards.map((c, i) => (i === 0 ? { ...c, deckId: state.decks[state.decks.length - 1].id } : c)) };
    expectOldOrder(state, queries, 'moved: out of order');
    state = { ...state, decks: state.decks.map((d, i) => ({ ...d, order: state.decks.length - i })) };
    expectOldOrder(state, queries, 'new deck order');
  });
});

describe('unit P4 — warmLibraryOrderOf: the shared warm-up makes the Deck order a list would make', () => {
  it('made once per data (ready after it), repaired after a rating, and the lists are the old rows', () => {
    const rnd = createRandom('p4-warm-order');
    const state = randomLibrary(rnd.fork('state'));
    const ctx = matchCtxOf(state, NOW);
    const target = { cards: state.cards, index: ctx.index, decks: ctx.decks };
    const DECK: SortSpec = { by: 'source' };
    expect(libraryOrderReady(target, DECK)).toBe(false);
    expect(warmLibraryOrderOf(target, DECK)).toBe(true);
    expect(libraryOrderReady(target, DECK)).toBe(true);
    expect(warmLibraryOrderOf(target, DECK)).toBe(false);
    // The Library's own path uses the same kept order: nothing is made again.
    expect(warmLibraryOrder(state, DECK, ctx)).toBe(false);
    expectOldOrder(state, [{}, { decks: [state.decks[0].id] }], 'warmed');
    // A rating: a new cards array of the same library — the order is repaired for it.
    const rated = rateAt(state, 1, rnd);
    const ratedTarget = { cards: rated.cards, index: ctx.index, decks: ctx.decks };
    expect(libraryOrderReady(ratedTarget, DECK)).toBe(false);
    expect(warmLibraryOrderOf(ratedTarget, DECK)).toBe(true);
    expect(libraryOrderReady(ratedTarget, DECK)).toBe(true);
    // A–Z (its key reads the notes) with only the cards, the index and the decks: the old rows too.
    expect(libraryOrderReady(ratedTarget, { by: 'az' })).toBe(false);
    expect(warmLibraryOrderOf(ratedTarget, { by: 'az' })).toBe(true);
    expect(ids(sortScopeCards(rated.cards, { by: 'az' }, rated, matchCtxOf(rated, NOW)))).toEqual(ids(oldSort(rated.cards, { by: 'az' }, rated)));
    expectOldOrder(rated, [{}, { life: ['review'] as LifeKey[] }], 'rated');
  });
});

describe('unit P4 — warmLibraryCaches `until`: the search box got the focus, the search text NOW', () => {
  it('stops exactly at `until`, with no stop() question; the rest goes on later', () => {
    const state = randomLibrary(createRandom('p4-until'));
    const n = state.cards.length;
    expect(n).toBeGreaterThan(2);
    const fresh = { ...state, notes: state.notes.map((note) => ({ ...note })) };
    const ctx = matchCtxOf(fresh, NOW);
    const end = warmDoneAt(fresh.cards, 'searchText');
    let asked = 0;
    const stop = () => {
      asked += 1;
      return true;
    };
    // In the middle of the first part, then to its end: never asked.
    expect(warmLibraryCaches(fresh.cards, ctx, 0, stop, 2)).toBe(2);
    expect(warmLibraryCaches(fresh.cards, ctx, 2, stop, end)).toBe(end);
    expect(asked).toBe(0);
    // `until` at or before the start: nothing to do.
    expect(warmLibraryCaches(fresh.cards, ctx, end, stop, end)).toBe(end);
    expect(warmLibraryCaches(fresh.cards, ctx, end, stop, 1)).toBe(end);
    expect(asked).toBe(0);
    // Without `until` the rest goes on as before, to the last step.
    expect(warmLibraryCaches(fresh.cards, ctx, end, () => false)).toBe(warmLibrarySteps(fresh.cards));
  });
});

/* ================================================================== unit P4 review */

/*
 * The P4 review: (3) the first Level chip on a new library index made ALL
 * the note lookups inside the Library's timed 'filter' line — now a chip
 * makes only its own PART; (1) the "no filter" list still made a copy of
 * 16,000 cards — sortScopeRows gives the pool itself when it already is in
 * order; (2) the warm-up's Deck order was one big step on a library NOT
 * stored in Deck order — warmDeckOrder makes it a part at a time.
 */

/** A copy of the state whose notes count every read of their fields and of their section (fresh note objects: no cache hit). */
function countingNotes(state: DataStateV3): { state: DataStateV3; fields: () => number; sections: () => number } {
  let fields = 0;
  let sections = 0;
  const notes = state.notes.map((note) => {
    const copy = { ...note } as Note;
    const values = { fields: note.fields, section: note.section };
    Object.defineProperty(copy, 'fields', {
      enumerable: true,
      get: () => {
        fields += 1;
        return values.fields;
      },
    });
    Object.defineProperty(copy, 'section', {
      enumerable: true,
      get: () => {
        sections += 1;
        return values.section;
      },
    });
    return copy;
  });
  return { state: { ...state, notes }, fields: () => fields, sections: () => sections };
}

describe('unit P4 review — a chip makes only the note lookup PART it needs; the parts and the warm-up’s pass agree', () => {
  it('a Level chip on a new index reads no section; a Card type chip reads neither; a Section chip then reads the sections once', () => {
    let base = p4Library(createRandom('p4r-parts-0'));
    for (let seed = 1; base.notes.length < 40; seed++) base = p4Library(createRandom(`p4r-parts-${seed}`));
    const { state, fields, sections } = countingNotes(base);
    const ctx = matchCtxOf(state, NOW); // building the index reads the notes: not counted below
    const at = { fields: fields(), sections: sections() };
    const level: Query = { fields: { level: ['b1', 'a2'] } };
    expect(positionsIn(state, scopePool(state, level, ctx, 'browse'))).toEqual(positionsIn(state, queryTestPool(state, level, ctx, 'browse')));
    expect(sections()).toBe(at.sections);
    // Only the Level part: the warm-up's pass is not done.
    expect(noteSetsReady(ctx.index)).toBe(false);
    const afterLevel = { fields: fields(), sections: sections() };
    // The same part again (Study n, Practice n of the same render): no note read at all.
    scopePool(state, level, ctx, 'study');
    readyFor(state, level, ctx);
    expect({ fields: fields(), sections: sections() }).toEqual(afterLevel);
    // A Card type chip: the card types are on the note itself — no field, no section.
    const typed: Query = { noteTypes: ['nt-p4-b'] };
    expect(positionsIn(state, scopePool(state, typed, ctx, 'browse'))).toEqual(positionsIn(state, queryTestPool(state, typed, ctx, 'browse')));
    expect({ fields: fields(), sections: sections() }).toEqual(afterLevel);
    // A Section chip: each note's section, once (the index keeps the folded path per note).
    const section: Query = { sections: [{ deckId: 'd1', path: 'vocabulary' }] };
    expect(positionsIn(state, scopePool(state, section, ctx, 'browse'))).toEqual(positionsIn(state, queryTestPool(state, section, ctx, 'browse')));
    expect(sections() - afterLevel.sections).toBeLessThanOrEqual(ctx.index.noteById.size);
    expect(sections()).toBeGreaterThan(afterLevel.sections);
    expect(fields()).toBe(afterLevel.fields);
    expect(noteSetsReady(ctx.index)).toBe(false);
  });

  it('100 random libraries: parts made in the MIDDLE of the warm-up’s pass, then the rest of the pass — the query test’s cards every time', () => {
    let middle = 0;
    for (let i = 0; i < 100; i++) {
      const rnd = createRandom(`p4r-mid-${i}`);
      // Libraries glued together (ids kept apart), so the pass needs 2–4 slices of 64 notes.
      let state = p4Library(rnd.fork('state-0'));
      for (let g = 1; state.notes.length < 130; g++) {
        const more = p4Library(rnd.fork(`state-${g}`));
        const tag = (id: string) => `g${g}-${id}`;
        state = {
          ...state,
          notes: [...state.notes, ...more.notes.map((n) => ({ ...n, id: tag(n.id) }))],
          cards: [...state.cards, ...more.cards.map((c) => ({ ...c, id: tag(c.id), noteId: tag(c.noteId) }))],
        };
      }
      const ctx = matchCtxOf(state, NOW);
      // A few slices of the pass (64 notes each), then the chips.
      for (let k = rnd.int(0, 2); k > 0; k--) warmNoteSets(ctx.index, () => true);
      if (!noteSetsReady(ctx.index)) middle += 1;
      const queries = Array.from({ length: 6 }, (_, k) => p4Query(rnd.fork(`q${k}`)));
      const check = (label: string) => {
        for (const q of queries) {
          for (const purpose of ['browse', 'study'] as const) {
            expect({ label, i, q, purpose, at: positionsIn(state, scopePool(state, q, ctx, purpose)) }).toEqual({
              label,
              i,
              q,
              purpose,
              at: positionsIn(state, queryTestPool(state, q, ctx, purpose)),
            });
          }
        }
      };
      check('parts first');
      while (!warmNoteSets(ctx.index, () => rnd.bool(0.5)));
      expect(noteSetsReady(ctx.index)).toBe(true);
      check('after the pass');
    }
    // In every library the pass was not done when its chips came (0, 1 or 2 of its slices made).
    expect(middle).toBe(100);
  });
});

describe('unit P4 review — sortScopeRows: the Library’s rows with NO copy when they already are in order', () => {
  /** A random library whose cards are stored in Deck order (the usual case: import order). */
  function inDeckOrder(seed: string): DataStateV3 {
    const state = randomLibrary(createRandom(seed));
    return { ...state, cards: oldSort(state.cards, { by: 'source' }, state) };
  }

  it('Deck order of a library stored in that order: the pool ITSELF (the state’s own array for "no filter"); every other case a new array', () => {
    for (let i = 0; i < 60; i++) {
      const rnd = createRandom(`p4r-rows-${i}`);
      const state = inDeckOrder(`p4r-rows-state-${i}`);
      const ctx = matchCtxOf(state, NOW);
      expect(sortScopeRows(state.cards, { by: 'source' }, state, ctx)).toBe(state.cards);
      expect(sortScopeRows(browsePool(state, {}, ctx), { by: 'source' }, state, ctx)).toBe(state.cards);
      for (const q of Array.from({ length: 4 }, () => randomQuery(rnd, state))) {
        const pool = browsePool(state, q, ctx);
        const rows = sortScopeRows(pool, { by: 'source' }, state, ctx);
        // A big pool is cut from the kept order (no copy); a small one is sorted on its own (a new array).
        if (pool.length >= state.cards.length * LIBRARY_ORDER_MIN_SHARE) expect(rows).toBe(pool);
        expect(ids(rows)).toEqual(ids(oldSort(pool, { by: 'source' }, state)));
        // sortScopeCards still gives a NEW array of the same cards.
        if (pool.length > 0) expect(sortScopeCards(pool, { by: 'source' }, state, ctx)).not.toBe(pool);
      }
    }
  });

  it('200 random libraries (in order or not) × 5 queries × every sort: exactly sortScopeCards’ rows', () => {
    for (let i = 0; i < 200; i++) {
      const rnd = createRandom(`p4r-rows-eq-${i}`);
      const state = rnd.bool(0.5) ? inDeckOrder(`p4r-rows-eq-state-${i}`) : randomLibrary(rnd.fork('state'));
      const ctx = matchCtxOf(state, NOW);
      for (const q of [{}, ...Array.from({ length: 4 }, () => randomQuery(rnd, state))]) {
        const pool = browsePool(state, q, ctx);
        for (const sort of P1_SORTS) {
          expect([i, q, sort, ids(sortScopeRows(pool, sort, state, ctx))]).toEqual([i, q, sort, ids(oldSort(pool, sort, state))]);
        }
      }
    }
  });
});

describe('unit P4 review — warmDeckOrder: the warm-up’s Deck order a part at a time, the same order a list would make', () => {
  /** A library with many cards (glued random libraries), so the order needs several parts. */
  function bigLibrary(seed: string, minCards: number): DataStateV3 {
    let base = randomLibrary(createRandom(`${seed}-0`));
    for (let k = 1; base.cards.length < minCards; k++) {
      const more = randomLibrary(createRandom(`${seed}-${k}`));
      const tag = (id: string) => `g${k}-${id}`;
      const deckOf = new Map(more.decks.map((d, j) => [d.id, base.decks[j % base.decks.length].id]));
      base = {
        ...base,
        notes: [...base.notes, ...more.notes.map((n) => ({ ...n, id: tag(n.id) }))],
        cards: [...base.cards, ...more.cards.map((c) => ({ ...c, id: tag(c.id), noteId: tag(c.noteId), deckId: deckOf.get(c.deckId) ?? c.deckId }))],
      };
    }
    return base;
  }

  it('in order, out of order (cards moved, decks reordered, shuffled), one id twice: ready at the end, and the rows are the old ones', () => {
    const DECK: SortSpec = { by: 'source' };
    for (let i = 0; i < 40; i++) {
      const rnd = createRandom(`p4r-deck-order-${i}`);
      let state = randomLibrary(rnd.fork('state'));
      const kind = i % 5;
      if (kind === 0) state = { ...state, cards: oldSort(state.cards, DECK, state) };
      if (kind === 1 && state.cards.length > 2) state = { ...state, cards: [...state.cards.slice(2), ...state.cards.slice(0, 2)] };
      if (kind === 2) state = { ...state, decks: state.decks.map((d, j) => ({ ...d, order: state.decks.length - j })) };
      if (kind === 3) state = { ...state, cards: rnd.sample(state.cards, state.cards.length) };
      if (kind === 4 && state.cards.length > 1) state = { ...state, cards: [...state.cards, { ...state.cards[0] }] };
      const ctx = matchCtxOf(state, NOW);
      const target = { cards: state.cards, index: ctx.index, decks: ctx.decks };
      let calls = 1;
      while (!warmDeckOrder(target, () => true)) calls += 1;
      expect(libraryOrderReady(target, DECK)).toBe(true);
      // Ready: nothing to do any more, not even a question.
      expect(warmDeckOrder(target, () => {
        throw new Error('not asked');
      })).toBe(true);
      expect(warmLibraryOrderOf(target, DECK)).toBe(false);
      // Asked after each part: an in-order library needs one or two calls, a mixed one more.
      expect(calls).toBeLessThanOrEqual(2 + Math.ceil((state.cards.length * 12) / 1024));
      expectOldOrder(state, [{}, { decks: [state.decks[0].id] }, randomQuery(rnd, state)], `kind ${kind}`);
    }
  });

  it('a big library NOT in Deck order needs many parts (one question each); a rating after it is repaired at once', () => {
    const state0 = bigLibrary('p4r-deck-big', 3000);
    const state = { ...state0, cards: createRandom('p4r-deck-big-mix').sample(state0.cards, state0.cards.length) };
    const ctx = matchCtxOf(state, NOW);
    const target = { cards: state.cards, index: ctx.index, decks: ctx.decks };
    let calls = 1;
    let asked = 0;
    while (
      !warmDeckOrder(target, () => {
        asked += 1;
        return true;
      })
    ) {
      calls += 1;
    }
    expect(asked).toBe(calls - 1);
    expect(calls).toBeGreaterThan(10);
    expect(ids(sortScopeCards(state.cards, { by: 'source' }, state, ctx))).toEqual(ids(oldSort(state.cards, { by: 'source' }, state)));
    // A rating: a new cards array of the same library — the kept order is reused at once.
    const rated = rateAt(state, 5, createRandom('p4r-deck-big-rate'));
    const ratedTarget = { cards: rated.cards, index: ctx.index, decks: ctx.decks };
    expect(libraryOrderReady(ratedTarget, { by: 'source' })).toBe(false);
    expect(warmDeckOrder(ratedTarget, () => true)).toBe(true);
    expect(libraryOrderReady(ratedTarget, { by: 'source' })).toBe(true);
  });

  it('new data in the middle of a job: the half-made order of the old data is never used for the new data', () => {
    const state0 = bigLibrary('p4r-deck-switch', 3000);
    const mix = createRandom('p4r-deck-switch-mix');
    const a = { ...state0, cards: mix.sample(state0.cards, state0.cards.length) };
    const b = { ...a, cards: [...a.cards.slice(7).reverse(), ...a.cards.slice(0, 7)] };
    // The same notes array: one library index, so the kept order and the job are found by the same key.
    const ctx = matchCtxOf(a, NOW);
    expect(matchCtxOf(b, NOW).index).toBe(ctx.index);
    const targetA = { cards: a.cards, index: ctx.index, decks: ctx.decks };
    const targetB = { cards: b.cards, index: ctx.index, decks: ctx.decks };
    expect(warmDeckOrder(targetA, () => true)).toBe(false); // A: half made
    expect(warmDeckOrder(targetB, () => true)).toBe(false); // B: a job of its own
    while (!warmDeckOrder(targetB, () => false));
    expect(ids(sortScopeCards(b.cards, { by: 'source' }, b, ctx))).toEqual(ids(oldSort(b.cards, { by: 'source' }, b)));
    // Back to A: made again from the start, for A's cards.
    while (!warmDeckOrder(targetA, () => false));
    expect(libraryOrderReady(targetA, { by: 'source' })).toBe(true);
    expect(ids(sortScopeCards(a.cards, { by: 'source' }, a, ctx))).toEqual(ids(oldSort(a.cards, { by: 'source' }, a)));
  });
});

/* ================================================================== deck rows */

describe('deckStatsMap: every deck row in one pass', () => {
  it('ready of each deck === readyFor({ decks: [id] }); statuses add up; a paused deck studies from its own row', () => {
    const d1 = makeDeckV3({ id: 'd1', name: 'One', order: 0 });
    const d2 = makeDeckV3({ id: 'd2', name: 'Two', order: 1, active: false });
    const empty = makeDeckV3({ id: 'd3', name: 'Empty', order: 2 });
    const state = stateOfV3({
      decks: [d1, d2, empty],
      groups: [
        basic('r1', 'd1', 'review', DUE_REVIEW),
        basic('r2', 'd1', 'review'),
        basic('n1', 'd1', 'new'),
        basic('ns', 'd1', 'notStarted'),
        basic('k1', 'd1', 'known'),
        basic('l2', 'd2', 'learning', { due: NOW - MIN }),
        basic('n2', 'd2', 'new'),
        basic('susp', 'd2', 'review', { ...DUE_REVIEW, suspended: true }),
      ],
    });
    const ctx = matchCtxOf(state, NOW);
    const rows = deckStatsMap(state, ctx);
    expect([...rows.keys()]).toEqual(['d1', 'd2', 'd3']);
    for (const deck of state.decks) {
      const row = rows.get(deck.id)!;
      expect(row.ready).toEqual(readyFor(state, { decks: [deck.id] }, ctx));
      expect(LIFE_KEYS.reduce((sum, k) => sum + row.life[k], 0)).toBe(row.total);
    }
    expect(rows.get('d1')).toMatchObject({
      total: 5,
      dueNow: 1,
      life: { notStarted: 1, new: 1, learning: 0, review: 2, mastered: 0, known: 1 },
    });
    expect(rows.get('d1')!.ready.total).toBe(2); // the due review + the new card
    expect(rows.get('d2')).toMatchObject({ total: 3, dueNow: 1 }); // the suspended card is not "due"
    expect(rows.get('d2')!.ready.total).toBe(2); // paused, but its own row names it
    expect(rows.get('d3')).toMatchObject({ total: 0, dueNow: 0 });
    expect(rows.get('d3')!.ready.total).toBe(0);
  });

  it('"{n} due" never counts a card Study cannot show: a learning card with a null due is neither due nor ready', () => {
    const d1 = makeDeckV3({ id: 'd1', name: 'One' });
    const state = stateOfV3({
      decks: [d1],
      // Damaged after load: in JavaScript `null <= now` is true, so life.ts isDueNow says "due".
      groups: [basic('broken', 'd1', 'learning', { due: null as unknown as number })],
    });
    const ctx = matchCtxOf(state, NOW);
    const row = deckStatsMap(state, ctx).get('d1')!;
    expect(row).toMatchObject({ total: 1, dueNow: 0 });
    expect(row.ready.total).toBe(0);
    expect(buildSessionQueue({ kind: 'scheduled', q: { decks: ['d1'] } }, state, ctx)).toEqual([]);
  });

  it('"{n} due" counts one direction of an item whose two directions are due (the other waits, as in Study)', () => {
    const d1 = makeDeckV3({ id: 'd1', name: 'One' });
    const twins = noteWithCards({
      deckId: 'd1',
      typeId: BUILTIN_TYPE_IDS.basicReverse,
      fields: ['front', 'back', '', ''],
      note: { id: 'n-twins' },
      card: (ord) => ({ id: `t${ord}`, ...lifeValues('review', NOW), due: NOW - (ord + 1) * HOUR }),
    });
    const state = stateOfV3({ decks: [d1], groups: [twins] });
    const row = deckStatsMap(state, matchCtxOf(state, NOW)).get('d1')!;
    expect(row.dueNow).toBe(1);
    expect(row.ready).toMatchObject({ total: 1, due: 1 });
  });
});

/* ================================================================== caches */

describe('cached lookups', () => {
  const deck = makeDeckV3({ id: 'd1', name: 'D' });
  const state = stateOfV3({ decks: [deck], groups: [basic('a', 'd1', 'new'), basic('b', 'd1', 'review', DUE_REVIEW)] });

  it('the library index is built once per (notes, card types); a rating (new cards array) keeps it', () => {
    const index = libraryIndexOf(state);
    expect(libraryIndexOf({ notes: state.notes, noteTypes: state.noteTypes })).toBe(index);
    const rated: DataStateV3 = { ...state, cards: state.cards.map((c) => (c.id === 'b' ? { ...c, reps: c.reps + 1 } : c)) };
    expect(libraryIndexOf(rated)).toBe(index);
    expect(libraryIndexOf({ ...state, notes: [...state.notes] })).not.toBe(index);
    expect(cardLookupOf(rated.cards)).not.toBe(cardLookupOf(state.cards));
    expect(cardLookupOf(state.cards)).toBe(cardLookupOf(state.cards));
  });

  it('decks and lists by id are cached per array; the lists hold the built-in lists', () => {
    expect(decksById(state.decks)).toBe(decksById(state.decks));
    expect(decksById(state.decks).get('d1')).toBe(deck);
    const lists = listsOf(state.lists);
    expect(lists).toBe(listsOf(state.lists));
    for (const l of BUILTIN_LISTS) expect(lists.get(l.id)).toBe(l);
    const ctx = matchCtxOf(state, NOW);
    expect(ctx.index).toBe(libraryIndexOf(state));
    expect(ctx.now).toBe(NOW);
  });

  it('scheduleCtxOf reads the state: tallies, settings, the card type of a card', () => {
    const ctx = matchCtxOf(state, NOW);
    const sctx = scheduleCtxOf(state, ctx);
    expect(sctx.done).toBe(state.person.dayDone);
    expect(sctx.settings).toBe(state.settings);
    expect(sctx.typeIdOf(state.cards[0])).toBe(BUILTIN_TYPE_IDS.basic);
    expect(sctx.typeIdOf({ ...state.cards[0], noteId: 'missing' })).toBeUndefined();
    expect(sctx.scope).toBeUndefined();
    expect(scheduleCtxOf(state, ctx, { life: ['known'], list: 'builtin:suspended' }).scope).toEqual({
      life: ['known'],
      flags: ['suspended'],
    });
  });

  it('damaged state arrays (missing) never throw', () => {
    const damaged = { ...state, notes: undefined, cards: undefined, decks: undefined, lists: undefined } as unknown as DataStateV3;
    const ctx = matchCtxOf(damaged, NOW);
    expect(scopePool(damaged, {}, ctx, 'browse')).toEqual([]);
    expect(readyFor(damaged, {}, ctx).total).toBe(0);
    expect(deckStatsMap(damaged, ctx).size).toBe(0);
  });
});

/* ================================================================== the selector readers */

describe('the selectors behind useReady / useDeckStatsMap / useFacets / useScopePool / useSessionLength', () => {
  const d1 = makeDeckV3({ id: 'd1', name: 'One', order: 0 });
  const d2 = makeDeckV3({ id: 'd2', name: 'Two', order: 1, active: false });
  const state = stateOfV3({
    decks: [d1, d2],
    groups: [
      basic('r1', 'd1', 'review', DUE_REVIEW),
      basic('n1', 'd1', 'new', { fav: true }),
      basic('n2', 'd2', 'new', { fav: true }),
      basic('later', 'd1', 'review', { due: NOW + DAY }),
    ],
  });
  const ctx = matchCtxOf(state, NOW);

  it('useReady: readyFor of the query; the SAME object while the numbers stay equal', () => {
    const read = readyReader(serializeQuery({}), NOW);
    const first = read(state);
    expect(first).toEqual(readyFor(state, {}, ctx));
    // A change the count does not read (onboarded) → the same object, no re-render.
    expect(read({ ...state, onboarded: !state.onboarded })).toBe(first);
    // A change it reads but with the same numbers (a new cards array) → still the same object.
    expect(read({ ...state, cards: [...state.cards] })).toBe(first);
    // Fewer cards → new numbers.
    const fewer = read({ ...state, cards: state.cards.filter((c) => c.id !== 'n1') });
    expect(fewer).not.toBe(first);
    expect(fewer.total).toBe(first.total - 1);
  });

  it('useDeckStatsMap / useScopePool / useFacets: recomputed only when what they read changes', () => {
    const rows = deckStatsReader(NOW);
    const map = rows(state);
    expect(map.get('d1')?.ready).toEqual(readyFor(state, { decks: ['d1'] }, ctx));
    expect(rows({ ...state, onboarded: false })).toBe(map);

    const pool = scopePoolReader(serializeQuery({ flags: ['fav'] }), 'browse', NOW);
    expect(sortedIds(pool(state))).toEqual(['n1', 'n2']);
    expect(pool({ ...state, sessions: [] })).toBe(pool(state));
    expect(ids(scopePoolReader(serializeQuery({ flags: ['fav'] }), 'study', NOW)(state))).toEqual(['n1']);

    // useSortedScopePool: the browse pool in the ONE sort order, cached per input.
    const sorted = sortedPoolReader(serializeQuery({}), JSON.stringify({ by: 'az', dir: 'desc' }), NOW);
    const browse = scopePool(state, {}, ctx, 'browse');
    expect(ids(sorted(state))).toEqual(ids(sortScopeCards(browse, { by: 'az', dir: 'desc' }, state, ctx)));
    expect(sorted({ ...state, sessions: [] })).toBe(sorted(state));

    const facets = facetsReader(serializeQuery({}), serializeQuery({ flags: ['fav'] }), NOW);
    const first = facets(state);
    const paused = first.find((f) => f.key === 'flags')?.values.find((v) => v.value === 'paused');
    expect(paused?.count).toBe(1);
    expect(facets({ ...state, person: { ...state.person, xp: 99 } })).toBe(first); // facets do not read the person
  });

  it('useSessionLength: the length of buildSessionQueue for the same params', () => {
    const cases: SessionParams[] = [
      { kind: 'scheduled', q: {} },
      { kind: 'ahead', q: { decks: ['d1'] } },
      { kind: 'practice', q: { flags: ['fav'] }, sort: { by: 'due' } },
      { kind: 'practice', sel: ['n2', 'r1', 'gone'] },
    ];
    for (const params of cases) {
      const key = sessionParamsKey(params);
      expect(sessionLengthReader(key, NOW)(state)).toBe(buildSessionQueue(params, state, ctx).length);
    }
    expect(sessionParamsKey({ kind: 'scheduled', q: { tags: ['B1'] } })).toBe(
      sessionParamsKey({ kind: 'scheduled', q: { tags: ['b1'] } }),
    );
  });

  it('memoOnInputs: the last result while every input is the same object', () => {
    let runs = 0;
    const sel = memoOnInputs(
      (s: { a: object; b: object }) => [s.a, s.b],
      () => {
        runs += 1;
        return runs;
      },
    );
    const a = {};
    const b = {};
    expect(sel({ a, b })).toBe(1);
    expect(sel({ a, b })).toBe(1);
    expect(sel({ a, b: {} })).toBe(2);
  });
});

/* ================================================================== the property */

const FLAG_KEYS: readonly FlagKey[] = ['fav', 'flagged', 'suspended', 'buried', 'paused'];
const TAG_WORDS = ['verb', 'a1', 'german', 'german::verbs', 'core', 'algo', 'missing'];
const TEXT_WORDS = ['stunde', 'uber', 'meaning', '1', 'extra', '"die stunde"', 'zzz'];
const SECTION_PATHS = ['', 'verbs', 'verbs::b1', 'nouns'];

/**
 * A random library that exercises every bucket and cap: due learning and
 * reviews, Known cards ready for a Check, siblings studied today, today's
 * tallies, per-deck new caps, random new order, Checks on/off, session sizes,
 * sibling spacing on/off, and one user list that names a deck.
 */
function randomLibrary(rnd: Random): DataStateV3 {
  const base = randomStateV3(rnd.fork('base'), { now: NOW, maxDecks: 3, maxNotes: 28 });
  const decks: Deck[] = base.decks.map((d) => ({
    ...d,
    options: {
      ...d.options,
      newPerDay: rnd.bool(0.3) ? rnd.int(0, 3) : null,
      newOrder: rnd.bool(0.3) ? 'random' : 'source',
      knownChecks: rnd.bool(0.8),
    },
  }));
  const cards: Card[] = base.cards.map((c) => {
    const key = life(c);
    const out: Card = { ...c };
    if ((key === 'learning' || key === 'review' || key === 'mastered') && rnd.bool(0.55)) {
      out.due = NOW - rnd.int(1, 3000) * MIN;
    }
    if (key === 'known' && rnd.bool(0.7)) out.knownAt = NOW - rnd.int(1, 120) * DAY;
    if (key !== 'new' && key !== 'notStarted' && key !== 'known' && rnd.bool(0.15)) out.lastReviewedAt = NOW - rnd.int(1, 120) * MIN;
    return out;
  });
  const dayKey = dayKeyOf(NOW);
  const newByDeck: Record<Id, number> = {};
  for (const d of decks) if (rnd.bool(0.4)) newByDeck[d.id] = rnd.int(0, 2);
  const lists: ListDef[] = [
    { id: 'user-1', name: 'One deck', icon: '🔖', query: { decks: [rnd.pick(decks).id] }, createdAt: NOW, updatedAt: NOW },
  ];
  return {
    ...base,
    decks,
    cards,
    lists,
    person: {
      ...base.person,
      dayDone: { dayKey, reviews: rnd.int(0, 4), neww: rnd.int(0, 3), checks: rnd.int(0, 2), newByDeck },
    },
    settings: {
      ...base.settings,
      sessionLimit: rnd.pick([0, 0, 3, 8, 50]),
      spaceSiblings: rnd.bool(0.7),
      knownChecksPerDay: rnd.pick([0, 1, 5]),
      srs: { ...base.settings.srs, dailyNewLimit: rnd.int(0, 8), dailyReviewLimit: rnd.int(1, 12) },
    },
  };
}

/** A random scope query over the state's own data (decks, sections, tags, lists …). */
function randomQuery(rnd: Random, state: DataStateV3): Query {
  const q: Query = {};
  const deckIds = state.decks.map((d) => d.id);
  if (rnd.bool(0.3)) q.decks = rnd.sample(deckIds, rnd.int(1, deckIds.length));
  if (rnd.bool(0.15)) q.sections = [{ deckId: rnd.pick(deckIds), path: rnd.pick(SECTION_PATHS) }];
  if (rnd.bool(0.2)) q.tags = [rnd.pick(TAG_WORDS)];
  if (rnd.bool(0.08)) q.notTags = [rnd.pick(TAG_WORDS)];
  if (rnd.bool(0.25)) q.life = rnd.sample(LIFE_KEYS, rnd.int(1, 3));
  if (rnd.bool(0.12)) q.due = rnd.pick(['now', 'today'] as const);
  if (rnd.bool(0.2)) q.flags = [rnd.pick(FLAG_KEYS)];
  if (rnd.bool(0.1)) q.notFlags = [rnd.pick(FLAG_KEYS)];
  if (rnd.bool(0.08)) q.hard = true;
  if (rnd.bool(0.08)) q.young = true;
  if (rnd.bool(0.05)) q.leech = true;
  if (rnd.bool(0.1)) q.directions = [rnd.int(0, 2)];
  if (rnd.bool(0.1)) q.noteTypes = [rnd.pick([...state.noteTypes.map((t) => t.id), threeWayType().id])];
  if (rnd.bool(0.12)) q.text = rnd.pick(TEXT_WORDS);
  if (rnd.bool(0.15)) q.list = rnd.pick([...BUILTIN_LISTS.map((l) => l.id), 'user-1', 'gone']);
  return q;
}

describe('property: readyFor(q).total === buildSessionQueue(scheduled, q).length (300 seeded states)', () => {
  const STATES = 300;
  const QUERIES_PER_STATE = 6;

  it('for random queries; every queued card is in the scope, studiable, and in the queue once', () => {
    let nonEmpty = 0;
    let capped = 0;
    let withChecks = 0;
    let pausedNamed = 0;
    for (let i = 0; i < STATES; i++) {
      const seed = `scope-${i}`;
      const rnd = createRandom(seed);
      const state = randomLibrary(rnd.fork('state'));
      const ctx = matchCtxOf(state, NOW);
      const sctx = scheduleCtxOf(state, ctx);
      const queries = [{}, ...Array.from({ length: QUERIES_PER_STATE }, (_, k) => randomQuery(rnd.fork(`q${k}`), state))];
      for (const q of queries) {
        const where = `seed ${seed}, q ${JSON.stringify(q)}`;
        const ready = readyFor(state, q, ctx);
        const queue = buildSessionQueue({ kind: 'scheduled', q }, state, ctx);

        // THE promise: the button number is the session length.
        expect({ where, total: ready.total }).toEqual({ where, total: queue.length });
        expect(ready.learning + ready.due + ready.checks + ready.neww).toBe(ready.total);
        expect(ready.mins).toBe(minutesFor(ready.total));
        expect(ready.capped).toBe(ready.total < ready.uncappedTotal);
        if (state.settings.sessionLimit > 0) expect(queue.length).toBeLessThanOrEqual(state.settings.sessionLimit);

        // Every queued card: in the scope, eligible, not suspended or buried, once.
        const match = compileQuery(q, ctx);
        const named = explicitDecks(q, ctx);
        expect({ where, unique: new Set(ids(queue)).size }).toEqual({ where, unique: queue.length });
        for (const card of queue) {
          expect({ where, id: card.id, ok: match(card) && studyEligible(card, sctx, named) }).toEqual({
            where,
            id: card.id,
            ok: true,
          });
          expect(card.suspended === true || isBuried(card, NOW)).toBe(false);
          expect(life(card)).not.toBe('notStarted');
          if (life(card) === 'known') expect(isCheckSampled(card.id)).toBe(true);
        }

        // Study pool ⊆ browse pool; ahead ⊆ study pool; practice ⊆ browse pool.
        const browse = new Set(ids(scopePool(state, q, ctx, 'browse')));
        const study = scopePool(state, q, ctx, 'study');
        for (const card of study) expect(browse.has(card.id)).toBe(true);
        const studySet = new Set(ids(study));
        for (const card of buildSessionQueue({ kind: 'ahead', q }, state, ctx)) expect(studySet.has(card.id)).toBe(true);
        for (const card of buildSessionQueue({ kind: 'practice', q }, state, ctx)) expect(browse.has(card.id)).toBe(true);

        if (queue.length > 0) nonEmpty += 1;
        if (ready.capped) capped += 1;
        if (ready.checks > 0) withChecks += 1;
        if (queue.some((c) => state.decks.find((d) => d.id === c.deckId)?.active === false)) pausedNamed += 1;
      }
      // The deck rows agree with readyFor for every deck.
      const rows = deckStatsMap(state, ctx);
      // "{n} due" is what Study shows as due when no daily limit and no session size cut the run.
      const open: DataStateV3 = {
        ...state,
        settings: { ...state.settings, sessionLimit: 0, srs: { ...state.settings.srs, dailyReviewLimit: NO_REVIEW_LIMIT } },
      };
      const openCtx = matchCtxOf(open, NOW);
      for (const deck of state.decks) {
        expect({ seed, deck: deck.id, ready: rows.get(deck.id)?.ready }).toEqual({
          seed,
          deck: deck.id,
          ready: readyFor(state, { decks: [deck.id] }, ctx),
        });
        const uncut = readyFor(open, { decks: [deck.id] }, openCtx);
        expect({ seed, deck: deck.id, dueNow: rows.get(deck.id)?.dueNow }).toEqual({ seed, deck: deck.id, dueNow: uncut.learning + uncut.due });
      }
    }
    // The random data really exercised the interesting cases.
    expect(nonEmpty).toBeGreaterThan(STATES);
    expect(capped).toBeGreaterThan(20);
    expect(withChecks).toBeGreaterThan(5);
    expect(pausedNamed).toBeGreaterThan(5);
  });
});

/* ================================================================== W5-3: the queue.ts facade cases */

/*
 * W5-3 deleted src/domain/queue.ts (the old facade over the scheduler) and its
 * tests. The cases below are the ones that still pin a real promise. They
 * run on scope.ts, the code every screen uses now. Every expected number is
 * the one the old test had.
 */

/** A learning card that is due (5 minutes ago). */
const learningDue = (id: string, deckId = 'd1') => basic(id, deckId, 'learning', { due: NOW - 5 * MIN });
/** A review card that is due (a day ago). */
const reviewDue = (id: string, deckId = 'd1', card: Partial<Card> = {}) =>
  basic(id, deckId, 'review', { due: NOW - DAY, ...card });
/** A review card that is not due yet (tomorrow). */
const reviewLater = (id: string, deckId = 'd1', card: Partial<Card> = {}) =>
  basic(id, deckId, 'review', { due: NOW + DAY, ...card });
/** A New card; `order` is its place in the deck's feed. */
const fresh = (id: string, deckId = 'd1', card: Partial<Card> = {}, order?: number) =>
  basic(id, deckId, 'new', card, order === undefined ? {} : { order });

interface LibraryOptions {
  /** Today's tallies so far. */
  reviews?: number;
  neww?: number;
  dailyNewLimit?: number;
  dailyReviewLimit?: number;
  /** Session size; default 0 = no cut, so only the daily limits decide. */
  sessionLimit?: number;
}

/** A library of these decks and notes, with today's tallies and the given limits. */
function library(decks: Deck[], groups: { note: Note; cards: Card[] }[], o: LibraryOptions = {}): DataStateV3 {
  const base = stateOfV3({ decks, groups });
  return {
    ...base,
    person: {
      ...base.person,
      dayDone: { dayKey: dayKeyOf(NOW), reviews: o.reviews ?? 0, neww: o.neww ?? 0, checks: 0, newByDeck: {} },
    },
    settings: {
      ...base.settings,
      sessionLimit: o.sessionLimit ?? 0,
      srs: { ...base.settings.srs, dailyNewLimit: o.dailyNewLimit ?? 10, dailyReviewLimit: o.dailyReviewLimit ?? 200 },
    },
  };
}

/** The numbers of one scope and the session it opens, side by side. */
function launch(state: DataStateV3, q: Query) {
  const ctx = matchCtxOf(state, NOW);
  return { ready: readyFor(state, q, ctx), queue: buildSessionQueue({ kind: 'scheduled', q }, state, ctx) };
}

const D1 = makeDeckV3({ id: 'd1', name: 'One', order: 0 });
const D2 = makeDeckV3({ id: 'd2', name: 'Two', order: 1 });

describe('the launch count includes the new cards a session adds (the "Study 11" opens "1/18" bug)', () => {
  // d1: 1 learning due + 8 reviews due + 10 new; d2 adds noise. 3 new done today → 7 new left.
  const state = library(
    [D1, D2],
    [
      learningDue('L'),
      ...Array.from({ length: 8 }, (_, i) => reviewDue(`R${i}`)),
      ...Array.from({ length: 10 }, (_, i) => fresh(`N${i}`, 'd1', {}, i)),
      reviewDue('X', 'd2'),
    ],
    { reviews: 14, neww: 3 },
  );

  it('the deck row: "{n} due" is 9, but "Study 16" — and the session has 16 cards', () => {
    const row = deckStatsMap(state, matchCtxOf(state, NOW)).get('d1')!;
    const { ready, queue } = launch(state, { decks: ['d1'] });
    expect(row.dueNow).toBe(9); // 8 reviews + 1 learning, no new cards
    expect(row.ready.total).toBe(16); // + min(10 new, 7 left) = 7
    expect(ready.total).toBe(16);
    expect(queue).toHaveLength(16);
    expect(row.ready.total - row.dueNow).toBe(7); // exactly the gap the old bug showed
  });
});

describe('"Study N" === the session, across the daily limits (the hero promise)', () => {
  // 3 learning due, 14 reviews due, 24 new, 5 reviews not due yet. Limits: 200 reviews, 10 new.
  const groups = [
    ...Array.from({ length: 3 }, (_, i) => learningDue(`L${i}`)),
    ...Array.from({ length: 14 }, (_, i) => reviewDue(`R${i}`)),
    ...Array.from({ length: 24 }, (_, i) => fresh(`N${i}`, 'd1', {}, i)),
    ...Array.from({ length: 5 }, (_, i) => reviewLater(`F${i}`)),
  ];
  // Learning is never capped by the daily limits — in the count and in the queue.
  it.each([
    [0, 0, 27], // 3 + 14 + 10
    [14, 3, 24], // 3 + 14 + 7
    [198, 8, 7], // 3 + 2 + 2
    [200, 10, 3], // 3 + 0 + 0
  ])('done today: %i reviews, %i new → Study %i, and the session has as many cards', (reviews, neww, total) => {
    const { ready, queue } = launch(library([D1], groups, { reviews, neww }), {});
    expect(ready.total).toBe(total);
    expect(queue).toHaveLength(total);
  });
});

describe('a list scope counts its new cards too (the old collection count)', () => {
  it('Favorites: 2 due + 2 new favorites → Study 4, and the session has 4 cards', () => {
    const state = library(
      [D1],
      [
        reviewDue('R0', 'd1', { fav: true }),
        reviewDue('R1', 'd1', { fav: true }),
        fresh('N0', 'd1', { fav: true }),
        fresh('N1', 'd1', { fav: true }),
        reviewDue('NOPE'),
      ],
    );
    const { ready, queue } = launch(state, { list: 'builtin:favorites' });
    expect(ready.due).toBe(2); // only the studied favorites are "due"
    expect(ready.total).toBe(4); // + the 2 new favorites
    expect(queue).toHaveLength(4);
  });
});

describe('bury keeps a card out of the count AND the session, for every kind of card', () => {
  const buriedUntil = NOW + DAY;

  it.each([
    ['new', () => fresh('B', 'd1', { buriedUntil })],
    ['learning', () => basic('B', 'd1', 'learning', { due: NOW - 5 * MIN, buriedUntil })],
    ['review', () => reviewDue('B', 'd1', { buriedUntil })],
  ])('a buried %s card is neither ready nor in the session today', (_kind, buried) => {
    const { ready, queue } = launch(library([D1], [buried(), reviewDue('keep')]), {});
    expect(ready.total).toBe(1);
    expect(ids(queue)).toEqual(['keep']);
  });

  it('a buried NEW card is not counted as new (the old regression)', () => {
    const { ready, queue } = launch(library([D1], [fresh('B', 'd1', { buriedUntil }), fresh('keep')]), {});
    expect(ready.neww).toBe(1);
    expect(ids(queue)).toEqual(['keep']);
  });
});

describe('a card whose deck is gone is never studied (the old active pool)', () => {
  it('"All" leaves the orphan out of the count and the session; browse still finds it', () => {
    const state = library([D1], [reviewDue('ok'), reviewDue('orphan', 'gone')]);
    const { ready, queue } = launch(state, {});
    expect(ready.total).toBe(1);
    expect(ids(queue)).toEqual(['ok']);
    expect(scopePool(state, {}, matchCtxOf(state, NOW), 'browse')).toHaveLength(2);
  });
});

describe('"{n} due" is the true urgency count; the Study number is limit-aware (M4)', () => {
  it('3 overdue reviews with a daily review limit of 1: "3 due", Study 1', () => {
    const state = library([D1], [reviewDue('a'), reviewDue('b'), reviewDue('c')], { dailyReviewLimit: 1 });
    const row = deckStatsMap(state, matchCtxOf(state, NOW)).get('d1')!;
    expect(row.dueNow).toBe(3);
    expect(row.ready.total).toBe(1);
  });

  it('"due" means learning + reviews that are due — never a New card', () => {
    const state = library([D1], [reviewDue('a'), learningDue('b'), fresh('c')], { dailyReviewLimit: 1 });
    expect(deckStatsMap(state, matchCtxOf(state, NOW)).get('d1')!.dueNow).toBe(2);
  });
});

describe('the daily limit is ONE budget shared by all decks (L15)', () => {
  // Each deck has more due reviews than the whole day allows. Each deck row is
  // honest about ITS session; the "All" number is the real ceiling of the day.
  const state = library(
    [D1, D2],
    [
      ...Array.from({ length: 8 }, (_, i) => reviewDue(`A${i}`, 'd1')),
      ...Array.from({ length: 8 }, (_, i) => reviewDue(`B${i}`, 'd2')),
    ],
    { dailyReviewLimit: 5, dailyNewLimit: 0 },
  );
  const rows = deckStatsMap(state, matchCtxOf(state, NOW));

  it('each deck row equals the session that deck opens: 5 (the shared rest), not 8', () => {
    for (const deckId of ['d1', 'd2']) {
      expect(rows.get(deckId)!.ready.total).toBe(5);
      expect(launch(state, { decks: [deckId] }).queue).toHaveLength(5);
    }
  });

  it('so the deck rows may add up to more than "All" (5 + 5 > 5)', () => {
    expect(launch(state, {}).ready.total).toBe(5);
    expect(rows.get('d1')!.ready.total + rows.get('d2')!.ready.total).toBe(10);
  });
});

describe('isLaunchable: a Study button is live when its session has a card, never by "{n} due" (H1)', () => {
  const rowOf = (state: DataStateV3) => deckStatsMap(state, matchCtxOf(state, NOW)).get('d1')!;

  it('true exactly when the session has at least one card', () => {
    expect(isLaunchable({ total: 0 })).toBe(false);
    expect(isLaunchable({ total: 1 })).toBe(true);
  });

  it('a deck of brand-new cards: 0 due, but launchable (the freshly-added-deck bug)', () => {
    const row = rowOf(library([D1], Array.from({ length: 6 }, (_, i) => fresh(`N${i}`, 'd1', {}, i))));
    expect(row.dueNow).toBe(0);
    expect(row.ready.total).toBe(6);
    expect(isLaunchable(row.ready)).toBe(true);
  });

  it('a deck with only future reviews is caught up: not launchable', () => {
    const row = rowOf(library([D1], [reviewLater('F')]));
    expect(row.dueNow).toBe(0);
    expect(isLaunchable(row.ready)).toBe(false);
  });

  it('overdue cards, but the daily review limit is used up: no "Study 0" button', () => {
    const row = rowOf(library([D1], [reviewDue('a'), reviewDue('b')], { reviews: 10, dailyReviewLimit: 10, dailyNewLimit: 0 }));
    expect(row.dueNow).toBe(2);
    expect(row.ready.total).toBe(0);
    expect(isLaunchable(row.ready)).toBe(false);
  });

  it('a list works the same way: one new favorite is launchable at 0 due', () => {
    const { ready } = launch(library([D1], [fresh('NF', 'd1', { fav: true })]), { list: 'builtin:favorites' });
    expect(ready.due).toBe(0);
    expect(isLaunchable(ready)).toBe(true);
  });
});

describe('the session order and what Study feeds', () => {
  it('learning first, then due reviews, then new cards', () => {
    const { queue } = launch(library([D1], [fresh('N'), reviewDue('R'), learningDue('L')]), {});
    expect(ids(queue)).toEqual(['L', 'R', 'N']);
  });

  it('Not started is never fed; a Known card comes only as its one sampled Check', () => {
    const [checkId] = Array.from({ length: 200 }, (_, i) => `k${i}`).filter(isCheckSampled);
    const [notSampled] = Array.from({ length: 200 }, (_, i) => `u${i}`).filter((id) => !isCheckSampled(id));
    const longAgo = NOW - 200 * DAY; // past every spread day (21 to 90 days)
    const state = library(
      [D1],
      [
        basic('waiting', 'd1', 'notStarted'),
        basic(checkId, 'd1', 'known', { knownAt: longAgo }),
        basic(notSampled, 'd1', 'known', { knownAt: longAgo }),
        fresh('fresh'),
      ],
    );
    const { ready, queue } = launch(state, {});
    expect(ready.checks).toBe(1);
    expect(ids(queue)).toEqual([checkId, 'fresh']);
    expect(ready.total).toBe(queue.length);
  });

  it('new siblings: two directions of one item never come on the same day', () => {
    const twins = noteWithCards({
      deckId: 'd1',
      typeId: BUILTIN_TYPE_IDS.basicReverse,
      note: { id: 'n1', order: 0 },
      card: (ord) => ({ id: `n1-c${ord}`, ...lifeValues('new', NOW) }),
    });
    const { ready, queue } = launch(library([D1], [twins, fresh('n2-c0', 'd1', {}, 1)]), {});
    expect(ids(queue)).toEqual(['n1-c0', 'n2-c0']);
    expect(ready.total).toBe(2);
  });

  it('new cards take turns between decks (round robin), so no deck starves', () => {
    const state = library(
      [D1, D2],
      [
        ...Array.from({ length: 10 }, (_, i) => fresh(`a${i}`, 'd1', {}, i)),
        ...Array.from({ length: 10 }, (_, i) => fresh(`b${i}`, 'd2', {}, i)),
      ],
      { dailyNewLimit: 4 },
    );
    expect(ids(launch(state, {}).queue)).toEqual(['a0', 'b0', 'a1', 'b1']);
  });
});

describe('the session size: N cuts every kind to N; 0 means "No limit" (M7)', () => {
  const studied = Array.from({ length: 40 }, (_, i) => reviewDue(`R${i}`, 'd1', { ease: 1.5 + i * 0.01 }));
  const later = Array.from({ length: 30 }, (_, i) => reviewLater(`F${i}`, 'd1', { due: NOW + (i + 1) * DAY }));

  it('practice of the hardest cards: exactly the session size, or all of them with no limit', () => {
    const practice = (sessionLimit: number) => {
      const state = library([D1], studied, { sessionLimit });
      return buildSessionQueue({ kind: 'practice', q: {}, sort: { by: 'hardest' } }, state, matchCtxOf(state, NOW));
    };
    expect(practice(30)).toHaveLength(30);
    expect(practice(35)).toHaveLength(35);
    expect(practice(0)).toHaveLength(40);
    expect(ids(practice(3))).toEqual(['R0', 'R1', 'R2']); // the lowest ease first
  });

  it('study ahead: exactly the session size, or all of them with no limit', () => {
    const ahead = (sessionLimit: number) => {
      const state = library([D1], later, { sessionLimit });
      return buildSessionQueue({ kind: 'ahead', q: {} }, state, matchCtxOf(state, NOW));
    };
    expect(ahead(7)).toHaveLength(7);
    expect(ahead(0)).toHaveLength(30);
  });
});

/* ================================================================== W5-3: the grep guard */

/*
 * The temporary aliases of wave 3 (spec §3.6) and the old queue facade are
 * deleted. This guard reads every source file under src/ as text and fails
 * when one of their names comes back — in code OR in a comment (a comment
 * that names a deleted function is a stale doc). This test file is the only
 * exception: it must name them to look for them.
 */
const RETIRED_NAMES = ['setCardProps', 'buryCard', 'updateCard', 'writeSchedule', 'computeReady', 'buildQueue'] as const;
/** Whole words only: `writesSchedule` (the real rule) and `updateCards` are other names. */
const RETIRED = new RegExp(`\\b(${RETIRED_NAMES.join('|')})\\b`);

/** The file types the guard reads: code, the JSON fixtures, the fixture README. */
const GUARDED_FILE = /\.(ts|tsx|js|jsx|json|md)$/;

/** Every guarded file under `dir`, as an absolute path. */
function guardedFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...guardedFiles(full));
    else if (GUARDED_FILE.test(entry.name)) out.push(full);
  }
  return out;
}

describe('grep guard: the wave-3 compatibility aliases never come back (W5-3)', () => {
  const SRC = path.resolve(__dirname, '..');
  const SELF = path.resolve(__filename);

  it(`no file under src/ names ${RETIRED_NAMES.join(', ')}`, () => {
    const files = guardedFiles(SRC).filter((file) => file !== SELF);
    expect(files.length).toBeGreaterThan(100); // the walk really read the tree
    const hits: string[] = [];
    for (const file of files) {
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const found = RETIRED.exec(line);
          if (found) hits.push(`${path.relative(SRC, file)}:${i + 1} ${found[1]}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('the deleted facade files stay deleted, and isLaunchable lives in scope.ts', () => {
    expect(fs.existsSync(path.join(SRC, 'domain', 'queue.ts'))).toBe(false);
    expect(fs.existsSync(path.join(SRC, 'domain', 'queue.test.ts'))).toBe(false);
    expect(fs.existsSync(path.join(SRC, 'domain', 'importSamples.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(SRC, 'domain', 'scope.ts'), 'utf8')).toMatch(/export function isLaunchable\(/);
  });

  it('the guard itself works: it finds a retired name, and not a longer word that contains one', () => {
    expect(RETIRED.test('actions.setCardProps([id], patch)')).toBe(true);
    expect(RETIRED.test('rateCard(id, r, { writeSchedule: false })')).toBe(true);
    expect(RETIRED.test('writesSchedule(kind)')).toBe(false);
    expect(RETIRED.test('updateCards(state)')).toBe(false);
  });
});
