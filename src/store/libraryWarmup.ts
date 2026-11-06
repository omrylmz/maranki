/**
 * The Library's cache warm-up, started EARLY and SHARED (unit P2).
 *
 * WHAT it does: scope.ts warmLibraryCaches fills the per-note caches the
 * Library reads (the search text first, then the headlines, the facet data
 * and the labels), in small slices while the phone is idle. Then the first
 * search, the first A–Z and the first FacetSheet opening find their values
 * ready instead of making them while the learner waits.
 *
 * WHY here and not in the Library screen: the Library is a LAZY tab. Its
 * warm-up started only 400 ms after the learner opened it, and on Hermes the
 * whole warm-up takes about 1.5–4.5 s of slices. A fast learner typed
 * before the search text was ready: the release device needed 234 ms for
 * the first search 'zeit' (budget 30 ms). Now ONE warm-up runs from the tab
 * layout ((tabs)/_layout.tsx, useLibraryWarmup), so the caches are usually
 * warm before the learner reaches the Library.
 *
 * The rules:
 *   - It starts only AFTER the app is ready (the engine's `ready`, the
 *     moment of the boot perf mark), and then waits WARM_START_AFTER_READY_MS
 *     more, so Today's first frames come first. The time-to-ready (budget
 *     < 2 s) does not change: nothing runs before it.
 *   - Slices: each one works at most about WARM_SLICE_MS, and the next one
 *     starts WARM_GAP_MS later (a frame in between), so taps and typing are
 *     never held up for long.
 *   - New data (a rating, an edit, an import, an undo) starts it again after
 *     WARM_RESTART_MS, for the new cards and index. Only the NEW notes are
 *     real work then: every other value is already in its cache. After a
 *     rating (the same library, a few new card objects) it walks only the
 *     changed cards (cardsToWarm), not 4 passes over 16,000 cards — this
 *     warm-up now runs on every screen, also during a study session.
 *   - Only ONE warm-up at a time: a new start stops the run of the old data.
 *   - The tab layout unmounting stops it (no timer is left).
 *   - Each COMPLETE warm-up prints one dev timing line, the work of all its
 *     slices together: "[perf] warm 410.2 ms (16,260 cards)" (perfMarks.ts).
 *   - The Library screen does no warm-up of its own. Its idle order step
 *     (library.tsx) waits until `libraryWarmup.isWarmed(…)` says the caches
 *     of ITS data are done.
 *
 * Unit P3 (the wave-5g review):
 *   - The order step waits WITHOUT POLLING (runWhenWarmed). Before, it
 *     looked again every 100 ms until the warm-up was done — and it never
 *     stopped while the Library tab was frozen in the background (a little
 *     work forever). Now it waits for `onWarmed`, a listener that is called
 *     once when a run completes; no timer is alive while it waits.
 *   - The Library opened EARLY asks for the warm-up soon (startSoon,
 *     useLibraryWarmupSoon). The shared warm-up begins 1.5 s after ready;
 *     the Library's own warm-up of unit P1 began 400 ms after the screen
 *     opened. So a learner who opened the Library in the first second got
 *     the warm caches LATER than before. Now the run begins at most
 *     WARM_SOON_MS after the Library opened. It is still one warm-up (the
 *     one planned slice comes sooner), and still nothing before ready.
 *
 * Unit P4 (the release re-measure on 16,260 cards):
 *   - After the per-note caches, a run also makes the NOTE LOOKUPS of the
 *     filter groups (scope.ts warmNoteSets: which notes have Level B1, which
 *     are in "Vocabulary", of which card type) and the library's DECK ORDER
 *     (scope.ts warmDeckOrder; the Library's default sort). So the first
 *     Level chip, and the first Library opening, find them ready. Both in
 *     slices too (the order since the P4 review), and a slice that already
 *     worked longer than WARM_SLICE_MS leaves the next part to the next slice.
 *   - The search box got the FOCUS (warmSearchText): the rest of the
 *     search-text pass is done at once. The release device needed 188.5 ms
 *     for a first search typed 1.5 s after the app was ready (the run had
 *     not begun). The keyboard opens natively in that time, and a key typed
 *     meanwhile only waits: the search after it reads no note. One dev line:
 *     "[perf] search-warm 160.2 ms (16,260 cards)".
 *   - No slice runs while a SAVE is being written (persistController
 *     persistWrites): it waits, with no timer, until the write is done. The
 *     save's timing (perfMarks 'save') is the time from its start to its
 *     end, so a slice in between is counted as save time. What is saved,
 *     and when, does not change. (Unit P4 review: the slice after a rating
 *     was about 0.3 ms before P4 — since P4 it also re-checks the Deck
 *     order, about 1–4 ms in node --jitless — so it did NOT make the 25–43 ms saves of the
 *     release run; the wait keeps the bigger parts — the note lookups and
 *     the Deck order after an edit — out of a save. See perfMarks.ts
 *     "WHAT 'save' MEASURES".)
 *
 * Unit P4 review:
 *   - The Deck order is made a PART AT A TIME too (scope.ts warmDeckOrder):
 *     a library that is not stored in Deck order (a card added to an older
 *     deck after a newer one was imported, "Move to deck…") needs a real
 *     sort of 16,000 cards — one 26.7 ms step in node --jitless before.
 *   - After the focus of the search box, the headlines come next, at once:
 *     the planned slice runs a frame later, and up to the end of the
 *     headlines a slice works up to WARM_FOCUS_SLICE_MS (16 ms). The first
 *     search ranks its rows by their headlines, so it then reads no note —
 *     a first search "e" (most of the 16,264 cards of the device's data)
 *     takes 141 ms in node --jitless with the search text alone, 20 ms
 *     with the headlines warm too.
 *
 * P4 review 2: the focus waits for a save too. Its pass (100–300 ms on the
 * phone) ran at once even while a save was being written, so the save's
 * line counted it: "[perf] save 190 ms (inside it: search-warm 160.2 ms)".
 * Now, while a write runs, warmSearchText returns 0 and waits (no timer)
 * until the write is done, then runs a frame later. The first search still
 * finds the search text ready: a save takes about 6–40 ms, the keyboard
 * about 250 ms to open, and the search waits 150 ms after the last key.
 *
 *   // (tabs)/_layout.tsx — once:
 *   useLibraryWarmup();
 *   // library.tsx — when it opens:
 *   useLibraryWarmupSoon();
 *   // library.tsx — the idle order step, once the caches of ITS data are warm:
 *   useEffect(() => runWhenWarmed(libraryWarmup, { cards, index, decks }, 400, makeOrder), [cards, index, decks]);
 *   // library.tsx — the search box got the focus:
 *   onFocus={() => libraryWarmup.warmSearchText(warmTargetOf(engine.store.getState()))}
 */
