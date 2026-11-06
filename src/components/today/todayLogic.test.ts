/**
 * Tests for the Today tab (spec §8.1, §8.10, §8.11, unit W4-1).
 *
 * Part 1 — the pure rules (todayLogic.ts), on real v3 states built with the
 * real scheduler (scope.ts):
 *   - the hero: "{n} cards ready · about {m} min", "34 ready · Study 30" when
 *     the session size cuts the run; the "Up first" card is the first card
 *     of the queue the button opens; the breakdown line adds up to the session;
 *   - the goal bars: a goal of 0 hides its bar;
 *   - which state Today shows (no decks, all paused, only Not started,
 *     caught up …) and the caught-up buttons (only counts above 0);
 *   - the deck rows: "{d} due · {n} new", the pill = that deck's OWN session
 *     (launch count === queue length), paused decks collapse and have no
 *     pill, and the shared-limit note when the pills add up to more than the
 *     total (device finding 2026-10-24) — naming only its real cause (the
 *     new-card limit, the review limit or the session size);
 *   - the lists: hidden zero built-in lists behind "Show all lists", user
 *     lists shown, hidden lists, order, and the list pill = its session;
 *   - which one-time card shows (repairs first, then the reminder offer once);
 *   - the streak sheet's REAL freeze count over the last 14 days;
 *   - the AddSheet rows and the starter-deck snackbar texts;
 *   - every count says "1 card", never "1 cards" (plural());
 *   - the "New list" route param and its banner (the contract with Library).
 *
 * Part 3 — merge guards: W4-1 merges LAST in wave 4 (spec §10.7). Three things
 * of this unit can only be finished after the Library unit (W4-2) is in:
 * Library must show the "New list" banner, AddDeckSheet.tsx must go when
 * browse.tsx goes, and list "Rename" must open SaveListSheet. These tests
 * fail after the merge until that is done.
 *
 * Part 2b — wave 5i (release re-measure): the "Study {n}" pulse is FINITE.
 * It breathes STUDY_PULSE.times times when Today shows (and when its number
 * changes), then ends: no timer is left. None while Today is not in front
 * (useIsFocused, mocked by `mockFocused`), none with Reduce Motion.
 *
 * Part 2 — the wiring of the screens, rendered with react-test-renderer
 * (module mocks below: the store hooks read one in-memory state and the
 * actions run the REAL reducer on it; the router, icons, theme and the
 * phone-only modules are small fakes). The tab bar's presses run through
 * expo-router's REAL tab router, so the test sees what the phone does with
 * the route params (a press keeps Library's q + nonce).
 */
// '@jest/globals' first: the jest.mock factories below use its `jest`.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import React from 'react';
import { AccessibilityInfo, Animated, StyleSheet } from 'react-native';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { BUILTIN_TYPE_IDS } from '../../domain/builtinTypes';
import { BUILTIN_LISTS } from '../../domain/lists';
import type { Card, DataStateV3, Deck, ListDef, ReadyCounts } from '../../domain/model';
import { parseQueryParam, serializeQuery } from '../../domain/query';
import { buildSessionQueue, deckStatsMap, matchCtxOf, readyFor, scopePool } from '../../domain/scope';
import { addDays, DAY, dayKeyOf, HOUR } from '../../domain/types';
import * as reducer from '../../store/reducer';
import type { SnackMessage } from '../../store/SnackbarContext';
import { subscribeReduceMotion } from '../../store/useReduceMotion';
import { FIXED_NOW, localTime } from '../../test/clock';
import {
  lifeValues,
  makeDeckV3,
  makePersonV3,
  makeSettingsV3,
  noteWithCards,
  stateOfV3,
  testCtx,
} from '../../test/factoriesV3';
import { light } from '../../theme/tokens';
import type { ContentPack, StarterDeck } from '../../variants/types';
import { triageLookupOf } from '../deck/deckPageLogic';
import { triageItems } from '../deck/triageLogic';
import { keepGoingCounts } from '../study/sessionLogic';
// expo-router's own copy of the React Navigation tab router: the tab-bar test
// runs the bar's presses through the REAL router (a deep import, so the
// 'expo-router' mock of Part 2 does not replace it).
import {
  CommonActions,
  type TabNavigationState,
  TabRouter,
} from 'expo-router/build/react-navigation/routers';
// The screens under test (jest moves the jest.mock calls of Part 2 above every import).
import { MarankiTabBar, TAB_LABEL_MAX_SCALE, TABS } from '../../app/(tabs)/_layout';
import TodayScreen from '../../app/(tabs)/index';
import { AddSheet } from '../sheets/AddSheet';
import { startStudyPulse } from './TodayHero';
import { ListActionsSheet } from '../sheets/ListActionsSheet';
import {
  addSheetRows,
  ALL_SCOPE,
  allLists,
  breakdownLine,
  caughtUpActions,
  clockLabel,
  dateOverline,
  deckRoute,
  deckRowModel,
  deckScope,
  freezesUsedLine,
  freezesUsedRecently,
  goalBars,
  greeting,
  heroLine,
  libraryRoute,
  LIST_ACTION_LABEL,
  listActionKeys,
  listPrefOf,
  listRowLine,
  listRowStats,
  listScope,
  NEW_LIST_BANNER,
  NEW_LIST_PARAM,
  newListBannerFor,
  NOT_STARTED_SCOPE,
  notStartedItemCount,
  notStartedItemsReader,
  packChoiceFor,
  pausedLabel,
  PRACTICE_SCOPE,
  pickOneTimeCard,
  pulseOn,
  REMINDER_OFFER_HREF,
  reminderOfferButton,
  repairsLine,
  sessionRoute,
  SHARED_LIMIT_COPY,
  sharedLimitNote,
  showNoListsLine,
  splitDecks,
  splitLists,
  starterMessage,
  STUDY_PULSE,
  streakStrip,
  streakUnit,
  studyLabel,
  TODAY_COPY,
  todayLists,
  todayListsReader,
  todayMode,
  triageRoute,
  upFirstCard,
  upFirstReader,
} from './todayLogic';

const NOW = FIXED_NOW;

/* ================================================================ fixtures */

let frontSeq = 0;

/** One Basic note with one card in `deckId`, with the card's values. */
function card(deckId: string, values: Partial<Card>) {
  frontSeq += 1;
  return noteWithCards({ deckId, fields: [`word ${frontSeq}`, 'back', '', ''], card: values });
}

/** Only the SRS values of a lifecycle (lifeValues: no ids), plus `extra`. */
function lifeOf(kind: Parameters<typeof lifeValues>[0], extra: Partial<Card> = {}): Partial<Card> {
  return { ...lifeValues(kind, NOW), ...extra };
}
/** A due review card (due an hour ago). */
const dueReview = (): Partial<Card> => lifeOf('review', { due: NOW - HOUR });
/** A new card (in the queue, never studied). */
const newCard = (): Partial<Card> => ({});
/** A Not started card. */
const notStarted = (): Partial<Card> => lifeOf('notStarted');

/**
 * A library of decks: `decks` = [id, name, card values[], active?]. The
 * settings: daily new limit 10, no session-size cap unless given.
 */
function library(
  decks: [string, string, Partial<Card>[], boolean?][],
  overrides: Partial<DataStateV3> = {},
  settings: Parameters<typeof makeSettingsV3>[0] = {},
): DataStateV3 {
  const deckObjs: Deck[] = decks.map(([id, name, , active], i) => makeDeckV3({ id, name, active: active ?? true, order: i }));
  const groups = decks.flatMap(([id, , values]) => values.map((v) => card(id, v)));
  return stateOfV3({
    decks: deckObjs,
    groups,
    overrides: { settings: makeSettingsV3({ sessionLimit: 0, ...settings, srs: { dailyNewLimit: 10, ...settings.srs } }), ...overrides },
  });
}

const times = <T,>(n: number, make: () => T): T[] => Array.from({ length: n }, make);

/** The session the hero's "Study {n}" opens. */
const heroQueue = (s: DataStateV3) => buildSessionQueue({ kind: 'scheduled', q: ALL_SCOPE }, s, matchCtxOf(s, NOW));
const readyAll = (s: DataStateV3) => readyFor(s, ALL_SCOPE, matchCtxOf(s, NOW));

/** The counts of a deck pill of `total` reviews (for the shared-limit note). */
const pill = (total: number) => ({ total, due: total, neww: 0 });
/** The hero's counts: `total` reviews, not cut. */
const heroOf = (total: number) => ({ total, due: total, neww: 0, uncappedTotal: total });

/* ================================================================ Part 1 — pure rules */

describe('header and hero', () => {
  it('date line and greeting follow the local clock', () => {
    // FIXED_NOW is Wednesday 10 June 2026, 09:00.
    expect(dateOverline(NOW)).toBe('Wednesday 10 June');
    expect(greeting(localTime('2026-06-10', '09:00'))).toBe('Good morning');
    expect(greeting(localTime('2026-06-10', '12:00'))).toBe('Good afternoon');
    expect(greeting(localTime('2026-06-10', '17:59'))).toBe('Good afternoon');
    expect(greeting(localTime('2026-06-10', '18:00'))).toBe('Good evening');
  });

  it('hero line: "{n} cards ready · about {m} min", plural-aware', () => {
    const one: ReadyCounts = { total: 1, learning: 0, due: 1, checks: 0, neww: 0, mins: 1, capped: false, uncappedTotal: 1 };
    expect(heroLine(one)).toBe('1 card ready · about 1 min');
    expect(heroLine({ ...one, total: 30, mins: 12, uncappedTotal: 30 })).toBe('30 cards ready · about 12 min');
  });

  it('hero line when the session size cuts the run: "34 ready · Study 30" (spec §4.6)', () => {
    const s = library([['d1', 'German', times(34, dueReview)]], {}, { sessionLimit: 30 });
    const ready = readyAll(s);
    expect(ready.capped).toBe(true);
    expect(heroLine(ready)).toBe('34 ready · Study 30');
    expect(studyLabel(ready.total)).toBe('Study 30');
    // The button's number is the session it opens.
    expect(heroQueue(s)).toHaveLength(30);
    expect(studyLabel(1240)).toBe('Study 1,240');
  });

  it('the breakdown adds up to the session and leaves zeros out', () => {
    const s = library([['d1', 'German', [...times(12, dueReview), ...times(3, newCard), lifeOf('learning', { due: NOW - 60_000 })]]]);
    const ready = readyAll(s);
    expect(ready.due + ready.learning + ready.neww + ready.checks).toBe(ready.total);
    expect(breakdownLine(ready)).toBe('12 due · 1 learning · 3 new');
    expect(breakdownLine({ due: 0, learning: 0, neww: 5, checks: 1 })).toBe('5 new · 1 check');
    expect(breakdownLine({ due: 0, learning: 0, neww: 0, checks: 2 })).toBe('2 checks');
  });

  it('"Up first" is the first card of the queue the hero button opens', () => {
    const s = library([['d1', 'German', [...times(2, newCard), dueReview()]]]);
    const first = upFirstCard(s, NOW);
    expect(first).not.toBeNull();
    expect(first!.id).toBe(heroQueue(s)[0].id);
    // A due review comes before new cards in the planned queue.
    expect(first!.reps).toBeGreaterThan(0);
    expect(upFirstCard(library([]), NOW)).toBeNull();
  });

  it('upFirstReader keeps its answer while nothing it reads changed, and follows a rating', () => {
    const s = library([['d1', 'German', [dueReview(), dueReview()]]]);
    const read = upFirstReader(NOW);
    const a = read(s);
    const sameInputs: DataStateV3 = { ...s, sessions: [...s.sessions] }; // sessions are not an input
    expect(read(sameInputs)).toBe(a);
    const rated = reducer.rateCard(s, { cardId: a!.id, rating: 'good' }, testCtx(NOW)).state;
    expect(read(rated)?.id).not.toBe(a!.id);
  });

  it('goal bars: a goal of 0 hides its bar; the bar is capped at 100%', () => {
    expect(goalBars({ reviews: 12, neww: 4 }, { goalReviews: 30, goalNew: 10 })).toEqual([
      { key: 'reviews', label: 'Reviews', done: 12, goal: 30, pct: 40, text: '12 / 30 goal', a11y: 'Reviews: 12 of 30 goal' },
      { key: 'new', label: 'New', done: 4, goal: 10, pct: 40, text: '4 / 10 goal', a11y: 'New: 4 of 10 goal' },
    ]);
    expect(goalBars({ reviews: 12, neww: 4 }, { goalReviews: 0, goalNew: 10 }).map((b) => b.key)).toEqual(['new']);
    expect(goalBars({ reviews: 12, neww: 4 }, { goalReviews: 0, goalNew: 0 })).toEqual([]);
    expect(goalBars({ reviews: 50, neww: 0 }, { goalReviews: 30, goalNew: 10 })[0].pct).toBe(100);
  });
});

