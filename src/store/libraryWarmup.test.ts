/**
 * Tests for src/store/libraryWarmup.ts — the Library's ONE shared cache
 * warm-up, started early from the tab layout (unit P2):
 *   - the controller: it waits for its delay, works in slices, says when the
 *     data is warmed, prints one '[perf] warm' line per complete run, runs
 *     one warm-up at a time (new data stops the old run), stops with no
 *     timer left, and after a rating walks only the changed cards;
 *   - the hook (useLibraryWarmup): nothing before the app is ready, the
 *     first start 1.5 s after ready (also when the data changes in that
 *     time), a restart for new data, no restart for other changes (the
 *     settings), and unmounting stops it;
 *   - unit P3: onWarmed (a listener called ONCE when a run completes; it
 *     can be removed), runWhenWarmed (the Library's order step waits with
 *     NO timer — no polling — and leaves nothing behind), and startSoon /
 *     useLibraryWarmupSoon (a Library opened early makes the first run
 *     begin 400 ms later, never later than planned, never before ready,
 *     still one warm-up);
 *   - unit P4: a run also makes the note lookups (scope.ts warmNoteSets)
 *     and the Deck order (WARM_ORDER_SORT = the Library's default sort), so
 *     Section / Card type chips read no note; a slice waits — with no timer —
 *     while a save is written (persistController persistWrites); and
 *     warmSearchText (the search box got the focus) makes the search text
 *     of every note at once, so the first search reads no note;
 *   - the P4 review: the Deck order is made a part at a time (a library NOT
 *     stored in Deck order: several slices, none over budget), and after
 *     the focus the headlines come next — a frame later, in slices of up to
 *     WARM_FOCUS_SLICE_MS — so the first search (filter AND headline rank)
 *     reads no note; a slice that waits for a save keeps waiting;
 *   - the P4 review 2: a focus while a save is written waits for it too (no
 *     pass, no timer), then makes the search text a frame after the write —
 *     so the app's "[perf] save" line never counts it; stop(), new data and
 *     a newer focus remove that wait, the same data keeps it.
 *
 * Timers are jest's fake timers. The slices' clock is a fake that moves 1 ms
 * each time it is read, so a slice really stops after about WARM_SLICE_MS
 * (8 reads): the warm-up of a small library then needs several slices.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { createRowsCache, DEFAULT_SORT, rowsReader } from '../components/library/libraryState';
import { faceHeadline } from '../domain/face';
import type { DataStateV3, Note } from '../domain/model';
import { serializeQuery } from '../domain/query';
import { sortCards } from '../domain/schedule';
import {
  libraryOrderReady,
  matchCtxOf,
  noteSetsReady,
  scheduleCtxOf,
  scopePool,
  sortScopeCards,
  warmDoneAt,
} from '../domain/scope';
import { FIXED_NOW as NOW } from '../test/clock';
import { randomStateV3 } from '../test/factoriesV3';
import { createRandom } from '../test/random';
import type { Engine, EngineMeta } from './engine';
import {
  cardsToWarm,
  createLibraryWarmup,
  type LibraryWarmup,
  type LibraryWarmupOptions,
  libraryWarmup,
  runWhenWarmed,
  useLibraryWarmup,
  useLibraryWarmupSoon,
  WARM_FOCUS_SLICE_MS,
  WARM_GAP_MS,
  WARM_ORDER_SORT,
  WARM_RESTART_MS,
  WARM_SLICE_MS,
  WARM_SOON_MS,
  WARM_START_AFTER_READY_MS,
  warmTargetOf,
  type WriteActivity,
} from './libraryWarmup';
import { perfMarks } from './perfMarks';
import { createPersistController, persistWrites, SAVE_DEBOUNCE_MS } from './persistController';
import { EngineContext } from './selectors';
import { createStore, type Store } from './store';

/** The first seeded library with more than `min` cards. */
function library(tag: string, min = 200): DataStateV3 {
  for (let seed = 0; ; seed++) {
    const state = randomStateV3(createRandom(`${tag}-${seed}`), { now: NOW, maxDecks: 3, maxNotes: 220 });
    if (state.cards.length > min) return state;
  }
}

