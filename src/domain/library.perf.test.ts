/**
 * Unit P1 — the Library on a German_Complete-sized library (16,000 cards).
 *
 * The release build on the device (16,260 cards, Hermes) needed: Library
 * filter 25–68 ms (budget 30), the first A–Z sort 685 ms and every later
 * one 150–237 ms, the first search 234 ms, and 94–133 ms per FacetSheet
 * opening (budget 80). Unit P1 made these paths faster WITHOUT changing a
 * single row or count. This file proves both on a big pool:
 *
 *   1. EXACTLY THE SAME RESULTS. The rows of the Library (libraryState
 *      rowsReader: filter, sort, headline rank) equal the OLD path — the
 *      comparator sort of schedule.ts (sortCards) with the old A–Z key
 *      (faceSortKey of the whole face) and the old headline rank (whole
 *      faces) — for many queries and every sort, also after an edit, an
 *      undo, a rating and an import, for an empty result and an empty
 *      library. The filter groups (deriveFacets) equal GOLDEN signatures
 *      that were recorded with the engine BEFORE unit P1.
 *   2. SPEED GUARDS in the style of facets.perf.test.ts: CPU time (waiting
 *      for the processor is not counted), the fastest of several runs, the
 *      time grows LINEARLY from 4,000 to 16,000 cards (linear ≈ 4,
 *      quadratic ≈ 16: MAX_GROWTH 10), and a generous upper bound in node.
 *      The real budgets are measured on the phone (perfMarks 'filter' and
 *      'facets', spec §11 E2). One guard compares the new A–Z with the old
 *      comparator sort on the same machine: it must be several times faster.
 *      Review 2: after a rating, "Due date" and "Hardest first" REPAIR the
 *      kept order (only the rated card moves); a guard checks that this is
 *      no slower than sorting the list alone (what the code before unit P1
 *      did), and the rows stay the old rows after many ratings.
 *
 * Unit P2 adds two guards. (1) The warm-up runs in PARTS, the search text
 * first (scope.ts WARM_PASSES): after only that part, the first search
 * costs a fraction of a cold one (the release device: 234 ms for the first
 * 'zeit', budget 30). (2) Making the library's order the first time per
 * sort (scope.ts makeLibraryOrder, schedule.ts orderPositions) is no slower
 * than the plain comparator sort it replaced (sortCards) on the whole
 * library — before unit P2 it was 20–40 % slower for Due date, Hardest
 * first, Recently added and Deck order. Both compare two timings on the
 * same machine (a ratio), never an absolute time.
 *
 * Unit P4 (the release re-measure: "Deck order" with a Level chip 36–54 ms,
 * the same pool re-sorted A–Z 5–12 ms) adds: the OLD path filters with the
 * query test itself (oldPool), Section and Card type queries, and guards
 * (after the warm-up) — a NEW Level / Section filter in Deck order, its
 * pool and rows included, costs at most two thirds of the query test alone
 * on the same filter; the note-group pool of a Level chip is at least 1.5
 * times as fast as the query test; and with no filter, the rows are the
 * store's own array (scope.ts sortScopeRows: no copy) and cost less than a
 * fifth of ONE filter pass that copies the cards.
 *
 * P4 review 2: the timing helper of these guards (inTurns) started from
 * Infinity / Infinity, so its loop never ran and every guard passed without
 * a measurement. Now its first try always runs (a test checks the helper
 * itself), and each guard compares with a reference that does NOT share
 * the new code: the query test (oldPool), or the old pool of "no filter"
 * (a filter pass that copies the cards). Each guard fails on the code
 * before unit P4: there the Deck order list cost 1.02–1.13 times
 * the query test, the pool 1.0 times, and the no-filter opening 1.3 times
 * a filter pass (node with its JIT; this commit: 0.38–0.47, 0.32–0.42 and
 * 0.04).
 *
 * Unit P3 adds the guard of the app's REAL first time. The P2 guard sorts
 * `state.cards` itself (sortScopeCards' `cards === all` shortcut), but the
 * Library never does: rowsReader always sorts a NEW array from scopePool,
 * also with no filter. So the new guard sorts two such lists — the whole
 * library rebuilt as a new array (it makes the library's order, then
 * finds its cards in it) and one deck (sorted on its own) — and checks
 * the same rows as sortCards, the path each one takes, and a time no
 * longer than sortCards on the same list (the same ratio style).
 *
 * The pool copies the shape of German_Complete with both directions: three
 * Anki card types (Vocabulary, Verbs, Grammar) with a Level field, a German
 * term field (A–Z by the word, not the article), HTML examples, sections
 * "Vocabulary::A1" …, one small deck made in the app (deck languages), and
 * cards in every status.
 */
import { describe, expect, it } from '@jest/globals';

import { createRowsCache, rowsReader } from '../components/library/libraryState';
import { FIXED_NOW as NOW } from '../test/clock';
import { createRandom } from '../test/random';
import { faceOfCard, faceSortKey } from './face';
import { deriveFacets, type Facet } from './facets';
import { fnv1a } from './hash';
import { makeCard, makeDeck, makeNote } from './makeV3';
import type { Card, DataStateV3, Deck, Id, Note, NoteType, Query, ScheduleCtx, SortSpec } from './model';
import { compileQuery, type MatchCtx, serializeQuery } from './query';
import {
  cardLookupOf,
  LIBRARY_ORDER_MIN_SHARE,
  matchCtxOf,
  noteSetsReady,
  scheduleCtxOf,
  scopePool,
  sortScopeCards,
  warmDoneAt,
  warmLibraryCaches,
  warmLibraryOrder,
  warmLibraryOrderOf,
  warmNoteSets,
} from './scope';
import { orderCards, sortCards } from './schedule';
import { foldText, oneLine } from './text';
import { DAY, DEFAULT_SRS, HOUR } from './types';
import { makeStateV3 } from '../test/factoriesV3';

