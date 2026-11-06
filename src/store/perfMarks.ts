/**
 * Development timings (spec §10.6 W3-2, §11 E2): how long the boot, a save, a
 * Library filter and the filter groups (facets) take, so the emulator checks
 * can read real numbers ("time-to-ready < 2 s; save after one rating < 20 ms;
 * Library filter < 30 ms; FacetSheet opens < 80 ms").
 *
 *   import { perfMarks } from '@/store/perfMarks';
 *   const pool = perfMarks.time('filter', () => filterCards(...));
 *   await perfMarks.timeAsync('save', () => port.save(next, prev));
 *   perfMarks.mark('boot', 812, 'loaded');
 *
 * Every timing is printed as ONE log line that a script can find in
 * `adb logcat` (scripts/emulator/measure-perf.sh, W5-4):
 *
 *   [perf] save 12.4 ms
 *   [perf] boot 812.0 ms (loaded)
 *
 * ON IN DEVELOPMENT, OFF IN RELEASE by default: in a release build (`__DEV__`
 * false) `enabled` is false, `time()` just runs the function, and nothing is
 * kept or printed. The build-time flag EXPO_PUBLIC_PERF_MARKS changes that
 * (perfMarksEnabled): '0' switches it off in a development build, and '1'
 * switches it ON in a release build — a debug build is several times slower
 * than a release one, so the budgets must be measured on a release build
 * (walkthrough M9):
 *
 *   EXPO_PUBLIC_PERF_MARKS=1 npx expo run:android --variant release
 *
 * The newest 200 entries are kept in memory (`entries()`), for tests and a
 * future dev screen.
 *
 * BUDGETS (spec §4.3, §11 E2): a line over its budget says so, so a script
 * (or a person) can find the slow ones in logcat:
 *
 *   [perf] facets 877.9 ms (15 groups) — over the 80 ms budget
 *
 * Who times what:
 *   - the engine (engine.ts) times 'boot', 'load', 'save' and 'replaceAll'
 *     itself — wired and tested;
 *   - the Library (W4-2) times 'filter' (its card list: the chips, the sort
 *     and the headline rank) and 'facets' (the filter groups of the
 *     FacetSheet). It wraps its store selectors with `timedSelector`:
 *       const reader = timedSelector('filter', rowsReader(cache, key, sortKey, now));
 *       const rows = useStateV3(reader);
 *     A cache hit (the same list again) is not a timing: only real work is.
 *     So E2's "Library filter < 30 ms; FacetSheet opens < 80 ms" has a
 *     [perf] line to read.
 *   - the Library's cache warm-up marks 'warm' once it is done: "[perf] warm
 *     410.2 ms (16,260 cards)" — the work of all its small slices together,
 *     done between frames (no budget: nobody waits for it). Since unit P2 it
 *     is ONE shared warm-up that starts 1.5 s after the app is ready (after
 *     the 'boot' line), from the tab layout (store/libraryWarmup.ts), the
 *     search text first; after a rating it walks only the changed cards:
 *     "[perf] warm 0.3 ms (2 of 16,260 cards)". One line per complete run;
 *   - the Library marks 'order' when its idle step made or repaired the
 *     library's order for the list's sort: "[perf] order 31.4 ms (16,260
 *     cards)" (unit P1 review 2; no budget either: it runs while the phone is
 *     idle). WHEN IT APPEARS (unit U2, checked against the code): a sort of
 *     the WHOLE library makes and keeps its order inside its own 'filter'
 *     line (scope.ts sortScopeCards), so it prints no 'order' line. An
 *     'order' line comes from the Library's idle step (library.tsx,
 *     runWhenWarmed) after a FILTERED list of any size was sorted while the
 *     library's order for that sort was not ready: the first time for that
 *     sort (a note edit makes a new library index, so it is a first time
 *     again), or after a change of many cards (more than 1/20 of them, or
 *     cards added or removed) or of any deck. One more case prints a short
 *     line: a filtered list SHORTER than 1/8 of the library
 *     (LIBRARY_ORDER_MIN_SHARE) is sorted on its own and never repairs the
 *     kept order, so after a small change (one rating) the idle step
 *     repairs it. The shared warm-up makes the Deck order (the default
 *     sort) itself, inside its 'warm' line (unit P4), so Deck order rarely
 *     prints an 'order' line;
 *   - the Library's search box marks 'search-warm' when its focus had to make
 *     the search text of the notes at once (unit P4: the app became ready a
 *     moment ago, the warm-up had not done it yet): "[perf] search-warm 160.2
 *     ms (16,260 cards)". The search's filter after it reads no note, and
 *     the headlines come next in bigger slices (unit P4 review), so the
 *     first search's headline rank finds them ready.
 *
 * GARBAGE COLLECTION AND OTHER WORK INSIDE A LINE (unit P4 review). Every
 * timing reads the JS engine's collector before and after (Hermes:
 * hermesGcReading). When it collected inside the timing, the line says how
 * often and for how long (the collector's time on the JS thread, as Hermes
 * counts it); an async timing (timeAsync: 'save') also names the other
 * lines recorded while it waited:
 *
 *   [perf] filter 33.5 ms (16,264 cards; 1 GC 28.0 ms) — over the 30 ms budget
 *   [perf] save 43.5 ms (inside it: warm 0.3 ms) — over the 20 ms budget
 *
 * WHY: the release run (emulator, host load 3–43) printed the
 * SAME "no filter" opening of the Library at 4.2–6.2 ms five times and at
 * 32.1–33.9 ms three times, once 135.5 ms. The work is the same each time:
 * node --jitless needs 5.0–5.9 ms for it with the old code, early or after
 * the warm-up, and the code since unit P4 needs 0.05 ms and makes no big
 * array (scope.ts sortScopeRows). A synchronous function only takes longer
 * when the JS thread is paused (a GC) or the system does not run it (other
 * threads, a busy host). The same report shows the second: the warm-up
 * needed 2.4–4.2 s of work while Today was on screen and 0.3–0.7 s on the
 * Library or Settings, for the same work. So a slow line WITHOUT a GC note,
 * for work that node --jitless does in a few ms, is the host or the other
 * threads, not the JS work. (Device check: the three cases — open early,
 * after the warm-up, after Settings and Today — with these notes.)
 *
 * WHAT 'save' MEASURES (unit P4 check): engine.ts timedPort wraps
 * port.save() with timeAsync, so the line is the WALL time from the start
 * of the save to its end. In that time the save waits for the native
 * database several times, and the JS thread may run other timers. Its own
 * JS work is small: for one rating on 16,264 cards, node --jitless needs
 * 0.53 ms for the diff (rowDiff diffState) and 0.04 ms for its 4 SQL
 * statements. The warm-up's slice after a rating was about 0.3 ms in the
 * release build before unit P4 (since P4 it also re-checks the Deck order:
 * one pass over the cards, plus the new card lookup when no selector made
 * it yet — about 1–4 ms in node --jitless), so it did
 * NOT make the 25.5 / 43.5 / 42.0 ms saves of the release run (unit P4
 * review: an earlier note said it did); since unit P4 no slice runs inside a
 * save at all (persistController persistWrites), which keeps the bigger
 * parts — the note lookups and the Deck order after an edit — out of it.
 * The rest of a 'save' line is the native SQLite transaction: the disk and
 * the load of the phone or emulator. A 'save' line over 20 ms with no GC
 * and no line inside it is that.
 *
 * Not for render code: a component must not read the clock while it renders
 * (React Compiler rule). Time an event handler, an effect or a store helper
 * (a selector made by `timedSelector` is a store helper: the store calls it).
 */