/** A copy of the state whose notes count every read of their fields (a value made from a note reads them). */
function counting(state: DataStateV3): { state: DataStateV3; reads: () => number } {
  let reads = 0;
  const notes = state.notes.map((note) => {
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
  return { state: { ...state, notes }, reads: () => reads };
}

/**
 * A controller with jest's timers and a clock that moves `stepMs` per read.
 * With 4 ms a slice stops at its second question (after about 128 cards);
 * with more than WARM_SLICE_MS it stops at its FIRST question: 64 cards, or
 * the end of a part.
 */
function controller(stepMs = 4): {
  warmup: LibraryWarmup;
  done: jest.Mock<(ms: number, walked: number, total: number) => void>;
  clockReads: () => number;
} {
  let t = 0;
  let reads = 0;
  const done = jest.fn<(ms: number, walked: number, total: number) => void>();
  const warmup = createLibraryWarmup({
    clock: () => {
      reads += 1;
      t += stepMs;
      return t;
    },
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    done,
  });
  return { warmup, done, clockReads: () => reads };
}

beforeEach(() => {
  jest.useFakeTimers();
});

const renderers: ReactTestRenderer[] = [];
afterEach(() => {
  for (const r of renderers.splice(0)) act(() => r.unmount());
  jest.useRealTimers();
});

describe('the warm-up controller', () => {
  test('waits for its delay, then warms in slices; isWarmed and ONE done() at the end; the search text and the headlines then read no note', () => {
    const { state, reads } = counting(library('p2-ctl'));
    const target = warmTargetOf(state);
    const { warmup, done, clockReads } = controller();
    warmup.start(target, 1500);
    jest.advanceTimersByTime(1499);
    expect(clockReads()).toBe(0); // no slice yet
    expect(warmup.isRunning()).toBe(true);
    jest.advanceTimersByTime(1);
    expect(clockReads()).toBeGreaterThan(0);
    // Several slices, one timer at a time, WARM_GAP_MS apart.
    let slices = 1;
    while (warmup.isRunning()) {
      expect(jest.getTimerCount()).toBe(1);
      expect(warmup.isWarmed(target)).toBe(false);
      jest.advanceTimersByTime(WARM_GAP_MS);
      slices += 1;
    }
    // 4 passes of about 128 cards per slice, and the labels.
    expect(slices).toBeGreaterThanOrEqual(Math.ceil((4 * state.cards.length) / 128));
    expect(warmup.isWarmed(target)).toBe(true);
    expect(done).toHaveBeenCalledTimes(1);
    expect(done.mock.calls[0][1]).toBe(state.cards.length);
    expect(done.mock.calls[0][2]).toBe(state.cards.length);
    // The work of all slices together: each slice a little over WARM_SLICE_MS on this clock.
    expect(done.mock.calls[0][0]).toBeGreaterThan(slices * WARM_SLICE_MS);
    // Everything is in the caches: the first uses read no note.
    const before = reads();
    for (const card of state.cards) {
      const note = target.index.noteById.get(card.noteId);
      if (note) target.index.searchText(note);
      faceHeadline(card, target.index, target.decks);
    }
    expect(reads()).toBe(before);
    // Nothing more to do for the same data.
    warmup.start(target, 0);
    expect(jest.getTimerCount()).toBe(0);
    expect(done).toHaveBeenCalledTimes(1);
  });

  test('the search text of EVERY note is ready first: after the slices of the first part, a search reads no note — the headlines come later', () => {
    const { state, reads } = counting(library('p2-ctl-first'));
    const target = warmTargetOf(state); // building the index reads the notes (which fields are filter groups)
    const atStart = reads();
    // Every question stops a slice: 64 cards per slice, and a slice never runs into the next part.
    const { warmup } = controller(WARM_SLICE_MS + 1);
    warmup.start(target, 0);
    const searchDone = warmDoneAt(state.cards, 'searchText');
    expect(searchDone).toBe(state.cards.length);
    const slices = Math.ceil(searchDone / 64);
    jest.advanceTimersByTime(0);
    for (let s = 1; s < slices; s++) jest.advanceTimersByTime(WARM_GAP_MS);
    expect(warmup.isRunning()).toBe(true);
    expect(warmup.isWarmed(target)).toBe(false);
    // The first part read each note of a card ONCE (its search text) and nothing else.
    const notesOfCards = new Set(state.cards.map((card) => card.noteId).filter((id) => target.index.noteById.has(id)));
    expect(reads() - atStart).toBe(notesOfCards.size);
    // Every note's search text is ready: searching reads no note.
    const afterFirstPart = reads();
    for (const id of notesOfCards) target.index.searchText(target.index.noteById.get(id)!);
    expect(reads()).toBe(afterFirstPart);
    // The next part is not done yet: the headlines still read their notes.
    for (const card of state.cards) faceHeadline(card, target.index, target.decks);
    expect(reads()).toBeGreaterThan(afterFirstPart);
    warmup.stop();
  });

  test('new data stops the old run: never two warm-ups at once; only the new data is warmed', () => {
    const first = library('p2-two');
    const second = { ...first, notes: first.notes.map((note) => ({ ...note })) }; // an edit of every note: a new index
    const a = warmTargetOf(first);
    const b = warmTargetOf(second);
    expect(b.index).not.toBe(a.index);
    const { warmup, done } = controller();
    warmup.start(a, 0);
    jest.advanceTimersByTime(0);
    jest.advanceTimersByTime(WARM_GAP_MS);
    expect(warmup.isRunning()).toBe(true);
    warmup.start(b, WARM_RESTART_MS);
    expect(jest.getTimerCount()).toBe(1); // the old run's timer is gone
    jest.runAllTimers();
    expect(warmup.isWarmed(b)).toBe(true);
    expect(warmup.isWarmed(a)).toBe(false);
    expect(done).toHaveBeenCalledTimes(1); // the old run never completed
    expect(done.mock.calls[0][1]).toBe(second.cards.length);
  });

  test('stop(): no timer left, nothing warmed; a later start of the same data goes on and completes once', () => {
    const target = warmTargetOf(library('p2-stop'));
    const { warmup, done } = controller();
    warmup.start(target, 0);
    jest.advanceTimersByTime(0);
    expect(warmup.isRunning()).toBe(true);
    warmup.stop();
    expect(warmup.isRunning()).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(60_000);
    expect(warmup.isWarmed(target)).toBe(false);
    expect(done).not.toHaveBeenCalled();
    warmup.start(target, 0);
    warmup.start(target, 0); // a second start of the same data does not start a second run
    expect(jest.getTimerCount()).toBe(1);
    jest.runAllTimers();
    expect(warmup.isWarmed(target)).toBe(true);
    expect(done).toHaveBeenCalledTimes(1);
  });

  test('after a rating (the same library, one new card object) only that card is walked; an edit (a new index) walks every card', () => {
    const state = library('p2-rating');
    const target = warmTargetOf(state);
    const { warmup, done } = controller();
    warmup.start(target, 0);
    jest.runAllTimers();
    expect(done).toHaveBeenCalledTimes(1);
    // A rating: a new cards array with one new card object; notes, card types and decks are the same.
    const rated: DataStateV3 = { ...state, cards: state.cards.map((c, i) => (i === 5 ? { ...c, reps: c.reps + 1 } : c)) };
    const ratedTarget = warmTargetOf(rated);
    expect(ratedTarget.index).toBe(target.index);
    expect(cardsToWarm(target, ratedTarget)).toEqual([rated.cards[5]]);
    warmup.start(ratedTarget, WARM_RESTART_MS);
    jest.runAllTimers();
    expect(warmup.isWarmed(ratedTarget)).toBe(true);
    expect(done).toHaveBeenCalledTimes(2);
    expect(done.mock.calls[1].slice(1)).toEqual([1, state.cards.length]);
    // An edit: new note objects → a new index → every card.
    const edited: DataStateV3 = { ...rated, notes: rated.notes.map((n, i) => (i === 0 ? { ...n } : n)) };
    const editedTarget = warmTargetOf(edited);
    expect(cardsToWarm(ratedTarget, editedTarget)).toBe(edited.cards);
    warmup.start(editedTarget, WARM_RESTART_MS);
    jest.runAllTimers();
    expect(done.mock.calls[2].slice(1)).toEqual([state.cards.length, state.cards.length]);
    // Cards added or removed: every card too.
    expect(cardsToWarm(editedTarget, { ...editedTarget, cards: edited.cards.slice(1) })).toHaveLength(edited.cards.length - 1);
    expect(cardsToWarm(null, editedTarget)).toBe(edited.cards);
  });

  test('the app instance prints ONE "[perf] warm" line per complete warm-up', () => {
    expect(perfMarks.enabled).toBe(true);
    perfMarks.clear();
    const state = library('p2-app', 50);
    const target = warmTargetOf(state);
    libraryWarmup.start(target, 0);
    jest.runAllTimers();
    const lines = () => perfMarks.entries().filter((entry) => entry.name === 'warm');
    expect(libraryWarmup.isWarmed(target)).toBe(true);
    expect(lines()).toHaveLength(1);
    expect(lines()[0].detail).toBe(`${state.cards.length.toLocaleString('en-US')} cards`);
    // A rating: one more line, for the one changed card.
    const rated = warmTargetOf({ ...state, cards: state.cards.map((c, i) => (i === 0 ? { ...c } : c)) });
    libraryWarmup.start(rated, 0);
    jest.runAllTimers();
    expect(lines()).toHaveLength(2);
    expect(lines()[1].detail).toBe(`1 of ${state.cards.length.toLocaleString('en-US')} cards`);
    libraryWarmup.stop();
  });
});

/* ------------------------------------------------------------------ the hook */

/** A stand-in engine: the two stores the hook reads. */
function fakeEngine(state: DataStateV3): { engine: Engine; store: Store<DataStateV3>; meta: Store<EngineMeta> } {
  const store = createStore(state);
  const meta = createStore<EngineMeta>({ ready: false, persistError: null, lastCompletion: null });
  return { engine: { store, meta } as unknown as Engine, store, meta };
}

/** A controller that records its calls (and uses Date.now, which the fake timers move). */
function recordingWarmup(): { warmup: LibraryWarmup; calls: string[] } {
  const real = createLibraryWarmup({
    clock: () => Date.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  const calls: string[] = [];
  const warmup: LibraryWarmup = {
    ...real,
    start: (target, delayMs) => {
      calls.push(`start ${delayMs}`);
      real.start(target, delayMs);
    },
    stop: () => {
      calls.push('stop');
      real.stop();
    },
    startSoon: (delayMs) => {
      calls.push(`soon ${delayMs}`);
      return real.startSoon(delayMs);
    },
  };
  return { warmup, calls };
}

function mount(engine: Engine, warmup: LibraryWarmup): ReactTestRenderer {
  const Probe = () => {
    useLibraryWarmup(warmup);
    return null;
  };
  let r!: ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(React.createElement(EngineContext.Provider, { value: engine }, React.createElement(Probe)));
  });
  renderers.push(r);
  return r;
}

describe('useLibraryWarmup (the tab layout)', () => {
  test('nothing before the app is ready; then the first start 1.5 s after ready', () => {
    const { engine, store, meta } = fakeEngine(library('p2-hook'));
    const { warmup, calls } = recordingWarmup();
    mount(engine, warmup);
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(calls).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
    act(() => meta.update((m) => ({ ...m, ready: true })));
    expect(calls).toEqual([`start ${WARM_START_AFTER_READY_MS}`]);
    const target = warmTargetOf(store.getState());
    act(() => {
      jest.advanceTimersByTime(WARM_START_AFTER_READY_MS - 1);
    });
    expect(warmup.isWarmed(target)).toBe(false);
    act(() => {
      jest.advanceTimersByTime(1);
    });
    act(() => {
      jest.runAllTimers();
    });
    expect(warmup.isWarmed(target)).toBe(true);
  });

  test('new data starts it again for the new data (400 ms later); a settings change does not; unmounting stops it', () => {
    const { engine, store, meta } = fakeEngine(library('p2-hook-data'));
    const { warmup, calls } = recordingWarmup();
    const r = mount(engine, warmup);
    act(() => meta.update((m) => ({ ...m, ready: true })));
    act(() => {
      jest.runAllTimers();
    });
    expect(warmup.isWarmed(warmTargetOf(store.getState()))).toBe(true);
    calls.length = 0;
    // A settings change: not the warm-up's data.
    act(() => store.update((s) => ({ ...s, settings: { ...s.settings, sessionLimit: 7 } })));
    expect(calls).toEqual([]);
    // A rating: a new cards array.
    act(() => store.update((s) => ({ ...s, cards: s.cards.map((c, i) => (i === 0 ? { ...c, reps: c.reps + 1 } : c)) })));
    expect(calls).toEqual(['stop', `start ${WARM_RESTART_MS}`]);
    const rated = warmTargetOf(store.getState());
    expect(warmup.isWarmed(rated)).toBe(false);
    act(() => {
      jest.advanceTimersByTime(WARM_RESTART_MS);
    });
    expect(warmup.isWarmed(rated)).toBe(true);
    // Another rating, then the layout goes away before the run: it stops, and no timer is left.
    act(() => store.update((s) => ({ ...s, cards: s.cards.map((c, i) => (i === 1 ? { ...c, reps: c.reps + 1 } : c)) })));
    expect(warmup.isRunning()).toBe(true);
    act(() => r.unmount());
    renderers.splice(renderers.indexOf(r), 1);
    expect(calls[calls.length - 1]).toBe('stop');
    expect(warmup.isRunning()).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('data that changes in the first 1.5 s does not start it earlier than 1.5 s after ready', () => {
    const { engine, store, meta } = fakeEngine(library('p2-hook-early'));
    const { warmup, calls } = recordingWarmup();
    mount(engine, warmup);
    act(() => meta.update((m) => ({ ...m, ready: true })));
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    act(() => store.update((s) => ({ ...s, cards: s.cards.map((c, i) => (i === 0 ? { ...c, fav: !c.fav } : c)) })));
    expect(calls).toEqual([`start ${WARM_START_AFTER_READY_MS}`, 'stop', `start ${WARM_START_AFTER_READY_MS - 1000}`]);
    const target = warmTargetOf(store.getState());
    act(() => {
      jest.advanceTimersByTime(WARM_START_AFTER_READY_MS - 1000 - 1);
    });
    expect(warmup.isWarmed(target)).toBe(false);
    act(() => {
      jest.runAllTimers();
    });
    expect(warmup.isWarmed(target)).toBe(true);
  });

  test('a change near the end of the first 1.5 s still waits WARM_RESTART_MS (the first frames after new data come first)', () => {
    const { engine, store, meta } = fakeEngine(library('p2-hook-late'));
    const { warmup, calls } = recordingWarmup();
    mount(engine, warmup);
    act(() => meta.update((m) => ({ ...m, ready: true })));
    act(() => {
      jest.advanceTimersByTime(1400);
    });
    act(() => store.update((s) => ({ ...s, cards: s.cards.map((c, i) => (i === 0 ? { ...c, fav: !c.fav } : c)) })));
    expect(calls).toEqual([`start ${WARM_START_AFTER_READY_MS}`, 'stop', `start ${WARM_RESTART_MS}`]);
  });
});

/* ------------------------------------------------------------------ unit P3 */

/** A rating of one card: a new cards array of the same library (a new warm-up target). */
function rate(state: DataStateV3, at: number): DataStateV3 {
  return { ...state, cards: state.cards.map((c, i) => (i === at ? { ...c, reps: c.reps + 1 } : c)) };
}

/**
 * A controller whose slices measure with Date.now, which does not move while
 * a slice runs: every run is ONE slice, so `done` says when a run began.
 */
function wallController(): { warmup: LibraryWarmup; done: jest.Mock<(ms: number, walked: number, total: number) => void> } {
  const done = jest.fn<(ms: number, walked: number, total: number) => void>();
  const warmup = createLibraryWarmup({
    clock: () => Date.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    done,
  });
  return { warmup, done };
}

describe('unit P3 — onWarmed: a listener called once when a run completes', () => {
  test('called ONCE, at the end of the run (the data is warmed then); never again for a later run; a removed one is never called; no timer left', () => {
    const state = library('p3-on');
    const target = warmTargetOf(state);
    const { warmup } = controller();
    const heard = jest.fn(() => expect(warmup.isWarmed(target)).toBe(true));
    const removed = jest.fn();
    warmup.onWarmed(heard);
    const off = warmup.onWarmed(removed);
    // Waiting costs nothing: no timer of its own.
    expect(jest.getTimerCount()).toBe(0);
    warmup.start(target, 0);
    jest.advanceTimersByTime(0);
    expect(warmup.isRunning()).toBe(true);
    expect(heard).not.toHaveBeenCalled(); // not after a slice, only after the whole run
    off();
    jest.runAllTimers();
    expect(warmup.isWarmed(target)).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    // The next run (a rating) completes: the listener was used up.
    warmup.start(warmTargetOf(rate(state, 3)), 0);
    jest.runAllTimers();
    expect(heard).toHaveBeenCalledTimes(1);
    off(); // removing it twice is harmless
  });

  test('a listener added while the listeners are called waits for the NEXT run; one removed by an earlier listener is skipped', () => {
    const state = library('p3-on-order');
    const { warmup } = controller();
    const later = jest.fn();
    const skipped = jest.fn();
    let offSkipped = () => {};
    const first = jest.fn(() => {
      warmup.onWarmed(later);
      offSkipped();
    });
    warmup.onWarmed(first);
    offSkipped = warmup.onWarmed(skipped);
    warmup.start(warmTargetOf(state), 0);
    jest.runAllTimers();
    expect(first).toHaveBeenCalledTimes(1);
    expect(later).not.toHaveBeenCalled();
    expect(skipped).not.toHaveBeenCalled();
    warmup.start(warmTargetOf(rate(state, 1)), 0);
    jest.runAllTimers();
    expect(first).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledTimes(1);
    expect(skipped).not.toHaveBeenCalled();
  });
});

describe("unit P3 — runWhenWarmed: the Library's order step waits with NO polling", () => {
  test('the warm-up not begun yet: after its delay the step waits with NO timer (a minute in the background costs nothing); once the run completes, the step runs ONCE a frame later; nothing is left', () => {
    const state = library('p3-wait');
    const target = warmTargetOf(state);
    const { warmup } = controller();
    const step = jest.fn(() => expect(warmup.isWarmed(target)).toBe(true));
    const cancel = runWhenWarmed(warmup, target, 400, step);
    expect(jest.getTimerCount()).toBe(1); // its first look, 400 ms later
    jest.advanceTimersByTime(400);
    expect(step).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0); // waiting: no timer at all (before unit P3: a look every 100 ms, forever)
    jest.advanceTimersByTime(60_000);
    expect(step).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    // The shared warm-up runs: while its slices run, the only timer is the warm-up's own.
    warmup.start(target, 0);
    jest.advanceTimersByTime(0);
    while (warmup.isRunning()) {
      expect(jest.getTimerCount()).toBe(1);
      expect(step).not.toHaveBeenCalled();
      jest.advanceTimersByTime(WARM_GAP_MS);
    }
    // The run completed: the step comes a frame later (not in the same moment as the last slice).
    expect(warmup.isWarmed(target)).toBe(true);
    expect(step).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(WARM_GAP_MS - 1);
    expect(step).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(step).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    // After it ran, nothing is left: a later run does not call it, and cancel is harmless.
    warmup.start(warmTargetOf(rate(state, 5)), 0);
    jest.runAllTimers();
    cancel();
    expect(step).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('already warmed: the step runs right after the delay; a run of OTHER data completing first does not run it (it waits again)', () => {
    const state = library('p3-warm');
    const a = warmTargetOf(state);
    const b = warmTargetOf(rate(state, 2));
    const { warmup } = controller();
    warmup.start(a, 0);
    jest.runAllTimers();
    const stepA = jest.fn();
    runWhenWarmed(warmup, a, 400, stepA);
    jest.advanceTimersByTime(399);
    expect(stepA).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(stepA).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    // b is not warmed. A run of other data completes first: b's step waits again, with no timer.
    const stepB = jest.fn(() => expect(warmup.isWarmed(b)).toBe(true));
    runWhenWarmed(warmup, b, 0, stepB);
    jest.advanceTimersByTime(0);
    warmup.start(warmTargetOf(rate(state, 4)), 0);
    jest.runAllTimers();
    expect(stepB).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    warmup.start(b, 0);
    jest.runAllTimers();
    expect(stepB).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('cancel (the screen went away, or new data): during the delay or while waiting — the step never runs, no timer and no listener are left', () => {
    const target = warmTargetOf(library('p3-cancel'));
    const { warmup } = controller();
    const during = jest.fn();
    const cancelDuring = runWhenWarmed(warmup, target, 400, during);
    cancelDuring();
    expect(jest.getTimerCount()).toBe(0);
    const waiting = jest.fn();
    const cancelWaiting = runWhenWarmed(warmup, target, 400, waiting);
    jest.advanceTimersByTime(400); // now it waits for the run (a listener, no timer)
    cancelWaiting();
    // The run completes: only the test's own listener is called, and nothing is planned after it.
    const heard = jest.fn();
    warmup.onWarmed(heard);
    warmup.start(target, 0);
    jest.runAllTimers();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(during).not.toHaveBeenCalled();
    expect(waiting).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('unit P3 — startSoon: a Library opened early makes the warm-up begin sooner', () => {
  test('a first run planned 1.5 s away begins WARM_SOON_MS after the request — one timer, one run', () => {
    expect(WARM_SOON_MS).toBe(400); // the delay of the Library's own warm-up of unit P1
    const target = warmTargetOf(library('p3-soon'));
    const { warmup, done } = wallController();
    warmup.start(target, WARM_START_AFTER_READY_MS);
    jest.advanceTimersByTime(200);
    warmup.startSoon(WARM_SOON_MS);
    expect(jest.getTimerCount()).toBe(1); // moved, not added: never two warm-ups
    jest.advanceTimersByTime(WARM_SOON_MS - 1);
    expect(done).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(1); // 600 ms after the start, not 1,500
    expect(warmup.isWarmed(target)).toBe(true);
    jest.advanceTimersByTime(WARM_START_AFTER_READY_MS);
    expect(done).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('never LATER than planned: a run due in 200 ms stays at 200 ms', () => {
    const target = warmTargetOf(library('p3-soon-late'));
    const { warmup, done } = wallController();
    warmup.start(target, WARM_START_AFTER_READY_MS);
    jest.advanceTimersByTime(WARM_START_AFTER_READY_MS - 200);
    warmup.startSoon(WARM_SOON_MS);
    jest.advanceTimersByTime(199);
    expect(done).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  test('before the app is ready (no start yet) nothing starts; then every start waits at most WARM_SOON_MS (a shorter wait stays shorter)', () => {
    const state = library('p3-soon-ready');
    const { warmup, done } = wallController();
    warmup.startSoon(WARM_SOON_MS);
    expect(jest.getTimerCount()).toBe(0);
    expect(warmup.isRunning()).toBe(false);
    jest.advanceTimersByTime(10_000);
    expect(done).not.toHaveBeenCalled();
    // The app is ready: the hook asks for 1.5 s, the Library's request makes it 400 ms.
    const first = warmTargetOf(state);
    warmup.start(first, WARM_START_AFTER_READY_MS);
    jest.advanceTimersByTime(WARM_SOON_MS - 1);
    expect(done).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(1);
    expect(warmup.isWarmed(first)).toBe(true);
    // Later data with a long wait: at most 400 ms too.
    warmup.start(warmTargetOf(rate(state, 1)), WARM_START_AFTER_READY_MS);
    jest.advanceTimersByTime(WARM_SOON_MS);
    expect(done).toHaveBeenCalledTimes(2);
    // A shorter wait stays shorter.
    warmup.start(warmTargetOf(rate(state, 2)), 100);
    jest.advanceTimersByTime(100);
    expect(done).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('wave 5h review: ending the request (the Library closed) lets later runs wait their own time again', () => {
    const state = library('p3-soon-end');
    const { warmup, done } = wallController();
    const end = warmup.startSoon(WARM_SOON_MS);
    warmup.start(warmTargetOf(state), WARM_START_AFTER_READY_MS);
    jest.advanceTimersByTime(WARM_SOON_MS);
    expect(done).toHaveBeenCalledTimes(1); // the open Library made it 400 ms
    end();
    end(); // a second call changes nothing
    // A later app start (after Erase everything, a data problem): its own 1.5 s again.
    warmup.start(warmTargetOf(rate(state, 1)), WARM_START_AFTER_READY_MS);
    jest.advanceTimersByTime(WARM_START_AFTER_READY_MS - 1);
    expect(done).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('two open requests: ending one keeps the other', () => {
    const state = library('p3-soon-two');
    const { warmup, done } = wallController();
    const endLong = warmup.startSoon(WARM_SOON_MS);
    warmup.startSoon(200);
    endLong();
    warmup.start(warmTargetOf(state), WARM_START_AFTER_READY_MS);
    jest.advanceTimersByTime(200);
    expect(done).toHaveBeenCalledTimes(1); // the 200 ms request still holds
  });

  test('during a run (slices WARM_GAP_MS apart) it changes nothing: the next slice still comes a frame later', () => {
    const target = warmTargetOf(library('p3-soon-run'));
    const { warmup, clockReads } = controller();
    warmup.start(target, 0);
    jest.advanceTimersByTime(0);
    expect(warmup.isRunning()).toBe(true);
    const reads = clockReads();
    warmup.startSoon(WARM_SOON_MS);
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(WARM_GAP_MS);
    expect(clockReads()).toBeGreaterThan(reads); // the next slice ran on time
    warmup.stop();
  });
});

/** The Library screen: only its request for a warm-up soon. */
function mountLibrary(warmup: LibraryWarmup): ReactTestRenderer {
  const Probe = () => {
    useLibraryWarmupSoon(warmup);
    return null;
  };
  let r!: ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(React.createElement(Probe));
  });
  renderers.push(r);
  return r;
}

describe('unit P3 — useLibraryWarmupSoon (the Library opens)', () => {
  test('the Library opens 200 ms after ready: the shared warm-up begins 400 ms later, not 1.5 s after ready — still one warm-up', () => {
    const { engine, store, meta } = fakeEngine(library('p3-hook'));
    const { warmup, calls } = recordingWarmup();
    mount(engine, warmup);
    act(() => meta.update((m) => ({ ...m, ready: true })));
    act(() => {
      jest.advanceTimersByTime(200);
    });
    mountLibrary(warmup);
    expect(calls).toEqual([`start ${WARM_START_AFTER_READY_MS}`, `soon ${WARM_SOON_MS}`]);
    expect(jest.getTimerCount()).toBe(1);
    const target = warmTargetOf(store.getState());
    act(() => {
      jest.advanceTimersByTime(WARM_SOON_MS - 1);
    });
    expect(warmup.isWarmed(target)).toBe(false);
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(warmup.isWarmed(target)).toBe(true); // 600 ms after ready (this clock does a whole run in one slice)
    expect(jest.getTimerCount()).toBe(0);
  });

  test('the Library opens BEFORE the app is ready: nothing runs before ready; then the first run begins 400 ms after ready', () => {
    const { engine, store, meta } = fakeEngine(library('p3-hook-early'));
    const { warmup, calls } = recordingWarmup();
    mount(engine, warmup);
    mountLibrary(warmup);
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(calls).toEqual([`soon ${WARM_SOON_MS}`]);
    expect(jest.getTimerCount()).toBe(0);
    act(() => meta.update((m) => ({ ...m, ready: true })));
    expect(calls).toEqual([`soon ${WARM_SOON_MS}`, `start ${WARM_START_AFTER_READY_MS}`]);
    const target = warmTargetOf(store.getState());
    act(() => {
      jest.advanceTimersByTime(WARM_SOON_MS - 1);
    });
    expect(warmup.isWarmed(target)).toBe(false);
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(warmup.isWarmed(target)).toBe(true);
  });

  test('wave 5h review: the Library unmounts → its request ends, and a later run waits its own time', () => {
    const state = library('p3-hook-unmount');
    const { warmup, done } = wallController();
    const r = mountLibrary(warmup);
    act(() => r.unmount());
    renderers.splice(renderers.indexOf(r), 1);
    warmup.start(warmTargetOf(state), WARM_START_AFTER_READY_MS);
    act(() => {
      jest.advanceTimersByTime(WARM_START_AFTER_READY_MS - 1);
    });
    expect(done).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(done).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ unit P4 */

/** A copy of the state whose notes count every read of their fields AND section (the note groups read both). */
function countingAll(state: DataStateV3): { state: DataStateV3; reads: () => number } {
  let reads = 0;
  const notes = state.notes.map((note) => {
    const copy = { ...note } as Note;
    for (const key of ['fields', 'section'] as const) {
      const value = note[key];
      Object.defineProperty(copy, key, {
        enumerable: true,
        get: () => {
          reads += 1;
          return value;
        },
      });
    }
    return copy;
  });
  return { state: { ...state, notes }, reads: () => reads };
}

/** A fake of the app's writes (persistWrites): `writing` is set by the test; end() calls the waiting listeners. */
function fakeWrites(): { writes: WriteActivity; set: (on: boolean) => void; waiting: () => number } {
  let writing = false;
  const idle = new Set<() => void>();
  return {
    writes: {
      busy: () => writing,
      onIdle(listener) {
        const once = () => listener();
        idle.add(once);
        return () => {
          idle.delete(once);
        };
      },
    },
    set(on) {
      writing = on;
      if (on) return;
      for (const listener of [...idle]) {
        idle.delete(listener);
        listener();
      }
    },
    waiting: () => idle.size,
  };
}

/** A controller with a clock that moves 1 ms per read, and the given extra options. */
function p4Controller(extra: Partial<LibraryWarmupOptions> = {}): { warmup: LibraryWarmup; done: jest.Mock; clockReads: () => number } {
  let t = 0;
  const done = jest.fn();
  const warmup = createLibraryWarmup({
    clock: () => (t += 1),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    done,
    ...extra,
  });
  return { warmup, done, clockReads: () => t };
}

describe('unit P4 — a run also makes the note lookups and the Deck order; slices wait for a save', () => {
  test('WARM_ORDER_SORT is the Library default sort (Deck order)', () => {
    expect(WARM_ORDER_SORT).toEqual(DEFAULT_SORT);
  });

  test('a complete run made the note lookups and the Deck order: Section and Card type chips then read no note', () => {
    const { state, reads } = countingAll(library('p4-run'));
    const target = warmTargetOf(state);
    const { warmup, done } = p4Controller();
    warmup.start(target, 0);
    expect(noteSetsReady(target.index)).toBe(false);
    expect(libraryOrderReady(target, WARM_ORDER_SORT)).toBe(false);
    jest.runAllTimers();
    expect(warmup.isWarmed(target)).toBe(true);
    expect(done).toHaveBeenCalledTimes(1);
    expect(noteSetsReady(target.index)).toBe(true);
    expect(libraryOrderReady(target, WARM_ORDER_SORT)).toBe(true);
    // A section and a card type that the library has: the pools read no note.
    const ctx = matchCtxOf(state, NOW);
    const withSection = state.notes.find((note) => target.index.sectionPath(note) !== '');
    expect(withSection).toBeDefined();
    const before = reads();
    const deckId = state.cards.find((card) => card.noteId === withSection!.id)!.deckId;
    const section = scopePool(state, { sections: [{ deckId, path: target.index.sectionPath(withSection!) }] }, ctx, 'browse');
    const typed = scopePool(state, { noteTypes: [withSection!.typeId] }, ctx, 'study');
    expect(reads()).toBe(before);
    expect(section.length).toBeGreaterThan(0);
    expect(typed.length).toBeGreaterThanOrEqual(0);
  });

  test('after a rating the run walks one card, and its Deck order is the repaired one (ready for the new cards)', () => {
    const state = library('p4-rating');
    const target = warmTargetOf(state);
    const { warmup, done } = p4Controller();
    warmup.start(target, 0);
    jest.runAllTimers();
    const rated = warmTargetOf({ ...state, cards: state.cards.map((c, i) => (i === 3 ? { ...c, reps: c.reps + 1 } : c)) });
    expect(libraryOrderReady(rated, WARM_ORDER_SORT)).toBe(false);
    warmup.start(rated, WARM_RESTART_MS);
    jest.runAllTimers();
    expect(done.mock.calls[1].slice(1)).toEqual([1, state.cards.length]);
    expect(libraryOrderReady(rated, WARM_ORDER_SORT)).toBe(true);
  });

  test('a slice that would run while a save is written waits: no timer, no clock read; a frame after the write it goes on', () => {
    const target = warmTargetOf(library('p4-writes'));
    const fake = fakeWrites();
    const { warmup, done, clockReads } = p4Controller({ writes: fake.writes });
    fake.set(true);
    warmup.start(target, 0);
    jest.advanceTimersByTime(0);
    // The planned slice found a save being written: it waits for it, with no timer and no work.
    expect(clockReads()).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    expect(fake.waiting()).toBe(1);
    expect(warmup.isRunning()).toBe(true);
    // The same data again (the hook's effect): still ONE planned slice, not a second one.
    warmup.start(target, 0);
    expect(jest.getTimerCount()).toBe(0);
    expect(fake.waiting()).toBe(1);
    jest.advanceTimersByTime(60_000);
    expect(clockReads()).toBe(0);
    // The write ends: the slice runs a frame (WARM_GAP_MS) later.
    fake.set(false);
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(WARM_GAP_MS - 1);
    expect(clockReads()).toBe(0);
    jest.advanceTimersByTime(1);
    expect(clockReads()).toBeGreaterThan(0);
    // A save in the middle of the run: the next slice waits again, then the run completes ONCE.
    fake.set(true);
    jest.advanceTimersByTime(WARM_GAP_MS);
    const frozen = clockReads();
    jest.advanceTimersByTime(10_000);
    expect(clockReads()).toBe(frozen);
    fake.set(false);
    jest.runAllTimers();
    expect(warmup.isWarmed(target)).toBe(true);
    expect(done).toHaveBeenCalledTimes(1);
    expect(fake.waiting()).toBe(0);
  });

  test('stop() while a slice waits for a save removes the wait: nothing runs after the write', () => {
    const target = warmTargetOf(library('p4-writes-stop'));
    const fake = fakeWrites();
    const { warmup, done, clockReads } = p4Controller({ writes: fake.writes });
    fake.set(true);
    warmup.start(target, 0);
    jest.advanceTimersByTime(0);
    expect(fake.waiting()).toBe(1);
    warmup.stop();
    expect(fake.waiting()).toBe(0);
    expect(warmup.isRunning()).toBe(false);
    fake.set(false);
    jest.runAllTimers();
    expect(clockReads()).toBe(0);
    expect(done).not.toHaveBeenCalled();
  });

  test('the app instance waits for the app’s real saves (persistController persistWrites)', async () => {
    perfMarks.clear();
    const gate: { open: () => void } = { open: () => undefined };
    const persist = createPersistController<DataStateV3>(
      {
        load: async () => ({ kind: 'empty' }),
        save: () =>
          new Promise<void>((resolve) => {
            gate.open = resolve;
          }),
        replaceAll: async () => undefined,
        preserveCorrupt: async () => undefined,
        readRaw: async () => null,
      },
      { now: () => NOW, decode: (value) => ({ kind: 'ok', state: value as DataStateV3 }), seed: () => library('p4-app-seed', 1) },
    );
    await persist.load();
    const state = library('p4-app-writes', 50);
    persist.scheduleSave(state);
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(persistWrites.busy()).toBe(true);
    libraryWarmup.start(warmTargetOf(state), 0);
    await jest.advanceTimersByTimeAsync(10_000);
    const warmLines = () => perfMarks.entries().filter((entry) => entry.name === 'warm');
    expect(warmLines()).toHaveLength(0);
    expect(libraryWarmup.isRunning()).toBe(true);
    gate.open();
    await jest.advanceTimersByTimeAsync(0);
    expect(persistWrites.busy()).toBe(false);
    await jest.runAllTimersAsync();
    expect(warmLines()).toHaveLength(1);
    expect(libraryWarmup.isWarmed(warmTargetOf(state))).toBe(true);
    libraryWarmup.stop();
  });
});

describe('unit P4 — warmSearchText: the search box got the focus, the search text of every note NOW', () => {
  test('before the first slice: every note of a card read ONCE, a search then reads no note; the run goes on with the next part', () => {
    const { state, reads } = counting(library('p4-focus'));
    const target = warmTargetOf(state);
    const atStart = reads();
    const searchWarmed = jest.fn();
    const { warmup, done } = p4Controller({ searchWarmed });
    warmup.start(target, WARM_START_AFTER_READY_MS);
    const ms = warmup.warmSearchText(target);
    expect(ms).toBeGreaterThan(0);
    expect(searchWarmed).toHaveBeenCalledTimes(1);
    expect(searchWarmed.mock.calls[0].slice(1)).toEqual([state.cards.length, state.cards.length]);
    const notesOfCards = new Set(state.cards.map((card) => card.noteId).filter((id) => target.index.noteById.has(id)));
    expect(reads() - atStart).toBe(notesOfCards.size);
    // A search reads no note now.
    const afterFocus = reads();
    scopePool(state, { text: 'meaning' }, matchCtxOf(state, NOW), 'browse');
    scopePool(state, { text: 'zz-nothing' }, matchCtxOf(state, NOW), 'browse');
    expect(reads()).toBe(afterFocus);
    // A second focus: nothing to do.
    expect(warmup.warmSearchText(target)).toBe(0);
    expect(searchWarmed).toHaveBeenCalledTimes(1);
    // Only the search text was made: a headline still reads its note (the next part comes with the slices).
    faceHeadline(state.cards[state.cards.length - 1], target.index, target.decks);
    expect(reads()).toBeGreaterThan(afterFocus);
    // The run goes on as planned and completes once.
    expect(warmup.isRunning()).toBe(true);
    jest.runAllTimers();
    expect(warmup.isWarmed(target)).toBe(true);
    expect(done).toHaveBeenCalledTimes(1);
  });

  test('in the middle of the first part: only the rest of it; after that part, or after a complete run: 0, nothing read', () => {
    const { state, reads } = counting(library('p4-focus-mid'));
    const target = warmTargetOf(state);
    // Every question stops a slice: 64 cards per slice.
    const { warmup } = controller(WARM_SLICE_MS + 1);
    warmup.start(target, 0);
    jest.advanceTimersByTime(0); // one slice: the first 64 cards of the search-text part
    const before = reads();
    expect(warmup.warmSearchText(target)).toBeGreaterThan(0);
    const notesLeft = new Set(state.cards.slice(64).map((card) => card.noteId));
    for (const card of state.cards.slice(0, 64)) notesLeft.delete(card.noteId);
    expect(reads() - before).toBe(notesLeft.size);
    expect(warmup.warmSearchText(target)).toBe(0);
    jest.runAllTimers();
    expect(warmup.isWarmed(target)).toBe(true);
    const after = reads();
    expect(warmup.warmSearchText(target)).toBe(0);
    expect(reads()).toBe(after);
  });

  test('data that no run has begun for: their search text goes into the caches, and their run then reads no note for it', () => {
    const first = library('p4-focus-other');
    const { state: second, reads } = counting({ ...first, notes: first.notes.map((note) => ({ ...note })) });
    const a = warmTargetOf(first);
    const b = warmTargetOf(second);
    const { warmup, done } = p4Controller();
    warmup.start(a, 0);
    jest.runAllTimers();
    // The Library shows newer data than the warm-up has seen (its effect has not run yet).
    const before = reads();
    expect(warmup.warmSearchText(b)).toBeGreaterThan(0);
    expect(reads()).toBeGreaterThan(before);
    const afterFocus = reads();
    for (const card of second.cards) {
      const note = b.index.noteById.get(card.noteId);
      if (note) b.index.searchText(note);
    }
    expect(reads()).toBe(afterFocus);
    // The run of the new data begins later and completes.
    warmup.start(b, WARM_RESTART_MS);
    jest.runAllTimers();
    expect(warmup.isWarmed(b)).toBe(true);
    expect(done).toHaveBeenCalledTimes(2);
  });

  test('the app instance prints one "[perf] search-warm" line when the focus made the search text', () => {
    perfMarks.clear();
    const state = library('p4-focus-app', 50);
    const target = warmTargetOf(state);
    libraryWarmup.start(target, WARM_START_AFTER_READY_MS);
    libraryWarmup.warmSearchText(target);
    libraryWarmup.warmSearchText(target);
    const lines = perfMarks.entries().filter((entry) => entry.name === 'search-warm');
    expect(lines).toHaveLength(1);
    expect(lines[0].detail).toBe(`${state.cards.length.toLocaleString('en-US')} cards`);
    libraryWarmup.stop();
  });
});

/* ------------------------------------------------------------------ unit P4 review */

/** Libraries glued together (ids kept apart) until there are at least `min` cards: the parts then need many slices. */
function bigLibrary(tag: string, min: number): DataStateV3 {
  let state = library(`${tag}-0`);
  for (let k = 1; state.cards.length < min; k++) {
    const more = library(`${tag}-${k}`);
    const id = (x: string) => `g${k}-${x}`;
    const deckOf = new Map(more.decks.map((d, j) => [d.id, state.decks[j % state.decks.length].id]));
    state = {
      ...state,
      notes: [...state.notes, ...more.notes.map((n) => ({ ...n, id: id(n.id) }))],
      cards: [
        ...state.cards,
        ...more.cards.map((c) => ({ ...c, id: id(c.id), noteId: id(c.noteId), deckId: deckOf.get(c.deckId) ?? c.deckId })),
      ],
    };
  }
  return state;
}

/** Run the planned slices one by one (each WARM_GAP_MS after the last): the clock reads of each, until the run is warmed. */
function slicesUntilWarmed(
  warmup: LibraryWarmup,
  target: ReturnType<typeof warmTargetOf>,
  clockReads: () => number,
  before?: () => void,
): number[] {
  const out: number[] = [];
  for (let guard = 0; !warmup.isWarmed(target) && guard < 10_000; guard++) {
    before?.();
    const at = clockReads();
    jest.advanceTimersByTime(WARM_GAP_MS);
    out.push(clockReads() - at);
  }
  return out;
}

describe('unit P4 review — the warm-up’s Deck order a part at a time', () => {
  test('a library NOT stored in Deck order: the order takes several slices, none over the slice budget; then it is the old order', () => {
    const base = bigLibrary('p4r-order', 2500);
    // Mixed: no run of one deck stays together (worse than any real library).
    const state = { ...base, cards: createRandom('p4r-order-mix').sample(base.cards, base.cards.length) };
    const target = warmTargetOf(state);
    const { warmup, done, clockReads } = p4Controller();
    warmup.start(target, 0);
    jest.advanceTimersByTime(0);
    let orderSlices = 0;
    const reads = slicesUntilWarmed(warmup, target, clockReads, () => {
      if (noteSetsReady(target.index) && !libraryOrderReady(target, WARM_ORDER_SORT)) orderSlices += 1;
    });
    expect(done).toHaveBeenCalledTimes(1);
    expect(libraryOrderReady(target, WARM_ORDER_SORT)).toBe(true);
    // Each slice: its start, at most WARM_SLICE_MS + 1 questions "over the budget?" (one read each), its end.
    expect(Math.max(...reads)).toBeLessThanOrEqual(WARM_SLICE_MS + 3);
    expect(orderSlices).toBeGreaterThanOrEqual(2);
    const ctx = matchCtxOf(state, NOW);
    expect(sortScopeCards(state.cards, WARM_ORDER_SORT, state, ctx).map((c) => c.id)).toEqual(
      sortCards(state.cards, WARM_ORDER_SORT, scheduleCtxOf(state, ctx)).map((c) => c.id),
    );
  });
});

describe('unit P4 review — after the focus, the headlines come next: soon, in bigger slices; then a search reads no note', () => {
  test('the planned slice comes a frame later; slices work up to WARM_FOCUS_SLICE_MS until the headlines are done, then WARM_SLICE_MS', () => {
    const state = bigLibrary('p4r-focus-boost', 1500);
    const target = warmTargetOf(state);
    const { warmup, done, clockReads } = p4Controller();
    warmup.start(target, WARM_START_AFTER_READY_MS);
    expect(warmup.warmSearchText(target)).toBeGreaterThan(0);
    const afterFocus = clockReads();
    jest.advanceTimersByTime(WARM_GAP_MS - 1);
    expect(clockReads()).toBe(afterFocus);
    // A frame later, not 1.5 s later.
    jest.advanceTimersByTime(1);
    const first = clockReads() - afterFocus;
    expect(first).toBeGreaterThan(WARM_SLICE_MS + 3);
    expect(first).toBeLessThanOrEqual(WARM_FOCUS_SLICE_MS + 3);
    const rest = slicesUntilWarmed(warmup, target, clockReads);
    // After the big slices of the headlines, only normal slices.
    const normal = rest.findIndex((reads) => reads <= WARM_SLICE_MS + 3);
    expect(normal).toBeGreaterThanOrEqual(0);
    expect(rest.slice(0, normal).every((reads) => reads <= WARM_FOCUS_SLICE_MS + 3)).toBe(true);
    expect(rest.slice(normal).every((reads) => reads <= WARM_SLICE_MS + 3)).toBe(true);
    expect(done).toHaveBeenCalledTimes(1);
    expect(WARM_FOCUS_SLICE_MS).toBe(16);
  });

  test('right after the focus the rows’ headline rank still reads notes; once the headlines are made, the first search reads NO note at all', () => {
    const { state, reads } = counting(bigLibrary('p4r-focus-rows', 1200));
    const target = warmTargetOf(state);
    const { warmup, clockReads } = p4Controller();
    warmup.start(target, WARM_START_AFTER_READY_MS);
    warmup.warmSearchText(target);
    const search = (text: string) => rowsReader(createRowsCache(), serializeQuery({ text }), JSON.stringify(DEFAULT_SORT), 0)(state);
    // The filter reads no note, but the headline rank of the matching rows does (they are not made yet).
    const atFocus = reads();
    expect(search('meaning').length).toBeGreaterThan(1);
    expect(reads()).toBeGreaterThan(atFocus);
    // The big slices: as long as a slice works more than a normal one, the headlines are not done.
    for (let guard = 0; guard < 1000; guard++) {
      const at = clockReads();
      jest.advanceTimersByTime(WARM_GAP_MS);
      if (clockReads() - at <= WARM_SLICE_MS + 3) break;
    }
    // Every headline is made: a new search — filter AND rank — reads no note.
    const ready = reads();
    expect(search('extra').length).toBeGreaterThan(1);
    expect(search('e').length).toBeGreaterThan(state.cards.length / 2);
    search('meaning');
    expect(reads()).toBe(ready);
    jest.runAllTimers();
    expect(warmup.isWarmed(target)).toBe(true);
  });

  test('P4 review 2: a focus while a save is written waits for it (no pass, no timer); a frame after the write the search text is made, and the run completes once', () => {
    // Big enough that the waiting slice (it runs first, a frame after the write) cannot do the whole part alone.
    const { state, reads } = counting(bigLibrary('p4r-focus-save', 1500));
    const target = warmTargetOf(state);
    const fake = fakeWrites();
    const searchWarmed = jest.fn();
    const { warmup, done, clockReads } = p4Controller({ writes: fake.writes, searchWarmed });
    fake.set(true);
    warmup.start(target, 0);
    jest.advanceTimersByTime(0);
    expect(fake.waiting()).toBe(1);
    // The focus during the write: nothing now — no note read, no clock read, no timer.
    const before = reads();
    expect(warmup.warmSearchText(target)).toBe(0);
    expect(reads()).toBe(before);
    expect(clockReads()).toBe(0);
    expect(searchWarmed).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    // The slice and the focus wait for the write (no polling).
    expect(fake.waiting()).toBe(2);
    jest.advanceTimersByTime(10_000);
    expect(reads()).toBe(before);
    expect(clockReads()).toBe(0);
    // The write ends: a frame (WARM_GAP_MS) later the focus makes the search text of every note.
    fake.set(false);
    expect(fake.waiting()).toBe(0);
    jest.advanceTimersByTime(WARM_GAP_MS - 1);
    expect(searchWarmed).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(searchWarmed).toHaveBeenCalledTimes(1);
    expect(searchWarmed.mock.calls[0][2]).toBe(state.cards.length);
    // A search reads no note now.
    const afterFocus = reads();
    scopePool(state, { text: 'meaning' }, matchCtxOf(state, NOW), 'browse');
    expect(reads()).toBe(afterFocus);
    jest.runAllTimers();
    expect(warmup.isWarmed(target)).toBe(true);
    expect(done).toHaveBeenCalledTimes(1);
    expect(searchWarmed).toHaveBeenCalledTimes(1);
  });

  test('P4 review 2: a focus that waits for a save is removed by stop(), by new data and by a newer focus — kept for the same data', () => {
    const fake = fakeWrites();
    const searchWarmed = jest.fn();
    const { warmup } = p4Controller({ writes: fake.writes, searchWarmed });
    /**
     * New data (nothing of it warm yet), a focus during a write, then
     * `between(target)`, then the write ends and a frame passes: how many
     * times the focus made the search text. Nothing is left afterwards.
     */
    const focusThen = (tag: string, between: (target: ReturnType<typeof warmTargetOf>) => void): number => {
      const target = warmTargetOf(library(tag));
      searchWarmed.mockClear();
      fake.set(true);
      warmup.start(target, WARM_START_AFTER_READY_MS);
      expect(warmup.warmSearchText(target)).toBe(0);
      expect(fake.waiting()).toBe(1);
      between(target);
      fake.set(false);
      jest.advanceTimersByTime(WARM_GAP_MS);
      const made = searchWarmed.mock.calls.length;
      warmup.stop();
      jest.runAllTimers();
      return made;
    };
    // stop() (the tab layout's cleanup): nothing runs after the write, no timer is left.
    expect(
      focusThen('p4r-wait-stop', () => {
        warmup.stop();
        expect(fake.waiting()).toBe(0);
      }),
    ).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    // New data (a rating): the focus for the old data does not run.
    expect(
      focusThen('p4r-wait-new', (target) => {
        warmup.start({ ...target, cards: target.cards.map((c, i) => (i === 0 ? { ...c, reps: c.reps + 1 } : c)) }, WARM_RESTART_MS);
        expect(fake.waiting()).toBe(0);
      }),
    ).toBe(0);
    // The same data again (the hook's effect): it still runs, once.
    expect(focusThen('p4r-wait-same', (target) => warmup.start(target, WARM_START_AFTER_READY_MS))).toBe(1);
    // A newer focus replaces the waiting one: ONE pass after the write, not two.
    expect(
      focusThen('p4r-wait-again', (target) => {
        expect(warmup.warmSearchText(target)).toBe(0);
        expect(fake.waiting()).toBe(1);
      }),
    ).toBe(1);
    // Nothing in between: it runs once.
    expect(focusThen('p4r-wait-plain', () => undefined)).toBe(1);
  });

  test('P4 review 2: a focus for data no run has begun for also waits for the save; a new save in its frame makes it wait again', () => {
    const first = library('p4r-focus-wait-other');
    const { state: second, reads } = counting({ ...first, notes: first.notes.map((note) => ({ ...note })) });
    const a = warmTargetOf(first);
    const b = warmTargetOf(second);
    const fake = fakeWrites();
    const searchWarmed = jest.fn();
    const { warmup } = p4Controller({ writes: fake.writes, searchWarmed });
    warmup.start(a, 0);
    jest.runAllTimers();
    fake.set(true);
    const before = reads();
    expect(warmup.warmSearchText(b)).toBe(0);
    expect(reads()).toBe(before);
    fake.set(false);
    // Another save begins before the frame is over: the focus waits for that one too.
    fake.set(true);
    jest.advanceTimersByTime(WARM_GAP_MS);
    expect(searchWarmed).not.toHaveBeenCalled();
    expect(reads()).toBe(before);
    expect(fake.waiting()).toBe(1);
    fake.set(false);
    jest.advanceTimersByTime(WARM_GAP_MS);
    expect(searchWarmed).toHaveBeenCalledTimes(1);
    expect(reads()).toBeGreaterThan(before);
    // Every note's search text is in its cache now.
    const afterFocus = reads();
    for (const card of second.cards) {
      const note = b.index.noteById.get(card.noteId);
      if (note) b.index.searchText(note);
    }
    expect(reads()).toBe(afterFocus);
    warmup.stop();
  });

  test('P4 review 2: the app instance — a focus during a real save is NOT inside its "[perf] save" line; its "search-warm" line comes after', async () => {
    perfMarks.clear();
    const gate: { open: () => void } = { open: () => undefined };
    // The engine's timed port (engine.ts timedPort): the 'save' line is the time of port.save().
    const persist = createPersistController<DataStateV3>(
      {
        load: async () => ({ kind: 'empty' }),
        save: () =>
          perfMarks.timeAsync(
            'save',
            () =>
              new Promise<void>((resolve) => {
                gate.open = resolve;
              }),
          ),
        replaceAll: async () => undefined,
        preserveCorrupt: async () => undefined,
        readRaw: async () => null,
      },
      { now: () => NOW, decode: (value) => ({ kind: 'ok', state: value as DataStateV3 }), seed: () => library('p4r-app-seed', 1) },
    );
    await persist.load();
    const state = library('p4r-app-focus-save', 50);
    const target = warmTargetOf(state);
    libraryWarmup.start(target, WARM_START_AFTER_READY_MS);
    persist.scheduleSave(state);
    await jest.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(persistWrites.busy()).toBe(true);
    // The learner taps the search box while the save is written.
    expect(libraryWarmup.warmSearchText(target)).toBe(0);
    const lines = (name: string) => perfMarks.entries().filter((entry) => entry.name === name);
    expect(lines('search-warm')).toHaveLength(0);
    gate.open();
    await jest.advanceTimersByTimeAsync(0);
    expect(persistWrites.busy()).toBe(false);
    expect(lines('save')).toHaveLength(1);
    expect(lines('save')[0].inside ?? []).toEqual([]);
    await jest.advanceTimersByTimeAsync(WARM_GAP_MS);
    expect(lines('search-warm')).toHaveLength(1);
    libraryWarmup.stop();
  });

  test('the search text already made (a focus before): 0 ms, but a run planned later still comes a frame from now', () => {
    const target = warmTargetOf(bigLibrary('p4r-focus-again', 600));
    const { warmup, clockReads } = p4Controller();
    warmup.start(target, WARM_START_AFTER_READY_MS);
    expect(warmup.warmSearchText(target)).toBeGreaterThan(0);
    // The run stops (the tab layout's effect cleans up) and starts again with the long wait.
    warmup.stop();
    warmup.start(target, WARM_START_AFTER_READY_MS);
    expect(warmup.warmSearchText(target)).toBe(0);
    const at = clockReads();
    jest.advanceTimersByTime(WARM_GAP_MS);
    expect(clockReads() - at).toBeGreaterThan(WARM_SLICE_MS + 3);
    // Stopped: a focus plans nothing (it only moves a planned slice).
    warmup.stop();
    warmup.warmSearchText(target);
    expect(jest.getTimerCount()).toBe(0);
  });
});