describe('which state Today shows', () => {
  /** todayMode with the inputs the screen gives it (index.tsx): `notStarted` = the triage ITEMS. */
  const mode = (s: DataStateV3) => {
    const ctx = matchCtxOf(s, NOW);
    return todayMode({
      decks: s.decks,
      stats: deckStatsMap(s, ctx),
      readyTotal: readyAll(s).total,
      notStarted: notStartedItemCount(s, NOW),
    });
  };

  it('no decks → "Start with a deck"', () => {
    expect(mode(library([]))).toBe('noDecks');
  });

  it('every deck paused → "All your decks are paused."', () => {
    expect(mode(library([['d1', 'German', [dueReview()], false]]))).toBe('allPaused');
  });

  it('decks without cards → noCards', () => {
    expect(mode(library([['d1', 'German', []]]))).toBe('noCards');
    // A paused deck without cards does not change that: there is no card at all.
    expect(mode(library([['d1', 'German', []], ['d2', 'Old', [], false]]))).toBe('noCards');
  });

  it('empty active decks next to a paused deck WITH cards → pausedCardsOnly, never "no cards yet" (review round 1)', () => {
    // A realistic case: the learner paused an imported deck and made a new, empty deck.
    const s = library([
      ['d1', 'New deck', []],
      ['d2', 'Imported', times(300, dueReview), false],
    ]);
    expect(readyAll(s).total).toBe(0); // the paused deck's cards leave Today
    expect(mode(s)).toBe('pausedCardsOnly');
    expect(TODAY_COPY.pausedCardsTitle).toBe('Your cards are in paused decks.');
    expect(TODAY_COPY.pausedCardsSub).toBe('Your other decks have no cards yet.');
    // Not started cards in the paused deck count too: they are cards.
    expect(mode(library([['d1', 'New deck', []], ['d2', 'Imported', [notStarted()], false]]))).toBe('pausedCardsOnly');
  });

  it('something ready → the study hero', () => {
    expect(mode(library([['d1', 'German', [dueReview()]]]))).toBe('study');
  });

  it('only Not started cards → "Nothing is in your queue yet."', () => {
    expect(mode(library([['d1', 'German', times(3, notStarted)]]))).toBe('notStartedOnly');
    // Known cards with Not started ones: still nothing in the queue.
    expect(mode(library([['d1', 'German', [notStarted(), lifeOf('known')]]]))).toBe('notStartedOnly');
  });

  // W4-1 review round 2: the button "Choose what to learn" opened an empty triage (a dead end, E11).
  it('suspended Not started cards do not give "Nothing is in your queue yet." (triage leaves them out)', () => {
    const suspendedNotStarted = () => lifeOf('notStarted', { suspended: true });
    const s = library([['d1', 'German', times(3, suspendedNotStarted)]]);
    const ctx = matchCtxOf(s, NOW);
    // The deck's status counts still list them: they ARE Not started cards of the deck …
    expect(deckStatsMap(s, ctx).get('d1')!.life.notStarted).toBe(3);
    // … but the triage scope of the button has none of them,
    expect(scopePool(s, NOT_STARTED_SCOPE, ctx, 'browse')).toHaveLength(0);
    // so Today does not send the learner there.
    expect(mode(s)).toBe('caughtUp');
    // One Not started card that is not suspended: the button has a card to show.
    expect(mode(library([['d1', 'German', [...times(3, suspendedNotStarted), notStarted()]]]))).toBe('notStartedOnly');
  });

  it('cards exist but nothing is ready → caught up', () => {
    expect(mode(library([['d1', 'German', [lifeOf('review')]]]))).toBe('caughtUp');
    expect(mode(library([['d1', 'German', [lifeOf('known')]]]))).toBe('caughtUp');
  });

  it('a paused deck does not keep Today busy (its cards leave Today)', () => {
    const s = library([
      ['d1', 'German', [lifeOf('review')]],
      ['d2', 'Spanish', [dueReview()], false],
    ]);
    expect(readyAll(s).total).toBe(0);
    expect(mode(s)).toBe('caughtUp');
  });

  it('caught-up buttons: only counts above 0, exact copy', () => {
    expect(caughtUpActions({ ahead: 12, practice: 1240, notStarted: 8 }).map((a) => a.label)).toEqual([
      'Study ahead · 12',
      'Practice · 1,240',
      'Choose what to learn · 8 not started',
    ]);
    expect(caughtUpActions({ ahead: 0, practice: 3, notStarted: 0 }).map((a) => a.key)).toEqual(['practice']);
    expect(caughtUpActions({ ahead: 0, practice: 0, notStarted: 0 })).toEqual([]);
    expect(TODAY_COPY.caughtUpTitle).toBe('You’re all caught up.');
    expect(TODAY_COPY.caughtUpSub).toBe('Come back tomorrow, or keep going:');
  });

  it('"Choose what to learn" counts only Not started cards Today could bring in (not paused, not suspended)', () => {
    const s = library([
      ['d1', 'German', [notStarted(), notStarted(), { newState: 'notStarted', suspended: true }, newCard()]],
      ['d2', 'Paused', [notStarted()], false],
    ]);
    expect(scopePool(s, NOT_STARTED_SCOPE, matchCtxOf(s, NOW), 'browse')).toHaveLength(2);
    // The route carries the same query, so triage shows the same cards.
    expect(parseQueryParam(triageRoute(NOT_STARTED_SCOPE).params.q)).toEqual(NOT_STARTED_SCOPE);
  });
  // Final review 2026-11: Today counted Not started CARDS (also of a turned-off direction),
  // triage counts ITEMS of the directions that are on, so the button could open an empty triage.
  describe('"Choose what to learn" counts what triage shows: items, directions that are on', () => {
    const REVERSE = BUILTIN_TYPE_IDS.basicReverse;
    /** `n` Basic + reverse items in deck d1; `cardOf(ord)` = the values of each direction's card. */
    function reverseDeck(n: number, cardOf: (ord: number) => Partial<Card>, directions?: number[], extra: Partial<Card>[] = []) {
      const deck = makeDeckV3({ id: 'd1', name: 'Capitals', order: 0, options: directions ? { directions: { [REVERSE]: directions } } : {} });
      const groups = [
        ...times(n, () => noteWithCards({ deckId: 'd1', typeId: REVERSE, card: cardOf })),
        ...extra.map((v) => card('d1', v)),
      ];
      return stateOfV3({
        decks: [deck],
        groups,
        overrides: { settings: makeSettingsV3({ sessionLimit: 0, srs: { dailyNewLimit: 10 } }) },
      });
    }
    /** What the triage screen builds for Today's button (triage.tsx). */
    const triageCount = (s: DataStateV3) => {
      const ctx = matchCtxOf(s, NOW);
      return triageItems(scopePool(s, NOT_STARTED_SCOPE, ctx, 'browse'), triageLookupOf(s, ctx)).length;
    };

    it('two Not started directions of one item are ONE item ("· 6 not started", never "· 12")', () => {
      // 6 items, both directions Not started, and one review that is not due: caught up.
      const s = reverseDeck(6, () => lifeValues('notStarted', NOW), undefined, [lifeOf('review')]);
      const ctx = matchCtxOf(s, NOW);
      expect(scopePool(s, NOT_STARTED_SCOPE, ctx, 'browse')).toHaveLength(12); // the cards
      expect(notStartedItemCount(s, NOW)).toBe(6);
      expect(notStartedItemCount(s, NOW)).toBe(triageCount(s));
      // The Complete screen's "Choose what to learn · {n}" for the same scope says the same.
      expect(keepGoingCounts(s, NOT_STARTED_SCOPE, [], ctx).notStarted).toBe(6);
      expect(mode(s)).toBe('caughtUp');
      expect(caughtUpActions({ ahead: 0, practice: 0, notStarted: notStartedItemCount(s, NOW) }).map((a) => a.label)).toEqual([
        'Choose what to learn · 6 not started',
      ]);
    });

    it('a turned-off direction: its Not started cards do not count (no dead end to "Nothing left to choose here.")', () => {
      // Reverse off; the forward cards are Known; the reverse cards are still Not started.
      const known = reverseDeck(3, (ord) => lifeValues(ord === 0 ? 'known' : 'notStarted', NOW), [0]);
      expect(scopePool(known, NOT_STARTED_SCOPE, matchCtxOf(known, NOW), 'browse')).toHaveLength(3);
      expect(triageCount(known)).toBe(0);
      expect(notStartedItemCount(known, NOW)).toBe(0);
      // Before: 'notStartedOnly' ("Nothing is in your queue yet.") with a button to an empty triage.
      expect(mode(known)).toBe('caughtUp');

      // The forward cards are reviews that are not due: caught up, and NO "Choose what to learn" button.
      const review = reverseDeck(3, (ord) => (ord === 0 ? lifeOf('review') : lifeValues('notStarted', NOW)), [0]);
      expect(mode(review)).toBe('caughtUp');
      expect(notStartedItemCount(review, NOW)).toBe(0);
      expect(caughtUpActions({ ahead: 3, practice: 3, notStarted: notStartedItemCount(review, NOW) }).map((a) => a.key)).toEqual([
        'ahead',
        'practice',
      ]);

      // One forward card still Not started: that item IS there, and the button opens it.
      const one = reverseDeck(1, (ord) => lifeValues('notStarted', NOW), [0], [lifeOf('known')]);
      expect(notStartedItemCount(one, NOW)).toBe(1);
      expect(triageCount(one)).toBe(1);
      expect(mode(one)).toBe('notStartedOnly');
    });

    it('the reader keeps its number while the inputs are the same, and counts again after a change', () => {
      const s = reverseDeck(2, () => lifeValues('notStarted', NOW));
      const read = notStartedItemsReader(NOW);
      expect(read(s)).toBe(2);
      const off = reducer.setDeckOptions(s, { deckId: 'd1', patch: { directions: { [REVERSE]: [0] } } }).state;
      expect(read(off)).toBe(2); // the forward cards are still Not started: 2 items
      const learned = reducer.learn(off, { cardIds: off.cards.filter((c) => c.ord === 0).map((c) => c.id) }, testCtx(NOW)).state;
      expect(read(learned)).toBe(0); // only turned-off cards are Not started now
    });
  });

  it('"Practice · {n}" on Today leaves out the paused decks (their cards leave Today)', () => {
    const s = library([
      ['d1', 'German', [lifeOf('review')]],
      ['d2', 'Paused', [lifeOf('review'), lifeOf('review')], false],
    ]);
    const ctx = matchCtxOf(s, NOW);
    expect(buildSessionQueue({ kind: 'practice', q: PRACTICE_SCOPE }, s, ctx)).toHaveLength(1);
    expect(buildSessionQueue({ kind: 'practice', q: ALL_SCOPE }, s, ctx)).toHaveLength(3);
    // "Study ahead" reads the study pool, which leaves paused decks out by itself.
    expect(buildSessionQueue({ kind: 'ahead', q: ALL_SCOPE }, s, ctx)).toHaveLength(1);
  });
});