import { useEffect, useRef } from 'react';

import type { LibraryIndex } from '../domain/libraryIndex';
import type { Card, DataStateV3, Deck, Id, SortSpec } from '../domain/model';
import {
  decksById,
  libraryIndexOf,
  libraryOrderReady,
  noteSetsReady,
  warmDoneAt,
  warmDeckOrder,
  warmLibraryCaches,
  warmLibrarySteps,
  warmNoteSets,
} from '../domain/scope';
import { plural } from '../domain/text';
import { perfMarks } from './perfMarks';
import { persistWrites } from './persistController';
import { memoOnInputs, useEngineMeta, useStateV3 } from './selectors';

/** The first warm-up starts this long after the app is ready (Today's first frames come first). */
export const WARM_START_AFTER_READY_MS = 1500;
/** After new data, the warm-up starts again this much later (as the Library's own warm-up did). */
export const WARM_RESTART_MS = 400;
/**
 * Once the Library is open, a run waits at most this long (unit P3): the
 * delay of the Library's own warm-up of unit P1 (400 ms after it opened).
 */
export const WARM_SOON_MS = 400;
/** One slice works at most about this long … */
export const WARM_SLICE_MS = 8;
/** … and the next one starts this much later (a frame in between). */
export const WARM_GAP_MS = 16;
/**
 * After the search box got the FOCUS (warmSearchText, unit P4 review): the
 * next slice comes WARM_GAP_MS later, and until the headlines are done a
 * slice works up to this long — one frame of work, one frame free. The
 * first search ranks its rows by their headlines (libraryState rankRows),
 * so they should be ready when it runs: at least 150 ms (the search
 * debounce) after the first key, and the keyboard opens first.
 */
export const WARM_FOCUS_SLICE_MS = 16;
/**
 * The sort whose library order a run makes at its end (unit P4): "Deck
 * order", the Library's default sort (libraryState DEFAULT_SORT;
 * libraryWarmup.test.ts checks that the two are the same). The Library's
 * own idle order step makes the order of any other sort it shows.
 */
