/**
 * Unit U2 — the field sort key computes the rank of each VALUE once
 * (scope.ts sortKeyFor + rankCache), not once per card. The first Level sort
 * of the device's 16,264 cards was 32.3 ms (budget 30 ms).
 *
 * The promise these tests pin: every key, so every order, is EXACTLY what
 * the old formula gives. The old formula is written out again here
 * (referenceFieldKey) and compared with the real code:
 *   (a) seeded libraries of German words (card type legacyVocabDe: its Level
 *       field is ordinal CEFR, its Type field is text) with random Level
 *       values (some notes have none), random card states and a SHUFFLED
 *       cards array: the keys, sortCards, orderCards, orderPositions,
 *       repairPositions and sortScopeCards (whole library, filtered lists, a
 *       repaired kept order) give the reference order, in both directions.
 *       Also a Level field with several values per note (the smallest rank
 *       wins) and a Level field with one value that is not a CEFR level
 *       (then the group sorts as text);
 *   (b) ONE scheduleCtxOf asked for Level, then Type, then Level again, then
 *       A–Z (and all four mixed, card by card) gives the key of a fresh ctx
 *       every time. The kept ranks belong to ONE library index: after a note
 *       edit (a new index) a card gets the rank of its new value;
 *   (c) a card with no Level gets NO_SORT_KEY and stays last in both directions.
 *
 * Why not randomStateV3: its card types have no filter group at all (every
 * field is facet 'off'), so it never reaches the field key.
 *
 * No timing here: the time is checked with the device data bench and on the
 * device (spec §11 E2).
 */
import { describe, expect, it } from '@jest/globals';

import { FIXED_NOW } from '../test/clock';
import { lifeValues, makeDeckV3, noteWithCards, stateOfV3 } from '../test/factoriesV3';
import { createRandom, type Random } from '../test/random';
import { builtinType } from './builtinTypes';
import { LIFE_KEYS } from './life';
import type { Card, DataStateV3, Note, NoteType, Query, SortSpec } from './model';
import { detectOrdinal, type Ordinal } from './ordinal';
import { NO_SORT_KEY, orderCards, orderPositions, repairPositions, type SortCtx, sortCards } from './schedule';
import { libraryIndexOf, matchCtxOf, scheduleCtxOf, scopePool, sortScopeCards } from './scope';
import { DAY } from './types';

const NOW = FIXED_NOW;
const ids = (cards: readonly Card[]) => cards.map((c) => c.id);

/** The Level values of the plain libraries. '' = the note has no Level. */
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', ''];
/** The Type values (a text group, not ordinal). '' = no Type. */
const TYPES = ['noun', 'verb', 'adjective', 'adverb', ''];

const LEVEL: SortSpec = { by: 'field', field: 'level' };
const LEVEL_DESC: SortSpec = { by: 'field', field: 'level', dir: 'desc' };
const TYPE: SortSpec = { by: 'field', field: 'type' };
const TYPE_DESC: SortSpec = { by: 'field', field: 'type', dir: 'desc' };
const AZ: SortSpec = { by: 'az' };
const FIELD_SORTS: readonly SortSpec[] = [LEVEL, LEVEL_DESC, TYPE, TYPE_DESC];

/** Filtered lists of every size: the whole library, a Level chip, two Levels, a deck, two statuses, a Type. */
const QUERIES: readonly Query[] = [
  {},
  { fields: { level: ['b1'] } },
  { fields: { level: ['a1', 'c2'] } },
  { decks: ['d1'] },
  { life: ['review', 'mastered'] },
  { fields: { type: ['verb'] } },
];

/* ------------------------------------------------------------------ the old formula */

/**
 * The field key of the OLD code (before unit U2), written out again: the
 * ordinal kind of the group from ALL its labels; then, for every value of
 * the card's note, the rank of the value's label, and the smallest one wins;
 * NO_SORT_KEY when the note has no value (or the rank is not a number). A
 * group that is not ordinal: the text of the first value.
 */