/* ------------------------------------------------------------------ the pool */

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const VERB_TAGS = ['regular', 'irregular', 'separable', 'inseparable', 'mixed', 'sein', 'haben', 'reflexive', 'modal'];
const ARTICLES = ['der ', 'die ', 'das ', '', 'der/die '];
const SYLLABLES = ['ab', 'an', 'bau', 'zeit', 'haus', 'kind', 'arbeit', 'über', 'stra', 'ße', 'ung', 'lich', 'ein', 'fahr', 'ä', 'ö', 'mut'];

function type(
  id: string,
  name: string,
  fields: [string, NoteType['fields'][number]['role'], string?][],
  templates: [string, number, number][],
  anki = true,
): NoteType {
  return {
    id,
    name,
    kind: 'standard',
    fields: fields.map(([f, role, lang]) => ({ name: f, role, facet: 'auto', ...(lang ? { lang } : {}) })),
    templates: templates.map(([t, prompt, answer], ord) => ({ ord, name: t, prompt: [prompt], answer: [answer] })),
    sortField: 0,
    ...(anki ? { source: { ankiMid: id } } : {}),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const VOCAB = type(
  'nt-vocab',
  'German Vocabulary',
  [['Word', 'term', 'de-DE'], ['Grammar', 'detail'], ['Examples', 'example', 'de-DE'], ['Translation', 'meaning', 'en-US'], ['Level', 'badge']],
  [['DE-EN', 0, 3], ['EN-DE', 3, 0]],
);
const VERBS = type(
  'nt-verbs',
  'German Verbs',
  [['Verb', 'term', 'de-DE'], ['Meaning', 'meaning', 'en-US'], ['Conjugation', 'detail'], ['Example', 'example'], ['Level', 'badge'], ['Tags', 'detail']],
  [['Forward', 0, 1], ['Reverse', 1, 0]],
);
const GRAMMAR = type('nt-grammar', 'German Grammar', [['Question', 'term'], ['Answer', 'meaning'], ['Example', 'example'], ['Level', 'badge']], [['Grammar Card', 0, 1]]);
/** A card type made in the app (no Anki model): it takes its languages from its deck. */
const MINE = type('nt-mine', 'My words', [['Front', 'term'], ['Back', 'meaning']], [['Front', 0, 1], ['Back', 1, 0]], false);

interface Pool {
  state: DataStateV3;
  decks: Deck[];
}

/** About `size` cards (16,000 → ~8,000 notes), seeded: the same pool on every run. */
function germanPool(size = 16_000): Pool {
  const rnd = createRandom(`library-perf-${size}`);
  const decks = [
    makeDeck({ id: 'd-vocab', name: 'German Vocabulary', order: 0 }, NOW),
    makeDeck({ id: 'd-verbs', name: 'German Verbs', order: 1 }, NOW),
    makeDeck({ id: 'd-grammar', name: 'German Grammar', order: 2 }, NOW),
    { ...makeDeck({ id: 'd-mine', name: 'My words', order: 3 }, NOW), language: 'de-DE', meaningLanguage: 'en-US' },
  ];
  const notes: Note[] = [];
  const cards: Card[] = [];
  let i = 0;
  const word = () => {
    const w = Array.from({ length: rnd.int(1, 3) }, () => rnd.pick(SYLLABLES)).join('');
    return w.charAt(0).toUpperCase() + w.slice(1);
  };
  const add = (t: NoteType, deckId: Id, fields: string[], section: string, ords: number[]) => {
    const note = makeNote({ id: `n${i}`, typeId: t.id, fields, section, order: i, tags: rnd.bool(0.1) ? ['Topic::Travel'] : [] }, NOW);
    notes.push(note);
    for (const ord of ords) {
      const roll = rnd.int(0, 9);
      const srs =
        roll < 4
          ? {}
          : roll < 5
            ? { newState: 'notStarted' as const }
            : roll < 7
              ? { reps: 1, stepIndex: 0, intervalDays: 0, due: NOW - HOUR }
              : roll < 9
                ? { reps: 5, stepIndex: null, intervalDays: rnd.int(1, 60), due: NOW + rnd.int(-3, 10) * DAY, ease: rnd.pick([1.5, 2.5]) }
                : { knownAt: NOW - DAY };
      cards.push(
        makeCard(note, ord, deckId, DEFAULT_SRS, NOW, {
          id: `c${i}-${ord}`,
          fav: rnd.bool(0.05),
          createdAt: NOW - rnd.int(0, 30) * DAY,
          ...srs,
        }),
      );
    }
    i += 1;
  };
  while (cards.length < size - 2) {
    const level = rnd.pick(LEVELS);
    const kind = rnd.int(0, 19);
    if (kind < 14) {
      const w = word();
      add(
        VOCAB,
        'd-vocab',
        [`${rnd.pick(ARTICLES)}${w}`, rnd.bool(0.3) ? '-e' : '', `<div class="example">Das ${w} ist hier.</div><div>Noch ${i}.</div>`, `${w.toLowerCase()} / thing ${i}`, level],
        `Vocabulary::${level}`,
        [0, 1],
      );
    } else if (kind < 17) {
      const v = `${word().toLowerCase()}en`;
      add(VERBS, 'd-verbs', [v, `to ${v}`, `ich ${v}e, du ${v}st`, `Ich ${v}e.`, level, rnd.sample(VERB_TAGS, rnd.int(1, 3)).join(', ')], `Verbs::${level}`, [0, 1]);
    } else if (kind < 19) {
      add(GRAMMAR, 'd-grammar', [`Question ${word()} ${i}?`, `Answer ${i}.`, `Beispiel ${i}`, level], `Grammar::${level}`, [0]);
    } else {
      const w = word();
      add(MINE, 'd-mine', [`die ${w}`, `the ${w.toLowerCase()}`], '', [0, 1]);
    }
  }
  return { state: makeStateV3({ noteTypes: [VOCAB, VERBS, GRAMMAR, MINE], notes, cards, decks }, NOW), decks };
}

const POOL = germanPool();
const QUARTER_POOL = germanPool(4_000);

/* ------------------------------------------------------------------ the old path */

/**
 * The scope pool as it was made BEFORE unit P4: the query test (query.ts
 * compileQuery) on every card. Unit P4 answers the Level, Section and Card
 * type groups from note lookups instead; the old path keeps the query test,
 * so it stays an independent reference.
 */
function oldPool(state: DataStateV3, q: Query, ctx: MatchCtx): Card[] {
  const match = compileQuery(q, ctx);
  return state.cards.filter((card) => match(card));
}

/**
 * The Library rows as they were made BEFORE unit P1: the scope pool (the
 * query test, oldPool), sorted by the comparator (sortCards) with the A–Z key
 * of the WHOLE face, then the old headline rank that built whole faces.
 */
function oldRows(state: DataStateV3, q: Query, sort: SortSpec, now = 0): Card[] {
  const ctx = matchCtxOf(state, now);
  const sctx = scheduleCtxOf(state, ctx);
  const fieldKey = sctx.sortKey!;
  const oldCtx: ScheduleCtx = {
    ...sctx,
    sortKey: (card, s) => (s.by === 'field' ? fieldKey(card, s) : faceSortKey(faceOfCard(card, ctx.index, ctx.decks))),
  };
  const sorted = sortCards(oldPool(state, q, ctx), sort, oldCtx);
  const needle = foldText(oneLine((q.text ?? '').replace(/"/g, ' ')));
  if (needle === '' || sorted.length < 2) return sorted;
  const parts: Card[][] = [[], [], []];
  for (const card of sorted) {
    const face = faceOfCard(card, ctx.index, ctx.decks);
    const plain = foldText(oneLine(face.prompt[0]?.plain ?? face.promptPlain));
    const key = faceSortKey(face);
    const rank = key === needle || plain === needle ? 0 : key.startsWith(needle) || plain.startsWith(needle) || plain.split(' ').includes(needle) ? 1 : 2;
    parts[rank].push(card);
  }
  return [...parts[0], ...parts[1], ...parts[2]];
}

/** The new path: what the Library shows (a fresh rows cache: no hit of an earlier list). */
function newRows(state: DataStateV3, q: Query, sort: SortSpec, now = 0): readonly Card[] {
  return rowsReader(createRowsCache(), serializeQuery(q), JSON.stringify(sort), now)(state);
}

const ids = (cards: readonly Card[]) => cards.map((c) => c.id);

const SORTS: SortSpec[] = (['source', 'due', 'az', 'newest', 'hardest', 'field'] as const).flatMap((by) => [
  { by, ...(by === 'field' ? { field: 'level' } : {}) },
  { by, dir: 'desc' as const, ...(by === 'field' ? { field: 'level' } : {}) },
]);

const QUERIES: Query[] = [
  {},
  { text: 'zeit' },
  { text: 'haus' },
  { text: 'die strasse' },
  { decks: ['d-vocab'], life: ['new'] },
  { decks: ['d-vocab'], fields: { level: ['b1'] } },
  { fields: { level: ['a1', 'c1'] } },
  { life: ['review', 'mastered'] },
  { flags: ['fav'] },
  { directions: [1] },
  { text: 'arbeit', decks: ['d-vocab'], fields: { level: ['b1'] } },
  { decks: ['d-mine'] },
  { text: 'zzzz-nothing' },
  // Unit P4: Section and Card type chips (the release device: "German + Vocabulary + B1" 53.6 ms).
  { decks: ['d-vocab'], sections: [{ deckId: 'd-vocab', path: 'vocabulary' }], fields: { level: ['b1'] } },
  { text: 'arbeit', sections: [{ deckId: 'd-vocab', path: 'vocabulary' }], fields: { level: ['b1'] } },
  { noteTypes: ['nt-verbs'], fields: { tags: ['regular', 'modal'] } },
  { sections: [{ deckId: 'd-verbs', path: 'verbs::b1' }, { deckId: 'd-grammar', path: 'grammar' }] },
];

/* ------------------------------------------------------------------ the golden facets */

/** Object keys in a fixed order, so the text depends only on the content. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) out[k] = canonical((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

/** A short signature of a facet list: every group, label, value, count and order. */
function facetSignature(facets: readonly Facet[]): string {
  return fnv1a(JSON.stringify(canonical(facets))).toString(16).padStart(8, '0');
}

const FACET_SELECTIONS: [Query, Query][] = [
  [{}, {}],
  [{}, { fields: { level: ['b1'] } }],
  [{}, { fields: { level: ['b1', 'b2'] }, life: ['new', 'learning'] }],
  [{}, { text: 'zeit' }],
  [{}, { text: 'arbeit', decks: ['d-vocab'], fields: { level: ['b1'] } }],
  [{}, { decks: ['d-vocab'], life: ['new'] }],
  [{}, { directions: [1], flags: ['fav'] }],
  [{}, { sections: [{ deckId: 'd-verbs', path: 'verbs::b1' }], fields: { tags: ['regular'] } }],
  [{ decks: ['d-verbs'] }, {}],
  [{ decks: ['d-mine'] }, { directions: [0] }],
];

/**
 * deriveFacets on the 16,000-card pool, recorded with the engine BEFORE
 * unit P1. If a later change of the facet rules changes
 * one on purpose, record the new value with that change and say so.
 */
const GOLDEN_FACETS: readonly string[] = [
  '1de92435', '32bd1092', '3b8d62d9', 'f9d579b7', '4ccfbd9c',
  '210bf1b9', '21e464b8', 'b521d030', 'a9c919b9', 'e2732462',
];

/* ------------------------------------------------------------------ timing */

/** The CPU time this process has used, in ms (see facets.perf.test.ts). */
const clockMs = (): number => {
  if (typeof process !== 'undefined' && typeof process.cpuUsage === 'function') {
    const used = process.cpuUsage();
    return (used.user + used.system) / 1000;
  }
  return Date.now();
};

/** 4 times the cards may take at most this many times as long (linear ≈ 4, quadratic ≈ 16). */
const MAX_GROWTH = 10;

/** The fastest of `runs` timings of `fn` (each run gets its own setup, not timed). */
function fastest<T>(runs: number, setup: () => T, fn: (input: T) => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < runs; r++) {
    const input = setup();
    const start = clockMs();
    fn(input);
    best = Math.min(best, clockMs() - start);
  }
  return best;
}

/** Linear growth from 4,000 to 16,000 cards (up to 3 tries) and the time of the big pool. */
function growth(measure: (pool: Pool) => number): { full: number; growth: number } {
  let best = { full: Number.POSITIVE_INFINITY, growth: Number.POSITIVE_INFINITY };
  for (let attempt = 0; attempt < 3 && best.growth >= MAX_GROWTH; attempt++) {
    const full = measure(POOL);
    const quarter = measure(QUARTER_POOL);
    const g = full / Math.max(quarter, 1);
    if (g < best.growth) best = { full, growth: g };
  }
  return best;
}

/** A copy of the pool with NEW note objects (every per-note cache is cold for it). */
function coldCopy(pool: Pool): DataStateV3 {
  return { ...pool.state, notes: pool.state.notes.map((n) => ({ ...n })) };
}

/* ------------------------------------------------------------------ the tests */

describe('unit P1 — the Library on 16,000 cards: exactly the old rows and counts', () => {
  it('the pool has the German_Complete shape', () => {
    expect(POOL.state.cards.length).toBeGreaterThanOrEqual(15_990);
    expect(QUARTER_POOL.state.cards.length).toBeGreaterThanOrEqual(3_990);
    const ctx = matchCtxOf(POOL.state, NOW);
    expect([...ctx.index.fieldSpecs.keys()].sort()).toEqual(['level', 'tags']);
  });

  it(`${QUERIES.length} queries × ${SORTS.length} sorts: the same rows in the same order as the old path`, () => {
    for (const q of QUERIES) {
      for (const sort of SORTS) {
        expect([q, sort, ids(newRows(POOL.state, q, sort))]).toEqual([q, sort, ids(oldRows(POOL.state, q, sort))]);
      }
    }
    expect(newRows(POOL.state, { text: 'zzzz-nothing' }, { by: 'az' })).toEqual([]);
  });

  it('an edit, an undo, a rating and an import between two lists: the old rows every time (no stale order or key)', () => {
    const start = POOL.state;
    const checks: Query[] = [{}, { text: 'haus' }, { decks: ['d-vocab'], fields: { level: ['b1'] } }];
    const sorts: SortSpec[] = [{ by: 'az' }, { by: 'az', dir: 'desc' }, { by: 'source' }, { by: 'due' }];
    const same = (state: DataStateV3, label: string) => {
      for (const q of checks) for (const sort of sorts) expect([label, q, sort, ids(newRows(state, q, sort))]).toEqual([label, q, sort, ids(oldRows(state, q, sort))]);
    };
    same(start, 'start');
    // An edit: the first note gets a headline that sorts first, and a new Level.
    const edited = { ...start, notes: start.notes.map((n, i) => (i === 0 ? { ...n, fields: ['das Aaa', ...n.fields.slice(1, 4), 'B1'] } : n)) };
    same(edited, 'edit');
    // Undo: the arrays from before come back.
    same(start, 'undo');
    // A rating: one card's schedule changes (a new cards array).
    const rated = { ...start, cards: start.cards.map((c, i) => (i === 10 ? { ...c, reps: 2, stepIndex: null, intervalDays: 3, due: NOW + 3 * DAY } : c)) };
    same(rated, 'rating');
    // An import: a second small library at the end.
    const extra = germanPool(400).state;
    const imported = {
      ...rated,
      notes: [...rated.notes, ...extra.notes.map((n) => ({ ...n, id: `x-${n.id}` }))],
      cards: [...rated.cards, ...extra.cards.map((c) => ({ ...c, id: `x-${c.id}`, noteId: `x-${c.noteId}` }))],
    };
    same(imported, 'import');
    // An empty library.
    const empty = makeStateV3({}, NOW);
    for (const sort of sorts) expect(newRows(empty, {}, sort)).toEqual([]);
  });

  it('review 2: Due date and Hardest first after 12 ratings, an undo and a reset — the old rows after every step (repaired, not sorted again)', () => {
    const rnd = createRandom('library-perf-ratings');
    const checks: Query[] = [{}, { fields: { level: ['b1'] } }, { life: ['review', 'mastered'] }, { decks: ['d-vocab'], life: ['new'] }];
    const sorts: SortSpec[] = [{ by: 'due' }, { by: 'due', dir: 'desc' }, { by: 'hardest' }, { by: 'hardest', dir: 'desc' }];
    const same = (state: DataStateV3, label: string) => {
      for (const q of checks) for (const sort of sorts) expect([label, q, sort, ids(newRows(state, q, sort))]).toEqual([label, q, sort, ids(oldRows(state, q, sort))]);
    };
    let state = POOL.state;
    same(state, 'start');
    const history: DataStateV3[] = [];
    for (let step = 0; step < 14; step++) {
      history.push(state);
      if (step === 6) state = history[history.length - 2]; // an undo
      else if (step === 10) {
        // A reset of every Grammar card (far more than 1/20 of them): sorted on its own, then made again.
        state = { ...state, cards: state.cards.map((c) => (c.deckId === 'd-grammar' ? { ...c, due: NOW, ease: 2.5, lapses: 0, reps: 0 } : c)) };
      } else {
        const at = rnd.int(0, state.cards.length - 1);
        state = {
          ...state,
          cards: state.cards.map((c, i) =>
            i === at ? { ...c, reps: c.reps + 1, due: NOW + rnd.int(-2, 30) * DAY, ease: rnd.pick([1.3, 1.5, 2.5, 2.7]), lapses: rnd.int(0, 3) } : c,
          ),
        };
      }
      same(state, `step ${step}`);
      // The Library's idle step between two lists, every other time.
      if (step % 2 === 1) for (const sort of sorts) warmLibraryOrder(state, sort, matchCtxOf(state, 0));
    }
  });

  it('the filter groups: the golden signatures of the engine before unit P1', () => {
    const ctx = matchCtxOf(POOL.state, NOW);
    const got = FACET_SELECTIONS.map(([scope, selection]) => facetSignature(deriveFacets(POOL.state.cards, scope, selection, ctx)));
    expect(got).toEqual(GOLDEN_FACETS);
  });
});

describe('unit P1 — speed guards on 16,000 cards (CPU time, linear growth, node)', () => {
  it('filter: chips and words on a warm library — linear, 16k well under the 30 ms budget × 5', () => {
    const measure = (pool: Pool) => {
      const ctx = matchCtxOf(pool.state, NOW);
      warmLibraryCaches(pool.state.cards, ctx, 0, () => false);
      newRows(pool.state, {}, { by: 'source' }); // the library order exists, as after the first open
      return fastest(
        5,
        () => null,
        () => {
          newRows(pool.state, { decks: ['d-vocab'], life: ['new'] }, { by: 'source' });
          newRows(pool.state, { text: 'arbeit' }, { by: 'source' });
          newRows(pool.state, { fields: { level: ['b1'] } }, { by: 'source' });
        },
      ) / 3;
    };
    const { full, growth: g } = growth(measure);
    expect(g).toBeLessThan(MAX_GROWTH);
    expect(full).toBeLessThan(5 * 30);
  });

  it('A–Z after the first time: linear, under 100 ms × 5 — and several times faster than the old comparator sort', () => {
    const state = POOL.state;
    warmLibraryCaches(state.cards, matchCtxOf(state, NOW), 0, () => false);
    newRows(state, {}, { by: 'az' }); // the first A–Z of this library
    const fresh = fastest(5, () => null, () => newRows(state, { decks: ['d-vocab'], life: ['new'] }, { by: 'az' }));
    const old = fastest(3, () => null, () => oldRows(state, { decks: ['d-vocab'], life: ['new'] }, { by: 'az' }));
    expect(fresh * 3).toBeLessThan(old);
    const { full, growth: g } = growth((pool) => {
      newRows(pool.state, {}, { by: 'az' });
      return fastest(5, () => null, () => newRows(pool.state, { fields: { level: ['a1', 'b2'] } }, { by: 'az', dir: 'desc' }));
    });
    expect(g).toBeLessThan(MAX_GROWTH);
    expect(full).toBeLessThan(5 * 100);
  });

  it('review 2: "Due date" and "Hardest first" on a Level chip after a rating — no slower than sorting the list alone, far under a sort of the library', () => {
    let state = POOL.state;
    warmLibraryCaches(state.cards, matchCtxOf(state, NOW), 0, () => false);
    for (const sort of [{ by: 'due' }, { by: 'hardest' }] as SortSpec[]) {
      newRows(state, {}, sort); // the library's order exists (the whole list made it)
      let step = 0;
      /** One rating: a new cards array in which one card has a new due time and ease. */
      const rate = () => {
        step += 1;
        const at = (step * 7919) % state.cards.length;
        state = { ...state, cards: state.cards.map((c, i) => (i === at ? { ...c, due: c.due + DAY, ease: c.ease + 0.05 } : c)) };
        cardLookupOf(state.cards); // every selector shares it: not part of the sort
        const ctx = matchCtxOf(state, 0);
        return { state, ctx, list: scopePool(state, { fields: { level: ['b1'] } }, ctx, 'browse') };
      };
      // Each run: 10 ratings, each followed by the list's sort (repaired) — or by a sort of the list alone.
      const RATINGS = 10;
      const runs = (sortOf: (s: ReturnType<typeof rate>) => unknown) => {
        const inputs = Array.from({ length: RATINGS }, rate);
        const start = clockMs();
        for (const input of inputs) sortOf(input);
        return clockMs() - start;
      };
      let repaired = Number.POSITIVE_INFINITY;
      let alone = Number.POSITIVE_INFINITY;
      let library = Number.POSITIVE_INFINITY;
      for (let attempt = 0; attempt < 5; attempt++) {
        repaired = Math.min(repaired, runs(({ state: s, ctx, list }) => sortScopeCards(list, sort, s, ctx)));
        alone = Math.min(alone, runs(({ state: s, ctx, list }) => orderCards(list, sort, scheduleCtxOf(s, ctx))));
        library = Math.min(library, runs(({ state: s, ctx }) => orderCards(s.cards, sort, scheduleCtxOf(s, ctx))));
      }
      const { state: last, ctx, list } = rate();
      expect(list.length).toBeGreaterThan(state.cards.length * 0.125); // cut from the library's order
      expect(ids(sortScopeCards(list, sort, last, ctx))).toEqual(ids(sortCards(list, sort, scheduleCtxOf(last, ctx))));
      expect([sort.by, repaired <= alone]).toEqual([sort.by, true]);
      expect([sort.by, repaired * 3 < library]).toEqual([sort.by, true]);
    }
  });

  it('the FIRST A–Z (new note objects, nothing cached): linear — the headline only, never whole faces', () => {
    const { full, growth: g } = growth((pool) => fastest(3, () => coldCopy(pool), (state) => newRows(state, {}, { by: 'az' })));
    expect(g).toBeLessThan(MAX_GROWTH);
    expect(full).toBeLessThan(5 * 300);
  });

  it('the FacetSheet on a warm library (no selection, and two chips): linear, under the 80 ms budget × 5', () => {
    const { full, growth: g } = growth((pool) => {
      const ctx = matchCtxOf(pool.state, NOW);
      warmLibraryCaches(pool.state.cards, ctx, 0, () => false);
      return fastest(5, () => null, () => {
        deriveFacets(pool.state.cards, {}, {}, ctx);
        deriveFacets(pool.state.cards, {}, { decks: ['d-vocab'], fields: { level: ['b1'] } }, ctx);
      }) / 2;
    });
    expect(g).toBeLessThan(MAX_GROWTH);
    expect(full).toBeLessThan(5 * 80);
  });

  it('after the warm-up, the first search, A–Z and count of new notes cost a fraction of the cold ones', () => {
    const firstUses = (state: DataStateV3) => {
      const ctx = matchCtxOf(state, NOW);
      newRows(state, { text: 'zeit' }, { by: 'source' });
      newRows(state, {}, { by: 'az' });
      deriveFacets(state.cards, {}, {}, ctx);
    };
    const cold = fastest(3, () => coldCopy(POOL), firstUses);
    const warmed = fastest(
      3,
      () => {
        const state = coldCopy(POOL);
        warmLibraryCaches(state.cards, matchCtxOf(state, NOW), 0, () => false);
        return state;
      },
      firstUses,
    );
    expect(warmed * 2).toBeLessThan(cold);
  });

  it('unit P2: after ONLY the search-text part of the warm-up (its first part), the first search costs a fraction of a cold one — and that part is a small share of the whole warm-up', () => {
    /** A cold copy with its library index made (the selectors make it when the notes change, not on the first search). */
    const coldWithIndex = () => {
      const state = coldCopy(POOL);
      matchCtxOf(state, NOW);
      return state;
    };
    /** The warm-up in slices that stop at every chance, until the search text of every note is made. */
    const searchPartOnly = (state: DataStateV3): number => {
      const ctx = matchCtxOf(state, NOW);
      const end = warmDoneAt(state.cards, 'searchText');
      let at = 0;
      while (at < end) at = warmLibraryCaches(state.cards, ctx, at, () => true);
      return at;
    };
    const firstSearch = (state: DataStateV3) => scopePool(state, { text: 'zeit' }, matchCtxOf(state, NOW), 'browse');
    const cold = fastest(3, coldWithIndex, firstSearch);
    const afterSearchPart = fastest(
      3,
      () => {
        const state = coldWithIndex();
        expect(searchPartOnly(state)).toBe(state.cards.length); // stopped right at the end of the first part
        return state;
      },
      firstSearch,
    );
    expect(afterSearchPart * 3).toBeLessThan(cold);
    // The first part is the cheap one: the search text comes long before the warm-up ends.
    const searchPart = fastest(3, coldWithIndex, searchPartOnly);
    const whole = fastest(3, coldWithIndex, (state) => warmLibraryCaches(state.cards, matchCtxOf(state, NOW), 0, () => false));
    expect(searchPart * 2).toBeLessThan(whole);
  });

  it('unit P2: making the library order the FIRST time per sort is no slower than sortCards on the whole library (every sort, both directions)', () => {
    const state = POOL.state;
    const ctx = matchCtxOf(state, NOW);
    warmLibraryCaches(state.cards, ctx, 0, () => false); // the A–Z keys are ready, for both ways
    // The first time: a new decks Map means no kept order, so sortScopeCards makes it now (the whole library is the list).
    const firstTime = (sort: SortSpec) => () => sortScopeCards(state.cards, sort, state, { ...ctx, decks: new Map(ctx.decks) });
    const plain = (sort: SortSpec) => () => sortCards(state.cards, sort, scheduleCtxOf(state, ctx));
    const ratios: string[] = [];
    for (const sort of SORTS) {
      // The same rows as the comparator sort.
      expect([sort, ids(firstTime(sort)())]).toEqual([sort, ids(plain(sort)())]);
      // Measured in turns (a moment of load slows both), the fastest of 7; up to 3 tries.
      let ratio = Number.POSITIVE_INFINITY;
      for (let attempt = 0; attempt < 3 && ratio > 1; attempt++) {
        let made = Number.POSITIVE_INFINITY;
        let sorted = Number.POSITIVE_INFINITY;
        for (let turn = 0; turn < 7; turn++) {
          made = Math.min(made, fastest(1, () => null, firstTime(sort)));
          sorted = Math.min(sorted, fastest(1, () => null, plain(sort)));
        }
        ratio = Math.min(ratio, made / Math.max(sorted, 0.05));
      }
      ratios.push(`${sort.by}${sort.dir === 'desc' ? ' desc' : ''} ${ratio.toFixed(2)}`);
      expect([sort, ratio <= 1]).toEqual([sort, true]);
    }
    expect(ratios).toHaveLength(SORTS.length);
  });

  it('unit P3: the app\'s REAL first time — a NEW list from scopePool (the whole library, one deck) — is no slower than sortCards on that list, with the same rows', () => {
    const state = POOL.state;
    const ctx = matchCtxOf(state, NOW);
    warmLibraryCaches(state.cards, ctx, 0, () => false); // the A–Z keys are ready, as after the shared warm-up
    // What the Library really sorts (libraryState rowsReader): scopePool's NEW array, never
    // state.cards itself — also with no filter at all. So the `cards === all` shortcut of the
    // guard above is never the app's path; these two lists are.
    const lists: [string, Card[]][] = [
      ['whole library', scopePool(state, {}, ctx, 'browse')],
      ['deck German Vocabulary', scopePool(state, { decks: ['d-vocab'] }, ctx, 'browse')],
    ];
    let checked = 0;
    expect(lists[0][1]).toHaveLength(state.cards.length);
    for (const [label, list] of lists) {
      expect(list).not.toBe(state.cards);
      // Big enough to be cut from a kept library order later: only "no kept order yet" sorts it on its own.
      expect(list.length).toBeGreaterThanOrEqual(state.cards.length * LIBRARY_ORDER_MIN_SHARE);
      for (const sort of SORTS) {
        // The first time: a new decks Map means no kept order for this library.
        const firstTime = () => sortScopeCards(list, sort, state, { ...ctx, decks: new Map(ctx.decks) });
        const plain = () => sortCards(list, sort, scheduleCtxOf(state, ctx));
        // Exactly the rows of the comparator sort.
        expect([label, sort, ids(firstTime())]).toEqual([label, sort, ids(plain())]);
        // Which path it took: the whole library MAKES the library's order (it is kept, the
        // idle step has nothing to do); one deck sorts its list on its own (the idle step
        // makes the order later).
        const fresh = { ...ctx, decks: new Map(ctx.decks) };
        sortScopeCards(list, sort, state, fresh);
        expect([label, sort, warmLibraryOrder(state, sort, fresh)]).toEqual([label, sort, list.length !== state.cards.length]);
        // Measured in turns (a moment of load slows both), the fastest of 7; up to 3 tries.
        let ratio = Number.POSITIVE_INFINITY;
        for (let attempt = 0; attempt < 3 && ratio > 1; attempt++) {
          let made = Number.POSITIVE_INFINITY;
          let sorted = Number.POSITIVE_INFINITY;
          for (let turn = 0; turn < 7; turn++) {
            made = Math.min(made, fastest(1, () => null, firstTime));
            sorted = Math.min(sorted, fastest(1, () => null, plain));
          }
          ratio = Math.min(ratio, made / Math.max(sorted, 0.05));
        }
        // A failure names the list, the sort and the ratio.
        expect([label, sort, ratio <= 1 ? 'no slower' : `ratio ${ratio.toFixed(2)}`]).toEqual([label, sort, 'no slower']);
        checked += 1;
      }
    }
    expect(checked).toBe(lists.length * SORTS.length);
  });
});

describe('unit P4 — Deck order with a filter, and with none (16,000 cards)', () => {
  /** The pool stored in Deck order (the device: the store keeps cards in import order, deck by deck). */
  const IN_ORDER: DataStateV3 = { ...POOL.state, cards: sortCards(POOL.state.cards, { by: 'source' }, scheduleCtxOf(POOL.state, matchCtxOf(POOL.state, NOW))) };

  /** The shared warm-up to its end (the per-note caches, the note lookups, the Deck order). */
  function warmAll(state: DataStateV3): MatchCtx {
    const ctx = matchCtxOf(state, 0);
    warmLibraryCaches(state.cards, ctx, 0, () => false);
    expect(warmNoteSets(ctx.index, () => false)).toBe(true);
    warmLibraryOrderOf({ cards: state.cards, index: ctx.index, decks: ctx.decks }, { by: 'source' });
    return ctx;
  }

  /** The fastest of 7 turns of a and b: they take turns, so a moment of load slows both. */
  function turnsOf(a: () => unknown, b: () => unknown): { a: number; b: number } {
    let ta = Number.POSITIVE_INFINITY;
    let tb = Number.POSITIVE_INFINITY;
    for (let turn = 0; turn < 7; turn++) {
      ta = Math.min(ta, fastest(1, () => null, a));
      tb = Math.min(tb, fastest(1, () => null, b));
    }
    return { a: ta, b: tb };
  }

  /**
   * turnsOf, up to 3 tries until a <= b × factor; the try with the smallest
   * a / b is kept. P4 review 2: the FIRST try always runs and always sets
   * the result. Before, the result started as Infinity / Infinity, so the
   * loop condition was false at once, nothing was measured, and every guard
   * that used it passed (the test below checks the helper itself).
   */
  function inTurns(a: () => unknown, b: () => unknown, factor: number): { a: number; b: number } {
    let best = turnsOf(a, b);
    for (let attempt = 1; attempt < 3 && !(best.a <= best.b * factor); attempt++) {
      const next = turnsOf(a, b);
      if (next.a / Math.max(next.b, 0.01) < best.a / Math.max(best.b, 0.01)) best = next;
    }
    return best;
  }

  /** About `ms` of CPU work (a loop that reads the clock). */
  const busyFor = (ms: number) => () => {
    const start = clockMs();
    let n = 0;
    while (clockMs() - start < ms) n += 1;
    return n;
  };

  /** A Level chip: alone, with a Deck chip, and with a Deck and a Section chip (the release device's lists). */
  const LEVEL_CHIPS: Query[] = [
    { decks: ['d-vocab'], fields: { level: ['b1'] } },
    { fields: { level: ['b1'] } },
    { decks: ['d-vocab'], sections: [{ deckId: 'd-vocab', path: 'vocabulary' }], fields: { level: ['b1'] } },
  ];

  it('P4 review 2: the timing helper really measures — finite times, and a slow function is slower than a quick one', () => {
    const t = inTurns(busyFor(0.2), busyFor(2), 1);
    expect([Number.isFinite(t.a), Number.isFinite(t.b)]).toEqual([true, true]);
    expect(t.a).toBeGreaterThan(0);
    expect(t.a).toBeLessThan(t.b);
    // A claim that is false is NOT passed: the slow one is never "at most half" of the quick one.
    const wrong = inTurns(busyFor(2), busyFor(0.2), 0.5);
    expect(wrong.a <= wrong.b * 0.5).toBe(false);
  });

  it('a NEW Level / Section filter in Deck order (pool and rows included) costs at most two thirds of the query test alone — the old rows', () => {
    for (const [label, state] of [['stored in another order', POOL.state], ['stored in Deck order', IN_ORDER]] as const) {
      const ctx = warmAll(state);
      expect(noteSetsReady(ctx.index)).toBe(true);
      for (const q of LEVEL_CHIPS) {
        // The device's case: the first list of a new filter is in Deck order (the default sort).
        const deckOrder = () => newRows(state, q, { by: 'source' });
        // The reference shares no new code: the query test on every card (what the pool was before
        // unit P4), with no sort at all. Before unit P4 the whole list cost 1.02–1.13 times this.
        const queryTest = () => oldPool(state, q, ctx);
        expect(ids(deckOrder())).toEqual(ids(oldRows(state, q, { by: 'source' })));
        const t = inTurns(deckOrder, queryTest, 2 / 3);
        expect([label, q, t.a * 1.5 <= t.b ? 'two thirds at most' : `deck order ${t.a.toFixed(2)} ms vs the query test ${t.b.toFixed(2)} ms`]).toEqual([
          label,
          q,
          'two thirds at most',
        ]);
      }
    }
  });

  it('the note-group pool of a Level chip is at least 1.5 times as fast as the query test on every card — and every note-group pool is the query test’s', () => {
    const state = POOL.state;
    const ctx = warmAll(state);
    // The same cards in the same order for every group the note lookups answer.
    const others: Query[] = [
      { noteTypes: ['nt-verbs'], fields: { tags: ['regular'] } },
      { noteTypes: ['nt-verbs'] },
      { sections: [{ deckId: 'd-verbs', path: 'verbs::b1' }] },
    ];
    for (const q of [...LEVEL_CHIPS, ...others]) expect([q, ids(scopePool(state, q, ctx, 'browse'))]).toEqual([q, ids(oldPool(state, q, ctx))]);
    // The speed claim is for the Level chips (a field group): in node the lookup takes 0.32–0.42 of
    // the query test (before unit P4: 1.0). A Card type or Section chip ALONE is about as fast as its
    // query test in node (0.9–1.0: that test is one note lookup and one comparison), and the tags +
    // Card type query about 0.6 — too close to a factor to be a stable guard, so they are not timed.
    for (const q of LEVEL_CHIPS) {
      const t = inTurns(() => scopePool(state, q, ctx, 'browse'), () => oldPool(state, q, ctx), 2 / 3);
      expect([q, t.a * 1.5 <= t.b ? '1.5 times as fast' : `${t.a.toFixed(2)} ms vs ${t.b.toFixed(2)} ms`]).toEqual([q, '1.5 times as fast']);
    }
  });

  it('no filter, Deck order, after the warm-up: the pool AND the rows are the store’s array (P4 review: no copy) — less than a fifth of one filter pass that copies the cards', () => {
    const state = IN_ORDER;
    warmAll(state);
    const cache = createRowsCache();
    const rows = rowsReader(cache, serializeQuery({}), JSON.stringify({ by: 'source' }), 0)(state);
    expect([...cache.pools.values()][0]).toBe(state.cards);
    // Unit P4 review: the rows are only read, so no copy of 16,000 cards is made (no garbage for a GC inside the line).
    expect(rows).toBe(state.cards);
    expect(ids(rows)).toEqual(ids(oldRows(state, {}, { by: 'source' })));
    const open = () => newRows(state, {}, { by: 'source' });
    // The reference: ONE filter pass that copies the cards — the pool of "no filter" before unit P4
    // (scopePool: cards.filter of a query that matches every card). The opening then also cut the
    // rows out of the kept order: 1.3 times this pass in node. Now it makes no array at all: 0.04.
    const copyPass = () => state.cards.filter((card) => card.deckId !== '');
    const t = inTurns(open, copyPass, 0.2);
    expect(t.a * 5 <= t.b ? 'a fifth at most' : `open ${t.a.toFixed(3)} ms vs one filter pass ${t.b.toFixed(3)} ms`).toBe('a fifth at most');
  });
});