export const WARM_ORDER_SORT: SortSpec = Object.freeze({ by: 'source' }) as SortSpec;

/**
 * Whether the app is writing to its storage now (persistController
 * persistWrites, unit P4). A slice waits while it is: see the file comment.
 */
export interface WriteActivity {
  /** True while a save (or a restore) is being written. */
  busy(): boolean;
  /** Call `listener` once, when no write runs any more. Returns the function that removes it. */
  onIdle(listener: () => void): () => void;
}

/** The data one warm-up is for. The same arrays always give the same index and decks Map (scope.ts caches). */
export interface WarmTarget {
  cards: readonly Card[];
  index: LibraryIndex;
  decks: ReadonlyMap<Id, Deck>;
}

/** What the warm-up uses from the outside world (the app's timers and perf clock; fakes in tests). */
export interface LibraryWarmupOptions {
  /** The clock in ms (the slices measure their time with it). */
  clock: () => number;
  /**
   * The wall clock in ms for PLANNING: when the planned slice is due
   * (startSoon compares it). Default: the current Date.now, read at each
   * call (so jest's fake timers move it, also for the app's one controller).
   * It is not `clock`: that one measures the work of the slices.
   */
  now?: () => number;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /**
   * Called once per COMPLETE warm-up: the work of all its slices (ms), how
   * many cards it walked, and how many cards the library has.
   */
  done?: (ms: number, walked: number, total: number) => void;
  /** Default WARM_SLICE_MS. */
  sliceMs?: number;
  /** Default WARM_GAP_MS. */
  gapMs?: number;
  /** Default WARM_FOCUS_SLICE_MS (the slices after warmSearchText, until the headlines are done). */
  focusSliceMs?: number;
  /** The app's writes (unit P4): no slice runs while one is written. None: slices never wait. */
  writes?: WriteActivity;
  /** Called after warmSearchText did work: how long it took (ms), how many cards it walked, and how many the library has. */
  searchWarmed?: (ms: number, walked: number, total: number) => void;
}

export interface LibraryWarmup {
  /** The clock the warm-up uses (the hook reads the time of "ready" with it). */
  clock(): number;
  /**
   * Warm the caches of `target`; the next slice runs after `delayMs` (at
   * most the wait of startSoon, once the Library asked).
   *   - New data (another target): the run of the old data stops, and this
   *     one starts from its first step (one warm-up at a time).
   *   - The same target, still waiting for a slice: it goes on as planned.
   *   - The same target, stopped half-way: it goes on from where it stopped.
   *   - The same target, already warmed: nothing to do.
   */
  start(target: WarmTarget, delayMs: number): void;
  /**
   * Stop: no slice runs until the next start(), and a focus that waits for
   * a save (warmSearchText) does not run either. What is warmed stays warmed.
   */
  stop(): void;
  /**
   * The Library is open (unit P3): from now on a run waits at most
   * `delayMs` before its next slice, like the Library's own warm-up of
   * unit P1, which began 400 ms after the screen opened.
   *   - A slice planned LATER comes sooner: at most `delayMs` from now,
   *     never later than it was planned.
   *   - No start() yet (the app is not ready): nothing starts now. The
   *     first start() then waits at most `delayMs`.
   *   - Still ONE warm-up: it moves the one planned slice, it never adds one.
   * Returns the function that ends the request (the Library closed): later
   * runs wait their own time again. A slice already planned stays planned.
   */
  startSoon(delayMs: number): () => void;
  /**
   * Call `listener` ONCE, when the next run COMPLETES — a run of any data,
   * so the listener asks isWarmed() about its own. Returns the function
   * that removes it (when it was not called yet). Waiting costs nothing:
   * no timer, no check, until a run completes.
   *
   *   const off = warmup.onWarmed(() => lookAgain());
   *   off();   // not needed any more (the screen closed)
   */
  onWarmed(listener: () => void): () => void;
  /** True when a complete warm-up was done for exactly these cards, index and decks. */
  isWarmed(target: WarmTarget): boolean;
  /** True while a run waits for its next slice (also while that slice waits for a save to be written). */
  isRunning(): boolean;
  /**
   * The Library's search box got the focus (unit P4): make the search text
   * of every note of `target` NOW, if it is not ready yet — the rest of the
   * search-text pass, in one go. A run of `target` then goes on from there
   * (its next slice does the next part); for other data (a run that has not
   * begun for it) the values simply land in their caches, and the run finds
   * them ready. Returns the time it took (ms on the warm-up's clock), 0 when
   * there was nothing to do now.
   *
   * Unit P4 review: when the run of `target` has not made the HEADLINES
   * yet, its planned slice comes a frame (WARM_GAP_MS) from now — never
   * later than it was planned, and a slice that waits for a save keeps
   * waiting — and its slices up to the end of the headlines work up to
   * WARM_FOCUS_SLICE_MS. So the first search's headline rank finds them
   * ready (it comes at least 150 ms after the first key).
   *
   * P4 review 2: while a SAVE is being written (`writes.busy()`), the pass
   * does not run now — the save's line would count it ("[perf] save 190 ms
   * (inside it: search-warm 160.2 ms)"). This returns 0, and the focus waits
   * (no timer) until the write is done; a frame (WARM_GAP_MS) later it runs
   * as if the focus came then. A save takes about 6–40 ms and the keyboard
   * about 250 ms to open, so the first search still finds the search text
   * ready. stop(), a newer focus and new data (start() of another target)
   * remove the wait.
   *
   *   <TextInput onFocus={() => warmup.warmSearchText(warmTargetOf(store.getState()))} … />
   */
  warmSearchText(target: WarmTarget): number;
}

