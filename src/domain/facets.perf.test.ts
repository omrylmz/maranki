/**
 * Perf guard for the facet engine (spec §4.3 "Budget": `deriveFacets` on a
 * 16,000-card pool in < 150 ms in node).
 *
 * W4-7: a fixed "< 150 ms" failed once at 282 ms while the test machine was
 * loaded (load average 37), and passed on the next run. A wall clock on a
 * busy machine cannot prove a fixed budget. So the guard now counts the CPU
 * time of the test process (process.cpuUsage: waiting for the processor is
 * not counted) and proves what a busy machine cannot change:
 *   - the time GROWS LINEARLY with the pool: 16,000 cards take less than 10
 *     times as long as 4,000 cards (linear ≈ 4, quadratic ≈ 16; see
 *     MAX_GROWTH). The two sizes are measured in turns (16k, 4k, 16k, 4k …),
 *     so a moment of load slows both;
 *   - each time is the fastest of 5 cold runs (load slows some runs, never
 *     all of them), and a spoiled try is measured again (up to 3 tries);
 *   - the spec budget is kept as a generous upper bound: 5 × 150 ms. The
 *     real budget is checked on the phone with the dev timings
 *     (perfMarks 'facets', spec §8.3).
 *
 * The pool copies the shape of German_Complete with both directions (15,960
 * cards): three card types (Vocabulary, Verbs, Grammar), a Level field on all
 * three, a multi-value Tags field on Verbs, HTML in the example fields,
 * sections "Vocabulary::A1" …, and cards in every status.
 *
 * Each run is COLD: it uses fresh copies of the note objects and a fresh
 * library index. The per-note caches (search text, section path, tags, facet
 * values, and since unit P1 the facet engine's own per-note data, facets.ts
 * NoteFacets) are WeakMaps keyed by the note OBJECT, some of them shared by
 * every index with the same filter fields (libraryIndex.ts), so only new
 * objects make sure that the time includes the first computation of every
 * note's values (the first FacetSheet open after the notes changed). The
 * copies and the index are made before the clock starts: the selectors build
 * the index when the notes change, not when the sheet opens.
 *
 * The WARM case (the Library warmed its caches while the phone was idle,
 * scope.ts warmLibraryCaches) has its guard in library.perf.test.ts.
 */
import { describe, expect, it } from '@jest/globals';

import { FIXED_NOW as NOW } from '../test/clock';
import { createRandom } from '../test/random';
import { deriveFacets } from './facets';
import { buildLibraryIndex } from './libraryIndex';
import { listsById } from './lists';
import { makeCard, makeDeck, makeNote } from './makeV3';
import type { Card, Note, NoteType, Query } from './model';
import type { MatchCtx } from './query';
import { DAY, DEFAULT_SRS, HOUR } from './types';

/** The spec budget (§4.3) for 16,000 cards in node. */
const BUDGET_MS = 150;
/** The generous upper bound this test checks: 5 × the budget (see the file comment). */
const GENEROUS_MS = 5 * BUDGET_MS;
/**
 * 4 times the cards may take at most this many times as long: linear ≈ 4
 * (measured in CPU time: 4.2 to 5 alone, up to about 6 with three whole test
 * suites running at once, because the big pool suffers more from a busy
 * memory cache), quadratic ≈ 16.
 */
const MAX_GROWTH = 10;
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const VERB_TAGS = ['regular', 'irregular', 'separable', 'inseparable', 'mixed', 'sein', 'haben', 'reflexive', 'modal'];

