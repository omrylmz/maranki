/**
 * The Library's rules (spec §8.3, §4.2, §4.6, §4.7, unit W4-2) — pure and
 * tested (libraryState.test.ts). library.tsx and the library/* components
 * hold React state and layout only; every decision is here.
 *
 * THE SCREEN STATE (`LibraryState`) is one plain object:
 *   chips      every filter group except the free text (Deck, Level, Not started …)
 *   text       what is in the search box (free words; tokens become chips)
 *   fromList   the list the Library was opened with ("From list 'B1 verbs'")
 *   sort       the "Deck order ▾" choice
 *   applied    the route request already applied (its `nonce`)
 *   intent     why the Library was opened ('newList' = the "New list" request)
 *   selecting  select mode is on
 *   selection  the selected cards: ids, or "Select all" = the QUERY itself
 * The query the list shows is `effectiveQuery(chips, the parsed text)`.
 *
 * ROUTE PARAMS (spec §4.6). Callers open the Library with `q` (a Query as
 * JSON) and `nonce` (new on every navigation). The screen keeps the nonce it
 * applied in `applied`, and DURING RENDER does
 *
 *   const next = applyRouteParams(state, params, lists);
 *   if (next) setState(next);
 *
 * — React's "adjust state when a prop changes" pattern: no effect, so no
 * lint error and no frame with the old filters. A list (`{"list": id}`) is
 * opened as ITS OWN chips (so a chip can be removed or added) and
 * `fromList` remembers it, for "From list '{name}'" · "Update list".
 * "Clear all" (`clearAll`) clears the filters AND says which params to clear
 * (`router.setParams({ q: undefined, nonce: undefined, newList: undefined })`).
 *
 * A third param, `newList=1`, is the "New list" request (spec §8.10). The
 * AddSheet and Today's "+ New list" send it (todayLogic NEW_LIST_PARAM):
 * `/(tabs)/library?q={}&nonce=…&newList=1`. The Library then shows the line
 * "Add filters, then tap Save as list." until the first "Save as list" or
 * "Clear all". It is the ONLY spelling of this request (wave 5: the old
 * `intent=newList` is gone, so two callers can never disagree).
 *
 * Also here: the real select-mode toggles (Favorite / Unfavorite …), the
 * smart empty state's best chip, the "Show {n} cards" number of the
 * FacetSheet, the row texts (status, badge, direction), the sort menu, the
 * suggestion chips, the FAB's deck, and the session / triage routes.
 *
 * Wave 5b (the device walkthrough on 16,260 cards):
 *   H2   typeSearch / submitSearch — Return parses the EVENT's text;
 *   M8   libraryChips / chipScopeFor — the chips use the FacetSheet's group
 *        names, in the chip row, the "No cards match" line and its "Remove …"
 *        button (bestChipToRemove) alike;
 *   M9   parseForList / pendingTokenStart / listTextFor — no count for a
 *        half-typed token: the list, the buttons, "Select all" and the
 *        FacetSheet's start (facetStartQuery) all leave it out, and while the
 *        learner edits a complete token (`level:b1` → `level:b`) they keep
 *        the result the list shows (review round 2);
 *        rowsReader — the list is memoized per (query, sort, data);
 *        facetCountsDeferred / withDraftSelection — a big library's FacetSheet
 *        counts after a tick, and a tapped chip turns on at once;
 *   L12  rankRows — free words: headline matches first;
 *   L16  selectionGone — select mode ends when nothing selected is visible.
 *
 * Wave 5c (the polish reviews):
 *   typeSearch / splitHalfTokens — a space does not finish a half-typed token
 *        (`level:b `): it stays in the box as text, never a 0-card chip, and
 *        the list shows no count for it, at the end of the box or in the middle;
 *   libraryChips — the field and Direction names now live in searchParse
 *        chipsOf, so the triage title says them the same way;
 *   M6   chooseCount / chooseButton — "Choose ({n})" counts the triage's
 *        ITEMS ("Choose (6 items)" for 12 cards), like the triage it opens;
 *   review round 1: parseForList / facetsDone — the box keeps what was typed
 *        in its order (only the tokens that became chips leave it); a field
 *        typed by the name its chip shows (`word_type:`) is half-typed by the
 *        same rule as its key (searchParse fieldKeyFor).
 *
 * Pure: no React, no clock (the caller passes `now`), no store writes. The
 * one mutable thing is a screen's RowsCache, which only its readers change.
 */
import { triageLookupOf } from '../deck/deckPageLogic';
import { cardIdsOf, cardsAndItems, triageItems } from '../deck/triageLogic';
import { faceHeadline } from '../../domain/face';
import {
  directionGroupNames,
  type DirectionGroupNames,
  directionInfo,
  DUE_LABELS,
  type Facet,
  type FacetKey,
  type FacetValue,
  fieldGroupLabel,
  isFacetValueSelected,
} from '../../domain/facets';
import { foldPath, foldTag, type LibraryIndex } from '../../domain/libraryIndex';
import { isDueNow, life, LIFE_LABELS } from '../../domain/life';
import { isBuiltinListId, listQueryChanged, stripListKey } from '../../domain/lists';
import type { Card, DataStateV3, Deck, Id, LifeKey, ListDef, Query, SortSpec } from '../../domain/model';
import { detectOrdinal, type OrdinalKind } from '../../domain/ordinal';
import {
  compileGroups,
  type GroupId,
  isEmptyQuery,
  type MatchCtx,
  parseQueryParam,
  sameQuery,
  sanitizeQuery,
  serializeQuery,
} from '../../domain/query';
import { browsePool, matchCtxOf, sortScopeRows } from '../../domain/scope';
import {
  buildSearchCtx,
  type ChipId,
  type ChipModel,
  type ChipScope,
  chipsOf,
  fieldKeyFor,
  mergeQueries,
  parseSearch,
  type ParsedSearch,
  removeChip,
  type SearchCtx,
} from '../../domain/searchParse';
import { foldText, oneLine, plural } from '../../domain/text';
import { nextReviewShort } from '../../utils/dateFormatting';

/* =================================================================== state */

/** The selected cards: a list of ids, or "Select all" = every card of a query. */
export type LibrarySelection = { kind: 'ids'; ids: readonly Id[] } | { kind: 'query'; query: Query };

/**
 * Why the Library was opened (kept in the screen state, not a route param).
 * 'newList' = the "New list" request `newList=1` (spec §8.10): the Library
 * shows the line "Add filters, then tap Save as list.".
 */
export type LibraryIntent = 'newList';

/** The state's `intent` after a "New list" request. */
export const NEW_LIST_INTENT: LibraryIntent = 'newList';

/**
 * The value of the `newList` route param that asks for "New list". It is the
 * value todayLogic NEW_LIST_PARAM sends (`{ newList: '1' }`); it is written
 * again here because this file stays pure (todayLogic reads the store), and
 * libraryState.test.ts checks that the two are the same.
 */
export const NEW_LIST_PARAM_VALUE = '1';

export interface LibraryState {
  /** Every filter group of the query EXCEPT `text` (the search box holds the text). */
  chips: Query;
  /** The search box, as typed. */
  text: string;
  /** The list the Library was opened with (its id), or null. */
  fromList: string | null;
  sort: SortSpec;
  /** The route request already applied (routeKey), or null. */
  applied: string | null;
  /** Why the Library was opened ('newList' shows the "New list" line), or null. */
  intent: LibraryIntent | null;
  selecting: boolean;
  selection: LibrarySelection;
}

/** The Library's route params (spec §2.2). expo-router may give an array for a repeated param. */
export interface LibraryParams {
  q?: string | string[];
  nonce?: string | string[];
  /** The "New list" request: `newList=1` (todayLogic NEW_LIST_PARAM). Any other value is no request. */
  newList?: string | string[];
}

/** "Deck order" — the first entry of the sort menu. */
export const DEFAULT_SORT: SortSpec = Object.freeze({ by: 'source' }) as SortSpec;

/** No card selected. */
export const NO_SELECTION: LibrarySelection = Object.freeze({ kind: 'ids', ids: Object.freeze([]) as readonly Id[] });

/**
 * What "Clear all" passes to router.setParams: every route param goes. Also
 * `newList`: router.setParams MERGES, so a `newList=1` left in the route
 * (without a nonce) would be a "New list" request again (routeKey), and the
 * line would come back.
 */
export const CLEARED_PARAMS = Object.freeze({ q: undefined, nonce: undefined, newList: undefined });

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** 'newList' when the params hold the "New list" request (`newList=1`); else null. */
function intentOf(params: LibraryParams): LibraryIntent | null {
  return firstParam(params.newList) === NEW_LIST_PARAM_VALUE ? NEW_LIST_INTENT : null;
}

/**
 * The key of one route request: its `nonce` (every caller sends a new one,
 * so the same filter asked twice is still a new request — STATE_BUG_AUDIT
 * U1). Without a nonce, the `q` text itself, else the "New list" request.
 * null = no request.
 */
export function routeKey(params: LibraryParams): string | null {
  const nonce = firstParam(params.nonce);
  if (nonce !== undefined && nonce !== '') return `n:${nonce}`;
  const q = firstParam(params.q);
  if (q !== undefined && q !== '') return `q:${q}`;
  const intent = intentOf(params);
  return intent !== null ? `i:${intent}` : null;
}

/** A query split into the chips and the free text (the text lives in the search box). */
export function splitText(q: Query): { chips: Query; text: string } {
  const clean = sanitizeQuery(q);
  const text = clean.text ?? '';
  return { chips: sanitizeQuery({ ...clean, text: undefined }), text };
}

/** What a route request opens. */
export interface OpenedQuery {
  chips: Query;
  text: string;
  /** The list it came from (only when the list exists). */
  fromList: string | null;
  /** The list's saved sort, if it has one. */
  sort: SortSpec | null;
}

/**
 * Open a query from the route (spec §4.7: "Opening a list in Library shows
 * its chips"). `{list: id}` becomes the list's own chips (AND whatever else
 * the request has), so each one can be removed; a list that does not exist
 * (deleted) stays a "List: …" chip that matches nothing and can be removed.
 *
 *   openQuery({ list: 'l1' }, lists)   // l1 = { decks: ['d1'], fields: { level: ['b1'] } }
 *     → chips { decks: ['d1'], fields: { level: ['b1'] } }, fromList 'l1'
 */
export function openQuery(q: Query, lists: ReadonlyMap<string, ListDef>): OpenedQuery {
  const clean = sanitizeQuery(q);
  const def = clean.list !== undefined ? lists.get(clean.list) : undefined;
  if (!def) return { ...splitText(clean), fromList: null, sort: null };
  const merged = mergeQueries(stripListKey(def.query), stripListKey(clean));
  return { ...splitText(merged), fromList: def.id, sort: def.sort ?? null };
}