/** The same data: the same three objects (the store never changes one in place). */
function sameTarget(a: WarmTarget | null, b: WarmTarget): boolean {
  return a !== null && a.cards === b.cards && a.index === b.index && a.decks === b.decks;
}

/**
 * The cards a run must walk. After a rating, a flag or an undo the library
 * is the SAME (the same index and decks, as many cards) and only a few card
 * objects are new: every other card was walked by the last complete run,
 * and its values are still in their caches (they are kept per note). So
 * only the new card objects are walked — one quick pass of `===`, not four
 * passes over 16,000 cards after every rating. Any other change (new notes,
 * card types or decks, cards added or removed): every card.
 */
export function cardsToWarm(last: WarmTarget | null, next: WarmTarget): readonly Card[] {
  if (last === null || last.index !== next.index || last.decks !== next.decks || last.cards.length !== next.cards.length) {
    return next.cards;
  }
  const out: Card[] = [];
  for (let i = 0; i < next.cards.length; i++) if (next.cards[i] !== last.cards[i]) out.push(next.cards[i]);
  return out;
}

/**
 * A warm-up controller. The app has one (`libraryWarmup` below); tests make
 * their own with fake timers and a fake clock.
 */
export function createLibraryWarmup(options: LibraryWarmupOptions): LibraryWarmup {
  const { clock, setTimer, clearTimer, done } = options;
  // A function that reads Date.now at each call, not Date.now itself: the
  // app's controller is made at import time, before jest's fake timers.
  const now = options.now ?? (() => Date.now());
  const sliceMs = options.sliceMs ?? WARM_SLICE_MS;
  const gapMs = options.gapMs ?? WARM_GAP_MS;
  const focusSliceMs = options.focusSliceMs ?? WARM_FOCUS_SLICE_MS;
  const { writes, searchWarmed } = options;
  /** The data of the current (or last) run. */
  let target: WarmTarget | null = null;
  /** The cards the current run walks (cardsToWarm), chosen in its first slice. */
  let list: readonly Card[] | null = null;
  /** The data of the last COMPLETE run. */
  let warmed: WarmTarget | null = null;
  /** The step to go on from (warmLibraryCaches), and the work of the slices so far (ms). */
  let at = 0;
  let busy = 0;
  /**
   * Unit P4 review: after warmSearchText, the slices work up to focusSliceMs
   * until `at` reaches this step (the end of the headlines). 0: no focus.
   */
  let focusUntil = 0;
  let timer: unknown = null;
  /** While the planned slice waits for a save to be written (unit P4): removes that wait. */
  let offWrites: (() => void) | null = null;
  /**
   * While a FOCUS waits for a save to be written (warmSearchText, P4 review
   * 2): removes that wait (or its timer a frame after the write), and the
   * data the focus was for.
   */
  let offSearchWait: (() => void) | null = null;
  let searchWaitFor: WarmTarget | null = null;
  /** When the planned slice is due (on `now`). */
  let dueAt = 0;
  /** The longest wait before a slice while the Library asks (startSoon); Infinity: no limit. */
  let soonMs = Number.POSITIVE_INFINITY;
  /** The open startSoon requests (one per open Library); soonMs is the shortest of them. */
  const soonRequests = new Set<{ ms: number }>();
  /** The onWarmed listeners that wait for the next complete run. */
  const listeners = new Set<() => void>();

  const clear = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    offWrites?.();
    offWrites = null;
  };

  /** True while a slice is planned: a timer, or a wait for a save to be written. */
  const planned = () => timer !== null || offWrites !== null;

  /** Remove the focus that waits for a save (if any): nothing of it runs later. */
  const clearSearchWait = () => {
    offSearchWait?.();
    offSearchWait = null;
    searchWaitFor = null;
  };

  /**
   * A focus came while a save is being written (P4 review 2): its pass waits.
   * When no write runs any more, warmSearchText(next) runs a frame
   * (WARM_GAP_MS) later — like a waiting slice — and looks at everything
   * again (a new save: it waits again; the data warmed meanwhile: nothing to
   * do). The save's timing ('save') ends before that, so the pass is never
   * counted in it.
   */
  const waitForWrite = (activity: WriteActivity, next: WarmTarget) => {
    searchWaitFor = next;
    let handle: unknown = null;
    let offIdle: (() => void) | null = activity.onIdle(() => {
      offIdle = null;
      handle = setTimer(() => {
        handle = null;
        offSearchWait = null;
        searchWaitFor = null;
        warmSearchText(next);
      }, gapMs);
    });
    offSearchWait = () => {
      offIdle?.();
      offIdle = null;
      if (handle !== null) clearTimer(handle);
      handle = null;
    };
  };

  /** Plan the next slice `delayMs` from now: the warm-up's ONE timer. */
  const plan = (delayMs: number) => {
    const wait = Math.max(0, delayMs);
    dueAt = now() + wait;
    timer = setTimer(slice, wait);
  };

  /**
   * One slice: some steps, then the next slice later — or the end. The
   * parts, in this order: the per-note caches (warmLibraryCaches), the note
   * lookups of the filter groups (warmNoteSets), the library's Deck order
   * (warmDeckOrder, a part at a time). A slice that already did work asks
   * "over the budget?" before the next part, so no slice runs long.
   */
  const slice = () => {
    timer = null;
    const run = target;
    if (run === null) return;
    // A save is being written: wait until it is done (no timer, no polling), then a frame later.
    if (writes?.busy()) {
      offWrites = writes.onIdle(() => {
        offWrites = null;
        plan(gapMs);
      });
      return;
    }
    // After a focus of the search box, up to the end of the headlines: a bigger slice (and only up to there).
    const focus = at < focusUntil;
    const budget = focus ? focusSliceMs : sliceMs;
    const start = clock();
    const over = () => clock() - start > budget;
    /** This slice stops here; the next one goes on a frame later. */
    const later = () => {
      busy += clock() - start;
      plan(gapMs);
    };
    if (list === null) list = cardsToWarm(warmed, run);
    let worked = false;
    if (at < warmLibrarySteps(list)) {
      at = warmLibraryCaches(list, run, at, over, focus ? focusUntil : Number.POSITIVE_INFINITY);
      if (at < warmLibrarySteps(list)) return later();
      worked = true;
    }
    if (!noteSetsReady(run.index)) {
      if (worked && over()) return later();
      if (!warmNoteSets(run.index, over)) return later();
      worked = true;
    }
    if (!libraryOrderReady(run, WARM_ORDER_SORT)) {
      if (worked && over()) return later();
      // A part at a time too (unit P4 review): a library NOT stored in Deck order needs a real sort.
      if (!warmDeckOrder(run, over)) return later();
    }
    busy += clock() - start;
    warmed = run;
    done?.(busy, list.length, run.cards.length);
    // Each waiting listener once. One that an earlier listener removed is
    // skipped; one added just now is not in this copy (it waits for the next run).
    for (const listener of [...listeners]) {
      if (listeners.delete(listener)) listener();
    }
  };

  /** The search box got the focus: see LibraryWarmup.warmSearchText. */
  const warmSearchText = (next: WarmTarget): number => {
    // A newer focus replaces one that waits for a save.
    clearSearchWait();
    // A complete run of these data: every note's search text is in its cache.
    if (sameTarget(warmed, next)) return 0;
    if (sameTarget(target, next)) {
      // The run of these data: the rest of its first part, from where it is.
      // Its next slice goes on with the next part.
      const cards = list ?? cardsToWarm(warmed, next);
      list = cards;
      const end = warmDoneAt(cards, 'searchText');
      // P4 review 2: never inside a save (its 'save' line would count this pass).
      if (at < end && writes?.busy()) {
        waitForWrite(writes, next);
        return 0;
      }
      let ms = 0;
      if (at < end) {
        const start = clock();
        const from = at;
        at = warmLibraryCaches(cards, next, at, () => false, end);
        ms = clock() - start;
        busy += ms;
        // One step per card in this part: the cards walked now.
        searchWarmed?.(ms, at - from, next.cards.length);
      }
      // Unit P4 review: the headlines next — the first search ranks its rows
      // by them. The planned slice comes a frame from now (never later than
      // planned; a slice that waits for a save keeps waiting), and the
      // slices up to the end of the headlines work up to focusSliceMs.
      const headlines = warmDoneAt(cards, 'headlines');
      if (at < headlines) {
        focusUntil = headlines;
        if (timer !== null && dueAt - now() > gapMs) {
          clear();
          plan(gapMs);
        }
      }
      return ms;
    }
    // Other data (no run has begun for them yet): their search texts go into
    // the caches now (kept per note), and that run will find them ready.
    // P4 review 2: after the save that is being written, if there is one.
    if (writes?.busy()) {
      waitForWrite(writes, next);
      return 0;
    }
    const cards = cardsToWarm(warmed, next);
    const start = clock();
    warmLibraryCaches(cards, next, 0, () => false, warmDoneAt(cards, 'searchText'));
    const ms = clock() - start;
    searchWarmed?.(ms, cards.length, next.cards.length);
    return ms;
  };

  return {
    clock,
    start(next, delayMs) {
      // A focus that waits for a save, for OTHER data: no use any more (P4 review 2).
      if (searchWaitFor !== null && !sameTarget(searchWaitFor, next)) clearSearchWait();
      if (sameTarget(warmed, next)) {
        // Nothing to warm. A run of older data (still waiting) is no use any more.
        clear();
        target = next;
        return;
      }
      if (sameTarget(target, next)) {
        // The same data: going on as planned (also a slice that waits for a save), or from where it stopped.
        if (!planned()) plan(Math.min(delayMs, soonMs));
        return;
      }
      clear();
      target = next;
      list = null;
      at = 0;
      busy = 0;
      focusUntil = 0;
      plan(Math.min(delayMs, soonMs));
    },
    stop() {
      clear();
      // P4 review 2: a focus that waits for a save does not run either.
      clearSearchWait();
    },
    startSoon(delayMs) {
      const request = { ms: Math.max(0, delayMs) };
      soonRequests.add(request);
      soonMs = Math.min(soonMs, request.ms);
      // A slice planned later comes sooner (still the one timer: never a second run).
      if (timer !== null && dueAt - now() > soonMs) {
        clear();
        plan(soonMs);
      }
      return () => {
        // The Library closed (wave 5h review): its request must not make the
        // runs of a later app start (after Erase everything, a data problem)
        // begin early. The slice already planned stays as it is.
        if (!soonRequests.delete(request)) return;
        soonMs = Math.min(Number.POSITIVE_INFINITY, ...[...soonRequests].map((r) => r.ms));
      };
    },
    onWarmed(listener) {
      // A wrapper of its own, so two subscriptions of one function are two.
      const once = () => listener();
      listeners.add(once);
      return () => {
        listeners.delete(once);
      };
    },
    isWarmed: (data) => sameTarget(warmed, data),
    isRunning: planned,
    warmSearchText,
  };
}

