/**
 * The store's facet selector keeps its results (unit P1, selectors.ts
 * facetsReader). The release pass on 16,260 cards counted the filter groups
 * TWICE for one FacetSheet opening (161.7 + 68.2 ms) and again on every
 * opening of the same library. Now every reader of the same (scope,
 * selection, time) over the same data gets the SAME array — and a kept
 * result is never stale: a rating, an edit, an import or an undo makes new
 * arrays, and the count is made again.
 *
 * Also (unit P4 review): the dev timings of perfMarks.ts name the garbage
 * collections inside a timing ("1 GC 28.0 ms") and, for an async timing
 * ('save'), the other lines recorded while it waited ("inside it: warm 0.3 ms").
 */
import { describe, expect, it } from '@jest/globals';

import { deriveFacets, type Facet } from '../domain/facets';
import type { DataStateV3, Query } from '../domain/model';
import { serializeQuery } from '../domain/query';
import { matchCtxOf } from '../domain/scope';
import { FIXED_NOW as NOW } from '../test/clock';
import { lifeValues, makeDeckV3, noteWithCards, stateOfV3 } from '../test/factoriesV3';
import { createPerfMarks, formatPerfLine, hermesGcReading, timedSelector } from './perfMarks';
import { FACETS_KEPT, facetsReader } from './selectors';
import { BUILTIN_TYPE_IDS } from '../domain/builtinTypes';
import { DAY, MIN } from '../domain/types';

/** Two decks of Basic + reverse notes in several states. */
function library(): DataStateV3 {
  const decks = [makeDeckV3({ id: 'd1', name: 'One', order: 0 }), makeDeckV3({ id: 'd2', name: 'Two', order: 1 })];
  const kinds = ['new', 'review', 'learning', 'notStarted', 'known'] as const;
  return stateOfV3({
    decks,
    groups: Array.from({ length: 12 }, (_, i) =>
      noteWithCards({
        deckId: i % 3 === 0 ? 'd2' : 'd1',
        typeId: BUILTIN_TYPE_IDS.basicReverse,
        fields: [`word ${i}`, `meaning ${i}`, '', ''],
        note: { id: `n${i}`, tags: i % 2 === 0 ? ['even'] : ['odd'] },
        card: (ord) => ({ id: `c${i}-${ord}`, ...lifeValues(kinds[(i + ord) % kinds.length], NOW), fav: i % 4 === 0 }),
      }),
    ),
  });
}

const ALL = serializeQuery({});
const key = (q: Query) => serializeQuery(q);