/** The state of a Library that opens with these route params. */
export function initialLibraryState(params: LibraryParams, lists: ReadonlyMap<string, ListDef>): LibraryState {
  const opened = openQuery(parseQueryParam(firstParam(params.q)), lists);
  return {
    chips: opened.chips,
    text: opened.text,
    fromList: opened.fromList,
    sort: opened.sort ?? DEFAULT_SORT,
    applied: routeKey(params),
    intent: intentOf(params),
    selecting: false,
    selection: NO_SELECTION,
  };
}

/**
 * The state after a NEW route request, or null when the request was applied
 * already (call it during render; set the state only when it is not null).
 * A new request replaces the filters and the intent, and ends select mode
 * (the selected cards belong to the old filters). The sort stays, unless the
 * list has one.
 */
export function applyRouteParams(
  state: LibraryState,
  params: LibraryParams,
  lists: ReadonlyMap<string, ListDef>,
): LibraryState | null {
  const key = routeKey(params);
  if (key === state.applied) return null;
  // The params were cleared ("Clear all", or a plain tab press): there is no
  // request, so nothing changes on screen — only the key is remembered.
  if (key === null) return { ...state, applied: null };
  const opened = openQuery(parseQueryParam(firstParam(params.q)), lists);
  return {
    ...state,
    chips: opened.chips,
    text: opened.text,
    fromList: opened.fromList,
    sort: opened.sort ?? state.sort,
    applied: key,
    intent: intentOf(params),
    selecting: false,
    selection: NO_SELECTION,
  };
}

/**
 * "Clear all" (spec §4.6, §8.3): every chip, the text, the list and the
 * "New list" line go; the sort stays. `params` is what the screen passes to
 * `router.setParams`, so the route request is cleared too.
 *
 * `applied` stays: it is the key of the request now in the params, so that
 * request is NOT applied again in the render before the router has cleared
 * the params (setParams is not instant). When the params are empty, the key
 * becomes null and nothing changes on screen (applyRouteParams).
 */
export function clearAll(state: LibraryState): { state: LibraryState; params: typeof CLEARED_PARAMS } {
  return {
    state: {
      ...state,
      chips: {},
      text: '',
      fromList: null,
      intent: null,
      selection: NO_SELECTION,
    },
    params: CLEARED_PARAMS,
  };
}

/** New chips (the text stays). A filter change empties the selection: it belonged to the old results. */
export function withChips(state: LibraryState, chips: Query): LibraryState {
  return { ...state, chips: splitText(chips).chips, selection: NO_SELECTION };
}

/** A query from the FacetSheet (chips AND text). */
export function withQuery(state: LibraryState, q: Query): LibraryState {
  const { chips, text } = splitText(q);
  const sameText = sanitizeQuery({ text: state.text }).text === (text || undefined);
  return { ...state, chips, text: sameText ? state.text : text, selection: NO_SELECTION };
}

/** The search box changed (typing). */
export function withText(state: LibraryState, text: string): LibraryState {
  if (text === state.text) return state;
  return { ...state, text, selection: NO_SELECTION };
}

/** The × of a chip. The text chip clears the search box. */
export function removeChipFrom(state: LibraryState, chipId: ChipId | string): LibraryState {
  if (chipId === 'text') return withText(state, '');
  return withChips(state, removeChip(state.chips, chipId));
}

/**
 * The smart empty state's "Remove {chip}" button (spec §8.3). Its chip is
 * found in the WHOLE query: the chips AND the parsed search box. So the chip
 * can still be a token in the box (`is:suspended`, typed with no space and no
 * Return yet), and `removeChipFrom` alone would not find it in `chips` — the
 * button would do nothing. So the tokens of the box become chips first
 * (commitSearch), and then the chip is removed:
 *
 *   chips { Level: B1 }, box 'is:suspended'   → no card matches
 *   removeBestChip(state, parsed, 'flags')    → chips { Level: B1 }, box ''
 *
 * The text chip removes only the free words; a token in the box stays (as a
 * chip). `parsed` is the box text parsed NOW (parseLive of `state.text`).
 */
export function removeBestChip(state: LibraryState, parsed: ParsedSearch, chipId: ChipId | string): LibraryState {
  const base = parsedChips(parsed) ? commitSearch(state, parsed) : state;
  return removeChipFrom(base, chipId);
}

/**
 * The typed tokens became chips (on Return, or a space after a complete
 * token, spec §4.2): the chips of `parsed` join the chips, and the box keeps
 * only the free words (`parsed.rest`).
 */
export function commitSearch(state: LibraryState, parsed: ParsedSearch, keepSpace = false): LibraryState {
  const { chips: added } = splitText(parsed.query);
  const rest = parsed.rest.trim();
  const text = rest !== '' && keepSpace ? `${rest} ` : rest;
  return { ...state, chips: mergeQueries(state.chips, added), text, selection: NO_SELECTION };
}

export function withSort(state: LibraryState, sort: SortSpec): LibraryState {
  return { ...state, sort };
}

/**
 * A list was saved from these chips ("Save as list"): the Library now shows
 * it, and the "New list" line is done (the user did what it asked).
 */
export function savedAsList(state: LibraryState, listId: Id): LibraryState {
  return { ...state, fromList: listId, intent: null };
}

/** The "New list" line is shown (spec §8.10): opened from "New list", and not selecting. */
export function showsNewListBanner(state: LibraryState): boolean {
  return state.intent === NEW_LIST_INTENT && !state.selecting;
}

/* ------------------------------------------------------------- select mode */

export function startSelecting(state: LibraryState): LibraryState {
  return { ...state, selecting: true, selection: NO_SELECTION };
}

export function stopSelecting(state: LibraryState): LibraryState {
  return { ...state, selecting: false, selection: NO_SELECTION };
}

/**
 * "Select all {n}" (spec §8.3): the selection IS the query — never a list
 * of ids (a whole library of ids must not be kept or put in a URL). The
 * cards are found from the query when an action runs.
 *
 * `query` must be the query of the rows the user SEES after the tap: the
 * chips AND the search box AS TYPED (`shownQueryNow`), not the list's
 * 150 ms debounced text. The screen also lets the list catch up with the box
 * at the same time. Else a tap right after typing 'bahnhof' would select the
 * 9 cards of the OLD list, while the list then shows only 'der Bahnhof'.
 */
export function selectAll(state: LibraryState, query: Query): LibraryState {
  return { ...state, selecting: true, selection: { kind: 'query', query: sanitizeQuery(query) } };
}

/**
 * True when "Select all" covers exactly the rows on screen, so every row is
 * drawn selected: the selection is a query, and it is the SAME query as the
 * list's. When the two differ (for one render, while the list catches up),
 * no row is drawn selected — a row never looks selected when the action
 * would not change it.
 */
export function selectsAllShown(selection: LibrarySelection, shownQuery: Query): boolean {
  return selection.kind === 'query' && sameQuery(selection.query, shownQuery);
}

/**
 * A tap on a row in select mode. After "Select all", the first tap turns
 * the query into the ids of the shown cards minus the tapped one.
 */
export function toggleSelected(state: LibraryState, id: Id, shownIds: readonly Id[]): LibraryState {
  const sel = state.selection;
  if (sel.kind === 'query') {
    return { ...state, selection: { kind: 'ids', ids: shownIds.filter((x) => x !== id) } };
  }
  const has = sel.ids.includes(id);
  return { ...state, selection: { kind: 'ids', ids: has ? sel.ids.filter((x) => x !== id) : [...sel.ids, id] } };
}

/**
 * The selection as a list of ids, after an action ran on it: the next toggle
 * keeps working on the SAME cards while some of them are still in the
 * results (selectionGone ends select mode when none is).
 */
export function withSelectedIds(state: LibraryState, ids: readonly Id[]): LibraryState {
  return { ...state, selection: { kind: 'ids', ids: [...ids] } };
}

/**
 * True when select mode should END by itself (walkthrough L16): cards are
 * selected, but NONE of them is in the list any more — "Unsuspend" on the
 * Suspended list empties the list, and "2 selected" over an empty list with
 * a bulk bar for cards you cannot see is confusing. The bulk change's
 * snackbar (with Undo) stays: it is the way back.
 *
 * `shown(id)` says whether a card is in the list. "Select all" (a query) is
 * the list itself, and an empty selection (just tapped "Select") is left
 * alone.
 *
 *   selectionGone({ selecting: true, selection: ids ['c1', 'c2'] }, (id) => false)   // true
 */
export function selectionGone(state: LibraryState, shown: (id: Id) => boolean): boolean {
  const sel = state.selection;
  if (!state.selecting || sel.kind !== 'ids' || sel.ids.length === 0) return false;
  return !sel.ids.some(shown);
}

/** The query the list shows: the chips AND the parsed search text. */
export function effectiveQuery(chips: Query, textQuery: Query): Query {
  return mergeQueries(chips, textQuery);
}

/** True when a query reads the clock: its `due` group, or the `buried` marker (in or not in). */
function readsClock(q: Query): boolean {
  return q.due !== undefined || (q.flags ?? []).includes('buried') || (q.notFlags ?? []).includes('buried');
}

/**
 * The time the LIST reader gets (spec §8.3: fast with 16,000 cards).
 *
 * WHY: the list reader (selectors.ts sortedPoolReader) filters and sorts
 * every card again each time it gets a new `now`. useNow() gives a new `now`
 * right after the screen opens and then every minute. But only two parts of
 * a query read the clock (query.ts compileGroups): the `due` group and the
 * `buried` marker. The sort never reads it (schedule.ts cardComparator). So
 * for every other query the time cannot change the list, and the screen
 * passes 0: the reader stays the same, and a clock tick gives the SAME rows
 * (no new pass over 16,000 cards).
 *
 *   listClock({ decks: ['d1'] }, lists, now)      // 0   (a tick changes nothing)
 *   listClock({ due: 'now' }, lists, now)         // now (the list follows the time)
 *   listClock({ list: 'l1' }, lists, now)         // now when list l1's query reads the clock
 */
export function listClock(q: Query, lists: ReadonlyMap<string, ListDef>, now: number): number {
  const clean = sanitizeQuery(q);
  if (readsClock(clean)) return now;
  // A list is resolved one level deep (its own `list` key is ignored), like compileGroups.
  const def = clean.list !== undefined ? lists.get(clean.list) : undefined;
  return def && readsClock(stripListKey(def.query)) ? now : 0;
}

/* ------------------------------------------- the list: a cache (M9) and rank (L12) */

