/**
 * Tests for the Library's rules (src/components/library/libraryState.ts,
 * spec §8.3, §4.2, §4.6, §4.7, unit W4-2).
 *
 * What is pinned here:
 *   - route params: the "adjust state when a prop changes" step (a nonce is
 *     applied ONCE; a new nonce with the same q applies again — STATE_BUG_AUDIT
 *     U1); a list opens as its own chips with "From list";
 *   - "Clear all" clears the chips AND the route params;
 *   - "Select all" stores the QUERY, never ids;
 *   - the real bulk toggles: Unfavorite / Unflag / Unsuspend when every card has the marker;
 *   - the smart empty state picks the chip whose removal gives the most cards,
 *     and its count is exactly the list without that chip — also when that
 *     chip is still a token in the search box;
 *   - the FacetSheet starts from the box as typed (not the debounced text);
 *   - "Update list" is not offered when every chip of the list was removed;
 *   - "Show {n} cards" of the FacetSheet equals the real list length;
 *   - the search box goes through searchParse (is:flagged, level:b1 …);
 *   - rows (status, badge, direction), sort menu, lists, routes, snackbars;
 *   - perfMarks.timedSelector records only real computations;
 *   - listClock: a clock tick does not filter and sort the list again
 *     unless the query reads the clock (a Due chip, the buried marker);
 *   - the AddSheet's "New list" line (newList=1, its ONLY spelling since wave
 *     5) until Save as list / Clear all;
 *   - a perf guard: the Library list of a 16,000-card library in node;
 *   - wave 5 (W5-5b): "Select all" within the 150 ms debounce selects the rows
 *     the learner SEES (never hidden cards); the FacetSheet's "Clear all",
 *     then the same filter, then "Show {n} cards" applies it; the bulk bar's
 *     colours have ≥ 4.5:1 text contrast and a visible active toggle in BOTH
 *     themes (tokens only);
 *   - wave 5b (the device walkthrough, at the end of the file): H2 Return
 *     parses the event's text; M9 no count for a half-typed token, the list
 *     memoized per (query, sort, data), a big library's FacetSheet counts
 *     after a tick; M8 chips named like the FacetSheet groups; M2 the chip row
 *     (cut text, scroll to a new chip); L12 headline matches first; L13 the
 *     More rows wrap; L16 select mode ends when nothing selected is visible;
 *     M3 taps pass while the keyboard is open; perfMarks budgets;
 *   - wave 5b, review round 1: the FacetSheet starts from the list's query
 *     (no half-typed token) and "Show" keeps that token in the box; the smart
 *     empty state's "Remove …" uses the chip names of the "No cards match"
 *     line; the disabled bulk bar (nothing selected) reads ≥ 4.5:1 in both
 *     themes; the chip text limit follows the font size;
 *   - wave 5b, review round 2 (at the very end): the FacetSheet counts ONCE
 *     per open, with the Library's clock (a hook like the real useNow, whose
 *     first value is the boot time); a chip is never wider than the row
 *     allows (measured, not only counted in characters); while a complete
 *     token is edited (`level:b1` → `level:b`) the list, "Select all" and
 *     the FacetSheet keep its result; rows name a direction like the
 *     Direction group; the SaveListSheet's buttons sit in ONE scroll view
 *     (the Sheet body, whose keyboardShouldPersistTaps covers M3).
 *
 * Part 2 (at the end) renders the Library SCREEN (src/app/(tabs)/library.tsx)
 * with react-test-renderer, to check the wiring: route params, Clear all →
 * router.setParams, the search box, select mode with the real toggles and
 * Undo, the result buttons, the smart empty state, the FAB, the
 * FacetSheet, the suggestion chips of a scoped Library, the same rows after
 * a clock tick, and "Move to deck…" only when another deck exists. Module
 * mocks (`jest.mock` below): the store hooks read one
 * in-memory state and every action runs the REAL reducer on it; the router,
 * the theme, icons, images and the review history are small fakes.
 */
// '@jest/globals' first: the jest.mock factories below use its `jest`.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { Dimensions, FlatList, Modal, ScrollView, StyleSheet } from 'react-native';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { BUILTIN_TYPE_IDS } from '../../domain/builtinTypes';
import { deriveFacets, toggleFacetValue } from '../../domain/facets';
import { buildLibraryIndex } from '../../domain/libraryIndex';
import { listsById } from '../../domain/lists';
import { makeCard, makeNote } from '../../domain/makeV3';
import type { Card, DataStateV3, ListDef, Note, NoteType, Query } from '../../domain/model';
import { parseQueryParam, sameQuery, serializeQuery } from '../../domain/query';
import { buildSessionQueue, matchCtxOf, readyFor, scopePool, type SessionParams, sortScopeCards } from '../../domain/scope';
import { chipsOf, parseSearch, removeChip } from '../../domain/searchParse';
import { plural } from '../../domain/text';
import { DAY, DEFAULT_SRS, MIN } from '../../domain/types';
import {
  createPerfMarks,
  formatPerfLine,
  PERF_BUDGETS,
  perfMarks,
  perfMarksEnabled,
  timedSelector,
} from '../../store/perfMarks';
import { sortedPoolReader } from '../../store/selectors';
import * as reducer from '../../store/reducer';
import type { SnackMessage } from '../../store/SnackbarContext';
import { FIXED_NOW } from '../../test/clock';
import { lifeValues, makeDeckV3, noteWithCards, stateOfV3, testCtx } from '../../test/factoriesV3';
import {
  applyRouteParams,
  BASE_SORTS,
  LIBRARY_COPY,
  bestChipToRemove,
  bulkToggles,
  chipOfGroup,
  chipScopeFor,
  chooseButton,
  chooseCount,
  CLEARED_PARAMS,
  clearAll,
  commitSearch,
  countLine,
  createRowsCache,
  DEFAULT_SORT,
  defaultListName,
  directionLabeler,
  editSnack,
  effectiveQuery,
  fabDeckId,
  FACET_SYNC_MAX_CARDS,
  facetCountsDeferred,
  facetsDone,
  facetStartQuery,
  fieldsWithValues,
  headlineRank,
  initialLibraryState,
  type LibraryState,
  libraryChips,
  libraryDirectionNames,
  libraryTags,
  listClock,
  listLine,
  listTextFor,
  NEW_LIST_INTENT,
  NEW_LIST_PARAM_VALUE,
  newCardRoute,
  NO_SELECTION,
  noteIdsOf,
  openQuery,
  ordinalFields,
  parsedChips,
  parseForList,
  parseLive,
  pendingTokenStart,
  practiceQueryRoute,
  practiceSelectionRoute,
  quotesClosed,
  rankRows,
  removeBestChip,
  removeChipFrom,
  resultCountFromFacets,
  routeKey,
  rowBadge,
  rowHeight,
  ROWS_CACHE_SIZE,
  rowsReader,
  rowStatus,
  savedAsList,
  searchCtxFor,
  searchNeedle,
  searchTree,
  selectAll,
  selectAllText,
  selectedText,
  selectionGone,
  selectionSummary,
  selectsAllShown,
  sessionLabel,
  sheetGroupKey,
  sheetGroups,
  shortLabel,
  shouldCommitOnSpace,
  shownQueryNow,
  showsNewListBanner,
  skippedNote,
  sortId,
  sortLabel,
  sortOptions,
  splitHalfTokens,
  splitText,
  startSelecting,
  stopSelecting,
  studyRoute,
  submitSearch,
  suggestionChips,
  summarizeRows,
  tagCountsOf,
  toggleSelected,
  toggleSnack,
  triageHref,
  typeSearch,
  valueText,
  withChips,
  withDraftSelection,
  withQuery,
  withSelectedIds,
  withSort,
  withText,
} from './libraryState';
import LibraryScreen from '../../app/(tabs)/library';
import { dark, light } from '../../theme/tokens';
import { CardSheet } from '../sheets/CardSheet';
import { SaveListSheet } from '../sheets/SaveListSheet';
import {
  changedChipKey,
  CHIP_CHROME,
  CHIP_TEXT_MAX,
  CHIP_TEXT_MIN,
  chipMaxWidth,
  chipText,
  chipTextMax,
  chipTextRoom,
  ELLIPSIS_ROOM,
  FilterChipsRow,
  fitChipChars,
  scrollToShow,
  textFromLines,
} from '../ui/FilterChipsRow';
import { triageLookupOf } from '../deck/deckPageLogic';
import { cardIdsOf, positionLabel, startRun, triageItems } from '../deck/triageLogic';
import { libraryRoute, NEW_LIST_BANNER, NEW_LIST_PARAM } from '../today/todayLogic';
import { MIN_TOUCH } from '../ui/buttons';
import { BAR_LABEL_MIN_SCALE, BulkBar, bulkBarColors } from './BulkBar';
import { FacetSheet } from './FacetSheet';

/* ============================================ mocks (Part 2, the screen) */

/** The one state the mocked store hooks read; the mocked actions run the real reducer on it. */
let mockState: DataStateV3;
/** The Library's route params (useLocalSearchParams). */
let mockParams: { q?: string; nonce?: string; intent?: string; newList?: string } = {};
/** What the mocked useNow() returns (a test moves it to play a clock tick). */
let mockNow: number = FIXED_NOW;
/**
 * The mocked useNow() itself: by default it returns mockNow. A test can put
 * in a hook that behaves like the real one (useNowLikeTheApp: the module-load
 * time first, the time NOW one tick after mount). Reset before every test.
 */
let mockUseNow: () => number = () => mockNow;
/** The snackbar channel of the tests (show puts a NEW message, dismiss clears it). */
const mockSnackChannel = {
  snack: null as SnackMessage | null,
  listeners: new Set<() => void>(),
  set(next: SnackMessage | null) {
    mockSnackChannel.snack = next;
    for (const listener of mockSnackChannel.listeners) listener();
  },
  subscribe(listener: () => void) {
    mockSnackChannel.listeners.add(listener);
    return () => {
      mockSnackChannel.listeners.delete(listener);
    };
  },
  get: () => mockSnackChannel.snack,
};
const mockShow = jest.fn((text: string, action?: { label?: string; onAction: () => void }) =>
  mockSnackChannel.set({ text, actionLabel: action ? (action.label ?? 'Undo') : undefined, onAction: action?.onAction }),
);
const mockDismiss = jest.fn(() => mockSnackChannel.set(null));
const mockPush = jest.fn<(href: unknown) => void>();
const mockSetParams = jest.fn<(params: Record<string, unknown>) => void>();

/** Run one reducer command on mockState; returns its result. */
function mockRun<I, R>(command: (s: DataStateV3, input: I, ctx: reducer.ReducerCtx) => { state: DataStateV3; result: R }, input: I): R {
  const step = command(mockState, input, testCtx(FIXED_NOW));
  mockState = step.state;
  return step.result;
}

const mockDeleted = new Map<string, ReturnType<typeof reducer.deleteNotes>['result']>();

const mockActions = {
  setFlags: jest.fn((cardIds: string[], patch: { fav?: boolean; flagged?: boolean; suspended?: boolean }) =>
    mockRun(reducer.setFlags, { cardIds, patch }).edit.id,
  ),
  learn: jest.fn((cardIds: string[]) => mockRun(reducer.learn, { cardIds }).edit.id),
  markKnown: jest.fn((cardIds: string[]) => mockRun(reducer.markKnown, { cardIds }).edit.id),
  setNotStarted: jest.fn((cardIds: string[]) => mockRun(reducer.setNotStarted, { cardIds }).edit.id),
  resetProgress: jest.fn((cardIds: string[]) => mockRun(reducer.resetProgress, { cardIds }).edit.id),
  reschedule: jest.fn((cardIds: string[], dueMs: number) => mockRun(reducer.reschedule, { cardIds, dueMs }).edit.id),
  undoManualEdit: jest.fn((editId: string) => mockRun(reducer.undoManualEdit, { editId })),
  moveNotes: jest.fn((noteIds: string[], deckId: string) => mockRun(reducer.moveNotes, { noteIds, deckId }).edit.id),
  tagNotes: jest.fn((noteIds: string[], add: string[], remove: string[]) =>
    mockRun(reducer.tagNotes, { noteIds, add, remove }).edit.id,
  ),
  deleteNotes: jest.fn((noteIds: string[]) => {
    const removed = mockRun((s, input: { noteIds: string[] }) => reducer.deleteNotes(s, input), { noteIds });
    const token = `del-${mockDeleted.size + 1}`;
    mockDeleted.set(token, removed);
    return token;
  }),
  undoDelete: jest.fn((token: string) => {
    const deleted = mockDeleted.get(token);
    if (!deleted) return false;
    return mockRun((s, input: { deleted: typeof deleted }) => reducer.undoDelete(s, input), { deleted });
  }),
  saveList: jest.fn((input: Parameters<typeof reducer.saveList>[1]['input']) => mockRun(reducer.saveList, { input })),
  setListPref: jest.fn((id: string, pref: Parameters<typeof reducer.setListPref>[1]['pref']) =>
    mockRun((s, i: { id: string; pref: typeof pref }) => reducer.setListPref(s, i), { id, pref }),
  ),
};

jest.mock('../../store/DataContext', () => ({ useData: () => ({ actions: mockActions }) }));

jest.mock('../../store/selectors', () => {
  const actual = jest.requireActual<typeof import('../../store/selectors')>('../../store/selectors');
  const scope = jest.requireActual<typeof import('../../domain/scope')>('../../domain/scope');
  const { FIXED_NOW: now } = jest.requireActual<typeof import('../../test/clock')>('../../test/clock');
  const ctx = () => scope.matchCtxOf(mockState, now);
  return {
    ...actual,
    useStateV3: <T,>(selector: (state: DataStateV3) => T): T => selector(mockState),
    useEngine: () => ({ store: { getState: () => mockState } }),
    useMatchCtx: () => ctx(),
    useLibraryIndex: () => scope.libraryIndexOf(mockState),
    useReady: (q: Query) => scope.readyFor(mockState, q, ctx()),
    useSessionLength: (params: SessionParams) => scope.buildSessionQueue(params, mockState, ctx()).length,
  };
});

jest.mock('../../store/useNow', () => ({ useNow: () => mockUseNow() }));

jest.mock('../../store/SnackbarContext', () => ({
  useSnackbar: () => {
    const snack = jest
      .requireActual<typeof import('react')>('react')
      .useSyncExternalStore(mockSnackChannel.subscribe, mockSnackChannel.get);
    return { show: mockShow, snack, dismiss: mockDismiss };
  },
}));