function referenceFieldKey(state: DataStateV3): (card: Card, sort: SortSpec) => string | number {
  const index = libraryIndexOf(state);
  const ordinals = new Map<string, Ordinal | null>();
  const ordinalOf = (key: string): Ordinal | null => {
    if (!ordinals.has(key)) {
      const labels = new Set<string>();
      for (const note of index.noteById.values()) {
        for (const value of index.facetValues(note).get(key) ?? []) labels.add(index.valueLabel(key, value));
      }
      ordinals.set(key, detectOrdinal([...labels]));
    }
    return ordinals.get(key) ?? null;
  };
  return (card, sort) => {
    if (sort.by !== 'field') throw new Error('referenceFieldKey: only field sorts');
    const key = sort.field ?? '';
    const note = index.noteById.get(card.noteId);
    const values = note ? index.facetValues(note).get(key) : undefined;
    const ordinal = ordinalOf(key);
    if (ordinal) {
      let best = NO_SORT_KEY;
      for (const v of values ?? []) best = Math.min(best, ordinal.rank(index.valueLabel(key, v)));
      return Number.isFinite(best) ? best : NO_SORT_KEY;
    }
    return values && values.length > 0 ? values[0] : NO_SORT_KEY;
  };
}

/** The sort ctx of the reference: the real decks, the OLD field key. */
function referenceCtx(state: DataStateV3): SortCtx {
  return { decks: matchCtxOf(state, NOW).decks, sortKey: referenceFieldKey(state) };
}

/* ------------------------------------------------------------------ seeded libraries */

