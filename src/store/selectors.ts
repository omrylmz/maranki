/**
 * React hooks that READ the engine's stores (spec §3.9, units W2-1 and W3-4).
 *
 *   const cards = useStoreSelector((s) => s.cards);
 *   const { ready, persistError } = useEngineMeta();
 *   const ready = useReady({ decks: [deckId] });     // "Study {ready.total}"
 *   const rows = useDeckStatsMap();                  // every deck row, one pass
 *   const index = useLibraryIndex();                 // notes and card types by id, search text …
 *   const facets = useFacets(chips, scope, sheetOpen);
 *
 * WHY a selector: `useData()` gives the whole state, so every change re-renders
 * every screen that uses it. `useStoreSelector(sel)` re-renders a component
 * only when the value it selects changes (compared with `Object.is`). It uses
 * React's `useSyncExternalStore`, the official way to read a store that lives
 * outside React.
 *
 * The rule for a selector: for the SAME state it must return the SAME value
 * (an object or array it builds is cached per state object here, so building
 * a new array is fine; it is built again only when the state changes).
 *
 * The derived hooks (useReady, useDeckStatsMap, useFacets, useScopePool,
 * useSortedScopePool, useSessionLength) go through src/domain/scope.ts, the
 * ONE place that turns a scope (a Query) into cards, counts, orders and
 * queues. So the number a hook gives for a scope is always the length of
 * the session that scope opens. They
 * also keep their last result while the parts of the state they read have
 * not changed (a new `person` after a completed session does not recount
 * facets), and `useReady` keeps the same object while the numbers are equal,
 * so a screen does not re-render for nothing.
 *
 * Time: a derived hook reads the clock with useNow() (React Compiler forbids
 * Date.now() in render). It ticks once a minute, which is enough for "due".
 */
import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';

import { deriveFacets, type Facet } from '../domain/facets';
import { achievementStatuses } from '../domain/gamification';
import type { LibraryIndex } from '../domain/libraryIndex';
import { isMastered } from '../domain/life';
import type { Card, DataStateV3, Id, Query, ReadyCounts, SortSpec } from '../domain/model';
import { type MatchCtx, parseQueryParam, serializeQuery } from '../domain/query';
import {
  buildSessionQueue,
  deckStatsMap,
  type DeckSummary,
  libraryIndexOf,
  matchCtxOf,
  readyFor,
  scopePool,
  type ScopePurpose,
  type SessionParams,
  sortScopeCards,
} from '../domain/scope';
import { DataState } from '../domain/types';
import type { Engine, EngineMeta } from './engine';
import { useNow } from './useNow';

/** The engine of the nearest DataProvider. DataContext.tsx provides it. */
export const EngineContext = createContext<Engine | null>(null);

/** The engine of the nearest DataProvider. Throws outside one. */
export function useEngine(): Engine {
  const engine = useContext(EngineContext);
  if (!engine) throw new Error('useEngine must be used inside DataProvider');
  return engine;
}

/**
 * One value from the app state. The component re-renders only when the value
 * changes. `selector` may be an inline function.
 */
export function useStoreSelector<T>(selector: (state: DataState) => T): T {
  const store = useEngine().store;
  const read = useMemo(() => cachedPerState(store.getState, selector), [store, selector]);
  return useSyncExternalStore(store.subscribe, read, read);
}

/** ready / persistError / lastCompletion of the engine. */
export function useEngineMeta(): EngineMeta {
  const meta = useEngine().meta;
  return useSyncExternalStore(meta.subscribe, meta.getState, meta.getState);
}

/** Achievement statuses for the current state (Progress screen). */
export function useAchievements() {
  return useStoreSelector(achievementsOf);
}

/**
 * The achievements of a state: unlocked or not, with progress. Pure.
 * "Mastered" is the ONE lifecycle rule (life.ts isMastered): a Known card is
 * never mastered, so marking 2,000 cards "I know it" unlocks nothing.
 */
export function achievementsOf(state: DataState) {
  const masteredCount = state.cards.filter(isMastered).length;
  return achievementStatuses({
    person: state.person,
    cards: state.cards,
    sessions: state.sessions,
    masteredCount,
    fastAnswers: state.person.fastAnswers,
  });
}