/** How many filtered pools (and sorted lists) a Library keeps. */
export const ROWS_CACHE_SIZE = 8;

/**
 * The Library's memory of the lists it made (walkthrough M9: "filter 1204 ms"
 * on 16,000 cards in a debug build). One object per Library screen
 * (`useState(createRowsCache)`); the readers of `rowsReader` share it.
 */
export interface RowsCache {
  /** The parts of the state a list depends on, when the entries were made. */
  inputs: readonly unknown[] | null;
  /**
   * (time, query) → the matching cards, in state order. Newest last. Only
   * read, never changed: for "no filter" it is the state's own cards array
   * (scope.ts browsePool, unit P4).
   */
  pools: Map<string, readonly Card[]>;
  /**
   * (time, query, sort) → the rows in list order. Newest last. Only read,
   * never changed: a Deck order list of a library stored in that order is
   * its pool itself (scope.ts sortScopeRows, unit P4 review).
   */
  rows: Map<string, readonly Card[]>;
}

export function createRowsCache(): RowsCache {
  return { inputs: null, pools: new Map(), rows: new Map() };
}

/**
 * What a browse list reads from the state (no tallies, no settings: a
 * rating's dayDone does not matter). Destructured: the face guard
 * (face.test.ts) forbids a direct property read of the notes in screens.
 */
const listInputs = ({ cards, notes, noteTypes, decks, lists }: DataStateV3): readonly unknown[] => [
  cards,
  notes,
  noteTypes,
  decks,
  lists,
];

/** A hit moves to the end (newest); a new entry pushes the oldest out. */
function lruGet<T>(map: Map<string, T>, key: string): T | undefined {
  const hit = map.get(key);
  if (hit !== undefined) {
    map.delete(key);
    map.set(key, hit);
  }
  return hit;
}

function lruSet<T>(map: Map<string, T>, key: string, value: T): void {
  map.set(key, value);
  while (map.size > ROWS_CACHE_SIZE) map.delete(map.keys().next().value as string);
}

/**
 * The store selector of the Library list (spec §8.3; walkthrough M9, L12):
 * every card that matches the query, in the chosen sort, and — when the box
 * has free words — the cards whose HEADLINE matches them first (rankRows).
 *
 * MEMOIZED per (query, sort, time) AND the identity of the data: the
 * filtered pool and the sorted rows are kept in `cache` (the newest 8 of
 * each) until the cards, notes, card types, decks or lists change. So:
 *   - typing back to a text the list showed before ("hund" → "hun" → "hund"),
 *     opening and closing a sheet, scrolling, or a clock tick that does not
 *     change the list (listClock) do NOT filter 16,000 cards again;
 *   - a new sort re-sorts the SAME filtered pool (no new filter pass);
 *   - a hit returns the SAME array, so perfMarks.timedSelector records only
 *     real work, and React draws nothing new.
 * The sort itself (scope.ts sortScopeCards, unit P1) cuts a big pool out of
 * the library's order for that sort, made once per data — no sort per
 * query — and rankRows reads only the cards' headlines (face.ts
 * faceHeadline), never whole faces. The rows are exactly the ones before.
 *
 * Unit P4 (the release re-measure on 16,260 cards): the pool of "no
 * filter" is the state's own cards array (scope.ts browsePool: no copy),
 * and "Deck order" — already the store's order — is the pool itself
 * (sortScopeRows, no copy; sortScopeCards gives a copy). A Level, Section or Card type chip is answered from
 * the note lookups of scope.ts (one Set lookup per card): "Deck German +
 * B1" took 36–45 ms on the device, and its time was in this filter, not in
 * the sort.
 *
 * Unit P4 review:
 *   - "Deck order" of a library stored in that order is the pool ITSELF
 *     (scope.ts sortScopeRows): the "no filter" opening returns the state's
 *     own cards array and makes no array of 16,000 cards, so no garbage
 *     collection can start inside this timed line because of it. The rows
 *     are read only (the screen never changes them).
 *   - The FIRST list on a new library index (after a note edit, or before
 *     the warm-up made the lookups) also makes the lookup part of its chip
 *     (scope.ts: a Level chip makes only the Level part, one pass over the
 *     notes). That time is in this line; "Study n" and "Practice n" of the
 *     same render then reuse the part.
 */
export function rowsReader(
  cache: RowsCache,
  queryKey: string,
  sortKey: string,
  now: number,
): (state: DataStateV3) => readonly Card[] {
  const q = parseQueryParam(queryKey);
  const sort = JSON.parse(sortKey) as SortSpec;
  const poolKey = `${now}\u001f${queryKey}`;
  const rowKey = `${poolKey}\u001f${sortKey}`;
  return (state) => {
    const inputs = listInputs(state);
    if (!cache.inputs || inputs.length !== cache.inputs.length || inputs.some((v, i) => v !== cache.inputs![i])) {
      cache.inputs = inputs;
      cache.pools.clear();
      cache.rows.clear();
    }
    const hit = lruGet(cache.rows, rowKey);
    if (hit) return hit;
    const ctx = matchCtxOf(state, now);
    let pool = lruGet(cache.pools, poolKey);
    if (!pool) {
      pool = browsePool(state, q, ctx);
      lruSet(cache.pools, poolKey, pool);
    }
    const rows = rankRows(sortScopeRows(pool, sort, state, ctx), q.text, ctx.index, ctx.decks);
    lruSet(cache.rows, rowKey, rows);
    return rows;
  };
}

/**
 * How well a card's headline matches the typed words (walkthrough L12):
 *   0  exact      the headline IS the words ("der Hund" for "hund": the A–Z
 *                 key drops the German article; "die Stunde" for "die stunde")
 *   1  start      the headline starts with them, or one of its words is them
 *                 ("Hundefutter", "to go" for "go")
 *   2  other      the words are only somewhere in the card (an example, the back)
 * `needle`, `key` and `plain` are folded (lower case, no accents).
 */
export function headlineRank(needle: string, key: string, plain: string): 0 | 1 | 2 {
  if (key === needle || plain === needle) return 0;
  if (key.startsWith(needle) || plain.startsWith(needle) || plain.split(' ').includes(needle)) return 1;
  return 2;
}