/** The German words card type, with its Level field as a list ("B1, A2"): a note can have several Levels. */
function levelListType(): NoteType {
  const base = builtinType('legacyVocabDe', NOW);
  return {
    id: 'nt-u2-level-list',
    name: 'German words, Level list',
    kind: base.kind,
    fields: base.fields.map((f) => (f.name === 'Level' ? { ...f, multiSep: ',' } : f)),
    templates: base.templates,
    sortField: base.sortField,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

interface LibraryOptions {
  notes: number;
  /** The card type (default: the built-in German words type). */
  type?: NoteType;
  /** The Level text of note i (default: one of LEVELS). */
  level?: (rnd: Random, i: number) => string;
}

/**
 * A library of German words in two decks: random Level and Type values,
 * random note order (newPos), random card states and due dates, and the
 * cards array SHUFFLED (the store keeps cards in any order).
 */
function randomLibrary(rnd: Random, options: LibraryOptions): DataStateV3 {
  const type = options.type ?? builtinType('legacyVocabDe', NOW);
  const levelAt = type.fields.findIndex((f) => f.name === 'Level');
  const typeAt = type.fields.findIndex((f) => f.name === 'Type');
  const levelOf = options.level ?? ((r: Random) => r.pick(LEVELS));
  const decks = [makeDeckV3({ id: 'd1', name: 'One', order: 0 }), makeDeckV3({ id: 'd2', name: 'Two', order: 1 })];
  const groups = Array.from({ length: options.notes }, (_, i) => {
    const level = levelOf(rnd, i);
    const wordType = rnd.pick(TYPES);
    return noteWithCards(
      {
        deckId: rnd.pick(decks).id,
        typeId: type.id,
        fields: type.fields.map((_, f) => (f === 0 ? `Wort ${i}` : f === levelAt ? level : f === typeAt ? wordType : '')),
        note: { id: `n${i}`, order: rnd.int(0, 40) },
        card: { id: `c${i}`, ...lifeValues(rnd.pick(LIFE_KEYS), NOW), due: NOW + rnd.int(-5, 5) * DAY },
      },
      [type],
    );
  });
  const state = stateOfV3({ decks, types: [type], groups });
  return { ...state, cards: rnd.shuffle(state.cards) };
}

/** The three kinds of library the tests run on, `seeds` seeded libraries each. */
const VARIANTS: readonly { name: string; make: (rnd: Random) => DataStateV3 }[] = [
  { name: 'Level A1–C2 or none', make: (rnd) => randomLibrary(rnd, { notes: 150 }) },
  {
    name: 'Level as a list (several values per note)',
    make: (rnd) =>
      randomLibrary(rnd, {
        notes: 150,
        type: levelListType(),
        // 0 to 3 Levels per note; note 0 always has two, so the "smallest rank" rule is reached.
        level: (r, i) => r.sample(LEVELS.slice(0, 6), i === 0 ? 2 : r.int(0, 3)).join(', '),
      }),
  },
  {
    name: 'Level with one value that is not CEFR (a text group)',
    make: (rnd) => randomLibrary(rnd, { notes: 150, level: (r, i) => (i === 0 ? 'Expert' : r.pick(LEVELS)) }),
  },
];
const SEEDS = [1, 2, 3, 4, 5, 6];

/** The Level of a card's note as the library sees it (folded values), [] when it has none. */
function levelValues(state: DataStateV3, card: Card): string[] {
  const index = libraryIndexOf(state);
  const note = index.noteById.get(card.noteId) as Note;
  return index.facetValues(note).get('level') ?? [];
}

/* ------------------------------------------------------------------ (a) same keys, same orders */

describe('unit U2 — a field sort key is EXACTLY the old formula (rank of each value computed once)', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: the keys and every sort path give the reference order, asc and desc`, () => {
      for (const seed of SEEDS) {
        const state = variant.make(createRandom(`u2-${variant.name}-${seed}`));
        const ctx = matchCtxOf(state, NOW);
        const sctx = scheduleCtxOf(state, ctx);
        const ref = referenceCtx(state);
        for (const sort of FIELD_SORTS) {
          const label = [variant.name, seed, sort];
          // The keys themselves, card by card.
          expect([label, state.cards.map((c) => sctx.sortKey!(c, sort))]).toEqual([
            label,
            state.cards.map((c) => ref.sortKey!(c, sort)),
          ]);
          const expected = ids(sortCards(state.cards, sort, ref));
          expect([label, ids(sortCards(state.cards, sort, sctx))]).toEqual([label, expected]);
          expect([label, ids(orderCards(state.cards, sort, sctx))]).toEqual([label, expected]);
          const positions = orderPositions(state.cards, sort, sctx);
          expect(positions).not.toBeNull();
          expect([label, positions!.map((i) => state.cards[i].id)]).toEqual([label, expected]);
          // The Library's sort: the whole library (it makes and keeps its order), then lists cut from it or sorted alone.
          for (const q of QUERIES) {
            const pool = scopePool(state, q, ctx, 'browse');
            expect([label, q, ids(sortScopeCards(pool, sort, state, ctx))]).toEqual([label, q, ids(sortCards(pool, sort, ref))]);
          }
        }
      }
    });
  }

  it('a few cards change (new place, other deck): repairPositions and the repaired kept order give the reference order', () => {
    for (const seed of SEEDS) {
      const rnd = createRandom(`u2-repair-${seed}`);
      const state = randomLibrary(rnd, { notes: 150 });
      const ctx = matchCtxOf(state, NOW);
      for (const sort of FIELD_SORTS) {
        const kept = orderPositions(state.cards, sort, scheduleCtxOf(state, ctx))!;
        // The Library keeps the whole library's order of this sort.
        sortScopeCards(state.cards, sort, state, ctx);
        // 3 cards (at most 1/20 of 150, so the kept order is repaired, not made again).
        const changed = rnd.sample(state.cards.map((_, i) => i), 3).sort((a, b) => a - b);
        const cards = state.cards.slice();
        for (const i of changed) cards[i] = { ...cards[i], newPos: rnd.int(0, 40), deckId: rnd.pick(['d1', 'd2']) };
        const next: DataStateV3 = { ...state, cards };
        const nextCtx = matchCtxOf(next, NOW);
        const expected = ids(sortCards(cards, sort, referenceCtx(next)));
        const repaired = repairPositions(cards, kept, changed, sort, scheduleCtxOf(next, nextCtx));
        expect([seed, sort, repaired.map((i) => cards[i].id)]).toEqual([seed, sort, expected]);
        expect([seed, sort, ids(sortScopeCards(cards, sort, next, nextCtx))]).toEqual([seed, sort, expected]);
      }
    }
  });

  it('the variants reach the paths they are for: a CEFR rank, the smallest of several ranks, a text key', () => {
    const plain = VARIANTS[0].make(createRandom('u2-reach-plain'));
    const list = VARIANTS[1].make(createRandom('u2-reach-list'));
    const text = VARIANTS[2].make(createRandom('u2-reach-text'));
    const keyOf = (state: DataStateV3) => scheduleCtxOf(state, matchCtxOf(state, NOW)).sortKey!;

    // Plain: B1 is rank 3 (ordinal.ts: A1 = 1 … C2 = 6).
    const b1 = plain.cards.find((c) => levelValues(plain, c).join() === 'b1')!;
    expect(keyOf(plain)(b1, LEVEL)).toBe(3);

    // A list: note 0 has two Levels; its key is the SMALLER rank.
    const c0 = list.cards.find((c) => c.id === 'c0')!;
    const values = levelValues(list, c0);
    expect(values.length).toBe(2);
    const ranks = values.map((v) => ({ a1: 1, a2: 2, b1: 3, b2: 4, c1: 5, c2: 6 })[v]!);
    expect(keyOf(list)(c0, LEVEL)).toBe(Math.min(...ranks));

    // 'Expert' is not a CEFR level, so the Level group is text: the key is the folded value itself.
    const expert = text.cards.find((c) => c.id === 'c0')!;
    expect(keyOf(text)(expert, LEVEL)).toBe('expert');
  });
});

/* ------------------------------------------------------------------ (b) one ctx, several fields */

describe('unit U2 — one sort key function asked for several fields gives a fresh one’s key each time', () => {
  it('Level, then Type, then Level again, then A–Z (and all mixed card by card)', () => {
    for (const seed of SEEDS) {
      const state = randomLibrary(createRandom(`u2-switch-${seed}`), { notes: 120 });
      const key = scheduleCtxOf(state, matchCtxOf(state, NOW)).sortKey!;
      const fresh = (card: Card, sort: SortSpec) => scheduleCtxOf(state, matchCtxOf(state, NOW)).sortKey!(card, sort);
      const ref = referenceFieldKey(state);
      // One field after the other, every card each time (the way a sort asks).
      for (const sort of [LEVEL, TYPE, LEVEL, AZ, LEVEL_DESC]) {
        for (const card of state.cards) {
          const k = key(card, sort);
          expect([seed, sort, card.id, k]).toEqual([seed, sort, card.id, fresh(card, sort)]);
          if (sort.by === 'field') expect([seed, sort, card.id, k]).toEqual([seed, sort, card.id, ref(card, sort)]);
        }
      }
      // Mixed: the field changes on EVERY call.
      for (const card of state.cards) {
        for (const sort of [TYPE, LEVEL, AZ, LEVEL, TYPE]) {
          expect([seed, sort, card.id, key(card, sort)]).toEqual([seed, sort, card.id, fresh(card, sort)]);
        }
      }
    }
  });

  /*
   * The next two tests use a value that has a DIFFERENT rank in two places
   * (ordinal.ts): "N1" is JLPT level N1 = rank 5 when every value of the
   * group is N1 … N5, but "Lesson N1" = rank 1 (kind 'natural', the number
   * at the end) when the group also has "N12". So a rank kept for the wrong
   * field, or for the wrong library index, gives a wrong key here.
   */

  /** The German words card type with its Type field renamed "Lesson": two ordinal groups, Level and Lesson. */
  function levelAndLessonType(): NoteType {
    const base = builtinType('legacyVocabDe', NOW);
    return {
      id: 'nt-u2-level-lesson',
      name: 'Words with a lesson',
      kind: base.kind,
      fields: base.fields.map((f) => (f.name === 'Type' ? { ...f, name: 'Lesson' } : f)),
      templates: base.templates,
      sortField: base.sortField,
      createdAt: NOW,
      updatedAt: NOW,
    };
  }

  /** A library of notes with these [Level, Lesson] values; note i has card c{i}. */
  function levelsAndLessons(values: readonly [string, string][]): DataStateV3 {
    const type = levelAndLessonType();
    const levelAt = type.fields.findIndex((f) => f.name === 'Level');
    const lessonAt = type.fields.findIndex((f) => f.name === 'Lesson');
    return stateOfV3({
      decks: [makeDeckV3({ id: 'd', name: 'D' })],
      types: [type],
      groups: values.map(([level, lesson], i) =>
        noteWithCards(
          {
            deckId: 'd',
            typeId: type.id,
            fields: type.fields.map((_, f) => (f === 0 ? `Wort ${i}` : f === levelAt ? level : f === lessonAt ? lesson : '')),
            note: { id: `n${i}` },
            card: { id: `c${i}`, ...lifeValues('review', NOW) },
          },
          [type],
        ),
      ),
    });
  }

  it('the kept ranks belong to ONE field: the same value "N1" is rank 5 for Level (JLPT) and 1 for Lesson', () => {
    const LESSON: SortSpec = { by: 'field', field: 'lesson' };
    const state = levelsAndLessons([
      ['N1', 'N1'],
      ['N5', 'N12'],
      ['N3', 'N3'],
    ]);
    const key = scheduleCtxOf(state, matchCtxOf(state, NOW)).sortKey!;
    const ref = referenceFieldKey(state);
    // Level first, then Lesson, then Level again, then mixed card by card — one function the whole time.
    expect(state.cards.map((c) => key(c, LEVEL))).toEqual([5, 1, 3]);
    expect(state.cards.map((c) => key(c, LESSON))).toEqual([1, 12, 3]);
    expect(state.cards.map((c) => key(c, LEVEL))).toEqual([5, 1, 3]);
    for (const card of state.cards) {
      for (const sort of [LESSON, LEVEL, AZ, LESSON]) {
        if (sort.by === 'field') expect([card.id, sort, key(card, sort)]).toEqual([card.id, sort, ref(card, sort)]);
        else expect(key(card, sort)).toEqual(scheduleCtxOf(state, matchCtxOf(state, NOW)).sortKey!(card, sort));
      }
    }
    const ctx = matchCtxOf(state, NOW);
    expect(ids(sortScopeCards(state.cards, LEVEL, state, ctx))).toEqual(['c1', 'c2', 'c0']);
    expect(ids(sortScopeCards(state.cards, LESSON, state, ctx))).toEqual(['c0', 'c2', 'c1']);
  });

  it('the kept ranks belong to ONE library index: after a note edit the same value can get another rank', () => {
    const before = levelsAndLessons([
      ['N1', ''],
      ['N5', ''],
      ['N3', ''],
    ]);
    const keyBefore = scheduleCtxOf(before, matchCtxOf(before, NOW)).sortKey!;
    // N1 … N5: JLPT levels (N5 = 1 … N1 = 5).
    expect(before.cards.map((c) => keyBefore(c, LEVEL))).toEqual([5, 1, 3]);

    // The note edit: note 1 is now "N12" (a new notes array, so a new library
    // index). "N12" is no JLPT level, so the group is 'natural' now and the
    // UNCHANGED value "N1" of note 0 gets rank 1.
    const levelAt = before.noteTypes[0].fields.findIndex((f) => f.name === 'Level');
    const edited = { ...before.notes[1], fields: before.notes[1].fields.map((v, f) => (f === levelAt ? 'N12' : v)) };
    const after: DataStateV3 = { ...before, notes: [before.notes[0], edited, before.notes[2]] };
    expect(libraryIndexOf(after)).not.toBe(libraryIndexOf(before));
    const keyAfter = scheduleCtxOf(after, matchCtxOf(after, NOW)).sortKey!;
    expect(after.cards.map((c) => keyAfter(c, LEVEL))).toEqual([1, 12, 3]);
    expect(after.cards.map((c) => keyAfter(c, LEVEL))).toEqual(after.cards.map((c) => referenceFieldKey(after)(c, LEVEL)));
    expect(ids(sortScopeCards(after.cards, LEVEL, after, matchCtxOf(after, NOW)))).toEqual(['c0', 'c2', 'c1']);
    // The old index still gives its own ranks.
    expect(before.cards.map((c) => keyBefore(c, LEVEL))).toEqual([5, 1, 3]);
    expect(ids(sortScopeCards(before.cards, LEVEL, before, matchCtxOf(before, NOW)))).toEqual(['c1', 'c2', 'c0']);
  });
});

/* ------------------------------------------------------------------ (c) no Level: always last */

describe('unit U2 — a card with no Level gets NO_SORT_KEY and stays last in both directions', () => {
  it('sortScopeCards, orderCards and sortCards put every card without a Level at the end, asc and desc', () => {
    for (const seed of SEEDS) {
      const state = randomLibrary(createRandom(`u2-none-${seed}`), { notes: 150 });
      const ctx = matchCtxOf(state, NOW);
      const sctx = scheduleCtxOf(state, ctx);
      const without = new Set(ids(state.cards.filter((c) => levelValues(state, c).length === 0)));
      expect(without.size).toBeGreaterThan(0);
      for (const id of without) {
        const card = state.cards.find((c) => c.id === id)!;
        expect(sctx.sortKey!(card, LEVEL)).toBe(NO_SORT_KEY);
        expect(sctx.sortKey!(card, LEVEL_DESC)).toBe(NO_SORT_KEY);
      }
      for (const sort of [LEVEL, LEVEL_DESC]) {
        for (const result of [
          sortScopeCards(state.cards, sort, state, ctx),
          orderCards(state.cards, sort, sctx),
          sortCards(state.cards, sort, sctx),
        ]) {
          const tail = ids(result.slice(result.length - without.size));
          expect([seed, sort, new Set(tail)]).toEqual([seed, sort, without]);
          // The cards with a Level come first, in rank order (low → high, or high → low with 'desc').
          const ranks = result.slice(0, result.length - without.size).map((c) => sctx.sortKey!(c, sort) as number);
          const inOrder = [...ranks].sort((a, b) => (sort.dir === 'desc' ? b - a : a - b));
          expect([seed, sort, ranks]).toEqual([seed, sort, inOrder]);
        }
      }
    }
  });
});