/**
 * `() => selector(getState())`, but computed only when the state object
 * changes. useSyncExternalStore calls this on every render and compares the
 * results: a selector that builds a new array each time would otherwise look
 * like a change every time (an endless re-render).
 */
export function cachedPerState<S, T>(getState: () => S, selector: (state: S) => T): () => T {
  let cache: { state: S; value: T } | null = null;
  return () => {
    const state = getState();
    if (cache === null || cache.state !== state) cache = { state, value: selector(state) };
    return cache.value;
  };
}

/* ------------------------------------------------------------ the note-model state */

/**
 * useStoreSelector for a selector written against the note model
 * (DataStateV3, src/domain/model.ts). Since unit W3-1 types.ts' `DataState`
 * IS `DataStateV3`, so this is useStoreSelector itself, under the name the
 * hooks below were written with (no cast, nothing copied).
 */
export function useStateV3<T>(selector: (state: DataStateV3) => T): T {
  return useStoreSelector(selector);
}

/**
 * A selector that runs `compute` again only when one of `inputs(state)` is a
 * different object; otherwise it returns its last result. The store never
 * edits an object in place, so "the same object" means "the same data".
 */
export function memoOnInputs<S, T>(inputs: (state: S) => readonly unknown[], compute: (state: S) => T): (state: S) => T {
  let last: { inputs: readonly unknown[]; value: T } | null = null;
  return (state) => {
    const now = inputs(state);
    if (last !== null && now.length === last.inputs.length && now.every((v, i) => v === last!.inputs[i])) {
      return last.value;
    }
    const value = compute(state);
    last = { inputs: now, value };
    return value;
  };
}

/** What a scope reads: its cards, the library, decks and lists (for queries and facets). */
const scopeInputs = (s: DataStateV3): readonly unknown[] => [s.cards, s.notes, s.noteTypes, s.decks, s.lists];

/** What a Study count also reads: today's tallies and the settings (limits, session size, siblings). */
const studyInputs = (s: DataStateV3): readonly unknown[] => [...scopeInputs(s), s.person?.dayDone, s.settings];

/** True when two ReadyCounts hold the same numbers. */
function sameReady(a: ReadyCounts, b: ReadyCounts): boolean {
  return (
    a.total === b.total &&
    a.learning === b.learning &&
    a.due === b.due &&
    a.checks === b.checks &&
    a.neww === b.neww &&
    a.mins === b.mins &&
    a.capped === b.capped &&
    a.uncappedTotal === b.uncappedTotal
  );
}

/* ------------------------------------------------------------ pure readers (tested) */

/**
 * The selector behind useReady: readyFor(state, q) at `now`, recomputed only
 * when the cards, library, decks, lists, tallies or settings change, and the
 * SAME object while the numbers stay equal. `queryKey` is serializeQuery(q).
 */
export function readyReader(queryKey: string, now: number): (state: DataStateV3) => ReadyCounts {
  const q = parseQueryParam(queryKey);
  let last: ReadyCounts | null = null;
  return memoOnInputs(studyInputs, (state) => {
    const next = readyFor(state, q, matchCtxOf(state, now));
    if (last !== null && sameReady(last, next)) return last;
    last = next;
    return next;
  });
}

/** The selector behind useDeckStatsMap (scope.ts deckStatsMap at `now`). */
export function deckStatsReader(now: number): (state: DataStateV3) => ReadonlyMap<Id, DeckSummary> {
  return memoOnInputs(studyInputs, (state) => deckStatsMap(state, matchCtxOf(state, now)));
}

/** How many facet results (scope, selection, time) are kept per library (unit P1). */
export const FACETS_KEPT = 8;

/** The facet results of one library: the parts of the state they read, and the results by key. */
interface FacetResults {
  inputs: readonly unknown[];
  /** `${now}␟${scopeKey}␟${selectionKey}` → the facets. Newest last. */
  byKey: Map<string, Facet[]>;
}

/*
 * Per cards array (each store state has its own), so two stores never mix
 * their results. Kept by the cards array and checked against the other
 * inputs (notes, card types, decks, lists): a rating, an edit, an import or
 * an undo makes new arrays, so a kept result is never stale.
 */
const facetResults = new WeakMap<readonly unknown[], FacetResults>();
/** The key of a state without a cards array (damaged data). */
const NO_CARDS_KEY: readonly unknown[] = Object.freeze([]);