import { plural } from '../domain/text';

/**
 * The names the app uses. Any other short name works too. 'warm' (units P1,
 * P2) is the Library's shared cache warm-up: the work of all its idle slices
 * together (store/libraryWarmup.ts, scope.ts warmLibraryCaches); 'order'
 * (unit P1 review 2) is the Library's idle step that makes the library's
 * order for a sort (scope.ts warmLibraryOrder) — no budget for either, they
 * run while the phone is idle.
 */
export type PerfName = 'boot' | 'load' | 'save' | 'replaceAll' | 'filter' | 'facets' | 'warm' | 'order' | (string & {});

/** One timing. */
export interface PerfEntry {
  name: PerfName;
  /** Duration in milliseconds. */
  ms: number;
  /** When it ended, on the perf clock (ms). */
  at: number;
  /** A short note, e.g. the boot result ('loaded') or a card count. */
  detail?: string;
  /**
   * The garbage collections of the JS engine inside this timing (unit P4
   * review): how many, and their time (ms) on the JS thread as the engine
   * counts it. Only when there was at least one, and only where the engine
   * says it (Hermes: hermesGcReading).
   */
  gc?: GcReading;
  /**
   * Other timings that were recorded INSIDE this one (only for timeAsync:
   * an async timing waits, and other JS work can run meanwhile), as
   * "warm 0.3 ms". Only when there was at least one.
   */
  inside?: string[];
}