function type(id: string, name: string, fields: string[], templates: string[]): NoteType {
  return {
    id,
    name,
    kind: 'standard',
    fields: fields.map((f, i) => ({ name: f, role: i === 0 ? 'term' : 'detail', facet: 'auto' })),
    templates: templates.map((t, ord) => ({ ord, name: t, prompt: [ord === 0 ? 0 : 1], answer: [ord === 0 ? 1 : 0] })),
    sortField: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const VOCAB = type('nt-vocab', 'German Vocabulary', ['Word', 'Grammar', 'Examples', 'Translation', 'Level'], ['DE-EN', 'EN-DE']);
const VERBS = type('nt-verbs', 'German Verbs', ['Verb', 'Meaning', 'Conjugation', 'Example', 'Level', 'Tags'], ['DE-EN', 'EN-DE']);
const GRAMMAR = type('nt-grammar', 'German Grammar', ['Question', 'Answer', 'Example', 'Level'], ['Grammar Card']);

/** A pool of about `size` cards (16,000 → about 8,000 notes), seeded (the same pool on every run). */
function germanLikePool(size = 16_000): { notes: Note[]; cards: Card[]; types: NoteType[] } {
  const rnd = createRandom('facets-perf');
  const notes: Note[] = [];
  const cards: Card[] = [];
  let i = 0;
  const addNote = (t: NoteType, fields: string[], section: string, ords: number[]) => {
    const note = makeNote({ id: `n${i}`, typeId: t.id, fields, section, order: i }, NOW);
    notes.push(note);
    for (const ord of ords) {
      const roll = rnd.int(0, 9);
      const srs =
        roll < 5
          ? {}
          : roll < 7
            ? { reps: 1, stepIndex: 0, intervalDays: 0, due: NOW - HOUR }
            : roll < 9
              ? { reps: 5, stepIndex: null, intervalDays: rnd.int(1, 60), due: NOW + rnd.int(-3, 10) * DAY }
              : { knownAt: NOW - DAY };
      cards.push(makeCard(note, ord, 'd-german', DEFAULT_SRS, NOW, { id: `c${i}-${ord}`, fav: rnd.bool(0.05), ...srs }));
    }
    i += 1;
  };
  while (cards.length < size - 2) {
    const level = rnd.pick(LEVELS);
    const kind = rnd.int(0, 9);
    if (kind < 7) {
      addNote(
        VOCAB,
        [`das Wort ${i}`, rnd.bool(0.3) ? '-e' : '', `<div class="example">Ein Beispiel Nummer ${i}.</div>`, `word ${i} / term`, level],
        `Vocabulary::${level}`,
        [0, 1],
      );
    } else if (kind < 9) {
      const tags = rnd.sample(VERB_TAGS, rnd.int(1, 3)).join(', ');
      addNote(VERBS, [`verb${i}en`, `to verb ${i}`, `regular: ich verbe, du verbst ${i}`, `Ich verbe ${i}.`, level, tags], `Verbs::${level}`, [0, 1]);
    } else {
      addNote(GRAMMAR, [`Question ${i}?`, `Answer ${i}.`, `Beispiel ${i}`, level], `Grammar::${level}`, [0]);
    }
  }
  return { notes, cards, types: [VOCAB, VERBS, GRAMMAR] };
}

const POOL = germanLikePool();
/** The same kind of pool with a quarter of the cards: the base of the growth check. */
const QUARTER_POOL = germanLikePool(4_000);

/**
 * The CPU time this process has used, in ms (the wall clock where
 * `process.cpuUsage` is missing). CPU time, not the wall clock: the time the
 * test waits while other programs use the processor is not counted.
 */
const clockMs = (): number => {
  if (typeof process !== 'undefined' && typeof process.cpuUsage === 'function') {
    const used = process.cpuUsage();
    return (used.user + used.system) / 1000;
  }
  return Date.now();
};

/**
 * ONE cold run on `pool`: new copies of the notes (so no per-note cache has
 * them yet) and a new index over them, then one timed deriveFacets. The
 * cards stay the same: they point at notes by id, not by object. The time
 * is in ms.
 */
function coldMs(pool: typeof POOL, scope: Query, selection: Query): number {
  const freshNotes = pool.notes.map((note) => ({ ...note }));
  const index = buildLibraryIndex(freshNotes, pool.types);
  const ctx: MatchCtx = {
    now: NOW,
    index,
    decks: new Map([['d-german', makeDeck({ id: 'd-german', name: 'German' }, NOW)]]),
    lists: listsById([]),
  };
  const start = clockMs();
  deriveFacets(pool.cards, scope, selection, ctx);
  const ms = clockMs() - start;
  // The run really was cold: its notes are not the shared pool objects.
  expect(index.noteById.get(pool.cards[0].noteId)).not.toBe(pool.notes[0]);
  return ms;
}

/**
 * The fastest cold time of the full pool and of the quarter pool, measured
 * in TURNS (full, quarter, full, quarter …), so a moment of load slows both
 * sizes, not one of them. Up to 3 tries of 5 turns: a busy machine can make
 * one try look bad, but quadratic work looks bad in every try (about 16 ×).
 */
function coldTimes(scope: Query, selection: Query): { full: number; growth: number } {
  let best = { full: Number.POSITIVE_INFINITY, growth: Number.POSITIVE_INFINITY };
  for (let attempt = 0; attempt < 3 && best.growth >= MAX_GROWTH; attempt++) {
    let full = Number.POSITIVE_INFINITY;
    let quarter = Number.POSITIVE_INFINITY;
    for (let turn = 0; turn < 5; turn++) {
      full = Math.min(full, coldMs(POOL, scope, selection));
      quarter = Math.min(quarter, coldMs(QUARTER_POOL, scope, selection));
    }
    // A run under 1 ms counts as 1 ms, so timer noise on a tiny run cannot look like quadratic growth.
    const growth = full / Math.max(quarter, 1);
    if (growth < best.growth) best = { full, growth };
  }
  return best;
}

/** The checks of one query: linear growth from 4,000 to 16,000 cards, and 16,000 under the generous bound. */
function expectWithinBudget(scope: Query, selection: Query): void {
  const { full, growth } = coldTimes(scope, selection);
  expect(growth).toBeLessThan(MAX_GROWTH);
  expect(full).toBeLessThan(GENEROUS_MS);
}

describe('deriveFacets perf guard (16k cards)', () => {
  it('the pool has the German_Complete shape', () => {
    expect(POOL.cards.length).toBeGreaterThanOrEqual(15_990);
    const index = buildLibraryIndex(POOL.notes, POOL.types);
    expect([...index.fieldSpecs.keys()].sort()).toEqual(['level', 'tags']);
    const facets = deriveFacets(POOL.cards, {}, {}, {
      now: NOW,
      index,
      decks: new Map([['d-german', makeDeck({ id: 'd-german', name: 'German' }, NOW)]]),
      lists: listsById([]),
    });
    expect(facets.map((f) => f.key)).toEqual(
      expect.arrayContaining(['section', 'field:level', 'field:tags', 'direction', 'life']),
    );
  });

  it('the quarter pool has the same shape with about 4,000 cards', () => {
    expect(QUARTER_POOL.cards.length).toBeGreaterThanOrEqual(3_990);
    expect(QUARTER_POOL.cards.length).toBeLessThanOrEqual(4_000);
    expect(POOL.cards.length / QUARTER_POOL.cards.length).toBeCloseTo(4, 1);
  });

  it(`no selection: linear in the cards (4 × the cards < ${MAX_GROWTH} × the time), 16k in < ${GENEROUS_MS} ms`, () => {
    expectWithinBudget({}, {});
  });

  it(`a deck scope and four chips (Level, status, a tag, text): linear, 16k in < ${GENEROUS_MS} ms`, () => {
    const selection: Query = { fields: { level: ['b1', 'b2'] }, life: ['new', 'learning'], tags: ['x'], text: 'wort' };
    expectWithinBudget({ decks: ['d-german'] }, selection);
  });
});