describe('unit P1 — facetsReader: one count per (scope, selection, time, data), shared by every reader', () => {
  it('a NEW reader for the same draft gets the SAME array (a new render, the sheet opened again)', () => {
    const state = library();
    const first = facetsReader(key({ life: ['new'] }), ALL, NOW)(state);
    expect(first).toEqual(deriveFacets(state.cards, {}, { life: ['new'] }, matchCtxOf(state, NOW)));
    expect(facetsReader(key({ life: ['new'] }), ALL, NOW)(state)).toBe(first);
    // A state change the facets do not read (the person) keeps it too.
    expect(facetsReader(key({ life: ['new'] }), ALL, NOW)({ ...state, person: { ...state.person, xp: 77 } })).toBe(first);
    // Another selection, scope or time is another count.
    expect(facetsReader(key({ life: ['review'] }), ALL, NOW)(state)).not.toBe(first);
    expect(facetsReader(key({ life: ['new'] }), key({ decks: ['d1'] }), NOW)(state)).not.toBe(first);
    const later = facetsReader(key({ life: ['new'] }), ALL, NOW + DAY)(state);
    expect(later).not.toBe(first);
    expect(later).toEqual(deriveFacets(state.cards, {}, { life: ['new'] }, matchCtxOf(state, NOW + DAY)));
  });

  it('never stale: a rating, an edit, a new list and an undo each give the counts of THAT data', () => {
    const start = library();
    const read = (s: DataStateV3): Facet[] => facetsReader(key({}), ALL, NOW)(s);
    const fresh = (s: DataStateV3): Facet[] => deriveFacets(s.cards, {}, {}, matchCtxOf(s, NOW));
    const first = read(start);
    // A rating: a new cards array (a New card became a due review).
    const rated = {
      ...start,
      cards: start.cards.map((c) => (c.id === 'c0-0' ? { ...c, reps: 3, stepIndex: null, intervalDays: 4, due: NOW - MIN } : c)),
    };
    expect(read(rated)).not.toBe(first);
    expect(read(rated)).toEqual(fresh(rated));
    // An edit: a new note (another tag).
    const edited = { ...rated, notes: rated.notes.map((n) => (n.id === 'n1' ? { ...n, tags: ['even', 'new-tag'] } : n)) };
    expect(read(edited)).toEqual(fresh(edited));
    expect(read(edited).find((f) => f.key === 'tag')?.values.map((v) => v.value)).toContain('new-tag');
    // A new user list (the facets read the lists for a list scope).
    const listed = { ...edited, lists: [{ id: 'l1', name: 'L', icon: '🔖', query: { decks: ['d2'] }, createdAt: NOW, updatedAt: NOW }] };
    expect(read(listed)).not.toBe(read(edited));
    expect(facetsReader(key({}), key({ list: 'l1' }), NOW)(listed)).toEqual(deriveFacets(listed.cards, { list: 'l1' }, {}, matchCtxOf(listed, NOW)));
    // Undo: the first state's arrays come back — its counts are right again.
    expect(read(start)).toEqual(fresh(start));
  });

  it(`keeps at most ${FACETS_KEPT} results per library: the oldest is counted again`, () => {
    const state = library();
    const read = (i: number) => facetsReader(key({ text: `word ${i}` }), ALL, NOW)(state);
    const first = read(0);
    for (let i = 1; i < FACETS_KEPT; i++) read(i);
    expect(read(0)).toBe(first); // still kept (and now the newest)
    for (let i = FACETS_KEPT; i < 2 * FACETS_KEPT + 1; i++) read(i);
    const again = read(0);
    expect(again).not.toBe(first);
    expect(again).toEqual(first);
  });

  it('perfMarks: a kept result from a NEW reader is no "facets" line — only real counts are', () => {
    let tick = 0;
    const marks = createPerfMarks({ enabled: true, clock: () => (tick += 1) });
    const state = library();
    const timed = () => timedSelector('facets', facetsReader(key({ flags: ['fav'] }), ALL, NOW), (f) => `${f.length}`, marks);
    timed()(state);
    timed()(state); // the sheet opened again on the same library
    expect(marks.entries().filter((e) => e.name === 'facets')).toHaveLength(1);
    timed()({ ...state, cards: [...state.cards] }); // new data: a real count
    expect(marks.entries().filter((e) => e.name === 'facets')).toHaveLength(2);
  });
});

/*
 * Unit P4 review: the release run printed the SAME "no filter" Library
 * opening at 4–6 ms and at 32–34 ms (once 135.5 ms). A synchronous selector
 * only takes longer when the JS thread is paused (a garbage collection) or
 * not run (a busy host). So every timing now says when the collector ran
 * inside it, and an async timing ('save') names the other lines recorded
 * while it waited. These tests pin the lines with a fake collector.
 */