/** "16,260 cards", or "2 of 16,260 cards" when only some were walked. */
function walkedText(walked: number, total: number): string {
  return walked === total ? plural(total, 'card') : `${walked.toLocaleString('en-US')} of ${plural(total, 'card')}`;
}

/**
 * The app's one warm-up: the app's timers, the perf clock, and one
 * '[perf] warm' line per complete run — "[perf] warm 410.2 ms (16,260
 * cards)" after the first one, "[perf] warm 0.3 ms (2 of 16,260 cards)"
 * after a rating. Its slices wait while a save is written (unit P4), and a
 * focus on the Library's search box prints "[perf] search-warm 160.2 ms
 * (16,260 cards)" when it had to make the search text.
 */
export const libraryWarmup: LibraryWarmup = createLibraryWarmup({
  clock: () => perfMarks.clock(),
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  done: (ms, walked, total) => perfMarks.mark('warm', ms, walkedText(walked, total)),
  writes: persistWrites,
  searchWarmed: (ms, walked, total) => perfMarks.mark('search-warm', ms, walkedText(walked, total)),
});

/** A stand-in for a missing cards array in damaged data. */
const NO_CARDS: readonly Card[] = Object.freeze([]);

/**
 * The warm-up's data of a state, as ONE object per (cards, notes, card
 * types, decks) arrays: a change of anything else (the settings, a list, a
 * session's payout) is not new data for the warm-up, so it does not start
 * it again. Module level, so the store hook keeps the same selector.
 */