/** The garbage collector's numbers: collections so far, and their time so far (ms). */
export interface GcReading {
  count: number;
  ms: number;
}

export interface PerfMarks {
  /** False in release builds: then every method does (almost) nothing. */
  readonly enabled: boolean;
  /** The perf clock in ms (`performance.now()` when the runtime has it). */
  clock(): number;
  /** Record a duration that was measured elsewhere. */
  mark(name: PerfName, ms: number, detail?: string): void;
  /** The garbage collector's numbers now (null: timings off, or the engine does not say them). For `record`. */
  gcNow(): GcReading | null;
  /**
   * Record a duration measured elsewhere, with what the collector did since
   * `gcBefore` (a gcNow() reading taken when the measured work began).
   */
  record(name: PerfName, ms: number, detail: string | undefined, gcBefore: GcReading | null): void;
  /** Run `fn` and record how long it took (also when it throws). Returns its value. */
  time<T>(name: PerfName, fn: () => T, detail?: string): T;
  /** The same for an async function: the time until its promise settles. */
  timeAsync<T>(name: PerfName, fn: () => Promise<T>, detail?: string): Promise<T>;
  /** The newest entries, oldest first (a copy). */
  entries(): PerfEntry[];
  /** Forget every entry. */
  clear(): void;
}

export interface PerfMarksOptions {
  enabled: boolean;
  /** Default: `performance.now()`, else Date.now. */
  clock?: () => number;
  /** Where the line goes. Default: none (the app's instance passes console.log). */
  log?: (line: string) => void;
  /** How many entries are kept. Default 200. */
  keep?: number;
  /**
   * The garbage collector's numbers now, or null when the engine does not
   * say them. Default: hermesGcReading. Read before and after each timing:
   * the difference goes into the entry (`gc`).
   */
  gc?: () => GcReading | null;
}

/**
 * The time budgets of spec §11 E2 (ms): "time-to-ready < 2 s; save after one
 * rating < 20 ms; Library filter < 30 ms; FacetSheet opens < 80 ms".
 */
export const PERF_BUDGETS: Readonly<Record<'boot' | 'save' | 'filter' | 'facets', number>> = Object.freeze({
  boot: 2000,
  save: 20,
  filter: 30,
  facets: 80,
});

/** The budget of a name, or undefined (a name without a budget). */
function budgetOf(name: PerfName): number | undefined {
  return Object.prototype.hasOwnProperty.call(PERF_BUDGETS, name)
    ? PERF_BUDGETS[name as keyof typeof PERF_BUDGETS]
    : undefined;
}

/**
 * The log line of one entry: "[perf] save 12.4 ms", "[perf] boot 812.0 ms
 * (loaded)", or — over its budget — "[perf] facets 877.9 ms (15 groups) —
 * over the 80 ms budget".
 */