describe('unit P4 review — perfMarks: GC pauses and other lines inside a timing', () => {
  /** A fake collector: `collect(ms)` is one collection that paused the JS thread `ms`. */
  function fakeGc(): { read: () => { count: number; ms: number }; collect: (ms: number) => void } {
    let count = 0;
    let total = 0;
    return {
      read: () => ({ count, ms: total }),
      collect: (ms) => {
        count += 1;
        total += ms;
      },
    };
  }

  it('timedSelector: a collection inside the selector is in its line; none → no note; a cache hit → no line', () => {
    let tick = 0;
    const gc = fakeGc();
    const lines: string[] = [];
    const marks = createPerfMarks({ enabled: true, clock: () => (tick += 1), gc: gc.read, log: (line) => lines.push(line) });
    let value = { n: 1 };
    const timed = timedSelector(
      'filter',
      (state: { slow: boolean }) => {
        if (state.slow) gc.collect(28);
        return value;
      },
      () => '16,264 cards',
      marks,
    );
    timed({ slow: true });
    expect(marks.entries()[0].gc).toEqual({ count: 1, ms: 28 });
    expect(lines[0]).toBe('[perf] filter 1.0 ms (16,264 cards; 1 GC 28.0 ms)');
    value = { n: 2 };
    timed({ slow: false });
    expect(marks.entries()[1].gc).toBeUndefined();
    expect(lines[1]).toBe('[perf] filter 1.0 ms (16,264 cards)');
    // A collection during a cache hit (the same value): no line at all.
    timed({ slow: true });
    expect(lines).toHaveLength(2);
  });

  it('time(): two collections; a line over its budget says so after the notes', () => {
    let now = 0;
    const gc = fakeGc();
    const lines: string[] = [];
    const marks = createPerfMarks({ enabled: true, clock: () => now, gc: gc.read, log: (line) => lines.push(line) });
    marks.time(
      'filter',
      () => {
        gc.collect(10);
        gc.collect(12.5);
        now += 33.5;
      },
      '3,876 cards',
    );
    expect(lines).toEqual(['[perf] filter 33.5 ms (3,876 cards; 2 GCs 22.5 ms) — over the 30 ms budget']);
  });

  it('timeAsync(): the lines recorded while it waited are named ("inside it"), with the collections of its whole window', async () => {
    let now = 0;
    const gc = fakeGc();
    const lines: string[] = [];
    const marks = createPerfMarks({ enabled: true, clock: () => now, gc: gc.read, log: (line) => lines.push(line) });
    marks.mark('filter', 1.3, '16,260 cards'); // before the save: not inside it
    let finish: () => void = () => undefined;
    const saving = marks.timeAsync(
      'save',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    marks.mark('warm', 0.3, '1 of 16,260 cards');
    gc.collect(4);
    now += 43.5;
    finish();
    await saving;
    expect(lines[2]).toBe('[perf] save 43.5 ms (1 GC 4.0 ms; inside it: warm 0.3 ms) — over the 20 ms budget');
    expect(marks.entries()[2]).toMatchObject({ name: 'save', inside: ['warm 0.3 ms'], gc: { count: 1, ms: 4 } });
    // A save with nothing inside it and no collection: the plain line.
    await marks.timeAsync('save', async () => {
      now += 9.1;
    });
    expect(lines[3]).toBe('[perf] save 9.1 ms');
  });

  it('hermesGcReading: js_numGCs and js_gcTime (seconds) of HermesInternal; null without it, or when it throws; off → never read', () => {
    const g = globalThis as { HermesInternal?: unknown };
    const saved = g.HermesInternal;
    try {
      delete g.HermesInternal;
      expect(hermesGcReading()).toBeNull();
      g.HermesInternal = { getInstrumentedStats: () => ({ js_numGCs: 41, js_gcTime: 0.3125 }) };
      expect(hermesGcReading()).toEqual({ count: 41, ms: 312.5 });
      g.HermesInternal = { getInstrumentedStats: () => ({ js_numGCs: '41' }) };
      expect(hermesGcReading()).toBeNull();
      g.HermesInternal = {
        getInstrumentedStats: () => {
          throw new Error('no stats');
        },
      };
      expect(hermesGcReading()).toBeNull();
      // Timings off (a release build): the collector is never asked.
      let asked = 0;
      const off = createPerfMarks({
        enabled: false,
        gc: () => {
          asked += 1;
          return { count: 0, ms: 0 };
        },
      });
      expect(off.time('filter', () => 7)).toBe(7);
      expect(off.gcNow()).toBeNull();
      timedSelector('filter', () => 1, undefined, off)({});
      expect(asked).toBe(0);
    } finally {
      if (saved === undefined) delete g.HermesInternal;
      else g.HermesInternal = saved;
    }
  });

  it('formatPerfLine: the notes in one bracket — detail; GCs; lines inside — and the budget last', () => {
    expect(formatPerfLine({ name: 'boot', ms: 812, detail: 'loaded' })).toBe('[perf] boot 812.0 ms (loaded)');
    expect(formatPerfLine({ name: 'save', ms: 25.5, gc: { count: 2, ms: 6 }, inside: ['warm 0.3 ms', 'order 1.0 ms'] })).toBe(
      '[perf] save 25.5 ms (2 GCs 6.0 ms; inside it: warm 0.3 ms, order 1.0 ms) — over the 20 ms budget',
    );
    expect(formatPerfLine({ name: 'warm', ms: 410.2, detail: '16,260 cards', inside: [] })).toBe('[perf] warm 410.2 ms (16,260 cards)');
  });
});