export const warmTargetOf: (state: DataStateV3) => WarmTarget = memoOnInputs(
  (s: DataStateV3) => [s.cards, s.notes, s.noteTypes, s.decks],
  (s) => ({ cards: s.cards ?? NO_CARDS, index: libraryIndexOf(s), decks: decksById(s.decks) }),
);

/**
 * Run the Library's warm-up for the store's data. Used ONCE, in the tab
 * layout ((tabs)/_layout.tsx), which stays mounted while the tabs change.
 *
 * Nothing runs before the engine is ready. The first start waits
 * WARM_START_AFTER_READY_MS after the moment the app became ready, also when
 * the data changes in that time; a later change starts it again after
 * WARM_RESTART_MS. Unmounting stops it. (An open Library makes every wait
 * at most WARM_SOON_MS: useLibraryWarmupSoon.)
 */
export function useLibraryWarmup(warmup: LibraryWarmup = libraryWarmup): void {
  const { ready } = useEngineMeta();
  const target = useStateV3(warmTargetOf);
  // When the app became ready, on the warm-up's clock (read in the effect, never in render).
  const readyAt = useRef<number | null>(null);
  useEffect(() => {
    if (!ready) return;
    const now = warmup.clock();
    if (readyAt.current === null) readyAt.current = now;
    warmup.start(target, Math.max(WARM_RESTART_MS, readyAt.current + WARM_START_AFTER_READY_MS - now));
    return () => warmup.stop();
  }, [ready, target, warmup]);
}