export function formatPerfLine(entry: Pick<PerfEntry, 'name' | 'ms' | 'detail' | 'gc' | 'inside'>): string {
  const ms = Number.isFinite(entry.ms) ? entry.ms.toFixed(1) : String(entry.ms);
  const budget = budgetOf(entry.name);
  const over = budget !== undefined && entry.ms > budget ? ` — over the ${budget} ms budget` : '';
  // The notes in the brackets: "16,264 cards; 1 GC 28.0 ms; inside it: warm 0.3 ms".
  const notes: string[] = [];
  if (entry.detail) notes.push(entry.detail);
  if (entry.gc) notes.push(`${plural(entry.gc.count, 'GC')} ${entry.gc.ms.toFixed(1)} ms`);
  if (entry.inside && entry.inside.length > 0) notes.push(`inside it: ${entry.inside.join(', ')}`);
  return `[perf] ${entry.name} ${ms} ms${notes.length > 0 ? ` (${notes.join('; ')})` : ''}${over}`;
}

/**
 * The garbage collector's numbers of Hermes (the app's JS engine), or null
 * on another engine (node in jest). HermesInternal.getInstrumentedStats()
 * gives `js_numGCs` (collections so far) and `js_gcTime` (seconds of
 * collection so far; Hermes counts the time a collection held the JS
 * thread — its Hades collector does most old-generation work beside it).
 * Read only while timings are on.
 *
 *   hermesGcReading()   // { count: 41, ms: 312.5 } on the phone, null in node
 */
export function hermesGcReading(): GcReading | null {
  const hermes = (globalThis as { HermesInternal?: { getInstrumentedStats?: () => Record<string, unknown> } })
    .HermesInternal;
  if (!hermes || typeof hermes.getInstrumentedStats !== 'function') return null;
  try {
    const stats = hermes.getInstrumentedStats();
    const count = stats.js_numGCs;
    const seconds = stats.js_gcTime;
    if (typeof count !== 'number' || typeof seconds !== 'number') return null;
    return { count, ms: seconds * 1000 };
  } catch {
    // A dev timing must never break the app.
    return null;
  }
}

/** What the collector did between two readings, or undefined when nothing (or no readings). */
function gcBetween(before: GcReading | null, after: GcReading | null): GcReading | undefined {
  if (!before || !after) return undefined;
  const count = after.count - before.count;
  const ms = after.ms - before.ms;
  return count > 0 || ms > 0 ? { count, ms } : undefined;
}

/** The runtime's high-resolution clock (Hermes and node have `performance.now`), or Date.now. */
function defaultClock(): () => number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf && typeof perf.now === 'function') return () => perf.now!();
  return () => Date.now();
}

export function createPerfMarks(options: PerfMarksOptions): PerfMarks {
  const enabled = options.enabled;
  const clock = options.clock ?? defaultClock();
  const keep = Math.max(1, options.keep ?? 200);
  const log = options.log;
  const gcNow = options.gc ?? hermesGcReading;
  let list: PerfEntry[] = [];
  /** How many entries were ever recorded (the list keeps only the newest): timeAsync finds the ones inside it. */
  let recorded = 0;

  /** Record one entry, with what the collector did since `gcBefore` and the lines `inside` it. */
  const record = (name: PerfName, ms: number, detail?: string, gcBefore?: GcReading | null, inside?: string[]): void => {
    const gc = gcBefore === undefined ? undefined : gcBetween(gcBefore, gcNow());
    const entry: PerfEntry = {
      name,
      ms,
      at: clock(),
      ...(detail ? { detail } : {}),
      ...(gc ? { gc } : {}),
      ...(inside && inside.length > 0 ? { inside } : {}),
    };
    list.push(entry);
    recorded += 1;
    if (list.length > keep) list = list.slice(list.length - keep);
    log?.(formatPerfLine(entry));
  };

  return {
    enabled,
    clock,
    mark(name, ms, detail) {
      if (enabled) record(name, ms, detail);
    },
    gcNow: () => (enabled ? gcNow() : null),
    record(name, ms, detail, gcBefore) {
      if (enabled) record(name, ms, detail, gcBefore);
    },
    time(name, fn, detail) {
      if (!enabled) return fn();
      const gcBefore = gcNow();
      const start = clock();
      try {
        return fn();
      } finally {
        record(name, clock() - start, detail, gcBefore);
      }
    },
    async timeAsync(name, fn, detail) {
      if (!enabled) return fn();
      const gcBefore = gcNow();
      const firstInside = recorded;
      const start = clock();
      try {
        return await fn();
      } finally {
        const ms = clock() - start;
        // The other lines recorded while this one waited (the ones still in the kept list).
        const count = Math.min(recorded - firstInside, list.length);
        const inside = list.slice(list.length - count).map((e) => `${e.name} ${e.ms.toFixed(1)} ms`);
        record(name, ms, detail, gcBefore, inside);
      }
    },
    entries: () => [...list],
    clear: () => {
      list = [];
    },
  };
}