/** True when two input lists hold the same objects. */
function sameInputs(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The selector behind useFacets and the FacetSheet: deriveFacets over every
 * card, for a scope and a selection, at `now`.
 *
 * SHARED RESULTS (unit P1; the release pass counted again for every opening
 * of the same library). Every reader of the same (scope, selection, time)
 * over the same data gets the SAME array from one cache, also a reader made
 * by a new render or a new opening of the sheet — so the counts are made
 * once, and perfMarks.timedSelector records no line for a result it saw
 * before. (The release pass's two counts for ONE opening, 161.7 + 68.2 ms,
 * had another cause: a minute tick of the clock while the sheet was open,
 * so a new time. FacetSheet.tsx keeps the time of the opening for that.)
 */
export function facetsReader(selectionKey: string, scopeKey: string, now: number): (state: DataStateV3) => Facet[] {
  const selection = parseQueryParam(selectionKey);
  const scope = parseQueryParam(scopeKey);
  const key = `${now}\u001f${scopeKey}\u001f${selectionKey}`;
  return (state) => {
    const inputs = scopeInputs(state);
    // A WeakMap key must be an object: damaged data without a cards array shares one stand-in.
    const cardsKey: readonly unknown[] = state.cards ?? NO_CARDS_KEY;
    let results = facetResults.get(cardsKey);
    if (!results || !sameInputs(results.inputs, inputs)) {
      results = { inputs, byKey: new Map() };
      facetResults.set(cardsKey, results);
    }
    const hit = results.byKey.get(key);
    if (hit) {
      // The newest last (the oldest goes first when there are too many).
      results.byKey.delete(key);
      results.byKey.set(key, hit);
      return hit;
    }
    const facets = deriveFacets(state.cards, scope, selection, matchCtxOf(state, now));
    results.byKey.set(key, facets);
    while (results.byKey.size > FACETS_KEPT) results.byKey.delete(results.byKey.keys().next().value as string);
    return facets;
  };
}

/** The selector behind useScopePool (scope.ts scopePool at `now`). */
export function scopePoolReader(queryKey: string, purpose: ScopePurpose, now: number): (state: DataStateV3) => Card[] {
  const q = parseQueryParam(queryKey);
  return memoOnInputs(studyInputs, (state) => scopePool(state, q, matchCtxOf(state, now), purpose));
}

/**
 * The selector behind useSortedScopePool: every card of the scope ('browse'),
 * in the order of `sort` (scope.ts sortScopeCards — the ONE sort rule, the
 * same order Practice uses). `sortKey` is JSON.stringify(sort).
 */
export function sortedPoolReader(queryKey: string, sortKey: string, now: number): (state: DataStateV3) => Card[] {
  const q = parseQueryParam(queryKey);
  const sort = JSON.parse(sortKey) as SortSpec;
  return memoOnInputs(studyInputs, (state) => {
    const ctx = matchCtxOf(state, now);
    return sortScopeCards(scopePool(state, q, ctx, 'browse'), sort, state, ctx);
  });
}

/**
 * The selector behind useSessionLength: the length of the session `params`
 * would open now (buildSessionQueue). `paramsKey` is sessionParamsKey(params).
 */
export function sessionLengthReader(paramsKey: string, now: number): (state: DataStateV3) => number {
  const params = parseSessionParams(paramsKey);
  return memoOnInputs(studyInputs, (state) => buildSessionQueue(params, state, matchCtxOf(state, now)).length);
}

/** SessionParams → a stable text key (the query in its clean form). */
export function sessionParamsKey(params: SessionParams): string {
  if (params.kind === 'practice' && 'sel' in params) {
    return JSON.stringify({ kind: 'practice', sel: [...params.sel], sort: params.sort ?? null });
  }
  const sort = params.kind === 'practice' && 'sort' in params ? params.sort ?? null : null;
  return JSON.stringify({ kind: params.kind, q: serializeQuery(params.q), sort });
}

/** The inverse of sessionParamsKey. */
function parseSessionParams(key: string): SessionParams {
  const raw = JSON.parse(key) as { kind: SessionParams['kind']; q?: string; sel?: Id[]; sort?: SortSpec | null };
  if (raw.kind === 'practice' && raw.sel) return { kind: 'practice', sel: raw.sel, sort: raw.sort ?? null };
  const q = parseQueryParam(raw.q ?? '');
  if (raw.kind === 'practice') return { kind: 'practice', q, sort: raw.sort ?? null };
  return { kind: raw.kind, q };
}

/* ------------------------------------------------------------ derived hooks */

/** A query with no group ("All"). */
const ALL: Query = Object.freeze({});
/** The facets while the FacetSheet is closed (spec §4.3: counts only while it is open). */
const NO_FACETS: Facet[] = [];
const noFacets = (): Facet[] => NO_FACETS;

/**
 * The library index (spec §4.4): notes and card types by id, search text,
 * facet values. Built once per (notes, card types) arrays — a rating does
 * not rebuild it.
 */
export function useLibraryIndex(): LibraryIndex {
  return useStateV3(libraryIndexOf);
}

/** The MatchCtx (§4.1) of the current state: now, the library index, decks and lists by id. */
export function useMatchCtx(): MatchCtx {
  const now = useNow();
  const selector = useMemo(
    () => memoOnInputs((s: DataStateV3) => [s.notes, s.noteTypes, s.decks, s.lists], (s) => matchCtxOf(s, now)),
    [now],
  );
  return useStateV3(selector);
}

/**
 * The numbers on the "Study N" button of scope `q` (spec §4.6). `total` is
 * the length of the session buildSessionQueue({ kind: 'scheduled', q }) opens.
 *
 *   const ready = useReady({});                      // Today hero, tab badge
 *   const deck = useReady({ decks: [deckId] });      // a deck's button
 */
export function useReady(q: Query): ReadyCounts {
  const now = useNow();
  const key = serializeQuery(q);
  const selector = useMemo(() => readyReader(key, now), [key, now]);
  return useStateV3(selector);
}

/**
 * Every deck row's numbers (total, statuses, "{n} due", and `ready` = the
 * deck's "Study N"), from ONE pass over all cards (spec §8.1).
 */
export function useDeckStatsMap(): ReadonlyMap<Id, DeckSummary> {
  const now = useNow();
  const selector = useMemo(() => deckStatsReader(now), [now]);
  return useStateV3(selector);
}

/**
 * The filter groups of `scope` with live counts for the chips in `selection`
 * (spec §4.3). Pass `enabled = false` while the FacetSheet is closed: the
 * counts are only computed while it is open.
 */
export function useFacets(selection: Query, scope: Query = ALL, enabled: boolean = true): Facet[] {
  const now = useNow();
  const selectionKey = serializeQuery(selection);
  const scopeKey = serializeQuery(scope);
  const selector = useMemo(
    () => (enabled ? facetsReader(selectionKey, scopeKey, now) : noFacets),
    [enabled, selectionKey, scopeKey, now],
  );
  return useStateV3(selector);
}

/**
 * The cards of scope `q` (scope.ts scopePool): 'browse' = every matching card
 * (the Library list); 'study' = only the cards Study may show.
 */
export function useScopePool(q: Query, purpose: ScopePurpose = 'browse'): Card[] {
  const now = useNow();
  const key = serializeQuery(q);
  const selector = useMemo(() => scopePoolReader(key, purpose, now), [key, purpose, now]);
  return useStateV3(selector);
}

/**
 * Every card of scope `q` in the order of `sort`: the Library list (spec
 * §8.3, the "Deck order ▾" menu). The order is scope.ts sortScopeCards, so
 * "Practice {n}" from the same chips and sort practises the cards in the
 * same order the list shows them.
 *
 *   const rows = useSortedScopePool(chips, { by: 'az' });   // "das Anliegen" under A
 */
export function useSortedScopePool(q: Query, sort: SortSpec): Card[] {
  const now = useNow();
  const key = serializeQuery(q);
  const sortKey = JSON.stringify({ by: sort.by, field: sort.field, dir: sort.dir });
  const selector = useMemo(() => sortedPoolReader(key, sortKey, now), [key, sortKey, now]);
  return useStateV3(selector);
}

/**
 * How many cards the session `params` would open now: "Practice {n}",
 * "Study ahead · {n}" (spec §4.6). The same function builds the session.
 */
export function useSessionLength(params: SessionParams): number {
  const now = useNow();
  const key = sessionParamsKey(params);
  const selector = useMemo(() => sessionLengthReader(key, now), [key, now]);
  return useStateV3(selector);
}