/**
 * The Library screen opened (unit P3): ask the shared warm-up to begin soon
 * (startSoon(WARM_SOON_MS)). The shared warm-up begins 1.5 s after the app
 * is ready, but the Library's own warm-up of unit P1 began 400 ms after the
 * screen opened — so without this, a learner who opens the Library in the
 * first second gets the warm caches LATER than before. It never starts a
 * second warm-up, and nothing starts before the app is ready.
 *
 *   // library.tsx
 *   useLibraryWarmupSoon();
 */
export function useLibraryWarmupSoon(warmup: LibraryWarmup = libraryWarmup): void {
  // The cleanup ends the request when the Library unmounts.
  useEffect(() => warmup.startSoon(WARM_SOON_MS), [warmup]);
}

/**
 * Run `step` ONCE, as soon as `warmup` has warmed `target` — with NO
 * polling (unit P3). The Library's idle order step uses it:
 *   1. wait `delayMs` (the screen's first frames come first);
 *   2. warmed: run `step`. Not yet: wait for the next COMPLETE run
 *      (warmup.onWarmed), with no timer at all, then look again
 *      WARM_GAP_MS later (a frame in between: the last slice and the step
 *      do not block one long moment; a run of OTHER data can complete
 *      first, then it waits again).
 * It returns `cancel`, which removes the timer or the listener. After
 * `step` ran, nothing is left either. So a Library tab frozen in the
 * background (freezeOnBlur) costs nothing while it waits.
 *
 *   useEffect(() => runWhenWarmed(libraryWarmup, { cards, index, decks }, 400, makeOrder), [cards, index, decks]);
 */
export function runWhenWarmed(warmup: LibraryWarmup, target: WarmTarget, delayMs: number, step: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let off: (() => void) | null = null;
  const look = () => {
    timer = null;
    if (warmup.isWarmed(target)) {
      step();
      return;
    }
    off = warmup.onWarmed(() => {
      off = null;
      timer = setTimeout(look, WARM_GAP_MS);
    });
  };
  timer = setTimeout(look, delayMs);
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    off?.();
    off = null;
  };
}