/** The typed free words as one folded needle ('"die stunde"' → 'die stunde'), or '' for none. */
export function searchNeedle(text: string | undefined): string {
  return foldText(oneLine((text ?? '').replace(/"/g, ' ')));
}

/**
 * The rows with free words in the box (walkthrough L12: "der Hund" came
 * after "Achtung"): exact headline matches first, then the ones that start
 * with the words, then the rest. Inside each part the chosen sort stays
 * (a stable split). Without free words, or when no headline matches, the
 * SAME array comes back: the chosen sort alone.
 */
export function rankRows(
  rows: readonly Card[],
  text: string | undefined,
  index: LibraryIndex,
  decks: ReadonlyMap<Id, Deck>,
): readonly Card[] {
  const needle = searchNeedle(text);
  if (needle === '' || rows.length < 2) return rows;
  const parts: [Card[], Card[], Card[]] = [[], [], []];
  for (const card of rows) {
    // The headline's A–Z key and folded text, without building the whole face (face.ts faceHeadline, unit P1).
    const head = faceHeadline(card, index, decks);
    parts[headlineRank(needle, head.sortKey, head.plainFolded)].push(card);
  }
  if (parts[2].length === rows.length) return rows;
  return [...parts[0], ...parts[1], ...parts[2]];
}

/* ------------------------------------------------------------ search text */

/** True when every quote in the text is closed (a space inside "quotes" does not end a token). */
export function quotesClosed(text: string): boolean {
  let n = 0;
  for (const ch of text) if (ch === '"') n += 1;
  return n % 2 === 0;
}

/** True when the box holds a key:value token (only then does the parser need the scope). */
export function hasToken(text: string): boolean {
  return text.includes(':');
}

/**
 * Should the typed text turn into chips now? On a space at the end, with the
 * quotes closed, when there is a token at all. (typeSearch then leaves a
 * HALF-typed token out: only complete tokens become chips.)
 */
export function shouldCommitOnSpace(text: string): boolean {
  return /\s$/.test(text) && quotesClosed(text) && hasToken(text);
}

/** True when a parse made any chip (more than free text). */
export function parsedChips(parsed: ParsedSearch): boolean {
  return Object.keys(splitText(parsed.query).chips).length > 0;
}

/** Per cards array: the parser's view of the whole library (built once, one pass). */
const searchCtxCache = new WeakMap<
  readonly Card[],
  { index: LibraryIndex; decks: ReadonlyMap<Id, Deck>; sctx: SearchCtx }
>();

/**
 * What the search parser knows (searchParse.ts SearchCtx): the decks, the
 * filter fields, sections and tags of the WHOLE library, so `level:b1`
 * works even when the current chips show no card. Built once per cards
 * array (and library index), lazily: only when the box holds a token.
 * `base` = the chips already applied (`section:` uses their only Deck chip).
 */
export function searchCtxFor(cards: readonly Card[], ctx: MatchCtx, base?: Query): SearchCtx {
  let hit = searchCtxCache.get(cards);
  if (!hit || hit.index !== ctx.index || hit.decks !== ctx.decks) {
    hit = { index: ctx.index, decks: ctx.decks, sctx: buildSearchCtx(cards, ctx) };
    searchCtxCache.set(cards, hit);
  }
  return base ? { ...hit.sctx, base } : hit.sctx;
}

/**
 * The search box → a query (spec §4.2: searchParse, so `is:flagged`,
 * `level:b1`, `tag:x` work). Plain words need no parser context, so the
 * context is built only when the text holds a token (`getCtx` is lazy).
 */
export function parseLive(text: string, getCtx: () => SearchCtx): ParsedSearch {
  if (!hasToken(text)) return { query: sanitizeQuery({ text }), rest: text, hints: [] };
  return parseSearch(text, getCtx());
}

/* -------------------------------------------- typing and Return (H2, M9) */

/**
 * The search box changed (onChangeText). A space after a COMPLETE token
 * turns the tokens into chips (spec §4.2); any other text is just the new
 * box text.
 *
 * A HALF-typed token (pendingTokenStart: `level:b`, `tag:alg`) never
 * becomes a chip on a space (wave 5c). Before, `level:b` + space made the
 * chip "Level: b", and the list said "No cards match Level: b" — the bad
 * chip that H2 removed for Return. Now it stays in the box as typed, until
 * it is complete (`level:b1` + space) or the learner presses Return (an
 * explicit "use this", submitSearch). The complete tokens around it still
 * become chips:
 *
 *   typeSearch(s, 'level:b ', …)              // no chip; the box keeps 'level:b '
 *   typeSearch(s, 'is:due level:b ', …)       // chip "Due now"; the box keeps 'level:b '
 *   typeSearch(s, 'level:b haus is:due ', …)  // chip "Due now"; the box keeps 'level:b haus ' (same order)
 *   typeSearch(s, 'level:b1 ', …)             // chip "Level: B1"; the box is ''
 *
 * `index` is the library index (a value is "half-typed" when it is the start
 * of a value the library has). Call it with the LATEST state (a functional
 * `setState(prev => …)`): the screen's own copy can be one key behind while
 * the phone renders a big library (walkthrough H2).
 */
export function typeSearch(state: LibraryState, text: string, getCtx: () => SearchCtx, index: LibraryIndex): LibraryState {
  if (shouldCommitOnSpace(text)) {
    // parseForList leaves every half-typed token out of the query and keeps it in `rest`.
    const parsed = parseForList(text, getCtx, index);
    if (parsedChips(parsed)) return commitSearch(state, parsed, true);
  }
  return withText(state, text);
}

/**
 * Return in the search box (walkthrough H2). `typed` is the text OF THE
 * EVENT (`nativeEvent.text`) — what the keyboard really holds — never the
 * screen state's text or the debounced list text. When the phone is busy,
 * the last keys can still be on their way to the state: with the state's
 * text, `tag:algo` + Return made the chip "Tag: alg", and
 * `is:flagged` + Return stayed text.
 *
 *   submitSearch({ …, text: 'tag:alg' }, 'tag:algo', ctx)   // chip Tag: algo, box ''
 *   submitSearch(state, 'haus', ctx)                               // no chip: the box is 'haus'
 *
 * Every token of `typed` becomes a chip (Return is an explicit "use this"),
 * also one the list does not apply yet (pendingTokenStart).
 */
export function submitSearch(state: LibraryState, typed: string, getCtx: () => SearchCtx): LibraryState {
  const parsed = parseLive(typed, getCtx);
  if (!parsedChips(parsed)) return withText(state, typed);
  return commitSearch(state, parsed);
}

/** The folded values of every field group of the library (for "is this value complete?"). Cached per index. */
const fieldValueCache = new WeakMap<LibraryIndex, Map<string, Set<string>>>();

function fieldValuesOf(index: LibraryIndex): Map<string, Set<string>> {
  const hit = fieldValueCache.get(index);
  if (hit) return hit;
  const out = new Map<string, Set<string>>();
  for (const key of index.fieldSpecs.keys()) out.set(key, new Set());
  for (const note of index.noteById.values()) {
    for (const [key, values] of index.facetValues(note)) {
      const set = out.get(key);
      if (set) for (const v of values) set.add(v);
    }
  }
  fieldValueCache.set(index, out);
  return out;
}

/** The `is:` words searchParse knows (folded, without spaces, '_' or '-'). */
const IS_WORDS: readonly string[] = [
  'new', 'notstarted', 'learning', 'review', 'mastered', 'known', 'due', 'duetoday',
  'fav', 'favorite', 'flagged', 'suspended', 'buried', 'paused', 'hard', 'young', 'recent', 'leech',
];

/** Where the last token of the text starts: after the last space that is not inside "quotes". */
function lastTokenStart(text: string): number {
  let start = 0;
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && /\s/.test(ch)) start = i + 1;
  }
  return start;
}

/** The key of a key:value token, folded, with its '-' ('-is', 'level'); null when it is no token. */
function tokenKeyOf(token: string): string | null {
  const m = /^(-?[^\s:"]+):/.exec(token);
  return m ? foldText(m[1]) : null;
}

/** Folded, trimmed, white space collapsed (the parser's foldWord). */
function foldWord(s: string): string {
  return foldText(s).replace(/\s+/g, ' ').trim();
}

/** "Is `value` still on its way to one of `known`?": not one of them, but the start of one. */
function stillTyping(value: string, known: Iterable<string>): boolean {
  let prefix = false;
  for (const k of known) {
    if (k === value) return false;
    if (!prefix && k.startsWith(value)) prefix = true;
  }
  return prefix;
}

/** The tokens of the box: where each starts and ends. White space outside "quotes" splits them (like lastTokenStart). */
function boxTokens(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = -1;
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const space = !inQuote && /\s/.test(ch);
    if (ch === '"') inQuote = !inQuote;
    if (space) {
      if (start !== -1) out.push({ start, end: i });
      start = -1;
    } else if (start === -1) {
      start = i;
    }
  }
  if (start !== -1) out.push({ start, end: text.length });
  return out;
}

/**
 * True when ONE token of the box (`raw`, no space around it) is HALF-typed —
 * the rules of pendingTokenStart:
 *   - it is `key:` with no value yet, or `key:"…` with the quote still open;
 *   - its value is not a value the library has, but the START of one.
 */
function isHalfToken(raw: string, sctx: SearchCtx, index: LibraryIndex): boolean {
  const m = /^-?([^\s:"]+):(.*)$/s.exec(raw);
  if (!m) return false;
  const key = foldText(m[1]);
  let value = m[2];
  if (value.startsWith('"')) {
    if (!quotesClosed(value)) return true;
    value = value.slice(1, -1);
  }
  const folded = foldWord(value);
  if (folded === '') return true;
  switch (key) {
    case 'is':
      return stillTyping(folded.replace(/[\s_-]/g, ''), IS_WORDS);
    case 'deck':
    case 'dir':
      return false;
    case 'tag':
      return !!sctx.tags && stillTyping(foldTag(value).replace(/ /g, '_'), sctx.tags);
    case 'section': {
      const path = foldPath(value);
      const paths = new Set<string>();
      for (const set of sctx.sectionsByDeck.values()) for (const p of set) paths.add(p);
      return stillTyping(path, paths);
    }
    default: {
      // The parser's own rule finds the field (also by the name its chip shows: `word_type:`).
      const field = fieldKeyFor(key, sctx);
      if (field === null) return false;
      return stillTyping(folded, fieldValuesOf(index).get(field) ?? []);
    }
  }
}

/**
 * Where the HALF-TYPED token at the end of the box starts, or null (spec
 * §4.2, walkthrough M9). While the learner types `level:b1`, the box holds
 * `level:`, then `level:b` — tokens that are not finished. The list must not
 * show their result ("0 cards" for Level "b", "Tag: alg"): it keeps the
 * result of the text BEFORE the token until the token is complete.
 *
 * The last token is half-typed when:
 *   - it is `key:` with no value yet, or `key:"…` with the quote still open;
 *   - its value is not a value the library has, but the START of one:
 *     `level:b` (B1, B2), `tag:alg` (algo), `is:flag` (flagged),
 *     `section:ver` (Verbs).
 * A value that is complete (`level:b1`), or that starts nothing in the
 * library (`level:x`, which then honestly finds 0 cards with a hint), is not
 * half-typed. `deck:ger` is complete: a deck is found by the start of its name.
 *
 * A space after the token does NOT finish it (wave 5c): `level:b ` is still
 * half-typed. Before, the space made the chip "Level: b" with 0 cards; now
 * the token stays in the box, and the list keeps its result.
 *
 *   pendingTokenStart('haus level:b', sctx, index)    // 5   (the list shows "haus")
 *   pendingTokenStart('haus level:b1', sctx, index)   // null
 *   pendingTokenStart('level:b ', sctx, index)        // 0   (a space does not finish it)
 */
export function pendingTokenStart(text: string, sctx: SearchCtx, index: LibraryIndex): number | null {
  const box = text.trimEnd();
  if (box === '') return null;
  const start = lastTokenStart(box);
  return isHalfToken(box.slice(start), sctx, index) ? start : null;
}

/**
 * The box split into what the list may apply and the HALF-typed tokens
 * (isHalfToken), at ANY place in the box (wave 5c): after `level:b` + space
 * the learner can type on (`level:b haus`), and the list must still not show
 * a count for Level "b". `complete` is the box without the half tokens (the
 * same string when there are none); `half` holds them as typed, in order.
 *
 *   splitHalfTokens('level:b haus', sctx, index)   // { complete: 'haus', half: ['level:b'] }
 *   splitHalfTokens('haus level:b1', sctx, index)  // { complete: 'haus level:b1', half: [] }
 */
export function splitHalfTokens(text: string, sctx: SearchCtx, index: LibraryIndex): { complete: string; half: string[] } {
  const kept: string[] = [];
  const half: string[] = [];
  for (const { start, end } of boxTokens(text)) {
    const raw = text.slice(start, end);
    (isHalfToken(raw, sctx, index) ? half : kept).push(raw);
  }
  return half.length === 0 ? { complete: text, half } : { complete: kept.join(' '), half };
}

/**
 * True when the box's half-typed last token (it starts at `cut`) is an EDIT
 * of the complete token the list shows now (`shown`): `shown` is the box up
 * to `cut`, followed by ONE complete token with the same key.
 *
 *   box 'level:b',      shown 'level:b1'        → true  (backspace in "b1")
 *   box 'haus level:b', shown 'haus level:b1'   → true
 *   box 'haus level:b', shown 'haus'            → false (a NEW token is typed)
 *   box 'level:',       shown 'level'           → false (a word, not a token)
 *   box 'tag:gr',       shown 'level:b1'        → false (another key)
 */
function editsShownToken(
  text: string,
  cut: number,
  shown: string | null,
  sctx: SearchCtx,
  index: LibraryIndex,
): shown is string {
  if (shown === null || shown.length <= cut || shown.slice(0, cut) !== text.slice(0, cut)) return false;
  // ONE token from `cut` to the end (no space after it), complete (no open quote, not half-typed).
  if (lastTokenStart(shown) !== cut || pendingTokenStart(shown, sctx, index) !== null) return false;
  const key = tokenKeyOf(shown.slice(cut));
  return key !== null && key === tokenKeyOf(text.slice(cut));
}

/**
 * The text the LIST applies for the box text `text` (walkthrough M9: no
 * count is ever shown for a half-typed token; the list keeps its previous
 * result until the token is complete). `shown` is the text the list shows
 * now (null: nothing to keep).
 *   - No half-typed token (pendingTokenStart, splitHalfTokens): the box itself.
 *   - The learner EDITS a complete token (editsShownToken: `level:b1`,
 *     backspace, `level:b`): the list keeps `shown`. So its count stays 3
 *     until `level:b2` is complete, instead of 3 → 6 → n (review round 2).
 *   - The learner types a NEW token (`haus` → `haus level:b`): the text
 *     before it ('haus'), the result the list had before the token began.
 *   - A half token that a space did not finish (`level:b haus`, wave 5c):
 *     the box without it ('haus').
 * The screen's debounced list text follows this, so the list text never
 * holds a half-typed token; the handlers that let the list catch up with
 * the box ("Select all", "+ Filter") use it too.
 *
 *   listTextFor('level:b', 'level:b1', ctx, index)    // 'level:b1' (kept)
 *   listTextFor('haus level:b', 'haus', ctx, index)   // 'haus'
 *   listTextFor('level:b2', 'level:b1', ctx, index)   // 'level:b2' (complete)
 *   listTextFor('level:b ', 'haus', ctx, index)       // ''         (still half-typed)
 */
export function listTextFor(text: string, shown: string | null, getCtx: () => SearchCtx, index: LibraryIndex): string {
  if (!hasToken(text)) return text;
  const sctx = getCtx();
  const cut = pendingTokenStart(text, sctx, index);
  if (cut !== null && editsShownToken(text, cut, shown, sctx, index)) return shown;
  return splitHalfTokens(text, sctx, index).complete;
}

/**
 * The search box → the query the LIST shows (walkthrough M9): like
 * parseLive, but a half-typed token (pendingTokenStart, splitHalfTokens —
 * at the end or, after a space, anywhere) is left out until it is complete,
 * so no count is ever shown for `level:b`. Instead the query is the one of
 * listTextFor: `shown` (the text the list shows now) while the learner edits
 * a complete token, else the box without the half tokens. Its `rest` is
 * what the box keeps when the complete tokens become chips (removeBestChip,
 * and typeSearch on a space): the box without those tokens, so the free
 * words AND the half tokens, in the order the learner typed them (the box's
 * own parse, with the half tokens held as text: searchParse `hold`). Before
 * (review round 1), the half tokens were moved to the end: 'level:b haus
 * is:due ' became 'haus level:b '.
 *
 *   parseForList('haus level:b', ctx, index).query               // { text: 'haus' }
 *   parseForList('haus level:b', ctx, index).rest                // 'haus level:b'
 *   parseForList('level:b haus is:due', ctx, index).rest         // 'level:b haus' (is:due becomes a chip)
 *   parseForList('level:b', ctx, index, 'level:b1').query        // { fields: { level: ['b1'] } } (kept)
 *   parseForList('level:b', ctx, index, 'level:b1').rest         // 'level:b'
 */
export function parseForList(
  text: string,
  getCtx: () => SearchCtx,
  index: LibraryIndex,
  shown: string | null = null,
): ParsedSearch {
  if (!hasToken(text)) return parseLive(text, getCtx);
  const sctx = getCtx();
  const { complete, half } = splitHalfTokens(text, sctx, index);
  if (half.length === 0) return parseLive(text, getCtx);
  const cut = pendingTokenStart(text, sctx, index);
  const head = parseLive(cut !== null && editsShownToken(text, cut, shown, sctx, index) ? shown : complete, getCtx);
  // The box without its chips: the same parse of the box, with every half token held as text in its place.
  const { rest } = parseSearch(text, sctx, (raw) => isHalfToken(raw, sctx, index));
  return { ...head, rest };
}

/**
 * The query of the rows the learner SEES once the list has caught up with
 * the box: the chips AND the box as typed, without a half-typed last token
 * (parseForList; `shown` = the text the list shows now, kept while the
 * learner edits a complete token). "Select all" stores this, so the
 * selection is always the list's own query (selectsAllShown); the
 * FacetSheet starts from it too (facetStartQuery). The screen lets the list
 * catch up with listTextFor(state.text, shown) at the same time.
 */
export function shownQueryNow(
  state: LibraryState,
  getCtx: () => SearchCtx,
  index: LibraryIndex,
  shown: string | null = null,
): Query {
  return effectiveQuery(state.chips, parseForList(state.text, getCtx, index, shown).query);
}

/**
 * The query the FacetSheet starts from: EXACTLY the query of the list the
 * learner sees once it has caught up with the box (shownQueryNow): the chips
 * AND the box as it is now, without a half-typed last token.
 *
 *   - The box AS IT IS NOW, not the list's 150 ms debounced text: words typed
 *     just before "+ Filter" must be in the sheet's draft, or "Show" would
 *     take them out of the box (withQuery gives the box the draft's text).
 *   - WITHOUT a half-typed token (walkthrough M9, parseForList): with
 *     `level:b` in the box, the list shows the cards of the text before it.
 *     The sheet must start from that same query, or its footer says "Show 0
 *     cards" (Level "b") over a list of 100 cards, and a tap on B1 makes the
 *     chip "Level: b, B1".
 *
 *   - While the learner edits a complete token, the list keeps its result
 *     (`shown`, listTextFor): the sheet starts from that kept query too.
 *
 *   box 'haus' (typed 50 ms ago)    → { text: 'haus' }   (the debounced list still has {})
 *   box 'level:b' (half-typed)      → {}                  (the list's query too)
 *   box 'level:b', shown 'level:b1' → { fields: { level: ['b1'] } }   (kept, like the list)
 */
export function facetStartQuery(
  state: LibraryState,
  getCtx: () => SearchCtx,
  index: LibraryIndex,
  shown: string | null = null,
): Query {
  return shownQueryNow(state, getCtx, index, shown);
}

/**
 * The FacetSheet closed with `draft` ("Show {n} cards", the scrim, Android
 * back): the Library's state after it, or null when nothing changes.
 *
 * The draft is compared with the Library AS IT IS NOW (facetStartQuery of
 * the state now), never with the query the sheet opened with. WHY: the
 * sheet's "Clear all" clears the Library at once while the sheet stays open.
 * If the learner then picks the same filters again, the draft equals the
 * query the sheet opened with — but not the (empty) Library. Compared with
 * the old query, "Show 3 cards" applied nothing and the list showed every card.
 *
 *   Library { Level: B1 } → sheet "Clear all" → tap B1 → "Show 3 cards"
 *   facetsDone(cleared state, { Level: B1 }, ctx, index) → the state with the chip Level: B1
 *
 * A half-typed token in the box (`level:b`) was never part of the sheet (the
 * list leaves it out, facetStartQuery). It STAYS in the box as typed: the
 * learner's typing is never lost, and the list still leaves it out, so the
 * list shows exactly the "Show {n} cards" number. When the sheet did not
 * change the free words, the box keeps them and the half tokens in the
 * order they were typed (parseForList `rest`; review round 1); when it did
 * (for example the sheet's "Clear all"), the draft's words come first and
 * the half tokens after them.
 * `shown` is the text the list showed while the sheet was open (the result
 * of a kept token is in the draft, so it becomes chips). After a change the
 * screen sets the list text to listTextFor(next.text, null): the text before
 * the half token, nothing kept — the draft has it all.
 *
 *   box 'level:b', tap B1, "Show 3 cards"         → chips { Level: B1 }, box 'level:b', 3 rows
 *   box 'level:b bahnhof', tap Flagged, "Show …"  → chips { Flagged }, box 'level:b bahnhof'
 */
export function facetsDone(
  state: LibraryState,
  draft: Query,
  getCtx: () => SearchCtx,
  index: LibraryIndex,
  shown: string | null = null,
): LibraryState | null {
  const start = facetStartQuery(state, getCtx, index, shown);
  if (sameQuery(draft, start)) return null;
  const { complete, half } = hasToken(state.text)
    ? splitHalfTokens(state.text, getCtx(), index)
    : { complete: state.text, half: [] as string[] };
  if (half.length === 0) return withQuery(state, draft);
  // The same free words as the sheet started with: the box keeps its words and
  // half tokens in their typed order (the parse's `rest` = the box without its chips).
  if (splitText(draft).text === splitText(start).text) {
    return { ...withQuery(state, draft), text: parseForList(state.text, getCtx, index, shown).rest };
  }
  // New words from the sheet: the box without the half tokens gets them (withQuery), then the tokens come back.
  const next = withQuery({ ...state, text: complete }, draft);
  const tail = half.join(' ');
  return { ...next, text: next.text === '' ? tail : `${next.text} ${tail}` };
}

/* ============================================================ bulk toggles */

/** The three markers select mode toggles (they never change the schedule). */
export type BulkFlag = 'fav' | 'flagged' | 'suspended';

export interface BulkToggle {
  key: BulkFlag;
  /** The button text = the action: "Unfavorite" when every card is a favorite. */
  label: string;
  icon: string;
  /** What setFlags gets. */
  patch: Partial<Record<BulkFlag, boolean>>;
  /** Every selected card has the marker (the button is drawn active). */
  allOn: boolean;
}

const TOGGLE_TEXT: Readonly<Record<BulkFlag, { off: string; on: string; iconOff: string; iconOn: string }>> = {
  fav: { off: 'Favorite', on: 'Unfavorite', iconOff: 'heart-outline', iconOn: 'heart' },
  flagged: { off: 'Flag', on: 'Unflag', iconOff: 'flag-outline', iconOn: 'flag' },
  suspended: { off: 'Suspend', on: 'Unsuspend', iconOff: 'pause-circle-outline', iconOn: 'pause-circle' },
};

/**
 * The REAL toggles of the bulk bar (spec §7 #19, §8.3): when every selected
 * card has the marker, the button takes it away ("Unfavorite"); when some or
 * none have it, the button sets it on every card ("Favorite").
 */
export function bulkToggles(cards: readonly Pick<Card, BulkFlag>[]): BulkToggle[] {
  return (['fav', 'flagged', 'suspended'] as const).map((key) => {
    const allOn = cards.length > 0 && cards.every((card) => card[key] === true);
    const text = TOGGLE_TEXT[key];
    const patch: Partial<Record<BulkFlag, boolean>> = {};
    patch[key] = !allOn;
    return { key, label: allOn ? text.on : text.off, icon: allOn ? text.iconOn : text.iconOff, patch, allOn };
  });
}

/**
 * The snackbar text of a toggle when the undo log has no label for it (the
 * same words as the store's own label): "12 cards added to Favorites".
 */
export function toggleSnack(toggle: Pick<BulkToggle, 'key' | 'allOn'>, n: number): string {
  const verbs: Readonly<Record<BulkFlag, [string, string]>> = {
    fav: ['added to Favorites', 'removed from Favorites'],
    flagged: ['flagged', 'unflagged'],
    suspended: ['suspended', 'unsuspended'],
  };
  return `${plural(n, 'card')} ${verbs[toggle.key][toggle.allOn ? 1 : 0]}`;
}

/** What the "More" sheet can do with a selection: how many cards each action would change. */
export interface SelectionSummary {
  total: number;
  /** Not started or Known: "Learn these" puts them in the queue. */
  learnable: number;
  /** Not Known yet: "Mark as known". */
  knowable: number;
  /** Never studied and not Not started yet: "Move back to Not started" changes them. */
  toNotStarted: number;
  /** Studied cards: "Move back to Not started" skips them. */
  studied: number;
  /** Cards "Reset progress…" changes (studied, Known or Not started). */
  resettable: number;
  /** Cards with a schedule (Learning, Review, Mastered): "Reschedule…". */
  reschedulable: number;
}

export function selectionSummary(cards: readonly Card[]): SelectionSummary {
  const out: SelectionSummary = {
    total: cards.length,
    learnable: 0,
    knowable: 0,
    toNotStarted: 0,
    studied: 0,
    resettable: 0,
    reschedulable: 0,
  };
  for (const card of cards) {
    const key = life(card);
    const known = card.knownAt != null;
    if (key === 'notStarted' || known) out.learnable += 1;
    if (!known) out.knowable += 1;
    if (card.reps > 0) out.studied += 1;
    else if (card.newState !== 'notStarted' || known) out.toNotStarted += 1;
    if (card.reps > 0 || known || card.newState === 'notStarted') out.resettable += 1;
    if (key === 'learning' || key === 'review' || key === 'mastered') out.reschedulable += 1;
  }
  return out;
}

/** The note after "Move back to Not started" skipped studied cards. */
export function skippedNote(skipped: number): string {
  if (skipped <= 0) return '';
  return skipped === 1
    ? '1 studied card was skipped.'
    : `${skipped.toLocaleString('en-US')} studied cards were skipped.`;
}

/** A tag and how many cards have it. */
export interface TagCountRow {
  tag: string;
  count: number;
}

/** Most first, then A–Z. */
function byCountThenTag(a: TagCountRow, b: TagCountRow): number {
  return b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0);
}

/** Count one note's tags into `counts` (the same tag in another case is one tag). */
function countTags(counts: Map<string, TagCountRow>, tags: readonly string[]): void {
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag === '') continue;
    const key = tag.toLowerCase();
    const row = counts.get(key);
    if (row) row.count += 1;
    else counts.set(key, { tag, count: 1 });
  }
}

/**
 * The tags of these cards ("Remove tag…"), each with how many of the cards
 * have it. Tags belong to the item, so every direction of an item counts.
 */
export function tagCountsOf(cards: readonly Card[], index: LibraryIndex): TagCountRow[] {
  const counts = new Map<string, TagCountRow>();
  for (const card of cards) {
    const note = index.noteById.get(card.noteId);
    if (note) countTags(counts, note.tags);
  }
  return [...counts.values()].sort(byCountThenTag);
}

const libraryTagsCache = new WeakMap<LibraryIndex, TagCountRow[]>();

/** Every tag of the library, with how many items have it (the suggestions of "Add tag…"). Cached per index. */
export function libraryTags(index: LibraryIndex): TagCountRow[] {
  const hit = libraryTagsCache.get(index);
  if (hit) return hit;
  const counts = new Map<string, TagCountRow>();
  for (const note of index.noteById.values()) countTags(counts, note.tags);
  const out = [...counts.values()].sort(byCountThenTag);
  libraryTagsCache.set(index, out);
  return out;
}

/**
 * The snackbar of a bulk change (spec §8.3: "{n} cards {verb} · Undo"): the
 * edit's own label from the undo log ("12 cards suspended"), and whether
 * Undo can take it back. An edit that changed nothing (or one too large for
 * the log) is not in the log: then `fallback` is shown, without Undo.
 */
export function editSnack(
  manualLog: readonly { id: string; label: string }[] | undefined,
  editId: string,
  fallback: string,
): { text: string; undoable: boolean } {
  const edit = editId === '' ? undefined : (manualLog ?? []).find((e) => e.id === editId);
  return edit ? { text: edit.label, undoable: true } : { text: fallback, undoable: false };
}

/** The unique item (note) ids of some cards, in first order. */
export function noteIdsOf(cards: readonly Pick<Card, 'noteId'>[]): Id[] {
  return [...new Set(cards.map((card) => card.noteId))];
}

/* ============================================================ smart empty */

/** The chip of a query group (each flag is its own group; they all belong to one chip). */
export function chipOfGroup(id: GroupId): ChipId {
  if (id.startsWith('flag:')) return 'flags';
  if (id.startsWith('notFlag:')) return 'notFlags';
  return id as ChipId;
}

export interface ChipRemoval {
  chipId: ChipId;
  /** The chip's label ("Suspended"): the button says "Remove Suspended". */
  label: string;
  /** How many cards the list shows without that chip. */
  count: number;
}

/**
 * The smart empty state's button (spec §8.3): the ONE chip whose removal
 * gives the most results. One pass, like the facet counts (§4.3): a card
 * that fails exactly one chip would be shown without that chip; a card that
 * fails two or more chips is no help. Ties: the first chip in chip order.
 * null when no single chip gives a result.
 *
 * The button's label is the chip's label in the Library (libraryChips, the
 * FacetSheet's group names, walkthrough M8): the SAME words as the line "No
 * cards match …" above it. `scope` is the chips' scope (chipScopeFor);
 * by default it is built from `pool` (the whole library, like the screen's).
 *
 *   No cards match Tags (German Verbs): irregular + Suspended.   [ Remove Tags (German Verbs): irregular ]
 */
export function bestChipToRemove(
  pool: readonly Card[],
  query: Query,
  ctx: MatchCtx,
  scope: ChipScope | undefined = chipScopeFor(pool, ctx, query),
): ChipRemoval | null {
  const groups = compileGroups(query, ctx);
  if (groups.length === 0) return null;
  const counts = new Map<ChipId, number>();
  for (const card of pool) {
    let failed: ChipId | null = null;
    let many = false;
    for (const g of groups) {
      if (g.test(card)) continue;
      const chip = chipOfGroup(g.id);
      if (failed === null) failed = chip;
      else if (failed !== chip) {
        many = true;
        break;
      }
    }
    if (!many && failed !== null) counts.set(failed, (counts.get(failed) ?? 0) + 1);
  }
  let best: ChipRemoval | null = null;
  for (const chip of libraryChips(query, ctx, scope)) {
    const count = counts.get(chip.id) ?? 0;
    if (count > 0 && (best === null || count > best.count)) best = { chipId: chip.id, label: chip.label, count };
  }
  return best;
}

/* =============================================================== chips */

/**
 * The chips of a query as the Library shows them, with the SAME group names
 * as the FacetSheet (walkthrough M8):
 *   - a field chip uses fieldGroupLabel with its card types: "Tags (German
 *     Verbs): irregular", the label a card type chose ("Verb type: …"), or
 *     the readable field name ("Word Type: noun");
 *   - the Direction chip uses the group's labels (facets directionLabels):
 *     "Direction: Back → Front" when card types with different template
 *     names share the directions.
 * Both rules live in searchParse chipsOf (wave 5c), so the triage title
 * names a chip like the Library does; this function is the Library's name
 * for it. `scope` is the parser's view of the library (searchCtxFor), the
 * scope of the FacetSheet; use chipScopeFor to get it, so every place names
 * a chip the same way.
 */
export function libraryChips(q: Query, ctx: MatchCtx, scope?: ChipScope): ChipModel[] {
  return chipsOf(q, ctx, scope);
}

/**
 * The scope libraryChips needs for the chips of `q` (walkthrough M8): only a
 * Direction chip needs one — its label comes from the directions of the
 * whole library (`cards`), like the FacetSheet's Direction group. For every
 * other query it is undefined, so the parser's view (one pass over the
 * cards, cached) is not built for nothing. The chip row, the "No cards
 * match …" line and the smart empty state's "Remove …" button all use it,
 * so the three always name a chip the same way.
 *
 *   chipScopeFor(cards, ctx, { directions: [1] })   // searchCtxFor(cards, ctx)
 *   chipScopeFor(cards, ctx, { decks: ['d1'] })     // undefined
 */
export function chipScopeFor(cards: readonly Card[], ctx: MatchCtx, q: Query): ChipScope | undefined {
  return q.directions ? searchCtxFor(cards, ctx) : undefined;
}

/* ===================================================== FacetSheet numbers */

/**
 * Above this many cards the FacetSheet counts AFTER it opens, and after each
 * tap, with "Counting…" until the numbers are there (spec §4.3 fallback;
 * walkthrough M9: 878 ms for 16,260 cards in a debug build, over the 80 ms
 * budget). A smaller library counts at once, with no placeholder flash.
 */
export const FACET_SYNC_MAX_CARDS = 2000;

/** True when the FacetSheet's counts wait one tick (see FACET_SYNC_MAX_CARDS). */
export function facetCountsDeferred(cardCount: number): boolean {
  return cardCount > FACET_SYNC_MAX_CARDS;
}

/**
 * The facets as the sheet DRAWS them while their counts belong to an older
 * draft (a tap in a big library, before the recount): every value is drawn
 * selected or not by the draft NOW (facets isFacetValueSelected), so the
 * tapped chip turns on at once. The counts stay the older ones; the sheet's
 * footer says "Counting…" meanwhile.
 */
export function withDraftSelection(facets: readonly Facet[], draft: Query): Facet[] {
  const mark = (key: FacetKey, values: readonly FacetValue[]): FacetValue[] =>
    values.map((v) => ({
      ...v,
      selected: isFacetValueSelected(draft, key, v.value),
      ...(v.children ? { children: mark(key, v.children) } : {}),
    }));
  return facets.map((facet) => ({ ...facet, values: mark(facet.key, facet.values) }));
}

/* ------------------------------------------------------- FacetSheet counts */

/**
 * "Show {n} cards" of the FacetSheet, read from the facet counts: every card
 * has exactly ONE status, so the Status group splits the results. With no
 * status chosen, its counts add up to the results; with some chosen, the
 * chosen ones do (the others are the "if you add this" counts). null = no
 * counts yet ("Counting…").
 */
export function resultCountFromFacets(facets: readonly Facet[]): number | null {
  const status = facets.find((f) => f.key === 'life');
  if (!status) return null;
  const chosen = status.values.some((v) => v.selected);
  let n = 0;
  for (const v of status.values) if (!chosen || v.selected) n += v.count;
  return n;
}

/** "B1 (1,530)": a facet value with its count. */
export function valueText(label: string, count: number): string {
  return `${label} (${count.toLocaleString('en-US')})`;
}

/**
 * A label short enough for one chip, cut at a WORD boundary with "…" (spec
 * device finding: long tag labels wrap at word boundaries or ellipsize, never
 * break in the middle of a word). A single word longer than `max` is cut with "…".
 *
 *   shortLabel('Morning Review With Two Extra Steps', 24) → 'Morning Review With Two…'
 */
export function shortLabel(label: string, max = 28): string {
  const chars = Array.from(label);
  if (chars.length <= max) return label;
  const head = chars.slice(0, max).join('');
  const space = head.lastIndexOf(' ');
  const cut = space >= Math.floor(max / 2) ? head.slice(0, space) : chars.slice(0, max - 1).join('');
  return `${cut.replace(/[\s›,;:·-]+$/, '')}…`;
}

/** Which value nodes of a tree group match a search ("Search tags"), with their path for the label. */
export interface TreeHit {
  value: string;
  /** "Algo › Core Patterns" (the node and its parents). */
  path: string;
  count: number;
  selected: boolean;
}

/** Every node of a tree facet whose label holds `search` (folded words), depth first. */
export function searchTree(
  roots: readonly { value: string; label: string; count: number; selected: boolean; children?: unknown[] }[],
  search: string,
  fold: (s: string) => string,
): TreeHit[] {
  const needle = fold(search).trim();
  const out: TreeHit[] = [];
  type Node = { value: string; label: string; count: number; selected: boolean; children?: unknown[] };
  const walk = (nodes: readonly Node[], parent: string) => {
    for (const node of nodes) {
      const path = parent ? `${parent} › ${node.label}` : node.label;
      if (needle === '' || fold(node.label).includes(needle)) {
        out.push({ value: node.value, path, count: node.count, selected: node.selected });
      }
      if (node.children) walk(node.children as Node[], path);
    }
  };
  walk(roots, '');
  return out;
}

/** The groups of the FacetSheet as the sheet draws them: the three toggles join "Markers". */
export interface SheetGroup {
  key: FacetKey;
  label: string;
  facets: Facet[];
}

/**
 * The FacetSheet groups, in the spec's order (facets.ts gives it): Status,
 * Due, Markers (+ Hard / Recent / Leech as more values of the same block),
 * Deck, Section, fields, Tags, Card type, Direction. A group with nothing to
 * show (no value with cards and no info line) is left out.
 */
export function sheetGroups(facets: readonly Facet[]): SheetGroup[] {
  const out: SheetGroup[] = [];
  let markers: SheetGroup | null = null;
  for (const facet of facets) {
    const empty = facet.values.length === 0 && !facet.info;
    if (facet.key === 'hard' || facet.key === 'young' || facet.key === 'leech') {
      if (empty) continue;
      if (!markers) {
        markers = { key: 'flags', label: 'Markers', facets: [] };
        out.push(markers);
      }
      markers.facets.push(facet);
      continue;
    }
    if (facet.key === 'flags') {
      markers = { key: 'flags', label: facet.label, facets: empty ? [] : [facet] };
      out.push(markers);
      continue;
    }
    if (empty) continue;
    out.push({ key: facet.key, label: facet.label, facets: [facet] });
  }
  return out.filter((g) => g.facets.length > 0);
}

/** The block a tapped chip scrolls to (a toggle chip opens the Markers block). */
export function sheetGroupKey(facet: FacetKey | null | undefined): FacetKey | null {
  if (!facet) return null;
  return facet === 'hard' || facet === 'young' || facet === 'leech' ? 'flags' : facet;
}

/* ================================================================== rows */

/**
 * The status of a row: the word, and when it comes back ("Review · next 4d").
 * The CardSheet says the same number in words ("next in 4 days"): one rule,
 * src/utils/dateFormatting.ts (wave 5i).
 */
export function rowStatus(card: Card, now: number): { key: LifeKey; text: string } {
  const key = life(card);
  const word = LIFE_LABELS[key];
  if (key !== 'learning' && key !== 'review' && key !== 'mastered') return { key, text: word };
  return { key, text: `${word} · ${nextReviewShort(card.due, now)}` };
}

/** One ordinal filter group of the library (Level), for the row badge and the sort menu. */
export interface OrdinalField {
  /** Folded field name: the key of Query.fields. */
  key: string;
  label: string;
  kind: OrdinalKind;
}

const ordinalCache = new WeakMap<LibraryIndex, OrdinalField[]>();

/**
 * The field groups whose values are ordinal (CEFR levels, numbers …, ordinal.ts),
 * by label. Built once per library index (a rating does not rebuild it).
 */
export function ordinalFields(index: LibraryIndex): OrdinalField[] {
  const hit = ordinalCache.get(index);
  if (hit) return hit;
  const labels = new Map<string, Set<string>>();
  for (const key of index.fieldSpecs.keys()) labels.set(key, new Set());
  for (const note of index.noteById.values()) {
    for (const [key, values] of index.facetValues(note)) {
      const set = labels.get(key);
      if (set) for (const v of values) set.add(index.valueLabel(key, v));
    }
  }
  const out: OrdinalField[] = [];
  for (const [key, set] of labels) {
    if (set.size < 2) continue;
    const ordinal = detectOrdinal([...set]);
    const spec = index.fieldSpecs.get(key);
    // The same label as the FacetSheet group (a label a card type chose wins).
    if (ordinal && spec) out.push({ key, label: fieldGroupLabel(spec.label, { spec, typeById: index.typeById }), kind: ordinal.kind });
  }
  out.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  ordinalCache.set(index, out);
  return out;
}

/** The right badge of a row: the card's value of the first ordinal group ("B1"), or null. */
export function rowBadge(
  card: Pick<Card, 'noteId'>,
  index: LibraryIndex,
  fields: readonly OrdinalField[],
): { value: string; label: string; kind: OrdinalKind } | null {
  if (fields.length === 0) return null;
  const note = index.noteById.get(card.noteId);
  if (!note) return null;
  const values = index.facetValues(note);
  for (const field of fields) {
    const v = values.get(field.key)?.[0];
    if (v !== undefined) return { value: index.valueLabel(field.key, v), label: field.label, kind: field.kind };
  }
  return null;
}

/** No Direction group: every row uses its card type's own label. */
const NO_GROUP = (): DirectionGroupNames | null => null;

/**
 * The direction label of a card's row (review round 2: rows and the
 * Direction filter must not name one direction two ways):
 *   - its LANGUAGES when its card type (in its deck) gives them: "German →
 *     English" — the clearest text, whatever the group says;
 *   - else, when the Direction group names the directions by ROLE (`group`,
 *     libraryDirectionNames: card types with different template names share
 *     them), the group's label: "Back → Front" — so after the chip
 *     "Direction: Back → Front" the rows say "Back → Front" too, not
 *     "Reverse" and "EN-DE";
 *   - else its card type's own template name ("DE-EN"), which IS the group's
 *     label, or a part of it.
 * `group` is read only when a card has no languages (it costs one pass over
 * the library, cached). Without it: the card type's own label. Cached per
 * (card type, deck, ord), so 16,000 rows cost a few Map reads.
 */
export function directionLabeler(
  index: LibraryIndex,
  decks: ReadonlyMap<Id, Deck>,
  group: () => DirectionGroupNames | null = NO_GROUP,
): (card: Card) => string {
  const cache = new Map<string, string>();
  let byRole: ReadonlyMap<number, string> | null | undefined;
  const roleLabels = () => {
    if (byRole === undefined) {
      const names = group();
      byRole = names && names.byRole ? names.labels : null;
    }
    return byRole;
  };
  return (card) => {
    const typeId = index.noteById.get(card.noteId)?.typeId;
    if (typeId === undefined) return `Direction ${card.ord + 1}`;
    const key = `${typeId}\u001f${card.deckId}\u001f${card.ord}`;
    let label = cache.get(key);
    if (label === undefined) {
      const info = directionInfo(card.ord, [typeId], index.typeById, {
        decks,
        decksByType: new Map([[typeId, [card.deckId]]]),
      });
      label = info.kind === 'lang' ? info.label : (roleLabels()?.get(card.ord) ?? info.label);
      cache.set(key, label);
    }
    return label;
  };
}

/** Per parser view (its directionSources): the names of the library's Direction group. */
const directionNamesCache = new WeakMap<object, DirectionGroupNames>();

/**
 * The names of the Direction group of the WHOLE library (spec §4.3,
 * walkthrough M8): the group the FacetSheet shows (its scope is everything)
 * and the Direction chip uses (chipScopeFor). Built from the parser's view
 * (searchCtxFor: one pass over the cards, cached per cards array), and
 * cached per that view.
 */
export function libraryDirectionNames(cards: readonly Card[], ctx: MatchCtx): DirectionGroupNames {
  const sources = searchCtxFor(cards, ctx).directionSources;
  if (!sources) return directionGroupNames(new Map(), ctx.index.typeById, ctx.decks);
  let hit = directionNamesCache.get(sources);
  if (!hit) {
    hit = directionGroupNames(sources, ctx.index.typeById, ctx.decks);
    directionNamesCache.set(sources, hit);
  }
  return hit;
}

/** What the list header needs to know about the shown cards (one pass). */
export interface RowsSummary {
  total: number;
  notStarted: number;
  dueNow: number;
  /** The cards have 2+ directions with different labels: rows show the direction. */
  directions: boolean;
}

export function summarizeRows(rows: readonly Card[], now: number, dirLabel: (card: Card) => string): RowsSummary {
  let notStarted = 0;
  let dueNow = 0;
  const ords = new Set<number>();
  for (const card of rows) {
    if (life(card) === 'notStarted') notStarted += 1;
    if (isDueNow(card, now)) dueNow += 1;
    ords.add(card.ord);
  }
  // Two ords can share one label (the cloze numbers of one template): only
  // DIFFERENT labels make a direction worth showing. dirLabel is cached, and
  // the loop stops at the second label.
  let directions = false;
  if (ords.size >= 2) {
    let firstLabel: string | null = null;
    for (const card of rows) {
      const label = dirLabel(card);
      if (firstLabel === null) firstLabel = label;
      else if (label !== firstLabel) {
        directions = true;
        break;
      }
    }
  }
  return { total: rows.length, notStarted, dueNow, directions };
}

/**
 * The ordinal groups that really split the shown cards (≥ 2 values), for the
 * suggestion chips. Stops scanning as soon as every group is decided.
 */
export function fieldsWithValues(
  rows: readonly Card[],
  index: LibraryIndex,
  fields: readonly OrdinalField[],
): OrdinalField[] {
  if (fields.length === 0) return [];
  const first = new Map<string, string>();
  const decided = new Set<string>();
  for (const card of rows) {
    const note = index.noteById.get(card.noteId);
    if (!note) continue;
    const values = index.facetValues(note);
    for (const field of fields) {
      if (decided.has(field.key)) continue;
      const v = values.get(field.key)?.[0];
      if (v === undefined) continue;
      const seen = first.get(field.key);
      if (seen === undefined) first.set(field.key, v);
      else if (seen !== v) decided.add(field.key);
    }
    if (decided.size === fields.length) break;
  }
  return fields.filter((f) => decided.has(f.key));
}

/** One suggestion chip under the empty search box (spec §8.3). */
export interface Suggestion {
  id: string;
  label: string;
  /** Adds this filter on tap… */
  add?: Query;
  /** …or opens the FacetSheet at this group (a field group needs a value). */
  facet?: FacetKey;
}

/**
 * The suggestion chips: built from the scope's REAL groups ("Not started",
 * "Due now", "Level"), so each one finds cards. At most `max`.
 */
export function suggestionChips(
  summary: RowsSummary,
  chips: Query,
  fields: readonly OrdinalField[],
  max = 4,
): Suggestion[] {
  const out: Suggestion[] = [];
  for (const field of fields) {
    if (chips.fields && Object.prototype.hasOwnProperty.call(chips.fields, field.key)) continue;
    out.push({ id: `field:${field.key}`, label: field.label, facet: `field:${field.key}` });
  }
  if (summary.notStarted > 0 && !chips.life) {
    out.push({ id: 'life', label: LIFE_LABELS.notStarted, add: { life: ['notStarted'] } });
  }
  if (summary.dueNow > 0 && !chips.due) out.push({ id: 'due', label: DUE_LABELS.now, add: { due: 'now' } });
  return out.slice(0, max);
}

/** The height of one row: fixed, so the list can use getItemLayout (spec §8.3). Grows with the font size. */
export function rowHeight(fontScale: number): number {
  const scale = Math.min(Math.max(Number.isFinite(fontScale) ? fontScale : 1, 1), ROW_FONT_CAP);
  return Math.ceil(ROW_PAD * 2 + ROW_TEXT * scale);
}

/** The largest font scale a row grows with (row texts use the same maxFontSizeMultiplier). */
export const ROW_FONT_CAP = 1.5;
/** Top + bottom padding of a row. */
const ROW_PAD = 9;
/** The three text lines of a row at font scale 1 (serif 17.5 + sans 13 + sans 12, with line gaps). */
const ROW_TEXT = 62;

/* ================================================================== sort */

export interface SortOption {
  id: string;
  label: string;
  sort: SortSpec;
}

/** The fixed entries of the sort menu (spec §8.3). */
export const BASE_SORTS: readonly SortOption[] = Object.freeze([
  { id: 'source', label: 'Deck order', sort: { by: 'source' } },
  { id: 'due', label: 'Due date', sort: { by: 'due' } },
  { id: 'az', label: 'A–Z', sort: { by: 'az' } },
  { id: 'newest', label: 'Recently added', sort: { by: 'newest' } },
  { id: 'hardest', label: 'Hardest first', sort: { by: 'hardest' } },
] as SortOption[]);

/** The sort menu: the fixed entries, then one per ordinal filter group (Level). */
export function sortOptions(fields: readonly OrdinalField[]): SortOption[] {
  return [
    ...BASE_SORTS,
    ...fields.map((f) => ({ id: `field:${f.key}`, label: f.label, sort: { by: 'field' as const, field: f.key } })),
  ];
}

/** The id of a sort ('az', 'field:level'). */
export function sortId(sort: SortSpec): string {
  return sort.by === 'field' ? `field:${sort.field ?? ''}` : sort.by;
}

/** The label of the current sort ("Deck order"); an unknown field sort falls back to "Deck order". */
export function sortLabel(sort: SortSpec, options: readonly SortOption[]): string {
  return options.find((o) => o.id === sortId(sort))?.label ?? BASE_SORTS[0].label;
}

/* ============================================================= lists */

/** The "From list" line (spec §4.7). */
export interface ListLine {
  list: ListDef;
  /** "From list 'B1 verbs'". */
  text: string;
  /** The chips differ from the list's saved query. */
  changed: boolean;
  /**
   * "Update list" is offered: a user list (built-in lists are code) whose
   * chips changed, and still has a chip. With every chip removed, the list
   * would become "everything" — the Library itself, the same rule that hides
   * "Save as list" for an empty query.
   */
  canUpdate: boolean;
}

export function listLine(fromList: string | null, lists: ReadonlyMap<string, ListDef>, query: Query): ListLine | null {
  if (fromList === null) return null;
  const list = lists.get(fromList);
  if (!list) return null;
  const changed = listQueryChanged(list, query);
  const canUpdate = changed && !isBuiltinListId(list.id) && !isEmptyQuery(stripListKey(query));
  return { list, text: `From list '${list.name}'`, changed, canUpdate };
}

/** The name "Save as list" suggests: the chips, joined ("Level: B1 · Not started"), at most 40 characters. */
export function defaultListName(chipLabels: readonly string[]): string {
  return shortLabel(chipLabels.join(' · '), 40);
}

/* ============================================================= routes */

/**
 * The label of a session from the Library (SessionRecord.scopeLabel): the
 * list's name when it is shown unchanged, else the chips ("German · Level:
 * B1"), else "Library".
 */
export function sessionLabel(chipLabels: readonly string[], line: ListLine | null): string {
  if (line && !line.changed) return line.list.name;
  if (chipLabels.length === 0) return 'Library';
  return shortLabel(chipLabels.join(' · '), 60);
}

/** "Study {n}": a scheduled session over the chips (spec §4.6). */
export function studyRoute(q: Query, label: string) {
  return { pathname: '/session' as const, params: { kind: 'scheduled', q: serializeQuery(q), label } };
}

/** "Practice {n}": a practice session over the chips, in the list's order (it writes nothing, §6.6). */
export function practiceQueryRoute(q: Query, sort: SortSpec, label: string) {
  return {
    pathname: '/session' as const,
    params: { kind: 'practice', q: serializeQuery(q), sort: JSON.stringify(sort), label },
  };
}

/** "Practice {n}" of selected cards: by a selection token — card ids never go in a URL (§2.2). */
export function practiceSelectionRoute(selToken: string, label: string) {
  return { pathname: '/session' as const, params: { kind: 'practice', sel: selToken, label } };
}

/**
 * "Choose ({n})": triage over the Not started cards of the chips, in the
 * Library's sort (spec §8.5). The triage route is built by another unit of
 * this wave, so this is a plain string (the caller casts it to `Href`).
 */
export function triageHref(q: Query, sort: SortSpec): string {
  return `/triage?q=${encodeURIComponent(serializeQuery(q))}&sort=${encodeURIComponent(JSON.stringify(sort))}`;
}

/** What the "Choose ({n})" button counts (chooseCount). */
export interface ChooseCount {
  /** The triage's items: notes with a Not started card (in an enabled direction) in the list. */
  items: number;
  /** The cards a choice over all of them changes (every enabled direction of each item). */
  cards: number;
}

/**
 * The number on "Choose ({n})" (walkthrough M6): the ITEMS the triage it
 * opens will show, not the Not started cards. A word with two directions
 * Not started is ONE thing to choose: the button said "Choose (12)" and the
 * triage it opened said "0 / 6 items". The items are found by the triage's
 * own rule (triageLogic triageItems) over the list's rows — the same cards
 * the triage reads for the same query — so the two numbers always agree.
 * `cards` are ALL the cards of the library, not only the list: with a
 * Direction chip the list holds one direction, but a choice also changes the
 * item's other direction (the triage finds it the same way).
 *
 * The lookups come from deckPageLogic.ts `triageLookupOf`, the SAME function
 * the triage screen, the deck page and the session use (wave 5d, M6): one
 * place builds them, so Library and triage can never count with two
 * different rules.
 *
 *   two directions, both Not started, 6 words → { items: 6, cards: 12 }
 */
export function chooseCount(rows: readonly Card[], cards: readonly Card[], ctx: Pick<MatchCtx, 'decks' | 'index'>): ChooseCount {
  const items = triageItems(rows, triageLookupOf({ cards }, ctx));
  return { items: items.length, cards: cardIdsOf(items).length };
}

/**
 * The "Choose ({n})" button's text and screen-reader label (walkthrough M6).
 * It counts items, like the triage it opens; when an item has more than one
 * card (two directions) it names the unit, like the triage's counter ("0 / 6
 * items"), because the count line above it says "{n} cards":
 *
 *   { items: 6, cards: 6 }    → 'Choose (6)',       'Choose what to learn, 6 cards not started'
 *   { items: 6, cards: 12 }   → 'Choose (6 items)', 'Choose what to learn, 12 cards (6 items) not started'
 */
export function chooseButton(count: ChooseCount): { label: string; a11y: string } {
  const n = count.items === count.cards ? count.items.toLocaleString('en-US') : plural(count.items, 'item');
  return {
    label: `Choose (${n})`,
    a11y: `Choose what to learn, ${cardsAndItems(count.cards, count.items)} not started`,
  };
}

/**
 * The deck of the FAB's new card (spec §8.3): the only Deck chip; else the
 * one deck all Section chips are in; else the last used deck (`lastUsed`).
 */
export function fabDeckId(chips: Query, decks: ReadonlyMap<Id, Deck>, lastUsed: () => Id | null): Id | null {
  const q = sanitizeQuery(chips);
  if (q.decks && q.decks.length === 1 && decks.has(q.decks[0])) return q.decks[0];
  if (!q.decks && q.sections) {
    const ids = new Set(q.sections.map((s) => s.deckId));
    if (ids.size === 1) {
      const [only] = [...ids];
      if (decks.has(only)) return only;
    }
  }
  return lastUsed();
}

/** "Add a card": the card editor with its deck preset. */
export function newCardRoute(deckId: Id | null) {
  return deckId
    ? { pathname: '/card-editor' as const, params: { deckId } }
    : { pathname: '/card-editor' as const, params: {} };
}

/* ============================================================ copy */

export const LIBRARY_COPY = {
  title: 'Library',
  select: 'Select',
  cancel: 'Cancel',
  searchPlaceholder: 'Search cards…',
  clearSearch: 'Clear the search',
  clearAll: 'Clear all',
  saveAsList: 'Save as list',
  saveAsNewList: 'Save as new list',
  updateList: 'Update list',
  emptyTitle: 'Your library is empty.',
  importFile: 'Import a file',
  makeDeck: 'Make my own deck',
  addCard: 'Add a card',
  sortTitle: 'Sort by',
  more: 'More',
} as const;

/** "12 selected". */
export function selectedText(n: number): string {
  return `${n.toLocaleString('en-US')} selected`;
}

/** "Select all 1,585". */
export function selectAllText(n: number): string {
  return `Select all ${n.toLocaleString('en-US')}`;
}

/** "1,585 cards" — always cards (one unit on the whole screen, spec §8.3). */
export function countLine(n: number): string {
  return plural(n, 'card');
}