// Only the review history of the CardSheet (the real module opens the phone's databases).
jest.mock('../../store/storage', () => ({
  appRevlogStore: () => ({ forCard: () => new Promise(() => undefined) }),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, setParams: mockSetParams }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('expo-image', () => ({ Image: () => null }));
jest.mock('@expo/ui/community/datetime-picker', () => ({
  DateTimePicker: function DateTimePicker() {
    return null;
  },
}));
jest.mock('../../domain/speech', () => ({ speak: () => undefined }));
jest.mock('../../platform/media', () => ({ mediaFileUri: () => null }));
jest.mock('../../theme/ThemeContext', () => ({
  useColors: () => jest.requireActual<typeof import('../../theme/tokens')>('../../theme/tokens').light,
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

/* ================================================================ fixtures */

const NOW = FIXED_NOW;
const DE_TYPE = BUILTIN_TYPE_IDS.legacyVocabDe;

/** A legacy German note (one card): Word, Translation, …, Level, Type, … */
function vocab(id: string, word: string, level: string, type: string, card: Partial<Card>, note: Partial<Note> = {}) {
  return noteWithCards({
    deckId: 'd-de',
    typeId: DE_TYPE,
    fields: [word, `meaning of ${word}`, '', '', '', level, type, '', '', ''],
    note: { id, ...note },
    card: { id: `c-${id}`, ...card },
  });
}

/**
 * German (6 legacy notes, Level A1/A2/B1, Type noun/verb) and Spanish (a
 * Basic + reverse note with two directions, and a Basic note with a tag tree).
 */
function fixture(): DataStateV3 {
  const de = makeDeckV3({ id: 'd-de', name: 'German', order: 0, language: 'de-DE', meaningLanguage: 'en-US' });
  const es = makeDeckV3({ id: 'd-es', name: 'Spanish', order: 1, language: 'es-ES', meaningLanguage: 'en-US' });
  const groups = [
    vocab('a1', 'das Anliegen', 'A1', 'noun', { ...lifeValues('new'), fav: true }),
    vocab('a2', 'die Abfahrt', 'A1', 'noun', { ...lifeValues('review'), suspended: true }),
    vocab('a3', 'gehen', 'A2', 'verb', lifeValues('notStarted')),
    vocab('b1', 'der Bahnhof', 'B1', 'noun', { ...lifeValues('review'), flagged: true }),
    vocab('b2', 'laufen', 'B1', 'verb', { ...lifeValues('learning'), due: NOW - MIN }),
    vocab('b3', 'die Reise', 'B1', 'noun', lifeValues('known')),
    noteWithCards({
      deckId: 'd-es',
      typeId: BUILTIN_TYPE_IDS.basicReverse,
      fields: ['comer', 'to eat', '', ''],
      note: { id: 'es1', tags: ['verb'] },
      card: (ord) => ({ id: `c-es1-${ord}`, ...lifeValues(ord === 0 ? 'review' : 'new') }),
    }),
    noteWithCards({
      deckId: 'd-es',
      typeId: BUILTIN_TYPE_IDS.basic,
      fields: ['casa', 'house', '', ''],
      note: { id: 'es2', tags: ['noun', 'Algo::Core_Patterns'] },
      card: { id: 'c-es2', ...lifeValues('notStarted') },
    }),
  ];
  return stateOfV3({ decks: [de, es], groups });
}

const STATE = fixture();
const CTX = matchCtxOf(STATE, NOW);

/** The ids of the cards a query lists in the Library (the browse pool). */
function listed(q: Query): string[] {
  return scopePool(STATE, q, CTX, 'browse').map((card) => card.id);
}

const B1_VERBS: ListDef = {
  id: 'l-b1',
  name: 'B1 verbs',
  icon: '⭐',
  query: { fields: { level: ['b1'], type: ['verb'] } },
  sort: { by: 'az' },
  createdAt: NOW,
  updatedAt: NOW,
};
const LISTS = listsById([B1_VERBS]);

/** The params a caller sends: q as JSON and a new nonce. */
function routeTo(q: Query, nonce: string) {
  return { q: serializeQuery(q), nonce };
}

/* =============================================== route params (spec §4.6) */

describe('route params — the "adjust state when a prop changes" step', () => {
  it('the first render applies q and remembers the nonce; text goes to the search box, the rest are chips', () => {
    const state = initialLibraryState(routeTo({ decks: ['d-de'], text: 'Bahnhof' }, '17'), LISTS);
    expect(state.chips).toEqual({ decks: ['d-de'] });
    expect(state.text).toBe('bahnhof');
    expect(state.applied).toBe('n:17');
    expect(state.sort).toEqual(DEFAULT_SORT);
    expect(state.selecting).toBe(false);
  });

  it('the SAME nonce is never applied twice: the user’s own chip changes survive a re-render', () => {
    const params = routeTo({ decks: ['d-de'] }, '17');
    const start = initialLibraryState(params, LISTS);
    const edited = removeChipFrom(start, 'decks');
    expect(edited.chips).toEqual({});
    expect(applyRouteParams(edited, params, LISTS)).toBeNull();
  });

  it('a NEW nonce with the same q applies again (STATE_BUG_AUDIT U1: same-value re-entry)', () => {
    const start = initialLibraryState(routeTo({ decks: ['d-de'] }, '17'), LISTS);
    const edited = removeChipFrom(start, 'decks');
    const again = applyRouteParams(edited, routeTo({ decks: ['d-de'] }, '18'), LISTS);
    expect(again).not.toBeNull();
    expect(again!.chips).toEqual({ decks: ['d-de'] });
    expect(again!.applied).toBe('n:18');
    // Applied once: the next render is a no-op.
    expect(applyRouteParams(again!, routeTo({ decks: ['d-de'] }, '18'), LISTS)).toBeNull();
  });

  it('a new request ends select mode and empties the selection (it belonged to the old filters)', () => {
    const selecting = selectAll(startSelecting(initialLibraryState({}, LISTS)), {});
    const next = applyRouteParams(selecting, routeTo({ life: ['new'] }, '2'), LISTS)!;
    expect(next.selecting).toBe(false);
    expect(next.selection).toEqual(NO_SELECTION);
    expect(next.chips).toEqual({ life: ['new'] });
  });

  it('a list opens as ITS OWN chips (each removable) with "From list", and the list’s sort', () => {
    const state = initialLibraryState(routeTo({ list: 'l-b1' }, '5'), LISTS);
    expect(state.chips).toEqual({ fields: { level: ['b1'], type: ['verb'] } });
    expect(state.chips.list).toBeUndefined();
    expect(state.fromList).toBe('l-b1');
    expect(state.sort).toEqual({ by: 'az' });
    const line = listLine(state.fromList, LISTS, effectiveQuery(state.chips, {}));
    expect(line?.text).toBe("From list 'B1 verbs'");
    expect(line?.changed).toBe(false);
  });

  it('a list AND more chips: the list’s chips plus the others', () => {
    const opened = openQuery({ list: 'l-b1', life: ['learning'] }, LISTS);
    expect(opened.chips).toEqual({ fields: { level: ['b1'], type: ['verb'] }, life: ['learning'] });
    expect(opened.fromList).toBe('l-b1');
  });

  it('a built-in list opens as its chips too', () => {
    const opened = openQuery({ list: 'builtin:flagged' }, LISTS);
    expect(opened.chips).toEqual({ flags: ['flagged'] });
    expect(opened.fromList).toBe('builtin:flagged');
  });

  it('a list that does not exist (deleted) stays a removable "List" chip that matches nothing', () => {
    const opened = openQuery({ list: 'l-gone' }, LISTS);
    expect(opened.chips).toEqual({ list: 'l-gone' });
    expect(opened.fromList).toBeNull();
    expect(listed(opened.chips)).toEqual([]);
  });

  it('broken params never crash: bad JSON → no filter; an array param → its first value', () => {
    expect(initialLibraryState({ q: '{not json', nonce: '1' }, LISTS).chips).toEqual({});
    const fromArray = initialLibraryState({ q: [serializeQuery({ life: ['new'] }), 'x'], nonce: ['9', '10'] }, LISTS);
    expect(fromArray.chips).toEqual({ life: ['new'] });
    expect(fromArray.applied).toBe('n:9');
  });

  it('routeKey: the nonce; without one the q itself; nothing → null', () => {
    expect(routeKey({ q: '{}', nonce: '3' })).toBe('n:3');
    expect(routeKey({ q: '{"life":["new"]}' })).toBe('q:{"life":["new"]}');
    expect(routeKey({})).toBeNull();
    expect(routeKey({ q: '', nonce: '' })).toBeNull();
  });

  it('routeKey: "New list" (newList=1) alone is a request too; with a nonce the nonce is the key; another value is none', () => {
    expect(routeKey({ newList: '1' })).toBe('i:newList');
    expect(routeKey({ newList: '1', nonce: '9' })).toBe('n:9');
    expect(routeKey({ newList: '0' })).toBeNull();
  });
});

/* ======================================= the AddSheet "New list" line (§8.10) */

describe('the "New list" line — "Add filters, then tap Save as list."', () => {
  const newList = () => initialLibraryState({ newList: '1', nonce: '5' }, LISTS);

  it('newList=1 shows the line; a request without it, or another value, does not', () => {
    expect(newList().intent).toBe(NEW_LIST_INTENT);
    expect(showsNewListBanner(newList())).toBe(true);
    expect(newList().chips).toEqual({});
    expect(initialLibraryState(routeTo({ decks: ['d-de'] }, '6'), LISTS).intent).toBeNull();
    expect(initialLibraryState({ newList: 'yes', nonce: '7' }, LISTS).intent).toBeNull();
    // A new request without it (another caller) ends the line.
    expect(applyRouteParams(newList(), routeTo({ decks: ['d-de'] }, '6'), LISTS)?.intent).toBeNull();
    // "New list" asked again while the Library is open: a new nonce shows it again.
    const done = savedAsList(newList(), 'l-1');
    expect(applyRouteParams(done, { newList: '1', nonce: '8' }, LISTS)?.intent).toBe('newList');
  });

  it('ONE spelling (wave 5): exactly what the AddSheet and Today send; the old intent=newList is no request', () => {
    // The value this file reads is the value todayLogic sends.
    expect(NEW_LIST_PARAM_VALUE).toBe(NEW_LIST_PARAM.newList);
    expect(initialLibraryState(libraryRoute({}, '9', NEW_LIST_PARAM).params, LISTS).intent).toBe('newList');
    // The old second spelling does nothing any more (it is not even a route param of the Library).
    const old = { intent: 'newList', nonce: '9' } as unknown as Parameters<typeof initialLibraryState>[0];
    expect(initialLibraryState(old, LISTS).intent).toBeNull();
  });

  it('it stays while filters are chosen, hides in select mode, and goes after "Save as list" or "Clear all"', () => {
    const chosen = withChips(newList(), { fields: { level: ['b1'] } });
    expect(showsNewListBanner(chosen)).toBe(true);
    expect(showsNewListBanner(startSelecting(chosen))).toBe(false);
    expect(showsNewListBanner(stopSelecting(startSelecting(chosen)))).toBe(true);
    expect(savedAsList(chosen, 'l-1').intent).toBeNull();
    const cleared = clearAll(chosen);
    expect(cleared.state.intent).toBeNull();
    expect(cleared.params).toHaveProperty('newList', undefined);
    // The router has not cleared the params yet: the old request does not come back.
    expect(applyRouteParams(cleared.state, { newList: '1', nonce: '5' }, LISTS)).toBeNull();
  });
});

/* ===================================================== Clear all (§4.6) */

describe('Clear all — every chip AND the route params', () => {
  it('clears chips, text and the list, keeps the sort, and returns the params to clear', () => {
    const start = withSort(initialLibraryState(routeTo({ list: 'l-b1', text: 'lauf' }, '7'), LISTS), { by: 'due' });
    const { state, params } = clearAll(start);
    expect(params).toEqual({ q: undefined, nonce: undefined, newList: undefined });
    expect(params).toBe(CLEARED_PARAMS);
    // Every route param goes, also the "New list" request `newList=1` (spec §8.10,
    // todayLogic NEW_LIST_PARAM — its only spelling since wave 5).
    expect(Object.keys(params).sort()).toEqual(['newList', 'nonce', 'q']);
    expect(state.chips).toEqual({});
    expect(state.text).toBe('');
    expect(state.fromList).toBeNull();
    expect(state.sort).toEqual({ by: 'due' });
  });

  it('the old request does NOT come back in the render before the router has cleared the params', () => {
    // router.setParams is not instant: the next render may still see the old params.
    const old = routeTo({ decks: ['d-de'] }, '7');
    const { state } = clearAll(initialLibraryState(old, LISTS));
    expect(applyRouteParams(state, old, LISTS)).toBeNull();
  });

  it('when the params are cleared, nothing changes on screen; a later request applies again', () => {
    const { state, params } = clearAll(initialLibraryState(routeTo({ decks: ['d-de'] }, '7'), LISTS));
    const afterClear = applyRouteParams(state, params, LISTS)!;
    expect(afterClear.applied).toBeNull();
    expect(afterClear.chips).toEqual({});
    expect(afterClear.text).toBe('');
    expect(applyRouteParams(afterClear, params, LISTS)).toBeNull();
    // The same filter asked again (a new nonce) works.
    expect(applyRouteParams(afterClear, routeTo({ decks: ['d-de'] }, '8'), LISTS)?.chips).toEqual({ decks: ['d-de'] });
  });

  it('a plain tab press (no params) keeps the user’s own filters', () => {
    const own: LibraryState = withChips(initialLibraryState({}, LISTS), { life: ['new'] });
    expect(applyRouteParams(own, {}, LISTS)).toBeNull();
    const fromRoute = withChips(initialLibraryState(routeTo({ decks: ['d-de'] }, '7'), LISTS), { life: ['new'] });
    expect(applyRouteParams(fromRoute, {}, LISTS)?.chips).toEqual({ life: ['new'] });
  });
});

/* =================================================== select mode (§8.3) */

describe('select mode — "Select all" stores the query, never ids', () => {
  it('selectAll keeps the query itself (no id list)', () => {
    const q: Query = { fields: { level: ['b1'] } };
    const state = selectAll(initialLibraryState({}, LISTS), q);
    expect(state.selecting).toBe(true);
    expect(state.selection.kind).toBe('query');
    expect(state.selection).toEqual({ kind: 'query', query: q });
    expect('ids' in state.selection).toBe(false);
  });

  it('a tap after "Select all" turns it into the shown ids minus the tapped card', () => {
    const shown = ['c-b1', 'c-b2', 'c-b3'];
    const state = toggleSelected(selectAll(initialLibraryState({}, LISTS), {}), 'c-b2', shown);
    expect(state.selection).toEqual({ kind: 'ids', ids: ['c-b1', 'c-b3'] });
  });

  it('taps add and remove ids; Cancel and new filters empty the selection', () => {
    let state = startSelecting(initialLibraryState({}, LISTS));
    state = toggleSelected(state, 'c-a1', []);
    state = toggleSelected(state, 'c-a2', []);
    expect(state.selection).toEqual({ kind: 'ids', ids: ['c-a1', 'c-a2'] });
    state = toggleSelected(state, 'c-a1', []);
    expect(state.selection).toEqual({ kind: 'ids', ids: ['c-a2'] });
    expect(withChips(state, { life: ['new'] }).selection).toEqual(NO_SELECTION);
    expect(withText(state, 'haus').selection).toEqual(NO_SELECTION);
    expect(stopSelecting(state)).toMatchObject({ selecting: false, selection: NO_SELECTION });
  });

  it('after a bulk change the selection keeps the SAME cards as ids (they may leave the list)', () => {
    const state = withSelectedIds(selectAll(initialLibraryState({}, LISTS), { flags: ['flagged'] }), ['c-b1']);
    expect(state.selection).toEqual({ kind: 'ids', ids: ['c-b1'] });
  });

  it('selectsAllShown: every row is drawn selected only when "Select all" IS the list’s query', () => {
    const q: Query = { decks: ['d-de'], text: 'bahnhof' };
    const all = selectAll(startSelecting(initialLibraryState({}, LISTS)), q).selection;
    expect(selectsAllShown(all, { text: 'bahnhof', decks: ['d-de'] })).toBe(true);
    // The list still shows the old (debounced) query: no row looks selected.
    expect(selectsAllShown(all, { decks: ['d-de'] })).toBe(false);
    expect(selectsAllShown({ kind: 'ids', ids: ['c-b1'] }, q)).toBe(false);
    expect(selectsAllShown(NO_SELECTION, {})).toBe(false);
  });

  it('the header texts', () => {
    expect(selectedText(12)).toBe('12 selected');
    expect(selectAllText(1585)).toBe('Select all 1,585');
    expect(countLine(1)).toBe('1 card');
    expect(countLine(1585)).toBe('1,585 cards');
  });
});

/* ============================================== bulk toggles (§7 #19) */

describe('bulk toggles — real toggles with text labels', () => {
  const card = (fav: boolean, flagged: boolean, suspended: boolean) => ({ fav, flagged, suspended });

  it('every selected card has the marker → Unfavorite / Unflag / Unsuspend, and the patch takes it away', () => {
    const t = bulkToggles([card(true, true, true), card(true, true, true)]);
    expect(t.map((x) => x.label)).toEqual(['Unfavorite', 'Unflag', 'Unsuspend']);
    expect(t.map((x) => x.patch)).toEqual([{ fav: false }, { flagged: false }, { suspended: false }]);
    expect(t.every((x) => x.allOn)).toBe(true);
  });

  it('mixed → Favorite / Flag / Suspend, and the patch SETS it on every card', () => {
    const t = bulkToggles([card(true, false, true), card(false, true, false)]);
    expect(t.map((x) => x.label)).toEqual(['Favorite', 'Flag', 'Suspend']);
    expect(t.map((x) => x.patch)).toEqual([{ fav: true }, { flagged: true }, { suspended: true }]);
  });

  it('none have it → the "on" action; no cards → the "on" label too (never "Un…" for nothing)', () => {
    expect(bulkToggles([card(false, false, false)]).map((x) => x.label)).toEqual(['Favorite', 'Flag', 'Suspend']);
    expect(bulkToggles([]).map((x) => x.label)).toEqual(['Favorite', 'Flag', 'Suspend']);
    expect(bulkToggles([]).some((x) => x.allOn)).toBe(false);
  });

  it('an absent marker counts as off', () => {
    expect(bulkToggles([{} as Card])[0].label).toBe('Favorite');
  });

  it('the fallback snackbar texts', () => {
    expect(toggleSnack({ key: 'fav', allOn: false }, 12)).toBe('12 cards added to Favorites');
    expect(toggleSnack({ key: 'fav', allOn: true }, 1)).toBe('1 card removed from Favorites');
    expect(toggleSnack({ key: 'flagged', allOn: true }, 3)).toBe('3 cards unflagged');
    expect(toggleSnack({ key: 'suspended', allOn: false }, 2)).toBe('2 cards suspended');
  });
});

/* ===================================== BulkBar colours (spec §8.12, §8.13) */

/** '#RRGGBB' or '#RRGGBBAA' → [r, g, b, alpha 0–1]. */
function rgba(hex: string): [number, number, number, number] {
  expect(hex).toMatch(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return [n(1), n(3), n(5), hex.length === 9 ? n(7) / 255 : 1];
}

/** A colour with alpha, painted over an opaque one: the colour the eye sees ('#RRGGBB'). */
function paintOver(top: string, base: string): string {
  const [r, g, b, a] = rgba(top);
  const [r0, g0, b0] = rgba(base);
  const mix = (x: number, y: number) => Math.round(x * a + y * (1 - a)).toString(16).padStart(2, '0');
  return `#${mix(r, r0)}${mix(g, g0)}${mix(b, b0)}`;
}

/** The WCAG 2.1 contrast ratio of two opaque colours (1 to 21). */
function contrast(x: string, y: string): number {
  const lum = (hex: string) => {
    const [r, g, b] = rgba(hex).slice(0, 3).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

describe('BulkBar colours — theme tokens, readable in BOTH themes', () => {
  it.each<[string, typeof light]>([
    ['Paper (light)', light],
    ['Evening (dark)', dark],
  ])('%s: text ≥ 4.5:1, "Practice {n}" ≥ 4.5:1, and an active toggle can be seen', (_, palette) => {
    const k = bulkBarColors(palette);
    const idle = paintOver(k.idleBg, k.bar);
    const active = paintOver(k.activeBg, k.bar);
    // Text on every button background (WCAG AA for normal text).
    expect(contrast(k.text, idle)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(k.text, active)).toBeGreaterThanOrEqual(4.5);
    // "Practice 12": the old fixed brown was 2.1:1 on the Evening teal.
    expect(contrast(k.accentText, k.accentBg)).toBeGreaterThanOrEqual(4.5);
    // "On" is not only a word: the active tint differs from the idle one, and its
    // outline stands out from the bar (WCAG 1.4.11, non-text contrast ≥ 3:1).
    expect(active).not.toBe(idle);
    expect(contrast(active, idle)).toBeGreaterThan(1.3);
    expect(contrast(k.activeBorder, k.bar)).toBeGreaterThanOrEqual(3);
    // Disabled (nothing selected, the bar right after "Select" — walkthrough L2):
    // the label on the idle tint still reads ≥ 4.5:1 (opacity 0.45 gave 2.6:1 on
    // Evening), and it is weaker than an enabled label, so it looks "off".
    const disabledFg = paintOver(k.disabledText, idle);
    expect(contrast(disabledFg, idle)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(disabledFg, idle)).toBeLessThan(contrast(k.text, idle));
  });

  it('no fixed colour: every value comes from the palette', () => {
    const k = bulkBarColors(dark);
    expect(k.accentText).toBe(dark.inverseSurface);
    expect(k.accentBg).toBe(dark.inverseAccent);
    expect(k.bar).toBe(dark.inverseSurface);
    expect(k.idleBg.startsWith(dark.inverseText)).toBe(true);
    expect(k.activeBg.startsWith(dark.inverseText)).toBe(true);
    expect(k.disabledText.startsWith(dark.inverseText)).toBe(true);
  });
});

describe('selectionSummary — what each "More" row would change', () => {
  it('counts per action', () => {
    const s = selectionSummary(STATE.cards);
    // learnable: Not started (a3, es2) + Known (b3)
    expect(s.learnable).toBe(3);
    expect(s.knowable).toBe(STATE.cards.length - 1);
    // studied: a2, b1, b2 (review/learning) + es1 ord 0 (review)
    expect(s.studied).toBe(4);
    // never studied and not Not started yet: a1 (new), b3 (known), es1 ord 1 (new)
    expect(s.toNotStarted).toBe(3);
    // studied + known + not started
    expect(s.resettable).toBe(4 + 1 + 2);
    expect(s.reschedulable).toBe(4);
    expect(s.total).toBe(STATE.cards.length);
  });

  it('skippedNote', () => {
    expect(skippedNote(0)).toBe('');
    expect(skippedNote(1)).toBe('1 studied card was skipped.');
    expect(skippedNote(1200)).toBe('1,200 studied cards were skipped.');
  });
});

/* ========================================== smart empty (§8.3) */

describe('smart empty — the chip whose removal gives the most cards', () => {
  it('Level: B1 + Suspended → "Remove Suspended" (3 cards), not Level (1 card)', () => {
    const q: Query = { fields: { level: ['b1'] }, flags: ['suspended'] };
    expect(listed(q)).toEqual([]);
    const best = bestChipToRemove(STATE.cards, q, CTX);
    expect(best).toEqual({ chipId: 'flags', label: 'Suspended', count: 3 });
    // The count is EXACTLY the list without that chip (the same one-pass counting as the facets).
    expect(listed(removeChip(q, best!.chipId))).toHaveLength(best!.count);
    expect(listed(removeChip(q, 'field:level'))).toHaveLength(1);
  });

  it('a card that fails two chips helps neither; two flags are ONE chip', () => {
    // Favorite AND Flagged AND Spanish: no card. a1 is a German favorite (fails decks only).
    const q: Query = { decks: ['d-es'], flags: ['fav', 'flagged'] };
    expect(listed(q)).toEqual([]);
    const best = bestChipToRemove(STATE.cards, q, CTX)!;
    // Removing the Deck chip: a1 fails flagged → still out; b1 fails fav → still out. Removing the
    // flags chip: the 3 Spanish cards. So the flags chip wins.
    expect(best.chipId).toBe('flags');
    expect(best.count).toBe(3);
    expect(listed(removeChip(q, 'flags'))).toHaveLength(3);
  });

  it('the text chip can be the best one', () => {
    const q: Query = { decks: ['d-es'], text: 'bahnhof' };
    const best = bestChipToRemove(STATE.cards, q, CTX)!;
    expect(best.chipId).toBe('text');
    expect(best.label).toBe('Text: bahnhof');
  });

  it('null when no single chip gives a card, or when there is no chip', () => {
    // Every card fails at least two of these.
    const q: Query = { decks: ['d-es'], fields: { level: ['b1'] }, flags: ['suspended'] };
    expect(bestChipToRemove(STATE.cards, q, CTX)).toBeNull();
    expect(bestChipToRemove(STATE.cards, {}, CTX)).toBeNull();
  });

  it('a token still in the box can be removed by the smart-empty button (it becomes a chip first)', () => {
    // Level: B1 is a chip; "is:suspended" is still typed in the box (no space, no Return).
    const start = withText(withChips(initialLibraryState({}, LISTS), { fields: { level: ['b1'] } }), 'is:suspended');
    const parsed = parseLive(start.text, () => searchCtxFor(STATE.cards, CTX, start.chips));
    const query = effectiveQuery(start.chips, parsed.query);
    expect(listed(query)).toEqual([]);
    const best = bestChipToRemove(STATE.cards, query, CTX)!;
    expect(best).toEqual({ chipId: 'flags', label: 'Suspended', count: 3 });
    // The chip is not in `chips` (it is a token in the box), but the button still removes it.
    expect(start.chips.flags).toBeUndefined();
    const next = removeBestChip(start, parsed, best.chipId);
    expect(next.text).toBe('');
    expect(next.chips).toEqual({ fields: { level: ['b1'] } });
    // The list now has exactly the number the button promised.
    expect(listed(effectiveQuery(next.chips, parseLive(next.text, () => searchCtxFor(STATE.cards, CTX)).query))).toHaveLength(
      best.count,
    );
  });

  it('removeBestChip: the text chip removes only the free words; a token in the box stays, as a chip', () => {
    const start = withText(initialLibraryState({}, LISTS), 'is:suspended bahnhof');
    const parsed = parseLive(start.text, () => searchCtxFor(STATE.cards, CTX));
    expect(listed(effectiveQuery(start.chips, parsed.query))).toEqual([]);
    const next = removeBestChip(start, parsed, 'text');
    expect(next.text).toBe('');
    expect(next.chips).toEqual({ flags: ['suspended'] });
    expect(listed(next.chips)).toEqual(['c-a2']);
    // A box of plain words: the text chip clears it, the other chips stay.
    const plain = withText(withChips(start, { decks: ['d-es'] }), 'bahnhof');
    const cleared = removeBestChip(plain, parseLive(plain.text, () => searchCtxFor(STATE.cards, CTX)), 'text');
    expect(cleared.text).toBe('');
    expect(cleared.chips).toEqual({ decks: ['d-es'] });
  });

  it('chipOfGroup: each flag group belongs to its flags chip', () => {
    expect(chipOfGroup('flag:fav')).toBe('flags');
    expect(chipOfGroup('notFlag:suspended')).toBe('notFlags');
    expect(chipOfGroup('field:level')).toBe('field:level');
    expect(chipOfGroup('decks')).toBe('decks');
  });
});

/* ================================================= FacetSheet numbers */

describe('FacetSheet — "Show {n} cards" equals the list it opens', () => {
  const selections: Query[] = [
    {},
    { fields: { level: ['b1'] } },
    { life: ['review', 'new'] },
    { life: ['notStarted'], decks: ['d-es'] },
    { text: 'die' },
    { flags: ['fav'] },
    { fields: { level: ['a1', 'b1'] }, due: 'now' },
    { tags: ['algo'] },
  ];
  it.each(selections.map((q) => [serializeQuery(q), q] as const))('%s', (_, q) => {
    const facets = deriveFacets(STATE.cards, {}, q, CTX);
    expect(resultCountFromFacets(facets)).toBe(listed(q).length);
  });

  it('no facets yet → null ("Counting…")', () => {
    expect(resultCountFromFacets([])).toBeNull();
  });

  it('a FacetSheet tap toggles a value; the toggles join the Markers block', () => {
    const facets = deriveFacets(STATE.cards, {}, {}, CTX);
    const groups = sheetGroups(facets);
    const keys = groups.map((g) => g.key);
    expect(keys.slice(0, 3)).toEqual(['life', 'due', 'flags']);
    // Level (ordinal) before Type, Deck before the fields; the derived groups exist (device finding).
    expect(keys).toContain('field:level');
    expect(keys).toContain('field:type');
    expect(keys).toContain('deck');
    expect(keys).toContain('tag');
    expect(keys.indexOf('field:level')).toBeLessThan(keys.indexOf('field:type'));
    expect(keys).not.toContain('hard');
    const markers = groups.find((g) => g.key === 'flags')!;
    // Recent (young) has cards here; Hard and Leech have none, so they are left out.
    expect(markers.facets.map((f) => f.key)).toEqual(['flags', 'young']);
    expect(toggleFacetValue({}, 'field:level', 'b1')).toEqual({ fields: { level: ['b1'] } });
    expect(sheetGroupKey('young')).toBe('flags');
    expect(sheetGroupKey('field:level')).toBe('field:level');
    expect(sheetGroupKey(null)).toBeNull();
  });

  it('valueText and shortLabel: cut at a WORD boundary with "…", never in the middle of a word', () => {
    expect(valueText('B1', 1585)).toBe('B1 (1,585)');
    expect(shortLabel('Level B1', 28)).toBe('Level B1');
    expect(shortLabel('Morning Review With Two Extra Steps', 24)).toBe('Morning Review With Two…');
    const cut = shortLabel('Algo › Core Patterns › Morning Review Extra Variants', 30);
    expect(cut.endsWith('…')).toBe(true);
    const words = 'Algo › Core Patterns › Morning Review Extra Variants'.split(' ');
    for (const word of cut.slice(0, -1).split(' ')) expect(words).toContain(word);
    // One long word: cut with "…" (there is no word boundary to use).
    expect(shortLabel('Supercalifragilisticexpialidocious', 12)).toBe('Supercalifr…');
    expect(Array.from(shortLabel('🙂'.repeat(40), 10))).toHaveLength(10);
  });

  it('searchTree finds a node at any depth, with its path', () => {
    const facets = deriveFacets(STATE.cards, {}, {}, CTX);
    const tags = facets.find((f) => f.key === 'tag')!;
    const hits = searchTree(tags.values, 'core', (s) => s.toLowerCase());
    expect(hits.map((h) => h.path)).toEqual(['Algo › Core Patterns']);
    expect(searchTree(tags.values, '', (s) => s).length).toBeGreaterThanOrEqual(4);
  });
});

/* ===================================================== search (§4.2) */

describe('search — the box goes through searchParse', () => {
  const sctx = () => searchCtxFor(STATE.cards, CTX);

  it('is:flagged becomes a chip and finds the flagged card (device finding)', () => {
    const parsed = parseLive('is:flagged', sctx);
    expect(parsed.query).toEqual({ flags: ['flagged'] });
    expect(listed(parsed.query)).toEqual(['c-b1']);
  });

  it('level:b1 works because the library has a Level field; an unknown field stays text with a hint', () => {
    expect(parseLive('level:b1', sctx).query).toEqual({ fields: { level: ['b1'] } });
    const unknown = parseLive('colour:red', sctx);
    expect(unknown.query).toEqual({ text: 'colour:red' });
    expect(unknown.hints).toEqual(["No field called 'colour' here."]);
  });

  it('plain words need no parser context (it is not even built)', () => {
    let built = 0;
    const parsed = parseLive('Bahnhof  "die reise"', () => {
      built += 1;
      return sctx();
    });
    expect(built).toBe(0);
    expect(parsed.query).toEqual({ text: 'bahnhof "die reise"' });
  });

  it('a space after a complete token commits it; inside open quotes it does not', () => {
    expect(shouldCommitOnSpace('is:new ')).toBe(true);
    expect(shouldCommitOnSpace('haus ')).toBe(false); // no token: free words stay text
    expect(shouldCommitOnSpace('deck:"German Ver')).toBe(false);
    expect(shouldCommitOnSpace('deck:"German ')).toBe(false);
    expect(quotesClosed('deck:"German Verbs" ')).toBe(true);
  });

  it('commitSearch moves the chips out of the box and keeps the free words', () => {
    const start = initialLibraryState({}, LISTS);
    const parsed = parseSearch('haus is:flagged ', sctx());
    expect(parsedChips(parsed)).toBe(true);
    const next = commitSearch(start, parsed, true);
    expect(next.chips).toEqual({ flags: ['flagged'] });
    expect(next.text).toBe('haus ');
    expect(commitSearch(start, parseSearch('is:new', sctx())).text).toBe('');
    // Tokens repeat into one OR group.
    const two = commitSearch(next, parseSearch('level:a1 level:b1', sctx()));
    expect(two.chips).toEqual({ flags: ['flagged'], fields: { level: ['a1', 'b1'] } });
    expect(parsedChips(parseSearch('haus', sctx()))).toBe(false);
  });

  it('searchCtxFor is built once per cards array', () => {
    expect(searchCtxFor(STATE.cards, CTX)).toBe(searchCtxFor(STATE.cards, CTX));
    expect(searchCtxFor(STATE.cards, CTX, { decks: ['d-de'] }).base).toEqual({ decks: ['d-de'] });
    expect(searchCtxFor([...STATE.cards], CTX)).not.toBe(searchCtxFor(STATE.cards, CTX));
  });

  it('effectiveQuery = the chips AND the text; splitText is its inverse', () => {
    const q = effectiveQuery({ decks: ['d-de'] }, { text: 'bahnhof' });
    expect(q).toEqual({ decks: ['d-de'], text: 'bahnhof' });
    expect(splitText(q)).toEqual({ chips: { decks: ['d-de'] }, text: 'bahnhof' });
    expect(listed(q)).toEqual(['c-b1']);
  });

  it('the text chip × clears the box; withQuery takes the FacetSheet result', () => {
    const start = withText(initialLibraryState({}, LISTS), 'bahnhof');
    expect(removeChipFrom(start, 'text').text).toBe('');
    const fromSheet = withQuery(start, { life: ['review'], text: 'bahnhof' });
    expect(fromSheet.chips).toEqual({ life: ['review'] });
    expect(fromSheet.text).toBe('bahnhof');
    expect(withQuery(start, { life: ['review'] }).text).toBe('');
  });

  it('facetStartQuery: the FacetSheet starts from the box AS TYPED, so "Show" keeps fresh words', () => {
    // "Bahnhof" was typed 50 ms ago: the list (debounced) does not use it yet.
    const start = withText(withChips(initialLibraryState({}, LISTS), { decks: ['d-de'] }), 'Bahnhof');
    const draft = facetStartQuery(start, sctx, CTX.index);
    expect(draft).toEqual({ decks: ['d-de'], text: 'bahnhof' });
    // The user picks B1 in the sheet and taps "Show": the words stay in the box.
    const shown = withQuery(start, toggleFacetValue(draft, 'field:level', 'b1'));
    expect(shown.text).toBe('Bahnhof');
    expect(shown.chips).toEqual({ decks: ['d-de'], fields: { level: ['b1'] } });
    // A token in the box is in the draft as a chip: "Show" moves it out of the box.
    const withToken = withText(start, 'is:flagged bahnhof');
    const tokenDraft = facetStartQuery(withToken, sctx, CTX.index);
    expect(tokenDraft).toEqual({ decks: ['d-de'], flags: ['flagged'], text: 'bahnhof' });
    const moved = withQuery(withToken, toggleFacetValue(tokenDraft, 'field:level', 'b1'));
    expect(moved.chips).toEqual({ decks: ['d-de'], flags: ['flagged'], fields: { level: ['b1'] } });
    expect(moved.text).toBe('bahnhof');
  });

  it('facetsDone compares the draft with the Library NOW: "Clear all" in the sheet, then the same filter, applies it', () => {
    const b1: Query = { fields: { level: ['b1'] } };
    const opened = withChips(initialLibraryState({}, LISTS), b1);
    // The sheet opened from { Level: B1 }; its "Clear all" cleared the Library at once.
    const cleared = clearAll(opened).state;
    // The learner picks B1 again: the draft equals the query the sheet OPENED with, but not the Library.
    const next = facetsDone(cleared, b1, sctx, CTX.index);
    expect(next).not.toBeNull();
    expect(next!.chips).toEqual(b1);
    expect(listed(effectiveQuery(next!.chips, {})).sort()).toEqual(['c-b1', 'c-b2', 'c-b3']);
    // Nothing changed in the sheet → nothing to apply (the list is not sorted again).
    expect(facetsDone(opened, b1, sctx, CTX.index)).toBeNull();
    // "Clear all" and then close: the Library is cleared already, nothing more to do.
    expect(facetsDone(cleared, {}, sctx, CTX.index)).toBeNull();
    // The box as typed counts as the Library's query too (the debounce never fools it).
    const typed = withText(opened, 'bahnhof');
    expect(facetsDone(typed, { ...b1, text: 'bahnhof' }, sctx, CTX.index)).toBeNull();
  });
});

/* ======================================================== rows (§8.3) */

describe('rows — status word, badge, direction', () => {
  const byId = (id: string) => STATE.cards.find((c) => c.id === id)!;

  it('rowStatus: the status word, and when a studied card comes back', () => {
    expect(rowStatus(byId('c-a3'), NOW)).toEqual({ key: 'notStarted', text: 'Not started' });
    expect(rowStatus(byId('c-a1'), NOW)).toEqual({ key: 'new', text: 'New' });
    expect(rowStatus(byId('c-b1'), NOW)).toEqual({ key: 'review', text: 'Review · next 3d' });
    expect(rowStatus(byId('c-b2'), NOW)).toEqual({ key: 'learning', text: 'Learning · due' });
    expect(rowStatus(byId('c-b3'), NOW)).toEqual({ key: 'known', text: 'Known' });
    expect(rowStatus({ ...byId('c-b1'), due: Number.NaN }, NOW).text).toBe('Review · due');
  });

  it('ordinalFields: Level is ordinal (CEFR), Type is not; built once per index', () => {
    const fields = ordinalFields(CTX.index);
    expect(fields).toEqual([{ key: 'level', label: 'Level', kind: 'cefr' }]);
    expect(ordinalFields(CTX.index)).toBe(fields);
  });

  it('rowBadge: the card’s Level ("B1"), none for a card without one', () => {
    const fields = ordinalFields(CTX.index);
    expect(rowBadge(byId('c-b1'), CTX.index, fields)).toEqual({ value: 'B1', label: 'Level', kind: 'cefr' });
    expect(rowBadge(byId('c-es2'), CTX.index, fields)).toBeNull();
    expect(rowBadge(byId('c-b1'), CTX.index, [])).toBeNull();
  });

  it('summarizeRows: Not started and due counts; a direction only with 2+ DIFFERENT directions', () => {
    const dirLabel = directionLabeler(CTX.index, CTX.decks);
    const all = summarizeRows(STATE.cards, NOW, dirLabel);
    expect(all.notStarted).toBe(2);
    expect(all.dueNow).toBe(1); // b2 (learning, due a minute ago); reviews are due in 3 days
    expect(all.directions).toBe(true);
    expect(dirLabel(byId('c-es1-0'))).toBe('Spanish → English');
    expect(dirLabel(byId('c-es1-1'))).toBe('English → Spanish');
    const german = STATE.cards.filter((c) => c.deckId === 'd-de');
    expect(summarizeRows(german, NOW, dirLabel).directions).toBe(false);
  });

  it('fieldsWithValues + suggestionChips: real groups of the scope only', () => {
    const fields = ordinalFields(CTX.index);
    const summary = summarizeRows(STATE.cards, NOW, directionLabeler(CTX.index, CTX.decks));
    expect(fieldsWithValues(STATE.cards, CTX.index, fields).map((f) => f.key)).toEqual(['level']);
    // One level only → no Level suggestion.
    const b1 = STATE.cards.filter((c) => ['c-b1', 'c-b2'].includes(c.id));
    expect(fieldsWithValues(b1, CTX.index, fields)).toEqual([]);
    const chips = suggestionChips(summary, {}, fieldsWithValues(STATE.cards, CTX.index, fields));
    expect(chips.map((s) => s.label)).toEqual(['Level', 'Not started', 'Due now']);
    expect(chips[0].facet).toBe('field:level');
    expect(chips[1].add).toEqual({ life: ['notStarted'] });
    expect(chips[2].add).toEqual({ due: 'now' });
    // Already a chip → not suggested again.
    expect(suggestionChips(summary, { life: ['new'], due: 'today' }, []).map((s) => s.id)).toEqual([]);
  });

  it('rowHeight: fixed (for getItemLayout), grows with the font size up to the cap', () => {
    expect(rowHeight(1)).toBe(rowHeight(1));
    expect(rowHeight(1.3)).toBeGreaterThan(rowHeight(1));
    expect(rowHeight(3)).toBe(rowHeight(1.5));
    expect(rowHeight(0.8)).toBe(rowHeight(1));
    expect(rowHeight(Number.NaN)).toBe(rowHeight(1));
  });
});

/* ========================================================= sort (§8.3) */

describe('sort menu', () => {
  it('the fixed entries, then one per ordinal group (Level)', () => {
    const options = sortOptions(ordinalFields(CTX.index));
    expect(options.map((o) => o.label)).toEqual(['Deck order', 'Due date', 'A–Z', 'Recently added', 'Hardest first', 'Level']);
    expect(options[5].sort).toEqual({ by: 'field', field: 'level' });
    expect(sortLabel({ by: 'field', field: 'level' }, options)).toBe('Level');
    expect(sortLabel({ by: 'field', field: 'gone' }, options)).toBe('Deck order');
    expect(sortId({ by: 'az' })).toBe('az');
    expect(withSort(initialLibraryState({}, LISTS), { by: 'az' }).sort).toEqual({ by: 'az' });
  });

  it('A–Z sorts German terms by the word, not the article (device finding)', () => {
    const german = scopePool(STATE, { decks: ['d-de'] }, CTX, 'browse');
    const words = sortScopeCards(german, { by: 'az' }, STATE, CTX).map((c) => c.noteId);
    // das Anliegen, die Abfahrt → A; der Bahnhof → B; gehen; laufen; die Reise → R
    expect(words).toEqual(['a2', 'a1', 'b1', 'a3', 'b2', 'b3']);
  });
});

/* ========================================================== lists (§4.7) */

describe('lists — From list · Update list · Save as new list', () => {
  it('unchanged: no update offered; changed: "Update list" for a user list', () => {
    const same = listLine('l-b1', LISTS, { fields: { type: ['verb'], level: ['b1'] } })!;
    expect(same.changed).toBe(false);
    expect(same.canUpdate).toBe(false);
    const changed = listLine('l-b1', LISTS, { fields: { level: ['b1'] } })!;
    expect(changed.changed).toBe(true);
    expect(changed.canUpdate).toBe(true);
  });

  it('a built-in list is code: changed chips offer only "Save as new list"', () => {
    const line = listLine('builtin:favorites', LISTS, { flags: ['fav'], decks: ['d-de'] })!;
    expect(line.text).toBe("From list 'Favorites'");
    expect(line.changed).toBe(true);
    expect(line.canUpdate).toBe(false);
  });

  it('every chip of a list removed → no "Update list" (it would save a list of everything)', () => {
    const line = listLine('l-b1', LISTS, {})!;
    expect(line.text).toBe("From list 'B1 verbs'");
    expect(line.changed).toBe(true);
    expect(line.canUpdate).toBe(false);
    // Only a list key left (no chip) is empty too.
    expect(listLine('l-b1', LISTS, { list: 'l-b1' })!.canUpdate).toBe(false);
    // One chip is enough to offer it again.
    expect(listLine('l-b1', LISTS, { text: 'laufen' })!.canUpdate).toBe(true);
  });

  it('no list, or a list that is gone → no line', () => {
    expect(listLine(null, LISTS, {})).toBeNull();
    expect(listLine('l-gone', LISTS, {})).toBeNull();
  });

  it('savedAsList shows the new list; the suggested name is the chips, at most 40 characters', () => {
    expect(savedAsList(initialLibraryState({}, LISTS), 'l-new').fromList).toBe('l-new');
    expect(defaultListName(['Level: B1', 'Not started'])).toBe('Level: B1 · Not started');
    expect(Array.from(defaultListName(['Deck: German Vocabulary Complete', 'Level: A1, A2, B1, B2'])).length).toBeLessThanOrEqual(40);
  });
});

/* ========================================================= routes */

describe('routes — every number opens exactly its query', () => {
  const q: Query = { decks: ['d-de'], fields: { level: ['b1'] } };

  it('Study / Practice carry the query as JSON; Practice also the sort', () => {
    expect(studyRoute(q, 'German')).toEqual({
      pathname: '/session',
      params: { kind: 'scheduled', q: serializeQuery(q), label: 'German' },
    });
    const practice = practiceQueryRoute(q, { by: 'az' }, 'German');
    expect(practice.params.kind).toBe('practice');
    expect(parseQueryParam(practice.params.q)).toEqual(q);
    expect(JSON.parse(practice.params.sort)).toEqual({ by: 'az' });
  });

  it('Practice of selected cards: a token, never card ids in the URL', () => {
    const route = practiceSelectionRoute('sel-abc', '12 selected cards');
    expect(route).toEqual({ pathname: '/session', params: { kind: 'practice', sel: 'sel-abc', label: '12 selected cards' } });
    expect(JSON.stringify(route)).not.toContain('c-');
  });

  it('Choose (n) → /triage?q=…&sort=…', () => {
    const href = triageHref(q, DEFAULT_SORT);
    expect(href.startsWith('/triage?q=')).toBe(true);
    const params = new URLSearchParams(href.slice(href.indexOf('?') + 1));
    expect(parseQueryParam(params.get('q'))).toEqual(q);
    expect(JSON.parse(params.get('sort')!)).toEqual({ by: 'source' });
  });

  it('the FAB: the only Deck chip; else the one deck of the Section chips; else the last used deck', () => {
    const last = () => 'd-last';
    expect(fabDeckId({ decks: ['d-de'] }, CTX.decks, last)).toBe('d-de');
    expect(fabDeckId({ decks: ['d-de', 'd-es'] }, CTX.decks, last)).toBe('d-last');
    expect(fabDeckId({ sections: [{ deckId: 'd-es', path: 'verbs' }] }, CTX.decks, last)).toBe('d-es');
    expect(fabDeckId({ decks: ['d-gone'] }, CTX.decks, last)).toBe('d-last');
    expect(fabDeckId({}, CTX.decks, () => null)).toBeNull();
    expect(newCardRoute('d-de')).toEqual({ pathname: '/card-editor', params: { deckId: 'd-de' } });
    expect(newCardRoute(null)).toEqual({ pathname: '/card-editor', params: {} });
  });

  it('sessionLabel: the list name when unchanged, else the chips, else "Library"', () => {
    const line = listLine('l-b1', LISTS, B1_VERBS.query);
    expect(sessionLabel(['Level: B1', 'Type: verb'], line)).toBe('B1 verbs');
    expect(sessionLabel(['Level: B1'], listLine('l-b1', LISTS, { fields: { level: ['b1'] } }))).toBe('Level: B1');
    expect(sessionLabel([], null)).toBe('Library');
  });
});

/* ===================================================== snackbars and tags */

describe('bulk snackbars and tags', () => {
  it('editSnack: the edit’s own label with Undo; an edit that is not in the log → the fallback, no Undo', () => {
    const log = [{ id: 'edit-1', label: '12 cards suspended' }];
    expect(editSnack(log, 'edit-1', 'x')).toEqual({ text: '12 cards suspended', undoable: true });
    expect(editSnack(log, 'edit-2', '3 cards flagged')).toEqual({ text: '3 cards flagged', undoable: false });
    expect(editSnack(undefined, '', 'nothing')).toEqual({ text: 'nothing', undoable: false });
  });

  it('tagCountsOf counts cards per tag (every direction of an item); libraryTags counts items', () => {
    const spanish = STATE.cards.filter((c) => c.deckId === 'd-es');
    expect(tagCountsOf(spanish, CTX.index)).toEqual([
      { tag: 'verb', count: 2 },
      { tag: 'Algo::Core_Patterns', count: 1 },
      { tag: 'noun', count: 1 },
    ]);
    expect(libraryTags(CTX.index).map((t) => t.tag)).toEqual(['Algo::Core_Patterns', 'noun', 'verb']);
    expect(libraryTags(CTX.index)).toBe(libraryTags(CTX.index));
  });

  it('noteIdsOf: each item once (a move or a tag changes whole items)', () => {
    const spanish = STATE.cards.filter((c) => c.deckId === 'd-es');
    expect(noteIdsOf(spanish)).toEqual(['es1', 'es2']);
  });
});

/* ===================================================== perfMarks.timedSelector */

describe('perfMarks.timedSelector — times only real computations', () => {
  it('a cache hit (the same object back) is not recorded; a new value is', () => {
    let tick = 0;
    const marks = createPerfMarks({ enabled: true, clock: () => (tick += 5) });
    let value: number[] = [1];
    const selector = (s: { n: number }) => {
      if (s.n !== value.length) value = Array.from({ length: s.n }, (_, i) => i);
      return value;
    };
    const timed = timedSelector('filter', selector, (v) => plural(v.length, 'card'), marks);
    timed({ n: 1 });
    timed({ n: 1 });
    timed({ n: 3 });
    expect(marks.entries().map((e) => [e.name, e.detail])).toEqual([
      ['filter', '1 card'],
      ['filter', '3 cards'],
    ]);
    expect(marks.entries().every((e) => e.ms === 5)).toBe(true);
  });

  it('switched off (a release build): the selector itself, no clock', () => {
    const marks = createPerfMarks({ enabled: false, clock: () => {
      throw new Error('no clock in a release build');
    } });
    const selector = (s: number) => s * 2;
    expect(timedSelector('facets', selector, undefined, marks)).toBe(selector);
  });
});

/* ====================================== the list's clock (review round 2) */

describe('listClock — the list is filtered again on a clock tick only when its query reads the clock', () => {
  const DUE_LIST: ListDef = { id: 'l-due', name: 'Due today', icon: '⏰', query: { due: 'today' }, createdAt: NOW, updatedAt: NOW };
  const lists = listsById([B1_VERBS, DUE_LIST]);

  it('0 for every query without a due group or the buried marker (built-in and user lists too)', () => {
    const clockFree: Query[] = [
      {},
      { decks: ['d-de'] },
      { flags: ['flagged'] },
      { notFlags: ['suspended'] },
      { life: ['new', 'notStarted'] },
      { fields: { level: ['b1'] } },
      { tags: ['verb'] },
      { text: 'bahnhof' },
      { hard: true },
      { list: 'l-b1' },
      { list: 'builtin:recent' },
      { list: 'gone' },
    ];
    for (const q of clockFree) expect(listClock(q, lists, NOW)).toBe(0);
  });

  it('now for a due group, the buried marker (in or not in), or a list whose query has one', () => {
    const clocked: Query[] = [
      { due: 'now' },
      { due: 'today' },
      { flags: ['buried'] },
      { flags: ['flagged', 'buried'] },
      { notFlags: ['buried'] },
      { list: 'l-due' },
    ];
    for (const q of clocked) expect(listClock(q, lists, NOW)).toBe(NOW);
  });

  it('with 0 the rows are exactly the rows at the real time, for every sort (so a tick may keep them)', () => {
    const state: DataStateV3 = { ...STATE, lists: [B1_VERBS] };
    const userLists = listsById(state.lists);
    const later = NOW + 40 * DAY;
    const queries: Query[] = [{}, { decks: ['d-de'] }, { flags: ['flagged'] }, { list: 'l-b1' }, { text: 'meaning' }];
    for (const q of queries) {
      expect(listClock(q, userLists, later)).toBe(0);
      for (const option of sortOptions(ordinalFields(CTX.index))) {
        const ids = (t: number) =>
          sortedPoolReader(serializeQuery(q), JSON.stringify(option.sort), t)(state).map((card) => card.id);
        expect(ids(0)).toEqual(ids(NOW));
        expect(ids(0)).toEqual(ids(later));
      }
    }
  });
});

/* ===================================================== perf guard (16k) */

describe('perf guard — the Library list of a 16,000-card library (spec §8.3, §11 E2)', () => {
  /** A German_Complete-like library: 8,000 legacy notes with a reverse-free type, 2 cards each via 2 decks. */
  function bigState(): DataStateV3 {
    const type: NoteType = {
      id: 'nt-big',
      name: 'Big',
      kind: 'standard',
      fields: [
        { name: 'Word', role: 'term', facet: 'off', lang: 'de-DE' },
        { name: 'Meaning', role: 'meaning', facet: 'off', lang: 'en-US' },
        { name: 'Level', role: 'badge', facet: 'auto' },
      ],
      templates: [
        { ord: 0, name: 'DE-EN', prompt: [0], answer: [1] },
        { ord: 1, name: 'EN-DE', prompt: [1], answer: [0] },
      ],
      sortField: 0,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const levels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
    const notes: Note[] = [];
    const cards: Card[] = [];
    for (let i = 0; i < 8000; i++) {
      const note = makeNote(
        { id: `n${i}`, typeId: type.id, fields: [`${i % 3 === 0 ? 'die ' : 'der '}Wort${i}`, `word ${i}`, levels[i % 6]], order: i, section: `Vocabulary::${levels[i % 6]}` },
        NOW,
      );
      notes.push(note);
      for (const ord of [0, 1]) {
        const studied = i % 4 === 0 ? { reps: 3, stepIndex: null, intervalDays: 5, due: NOW + (i % 9) * DAY } : {};
        cards.push(makeCard(note, ord, 'd-big', DEFAULT_SRS, NOW, { id: `c${i}-${ord}`, ...studied }));
      }
    }
    return stateOfV3({ decks: [makeDeckV3({ id: 'd-big', name: 'German' })], types: [type], overrides: { notes, cards, noteTypes: [type] } });
  }

  it('filter + sort (Deck order) + the header summary: < 150 ms in node, best of 3', () => {
    const state = bigState();
    expect(state.cards).toHaveLength(16_000);
    const times: number[] = [];
    for (let run = 0; run < 3; run++) {
      // A fresh index each run (cold caches), built before the clock starts — like the store does.
      // Destructured: the face guard (face.test.ts) forbids a direct property read of the notes here.
      const { notes: bigNotes, noteTypes } = state;
      const ctx = { ...matchCtxOf(state, NOW), index: buildLibraryIndex(bigNotes, noteTypes) };
      const start = performance.now();
      const rows = sortScopeCards(scopePool(state, { fields: { level: ['b1', 'b2'] } }, ctx, 'browse'), DEFAULT_SORT, state, ctx);
      summarizeRows(rows, NOW, directionLabeler(ctx.index, ctx.decks));
      // Wave 5c: the "Choose ({n})" items are counted with every new list too.
      chooseCount(rows, state.cards, ctx);
      times.push(performance.now() - start);
      // Levels B1 and B2: 2,666 of the 8,000 items, both directions.
      expect(rows).toHaveLength(5332);
    }
    expect(Math.min(...times)).toBeLessThan(150);
  });

  it('the heaviest sort, A–Z over all 16,000 cards with cold faces: < 400 ms in node, best of 3', () => {
    const state = bigState();
    const times: number[] = [];
    for (let run = 0; run < 3; run++) {
      // Fresh note objects: the faces and sort keys are cached per note object, so this run is cold.
      const { notes: original } = state;
      const notes = original.map((n) => ({ ...n }));
      const cold = { ...state, notes };
      const ctx = { ...matchCtxOf(cold, NOW), index: buildLibraryIndex(notes, cold.noteTypes) };
      const start = performance.now();
      const rows = sortScopeCards(scopePool(cold, {}, ctx, 'browse'), { by: 'az' }, cold, ctx);
      times.push(performance.now() - start);
      expect(rows).toHaveLength(16_000);
    }
    expect(Math.min(...times)).toBeLessThan(400);
  });

  it('selecting all 16,000 keeps ONE query object, never 16,000 ids', () => {
    const state = selectAll(initialLibraryState({}, LISTS), {});
    expect(JSON.stringify(state.selection).length).toBeLessThan(100);
    expect(sameQuery((state.selection as { query: Query }).query, {})).toBe(true);
  });
});

/* ============================================ Part 2 — the screen's wiring */

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  mockState = fixture();
  mockParams = {};
  mockNow = FIXED_NOW;
  mockUseNow = () => mockNow;
  mockDeleted.clear();
  mockSnackChannel.snack = null;
});

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
  jest.clearAllMocks();
});

function renderScreen(): ReactTestRenderer {
  act(() => {
    renderer = TestRenderer.create(React.createElement(LibraryScreen));
  });
  return renderer!;
}

/** Render again (the mocked store has no subscription: a change needs a re-render). */
function rerender(r: ReactTestRenderer) {
  act(() => r.update(React.createElement(LibraryScreen)));
}

/** Every text on screen (host Text nodes only). */
function texts(r: ReactTestRenderer): string[] {
  return r.root
    .findAll((n) => (n.type as unknown) === 'Text')
    .map((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children ?? '')));
}

/** The pressable (composite, with onPress) with this screen-reader label. */
function byLabel(r: ReactTestRenderer, label: string): ReactTestInstance | undefined {
  return r.root.findAll(
    (n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  )[0];
}

/** The nearest pressable around the text `text`. */
function byText(r: ReactTestRenderer, text: string): ReactTestInstance {
  const node = r.root.findAll((n) => (n.type as unknown) === 'Text' && n.props.children === text)[0];
  if (!node) throw new Error(`no text ${text}`);
  let at: ReactTestInstance | null = node;
  while (at && typeof at.props.onPress !== 'function') at = at.parent;
  if (!at) throw new Error(`no pressable around ${text}`);
  return at;
}

/** Press the nearest pressable around the text `text` inside one part of the screen (a sheet). */
function pressIn(root: ReactTestInstance, text: string): void {
  const node = root.findAll((n) => (n.type as unknown) === 'Text' && n.props.children === text)[0];
  if (!node) throw new Error(`no text ${text}`);
  let at: ReactTestInstance | null = node;
  while (at && typeof at.props.onPress !== 'function') at = at.parent;
  if (!at) throw new Error(`no pressable around ${text}`);
  at.props.onPress();
}

/** The search box. */
function searchBox(r: ReactTestRenderer): ReactTestInstance {
  return r.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === 'Search cards')[0];
}

/** The LibraryRow elements the list draws. */
function rows(r: ReactTestRenderer): ReactTestInstance[] {
  const seen = new Set<string>();
  return r.root
    .findAll((n) => typeof n.type !== 'string' && n.props.card !== undefined && 'selecting' in n.props && 'fields' in n.props)
    .filter((n) => {
      const id = (n.props.card as Card).id;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
}

/** The card ids of the rows the list draws. */
function rowIds(r: ReactTestRenderer): string[] {
  return rows(r).map((n) => (n.props.card as Card).id);
}

function lastUndo(): () => void {
  const call = mockShow.mock.calls[mockShow.mock.calls.length - 1];
  const action = call?.[1];
  if (!action) throw new Error('the last snackbar had no Undo');
  return action.onAction;
}

const ctxNow = () => matchCtxOf(mockState, NOW);

describe('Library screen — route params and Clear all', () => {
  it('applies q + nonce on the first render: the chip, the count and the rows', () => {
    mockParams = routeTo({ decks: ['d-es'] }, '1');
    const r = renderScreen();
    expect(texts(r)).toEqual(expect.arrayContaining(['Deck: Spanish', '3 cards ·']));
    expect(rowIds(r).sort()).toEqual(['c-es1-0', 'c-es1-1', 'c-es2']);
  });

  it('a new nonce with the same q applies again; the same nonce does not undo the user’s edit', () => {
    mockParams = routeTo({ decks: ['d-es'] }, '1');
    const r = renderScreen();
    act(() => byLabel(r, 'Remove filter Deck: Spanish')!.props.onPress());
    expect(texts(r)).not.toContain('Deck: Spanish');
    rerender(r);
    expect(texts(r)).not.toContain('Deck: Spanish');
    mockParams = routeTo({ decks: ['d-es'] }, '2');
    rerender(r);
    expect(texts(r)).toContain('Deck: Spanish');
  });

  it('a list opens as its chips with "From list"; Clear all removes every chip AND the route params', () => {
    mockState = { ...mockState, lists: [B1_VERBS] };
    mockParams = routeTo({ list: 'l-b1' }, '3');
    const r = renderScreen();
    expect(texts(r)).toEqual(expect.arrayContaining(['Level: B1', 'Type: verb', "From list 'B1 verbs'"]));
    expect(rowIds(r)).toEqual(['c-b2']);
    act(() => byText(r, 'Clear all').props.onPress());
    expect(mockSetParams).toHaveBeenCalledWith({ q: undefined, nonce: undefined, newList: undefined });
    expect(texts(r)).not.toContain('Level: B1');
    expect(texts(r)).not.toContain("From list 'B1 verbs'");
    expect(rowIds(r)).toHaveLength(mockState.cards.length);
  });
});

describe('Library screen — search, numbers and result buttons', () => {
  it('"is:flagged " turns into a chip and finds the flagged card; the row says Flagged', () => {
    const r = renderScreen();
    act(() => searchBox(r).props.onChangeText('is:flagged '));
    expect(texts(r)).toContain('Flagged');
    expect(rowIds(r)).toEqual(['c-b1']);
    expect(searchBox(r).props.value).toBe('');
    const label = r.root.findAll(
      (n) =>
        typeof n.type !== 'string' &&
        typeof n.props.accessibilityLabel === 'string' &&
        n.props.accessibilityLabel.startsWith('der Bahnhof') &&
        typeof n.props.onPress === 'function',
    )[0].props.accessibilityLabel as string;
    expect(label).toContain('Flagged');
    expect(label).toContain('Level: B1');
  });

  it('free words are debounced, accent-folded text', async () => {
    const r = renderScreen();
    act(() => searchBox(r).props.onChangeText('BAHNHOF'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(rowIds(r)).toEqual(['c-b1']);
  });

  it('"Study {n}" is readyFor of the chips and opens exactly that query; Practice and Choose too', () => {
    mockParams = routeTo({ decks: ['d-de'] }, '1');
    const r = renderScreen();
    const q: Query = { decks: ['d-de'] };
    const ready = readyFor(mockState, q, ctxNow()).total;
    const practice = buildSessionQueue({ kind: 'practice', q, sort: null }, mockState, ctxNow()).length;
    expect(ready).toBeGreaterThan(0);
    act(() => byText(r, `Study ${ready}`).props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith(studyRoute(q, 'Deck: German'));
    act(() => byText(r, `Practice ${practice}`).props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith(practiceQueryRoute(q, DEFAULT_SORT, 'Deck: German'));
    act(() => byText(r, 'Choose (1)').props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith(triageHref(q, DEFAULT_SORT));
  });

  it('a button with 0 is hidden (no "Study 0", no "Choose (0)")', () => {
    mockParams = routeTo({ flags: ['suspended'] }, '1');
    const r = renderScreen();
    const all = texts(r);
    expect(all.some((t) => t.startsWith('Study '))).toBe(false);
    expect(all.some((t) => t.startsWith('Choose ('))).toBe(false);
  });

  it('"Save as list" saves the chips, pins the list on Today and shows "From list"', () => {
    mockParams = routeTo({ fields: { level: ['b1'] } }, '1');
    const r = renderScreen();
    act(() => byText(r, 'Save as list').props.onPress());
    act(() => byText(r, 'Save list').props.onPress());
    expect(mockActions.saveList).toHaveBeenCalledTimes(1);
    const saved = mockState.lists[0];
    expect(saved.query).toEqual({ fields: { level: ['b1'] } });
    expect(mockState.listPrefs[saved.id]?.pinned).toBe(true);
    rerender(r);
    expect(texts(r)).toContain(`From list '${saved.name}'`);
  });
});

describe('Library screen — select mode', () => {
  it('Select all → the bulk bar has REAL toggles; Unflag → setFlags on the cards, with Undo', () => {
    mockParams = routeTo({ flags: ['flagged'] }, '1');
    const r = renderScreen();
    act(() => byText(r, 'Select').props.onPress());
    act(() => byText(r, 'Select all 1').props.onPress());
    expect(texts(r)).toEqual(expect.arrayContaining(['1 selected', 'Favorite', 'Unflag', 'Suspend']));
    act(() => byLabel(r, 'Unflag')!.props.onPress());
    expect(mockActions.setFlags).toHaveBeenCalledWith(['c-b1'], { flagged: false });
    expect(mockState.cards.find((c) => c.id === 'c-b1')!.flagged).toBe(false);
    expect(mockShow).toHaveBeenLastCalledWith('1 card unflagged', expect.objectContaining({ onAction: expect.any(Function) }));
    rerender(r);
    // Walkthrough L16 (changed): the card left the Flagged list, so nothing
    // selected is visible any more — select mode ends by itself. The
    // snackbar's Undo is the way back.
    expect(texts(r)).not.toContain('1 selected');
    expect(texts(r)).toContain('Select');
    expect(r.root.findAllByType(BulkBar)).toHaveLength(0);
    act(() => lastUndo()());
    expect(mockState.cards.find((c) => c.id === 'c-b1')!.flagged).toBe(true);
  });

  it('mixed selection → "Favorite" sets it on every card', () => {
    mockParams = routeTo({ decks: ['d-de'], life: ['new', 'notStarted'] }, '1');
    const r = renderScreen();
    act(() => byText(r, 'Select').props.onPress());
    act(() => byText(r, 'Select all 2').props.onPress());
    act(() => byLabel(r, 'Favorite')!.props.onPress());
    const ids = ['c-a1', 'c-a3'];
    expect(mockActions.setFlags).toHaveBeenCalledWith(expect.arrayContaining(ids), { fav: true });
    for (const id of ids) expect(mockState.cards.find((c) => c.id === id)!.fav).toBe(true);
  });

  it('More → "Mark as known" changes the selected cards and ends select mode, with Undo', () => {
    mockParams = routeTo({ decks: ['d-es'] }, '1');
    const r = renderScreen();
    act(() => byText(r, 'Select').props.onPress());
    act(() => byText(r, 'Select all 3').props.onPress());
    act(() => byLabel(r, 'More')!.props.onPress());
    act(() => byText(r, 'Mark as known').props.onPress());
    expect(mockActions.markKnown).toHaveBeenCalledWith(expect.arrayContaining(['c-es1-0', 'c-es1-1', 'c-es2']));
    expect(mockShow).toHaveBeenLastCalledWith(
      '3 cards marked as known',
      expect.objectContaining({ onAction: expect.any(Function) }),
    );
    expect(texts(r)).not.toContain('3 selected');
    act(() => lastUndo()());
    expect(mockState.cards.filter((c) => c.deckId === 'd-es').every((c) => c.knownAt == null)).toBe(true);
  });

  it('More → "Delete 3 cards…" deletes whole items after the hold, and Undo brings them back', () => {
    mockParams = routeTo({ decks: ['d-es'] }, '1');
    const r = renderScreen();
    act(() => byText(r, 'Select').props.onPress());
    act(() => byText(r, 'Select all 3').props.onPress());
    act(() => byLabel(r, 'More')!.props.onPress());
    act(() => byText(r, 'Delete 3 cards…').props.onPress());
    const hold = r.root.findAll(
      (n) => typeof n.type !== 'string' && n.props.accessibilityLabel === 'Hold to delete' && n.props.onAccessibilityAction,
    )[0];
    act(() => hold.props.onAccessibilityAction({ nativeEvent: { actionName: 'longpress' } }));
    expect(mockActions.deleteNotes).toHaveBeenCalledWith(['es1', 'es2']);
    expect(mockState.cards.some((c) => c.deckId === 'd-es')).toBe(false);
    expect(mockShow).toHaveBeenLastCalledWith('3 cards deleted', expect.objectContaining({ onAction: expect.any(Function) }));
    act(() => lastUndo()());
    expect(mockState.cards.filter((c) => c.deckId === 'd-es')).toHaveLength(3);
  });

  it('"Select all" tapped within the 150 ms debounce selects the rows the learner SEES, never hidden cards', () => {
    const r = renderScreen();
    act(() => byText(r, 'Select').props.onPress());
    act(() => searchBox(r).props.onChangeText('bahnhof'));
    // No wait: the debounced list still shows every card.
    const all = mockState.cards.length;
    expect(rowIds(r)).toHaveLength(all);
    act(() => byText(r, `Select all ${all}`).props.onPress());
    // The list caught up with the box at once: one row, drawn selected, and the header agrees.
    expect(rowIds(r)).toEqual(['c-b1']);
    expect(rows(r).map((n) => n.props.selected)).toEqual([true]);
    expect(texts(r)).toContain('1 selected');
    // The toggles are about that one card (it is flagged → "Unflag"), and change only it.
    act(() => byLabel(r, 'Unflag')!.props.onPress());
    expect(mockActions.setFlags).toHaveBeenCalledWith(['c-b1'], { flagged: false });
    expect(mockState.cards.filter((c) => c.flagged).map((c) => c.id)).toEqual([]);
  });

  it('the bulk bar draws an active toggle with its outline (theme tokens)', () => {
    mockParams = routeTo({ flags: ['flagged'] }, '1');
    const r = renderScreen();
    act(() => byText(r, 'Select').props.onPress());
    act(() => byText(r, 'Select all 1').props.onPress());
    expect(r.root.findAllByType(BulkBar)).toHaveLength(1);
    const k = bulkBarColors(light);
    const styleOf = (label: string) => {
      const node = r.root.findAll(
        (n) => (n.type as unknown) === 'View' && n.props.accessibilityLabel === label && n.props.accessibilityState,
      )[0];
      const style = node.props.style as Record<string, unknown> | Record<string, unknown>[];
      return Object.assign({}, ...(Array.isArray(style) ? style : [style])) as Record<string, unknown>;
    };
    expect(styleOf('Unflag')).toMatchObject({ borderColor: k.activeBorder, backgroundColor: k.activeBg });
    expect(styleOf('Favorite')).toMatchObject({ borderColor: 'transparent', backgroundColor: k.idleBg });
  });

  it('a row tap opens the CardSheet; in select mode it selects instead', () => {
    const r = renderScreen();
    const b1 = () => rows(r).find((n) => (n.props.card as Card).id === 'c-b1')!;
    act(() => b1().props.onPress('c-b1'));
    expect(r.root.findByType(CardSheet).props).toMatchObject({ cardId: 'c-b1', open: true });
    act(() => r.root.findByType(CardSheet).props.onClose());
    expect(r.root.findByType(CardSheet).props.open).toBe(false);
    act(() => byText(r, 'Select').props.onPress());
    act(() => b1().props.onPress('c-b1'));
    expect(texts(r)).toContain('1 selected');
    expect(b1().props.selected).toBe(true);
  });
});

describe('Library screen — empty states, FAB and filters', () => {
  it('no match → "Remove {best chip}" and Clear all', () => {
    mockParams = routeTo({ fields: { level: ['b1'] }, flags: ['suspended'] }, '1');
    const r = renderScreen();
    expect(texts(r)).toEqual(expect.arrayContaining(['Remove Suspended', 'Clear all']));
    act(() => byText(r, 'Remove Suspended').props.onPress());
    expect(rowIds(r).sort()).toEqual(['c-b1', 'c-b2', 'c-b3']);
  });

  it('no match because of a token still in the box → "Remove Suspended" really removes it', async () => {
    mockParams = routeTo({ fields: { level: ['b1'] } }, '1');
    const r = renderScreen();
    // Typed, but no space and no Return: still text in the box, not a chip yet.
    act(() => searchBox(r).props.onChangeText('is:suspended'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(rowIds(r)).toEqual([]);
    expect(texts(r)).toContain('Remove Suspended');
    act(() => byText(r, 'Remove Suspended').props.onPress());
    expect(searchBox(r).props.value).toBe('');
    expect(texts(r)).toContain('Level: B1');
    expect(rowIds(r).sort()).toEqual(['c-b1', 'c-b2', 'c-b3']);
  });

  it('a list with every chip removed offers no "Update list" (only Clear all)', () => {
    mockState = { ...mockState, lists: [B1_VERBS] };
    mockParams = routeTo({ list: 'l-b1' }, '3');
    const r = renderScreen();
    act(() => byLabel(r, 'Remove filter Level: B1')!.props.onPress());
    expect(texts(r)).toContain('Update list');
    act(() => byLabel(r, 'Remove filter Type: verb')!.props.onPress());
    expect(texts(r)).toContain("From list 'B1 verbs'");
    expect(texts(r)).not.toContain('Update list');
    expect(texts(r)).not.toContain('Save as new list');
    expect(texts(r)).toContain('Clear all');
  });

  it('an empty library → "Your library is empty." with Import a file / Make my own deck', () => {
    mockState = stateOfV3({ decks: [] });
    const r = renderScreen();
    expect(texts(r)).toContain('Your library is empty.');
    act(() => byText(r, 'Import a file').props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith('/import');
    act(() => byText(r, 'Make my own deck').props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith('/deck-editor');
  });

  it('the FAB "Add a card" opens the card editor in the only Deck chip’s deck', () => {
    mockParams = routeTo({ decks: ['d-es'] }, '1');
    const r = renderScreen();
    act(() => byLabel(r, 'Add a card')!.props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/card-editor', params: { deckId: 'd-es' } });
  });

  it('"+ Filter" opens the FacetSheet with the derived groups (Level, Type, Tags); a tap + "Show" applies it', async () => {
    const r = renderScreen();
    act(() => byLabel(r, 'Add a filter')!.props.onPress());
    expect(r.root.findByType(FacetSheet).props.open).toBe(true);
    // The counts come one tick after the sheet opens.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const all = texts(r);
    expect(all).toEqual(expect.arrayContaining(['Level', 'Type', 'Tags', 'Status', 'B1 (3)', 'A1 (2)']));
    act(() => byText(r, 'B1 (3)').props.onPress());
    expect(texts(r)).toContain('Show 3 cards');
    act(() => byText(r, 'Show 3 cards').props.onPress());
    expect(r.root.findByType(FacetSheet).props.open).toBe(false);
    expect(texts(r)).toContain('Level: B1');
    expect(rowIds(r).sort()).toEqual(['c-b1', 'c-b2', 'c-b3']);
  });

  it('Filters opened right after typing (within the 150 ms debounce): "Show" keeps the typed words', async () => {
    const r = renderScreen();
    act(() => searchBox(r).props.onChangeText('bahnhof'));
    // No wait: the debounced list text is still empty.
    act(() => byLabel(r, 'Add a filter')!.props.onPress());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The counts already use the typed word: one card, "der Bahnhof" (B1, flagged).
    expect(texts(r)).toEqual(expect.arrayContaining(['All cards here are B1.', 'Flagged (1)', 'Show 1 card']));
    act(() => byText(r, 'Flagged (1)').props.onPress());
    act(() => byText(r, 'Show 1 card').props.onPress());
    expect(r.root.findByType(FacetSheet).props.open).toBe(false);
    expect(searchBox(r).props.value).toBe('bahnhof');
    expect(byLabel(r, 'Remove filter Flagged')).toBeDefined();
    expect(rowIds(r)).toEqual(['c-b1']);
  });

  it('the sheet’s "Clear all", then the same filter again: "Show 3 cards" really shows those 3 cards', async () => {
    mockParams = routeTo({ fields: { level: ['b1'] } }, '1');
    const r = renderScreen();
    expect(rowIds(r).sort()).toEqual(['c-b1', 'c-b2', 'c-b3']);
    act(() => byLabel(r, 'Add a filter')!.props.onPress());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const sheet = () => r.root.findByType(FacetSheet);
    // "Clear all" in the sheet clears the Library at once; the sheet stays open.
    act(() => pressIn(sheet(), 'Clear all'));
    expect(sheet().props.open).toBe(true);
    expect(texts(r)).not.toContain('Level: B1');
    // The same value again: the footer promises 3 cards…
    act(() => pressIn(sheet(), 'B1 (3)'));
    expect(texts(r)).toContain('Show 3 cards');
    act(() => pressIn(sheet(), 'Show 3 cards'));
    // …and the Library shows exactly them, with the chip back.
    expect(sheet().props.open).toBe(false);
    expect(texts(r)).toContain('Level: B1');
    expect(rowIds(r).sort()).toEqual(['c-b1', 'c-b2', 'c-b3']);
  });
});

/* ============================================ Part 2 — review round 2 */

/** The fixture with the German deck only (one deck: nowhere else to move a card). */
function germanOnly(): DataStateV3 {
  const s = fixture();
  const cards = s.cards.filter((card) => card.deckId === 'd-de');
  const noteIds = new Set(cards.map((card) => card.noteId));
  // Destructured: the face guard (face.test.ts) forbids a direct property read of the notes here.
  const { notes: allNotes } = s;
  const notes = allNotes.filter((note) => noteIds.has(note.id));
  return { ...s, decks: s.decks.filter((deck) => deck.id === 'd-de'), cards, notes };
}

/** The array the FlatList draws (its `data`). */
function listData(r: ReactTestRenderer): readonly Card[] {
  return r.root.findByType(FlatList).props.data as readonly Card[];
}

describe('Library screen — a clock tick does not filter the list again for nothing', () => {
  it('the tick right after the first open, and the one a minute later, keep the SAME rows for a clock-free query', () => {
    mockParams = routeTo({ decks: ['d-de'] }, '1');
    const r = renderScreen();
    const first = listData(r);
    expect(first).toHaveLength(6);
    // useNow's first tick: from the module-load time to the real time, right after mount.
    mockNow = NOW + 2 * MIN;
    rerender(r);
    expect(listData(r)).toBe(first);
    // The tick a minute later.
    mockNow = NOW + 3 * MIN;
    rerender(r);
    expect(listData(r)).toBe(first);
    // A real change of the cards still gives new rows.
    mockActions.setFlags(['c-a3'], { flagged: true });
    rerender(r);
    expect(listData(r)).not.toBe(first);
  });

  it('a Due chip does follow the clock: at a later time the list holds the cards that became due', () => {
    mockParams = routeTo({ due: 'now' }, '1');
    const r = renderScreen();
    const dueAt = (t: number) =>
      scopePool(mockState, { due: 'now' }, matchCtxOf(mockState, t), 'browse')
        .map((card) => card.id)
        .sort();
    expect(rowIds(r).sort()).toEqual(dueAt(NOW));
    const later = NOW + 4 * DAY;
    expect(dueAt(later).length).toBeGreaterThan(dueAt(NOW).length);
    mockNow = later;
    rerender(r);
    expect(rowIds(r).sort()).toEqual(dueAt(later));
  });
});

describe('Library screen — suggestion chips in a scoped Library', () => {
  it('the chip "Deck: German" and an empty box: "Try:" Level · Not started · Due now; a tap adds the filter', () => {
    mockParams = routeTo({ decks: ['d-de'] }, '1');
    const r = renderScreen();
    expect(texts(r)).toContain('Try:');
    expect(byLabel(r, 'Filter by Level')).toBeDefined();
    expect(byLabel(r, 'Add the filter Due now')).toBeDefined();
    act(() => byLabel(r, 'Add the filter Not started')!.props.onPress());
    expect(texts(r)).toEqual(expect.arrayContaining(['Deck: German', 'Not started']));
    expect(rowIds(r)).toEqual(['c-a3']);
    // The group has a chip now: no suggestion for it any more.
    expect(byLabel(r, 'Add the filter Not started')).toBeUndefined();
  });

  it('no suggestions while the box holds text, or in select mode', () => {
    mockParams = routeTo({ decks: ['d-de'] }, '1');
    const r = renderScreen();
    act(() => searchBox(r).props.onChangeText('lauf'));
    expect(texts(r)).not.toContain('Try:');
    act(() => searchBox(r).props.onChangeText(''));
    expect(texts(r)).toContain('Try:');
    act(() => byText(r, 'Select').props.onPress());
    expect(texts(r)).not.toContain('Try:');
  });
});

describe('Library screen — the AddSheet "New list" line (spec §8.10)', () => {
  const LINE = 'Add filters, then tap Save as list.';

  it('newList=1 shows the line while filters are chosen; "Save as list" ends it', () => {
    expect(NEW_LIST_BANNER).toBe(LINE);
    mockParams = { newList: '1', nonce: '1' };
    const r = renderScreen();
    expect(texts(r)).toContain(LINE);
    expect(texts(r)).not.toContain('Save as list');
    act(() => byLabel(r, 'Add the filter Not started')!.props.onPress());
    expect(texts(r)).toContain(LINE);
    act(() => byText(r, 'Save as list').props.onPress());
    act(() => byText(r, 'Save list').props.onPress());
    expect(mockActions.saveList).toHaveBeenCalledTimes(1);
    expect(texts(r)).not.toContain(LINE);
  });

  it('"Clear all" ends the line and clears every route param, newList too', () => {
    mockParams = { newList: '1', nonce: '1' };
    const r = renderScreen();
    act(() => byLabel(r, 'Add the filter Not started')!.props.onPress());
    act(() => byText(r, 'Clear all').props.onPress());
    const cleared = mockSetParams.mock.calls[mockSetParams.mock.calls.length - 1][0];
    expect(Object.keys(cleared).sort()).toEqual(['newList', 'nonce', 'q']);
    expect(Object.values(cleared).every((v) => v === undefined)).toBe(true);
    expect(texts(r)).not.toContain(LINE);
  });

  // The AddSheet and Today's "+ New list" send `newList=1` (todayLogic
  // NEW_LIST_PARAM) — since wave 5 the ONLY spelling (the old `intent=newList` is gone).
  it('the exact route the AddSheet and Today send shows the line; Save as list ends it', () => {
    mockParams = libraryRoute({}, '1', NEW_LIST_PARAM).params;
    const r = renderScreen();
    expect(texts(r)).toContain(LINE);
    act(() => byLabel(r, 'Add the filter Not started')!.props.onPress());
    act(() => byText(r, 'Save as list').props.onPress());
    act(() => byText(r, 'Save list').props.onPress());
    expect(texts(r)).not.toContain(LINE);
    // A tab press keeps the same params (the same nonce): the line does not come back.
    rerender(r);
    expect(texts(r)).not.toContain(LINE);
  });

  it('newList=1: "Clear all" ends the line and clears newList too, so it does not come back', () => {
    mockParams = { q: '{}', nonce: '1', newList: '1' };
    const r = renderScreen();
    act(() => byLabel(r, 'Add the filter Not started')!.props.onPress());
    act(() => byText(r, 'Clear all').props.onPress());
    expect(mockSetParams).toHaveBeenLastCalledWith(expect.objectContaining({ newList: undefined }));
    expect(Object.keys(mockSetParams.mock.calls[mockSetParams.mock.calls.length - 1][0])).toContain('newList');
    expect(texts(r)).not.toContain(LINE);
    // router.setParams MERGES into the params: apply it like the router does.
    // A `newList=1` left behind (no nonce) would be a request again → the line.
    const merged: Record<string, string | undefined> = { ...mockParams, ...mockSetParams.mock.calls[mockSetParams.mock.calls.length - 1][0] };
    mockParams = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
    expect(mockParams).toEqual({});
    rerender(r);
    expect(texts(r)).not.toContain(LINE);
  });

  it('newList with another value is no request for the line', () => {
    mockParams = { q: '{}', nonce: '1', newList: '0' };
    const r = renderScreen();
    expect(texts(r)).not.toContain(LINE);
  });

  it('the old second spelling intent=newList is no request any more (one spelling)', () => {
    mockParams = { q: '{}', nonce: '1', intent: 'newList' };
    const r = renderScreen();
    expect(texts(r)).not.toContain(LINE);
  });

  it('a Library opened any other way shows no line', () => {
    mockParams = routeTo({ decks: ['d-de'] }, '1');
    const r = renderScreen();
    expect(texts(r)).not.toContain(LINE);
  });
});

describe('Library screen — "Move to deck…" only when it can move something', () => {
  /** Select all, then open More. */
  function openMore(r: ReactTestRenderer, n: number) {
    act(() => byText(r, 'Select').props.onPress());
    act(() => byText(r, `Select all ${n}`).props.onPress());
    act(() => byLabel(r, 'More')!.props.onPress());
  }

  it('one deck that holds every selected card: no "Move to deck…" row (it would change nothing)', () => {
    mockState = germanOnly();
    const r = renderScreen();
    openMore(r, 6);
    expect(texts(r)).toContain('6 cards selected');
    expect(texts(r)).toContain('Add tag…');
    expect(texts(r)).not.toContain('Move to deck…');
  });

  it('another deck exists: the row moves the whole items there, with Undo', () => {
    mockParams = routeTo({ decks: ['d-es'] }, '1');
    const r = renderScreen();
    openMore(r, 3);
    act(() => byText(r, 'Move to deck…').props.onPress());
    act(() => byText(r, 'German').props.onPress());
    expect(mockActions.moveNotes).toHaveBeenCalledWith(['es1', 'es2'], 'd-de');
    expect(mockState.cards.filter((card) => card.deckId === 'd-es')).toHaveLength(0);
    expect(mockShow).toHaveBeenLastCalledWith(
      '3 cards moved to German',
      expect.objectContaining({ onAction: expect.any(Function) }),
    );
    act(() => lastUndo()());
    expect(mockState.cards.filter((card) => card.deckId === 'd-es')).toHaveLength(3);
  });
});

/* ================================================= wave 5b: the device walkthrough */

describe('walkthrough H2 — Return parses the text of the EVENT, typing uses the latest state', () => {
  const sctx = () => searchCtxFor(STATE.cards, CTX);

  it('submitSearch parses the typed text, never the (late) state text', () => {
    // The state still holds 'tag:alg' (the last keys are on their way); the event has all of it.
    const late = withText(initialLibraryState({}, LISTS), 'tag:alg');
    const next = submitSearch(late, 'tag:algo', sctx);
    expect(next.chips).toEqual({ tags: ['algo'] });
    expect(next.text).toBe('');
    expect(listed(next.chips)).toEqual(['c-es2']);
    // 'is:flagged' + Return became a chip (it stayed text before).
    const flag = submitSearch(withText(initialLibraryState({}, LISTS), 'is:flagge'), 'is:flagged', sctx);
    expect(flag.chips).toEqual({ flags: ['flagged'] });
    expect(flag.text).toBe('');
    // Free words: no chip, the box holds what was typed.
    expect(submitSearch(late, 'bahnhof', sctx)).toMatchObject({ chips: {}, text: 'bahnhof' });
  });

  it('typeSearch: a space after a complete token commits it; the next key keeps that chip', () => {
    const s0 = initialLibraryState({}, LISTS);
    const s1 = typeSearch(s0, 'is:flagged ', sctx, CTX.index);
    expect(s1).toMatchObject({ chips: { flags: ['flagged'] }, text: '' });
    const s2 = typeSearch(s1, 'level:b1 ', sctx, CTX.index);
    expect(s2.chips).toEqual({ flags: ['flagged'], fields: { level: ['b1'] } });
    expect(typeSearch(s2, 'haus', sctx, CTX.index)).toMatchObject({ chips: s2.chips, text: 'haus' });
    // Not a token, or quotes still open: just text.
    expect(typeSearch(s0, 'haus ', sctx, CTX.index).text).toBe('haus ');
    expect(typeSearch(s0, 'deck:"German ', sctx, CTX.index).text).toBe('deck:"German ');
  });
});

describe('walkthrough M9 — no count for a half-typed token', () => {
  const sctx = () => searchCtxFor(STATE.cards, CTX);
  const pending = (text: string) => pendingTokenStart(text, sctx(), CTX.index);

  it('pendingTokenStart: a key with no value, an open quote, or only the START of a real value', () => {
    expect(pending('level:')).toBe(0);
    expect(pending('level:b')).toBe(0); // B1 is a value; "b" is only its start
    expect(pending('bahnhof level:b')).toBe(8);
    expect(pending('level:"b')).toBe(0);
    expect(pending('tag:alg')).toBe(0);
    expect(pending('tag:algo::core')).toBe(0);
    expect(pending('is:flag')).toBe(0);
    expect(pending('-is:susp')).toBe(0);
    expect(pending('type:ver')).toBe(0);
  });

  it('pendingTokenStart: complete tokens, tokens that start nothing, and plain words are not half-typed', () => {
    expect(pending('level:b1')).toBeNull();
    expect(pending('level:x')).toBeNull(); // starts nothing: applied, 0 cards (honest)
    expect(pending('tag:algo')).toBeNull();
    expect(pending('tag:algo::core_patterns')).toBeNull();
    expect(pending('is:flagged')).toBeNull();
    expect(pending('is:due')).toBeNull(); // complete, though "duetoday" starts with it
    expect(pending('deck:ger')).toBeNull(); // a deck is found by the start of its name
    expect(pending('level:b1 ')).toBeNull(); // complete, with a space after it (it becomes a chip)
    expect(pending('bahnhof')).toBeNull();
    expect(pending('colour:re')).toBeNull(); // no such field: text, with a hint
    expect(pending('')).toBeNull();
  });

  it('parseForList leaves the half token out — the list keeps the result of the text before it — and keeps it in `rest`', () => {
    const half = parseForList('bahnhof level:b', sctx, CTX.index);
    expect(half.query).toEqual({ text: 'bahnhof' });
    expect(half.hints).toEqual([]);
    expect(half.rest).toBe('bahnhof level:b');
    expect(parseForList('bahnhof level:b1', sctx, CTX.index).query).toEqual({ fields: { level: ['b1'] }, text: 'bahnhof' });
    expect(parseForList('level:', sctx, CTX.index).query).toEqual({});
    // Return still makes the chip the learner asked for.
    expect(submitSearch(initialLibraryState({}, LISTS), 'level:b', sctx).chips).toEqual({ fields: { level: ['b'] } });
  });

  it('shownQueryNow ("Select all") is the list\'s query: without the half token', () => {
    const state = withText(withChips(initialLibraryState({}, LISTS), { decks: ['d-de'] }), 'level:b');
    expect(shownQueryNow(state, sctx, CTX.index)).toEqual({ decks: ['d-de'] });
    expect(shownQueryNow(withText(state, 'level:b1'), sctx, CTX.index)).toEqual({ decks: ['d-de'], fields: { level: ['b1'] } });
  });

  it('review round 1: facetStartQuery is the list\'s query — the FacetSheet starts WITHOUT the half token', () => {
    const state = withText(withChips(initialLibraryState({}, LISTS), { decks: ['d-de'] }), 'level:b');
    const start = facetStartQuery(state, sctx, CTX.index);
    // Not { fields: { level: ['b'] } }: the sheet would say "Show 0 cards" over a list of 6.
    expect(start).toEqual({ decks: ['d-de'] });
    expect(start).toEqual(shownQueryNow(state, sctx, CTX.index));
    expect(resultCountFromFacets(deriveFacets(STATE.cards, {}, start, CTX))).toBe(listed(start).length);
    expect(listed(start)).toHaveLength(6);
    // The words before the token are in it.
    expect(facetStartQuery(withText(state, 'bahnhof level:b'), sctx, CTX.index)).toEqual({ decks: ['d-de'], text: 'bahnhof' });
  });

  it('review round 1: facetsDone — "Show" with no change changes nothing; a change keeps the half token in the box', () => {
    const state = withText(withChips(initialLibraryState({}, LISTS), { decks: ['d-de'] }), 'level:b');
    const start = facetStartQuery(state, sctx, CTX.index);
    expect(facetsDone(state, start, sctx, CTX.index)).toBeNull();
    // B1 picked in the sheet: the chip is "Level: B1" (never "Level: b, B1"), and the typing is not lost.
    const b1 = toggleFacetValue(start, 'field:level', 'b1');
    const next = facetsDone(state, b1, sctx, CTX.index)!;
    expect(next.chips).toEqual({ decks: ['d-de'], fields: { level: ['b1'] } });
    expect(next.text).toBe('level:b');
    // The list still leaves the token out: exactly the number "Show {n} cards" promised.
    const shown = listed(shownQueryNow(next, sctx, CTX.index));
    expect(shown).toHaveLength(resultCountFromFacets(deriveFacets(STATE.cards, {}, b1, CTX))!);
    expect(shown.sort()).toEqual(['c-b1', 'c-b2', 'c-b3']);
    // Words before the token keep their case, and the token follows them.
    const words = withText(state, 'Bahnhof level:b');
    const flagged = toggleFacetValue(facetStartQuery(words, sctx, CTX.index), 'flags', 'flagged');
    const wordsNext = facetsDone(words, flagged, sctx, CTX.index)!;
    expect(wordsNext.chips).toEqual({ decks: ['d-de'], flags: ['flagged'] });
    expect(wordsNext.text).toBe('Bahnhof level:b');
  });

  it('removeBestChip with the list\'s parse: complete tokens become chips, the half token stays in the box', () => {
    const state = withText(withChips(initialLibraryState({}, LISTS), { fields: { level: ['c2'] } }), 'is:suspended level:b');
    const next = removeBestChip(state, parseForList(state.text, sctx, CTX.index), 'field:level');
    expect(next.chips).toEqual({ flags: ['suspended'] });
    expect(next.text).toBe('level:b');
  });
});

describe('walkthrough M9 — the list is memoized per (query, sort, data)', () => {
  const SOURCE = JSON.stringify({ by: 'source' });
  const AZ = JSON.stringify({ by: 'az' });
  const DE = serializeQuery({ decks: ['d-de'] });

  it('the same query and sort give the SAME array, also from a new reader; a new sort reuses the filtered pool', () => {
    const cache = createRowsCache();
    const first = rowsReader(cache, DE, SOURCE, 0)(STATE);
    expect(first.map((c) => c.id)).toEqual(listed({ decks: ['d-de'] }));
    // A new render makes a new reader: the list is not filtered again.
    expect(rowsReader(cache, DE, SOURCE, 0)(STATE)).toBe(first);
    const az = rowsReader(cache, DE, AZ, 0)(STATE);
    expect(cache.pools.size).toBe(1);
    expect(az.map((c) => c.id)).toEqual(
      sortScopeCards(scopePool(STATE, { decks: ['d-de'] }, CTX, 'browse'), { by: 'az' }, STATE, CTX).map((c) => c.id),
    );
    // Typing on and back ("hund" → "hun" → "hund"): the earlier list comes back as it was.
    rowsReader(cache, serializeQuery({ text: 'bahn' }), SOURCE, 0)(STATE);
    expect(rowsReader(cache, DE, SOURCE, 0)(STATE)).toBe(first);
  });

  it('every sort without free words gives exactly the store\'s sorted pool (the same rows as before the cache)', () => {
    for (const { sort } of BASE_SORTS) {
      const key = JSON.stringify(sort);
      const ours = rowsReader(createRowsCache(), serializeQuery({}), key, 0)(STATE).map((c) => c.id);
      expect(ours).toEqual(sortedPoolReader(serializeQuery({}), key, 0)(STATE).map((c) => c.id));
    }
  });

  it('new data empties the cache; today\'s tallies or the settings alone do not (the list does not read them)', () => {
    const cache = createRowsCache();
    const read = rowsReader(cache, serializeQuery({ flags: ['flagged'] }), SOURCE, 0);
    expect(read(STATE).map((c) => c.id)).toEqual(['c-b1']);
    const unflagged = { ...STATE, cards: STATE.cards.map((c) => (c.id === 'c-b1' ? { ...c, flagged: false } : c)) };
    expect(read(unflagged)).toEqual([]);
    const now = read(unflagged);
    expect(read({ ...unflagged, settings: { ...unflagged.settings } })).toBe(now);
  });

  it('keeps at most ROWS_CACHE_SIZE lists; the oldest goes first', () => {
    const cache = createRowsCache();
    for (let i = 0; i <= ROWS_CACHE_SIZE + 2; i++) rowsReader(cache, serializeQuery({ text: `w${i}` }), SOURCE, 0)(STATE);
    expect(cache.rows.size).toBe(ROWS_CACHE_SIZE);
    expect(cache.pools.size).toBe(ROWS_CACHE_SIZE);
  });

  it('perfMarks: a hit of the shared cache from a NEW reader is not recorded as a filter pass', () => {
    let tick = 0;
    const marks = createPerfMarks({ enabled: true, clock: () => (tick += 1) });
    const cache = createRowsCache();
    const timed = () => timedSelector('filter', rowsReader(cache, DE, SOURCE, 0), (rows) => plural(rows.length, 'card'), marks);
    timed()(STATE);
    timed()(STATE); // a new render, the same list
    expect(marks.entries().map((e) => [e.name, e.detail])).toEqual([['filter', '6 cards']]);
  });

  it('unit P4 review: Deck order of a library stored in that order is NO copy — "no filter" gives the store’s own cards array; the rows are the same', () => {
    const inOrder: DataStateV3 = { ...STATE, cards: sortScopeCards(STATE.cards, { by: 'source' }, STATE, CTX) };
    const ctx = matchCtxOf(inOrder, FIXED_NOW);
    // No filter: the list IS the state's cards array (no array of 16,000 cards on the device).
    const all = rowsReader(createRowsCache(), serializeQuery({}), SOURCE, 0)(inOrder);
    expect(all).toBe(inOrder.cards);
    // A filter: the rows are the filtered pool itself, in the old order.
    const cache = createRowsCache();
    const de = rowsReader(cache, DE, SOURCE, 0)(inOrder);
    expect(de).toBe(cache.pools.values().next().value);
    expect(de.map((c) => c.id)).toEqual(
      sortScopeCards(scopePool(inOrder, { decks: ['d-de'] }, ctx, 'browse'), { by: 'source' }, inOrder, ctx).map((c) => c.id),
    );
    // Another sort of the same pool: a new array, not the pool.
    expect(rowsReader(cache, DE, AZ, 0)(inOrder)).not.toBe(de);
  });
});

/** A German deck for the headline rank: in deck order Achtung, Hundehütte, Hund, Kater. */
function rankState(): DataStateV3 {
  const de = makeDeckV3({ id: 'd-de', name: 'German', order: 0, language: 'de-DE', meaningLanguage: 'en-US' });
  const word = (id: string, order: number, term: string, example: string) =>
    noteWithCards({
      deckId: 'd-de',
      typeId: DE_TYPE,
      fields: [term, `meaning of ${term}`, example, '', '', 'A1', 'noun', '', '', ''],
      note: { id, order },
      card: { id: `c-${id}`, newPos: order },
    });
  return stateOfV3({
    decks: [de],
    groups: [
      word('achtung', 1, 'die Achtung', 'Achtung, der Hund!'),
      word('hutte', 2, 'die Hundehütte', ''),
      word('hund', 3, 'der Hund', ''),
      word('kater', 4, 'der Kater', 'Kein Hund, ein Kater.'),
    ],
  });
}

describe('walkthrough L12 — free words: the headline matches come first', () => {
  it('headlineRank: exact, then a start (or a whole word), then the rest; searchNeedle folds the words', () => {
    expect(headlineRank('hund', 'hund', 'der hund')).toBe(0);
    expect(headlineRank('die stunde', 'stunde', 'die stunde')).toBe(0);
    expect(headlineRank('hund', 'hundehutte', 'die hundehutte')).toBe(1);
    expect(headlineRank('go', 'to go', 'to go')).toBe(1);
    expect(headlineRank('hund', 'achtung', 'die achtung')).toBe(2);
    expect(searchNeedle('"Die  Stunde"')).toBe('die stunde');
    expect(searchNeedle(undefined)).toBe('');
  });

  it('"hund": der Hund (exact), die Hundehütte (start), then Achtung and Kater (only in an example), each part in the sort', () => {
    const state = rankState();
    const ids = (sort: string, q: Query) => rowsReader(createRowsCache(), serializeQuery(q), sort, 0)(state).map((c) => c.id);
    expect(ids(JSON.stringify({ by: 'source' }), { text: 'hund' })).toEqual(['c-hund', 'c-hutte', 'c-achtung', 'c-kater']);
    // Without free words: the chosen sort alone (deck order).
    expect(ids(JSON.stringify({ by: 'source' }), {})).toEqual(['c-achtung', 'c-hutte', 'c-hund', 'c-kater']);
    // Z–A inside each part: the headline parts first, then Kater (K) before Achtung (A).
    expect(ids(JSON.stringify({ by: 'az', dir: 'desc' }), { text: 'hund' })).toEqual(['c-hund', 'c-hutte', 'c-kater', 'c-achtung']);
  });

  it('no headline matches: the SAME array as the sort alone', () => {
    const state = rankState();
    const ctx = matchCtxOf(state, NOW);
    const sorted = sortScopeCards(scopePool(state, { text: 'kein' }, ctx, 'browse'), { by: 'source' }, state, ctx);
    expect(rankRows(sorted, 'kein', ctx.index, ctx.decks)).toBe(sorted);
  });
});

describe('walkthrough L16 — select mode ends when nothing selected is visible any more', () => {
  it('selectionGone: only for a selection of ids that the list no longer shows', () => {
    const selecting = withSelectedIds(startSelecting(initialLibraryState({}, LISTS)), ['c-a2', 'c-b1']);
    expect(selectionGone(selecting, () => false)).toBe(true);
    expect(selectionGone(selecting, (id) => id === 'c-b1')).toBe(false);
    // Just tapped "Select" (nothing selected yet), "Select all" (the list itself), or not selecting.
    expect(selectionGone(startSelecting(initialLibraryState({}, LISTS)), () => false)).toBe(false);
    expect(selectionGone(selectAll(initialLibraryState({}, LISTS), {}), () => false)).toBe(false);
    expect(selectionGone(stopSelecting(selecting), () => false)).toBe(false);
  });
});

/** German Verbs (with a "Tags" field) and German Vocabulary, with different template names. */
function verbsAndWords() {
  const verbs: NoteType = {
    id: 'nt-verbs',
    name: 'German Verbs (bidirectional)',
    kind: 'standard',
    fields: [
      { name: 'Verb', role: 'term', facet: 'off' },
      { name: 'Meaning', role: 'meaning', facet: 'off' },
      { name: 'Tags', role: 'badge', facet: 'on', multiSep: ',' },
    ],
    templates: [
      { ord: 0, name: 'Forward', prompt: [0], answer: [1] },
      { ord: 1, name: 'Reverse', prompt: [1], answer: [0] },
    ],
    sortField: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const words: NoteType = {
    ...verbs,
    id: 'nt-words',
    name: 'German Vocabulary',
    fields: verbs.fields.slice(0, 2),
    templates: [
      { ord: 0, name: 'DE-EN', prompt: [0], answer: [1] },
      { ord: 1, name: 'EN-DE', prompt: [1], answer: [0] },
    ],
  };
  const groups = [
    noteWithCards({ deckId: 'd-de', typeId: verbs.id, fields: ['gehen', 'to go', 'irregular, sein'], note: { id: 'v1', tags: ['verbs'] } }, [verbs]),
    noteWithCards({ deckId: 'd-de', typeId: verbs.id, fields: ['machen', 'to make', 'regular'], note: { id: 'v2' } }, [verbs]),
    noteWithCards({ deckId: 'd-de', typeId: words.id, fields: ['das Haus', 'the house'], note: { id: 'w1' } }, [words]),
  ];
  return stateOfV3({ decks: [makeDeckV3({ id: 'd-de', name: 'German' })], groups, types: [verbs, words] });
}

/** The cards of these items with this ord (direction) suspended. */
function withSuspended(state: DataStateV3, noteIds: readonly string[], ord: number): DataStateV3 {
  return {
    ...state,
    cards: state.cards.map((card) => (noteIds.includes(card.noteId) && card.ord === ord ? { ...card, suspended: true } : card)),
  };
}

describe('walkthrough M8 — Library chips use the FacetSheet group names', () => {
  it('a field chip says "Tags (German Verbs): irregular" and a Direction chip "Back → Front", like the sheet', () => {
    const state = verbsAndWords();
    const ctx = matchCtxOf(state, NOW);
    const q: Query = { fields: { tags: ['irregular'] }, directions: [1] };
    const labels = libraryChips(q, ctx, searchCtxFor(state.cards, ctx)).map((chip) => chip.label);
    expect(labels).toEqual(['Tags (German Verbs): irregular', 'Direction: Back → Front']);
    const facets = deriveFacets(state.cards, {}, q, ctx);
    expect(facets.find((f) => f.key === 'field:tags')!.label).toBe('Tags (German Verbs)');
    expect(facets.find((f) => f.key === 'direction')!.values.map((v) => v.label)).toEqual(['Front → Back', 'Back → Front']);
    // Every other chip is chipsOf's own.
    const other: Query = { tags: ['verbs'], life: ['new'], decks: ['d-de'] };
    expect(libraryChips(other, ctx)).toEqual(chipsOf(other, ctx));
  });

  it('chipScopeFor: the parser\'s view only for a Direction chip (the one chip whose label needs it)', () => {
    const state = verbsAndWords();
    const ctx = matchCtxOf(state, NOW);
    expect(chipScopeFor(state.cards, ctx, { directions: [1] })).toBe(searchCtxFor(state.cards, ctx));
    expect(chipScopeFor(state.cards, ctx, { fields: { tags: ['irregular'] } })).toBeUndefined();
  });

  it('review round 1: the smart empty state\'s "Remove …" names the chip exactly like the "No cards match" line', () => {
    // The Back → Front cards of "machen" (regular) and "das Haus" (no Tags field) are suspended.
    const state = withSuspended(verbsAndWords(), ['v2', 'w1'], 1);
    const ctx = matchCtxOf(state, NOW);
    const q: Query = { fields: { tags: ['irregular'] }, directions: [1], flags: ['suspended'] };
    expect(scopePool(state, q, ctx, 'browse')).toEqual([]);
    // The line "No cards match …" (the screen's queryLabels).
    const line = libraryChips(q, ctx, chipScopeFor(state.cards, ctx, q)).map((chip) => chip.label);
    expect(line).toEqual(['Tags (German Verbs): irregular', 'Direction: Back → Front', 'Suspended']);
    // Without the Tags chip, the 2 suspended Back → Front cards show: the best chip, named as in the line.
    const best = bestChipToRemove(state.cards, q, ctx)!;
    expect(best).toEqual({ chipId: 'field:tags', label: 'Tags (German Verbs): irregular', count: 2 });
    expect(line).toContain(best.label);
    // Wave 5c: chipsOf itself names the field with its card types now (the triage
    // title reads it), so even without the screen's scope it is the same word.
    expect(chipsOf(q, ctx).find((chip) => chip.id === 'field:tags')!.label).toBe(best.label);
    // The same scope passed explicitly (as the screen does) gives the same button.
    expect(bestChipToRemove(state.cards, q, ctx, chipScopeFor(state.cards, ctx, q))).toEqual(best);
  });

  it('review round 1: a Direction chip as the best one is named like the FacetSheet value', () => {
    // "gehen" Front → Back is suspended: without the Direction chip it shows.
    const state = withSuspended(verbsAndWords(), ['v1'], 0);
    const ctx = matchCtxOf(state, NOW);
    const q: Query = { fields: { tags: ['irregular'] }, directions: [1], flags: ['suspended'] };
    expect(scopePool(state, q, ctx, 'browse')).toEqual([]);
    const best = bestChipToRemove(state.cards, q, ctx)!;
    expect(best).toEqual({ chipId: 'directions', label: 'Direction: Back → Front', count: 1 });
    expect(libraryChips(q, ctx, chipScopeFor(state.cards, ctx, q)).map((chip) => chip.label)).toContain(best.label);
  });
});

describe('walkthrough M9 — the FacetSheet of a big library counts after a tick', () => {
  it('facetCountsDeferred: above FACET_SYNC_MAX_CARDS cards', () => {
    expect(facetCountsDeferred(FACET_SYNC_MAX_CARDS)).toBe(false);
    expect(facetCountsDeferred(FACET_SYNC_MAX_CARDS + 1)).toBe(true);
  });

  it('withDraftSelection draws the older counts with the selection of the draft NOW (also inside a tree)', () => {
    const facets = deriveFacets(STATE.cards, {}, {}, CTX);
    const drawn = withDraftSelection(facets, { fields: { level: ['b1'] }, tags: ['algo::core_patterns'] });
    const level = drawn.find((f) => f.key === 'field:level')!;
    expect(level.values.filter((v) => v.selected).map((v) => v.value)).toEqual(['b1']);
    // The counts are the older ones (nothing was counted again).
    expect(level.values.map((v) => v.count)).toEqual(facets.find((f) => f.key === 'field:level')!.values.map((v) => v.count));
    const tag = drawn.find((f) => f.key === 'tag')!;
    const algo = tag.values.find((v) => v.value === 'algo')!;
    expect(algo.selected).toBe(false);
    expect(algo.children!.find((v) => v.value === 'algo::core_patterns')!.selected).toBe(true);
  });
});

/** The texts a person sees: host Text nodes that are not inside a part hidden from everyone (A11Y_HIDDEN, opacity 0). */
function visibleTexts(r: ReactTestRenderer): string[] {
  const hidden = (n: ReactTestInstance | null): boolean => {
    for (let at = n; at; at = at.parent) {
      const style = StyleSheet.flatten(at.props.style) as { opacity?: number } | undefined;
      if (at.props.importantForAccessibility === 'no-hide-descendants' && style?.opacity === 0) return true;
    }
    return false;
  };
  return r.root
    .findAll((n) => (n.type as unknown) === 'Text' && !hidden(n))
    .map((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children ?? '')));
}

describe('walkthrough M2 — the chip row', () => {
  it('chipText: a long chip is cut at a word boundary with "…"; a short one stays', () => {
    expect(chipText('Level: B1, B2')).toBe('Level: B1, B2');
    const long = 'Deck: German — Everyday, German — Conversation, German';
    const cut = chipText(long);
    expect(cut).toBe('Deck: German — Everyday, German…');
    expect(Array.from(cut).length).toBeLessThanOrEqual(CHIP_TEXT_MAX);
    // A word boundary too early in the text would leave almost nothing: then the word is cut.
    expect(chipText('Tag: Supercalifragilisticexpialidocious-and-more', 20)).toBe('Tag: Supercalifragi…');
    expect(chipText('Supercalifragilisticexpialidocious', 12)).toBe('Supercalifr…');
  });

  it('review round 1: chipTextMax — fewer characters at a bigger font size, so a chip keeps its width', () => {
    expect(chipTextMax(1)).toBe(CHIP_TEXT_MAX);
    expect(chipTextMax(0.85)).toBe(CHIP_TEXT_MAX);
    expect(chipTextMax(Number.NaN)).toBe(CHIP_TEXT_MAX);
    expect(chipTextMax(1.3)).toBe(25);
    expect(chipTextMax(2)).toBe(16);
    expect(chipTextMax(3.1)).toBe(CHIP_TEXT_MIN);
    // The drawn width (characters × font scale) never grows past the normal one (+ the rounding).
    for (const scale of [1, 1.15, 1.3, 1.5, 1.75, 2, 2.5]) {
      expect(chipTextMax(scale) * scale).toBeLessThanOrEqual(CHIP_TEXT_MAX + 1);
    }
    // At 1.3× a 31-character label is cut now (it filled a 360 pt row).
    const label = 'Tags (German Verbs): irregular!';
    expect(Array.from(label)).toHaveLength(31);
    expect(chipText(label, chipTextMax(1))).toBe(label);
    expect(Array.from(chipText(label, chipTextMax(1.3))).length).toBeLessThanOrEqual(25);
  });

  it('changedChipKey: the first new chip, or the first chip with a new label; null for a removal', () => {
    const deck = { key: 'decks', label: 'Deck: German' };
    expect(changedChipKey([deck], [deck, { key: 'field:level', label: 'Level: B1' }])).toBe('field:level');
    expect(changedChipKey([deck, { key: 'field:level', label: 'Level: B1' }], [deck, { key: 'field:level', label: 'Level: B1, B2' }])).toBe(
      'field:level',
    );
    expect(changedChipKey([deck, { key: 'life', label: 'New' }], [deck])).toBeNull();
    expect(changedChipKey([deck], [deck])).toBeNull();
  });

  it('scrollToShow: just far enough to show the whole chip, or null when it is in view', () => {
    const view = { offset: 0, width: 360 };
    expect(scrollToShow({ x: 40, width: 120 }, view, 20)).toBeNull();
    expect(scrollToShow({ x: 500, width: 120 }, view, 20)).toBe(280);
    expect(scrollToShow({ x: 100, width: 120 }, { offset: 300, width: 360 }, 20)).toBe(80);
    // A chip wider than the row: its start.
    expect(scrollToShow({ x: 500, width: 600 }, view, 20)).toBe(480);
    // The row is not measured yet: the chip goes to the start.
    expect(scrollToShow({ x: 500, width: 120 }, { offset: 0, width: 0 }, 20)).toBe(480);
  });

  it('the row shows the cut text, says the whole label, and scrolls to a NEW chip', () => {
    const chip = (key: string, label: string) => ({ key, label, onRemove: () => undefined });
    let row: ReactTestRenderer | null = null;
    const long = 'Deck: German — Everyday, German — Conversation, German';
    act(() => {
      row = TestRenderer.create(React.createElement(FilterChipsRow, { chips: [chip('decks', long)], onAdd: () => undefined, inset: 20 }));
    });
    const r = row!;
    // The texts on screen: not the hidden copies the row measures the labels with (wave 5c).
    const shown = visibleTexts(r);
    // The test renderer's font size (react-native's jest setup: 2×): the limit follows it (chipTextMax).
    const { fontScale } = Dimensions.get('window');
    expect(fontScale).toBeGreaterThan(1);
    expect(shown).toContain(chipText(long, chipTextMax(fontScale)));
    expect(Array.from(chipText(long, chipTextMax(fontScale))).length).toBeLessThan(Array.from(chipText(long)).length);
    expect(shown).not.toContain(long);
    expect(r.root.findAll((n) => n.props.accessibilityLabel === `Remove filter ${long}`).length).toBeGreaterThan(0);
    const scroll = r.root.findByType(ScrollView);
    expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
    const scrollTo = jest.fn();
    (scroll.instance as { scrollTo: unknown }).scrollTo = scrollTo;
    // The row is 360 wide and scrolled to the far right.
    act(() => scroll.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 40 } } }));
    act(() => scroll.props.onScroll({ nativeEvent: { contentOffset: { x: 400, y: 0 } } }));
    // A new chip "Level: B1, B2" comes in; it is drawn at x 300.
    act(() => r.update(React.createElement(FilterChipsRow, { chips: [chip('decks', long), chip('field:level', 'Level: B1, B2')], onAdd: () => undefined, inset: 20 })));
    // The View that measures one chip (it has the chip's slop as padding).
    const wrapper = (label: string) =>
      r.root.findAll(
        (n) =>
          (n.type as unknown) === 'View' &&
          typeof n.props.onLayout === 'function' &&
          (n.props.style as { paddingVertical?: number } | undefined)?.paddingVertical === 6 &&
          n.findAll((m) => m.props.accessibilityLabel === `Remove filter ${label}`).length > 0,
      )[0];
    act(() => wrapper('Level: B1, B2').props.onLayout({ nativeEvent: { layout: { x: 300, y: 0, width: 130, height: 33 } } }));
    expect(scrollTo).toHaveBeenLastCalledWith({ x: 280, animated: true });
    act(() => r.unmount());
  });
});

describe('perfMarks — budgets, and measuring a release build', () => {
  it('a line over its budget says so; a line within it (or a name without one) does not', () => {
    expect(PERF_BUDGETS).toEqual({ boot: 2000, save: 20, filter: 30, facets: 80 });
    expect(formatPerfLine({ name: 'facets', ms: 877.94, detail: '15 groups' })).toBe(
      '[perf] facets 877.9 ms (15 groups) — over the 80 ms budget',
    );
    expect(formatPerfLine({ name: 'filter', ms: 30 })).toBe('[perf] filter 30.0 ms');
    expect(formatPerfLine({ name: 'search', ms: 9999 })).toBe('[perf] search 9999.0 ms');
  });

  it('perfMarksEnabled: on in development, off in release, EXPO_PUBLIC_PERF_MARKS=1 measures a release build', () => {
    expect(perfMarksEnabled(true, undefined)).toBe(true);
    expect(perfMarksEnabled(false, undefined)).toBe(false);
    expect(perfMarksEnabled(false, '1')).toBe(true);
    expect(perfMarksEnabled(true, '0')).toBe(false);
    expect(perfMarksEnabled(false, 'yes')).toBe(false);
  });
});

/* ------------------------------------------- the walkthrough, on the screen */

describe('Library screen — walkthrough fixes', () => {
  it('H2: Return makes the chip from the EVENT text, also when the box state is a key behind', () => {
    const r = renderScreen();
    act(() => searchBox(r).props.onChangeText('tag:alg'));
    // The last keys never reached onChangeText before Return.
    act(() => searchBox(r).props.onSubmitEditing({ nativeEvent: { text: 'tag:algo' } }));
    expect(texts(r)).toContain('Tag: Algo');
    expect(texts(r)).not.toContain('Tag: alg');
    expect(searchBox(r).props.value).toBe('');
    expect(rowIds(r)).toEqual(['c-es2']);
    act(() => searchBox(r).props.onChangeText('is:flagge'));
    act(() => searchBox(r).props.onSubmitEditing({ nativeEvent: { text: 'is:flagged' } }));
    expect(byLabel(r, 'Remove filter Flagged')).toBeDefined();
  });

  it('M9: while "level:b" is typed the list and its count stay those of the text before; "level:b1" applies', async () => {
    mockParams = routeTo({ decks: ['d-de'] }, '1');
    const r = renderScreen();
    const before = listData(r);
    expect(texts(r)).toContain('6 cards ·');
    act(() => searchBox(r).props.onChangeText('level:b'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(listData(r)).toBe(before);
    expect(texts(r)).toContain('6 cards ·');
    expect(texts(r).some((t) => t.startsWith('No cards match'))).toBe(false);
    act(() => searchBox(r).props.onChangeText('level:b1'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(rowIds(r).sort()).toEqual(['c-b1', 'c-b2', 'c-b3']);
    expect(texts(r)).toContain('3 cards ·');
  });

  it('M9: "Select all" while a half token is in the box selects the rows on screen', () => {
    mockParams = routeTo({ decks: ['d-de'] }, '1');
    const r = renderScreen();
    act(() => byText(r, 'Select').props.onPress());
    act(() => searchBox(r).props.onChangeText('level:b'));
    act(() => byText(r, 'Select all 6').props.onPress());
    expect(texts(r)).toContain('6 selected');
    expect(rows(r).every((n) => n.props.selected === true)).toBe(true);
  });

  it('L12: typing "hund" lists der Hund first', async () => {
    mockState = rankState();
    const r = renderScreen();
    act(() => searchBox(r).props.onChangeText('hund'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(rowIds(r)).toEqual(['c-hund', 'c-hutte', 'c-achtung', 'c-kater']);
  });

  it('L16: "Unsuspend" on the Suspended list ends select mode; the snackbar has Undo', () => {
    mockParams = routeTo({ flags: ['suspended'] }, '1');
    const r = renderScreen();
    act(() => byText(r, 'Select').props.onPress());
    act(() => byText(r, 'Select all 1').props.onPress());
    act(() => byLabel(r, 'Unsuspend')!.props.onPress());
    expect(mockActions.setFlags).toHaveBeenCalledWith(['c-a2'], { suspended: false });
    expect(mockShow).toHaveBeenLastCalledWith('1 card unsuspended', expect.objectContaining({ onAction: expect.any(Function) }));
    expect(texts(r)).not.toContain('1 selected');
    expect(r.root.findAllByType(BulkBar)).toHaveLength(0);
    expect(texts(r)).toContain('Remove Suspended');
    act(() => lastUndo()());
    expect(mockState.cards.find((c) => c.id === 'c-a2')!.suspended).toBe(true);
  });

  it('L16: a change that leaves selected cards in the list keeps select mode', () => {
    mockParams = routeTo({ decks: ['d-de'], life: ['new', 'notStarted'] }, '1');
    const r = renderScreen();
    act(() => byText(r, 'Select').props.onPress());
    act(() => byText(r, 'Select all 2').props.onPress());
    act(() => byLabel(r, 'Favorite')!.props.onPress());
    expect(texts(r)).toContain('2 selected');
    expect(r.root.findAllByType(BulkBar)).toHaveLength(1);
  });

  it('L13: the "More" rows wrap their note ("… studied cards will be skipped" is never cut)', () => {
    mockParams = routeTo({ decks: ['d-de'] }, '1');
    const r = renderScreen();
    act(() => byText(r, 'Select').props.onPress());
    act(() => byText(r, 'Select all 6').props.onPress());
    act(() => byLabel(r, 'More')!.props.onPress());
    const note = r.root.findAll(
      (n) => (n.type as unknown) === 'Text' && typeof n.props.children === 'string' && n.props.children.startsWith('Only cards never studied'),
    )[0];
    expect(note.props.children).toMatch(/studied cards? will be skipped$/);
    expect(note.props.numberOfLines).toBeUndefined();
  });

  it('M9 (review round 1): "+ Filter" with a half-typed "level:b" starts at the list\'s count; "Show" keeps the token', async () => {
    mockParams = routeTo({ decks: ['d-de'] }, '1');
    const r = renderScreen();
    act(() => searchBox(r).props.onChangeText('level:b'));
    const sheet = () => r.root.findByType(FacetSheet);
    const openSheet = async () => {
      act(() => byLabel(r, 'Add a filter')!.props.onPress());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    await openSheet();
    // The list shows 6 cards, and so does the sheet's footer; no value "b" is selected or listed.
    expect(texts(r)).toContain('6 cards ·');
    expect(texts(r)).toContain('Show 6 cards');
    expect(sheet().props.query).toEqual({ decks: ['d-de'] });
    expect(texts(r).some((t) => t.startsWith('b ('))).toBe(false);
    expect(byLabel(r, 'B1, 3 cards')!.props.accessibilityState).toEqual({ selected: false });
    // "Show 6 cards" with nothing changed: the list (6) and the box stay.
    act(() => pressIn(sheet(), 'Show 6 cards'));
    expect(sheet().props.open).toBe(false);
    expect(searchBox(r).props.value).toBe('level:b');
    expect(listData(r)).toHaveLength(6);
    // Again, and pick B1: the chip is "Level: B1" (never "Level: b, B1"), the list shows the 3 promised cards.
    await openSheet();
    act(() => pressIn(sheet(), 'B1 (3)'));
    expect(texts(r)).toContain('Show 3 cards');
    act(() => pressIn(sheet(), 'Show 3 cards'));
    expect(byLabel(r, 'Remove filter Level: B1')).toBeDefined();
    expect(searchBox(r).props.value).toBe('level:b');
    expect(rowIds(r).sort()).toEqual(['c-b1', 'c-b2', 'c-b3']);
    expect(texts(r)).toContain('3 cards ·');
  });

  it('M8 (review round 1): no match → "Remove …" names the chip exactly as the "No cards match" line does', () => {
    mockState = withSuspended(verbsAndWords(), ['v2', 'w1'], 1);
    mockParams = routeTo({ fields: { tags: ['irregular'] }, directions: [1], flags: ['suspended'] }, '1');
    const r = renderScreen();
    expect(rowIds(r)).toEqual([]);
    const all = texts(r);
    // The line's bold chip names…
    expect(all).toEqual(expect.arrayContaining(['Tags (German Verbs): irregular', 'Direction: Back → Front', 'Suspended']));
    // …and the button with the same name (not "Tags (field): irregular").
    expect(all).toContain('Remove Tags (German Verbs): irregular');
    expect(all.some((t) => t.startsWith('Remove Tags (field)'))).toBe(false);
    act(() => byText(r, 'Remove Tags (German Verbs): irregular').props.onPress());
    const suspended = mockState.cards.filter((card) => card.suspended).map((card) => card.id);
    expect(rowIds(r).sort()).toEqual(suspended.sort());
    expect(suspended).toHaveLength(2);
  });

  it('L2 (review round 1): right after "Select" the bulk bar is disabled, its labels still ≥ 4.5:1 (no opacity)', () => {
    const r = renderScreen();
    act(() => byText(r, 'Select').props.onPress());
    const bar = r.root.findByType(BulkBar);
    expect(bar.props.disabled).toBe(true);
    const k = bulkBarColors(light);
    for (const label of ['Favorite', 'Flag', 'Suspend', 'More']) {
      const button = bar.findAll(
        (n) => (n.type as unknown) === 'View' && n.props.accessibilityLabel === label && n.props.accessibilityState,
      )[0];
      expect(button.props.accessibilityState).toMatchObject({ disabled: true });
      const style = StyleSheet.flatten(button.props.style);
      // An opacity faded the label to 2.6:1 on Evening: the disabled look is a colour now.
      expect(style.opacity ?? 1).toBe(1);
      expect(style.backgroundColor).toBe(k.idleBg);
      const text = button.findAll((n) => (n.type as unknown) === 'Text' && n.props.children === label)[0];
      expect(StyleSheet.flatten(text.props.style).color).toBe(k.disabledText);
    }
    // One card selected ("gehen": not a favorite): the labels are the full text colour again.
    act(() => rows(r).find((n) => (n.props.card as Card).id === 'c-a3')!.props.onPress('c-a3'));
    const favorite = r.root
      .findByType(BulkBar)
      .findAll((n) => (n.type as unknown) === 'Text' && n.props.children === 'Favorite')[0];
    expect(StyleSheet.flatten(favorite.props.style).color).toBe(k.text);
  });

  // Final review 2026-11: on a 360-dp phone a toggle has about 49 pt for its label, and
  // "Unfavorite" (52 pt) read "Unfavo…". The label shrinks a little to fit instead.
  it('the bulk bar labels shrink to fit their button, never cut to "Unfavo…"', () => {
    const r = renderScreen();
    act(() => byText(r, 'Select').props.onPress());
    const labels = r.root
      .findByType(BulkBar)
      .findAll((n) => (n.type as unknown) === 'Text' && typeof n.props.children === 'string');
    expect(labels.length).toBeGreaterThanOrEqual(4);
    for (const text of labels) {
      expect(text.props).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: BAR_LABEL_MIN_SCALE });
    }
    // 11 pt × 0.75 = 8.25 pt: enough for "Suspend" (55 pt at 1.3× text size) in a 49 pt button.
    expect(BAR_LABEL_MIN_SCALE).toBeLessThanOrEqual(49 / 55.3);
  });

  // Final review 2026-11 (spec §8.12, touch targets ≥ 44 pt): the sort control was a 12.5 pt
  // line with a slop of 10 (about 36 pt), the clear-search × 17 pt with a slop of 12 (41 pt).
  it('the sort control and the clear-search × are touch targets of at least 44 pt', () => {
    const r = renderScreen();
    const sort = r.root.findAll(
      (n) => typeof n.type !== 'string' && String(n.props.accessibilityLabel ?? '').startsWith('Sort: ') && typeof n.props.onPress === 'function',
    )[0];
    expect(StyleSheet.flatten(sort.props.style).minHeight).toBeGreaterThanOrEqual(MIN_TOUCH);
    act(() => searchBox(r).props.onChangeText('gehen'));
    const clear = byLabel(r, LIBRARY_COPY.clearSearch)!;
    const slop = clear.props.hitSlop as number;
    expect(17 + 2 * slop).toBeGreaterThanOrEqual(MIN_TOUCH);
  });

  it('M3: taps reach the list and the chip row while the keyboard is open', () => {
    const r = renderScreen();
    expect(r.root.findByType(FlatList).props.keyboardShouldPersistTaps).toBe('handled');
    for (const scroll of r.root.findAllByType(ScrollView)) {
      if (scroll.props.horizontal) expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
    }
  });

  it('M9: a big library counts the FacetSheet after a tick; a tap turns the chip on at once and the footer waits', async () => {
    mockState = manyCards(FACET_SYNC_MAX_CARDS / 2 + 50);
    const total = mockState.cards.length;
    expect(facetCountsDeferred(total)).toBe(true);
    const r = renderScreen();
    act(() => byLabel(r, 'Add a filter')!.props.onPress());
    const sheet = () => r.root.findByType(FacetSheet);
    expect(sheet().findAll((n) => (n.type as unknown) === 'Text' && n.props.children === 'Counting…').length).toBeGreaterThan(0);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(texts(r)).toContain(`Show ${plural(total, 'card')}`);
    const a1 = mockState.cards.filter((c) => c.id.endsWith('-a1')).length;
    const a1Chip = () => byText(r, `A1 (${a1.toLocaleString('en-US')})`);
    act(() => a1Chip().props.onPress());
    // At once: the chip is on, the counts are the older ones, the footer waits.
    expect(a1Chip().props.accessibilityState).toEqual({ selected: true });
    expect(texts(r)).not.toContain(`Show ${plural(total, 'card')}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(texts(r)).toContain(`Show ${plural(a1, 'card')}`);
  });
});

/** A library above the FacetSheet's budget: `n` notes, two directions each, Level A1…C2 (card ids end in the level). */
function manyCards(n: number): DataStateV3 {
  const type: NoteType = {
    id: 'nt-many',
    name: 'Many',
    kind: 'standard',
    fields: [
      { name: 'Word', role: 'term', facet: 'off' },
      { name: 'Meaning', role: 'meaning', facet: 'off' },
      { name: 'Level', role: 'badge', facet: 'auto' },
    ],
    templates: [
      { ord: 0, name: 'Forward', prompt: [0], answer: [1] },
      { ord: 1, name: 'Reverse', prompt: [1], answer: [0] },
    ],
    sortField: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const levels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const notes: Note[] = [];
  const cards: Card[] = [];
  for (let i = 0; i < n; i++) {
    const level = levels[i % 6];
    const note = makeNote({ id: `m${i}`, typeId: type.id, fields: [`Wort ${i}`, `word ${i}`, level], order: i }, NOW);
    notes.push(note);
    for (const ord of [0, 1]) cards.push(makeCard(note, ord, 'd-many', DEFAULT_SRS, NOW, { id: `m${i}-${ord}-${level.toLowerCase()}` }));
  }
  return stateOfV3({ decks: [makeDeckV3({ id: 'd-many', name: 'Many' })], types: [type], overrides: { notes, cards, noteTypes: [type] } });
}

/* ======================================= wave 5b, review round 2 (the screen) */

/**
 * A hook that behaves like the app's useNow (src/store/useNow.ts): first
 * `boot` (the time the module was loaded — it can be hours old), and the
 * time NOW (mockNow) one tick after mount.
 */
function nowLikeTheApp(boot: number): () => number {
  return function useNowLikeTheApp(): number {
    const [value, setValue] = React.useState(boot);
    React.useEffect(() => {
      const t = setTimeout(() => setValue(mockNow), 0);
      return () => clearTimeout(t);
    }, []);
    return value;
  };
}

/** Let the 0 ms timers run (and the renders they cause). */
async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe('review round 2 — the FacetSheet counts ONCE per open, at the real time', () => {
  /** How many times the filter groups were counted (perfMarks 'facets'). */
  const facetPasses = () => perfMarks.entries().filter((entry) => entry.name === 'facets').length;
  /** Every Modal on screen (a Sheet draws one while it is open or sliding out). */
  const modals = (r: ReactTestRenderer) => r.root.findAllByType(Modal).length;

  it('a small library: one count in the opening render, "Due now" at the time NOW (not the boot time)', async () => {
    expect(perfMarks.enabled).toBe(true);
    // The app started 3 hours ago; "laufen" became due a minute ago.
    mockUseNow = nowLikeTheApp(NOW - 180 * MIN);
    const r = renderScreen();
    await tick(); // the Library's clock moves from the boot time to now
    perfMarks.clear();
    act(() => byLabel(r, 'Add a filter')!.props.onPress());
    expect(facetPasses()).toBe(1);
    expect(texts(r)).toContain('Due now (1)');
    expect(texts(r)).toContain('Show 9 cards');
    await tick();
    await tick();
    expect(facetPasses()).toBe(1);
    // Closed (the sheet slides out and its content unmounts), then opened again
    // on the SAME data at the same time: the kept result (unit P1,
    // selectors.ts facetsReader), so NO second count.
    act(() => pressIn(r.root.findByType(FacetSheet), 'Show 9 cards'));
    await tick(600);
    expect(modals(r)).toBe(0);
    act(() => byLabel(r, 'Add a filter')!.props.onPress());
    await tick();
    expect(facetPasses()).toBe(1);
    expect(texts(r)).toContain('Due now (1)');
    // New data (a card flagged: a new cards array): the next opening counts again, ONCE, with the new numbers.
    act(() => pressIn(r.root.findByType(FacetSheet), 'Show 9 cards'));
    await tick(600);
    const flaggedBefore = mockState.cards.filter((c) => c.flagged).length;
    const unflagged = mockState.cards.find((c) => !c.flagged)!;
    act(() => {
      mockActions.setFlags([unflagged.id], { flagged: true });
    });
    act(() => byLabel(r, 'Add a filter')!.props.onPress());
    await tick();
    await tick();
    expect(facetPasses()).toBe(2);
    expect(texts(r)).toContain(`Flagged (${flaggedBefore + 1})`);
  });

  it('a big library: "Counting…", then ONE count one tick later — never a first pass with the boot time', async () => {
    mockState = manyCards(FACET_SYNC_MAX_CARDS / 2 + 50);
    mockUseNow = nowLikeTheApp(NOW - 180 * MIN);
    const r = renderScreen();
    await tick();
    perfMarks.clear();
    act(() => byLabel(r, 'Add a filter')!.props.onPress());
    const sheet = () => r.root.findByType(FacetSheet);
    expect(sheet().findAll((n) => (n.type as unknown) === 'Text' && n.props.children === 'Counting…').length).toBeGreaterThan(0);
    expect(facetPasses()).toBe(0);
    await tick();
    expect(facetPasses()).toBe(1);
    expect(texts(r)).toContain(`Show ${plural(mockState.cards.length, 'card')}`);
    await tick();
    await tick();
    expect(facetPasses()).toBe(1);
  });
});

describe('unit P1 review — ONE count for one FacetSheet opening, also when the minute changes while it is open', () => {
  /*
   * The release pass counted twice for one opening ("facets 161.7 ms + 68.2
   * ms", a search in the box, then "+ Filter"). The cause: the Library's
   * clock (useNow) ticks on every full minute, and the sheet counted again
   * with the new time while it stayed open — a full count over all 16,000
   * cards (the debug log of the walk shows the second count 2 s after a full
   * minute, with no touch). Now the counts use the time of the opening, or
   * of the last tap (a tap needs a new count anyway): a tick alone counts nothing.
   */
  const facetPasses = () => perfMarks.entries().filter((entry) => entry.name === 'facets').length;
  /** The sheet's texts that start with `prefix` (a chip's label and count). */
  const sheetText = (r: ReactTestRenderer, prefix: string) => texts(r).find((t) => t.startsWith(prefix));

  for (const big of [false, true]) {
    it(`${big ? 'a big library (counted one tick after the opening)' : 'a small library'}: words in the box, "+ Filter", then a clock tick — no second count`, async () => {
      if (big) mockState = manyCards(FACET_SYNC_MAX_CARDS / 2 + 50);
      const r = renderScreen();
      await tick();
      // The device's steps: words typed in the search box (the list catches up after 150 ms), then "+ Filter".
      act(() => searchBox(r).props.onChangeText(big ? 'wort 1' : 'lauf'));
      await tick(200);
      perfMarks.clear();
      act(() => byLabel(r, 'Add a filter')!.props.onPress());
      await tick();
      await tick();
      expect(facetPasses()).toBe(1);
      // The full minute: the Library's clock ticks while the sheet is open.
      mockNow = NOW + MIN;
      rerender(r);
      await tick();
      await tick();
      expect(facetPasses()).toBe(1);
      // And the next minute.
      mockNow = NOW + 2 * MIN;
      rerender(r);
      await tick();
      await tick();
      expect(facetPasses()).toBe(1);
    });
  }

  it('the counts are as of the opening; a tap counts again at the time then, and so does the next opening', async () => {
    // Opened two minutes before "laufen" is due.
    mockNow = NOW - 2 * MIN;
    const r = renderScreen();
    await tick();
    perfMarks.clear();
    act(() => byLabel(r, 'Add a filter')!.props.onPress());
    expect(facetPasses()).toBe(1);
    expect(texts(r)).not.toContain('Due now (1)');
    // Now "laufen" is due, but the open sheet keeps the counts of its opening.
    mockNow = NOW;
    rerender(r);
    await tick();
    expect(facetPasses()).toBe(1);
    expect(texts(r)).not.toContain('Due now (1)');
    // A tap (Learning: "laufen" is a learning card) counts once more, at the time NOW.
    const learning = sheetText(r, 'Learning (')!;
    act(() => pressIn(r.root.findByType(FacetSheet), learning));
    await tick();
    expect(facetPasses()).toBe(2);
    expect(texts(r)).toContain('Due now (1)');
    // The tap undone: the same draft as the opening, but at the time NOW — counted once, with "laufen" due.
    act(() => pressIn(r.root.findByType(FacetSheet), sheetText(r, 'Learning (')!));
    await tick();
    expect(facetPasses()).toBe(3);
    expect(texts(r)).toContain('Due now (1)');
    // Closed, and opened again at the same time: the kept counts (no count).
    act(() => pressIn(r.root.findByType(FacetSheet), sheetText(r, 'Show ')!));
    await tick(600);
    act(() => byLabel(r, 'Add a filter')!.props.onPress());
    await tick();
    expect(facetPasses()).toBe(3);
    expect(texts(r)).toContain('Due now (1)');
    // Closed, the minute changes, and opened again WHILE the sheet still
    // slides out: a fresh body all the same, so this opening counts once, at the new time.
    act(() => pressIn(r.root.findByType(FacetSheet), sheetText(r, 'Show ')!));
    mockNow = NOW + MIN;
    rerender(r);
    act(() => byLabel(r, 'Add a filter')!.props.onPress());
    await tick();
    await tick();
    expect(facetPasses()).toBe(4);
    expect(texts(r)).toContain('Due now (1)');
  });
});

describe('review round 2 — a chip is never wider than the row allows (a real width, not only characters)', () => {
  it('chipMaxWidth: 85 % of the visible row; fitChipChars shrinks the text part by the same ratio', () => {
    expect(chipMaxWidth(320, 20)).toBeCloseTo(238);
    expect(chipMaxWidth(30, 20)).toBe(0);
    // 31 characters drawn 400 pt wide, at most 238 pt: the text part 353 → 191 pt.
    expect(fitChipChars(31, 400, 238)).toBe(Math.floor((31 * (238 - CHIP_CHROME)) / (400 - CHIP_CHROME)));
    expect(fitChipChars(31, 400, 238)).toBe(16);
    // It fits: nothing to do.
    expect(fitChipChars(31, 238, 238)).toBeNull();
    expect(fitChipChars(31, Number.NaN, 238)).toBeNull();
    // Always fewer characters than now, never fewer than CHIP_TEXT_MIN, and it stops there.
    expect(fitChipChars(20, 241, 240)).toBe(19);
    expect(fitChipChars(40, 2000, 60)).toBe(CHIP_TEXT_MIN);
    expect(fitChipChars(CHIP_TEXT_MIN, 2000, 60)).toBeNull();
  });

  it('a chip of 32 WIDE letters, drawn wider than the row allows, is cut again until it fits; a new label starts again', () => {
    const wide = 'Deck: WWWWWWWWWW WWWWWWWWWW WWWW';
    expect(Array.from(wide)).toHaveLength(32);
    const row = (label: string) =>
      React.createElement(FilterChipsRow, { chips: [{ key: 'decks', label, onRemove: () => undefined }], onAdd: () => undefined, inset: 20 });
    let made: ReactTestRenderer | null = null;
    act(() => {
      made = TestRenderer.create(row(wide));
    });
    const r = made!;
    const chipLabel = () =>
      String(
        r.root.findAll((n) => (n.type as unknown) === 'Text').map((n) => String(n.props.children)).find((t) => t !== 'Filter'),
      );
    const wrapper = () =>
      r.root.findAll(
        (n) =>
          (n.type as unknown) === 'View' &&
          typeof n.props.onLayout === 'function' &&
          (n.props.style as { paddingVertical?: number } | undefined)?.paddingVertical === 6,
      )[0];
    const first = chipLabel();
    const length = (text: string) => Array.from(text).length;
    // The font-size limit alone (limit 1).
    expect(first).toBe(chipText(wide, chipTextMax(Dimensions.get('window').fontScale)));
    // The row is 600 pt wide, so a chip may be 476 pt; the chip was drawn 600 pt wide.
    act(() => r.root.findByType(ScrollView).props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 600, height: 40 } } }));
    const max = chipMaxWidth(600, 20);
    act(() => wrapper().props.onLayout({ nativeEvent: { layout: { x: 20, y: 0, width: 600, height: 33 } } }));
    const second = chipLabel();
    expect(second).toBe(chipText(wide, fitChipChars(length(first), 600, max)!));
    expect(second.endsWith('…')).toBe(true);
    expect(length(second)).toBeLessThan(length(first));
    // Still a bit too wide: cut once more. Then it fits, and nothing changes any more.
    act(() => wrapper().props.onLayout({ nativeEvent: { layout: { x: 20, y: 0, width: max + 30, height: 33 } } }));
    const third = chipLabel();
    expect(length(third)).toBeLessThan(length(second));
    act(() => wrapper().props.onLayout({ nativeEvent: { layout: { x: 20, y: 0, width: max - 10, height: 33 } } }));
    expect(chipLabel()).toBe(third);
    // The screen reader still says the whole label.
    expect(r.root.findAll((n) => n.props.accessibilityLabel === `Remove filter ${wide}`).length).toBeGreaterThan(0);
    // A new label is measured from the start again (the limit belonged to the old label).
    act(() => r.update(row('Deck: German')));
    expect(chipLabel()).toBe('Deck: German');
    act(() => r.unmount());
  });
});

describe('review round 2 — while a complete token is EDITED, the list keeps its result', () => {
  const sctx = () => searchCtxFor(STATE.cards, CTX);
  const target = (text: string, shown: string | null) => listTextFor(text, shown, sctx, CTX.index);

  it('listTextFor: the shown text is kept only for an edit of ONE complete token with the same key', () => {
    // Backspace in "level:b1", or the whole value removed: the list keeps "level:b1".
    expect(target('level:b', 'level:b1')).toBe('level:b1');
    expect(target('level:', 'level:b1')).toBe('level:b1');
    expect(target('level:a', 'level:b1')).toBe('level:b1'); // another value, the same key
    expect(target('bahnhof level:b', 'bahnhof level:b1')).toBe('bahnhof level:b1');
    expect(target('-is:susp', '-is:suspended')).toBe('-is:suspended');
    // A NEW token: the text before it (the result the list had before the token began).
    expect(target('level:b', '')).toBe('');
    expect(target('level:b', null)).toBe('');
    expect(target('bahnhof level:b', 'bahnhof')).toBe('bahnhof');
    expect(target('level:', 'level')).toBe(''); // "level" was a word, not a token
    // Not an edit of the shown token: another key, another start, a space after it, or a half token.
    expect(target('tag:alg', 'level:b1')).toBe('');
    expect(target('is:susp', '-is:suspended')).toBe('');
    expect(target('haus level:b', 'bahnhof level:b1')).toBe('haus');
    expect(target('level:b', 'level:b1 ')).toBe('');
    expect(target('level:b', 'level:"b')).toBe('');
    expect(target('level:b', 'bahnhof level:b1')).toBe('');
    // Nothing half-typed: the box itself.
    expect(target('level:a2', 'level:b1')).toBe('level:a2');
    expect(target('bahnhof', 'level:b1')).toBe('bahnhof');
    expect(target('level:b1 ', 'level:b1')).toBe('level:b1 ');
    // Wave 5c: a space does not finish a half token. While it edits the shown
    // token, the list keeps it; else the list shows the box without it.
    expect(target('level:b ', 'level:b1')).toBe('level:b1');
    expect(target('level:b ', null)).toBe('');
    // Applied again to its own result, it gives the same text (the screen's debounce settles).
    for (const [text, shown] of [['level:b', 'level:b1'], ['bahnhof level:b', 'bahnhof'], ['level:b', null]] as const) {
      const once = target(text, shown);
      expect(target(text, once)).toBe(once);
    }
  });

  it('parseForList / shownQueryNow / facetStartQuery with the shown text: the kept query; the box keeps the half token', () => {
    const kept = parseForList('bahnhof level:b', sctx, CTX.index, 'bahnhof level:b1');
    expect(kept.query).toEqual({ fields: { level: ['b1'] }, text: 'bahnhof' });
    expect(kept.rest).toBe('bahnhof level:b');
    // Without a shown text: as before (the text before the token).
    expect(parseForList('bahnhof level:b', sctx, CTX.index).query).toEqual({ text: 'bahnhof' });
    const state = withText(withChips(initialLibraryState({}, LISTS), { decks: ['d-de'] }), 'level:b');
    expect(shownQueryNow(state, sctx, CTX.index, 'level:b1')).toEqual({ decks: ['d-de'], fields: { level: ['b1'] } });
    expect(facetStartQuery(state, sctx, CTX.index, 'level:b1')).toEqual({ decks: ['d-de'], fields: { level: ['b1'] } });
    expect(shownQueryNow(state, sctx, CTX.index, '')).toEqual({ decks: ['d-de'] });
  });

  it('facetsDone with the kept text: no change → null; a change makes the kept value a chip and keeps the half token', () => {
    const state = withText(withChips(initialLibraryState({}, LISTS), { decks: ['d-de'] }), 'level:b');
    const start = facetStartQuery(state, sctx, CTX.index, 'level:b1');
    expect(facetsDone(state, start, sctx, CTX.index, 'level:b1')).toBeNull();
    const a2 = toggleFacetValue(start, 'field:level', 'a2');
    const next = facetsDone(state, a2, sctx, CTX.index, 'level:b1')!;
    expect(sameQuery(next.chips, { decks: ['d-de'], fields: { level: ['b1', 'a2'] } })).toBe(true);
    expect(next.text).toBe('level:b');
    // The list then shows the text before the half token (nothing kept): exactly the draft.
    const listText = listTextFor(next.text, null, sctx, CTX.index);
    expect(listText).toBe('');
    const shown = listed(effectiveQuery(next.chips, parseForList(listText, sctx, CTX.index).query));
    expect(shown.sort()).toEqual(['c-a3', 'c-b1', 'c-b2', 'c-b3']);
    expect(shown).toHaveLength(resultCountFromFacets(deriveFacets(STATE.cards, {}, a2, CTX))!);
  });

  it('removeBestChip with the kept parse: the kept token becomes a chip as the list showed it; the half token stays', () => {
    const state = withText(initialLibraryState({}, LISTS), 'level:b');
    const next = removeBestChip(state, parseForList(state.text, sctx, CTX.index, 'level:b1'), 'flags');
    expect(next.chips).toEqual({ fields: { level: ['b1'] } });
    expect(next.text).toBe('level:b');
  });
});

describe('Library screen — review round 2: editing a complete token keeps the list', () => {
  /** Type `text` in the box and wait past the 150 ms debounce. */
  const typeAndWait = async (r: ReactTestRenderer, text: string) => {
    act(() => searchBox(r).props.onChangeText(text));
    await tick(200);
  };

  it('"level:b1" (3) → "level:b" → "level:a": still those 3 rows; "level:a2" applies (1)', async () => {
    mockParams = routeTo({ decks: ['d-de'] }, '1');
    const r = renderScreen();
    await typeAndWait(r, 'level:b1');
    const b1 = listData(r);
    expect(rowIds(r).sort()).toEqual(['c-b1', 'c-b2', 'c-b3']);
    expect(texts(r)).toContain('3 cards ·');
    await typeAndWait(r, 'level:b');
    expect(listData(r)).toBe(b1);
    expect(texts(r)).toContain('3 cards ·');
    await typeAndWait(r, 'level:');
    await typeAndWait(r, 'level:a');
    expect(listData(r)).toBe(b1);
    await typeAndWait(r, 'level:a2');
    expect(rowIds(r)).toEqual(['c-a3']);
    expect(texts(r)).toContain('1 card ·');
  });

  it('a NEW token still shows the text before it (not the result of a word typed earlier)', async () => {
    mockParams = routeTo({ decks: ['d-de'] }, '1');
    const r = renderScreen();
    await typeAndWait(r, 'level');
    expect(rowIds(r)).toEqual([]);
    await typeAndWait(r, 'level:b');
    expect(rowIds(r)).toHaveLength(6);
    expect(texts(r)).toContain('6 cards ·');
  });

  it('with a kept token, "Select all" and "+ Filter" use the list\'s 3 rows; "Show" keeps the box', async () => {
    mockParams = routeTo({ decks: ['d-de'] }, '1');
    const r = renderScreen();
    await typeAndWait(r, 'level:b1');
    await typeAndWait(r, 'level:b');
    act(() => byText(r, 'Select').props.onPress());
    act(() => byText(r, 'Select all 3').props.onPress());
    expect(texts(r)).toContain('3 selected');
    expect(rows(r).every((n) => n.props.selected === true)).toBe(true);
    act(() => byText(r, 'Cancel').props.onPress());
    // The FacetSheet starts from the list (B1 is on), "Show 3 cards".
    act(() => byLabel(r, 'Add a filter')!.props.onPress());
    await tick();
    const sheet = () => r.root.findByType(FacetSheet);
    expect(texts(r)).toContain('Show 3 cards');
    expect(byLabel(r, 'B1, 3 cards')!.props.accessibilityState).toEqual({ selected: true });
    // Pick A2 too: the chip is "Level: B1, A2", the box keeps "level:b", the list shows the 4 promised cards.
    act(() => pressIn(sheet(), 'A2 (1)'));
    expect(texts(r)).toContain('Show 4 cards');
    act(() => pressIn(sheet(), 'Show 4 cards'));
    expect(searchBox(r).props.value).toBe('level:b');
    expect(rowIds(r).sort()).toEqual(['c-a3', 'c-b1', 'c-b2', 'c-b3']);
    expect(texts(r)).toContain('4 cards ·');
    expect(r.root.findAll((n) => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('Remove filter Level:')).length).toBeGreaterThan(0);
  });
});

describe('review round 2 — rows name a direction like the Direction filter group', () => {
  it('card types with different template names: rows say "Front → Back" / "Back → Front", like the group and its chip', () => {
    const state = verbsAndWords();
    const ctx = matchCtxOf(state, NOW);
    const names = libraryDirectionNames(state.cards, ctx);
    expect(names.byRole).toBe(true);
    expect(libraryDirectionNames(state.cards, ctx)).toBe(names); // cached
    // The same labels as the FacetSheet's Direction group (its scope is the whole library).
    const group = deriveFacets(state.cards, {}, {}, ctx).find((f) => f.key === 'direction')!;
    expect(group.values.map((v) => [Number(v.value), v.label])).toEqual([...names.labels]);
    const label = directionLabeler(ctx.index, ctx.decks, () => libraryDirectionNames(state.cards, ctx));
    const byNote = (noteId: string, ord: number) => label(state.cards.find((c) => c.noteId === noteId && c.ord === ord)!);
    expect([byNote('v1', 0), byNote('w1', 0)]).toEqual(['Front → Back', 'Front → Back']);
    expect([byNote('v1', 1), byNote('w1', 1)]).toEqual(['Back → Front', 'Back → Front']);
    // Without the group, each card type's own template name (as before).
    const own = directionLabeler(ctx.index, ctx.decks);
    expect(own(state.cards.find((c) => c.noteId === 'v1' && c.ord === 1)!)).toBe('Reverse');
    expect(own(state.cards.find((c) => c.noteId === 'w1' && c.ord === 1)!)).toBe('EN-DE');
  });

  it('a card type that knows its languages keeps them ("Spanish → English"); the group is read only for the others', () => {
    let reads = 0;
    const label = directionLabeler(CTX.index, CTX.decks, () => {
      reads += 1;
      return libraryDirectionNames(STATE.cards, CTX);
    });
    expect(label(STATE.cards.find((c) => c.id === 'c-es1-0')!)).toBe('Spanish → English');
    expect(label(STATE.cards.find((c) => c.id === 'c-es1-1')!)).toBe('English → Spanish');
    expect(reads).toBe(0);
  });

  it('the screen: after the chip "Direction: Back → Front" no row says "Reverse" or "EN-DE"; without it, the role labels', () => {
    mockState = verbsAndWords();
    mockParams = routeTo({ directions: [1] }, '1');
    let r = renderScreen();
    expect(byLabel(r, 'Remove filter Direction: Back → Front')).toBeDefined();
    expect(rowIds(r)).toHaveLength(3);
    // One direction on screen: the rows do not repeat it, and never name it another way.
    expect(texts(r).some((t) => /Reverse|EN-DE/.test(t))).toBe(false);
    act(() => renderer!.unmount());
    renderer = null;
    mockParams = {};
    r = renderScreen();
    const detail = texts(r).filter((t) => t.includes('→'));
    expect(detail.some((t) => t.endsWith('· Front → Back'))).toBe(true);
    expect(detail.some((t) => t.endsWith('· Back → Front'))).toBe(true);
    expect(texts(r).some((t) => /Reverse|EN-DE|Forward|DE-EN/.test(t))).toBe(false);
  });
});

describe('review round 2 — M3 in the SaveListSheet: ONE scroll view above its buttons (the Sheet body)', () => {
  it('"Save as list": every button of the sheet sits in the Sheet\'s body ScrollView only, no scroll view of its own', () => {
    // M3 (a tap with the keyboard open must press the button, not only close
    // the keyboard) needs keyboardShouldPersistTaps="handled" on EVERY scroll
    // view above the button. This sheet has no scroll view of its own, so the
    // Sheet body's prop (src/components/ui/Sheet.tsx, unit P4) covers all of
    // its buttons. This test keeps it so: a scroll view added inside the
    // sheet would need the prop too.
    mockParams = routeTo({ fields: { level: ['b1'] } }, '1');
    const r = renderScreen();
    act(() => byText(r, 'Save as list').props.onPress());
    const sheet = r.root.findByType(SaveListSheet);
    expect(sheet.props.open).toBe(true);
    const scrollsAbove = (node: ReactTestInstance): ReactTestInstance[] => {
      const out: ReactTestInstance[] = [];
      for (let at: ReactTestInstance | null = node.parent; at && at !== sheet; at = at.parent) {
        if (at.type === ScrollView || at.type === FlatList) out.push(at);
      }
      return out;
    };
    // The sheet's own controls: its two buttons, an icon and the Name box (found inside the sheet only).
    const textIn = (text: string) => sheet.findAll((n) => (n.type as unknown) === 'Text' && n.props.children === text)[0];
    const labelIn = (label: string) =>
      sheet.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label)[0];
    const controls = [textIn('Save list'), textIn('Cancel'), labelIn('Icon ⭐'), labelIn('Name')];
    expect(controls.every((node) => node !== undefined)).toBe(true);
    for (const node of controls) {
      const scrolls = scrollsAbove(node);
      expect(scrolls).toHaveLength(1);
      // It is the Sheet's body: the one ScrollView of the Modal.
      expect(scrolls[0]).toBe(sheet.findByType(Modal).findByType(ScrollView));
    }
  });
});

/* =========================================================== wave 5c (F1b) */

describe('wave 5c — a space after a HALF-typed token keeps it as text (no 0-card chip)', () => {
  const sctx = () => searchCtxFor(STATE.cards, CTX);
  const s0 = initialLibraryState({}, LISTS);

  it('typeSearch: a half token stays in the box; complete tokens around it still become chips', () => {
    expect(typeSearch(s0, 'level:b ', sctx, CTX.index)).toMatchObject({ chips: {}, text: 'level:b ' });
    expect(typeSearch(s0, 'tag:alg ', sctx, CTX.index)).toMatchObject({ chips: {}, text: 'tag:alg ' });
    expect(typeSearch(s0, 'is:flag ', sctx, CTX.index)).toMatchObject({ chips: {}, text: 'is:flag ' });
    // Typing on after it: still no chip for it.
    expect(typeSearch(s0, 'level:b bahnhof ', sctx, CTX.index)).toMatchObject({ chips: {}, text: 'level:b bahnhof ' });
    // A complete token next to it becomes a chip; the half token stays in the box.
    expect(typeSearch(s0, 'is:due level:b ', sctx, CTX.index)).toMatchObject({ chips: { due: 'now' }, text: 'level:b ' });
    expect(typeSearch(s0, 'level:b is:due ', sctx, CTX.index)).toMatchObject({ chips: { due: 'now' }, text: 'level:b ' });
    // Complete: the chip, and an empty box.
    expect(typeSearch(s0, 'level:b1 ', sctx, CTX.index)).toMatchObject({ chips: { fields: { level: ['b1'] } }, text: '' });
    // A value that starts nothing is not half-typed: it is applied (0 cards, with a hint elsewhere).
    expect(typeSearch(s0, 'level:x ', sctx, CTX.index).chips).toEqual({ fields: { level: ['x'] } });
    // Return is an explicit "use this": it still makes the chip the learner typed.
    expect(submitSearch(s0, 'level:b', sctx).chips).toEqual({ fields: { level: ['b'] } });
  });

  it('pendingTokenStart / splitHalfTokens: a space does not finish a half token, at the end or in the middle', () => {
    expect(pendingTokenStart('level:b ', sctx(), CTX.index)).toBe(0);
    expect(pendingTokenStart('bahnhof level:b  ', sctx(), CTX.index)).toBe(8);
    expect(splitHalfTokens('level:b bahnhof', sctx(), CTX.index)).toEqual({ complete: 'bahnhof', half: ['level:b'] });
    expect(splitHalfTokens('is:due level:b tag:alg', sctx(), CTX.index)).toEqual({
      complete: 'is:due',
      half: ['level:b', 'tag:alg'],
    });
    // Nothing half-typed: the very same text.
    expect(splitHalfTokens('bahnhof level:b1 ', sctx(), CTX.index)).toEqual({ complete: 'bahnhof level:b1 ', half: [] });
  });

  it('the list shows no count for a half token anywhere in the box, and "Show" in the FacetSheet keeps it in the box', () => {
    expect(listTextFor('level:b ', null, sctx, CTX.index)).toBe('');
    expect(listTextFor('level:b bahnhof', null, sctx, CTX.index)).toBe('bahnhof');
    const parsed = parseForList('level:b bahnhof', sctx, CTX.index);
    expect(parsed.query).toEqual({ text: 'bahnhof' });
    // The box keeps the typed order (review round 1; before: 'bahnhof level:b').
    expect(parsed.rest).toBe('level:b bahnhof');
    expect(listed(effectiveQuery({}, parsed.query))).toEqual(['c-b1']);
    const state = withText(withChips(s0, { decks: ['d-de'] }), 'level:b bahnhof');
    const start = facetStartQuery(state, sctx, CTX.index);
    expect(start).toEqual({ decks: ['d-de'], text: 'bahnhof' });
    const next = facetsDone(state, toggleFacetValue(start, 'flags', 'flagged'), sctx, CTX.index)!;
    expect(next.chips).toEqual({ decks: ['d-de'], flags: ['flagged'] });
    expect(next.text).toBe('level:b bahnhof');
  });

  it('review round 1: a space commit and "Show" keep the order of what was typed (only the committed tokens leave the box)', () => {
    // 'level:b haus is:due ': the chip "Due now"; the box is 'level:b haus ', not 'haus level:b '.
    expect(typeSearch(s0, 'level:b bahnhof is:due ', sctx, CTX.index)).toMatchObject({
      chips: { due: 'now' },
      text: 'level:b bahnhof ',
    });
    expect(typeSearch(s0, 'Bahnhof level:b is:flagged tag:alg ', sctx, CTX.index)).toMatchObject({
      chips: { flags: ['flagged'] },
      text: 'Bahnhof level:b tag:alg ',
    });
    // A token that stays text (no such field) keeps its place too.
    expect(typeSearch(s0, 'level:b colour:red is:due ', sctx, CTX.index).text).toBe('level:b colour:red ');
    // "Show" in the FacetSheet with a new chip: the box keeps its words and half tokens in their order.
    const state = withText(s0, 'level:b bahnhof is:due');
    const start = facetStartQuery(state, sctx, CTX.index);
    expect(start).toEqual({ due: 'now', text: 'bahnhof' });
    const next = facetsDone(state, toggleFacetValue(start, 'flags', 'flagged'), sctx, CTX.index)!;
    expect(next.chips).toEqual({ due: 'now', flags: ['flagged'] });
    expect(next.text).toBe('level:b bahnhof');
    // The sheet changed the words ("Clear all" took the text away): the half token still stays.
    const cleared = facetsDone(state, { flags: ['flagged'] }, sctx, CTX.index)!;
    expect(cleared).toMatchObject({ chips: { flags: ['flagged'] }, text: 'level:b' });
  });

  it('review round 1: a field typed by the name its chip shows (`word_type:`) follows the half-token rule of its key', () => {
    const words: NoteType = {
      id: 'nt-wt',
      name: 'Words',
      kind: 'standard',
      fields: [
        { name: 'Word', role: 'term', facet: 'off' },
        { name: 'Meaning', role: 'meaning', facet: 'off' },
        { name: 'WordType', role: 'badge', facet: 'on' },
      ],
      templates: [{ ord: 0, name: 'Card', prompt: [0], answer: [1] }],
      sortField: 0,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const groups = [
      noteWithCards({ deckId: 'd-w', typeId: words.id, fields: ['Haus', 'house', 'noun'], note: { id: 'wt1' } }, [words]),
      noteWithCards({ deckId: 'd-w', typeId: words.id, fields: ['gehen', 'to go', 'verb'], note: { id: 'wt2' } }, [words]),
    ];
    const state = stateOfV3({ decks: [makeDeckV3({ id: 'd-w', name: 'Words' })], groups, types: [words] });
    const ctx = matchCtxOf(state, NOW);
    const wordsCtx = () => searchCtxFor(state.cards, ctx);
    // The chip says "Word Type: noun"; typed with its name, `nou` is still half-typed (no "No field" text, no 0-card chip).
    expect(chipsOf({ fields: { wordtype: ['noun'] } }, ctx)[0].label).toBe('Word Type: noun');
    expect(pendingTokenStart('word_type:nou', wordsCtx(), ctx.index)).toBe(0);
    expect(typeSearch(s0, 'word_type:nou ', wordsCtx, ctx.index)).toMatchObject({ chips: {}, text: 'word_type:nou ' });
    // Complete: the same chip as the key `wordtype:noun`.
    expect(typeSearch(s0, 'word_type:noun ', wordsCtx, ctx.index)).toMatchObject({ chips: { fields: { wordtype: ['noun'] } }, text: '' });
    expect(typeSearch(s0, 'wordtype:noun ', wordsCtx, ctx.index).chips).toEqual({ fields: { wordtype: ['noun'] } });
  });

  it('the screen: "level:b" + space shows no "Level: b" chip and keeps the count; "level:b1" + space makes the chip', async () => {
    const r = renderScreen();
    const all = mockState.cards.length;
    act(() => searchBox(r).props.onChangeText('level:b '));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(searchBox(r).props.value).toBe('level:b ');
    expect(texts(r).some((t) => t.startsWith('Level: b'))).toBe(false);
    expect(texts(r)).toContain(`${countLine(all)} ·`);
    expect(rowIds(r)).toHaveLength(all);
    act(() => searchBox(r).props.onChangeText('level:b1 '));
    expect(texts(r)).toContain('Level: B1');
    expect(searchBox(r).props.value).toBe('');
    expect(rowIds(r).sort()).toEqual(listed({ fields: { level: ['b1'] } }).sort());
  });
});

describe('wave 5c (M6) — "Choose ({n})" counts the ITEMS the triage it opens shows', () => {
  /** `n` Basic + reverse words, both directions Not started. */
  function bothWays(n: number): DataStateV3 {
    const deck = makeDeckV3({ id: 'd-w', name: 'Words' });
    const groups = Array.from({ length: n }, (_, i) =>
      noteWithCards({
        deckId: 'd-w',
        typeId: BUILTIN_TYPE_IDS.basicReverse,
        fields: [`word ${i}`, `meaning ${i}`, '', ''],
        note: { id: `w${i}`, order: i },
        card: () => lifeValues('notStarted'),
      }),
    );
    return stateOfV3({ decks: [deck], groups });
  }

  it('chooseCount: one item per note with every enabled direction; the same number as the triage counter', () => {
    const state = bothWays(3);
    const ctx = matchCtxOf(state, NOW);
    const rows = scopePool(state, {}, ctx, 'browse');
    expect(rows).toHaveLength(6);
    expect(chooseCount(rows, state.cards, ctx)).toEqual({ items: 3, cards: 6 });
    // The triage's own run over the same query (its lookups, triageLookupOf) says "0 / 3 items".
    const run = startRun(triageItems(rows, triageLookupOf(state, ctx)));
    expect(positionLabel(run)).toBe('0 / 3 items');
    // A Direction chip: the list holds one direction, but an item still changes both (like the triage).
    const one = scopePool(state, { directions: [1] }, ctx, 'browse');
    expect(one).toHaveLength(3);
    expect(chooseCount(one, state.cards, ctx)).toEqual({ items: 3, cards: 6 });
    // A direction turned off for the deck is not counted (the triage leaves it out too).
    const directions = new Map([[BUILTIN_TYPE_IDS.basicReverse, [0]]]);
    const off: DataStateV3 = {
      ...state,
      decks: state.decks.map((d) => ({ ...d, options: { ...d.options, directions: Object.fromEntries(directions) } })),
    };
    const offCtx = matchCtxOf(off, NOW);
    expect(chooseCount(scopePool(off, {}, offCtx, 'browse'), off.cards, offCtx)).toEqual({ items: 3, cards: 3 });
    // Nothing Not started: 0 (the button is hidden).
    const learned = { ...state, cards: state.cards.map((c) => ({ ...c, newState: 'queued' as const })) };
    const learnedCtx = matchCtxOf(learned, NOW);
    expect(chooseCount(scopePool(learned, {}, learnedCtx, 'browse'), learned.cards, learnedCtx).items).toBe(0);
  });

  // Wave 5d (M6): chooseCount built its OWN lookups instead of reusing deckPageLogic's
  // triageLookupOf (the triage screen's). Now both come from one function, so on every fixture of
  // this file (German + Spanish, Basic + reverse words; a direction turned off; a paused deck)
  // the Library's number IS the triage's number, for every query.
  it('chooseCount IS the triage’s count (triageLookupOf) on the fixtures, for every query', () => {
    /** Every card Not started (so each fixture has many items to choose). */
    const allNotStarted = (s: DataStateV3): DataStateV3 => ({ ...s, cards: s.cards.map((c) => ({ ...c, ...lifeValues('notStarted') })) });
    const library = fixture(); // German (legacy, one card per word) + Spanish (two directions)
    const words = bothWays(4);
    const variants: DataStateV3[] = [
      library,
      allNotStarted(library),
      words,
      // Direction 2 turned off for the words deck.
      { ...words, decks: words.decks.map((d) => ({ ...d, options: { ...d.options, directions: { [BUILTIN_TYPE_IDS.basicReverse]: [0] } } })) },
      // The Spanish deck paused (the Library still lists it; the triage counts it the same way).
      { ...allNotStarted(library), decks: library.decks.map((d) => (d.id === 'd-es' ? { ...d, active: false } : d)) },
    ];
    const queries: Query[] = [{}, { decks: ['d-es'] }, { decks: ['d-w'] }, { directions: [1] }, { life: ['notStarted'] }];
    let counted = 0;
    for (const state of variants) {
      const ctx = matchCtxOf(state, NOW);
      for (const q of queries) {
        const rows = scopePool(state, q, ctx, 'browse');
        const triage = triageItems(rows, triageLookupOf(state, ctx));
        expect([q, chooseCount(rows, state.cards, ctx)]).toEqual([q, { items: triage.length, cards: cardIdsOf(triage).length }]);
        counted += triage.length;
      }
    }
    expect(counted).toBeGreaterThan(20); // the fixtures really have Not started items to count
  });

  it('chooseButton: items; the unit is named when the items hold more cards (the count line says cards)', () => {
    expect(chooseButton({ items: 3, cards: 6 })).toEqual({
      label: 'Choose (3 items)',
      a11y: 'Choose what to learn, 6 cards (3 items) not started',
    });
    expect(chooseButton({ items: 1, cards: 2 }).label).toBe('Choose (1 item)');
    expect(chooseButton({ items: 6, cards: 6 })).toEqual({ label: 'Choose (6)', a11y: 'Choose what to learn, 6 cards not started' });
    expect(chooseButton({ items: 1, cards: 1 })).toEqual({ label: 'Choose (1)', a11y: 'Choose what to learn, 1 card not started' });
    expect(chooseButton({ items: 1234, cards: 1234 }).label).toBe('Choose (1,234)');
  });

  it('the screen: "6 cards" with "Choose (3 items)", and the button opens the triage of the same query', () => {
    mockState = bothWays(3);
    const r = renderScreen();
    expect(texts(r)).toContain('6 cards ·');
    expect(texts(r)).toContain('Choose (3 items)');
    expect(texts(r).some((t) => t === 'Choose (6)')).toBe(false);
    expect(byLabel(r, 'Choose what to learn, 6 cards (3 items) not started')).toBeDefined();
    act(() => byText(r, 'Choose (3 items)').props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith(triageHref({}, DEFAULT_SORT));
  });
});

describe('wave 5c — the chip row: a real max width from the text layout, and no stale chip to show', () => {
  const chip = (key: string, label: string) => ({ key, label, onRemove: () => undefined });
  const rowOf = (chips: { key: string; label: string; onRemove: () => void }[]) =>
    React.createElement(FilterChipsRow, { chips, onAdd: () => undefined, inset: 20 });
  /** The hidden copy that measures a chip's label (it has onTextLayout). */
  const measurer = (r: ReactTestRenderer, label: string) =>
    r.root.findAll((n) => (n.type as unknown) === 'Text' && typeof n.props.onTextLayout === 'function' && n.props.children === label)[0];
  /** The chip texts a person sees (not "+ Filter", not the hidden copies). */
  const chipTexts = (r: ReactTestRenderer) => visibleTexts(r).filter((t) => t !== 'Filter');
  /** The View that measures one chip (it has the chip's slop as padding). */
  const wrapper = (r: ReactTestRenderer, label: string) =>
    r.root.findAll(
      (n) =>
        (n.type as unknown) === 'View' &&
        typeof n.props.onLayout === 'function' &&
        (n.props.style as { paddingVertical?: number } | undefined)?.paddingVertical === 6 &&
        n.findAll((m) => m.props.accessibilityLabel === `Remove filter ${label}`).length > 0,
    )[0];
  const length = (text: string) => Array.from(text).length;

  it('chipTextRoom and textFromLines', () => {
    expect(chipTextRoom(238, 1)).toBe(238 - CHIP_CHROME - ELLIPSIS_ROOM);
    expect(chipTextRoom(238, 2)).toBe(238 - CHIP_CHROME - 2 * ELLIPSIS_ROOM);
    expect(chipTextRoom(238, Number.NaN)).toBe(238 - CHIP_CHROME - ELLIPSIS_ROOM);
    expect(chipTextRoom(40, 1)).toBe(0);
    const long = 'Deck: German — Everyday, German — Conversation, German';
    expect(textFromLines('Level: B1, B2', [{ text: 'Level: B1, B2' }])).toBe('Level: B1, B2');
    expect(textFromLines('Level: B1, B2', [])).toBe('Level: B1, B2');
    expect(textFromLines(long, [{ text: 'Deck: German — Everyday, German — ' }, { text: 'Conversation, German' }])).toBe(
      'Deck: German — Everyday, German…',
    );
    // A word longer than the line: the phone breaks inside it.
    expect(textFromLines('Tag: Supercalifragilistic', [{ text: 'Tag: Supercali' }, { text: 'fragilistic' }])).toBe('Tag: Supercali…');
    // A first line that is not the start of the label: the character cut.
    expect(textFromLines(long, [{ text: 'something else' }, { text: 'x' }])).toBe(chipText(long, CHIP_TEXT_MIN));
  });

  it('the text layout decides: a long label that fits stays WHOLE (no 32-character cut); one that does not is cut where it stops fitting', () => {
    const { fontScale } = Dimensions.get('window');
    const fits = 'Section: Vocabulary › Everyday life › Kitchen';
    expect(length(fits)).toBeGreaterThan(CHIP_TEXT_MAX);
    let made: ReactTestRenderer | null = null;
    act(() => {
      made = TestRenderer.create(rowOf([chip('sections', fits)]));
    });
    const r = made!;
    // Before the layout answers (the first frame): the guess by characters.
    expect(chipTexts(r)).toEqual([chipText(fits, chipTextMax(fontScale))]);
    // The row is 600 pt wide: the hidden copy is drawn exactly as wide as the text may be.
    act(() => r.root.findByType(ScrollView).props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 600, height: 40 } } }));
    const copy = measurer(r, fits);
    // Its box: the nearest View around it that is hidden from screen readers.
    let box: ReactTestInstance | null = copy.parent;
    while (box && box.props.importantForAccessibility !== 'no-hide-descendants') box = box.parent;
    expect(StyleSheet.flatten(box!.props.style)).toMatchObject({
      position: 'absolute',
      width: chipTextRoom(chipMaxWidth(600, 20), fontScale),
      opacity: 0,
    });
    // One line: the whole label, though it has more than 32 characters.
    act(() => copy.props.onTextLayout({ nativeEvent: { lines: [{ text: fits }] } }));
    expect(chipTexts(r)).toEqual([fits]);
    // Measured: the hidden copy is gone (nothing left to measure for this label and width).
    expect(measurer(r, fits)).toBeUndefined();
    // A new label is measured again; one that needs two lines is cut after its first line.
    const long = 'Deck: German — Everyday, German — Conversation, German';
    act(() => r.update(rowOf([chip('sections', long)])));
    expect(chipTexts(r)).toEqual([chipText(long, chipTextMax(fontScale))]);
    act(() =>
      measurer(r, long).props.onTextLayout({
        nativeEvent: { lines: [{ text: 'Deck: German — Everyday, German — ' }, { text: 'Conversation, German' }] },
      }),
    );
    expect(chipTexts(r)).toEqual(['Deck: German — Everyday, German…']);
    expect(r.root.findAll((n) => n.props.accessibilityLabel === `Remove filter ${long}`).length).toBeGreaterThan(0);
    // The safety net still holds: drawn wider than the limit anyway → fewer characters.
    const max = chipMaxWidth(600, 20);
    act(() => wrapper(r, long).props.onLayout({ nativeEvent: { layout: { x: 20, y: 0, width: max + 40, height: 33 } } }));
    expect(length(chipTexts(r)[0])).toBeLessThan(length('Deck: German — Everyday, German…'));
    act(() => r.unmount());
  });

  it('a label change that keeps the chip\'s size leaves nothing waiting: a later removal does not scroll the row by itself', () => {
    const deck = chip('decks', 'Deck: German');
    let made: ReactTestRenderer | null = null;
    act(() => {
      made = TestRenderer.create(rowOf([deck, chip('field:level', 'Level: B1')]));
    });
    const r = made!;
    const scroll = r.root.findByType(ScrollView);
    const scrollTo = jest.fn();
    (scroll.instance as { scrollTo: unknown }).scrollTo = scrollTo;
    act(() => scroll.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 40 } } }));
    act(() => wrapper(r, 'Deck: German').props.onLayout({ nativeEvent: { layout: { x: 20, y: 0, width: 120, height: 33 } } }));
    act(() => wrapper(r, 'Level: B1').props.onLayout({ nativeEvent: { layout: { x: 148, y: 0, width: 100, height: 33 } } }));
    // "Level: B1" → "Level: B2": the same size and in view — no scroll, and no new onLayout for it.
    act(() => r.update(rowOf([deck, chip('field:level', 'Level: B2')])));
    expect(scrollTo).not.toHaveBeenCalled();
    // The learner scrolls the row, then removes "Deck: German": the level chip moves left (its onLayout).
    act(() => scroll.props.onScroll({ nativeEvent: { contentOffset: { x: 200, y: 0 } } }));
    act(() => r.update(rowOf([chip('field:level', 'Level: B2')])));
    act(() => wrapper(r, 'Level: B2').props.onLayout({ nativeEvent: { layout: { x: 20, y: 0, width: 100, height: 33 } } }));
    // Nothing new to show: the row stays where the learner put it.
    expect(scrollTo).not.toHaveBeenCalled();
    // A NEW chip still scrolls into view.
    act(() => r.update(rowOf([chip('field:level', 'Level: B2'), chip('life', 'Not started')])));
    act(() => wrapper(r, 'Not started').props.onLayout({ nativeEvent: { layout: { x: 128, y: 0, width: 110, height: 33 } } }));
    expect(scrollTo).toHaveBeenLastCalledWith({ x: 108, animated: true });
    act(() => r.unmount());
  });

  /* ------------------------------------------------------- review round 1 */

  it('review round 1: a long single word moved whole to line 2 is cut INSIDE the word, never down to "Deck…"', () => {
    // The phone breaks after "Deck: " and puts the long word on line 2 (broken inside it on line 2).
    const name = 'Deck: German_Complete_Vocabulary_Edition';
    expect(textFromLines(name, [{ text: 'Deck: ' }, { text: 'German_Complete_Vocab' }, { text: 'ulary_Edition' }])).toBe(
      'Deck: German_Complete…',
    );
    // The word fits a whole line, but not after "Deck: ": still a cut inside it (line 2 holds that many characters).
    expect(textFromLines('Deck: German_Complete_Vocab', [{ text: 'Deck: ' }, { text: 'German_Complete_Vocab' }])).toBe(
      'Deck: German_Complete…',
    );
    // A value on line 1, then a word wider than a whole line: the room after the value is used too.
    expect(
      textFromLines('Tag: algopack German_Complete_Vocabulary_Edition', [
        { text: 'Tag: algopack ' },
        { text: 'German_Complete_Vocab' },
        { text: 'ulary_Edition' },
      ]),
    ).toBe('Tag: algopack German_…');
    // A long first line keeps its word-boundary cut when the cut inside the word would show less.
    expect(
      textFromLines('Deck: German — Everyday, German_Complete_Vocabulary_Edition', [
        { text: 'Deck: German — Everyday, ' },
        { text: 'German_Complete_Vocab' },
        { text: 'ulary_Edition' },
      ]),
    ).toBe('Deck: German — Everyday…');
    // Lines that do not follow the label: no cut inside a word (the old rules).
    expect(textFromLines(name, [{ text: 'Deck: ' }, { text: 'something else' }])).toBe('Deck…');
    // On screen: the chip shows the value, and a screen reader still says the whole label.
    let made: ReactTestRenderer | null = null;
    act(() => {
      made = TestRenderer.create(rowOf([chip('decks', name)]));
    });
    const r = made!;
    act(() =>
      measurer(r, name).props.onTextLayout({
        nativeEvent: { lines: [{ text: 'Deck: ' }, { text: 'German_Complete_Vocab' }, { text: 'ulary_Edition' }] },
      }),
    );
    expect(chipTexts(r)).toEqual(['Deck: German_Complete…']);
    expect(r.root.findAll((n) => n.props.accessibilityLabel === `Remove filter ${name}`).length).toBeGreaterThan(0);
    act(() => r.unmount());
  });

  it('review round 1: a NEW long chip that grows when its text is measured is scrolled into view AGAIN', () => {
    const long = 'Section: Vocabulary › Everyday life › Kitchen';
    const deck = chip('decks', 'Deck: German');
    let made: ReactTestRenderer | null = null;
    act(() => {
      made = TestRenderer.create(rowOf([deck]));
    });
    const r = made!;
    const scroll = r.root.findByType(ScrollView);
    const scrollTo = jest.fn();
    (scroll.instance as { scrollTo: unknown }).scrollTo = scrollTo;
    // A 412 pt phone; the deck chip is measured.
    act(() => scroll.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 412, height: 40 } } }));
    act(() => wrapper(r, 'Deck: German').props.onLayout({ nativeEvent: { layout: { x: 20, y: 0, width: 120, height: 33 } } }));
    // The new chip comes in. First frame: the character guess, 150 pt wide at x 300 → scrolled to show its end.
    act(() => r.update(rowOf([deck, chip('sections', long)])));
    act(() => wrapper(r, long).props.onLayout({ nativeEvent: { layout: { x: 300, y: 0, width: 150, height: 33 } } }));
    expect(scrollTo).toHaveBeenLastCalledWith({ x: 58, animated: true });
    // The phone measures the label: it fits whole, so the chip grows to 300 pt.
    act(() => measurer(r, long).props.onTextLayout({ nativeEvent: { lines: [{ text: long }] } }));
    expect(chipTexts(r)).toContain(long);
    act(() => wrapper(r, long).props.onLayout({ nativeEvent: { layout: { x: 300, y: 0, width: 300, height: 33 } } }));
    // Its end (and "+ Filter") is brought into view again: 300 + 300 + 20 − 412.
    expect(scrollTo).toHaveBeenLastCalledWith({ x: 208, animated: true });
    expect(scrollTo).toHaveBeenCalledTimes(2);
    // Its text is final now: nothing waits, so a later move of the chip does not scroll the row.
    act(() => scroll.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 0 } } }));
    act(() => wrapper(r, long).props.onLayout({ nativeEvent: { layout: { x: 310, y: 0, width: 300, height: 33 } } }));
    expect(scrollTo).toHaveBeenCalledTimes(2);
    act(() => r.unmount());
  });

  /* ------------------------------------------------------------ wave 5d (F1b) */

  // A chip that waited with only its character-guess width kept waiting for ever when its measured
  // text had the SAME size (no onLayout came). A later, unrelated move of the chip — here a new row
  // width — then scrolled the row by itself, away from where the learner had put it.
  it('wave 5d: a measured text of the same size ends the wait after one frame; a later move does not scroll the row', () => {
    jest.useFakeTimers();
    try {
      const long = 'Section: Vocabulary › Everyday life › Kitchen';
      const deck = chip('decks', 'Deck: German');
      let made: ReactTestRenderer | null = null;
      act(() => {
        made = TestRenderer.create(rowOf([deck]));
      });
      const r = made!;
      const scroll = r.root.findByType(ScrollView);
      const scrollTo = jest.fn();
      (scroll.instance as { scrollTo: unknown }).scrollTo = scrollTo;
      act(() => scroll.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 412, height: 40 } } }));
      act(() => wrapper(r, 'Deck: German').props.onLayout({ nativeEvent: { layout: { x: 20, y: 0, width: 120, height: 33 } } }));
      // The new chip: first frame, the character guess, 150 pt wide at x 300 → scrolled to show it.
      act(() => r.update(rowOf([deck, chip('sections', long)])));
      act(() => wrapper(r, long).props.onLayout({ nativeEvent: { layout: { x: 300, y: 0, width: 150, height: 33 } } }));
      expect(scrollTo).toHaveBeenCalledTimes(1);
      // The phone measures the label: its final text is exactly as wide as the guess, so NO onLayout comes.
      act(() => measurer(r, long).props.onTextLayout({ nativeEvent: { lines: [{ text: long }] } }));
      act(() => jest.advanceTimersByTime(100)); // the next frame is drawn: the wait is over
      // The learner scrolls the row back to the start; then the row gets a new width (the phone turns),
      // and the chip moves (its onLayout). The row stays where the learner put it.
      act(() => scroll.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 0 } } }));
      act(() => wrapper(r, long).props.onLayout({ nativeEvent: { layout: { x: 310, y: 0, width: 150, height: 33 } } }));
      expect(scrollTo).toHaveBeenCalledTimes(1);
      // A NEW chip still scrolls into view, as always.
      act(() => r.update(rowOf([deck, chip('sections', long), chip('life', 'Not started')])));
      act(() => wrapper(r, 'Not started').props.onLayout({ nativeEvent: { layout: { x: 470, y: 0, width: 110, height: 33 } } }));
      expect(scrollTo).toHaveBeenCalledTimes(2);
      act(() => r.unmount());
    } finally {
      jest.useRealTimers();
    }
  });

  it('wave 5d: before that frame, the grown chip still scrolls into view again (review round 1 keeps working)', () => {
    jest.useFakeTimers();
    try {
      const long = 'Section: Vocabulary › Everyday life › Kitchen';
      let made: ReactTestRenderer | null = null;
      act(() => {
        made = TestRenderer.create(rowOf([chip('decks', 'Deck: German')]));
      });
      const r = made!;
      const scroll = r.root.findByType(ScrollView);
      const scrollTo = jest.fn();
      (scroll.instance as { scrollTo: unknown }).scrollTo = scrollTo;
      act(() => scroll.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 412, height: 40 } } }));
      act(() => r.update(rowOf([chip('decks', 'Deck: German'), chip('sections', long)])));
      act(() => wrapper(r, long).props.onLayout({ nativeEvent: { layout: { x: 300, y: 0, width: 150, height: 33 } } }));
      act(() => measurer(r, long).props.onTextLayout({ nativeEvent: { lines: [{ text: long }] } }));
      // The grown chip's onLayout comes with the same layout (before the next frame): scrolled again.
      act(() => wrapper(r, long).props.onLayout({ nativeEvent: { layout: { x: 300, y: 0, width: 300, height: 33 } } }));
      expect(scrollTo).toHaveBeenCalledTimes(2);
      act(() => jest.advanceTimersByTime(100));
      act(() => wrapper(r, long).props.onLayout({ nativeEvent: { layout: { x: 310, y: 0, width: 300, height: 33 } } }));
      expect(scrollTo).toHaveBeenCalledTimes(2);
      act(() => r.unmount());
    } finally {
      jest.useRealTimers();
    }
  });
});