/**
 * Are the timings on? `flag` is EXPO_PUBLIC_PERF_MARKS (inlined at build
 * time): '1' → on in ANY build (a release build measures the real budgets);
 * '0' → off; anything else → on only in a development build.
 *
 *   perfMarksEnabled(true, undefined)   // true   (a debug build)
 *   perfMarksEnabled(false, undefined)  // false  (a release build)
 *   perfMarksEnabled(false, '1')        // true   (a release build made to measure)
 */
export function perfMarksEnabled(dev: boolean, flag: string | undefined): boolean {
  if (flag === '1') return true;
  if (flag === '0') return false;
  return dev;
}

/** On in development builds, unless EXPO_PUBLIC_PERF_MARKS is '0'; on in release with '1'. */
export const PERF_MARKS_ON: boolean = perfMarksEnabled(
  typeof __DEV__ !== 'undefined' && __DEV__,
  process.env.EXPO_PUBLIC_PERF_MARKS,
);

/**
 * The app's one instance. Under jest the lines are not printed (they would
 * fill the test output); the entries are still kept.
 */
export const perfMarks: PerfMarks = createPerfMarks({
  enabled: PERF_MARKS_ON,
  log: process.env.NODE_ENV === 'test' ? undefined : (line) => console.log(line),
});

/**
 * A store selector that is timed each time it really COMPUTES (spec §11 E2,
 * unit W4-2). The selectors of src/store/selectors.ts keep their last result
 * while their inputs stay the same ("memoized"): a call then returns the SAME
 * object at once. So a call that returns the same object as the call before
 * was a cache hit, and it is NOT recorded. A call that returns a new object
 * did the real work: its time is recorded under `name`.
 *
 *   const reader = timedSelector('facets', facetsReader(selKey, scopeKey, now));
 *   const facets = useStateV3(reader);    // "[perf] facets 41.2 ms (12 groups)"
 *
 * `detail` turns the new value into the short note of the line (a count).
 * With `marks.enabled` false (a release build) the selector is returned as
 * it is: no clock, no cost.
 */
export function timedSelector<S, T>(
  name: PerfName,
  selector: (state: S) => T,
  detail?: (value: T) => string,
  marks: PerfMarks = perfMarks,
): (state: S) => T {
  if (!marks.enabled) return selector;
  let last: { value: T } | null = null;
  return (state) => {
    // The collector's numbers first (unit P4 review): a GC pause inside the
    // selector shows in its line ("1 GC 28.0 ms").
    const gcBefore = marks.gcNow();
    const start = marks.clock();
    const value = selector(state);
    if ((last === null || last.value !== value) && !timedBefore(marks, value)) {
      marks.record(name, marks.clock() - start, detail?.(value), gcBefore);
    }
    last = { value };
    return value;
  };
}

/** Per PerfMarks: every object a timed selector already recorded. */
const recordedValues = new WeakMap<PerfMarks, WeakSet<object>>();

/**
 * True when `value` is an object a timed selector recorded before — a hit
 * of a cache that is SHARED by several selectors (the Library's rows cache,
 * libraryState rowsReader: going back to an earlier search makes a new
 * selector, but it returns the cached list at once). Such a hit is no real
 * work, so it is not recorded. The first time an object is seen, it is
 * remembered and this returns false.
 */
function timedBefore(marks: PerfMarks, value: unknown): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  let seen = recordedValues.get(marks);
  if (!seen) recordedValues.set(marks, (seen = new WeakSet()));
  if (seen.has(value)) return true;
  seen.add(value);
  return false;
}