describe('deck rows', () => {
  it('"{d} due · {n} new" and the pill = the deck’s own session (launch count === queue length)', () => {
    const s = library([['d1', 'German', [...times(22, dueReview), ...times(15, newCard)]]]);
    const stats = deckStatsMap(s, matchCtxOf(s, NOW));
    const model = deckRowModel(stats.get('d1'), false);
    expect(model.line).toBe('22 due · 10 new');
    expect(model.pill).toBe(32);
    expect(buildSessionQueue({ kind: 'scheduled', q: deckScope('d1') }, s, matchCtxOf(s, NOW))).toHaveLength(32);
  });

  it('a deck with only new cards: "{n} new"; nothing to study: "All caught up ✓", no pill', () => {
    const s = library([
      ['d1', 'Spanish verbs', times(12, newCard)],
      ['d2', 'Algo', [lifeOf('review')]],
      ['d3', 'Empty', []],
      ['d4', 'Waiting', times(2, notStarted)],
    ], {}, { srs: { dailyNewLimit: 20 } });
    const stats = deckStatsMap(s, matchCtxOf(s, NOW));
    expect(deckRowModel(stats.get('d1'), false)).toEqual({ line: '12 new', pill: 12 });
    expect(deckRowModel(stats.get('d2'), false)).toEqual({ line: 'All caught up ✓', pill: null });
    expect(deckRowModel(stats.get('d3'), false)).toEqual({ line: 'No cards yet', pill: null });
    expect(deckRowModel(stats.get('d4'), false)).toEqual({ line: '2 not started', pill: null });
    expect(deckRowModel(undefined, false)).toEqual({ line: 'No cards yet', pill: null });
  });

  it('paused decks collapse into "Paused ({n})" and their rows have no pill', () => {
    const s = library([
      ['d1', 'German', [dueReview()]],
      ['d2', 'Spanish', [dueReview()], false],
      ['d3', 'French', [newCard()], false],
    ]);
    const { active, paused } = splitDecks(s.decks);
    expect(active.map((d) => d.id)).toEqual(['d1']);
    expect(paused.map((d) => d.id)).toEqual(['d2', 'd3']);
    expect(pausedLabel(paused.length)).toBe('Paused (2)');
    const stats = deckStatsMap(s, matchCtxOf(s, NOW));
    expect(deckRowModel(stats.get('d2'), true)).toEqual({ line: 'Paused · 1 card', pill: null });
    // The hero does not count the paused decks' cards.
    expect(readyAll(s).total).toBe(1);
  });

  it('decks keep their list order (deck.order)', () => {
    const decks = [makeDeckV3({ id: 'b', name: 'B', order: 2 }), makeDeckV3({ id: 'a', name: 'A', order: 1 })];
    expect(splitDecks(decks).active.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('the shared daily new limit: the pills add up to more than the total → the note says why', () => {
    // Two decks with 10 new cards each, a daily new limit of 10 shared by both.
    const s = library([
      ['d1', 'German', times(10, newCard)],
      ['d2', 'Spanish', times(10, newCard)],
    ]);
    const stats = deckStatsMap(s, matchCtxOf(s, NOW));
    const pills = ['d1', 'd2'].map((id) => deckRowModel(stats.get(id), false).pill);
    expect(pills).toEqual([10, 10]);
    const hero = readyAll(s);
    const total = hero.total;
    expect(total).toBe(10);
    // Each pill is still honest: the session it opens has that many cards.
    for (const id of ['d1', 'd2']) {
      expect(buildSessionQueue({ kind: 'scheduled', q: deckScope(id) }, s, matchCtxOf(s, NOW))).toHaveLength(10);
    }
    expect(deckRowModel(stats.get('d1'), false).line).toBe('10 new');
    const note = sharedLimitNote(['d1', 'd2'].map((id) => stats.get(id)!.ready), hero);
    expect(note).toMatch(/session of that deck only/);
    expect(note).toBe(`${SHARED_LIMIT_COPY.separate} ${SHARED_LIMIT_COPY.newLimit}`);
    // No note when the pills do not add up to more than the total, or with one pill.
    expect(sharedLimitNote([pill(5), pill(5)], heroOf(10))).toBeNull();
    expect(sharedLimitNote([pill(12)], heroOf(10))).toBeNull();
    expect(sharedLimitNote([pill(12), pill(0)], heroOf(10))).toBeNull(); // a deck with 0 has no pill
  });

  // W4-1 review round 1: the note blamed new cards also when no new card was involved.
  it('the session size cuts the total → the note names the session size, not the new-card limit', () => {
    // German 40 due reviews, Spanish 40 due reviews, no new cards, session size 50.
    const s = library(
      [
        ['d1', 'German', times(40, dueReview)],
        ['d2', 'Spanish', times(40, dueReview)],
      ],
      {},
      { sessionLimit: 50 },
    );
    const hero = readyAll(s);
    expect(heroLine(hero)).toBe('80 ready · Study 50');
    const stats = deckStatsMap(s, matchCtxOf(s, NOW));
    const readies = ['d1', 'd2'].map((id) => stats.get(id)!.ready);
    expect(readies.map((r) => r.total)).toEqual([40, 40]);
    const note = sharedLimitNote(readies, hero);
    expect(note).toBe('Each Study button is a session of that deck only. Your session size is 50 cards.');
    expect(note).not.toContain('New cards');
  });

  it('a shared daily REVIEW limit → the note names the review limit', () => {
    // Two decks with 8 due reviews each, a daily review limit of 10 for both.
    const s = library(
      [
        ['d1', 'German', times(8, dueReview)],
        ['d2', 'Spanish', times(8, dueReview)],
      ],
      {},
      { srs: { dailyReviewLimit: 10 } },
    );
    const hero = readyAll(s);
    expect(hero).toMatchObject({ total: 10, capped: false });
    const stats = deckStatsMap(s, matchCtxOf(s, NOW));
    const note = sharedLimitNote(['d1', 'd2'].map((id) => stats.get(id)!.ready), hero);
    expect(note).toBe(`${SHARED_LIMIT_COPY.separate} ${SHARED_LIMIT_COPY.reviewLimit}`);
  });

  it('both daily limits, and a limit together with the session size', () => {
    // 8 due + 7 new in each deck; 10 reviews and 10 new cards a day for both decks.
    const both = library(
      [
        ['d1', 'German', [...times(8, dueReview), ...times(7, newCard)]],
        ['d2', 'Spanish', [...times(8, dueReview), ...times(7, newCard)]],
      ],
      {},
      { srs: { dailyReviewLimit: 10, dailyNewLimit: 10 } },
    );
    const stats = deckStatsMap(both, matchCtxOf(both, NOW));
    expect(sharedLimitNote(['d1', 'd2'].map((id) => stats.get(id)!.ready), readyAll(both))).toBe(
      `${SHARED_LIMIT_COPY.separate} ${SHARED_LIMIT_COPY.bothLimits}`,
    );
    const noteWith = (sessionLimit: number) => {
      const s = { ...both, settings: { ...both.settings, sessionLimit } };
      const st = deckStatsMap(s, matchCtxOf(s, NOW));
      return { hero: readyAll(s), note: sharedLimitNote(['d1', 'd2'].map((id) => st.get(id)!.ready), readyAll(s)) };
    };
    // Session size 15: the hero (10 reviews + 10 new) is cut to 10 reviews + 5 new.
    // The cut takes only new cards, so the numbers still prove both limits.
    const at15 = noteWith(15);
    expect(heroLine(at15.hero)).toBe('20 ready · Study 15');
    expect(at15.note).toBe(
      `${SHARED_LIMIT_COPY.separate} ${SHARED_LIMIT_COPY.bothLimits} ${SHARED_LIMIT_COPY.sessionSize(15)}`,
    );
    // Session size 8: the cut reaches the reviews. The numbers no longer prove
    // a daily limit, so the note says only what is sure.
    const at8 = noteWith(8);
    expect(heroLine(at8.hero)).toBe('20 ready · Study 8');
    expect(at8.note).toBe(`${SHARED_LIMIT_COPY.separate} ${SHARED_LIMIT_COPY.sessionSize(8)}`);
    expect(SHARED_LIMIT_COPY.sessionSize(1)).toBe('Your session size is 1 card.');
  });
});

describe('lists', () => {
  const favorites = 'builtin:favorites';
  const hard = 'builtin:hard';

  function userList(id: string, name: string, query: ListDef['query'], createdAt = NOW): ListDef {
    return { id, name, icon: '⭐', query, createdAt, updatedAt: createdAt };
  }

  it('a user list without a pref is shown; a built-in list without one waits behind "Show all lists"', () => {
    expect(listPrefOf({ id: 'list-1' }, {})).toEqual({ pinned: true, hidden: false, order: Number.POSITIVE_INFINITY });
    expect(listPrefOf({ id: favorites }, {})).toEqual({ pinned: false, hidden: false, order: Number.POSITIVE_INFINITY });
    expect(allLists([userList('list-1', 'B1 verbs', {})]).map((l) => l.id)).toEqual([...BUILTIN_LISTS.map((l) => l.id), 'list-1']);
  });

  it('hidden zero lists: a pinned built-in list with 0 cards goes behind "Show all lists"', () => {
    const lists = allLists([userList('list-1', 'Empty list', { tags: ['nothing'] })]);
    const prefs = { [favorites]: { pinned: true, hidden: false, order: 0 }, [hard]: { pinned: true, hidden: false, order: 1 } };
    const counts = new Map([[favorites, 3], [hard, 0], ['list-1', 0]]);
    const { shown, more } = splitLists(lists, prefs, counts);
    expect(shown.map((l) => l.id)).toEqual([favorites, 'list-1']); // a user list shows even with 0 cards
    expect(more.map((l) => l.id)).toContain(hard);
    expect(more.map((l) => l.id)).toContain('builtin:leeches'); // not pinned
  });

  it('a hidden list is behind "Show all lists"; order follows the stored order', () => {
    const lists = allLists([userList('list-1', 'B1 verbs', {}), userList('list-2', 'Verbs', {}, NOW + 1)]);
    const prefs = {
      [favorites]: { pinned: true, hidden: false, order: 5 },
      'list-2': { pinned: true, hidden: false, order: 1 },
      'list-1': { pinned: true, hidden: true, order: 0 },
    };
    const counts = new Map([[favorites, 2], ['list-1', 4], ['list-2', 4]]);
    const { shown, more } = splitLists(lists, prefs, counts);
    expect(shown.map((l) => l.id)).toEqual(['list-2', favorites]);
    expect(more[0].id).toBe('list-1');
  });

  it('the list row numbers: cards, due cards, and the pill = the session it opens', () => {
    const s = library([
      ['d1', 'German', [{ ...dueReview(), fav: true }, { fav: true }, { ...lifeOf('review'), fav: true }, dueReview()]],
    ]);
    const stats = listRowStats(s, favorites, NOW);
    expect(stats).toEqual({ count: 3, due: 1, ready: 2 });
    expect(buildSessionQueue({ kind: 'scheduled', q: listScope(favorites) }, s, matchCtxOf(s, NOW))).toHaveLength(stats.ready);
    expect(listRowLine(stats)).toBe('3 cards · 1 due');
    expect(listRowLine({ count: 1, due: 0 })).toBe('1 card');
  });

  // Final review 2026-11: the row counted `due` card by card (isDueNow), so both directions of
  // an item and a review whose sibling was studied today were "due" — a row said "2 cards ·
  // 1 due" with no Study pill. It counts like a deck row now: the scheduler's own due buckets.
  it('"{n} due" of a list row never counts a card Study cannot show (one card per item, spaced siblings)', () => {
    const REVERSE = BUILTIN_TYPE_IDS.basicReverse;
    const make = (cardOf: (ord: number) => Partial<Card>) => {
      const deck = makeDeckV3({ id: 'd1', name: 'Capitals', order: 0 });
      const group = noteWithCards({ deckId: 'd1', typeId: REVERSE, card: cardOf });
      return stateOfV3({
        decks: [deck],
        groups: [group],
        overrides: {
          settings: makeSettingsV3({ sessionLimit: 0, spaceSiblings: true, srs: { dailyNewLimit: 10 } }),
          listPrefs: { [favorites]: { pinned: true, hidden: false, order: 0 } },
        },
      });
    };
    const deckDue = (s: DataStateV3) => deckStatsMap(s, matchCtxOf(s, NOW)).get('d1')!.dueNow;

    // Direction 0 was reviewed an hour ago (not due); direction 1 is overdue, but its sibling
    // was studied today: Study shows nothing, and the row says so.
    const spaced = make((ord) =>
      ord === 0
        ? lifeOf('review', { fav: true, due: NOW + 3 * DAY, lastReviewedAt: NOW - HOUR })
        : lifeOf('review', { fav: true, due: NOW - DAY }),
    );
    const one = listRowStats(spaced, favorites, NOW);
    expect(one).toEqual({ count: 2, due: 0, ready: 0 });
    expect(one.due).toBe(deckDue(spaced));
    expect(listRowLine(one)).toBe('2 cards');

    // Both directions overdue: one card per item, so "1 due" next to "Study 1" (it said "2 due").
    const both = make(() => lifeOf('review', { fav: true, due: NOW - DAY }));
    const stats = listRowStats(both, favorites, NOW);
    expect(stats).toEqual({ count: 2, due: 1, ready: 1 });
    expect(stats.due).toBe(deckDue(both));
    expect(buildSessionQueue({ kind: 'scheduled', q: listScope(favorites) }, both, matchCtxOf(both, NOW))).toHaveLength(stats.ready);
  });

  it('todayLists: the seed pins Hard / Favorites / Recent; zero ones are hidden; only drawn rows get full numbers', () => {
    // A due MASTERED favorite: not "hard" (ease 2.65), not "recent" (interval 34 days).
    const s = library([['d1', 'German', [lifeOf('mastered', { due: NOW - HOUR, fav: true }), newCard()]]], {
      listPrefs: {
        [hard]: { pinned: true, hidden: false, order: 0 },
        [favorites]: { pinned: true, hidden: false, order: 1 },
        'builtin:recent': { pinned: true, hidden: false, order: 2 },
      },
    });
    const closed = todayLists(s, NOW, false);
    expect(closed.shown.map((r) => r.list.id)).toEqual([favorites]);
    expect(closed.shown[0].stats).toEqual({ count: 1, due: 1, ready: 1 });
    expect(closed.more.every((r) => r.stats === null)).toBe(true);
    expect(closed.more.map((r) => r.list.id)).toContain(hard);
    const open = todayLists(s, NOW, true);
    expect(open.more.every((r) => r.stats !== null)).toBe(true);
  });

  // W4-1 review round 2: "No lists yet…" showed while the learner's own list was only hidden.
  it('"No lists yet…" only when the learner has made no list; hidden lists leave only "Show all lists"', () => {
    // The learner saved "B1 verbs" and tapped Hide; every built-in list has 0 cards.
    const hidden = library([['d1', 'German', [newCard()]]], {
      lists: [userList('list-1', 'B1 verbs', { tags: ['verb'] })],
      listPrefs: { 'list-1': { pinned: false, hidden: true, order: 0 } },
    });
    const closed = todayLists(hidden, NOW, false);
    expect(closed.shown).toEqual([]);
    expect(closed.more.map((r) => r.list.id)).toContain('list-1');
    expect(showNoListsLine(closed, false)).toBe(false);
    // No list made and no built-in list with cards: the line is true.
    const none = todayLists(library([['d1', 'German', [newCard()]]]), NOW, false);
    expect(none.shown).toEqual([]);
    expect(showNoListsLine(none, false)).toBe(true);
    // "Show all lists" open: rows are drawn, so no line.
    expect(showNoListsLine(todayLists(library([['d1', 'German', [newCard()]]]), NOW, true), true)).toBe(false);
    expect(TODAY_COPY.noLists).toBe('No lists yet. Filter the Library, then tap Save as list.');
  });

  it('todayListsReader keeps the same object while its inputs are the same', () => {
    const s = library([['d1', 'German', [{ ...dueReview(), fav: true }]]], {
      listPrefs: { [favorites]: { pinned: true, hidden: false, order: 0 } },
    });
    const read = todayListsReader(NOW, false);
    const a = read(s);
    const sameInputs: DataStateV3 = { ...s, sessions: [] };
    expect(read(sameInputs)).toBe(a);
    const after = reducer.setListPref(s, { id: favorites, pref: { hidden: true } }).state;
    expect(read(after).shown).toEqual([]);
  });

  it('list actions: a user list has Rename · Edit filters · Hide · Delete list; a built-in list cannot be renamed or deleted', () => {
    const shownPref = { pinned: true, hidden: false, order: 0 };
    expect(listActionKeys({ id: 'list-1' }, shownPref)).toEqual(['rename', 'edit', 'hide', 'delete']);
    expect(listActionKeys({ id: favorites }, shownPref)).toEqual(['open', 'hide']);
    // A hidden (or not pinned) list offers the way back.
    expect(listActionKeys({ id: 'list-1' }, { ...shownPref, hidden: true })).toEqual(['rename', 'edit', 'show', 'delete']);
    expect(listActionKeys({ id: favorites }, { ...shownPref, pinned: false })).toEqual(['open', 'show']);
    expect(['rename', 'edit', 'hide', 'delete'].map((k) => LIST_ACTION_LABEL[k as keyof typeof LIST_ACTION_LABEL])).toEqual([
      'Rename',
      'Edit filters',
      'Hide',
      'Delete list',
    ]);
  });
});

describe('one-time cards', () => {
  const base = { repairs: 0, repairsDismissed: false, sessions: 0, reminderEnabled: false, reminderOfferSeen: false };

  it('the repairs card shows while repairs were made and it was not closed — before the reminder offer', () => {
    expect(pickOneTimeCard({ ...base, repairs: 3, sessions: 1 })).toBe('repairs');
    expect(pickOneTimeCard({ ...base, repairs: 3, repairsDismissed: true, sessions: 1 })).toBe('reminder');
    expect(repairsLine(1)).toBe('We fixed 1 item in your library.');
    expect(repairsLine(3)).toBe('We fixed 3 items in your library.');
  });

  it('the reminder offer: only after the first completed session, only while reminders are off, only once', () => {
    expect(pickOneTimeCard(base)).toBeNull(); // no session yet
    expect(pickOneTimeCard({ ...base, sessions: 1 })).toBe('reminder');
    expect(pickOneTimeCard({ ...base, sessions: 1, reminderEnabled: true })).toBeNull();
    expect(pickOneTimeCard({ ...base, sessions: 1, reminderOfferSeen: true })).toBeNull();
  });

  it('the offer button names the reminder time; it goes to Settings › Reminders with enable=1', () => {
    expect(reminderOfferButton('20:00')).toBe('Remind me at 8:00 PM');
    expect(clockLabel('07:05')).toBe('7:05 AM');
    expect(clockLabel('00:30')).toBe('12:30 AM');
    expect(clockLabel('12:00')).toBe('12:00 PM');
    expect(clockLabel('nonsense')).toBe('8:00 PM');
    expect(clockLabel(undefined)).toBe('8:00 PM');
    expect(REMINDER_OFFER_HREF).toBe('/(tabs)/settings/reminders?enable=1');
  });
});

describe('streak sheet', () => {
  const today = dayKeyOf(NOW);

  it('counts the freezes really used in the last 14 days (today included), each day once', () => {
    const days = [addDays(today, -1), addDays(today, -13), addDays(today, -14), addDays(today, -1), addDays(today, -40)];
    expect(freezesUsedRecently(days, NOW)).toBe(2);
    expect(freezesUsedRecently([], NOW)).toBe(0);
    expect(freezesUsedLine(1)).toBe('1 freeze used in the last 14 days.');
    expect(freezesUsedLine(2)).toBe('2 freezes used in the last 14 days.');
  });

  it('the strip: 14 days, today last; a freeze beats a session on the same day', () => {
    const sessions = [{ dayKey: addDays(today, -1) }, { dayKey: addDays(today, -2) }];
    const strip = streakStrip(sessions, [addDays(today, -2), addDays(today, -3)], NOW);
    expect(strip).toHaveLength(14);
    expect(strip[13]).toBe('today');
    expect(strip.slice(10, 13)).toEqual(['frozen', 'frozen', 'studied']);
    expect(strip[0]).toBe('missed');
    expect(streakUnit(1)).toBe('day in a row');
    expect(streakUnit(12)).toBe('days in a row');
  });
});

describe('AddSheet rows and starter decks', () => {
  it('rows in spec order; "New card" goes into the last used deck and is hidden without decks', () => {
    expect(addSheetRows('Spanish verbs').map((r) => [r.title, r.sub])).toEqual([
      ['New card', 'Into Spanish verbs'],
      ['New deck', 'Start empty and type your own cards'],
      ['Import a file', 'Anki .apkg or .csv'],
      ['Find on AnkiWeb', 'Search shared decks'],
      ['New list', 'Save a filter, like ‘B1 verbs’'],
    ]);
    expect(addSheetRows(null).map((r) => r.key)).toEqual(['deck', 'import', 'ankiweb', 'list']);
  });

  const starter: StarterDeck = { key: 'vocabulary', title: 'German vocabulary', subtitle: '6,845 words', asset: 1, version: 1 };
  const result = (cardsAdded: number) => ({ cardsAdded }) as NonNullable<Parameters<typeof starterMessage>[0]['result']>;

  it('the snackbar after "Add" says what happened (idempotent: a second add is "Already up to date.")', () => {
    expect(starterMessage({ kind: 'add', starter, result: result(1), images: 'none', elsewhereDecks: [] })).toEqual({
      text: 'Added German vocabulary · 1 card.',
    });
    expect(starterMessage({ kind: 'add', starter, result: result(6845), images: 'written', elsewhereDecks: [] }).text).toBe(
      'Added German vocabulary · 6,845 cards.',
    );
    expect(starterMessage({ kind: 'update', starter, result: result(0), images: 'none', elsewhereDecks: [] }).text).toBe(
      'Updated German vocabulary. Your progress is kept.',
    );
    // A newer file that dropped items: they are kept, but suspended (starterDecks.ts "retired").
    const retired = (notesRetired: number) =>
      ({ cardsAdded: 0, notesRetired }) as NonNullable<Parameters<typeof starterMessage>[0]['result']>;
    expect(starterMessage({ kind: 'update', starter, result: retired(245), images: 'none', elsewhereDecks: [] }).text).toBe(
      'Updated German vocabulary. Your progress is kept. 245 old items are not in the new version, so they are suspended.',
    );
    expect(starterMessage({ kind: 'update', starter, result: retired(1), images: 'none', elsewhereDecks: [] }).text).toBe(
      'Updated German vocabulary. Your progress is kept. 1 old item is not in the new version, so it is suspended.',
    );
    // How many items (notes) changed and how many are new; a 0 is left out.
    const counts = (notesUpdated: number, notesAdded: number) =>
      ({ cardsAdded: notesAdded * 2, notesUpdated, notesAdded }) as NonNullable<Parameters<typeof starterMessage>[0]['result']>;
    expect(starterMessage({ kind: 'update', starter, result: counts(4000, 500), images: 'none', elsewhereDecks: [] }).text).toBe(
      'Updated German vocabulary: 4,000 items changed, 500 new. Your progress is kept.',
    );
    expect(starterMessage({ kind: 'update', starter, result: counts(1, 0), images: 'none', elsewhereDecks: [] }).text).toBe(
      'Updated German vocabulary: 1 item changed. Your progress is kept.',
    );
    expect(starterMessage({ kind: 'update', starter, result: counts(0, 1), images: 'none', elsewhereDecks: [] }).text).toBe(
      'Updated German vocabulary: 1 new item. Your progress is kept.',
    );
    expect(starterMessage({ kind: 'upToDate', starter, result: null, images: 'none', elsewhereDecks: [] })).toEqual({
      text: 'Already up to date.',
    });
  });

  it('"elsewhere" offers "Add as a new deck"; images that were not saved offer "Try again"', () => {
    expect(
      starterMessage({
        kind: 'elsewhere',
        starter,
        result: null,
        images: 'none',
        elsewhereDecks: [{ deckId: 'u', deckName: 'Unfiled cards', notes: 12 }],
      }),
    ).toEqual({ text: 'These cards are already in Unfiled cards.', retry: { kind: 'copy', label: 'Add as a new deck' } });
    expect(starterMessage({ kind: 'add', starter, result: result(2), images: 'failed', elsewhereDecks: [] })).toEqual({
      text: 'Added German vocabulary · 2 cards. Some images were not saved.',
      retry: { kind: 'images', label: 'Try again' },
    });
    expect(starterMessage({ kind: 'upToDate', starter, result: null, images: 'skipped', elsewhereDecks: [] }).retry?.kind).toBe(
      'images',
    );
  });
});

describe('the pack button on the no-decks card (final review 2026-11)', () => {
  const starter = (subtitle: string) => ({ key: 'vocabulary', title: 'Vocabulary', subtitle }) as unknown as StarterDeck;

  it('says what it does — "Starter decks" (it opens the AddSheet), never the tour\'s "Start with German"', () => {
    const german = {
      id: 'german',
      cardTypePresets: [],
      starterDecks: [starter('7,517 words, A1 to C2')],
      onboarding: { firstChoice: { title: 'Start with German', sub: '9,105 words and grammar, A1 to C2' } },
    } as unknown as ContentPack;
    expect(packChoiceFor(german)).toEqual({ title: TODAY_COPY.starterDecks, sub: '9,105 words and grammar, A1 to C2' });
    // No tour choice: the first deck's line.
    expect(packChoiceFor({ ...german, onboarding: undefined })).toEqual({ title: 'Starter decks', sub: '7,517 words, A1 to C2' });
    // No starter decks (the generic build): no button.
    expect(packChoiceFor({ ...german, starterDecks: [] })).toBeNull();
  });
});

describe('routes', () => {
  it('a session route carries the scope as `q` (never card ids)', () => {
    const r = sessionRoute('scheduled', deckScope('d1'), 'German');
    expect(r.pathname).toBe('/session');
    expect(r.params.kind).toBe('scheduled');
    expect(parseQueryParam(r.params.q)).toEqual({ decks: ['d1'] });
    expect(r.params.label).toBe('German');
    expect(sessionRoute('scheduled', ALL_SCOPE, 'All decks').params.q).toBe('{}');
  });

  it('Library gets the query and a nonce (spec §4.6); "New list" adds its banner param', () => {
    const r = libraryRoute(listScope('builtin:hard'), '123');
    expect(r).toEqual({ pathname: '/(tabs)/library', params: { q: serializeQuery({ list: 'builtin:hard' }), nonce: '123' } });
    expect(libraryRoute({}, '9', NEW_LIST_PARAM).params).toEqual({ q: '{}', nonce: '9', newList: '1' });
  });

  it('the "New list" contract: Library shows "Add filters, then tap Save as list." for newList=1 only (spec §8.10)', () => {
    expect(NEW_LIST_BANNER).toBe('Add filters, then tap Save as list.');
    expect(newListBannerFor(libraryRoute({}, '9', NEW_LIST_PARAM).params.newList)).toBe(NEW_LIST_BANNER);
    // A list row, "Edit filters", a plain Library: no banner.
    expect(newListBannerFor(libraryRoute(listScope('builtin:hard'), '10').params.newList)).toBeNull();
    expect(newListBannerFor(undefined)).toBeNull();
    expect(newListBannerFor('0')).toBeNull();
    // expo-router can give a param as a list of strings: the first value counts.
    expect(newListBannerFor(['1'])).toBe(NEW_LIST_BANNER);
    expect(newListBannerFor([])).toBeNull();
  });

  it('the deck page and triage routes', () => {
    expect(deckRoute('d-1')).toBe('/deck/d-1');
    expect(deckRoute('a/b')).toBe('/deck/a%2Fb');
    expect(triageRoute({ life: ['notStarted'] })).toEqual({ pathname: '/triage', params: { q: '{"life":["notStarted"]}' } });
  });
});

/* ================================================================ Part 2 — the screens' wiring */

/*
 * Module mocks. Names start with `mock` so jest lets the factories use them.
 * `mockState` is the one in-memory state; every action runs the REAL reducer.
 */
/** The clock of every screen in Part 2 (useNow). */
const mockNow = FIXED_NOW;
let mockState: DataStateV3 = library([]);
let mockRepaired: string[] = [];

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
const mockPush = jest.fn<(href: unknown) => void>();
const mockNavigate = jest.fn<(href: unknown) => void>();
/** What expo-router's useIsFocused() answers: Today is the screen in front (wave 5i: the pulse runs only then). */
let mockFocused = true;

/** Listeners of the fake store: a test re-renders the screen after an action. */
const mockStoreListeners = new Set<() => void>();

function mockRun<I, R>(
  command: (s: DataStateV3, input: I, ctx: reducer.ReducerCtx) => { state: DataStateV3; result: R },
  input: I,
): R {
  const step = command(mockState, input, testCtx(NOW));
  mockState = step.state;
  for (const l of mockStoreListeners) l();
  return step.result;
}

const mockActions = {
  setListPref: jest.fn((id: string, pref: Parameters<typeof reducer.setListPref>[1]['pref']) =>
    mockRun(reducer.setListPref, { id, pref }),
  ),
  saveList: jest.fn((input: Parameters<typeof reducer.saveList>[1]['input']) => mockRun(reducer.saveList, { input })),
  deleteList: jest.fn((id: string) => mockRun(reducer.deleteList, { id })),
  updateAppSettings: jest.fn((patch: Partial<DataStateV3['settings']>) => {
    mockState = { ...mockState, settings: { ...mockState.settings, ...patch } };
    for (const l of mockStoreListeners) l();
  }),
  applyImport: jest.fn(),
  flush: jest.fn(() => Promise.resolve({ ok: true as const })),
};

/** The one fake engine (the same object on every call, like the real useEngine()). */
const mockEngine = {
  actions: mockActions,
  store: { getState: () => mockState },
  status: 'ready',
  boot: () => Promise.resolve({ kind: 'loaded', state: mockState, repaired: mockRepaired }),
};

jest.mock('../../store/selectors', () => {
  const actual = jest.requireActual<typeof import('../../store/selectors')>('../../store/selectors');
  const scope = jest.requireActual<typeof import('../../domain/scope')>('../../domain/scope');
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  /** Read the fake store like useSyncExternalStore: a new state renders again. */
  const useState = () =>
    ReactActual.useSyncExternalStore(
      (l: () => void) => {
        mockStoreListeners.add(l);
        return () => mockStoreListeners.delete(l);
      },
      () => mockState,
    );
  return {
    ...actual,
    useStateV3: <T,>(selector: (state: DataStateV3) => T): T => selector(useState()),
    useReady: (q: import('../../domain/model').Query) => {
      const s = useState();
      return scope.readyFor(s, q, scope.matchCtxOf(s, mockNow));
    },
    useDeckStatsMap: () => {
      const s = useState();
      return scope.deckStatsMap(s, scope.matchCtxOf(s, mockNow));
    },
    useScopePool: (q: import('../../domain/model').Query, purpose: 'browse' | 'study' = 'browse') => {
      const s = useState();
      return scope.scopePool(s, q, scope.matchCtxOf(s, mockNow), purpose);
    },
    useSessionLength: (params: import('../../domain/scope').SessionParams) => {
      const s = useState();
      return scope.buildSessionQueue(params, s, scope.matchCtxOf(s, mockNow)).length;
    },
    useEngine: () => mockEngine,
    useEngineMeta: () => ({ ready: true, persistError: null, lastCompletion: null }),
  };
});

jest.mock('../../store/DataContext', () => ({
  useData: () => ({ actions: mockActions }),
  normalizedDayDone: jest.requireActual<typeof import('../../store/reducer')>('../../store/reducer').normalizedDayDone,
}));
jest.mock('../../store/useNow', () => ({ useNow: () => mockNow }));
jest.mock('../../store/SnackbarContext', () => ({
  useSnackbar: () => {
    const snack = jest
      .requireActual<typeof import('react')>('react')
      .useSyncExternalStore(mockSnackChannel.subscribe, mockSnackChannel.get);
    return { show: mockShow, snack, dismiss: () => mockSnackChannel.set(null) };
  },
}));
jest.mock('../../store/storage', () => ({ appRevlogStore: () => ({ forCard: () => new Promise(() => undefined) }) }));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, navigate: mockNavigate }),
  useIsFocused: () => mockFocused,
}));
jest.mock('expo-image', () => ({ Image: () => null }));
jest.mock('@expo/ui/community/datetime-picker', () => ({
  DateTimePicker: function DateTimePicker() {
    return null;
  },
}));
jest.mock('../../domain/speech', () => ({ speak: () => undefined }));
jest.mock('../../platform/media', () => ({
  mediaFileUri: () => null,
  writeImportMedia: () => ({ written: 0, bytes: 0, missing: [], failed: [] }),
}));
jest.mock('../../theme/ThemeContext', () => ({
  useColors: () => jest.requireActual<typeof import('../../theme/tokens')>('../../theme/tokens').light,
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// The tabs layout file also holds the weekly backup and the crash screen; the
// tab-bar test needs neither (they read files on the phone).
jest.mock('../../store/autoBackup', () => ({ useAutoBackup: () => undefined }));
jest.mock('../../components/ErrorScreen', () => ({ ErrorScreen: () => null }));

let renderer: ReactTestRenderer | null = null;

/**
 * Render `element` and let its first async updates land (the Reduce Motion
 * read, the boot result), inside act, so React applies them before the test looks.
 */
async function mount(element: React.ReactElement): Promise<ReactTestRenderer> {
  await act(async () => {
    renderer = TestRenderer.create(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return renderer!;
}

/** Every text on screen, joined (children arrays of strings and numbers too). */
function texts(r: ReactTestRenderer): string[] {
  return r.root
    .findAll((n) => (n.type as unknown) === 'Text')
    .map((n) => {
      const ch = n.props.children;
      return Array.isArray(ch) ? ch.filter((x) => typeof x === 'string' || typeof x === 'number').join('') : String(ch ?? '');
    });
}

/** The pressable whose accessibility label is `label`. */
function byLabel(r: ReactTestRenderer, label: string): ReactTestInstance {
  const node = r.root.findAll(
    (n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  )[0];
  if (!node) throw new Error(`no control labelled "${label}"`);
  return node;
}

/** The nearest pressable above the text `text`. */
function byText(r: ReactTestRenderer, text: string): ReactTestInstance {
  const node = r.root.findAll((n) => (n.type as unknown) === 'Text' && n.props.children === text)[0];
  if (!node) throw new Error(`no text "${text}"`);
  let cur: ReactTestInstance | null = node;
  while (cur && typeof cur.props.onPress !== 'function') cur = cur.parent;
  if (!cur) throw new Error(`"${text}" is not pressable`);
  return cur;
}

beforeEach(() => {
  mockFocused = true;
  mockPush.mockClear();
  mockNavigate.mockClear();
  mockShow.mockClear();
  mockSnackChannel.snack = null;
  mockRepaired = [];
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe('the Study pulse is finite (wave 5i, release re-measure)', () => {
  /** Make the next OS read of Reduce Motion answer `value`, and wait for it (useReduceMotion keeps it). */
  async function setReduceMotion(value: boolean): Promise<void> {
    jest.mocked(AccessibilityInfo.isReduceMotionEnabled).mockResolvedValue(value);
    const stop = subscribeReduceMotion(() => undefined);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    stop();
  }

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    await setReduceMotion(false);
  });

  it('a few breaths only: STUDY_PULSE is 2 breaths of 3.2 s, scale 1.015 (the design pulseSoft)', () => {
    expect(STUDY_PULSE).toEqual({ times: 2, halfMs: 1600, scale: 1.015 });
    expect(pulseOn({ focused: true, reduced: false, total: 30 })).toBe(true);
    expect(pulseOn({ focused: false, reduced: false, total: 30 })).toBe(false);
    expect(pulseOn({ focused: true, reduced: true, total: 30 })).toBe(false);
    expect(pulseOn({ focused: true, reduced: false, total: 0 })).toBe(false);
  });

  it('startStudyPulse ENDS by itself: the end comes once, the button is back at rest, no timer is left', () => {
    jest.useFakeTimers();
    const value = new Animated.Value(0);
    const onEnd = jest.fn<(finished: boolean) => void>();
    const stop = startStudyPulse(value, onEnd);
    expect(jest.getTimerCount()).toBeGreaterThan(0); // it is running
    // Far longer than the 2 breaths (6.4 s): an endless loop would still have a timer here.
    act(() => {
      jest.advanceTimersByTime(STUDY_PULSE.times * 2 * STUDY_PULSE.halfMs + 60_000);
    });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(true);
    expect(jest.getTimerCount()).toBe(0);
    expect((value as unknown as { __getValue(): number }).__getValue()).toBe(0);
    // Stopping after the end changes nothing.
    stop();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('stopped early (Today left, the number changed): it ends at once, at rest', () => {
    jest.useFakeTimers();
    const value = new Animated.Value(0);
    const onEnd = jest.fn<(finished: boolean) => void>();
    const stop = startStudyPulse(value, onEnd);
    // Stopped during the first half breath (React Native's jest mock ends each native half after 16 ms).
    act(() => stop());
    expect(onEnd).toHaveBeenCalledWith(false);
    expect((value as unknown as { __getValue(): number }).__getValue()).toBe(0);
    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('Today: one short pulse when it shows (iterations = STUDY_PULSE.times), another when the number changes', async () => {
    const loop = jest.spyOn(Animated, 'loop');
    mockState = library([['d1', 'German', times(3, dueReview)]]);
    const r = await mount(React.createElement(TodayScreen));
    expect(byLabel(r, 'Study 3')).toBeDefined();
    expect(loop).toHaveBeenCalledTimes(1);
    expect(loop.mock.calls[0][1]).toEqual({ iterations: STUDY_PULSE.times });
    // The same number again (another render): no new pulse.
    act(() => r.update(React.createElement(TodayScreen)));
    expect(loop).toHaveBeenCalledTimes(1);
    // The number changes (a card more is due): a new short pulse.
    mockState = library([['d1', 'German', times(4, dueReview)]]);
    act(() => {
      for (const l of mockStoreListeners) l();
    });
    expect(byLabel(r, 'Study 4')).toBeDefined();
    expect(loop).toHaveBeenCalledTimes(2);
    expect(loop.mock.calls[1][1]).toEqual({ iterations: STUDY_PULSE.times });
  });

  it('no pulse while Today is not the screen in front', async () => {
    const loop = jest.spyOn(Animated, 'loop');
    mockFocused = false;
    mockState = library([['d1', 'German', times(3, dueReview)]]);
    const r = await mount(React.createElement(TodayScreen));
    expect(byLabel(r, 'Study 3')).toBeDefined();
    expect(loop).not.toHaveBeenCalled();
    // Today comes back in front: then it pulses.
    mockFocused = true;
    act(() => r.update(React.createElement(TodayScreen)));
    expect(loop).toHaveBeenCalledTimes(1);
  });

  it('no pulse with Reduce Motion (spec §8.12)', async () => {
    await setReduceMotion(true);
    const loop = jest.spyOn(Animated, 'loop');
    mockState = library([['d1', 'German', times(3, dueReview)]]);
    const r = await mount(React.createElement(TodayScreen));
    expect(byLabel(r, 'Study 3')).toBeDefined();
    expect(loop).not.toHaveBeenCalled();
  });
});

describe('Today screen wiring', () => {
  it('the hero "Study {n}" opens the scheduled session over everything, with exactly n cards', async () => {
    mockState = library([['d1', 'German', [...times(3, dueReview), ...times(2, newCard)]]]);
    const r = await mount(React.createElement(TodayScreen));
    const n = readyAll(mockState).total;
    expect(n).toBe(5);
    act(() => byLabel(r, `Study ${n}`).props.onPress());
    const href = mockPush.mock.calls[0][0] as ReturnType<typeof sessionRoute>;
    expect(href.params.kind).toBe('scheduled');
    expect(buildSessionQueue({ kind: 'scheduled', q: parseQueryParam(href.params.q) }, mockState, matchCtxOf(mockState, NOW))).toHaveLength(n);
    expect(texts(r)).toContain('5 cards ready · about 2 min');
  });

  it('a deck row opens the deck page; its pill opens that deck’s session (pill = queue length)', async () => {
    mockState = library([
      ['d1', 'German', [...times(4, dueReview), ...times(10, newCard)]],
      ['d2', 'Spanish', times(10, newCard)],
    ]);
    const r = await mount(React.createElement(TodayScreen));
    expect(texts(r)).toContain('4 due · 10 new');
    act(() => byLabel(r, 'German, 4 due · 10 new').props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith('/deck/d1');
    act(() => byLabel(r, 'Study 10 from Spanish').props.onPress());
    const href = mockPush.mock.calls.at(-1)![0] as ReturnType<typeof sessionRoute>;
    expect(parseQueryParam(href.params.q)).toEqual({ decks: ['d2'] });
    expect(buildSessionQueue({ kind: 'scheduled', q: { decks: ['d2'] } }, mockState, matchCtxOf(mockState, NOW))).toHaveLength(10);
    // 14 + 10 pills vs a total of 14: the note explains the shared new-card limit.
    expect(texts(r).some((t) => t.includes('session of that deck only'))).toBe(true);
    expect(texts(r)).toContain(`${SHARED_LIMIT_COPY.separate} ${SHARED_LIMIT_COPY.newLimit}`);
  });

  it('empty active deck + paused deck with cards: "Your cards are in paused decks." with real buttons (review round 1)', async () => {
    mockState = library([
      ['d1', 'New deck', []],
      ['d2', 'Imported', times(3, dueReview), false],
    ]);
    const r = await mount(React.createElement(TodayScreen));
    expect(texts(r)).toContain(TODAY_COPY.pausedCardsTitle);
    expect(texts(r)).not.toContain(TODAY_COPY.noCardsTitle);
    expect(texts(r)).not.toContain('Imported'); // still collapsed
    act(() => byText(r, TODAY_COPY.showPaused).props.onPress());
    expect(texts(r)).toContain('Imported');
    expect(texts(r)).toContain('Paused · 3 cards');
    act(() => byText(r, TODAY_COPY.addCard).props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/card-editor', params: { deckId: 'd1' } });
  });

  it('paused decks collapse into "Paused (1)" and a tap shows them', async () => {
    mockState = library([
      ['d1', 'German', [dueReview()]],
      ['d2', 'Spanish', [dueReview()], false],
    ]);
    const r = await mount(React.createElement(TodayScreen));
    expect(texts(r)).toContain('Paused (1)');
    expect(texts(r)).not.toContain('Spanish');
    act(() => byLabel(r, 'Paused (1), hidden').props.onPress());
    expect(texts(r)).toContain('Spanish');
    expect(texts(r)).toContain('Paused · 1 card');
  });

  it('caught up: only the buttons with cards, each opening its own session', async () => {
    mockState = library([['d1', 'German', [lifeOf('review'), notStarted()]]]);
    const r = await mount(React.createElement(TodayScreen));
    expect(texts(r)).toContain(TODAY_COPY.caughtUpTitle);
    expect(texts(r)).toContain('Study ahead · 1');
    expect(texts(r)).toContain('Choose what to learn · 1 not started');
    act(() => byText(r, 'Study ahead · 1').props.onPress());
    expect((mockPush.mock.calls[0][0] as ReturnType<typeof sessionRoute>).params.kind).toBe('ahead');
    act(() => byText(r, 'Choose what to learn · 1 not started').props.onPress());
    expect(mockPush.mock.calls[1][0]).toEqual(triageRoute(NOT_STARTED_SCOPE));
  });

  it('no decks: the empty state has real buttons only (Import a file · Find on AnkiWeb · Make my own deck)', async () => {
    mockState = library([]);
    const r = await mount(React.createElement(TodayScreen));
    expect(texts(r)).toContain(TODAY_COPY.noDecksTitle);
    act(() => byText(r, TODAY_COPY.importFile).props.onPress());
    act(() => byText(r, TODAY_COPY.findAnkiWeb).props.onPress());
    act(() => byText(r, TODAY_COPY.makeDeck).props.onPress());
    expect(mockPush.mock.calls.map((c) => c[0])).toEqual([
      { pathname: '/import', params: { source: 'file' } },
      { pathname: '/import', params: { source: 'ankiweb' } },
      '/deck-editor',
    ]);
  });

  it('the header "+" has a label and opens the AddSheet', async () => {
    mockState = library([['d1', 'German', [dueReview()]]]);
    const r = await mount(React.createElement(TodayScreen));
    act(() => byLabel(r, TODAY_COPY.addLabel).props.onPress());
    expect(r.root.findByType(AddSheet).props.open).toBe(true);
  });

  it('the reminder offer: "Remind me at 8:00 PM" sets reminderOfferSeen and opens Settings › Reminders with enable=1', async () => {
    mockState = library([['d1', 'German', [dueReview()]]], {
      sessions: [{ id: 's1', dayKey: dayKeyOf(NOW - DAY), at: NOW - DAY } as unknown as DataStateV3['sessions'][number]],
    });
    const r = await mount(React.createElement(TodayScreen));
    expect(texts(r)).toContain('Want a daily reminder?');
    act(() => byText(r, 'Remind me at 8:00 PM').props.onPress());
    expect(mockState.settings.reminderOfferSeen).toBe(true);
    expect(mockPush).toHaveBeenLastCalledWith(REMINDER_OFFER_HREF);
    expect(texts(r)).not.toContain('Want a daily reminder?');
  });

  it('the repairs card shows the boot result’s count first, and closes', async () => {
    mockRepaired = ['card #1: removed', 'note "n": padded'];
    mockState = library([['d1', 'German', [dueReview()]]], {
      sessions: [{ id: 's1', dayKey: dayKeyOf(NOW - DAY), at: NOW - DAY } as unknown as DataStateV3['sessions'][number]],
    });
    const r = await mount(React.createElement(TodayScreen));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(texts(r)).toContain('We fixed 2 items in your library.');
    expect(texts(r)).not.toContain('Want a daily reminder?'); // at most one at a time
    act(() => byLabel(r, 'Close this message').props.onPress());
    expect(texts(r)).not.toContain('We fixed 2 items in your library.');
    expect(texts(r)).toContain('Want a daily reminder?');
  });

  it('lists: the row opens Library with the list and a nonce; its pill opens the list session', async () => {
    mockState = library([['d1', 'German', [{ ...dueReview(), fav: true }]]], {
      listPrefs: { 'builtin:favorites': { pinned: true, hidden: false, order: 0 } },
    });
    const r = await mount(React.createElement(TodayScreen));
    act(() => byLabel(r, 'Favorites, 1 card · 1 due').props.onPress());
    const lib = mockNavigate.mock.calls[0][0] as ReturnType<typeof libraryRoute>;
    expect(lib.pathname).toBe('/(tabs)/library');
    expect(parseQueryParam(lib.params.q)).toEqual({ list: 'builtin:favorites' });
    expect(lib.params.nonce).toMatch(/^\d+$/);
    act(() => byLabel(r, 'Study 1 from Favorites').props.onPress());
    expect(parseQueryParam((mockPush.mock.calls[0][0] as ReturnType<typeof sessionRoute>).params.q)).toEqual({
      list: 'builtin:favorites',
    });
    // Zero built-in lists wait behind "Show all lists".
    expect(texts(r)).not.toContain('Hard cards');
    act(() => byText(r, TODAY_COPY.showAllLists).props.onPress());
    expect(texts(r)).toContain('Hard cards');
  });

  // W4-1 review round 2.
  it('lists: a hidden list → no "No lists yet…" (it would be false), only "Show all lists"', async () => {
    mockState = library([['d1', 'German', [dueReview()]]], {
      lists: [{ id: 'list-1', name: 'B1 verbs', icon: '⭐', query: { tags: ['verb'] }, createdAt: NOW, updatedAt: NOW }],
      listPrefs: { 'list-1': { pinned: false, hidden: true, order: 0 } },
    });
    const r = await mount(React.createElement(TodayScreen));
    expect(texts(r)).not.toContain(TODAY_COPY.noLists);
    expect(texts(r)).not.toContain('B1 verbs');
    act(() => byText(r, TODAY_COPY.showAllLists).props.onPress());
    expect(texts(r)).toContain('B1 verbs');
    act(() => r.unmount());

    // No list made at all: the line shows (and tells the truth).
    mockState = library([['d1', 'German', [dueReview()]]]);
    const fresh = await mount(React.createElement(TodayScreen));
    expect(texts(fresh)).toContain(TODAY_COPY.noLists);
  });

  // Final review 2026-11: the button counted CARDS, also of a direction that is turned off.
  it('"Choose what to learn · {n}" = the triage items; a turned-off direction gives no button to an empty triage', async () => {
    const REVERSE = BUILTIN_TYPE_IDS.basicReverse;
    const reverse = (directions: number[] | null, cardOf: (ord: number) => Partial<Card>, extra: Partial<Card>[] = []) =>
      stateOfV3({
        decks: [makeDeckV3({ id: 'd1', name: 'Capitals', order: 0, options: directions ? { directions: { [REVERSE]: directions } } : {} })],
        groups: [
          ...times(3, () => noteWithCards({ deckId: 'd1', typeId: REVERSE, card: cardOf })),
          ...extra.map((v) => card('d1', v)),
        ],
        overrides: { settings: makeSettingsV3({ sessionLimit: 0, srs: { dailyNewLimit: 10 } }) },
      });
    // Both directions on, the forward cards are reviews (not due), the reverse ones Not started: 3 items.
    mockState = reverse(null, (ord) => (ord === 0 ? lifeOf('review') : lifeValues('notStarted', NOW)));
    const r = await mount(React.createElement(TodayScreen));
    expect(texts(r)).toContain(TODAY_COPY.caughtUpTitle);
    expect(texts(r)).toContain('Choose what to learn · 3 not started');
    // The label may wrap: "Choose what to learn · 12 not started" is wider than the card on a 360-dp phone.
    const label = r.root.findAll((n) => (n.type as unknown) === 'Text' && n.props.children === 'Choose what to learn · 3 not started')[0];
    expect(label.props.numberOfLines).toBe(2);
    act(() => r.unmount());

    // Every item's two directions Not started (and one review): 3 items, never "· 6".
    mockState = reverse(null, () => lifeValues('notStarted', NOW), [lifeOf('review')]);
    const both = await mount(React.createElement(TodayScreen));
    const chooseLabels = texts(both).filter((t) => t.startsWith('Choose what to learn'));
    expect(chooseLabels).toEqual(['Choose what to learn · 3 not started']);
    act(() => both.unmount());

    // Reverse turned off: its Not started cards are not choices. No button to "Nothing left to choose here."
    mockState = reverse([0], (ord) => (ord === 0 ? lifeOf('review') : lifeValues('notStarted', NOW)));
    const off = await mount(React.createElement(TodayScreen));
    expect(texts(off)).toContain(TODAY_COPY.caughtUpTitle);
    expect(texts(off).some((t) => t.startsWith('Choose what to learn'))).toBe(false);
    act(() => off.unmount());

    // Reverse off and the forward cards Known: "You're all caught up.", not "Nothing is in your queue yet."
    mockState = reverse([0], (ord) => lifeValues(ord === 0 ? 'known' : 'notStarted', NOW));
    const known = await mount(React.createElement(TodayScreen));
    expect(texts(known)).not.toContain(TODAY_COPY.notStartedTitle);
    expect(texts(known)).toContain(TODAY_COPY.caughtUpTitle);
    expect(texts(known)).not.toContain(TODAY_COPY.chooseWhat);
  });

  // W4-1 review round 2: "Choose what to learn" would open an empty triage.
  it('only suspended Not started cards: no "Nothing is in your queue yet." and no button to an empty triage', async () => {
    mockState = library([['d1', 'German', times(2, () => lifeOf('notStarted', { suspended: true }))]]);
    const r = await mount(React.createElement(TodayScreen));
    expect(texts(r)).not.toContain(TODAY_COPY.notStartedTitle);
    expect(texts(r)).not.toContain(TODAY_COPY.chooseWhat);
    expect(texts(r)).toContain(TODAY_COPY.caughtUpTitle);
    expect(texts(r)).toContain(TODAY_COPY.caughtUpSubAlone); // no button has a card
  });
});

describe('tab bar wiring (spec §2.1, §8.12)', () => {
  // The tab routes of this folder: the 4 tabs and two old ones (browse, stats) that get no button.
  const ROUTE_NAMES = ['index', 'library', 'progress', 'settings', 'browse', 'stats'];
  const router = TabRouter({});
  const config = { routeNames: ROUTE_NAMES, routeParamList: {}, routeGetIdList: {} };
  type TabState = TabNavigationState<Record<string, object | undefined>>;

  /** The real router's next state for `action` (expo-router's vendored TabRouter). */
  function step(state: TabState, action: ReturnType<typeof CommonActions.navigate>): TabState {
    const next = router.getStateForAction(state, action, config);
    if (next === null) throw new Error('the tab router did not handle the action');
    return next as TabState;
  }

  /**
   * The bar over a REAL tab state. A press runs `navigation.navigate(name,
   * params)` through the real router, like Expo Router does on the phone;
   * `press(label)` then draws the bar again with the new state.
   */
  async function mountBar(initial: TabState) {
    const h = { state: initial };
    const navigation = {
      emit: jest.fn((_e: { type: 'tabPress'; target: string; canPreventDefault: true }) => ({ defaultPrevented: false })),
      navigate: jest.fn((name: string, params?: object) => {
        h.state = step(h.state, CommonActions.navigate(name, params));
      }),
    };
    const r = await mount(React.createElement(MarankiTabBar, { state: h.state, navigation }));
    const press = (label: string) => {
      act(() => byLabel(r, label).props.onPress());
      act(() => r.update(React.createElement(MarankiTabBar, { state: h.state, navigation })));
    };
    return { r, h, navigation, press };
  }

  /** The labels of the tab buttons, in bar order (each control once). */
  const tabLabels = (r: ReactTestRenderer) => [
    ...new Set(
      r.root
        .findAll((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'tab' && typeof n.props.onPress === 'function')
        .map((n) => n.props.accessibilityLabel as string),
    ),
  ];

  it('exactly 4 tabs — Today, Library, Progress, Settings — by route name; old routes get no button', async () => {
    mockState = library([]);
    const { r } = await mountBar(router.getInitialState(config));
    expect(TABS.map((t) => t.name)).toEqual(['index', 'library', 'progress', 'settings']);
    expect(tabLabels(r)).toEqual(['Today', 'Library', 'Progress', 'Settings']);
    expect(texts(r)).not.toContain('browse');
    expect(texts(r)).not.toContain('stats');
    // The tab you are on says so to a screen reader.
    expect(byLabel(r, 'Today').props.accessibilityState).toEqual({ selected: true });
    expect(byLabel(r, 'Library').props.accessibilityState).toEqual({ selected: false });
  });

  it('the amber Today badge = readyFor({}).total (= the hero’s "Study {n}"), and the label says it', async () => {
    mockState = library([['d1', 'German', [...times(3, dueReview), ...times(2, newCard)]]]);
    const n = readyAll(mockState).total;
    expect(n).toBe(5);
    const { r } = await mountBar(router.getInitialState(config));
    expect(tabLabels(r)[0]).toBe('Today, 5 cards ready');
    expect(texts(r)).toContain(String(n));
    // The badge's number is the theme's text-on-amber (white on amber was 2.7:1; uiContrast.test.ts).
    const badge = r.root.findAll((node) => (node.type as unknown) === 'Text' && node.props.children === n)[0];
    expect(StyleSheet.flatten(badge.props.style).color).toBe(light.inkOnAmber);
    act(() => r.unmount());

    // One card: "1 card", never "1 cards" (plural()).
    mockState = library([['d1', 'German', [dueReview()]]]);
    const one = await mountBar(router.getInitialState(config));
    expect(tabLabels(one.r)[0]).toBe('Today, 1 card ready');
    act(() => one.r.unmount());

    // Nothing ready: no badge, the label is only the tab name.
    mockState = library([['d1', 'German', [lifeOf('review')]]]);
    const none = await mountBar(router.getInitialState(config));
    expect(tabLabels(none.r)[0]).toBe('Today');
    expect(texts(none.r)).toEqual(['Today', 'Library', 'Progress', 'Settings']);
  });

  it('the tab labels (and the badge) grow with the system font size, at most 1.3 times', async () => {
    mockState = library([['d1', 'German', [dueReview()]]]);
    const { r } = await mountBar(router.getInitialState(config));
    const textNodes = r.root.findAll((n) => (n.type as unknown) === 'Text');
    expect(textNodes.length).toBe(5); // 4 labels + the badge
    expect(TAB_LABEL_MAX_SCALE).toBe(1.3);
    for (const node of textNodes) expect(node.props.maxFontSizeMultiplier).toBe(1.3);
  });

  // W4-1 review round 2: the old bar called navigate(route.name), and the router then dropped the params.
  it('a tab press KEEPS the tab’s params: Library keeps the q + nonce Today sent (spec §4.6)', async () => {
    mockState = library([['d1', 'German', [dueReview()]]]);
    // Today › list row: Library with the list and a nonce (ListRows openList).
    const sent = libraryRoute(listScope('builtin:favorites'), '1').params;
    const onLibrary = step(router.getInitialState(config), CommonActions.navigate('library', sent));
    const { h, navigation, press } = await mountBar(onLibrary);

    // The learner taps Progress, then Library, in the bar.
    press('Progress');
    expect(h.state.routes[h.state.index].name).toBe('progress');
    const onProgress = h.state;
    press('Library');
    expect(h.state.routes[h.state.index].name).toBe('library');
    expect(navigation.navigate).toHaveBeenLastCalledWith('library', sent);
    const library_ = h.state.routes.find((route) => route.name === 'library')!;
    // The same params: the same nonce, so Library does not reset its chips.
    expect(library_.params).toBe(sent);
    expect(parseQueryParam((library_.params as typeof sent).q)).toEqual({ list: 'builtin:favorites' });

    // Why it matters: a navigate WITHOUT params makes the router drop them (the old bar's call).
    const dropped = step(onProgress, CommonActions.navigate('library'));
    expect(dropped.routes.find((route) => route.name === 'library')!.params).toBeUndefined();
  });

  it('a press on the tab you are on, or a press another listener stopped, does not navigate', async () => {
    mockState = library([]);
    const { navigation, press } = await mountBar(router.getInitialState(config));
    press('Today'); // already on Today
    expect(navigation.emit).toHaveBeenCalledTimes(1);
    expect(navigation.navigate).not.toHaveBeenCalled();
    navigation.emit.mockReturnValueOnce({ defaultPrevented: true });
    press('Library');
    expect(navigation.navigate).not.toHaveBeenCalled();
  });
});

describe('ListActionsSheet wiring', () => {
  const list: ListDef = { id: 'list-1', name: 'B1 verbs', icon: '⭐', query: { tags: ['verb'] }, createdAt: NOW, updatedAt: NOW };

  beforeEach(() => {
    mockState = library([['d1', 'German', [newCard()]]], { lists: [list] });
  });

  /** A parent like Today's ListRows: the menu closes by clearing its list id. */
  function ListMenuHost({ id }: { id: string }) {
    const [menuId, setMenuId] = React.useState<string | null>(id);
    return React.createElement(ListActionsSheet, { listId: menuId, open: menuId !== null, onClose: () => setMenuId(null) });
  }

  /** Let the menu's slide-out finish: its onClosed opens the next sheet. */
  async function afterSlideOut() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
  }

  // Wave-4b merge (the guard below): "Rename" opens SaveListSheet, the Library's
  // "Save as list" sheet in its rename mode (spec §2.3), after the menu slid out.
  it('Rename opens SaveListSheet; it saves the new name and keeps the id, the filters and the sort', async () => {
    mockState = { ...mockState, lists: [{ ...list, sort: { by: 'due' } }] };
    const r = await mount(React.createElement(ListMenuHost, { id: 'list-1' }));
    act(() => byText(r, 'Rename').props.onPress());
    // Never two native modals animating at once: it opens after the slide-out.
    expect(texts(r)).not.toContain('Rename list');
    await afterSlideOut();
    expect(texts(r)).toContain('Rename list');
    const input = r.root.findAll((n) => n.props.accessibilityLabel === 'Name' && typeof n.props.onChangeText === 'function')[0];
    act(() => input.props.onChangeText('Verbs B1'));
    act(() => byText(r, 'Save').props.onPress());
    expect(mockState.lists).toHaveLength(1);
    expect(mockState.lists[0]).toMatchObject({ id: 'list-1', name: 'Verbs B1', query: { tags: ['verb'] }, sort: { by: 'due' } });
    expect(mockShow).toHaveBeenLastCalledWith("List renamed to 'Verbs B1'");
  });

  // W4-1 review round 1: a list has a name AND an emoji (spec §4.7); Rename can change both.
  it('Rename can change the icon (grid or a typed emoji); the name, filters and id stay', async () => {
    const r = await mount(React.createElement(ListMenuHost, { id: 'list-1' }));
    act(() => byText(r, 'Rename').props.onPress());
    await afterSlideOut();
    expect(byLabel(r, 'Icon ⭐').props.accessibilityState).toEqual({ selected: true }); // the list's icon
    act(() => byLabel(r, 'Icon 🎯').props.onPress());
    act(() => byText(r, 'Save').props.onPress());
    expect(mockState.lists[0]).toMatchObject({ id: 'list-1', name: 'B1 verbs', icon: '🎯', query: { tags: ['verb'] } });
    act(() => r.unmount());

    // "Type any emoji": one glyph, even a flag made of two code points.
    const again = await mount(React.createElement(ListMenuHost, { id: 'list-1' }));
    act(() => byText(again, 'Rename').props.onPress());
    await afterSlideOut();
    const typed = again.root.findAll(
      (n) => n.props.accessibilityLabel === 'Type any emoji' && typeof n.props.onChangeText === 'function',
    )[0];
    act(() => typed.props.onChangeText('🇩🇪 German'));
    act(() => byText(again, 'Save').props.onPress());
    expect(mockState.lists[0]).toMatchObject({ id: 'list-1', name: 'B1 verbs', icon: '🇩🇪', query: { tags: ['verb'] } });
  });

  it('Hide moves the list off Today, with Undo', async () => {
    const r = await mount(React.createElement(ListActionsSheet, { listId: 'list-1', open: true, onClose: () => undefined }));
    act(() => byText(r, 'Hide').props.onPress());
    expect(mockState.listPrefs['list-1'].hidden).toBe(true);
    act(() => mockSnackChannel.snack!.onAction!());
    expect(listPrefOf(list, mockState.listPrefs)).toMatchObject({ hidden: false, pinned: true });
  });

  it('Delete list asks first, then deletes only the saved filter (the cards stay)', async () => {
    const cards = mockState.cards.length;
    const r = await mount(React.createElement(ListActionsSheet, { listId: 'list-1', open: true, onClose: () => undefined }));
    act(() => byText(r, 'Delete list').props.onPress());
    expect(mockState.lists).toHaveLength(1); // not yet: it asks first
    expect(texts(r)).toContain('Delete ‘B1 verbs’?');
    act(() => byText(r, 'Delete list').props.onPress());
    expect(mockState.lists).toHaveLength(0);
    expect(mockState.cards).toHaveLength(cards);
  });

  it('Edit filters opens Library with the list', async () => {
    const r = await mount(React.createElement(ListActionsSheet, { listId: 'list-1', open: true, onClose: () => undefined }));
    act(() => byText(r, 'Edit filters').props.onPress());
    expect(parseQueryParam((mockNavigate.mock.calls[0][0] as ReturnType<typeof libraryRoute>).params.q)).toEqual({ list: 'list-1' });
  });

  it('a built-in list offers only Open in Library and Hide / Show on Today', async () => {
    const r = await mount(React.createElement(ListActionsSheet, { listId: 'builtin:hard', open: true, onClose: () => undefined }));
    expect(texts(r)).toContain('Open in Library');
    expect(texts(r)).toContain('Show on Today'); // not pinned yet
    expect(texts(r)).not.toContain('Rename');
    expect(texts(r)).not.toContain('Delete list');
    act(() => byText(r, 'Show on Today').props.onPress());
    expect(mockState.listPrefs['builtin:hard']).toMatchObject({ pinned: true, hidden: false });
  });
});

describe('AddSheet wiring', () => {
  it('each row does what it says', async () => {
    mockState = library([['d1', 'Spanish verbs', [newCard()]]]);
    const r = await mount(React.createElement(AddSheet, { open: true, onClose: () => undefined }));
    expect(texts(r)).toContain('Into Spanish verbs');
    act(() => byText(r, 'New card').props.onPress());
    act(() => byText(r, 'New deck').props.onPress());
    act(() => byText(r, 'Import a file').props.onPress());
    act(() => byText(r, 'Find on AnkiWeb').props.onPress());
    expect(mockPush.mock.calls.map((c) => c[0])).toEqual([
      { pathname: '/card-editor', params: { deckId: 'd1' } },
      '/deck-editor',
      { pathname: '/import', params: { source: 'file' } },
      { pathname: '/import', params: { source: 'ankiweb' } },
    ]);
    act(() => byText(r, 'New list').props.onPress());
    expect((mockNavigate.mock.calls[0][0] as ReturnType<typeof libraryRoute>).params.newList).toBe('1');
  });

  it('no starter section in the generic build; a pack with starter decks shows "Added ✓" / "Add"', async () => {
    mockState = library([]);
    const plain = await mount(React.createElement(AddSheet, { open: true, onClose: () => undefined }));
    expect(texts(plain)).not.toContain(TODAY_COPY.starterDecks);
    expect(texts(plain)).not.toContain('New card'); // no deck yet
    act(() => plain.unmount());

    const pack: ContentPack = {
      id: 'german',
      cardTypePresets: [],
      starterDecks: [
        { key: 'vocabulary', title: 'German vocabulary', subtitle: 'Words', asset: 1, version: 1 },
        { key: 'verbs', title: 'German verbs', subtitle: 'Verbs', asset: 2, version: 1 },
      ],
    };
    const installed = makeDeckV3({ id: 'dv', name: 'German vocabulary', sourceKey: 'pack:german:vocabulary', source: 'pack' });
    mockState = stateOfV3({ decks: [installed], overrides: { person: makePersonV3() } });
    const r = await mount(React.createElement(AddSheet, { open: true, onClose: () => undefined, pack }));
    expect(texts(r)).toContain(TODAY_COPY.starterDecks);
    expect(texts(r)).toContain('Added ✓');
    expect(byLabel(r, 'Add German verbs')).toBeTruthy();
    act(() => byText(r, 'German vocabulary').props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith('/deck/dv');
  });
});

/* ================================================================ Part 3 — merge guards */

/*
 * W4-1 merges LAST in wave 4 (spec §10.7: W4-6 → W4-2 → W4-3 → W4-5 → W4-4 →
 * W4-1). In this unit's worktree the Library (W4-2) does not exist yet, so two
 * parts of this unit can only be finished at the merge (W4-1 review round 1).
 * These tests read the source files and FAIL after the merge until that is done.
 */
const REPO = path.resolve(__dirname, '..', '..', '..');
const exists = (rel: string) => fs.existsSync(path.join(REPO, rel));
const sourceText = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

/** Every .ts/.tsx file under `dir` (repo-relative, with '/'); none when `dir` does not exist. */
function sourceFiles(dir: string): string[] {
  if (!exists(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const LIBRARY_SCREEN = 'src/app/(tabs)/library.tsx';
const OLD_BROWSE = 'src/app/(tabs)/browse.tsx';
const OLD_ADD_DECK_SHEET = 'src/components/sheets/AddDeckSheet.tsx';
const SAVE_LIST_SHEET = 'src/components/sheets/SaveListSheet.tsx';
const LIST_ACTIONS_SHEET = 'src/components/sheets/ListActionsSheet.tsx';

describe('merge guards (W4-1 merges last)', () => {
  // Skipped while the Library tab is not built (this unit's worktree); it runs after the merge.
  // MERGE NOTE: the spec pins only `q` and `nonce` for Library, so W4-2 does not know the
  // `newList` param. This test is EXPECTED to fail right after the merge, until library.tsx
  // (W4-2's file) reads it — an edit planned at integration.
  (exists(LIBRARY_SCREEN) ? it : it.skip)(
    'Library reads the "New list" param and shows its banner (spec §8.10, todayLogic NEW_LIST_PARAM)',
    () => {
      const files = [LIBRARY_SCREEN, ...sourceFiles('src/components/library')].filter((f) => !f.endsWith('.test.ts'));
      const readers = files.filter((f) => /\b(newListBannerFor|NEW_LIST_BANNER)\b/.test(sourceText(f)));
      // FIX: in Library's "adjust state when a prop changes" step (a new nonce),
      // keep `banner = newListBannerFor(params.newList)` and show it above the chips until
      // "Save as list" or "Clear all" ("Clear all" also clears `newList`).
      // Add a Library wiring test: params { q: '{}', nonce, newList: '1' } → the banner shows.
      expect(readers).not.toEqual([]);
    },
  );

  it('AddDeckSheet (replaced by AddSheet) has no importer but the old browse.tsx, and goes with it (spec §10 W4-1)', () => {
    const browseLeft = exists(OLD_BROWSE);
    const importers = [...sourceFiles('src/app'), ...sourceFiles('src/components')]
      .filter((f) => !f.endsWith('.test.ts'))
      .filter((f) => /['"][^'"]*\/AddDeckSheet['"]/.test(sourceText(f)));
    expect(importers).toEqual(browseLeft ? [OLD_BROWSE] : []);
    // FIX after W4-2 deleted browse.tsx: delete src/components/sheets/AddDeckSheet.tsx too.
    expect(exists(OLD_ADD_DECK_SHEET)).toBe(browseLeft);
  });

  // W4-1 review round 2. Skipped while SaveListSheet (W4-2) is not built; it runs after the merge.
  (exists(SAVE_LIST_SHEET) ? it : it.skip)(
    'list "Rename" opens SaveListSheet, not a second copy of it (spec §2.3)',
    () => {
      const text = sourceText(LIST_ACTIONS_SHEET);
      // FIX at the merge: the 'rename' action of ListActionsSheet closes the sheet and opens
      // SaveListSheet for this list (its rename mode). Then delete the 'rename' stage and
      // LIST_ICON_CHOICES, and move the two "Rename …" tests of "ListActionsSheet wiring"
      // above to SaveListSheet (Rename keeps the id, the filters and the sort).
      expect(text).toMatch(/['"][^'"]*\/SaveListSheet['"]/);
      expect(text).not.toMatch(/\bLIST_ICON_CHOICES\b/);
    },
  );
});
