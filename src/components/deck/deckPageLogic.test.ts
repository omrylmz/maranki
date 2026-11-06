/**
 * Tests for the deck page's pure parts (src/components/deck/deckPageLogic.ts,
 * spec §8.2, §9.3, unit W4-3) and for the import fixes of the same unit
 * (src/domain/importApkg.ts — W4-3 owns no import test file, so they live at
 * the end of this file):
 *   - the header line ("15,960 cards · 15 sections · Imported from …"), the
 *     legend, the empty / "nothing in your queue" modes;
 *   - the study block never offers an EMPTY session: a deck with only new
 *     cards and the day's new-card limit used up shows "Today's new cards are
 *     done…" with Practice, never "Study ahead" (the device dead end); every
 *     shown count equals the session buildSessionQueue opens. That line is
 *     shown only when it is true: not for a deck cap of 0, all-suspended New
 *     cards, or New cards only in a turned-off direction;
 *   - "Today: 20 reviews + 10 new (limit 10 a day)";
 *   - "Add the next 50 in order" = the first items by deck order, all their
 *     enabled directions;
 *   - the "By level" and "By section" bars (status counts per value); the row
 *     menu's "Learn all" / "Mark all as known" leave a turned-off direction as
 *     it is;
 *   - "Where do you start?": groups, the easier cards, the scope from a level
 *     (the deck page then opens "Choose what to learn" there);
 *   - deck settings: directions (on/off keeps progress, never the last one
 *     off), read-aloud summary, the German "Noun genders" rule, CardTypeSheet
 *     drafts saved with the real updateNoteType — a label typed key by key
 *     ("Word (DE)" on the field "Word") is kept as typed;
 *   - Pause through the real reducer: Today ({}) loses the deck, the deck
 *     page ({ decks: [id] }) still studies it;
 *   - the CSV export, routes, delete copy, the frozen store selector;
 *   - import: the real file name ("msf:96" is no name), the re-import target
 *     by guid (wave 5: only when that deck holds at least half of the file's
 *     items), the deck languages from {{tts}};
 *   - wave 5 (W5-5b): "Start at {the first level}" opens triage over the
 *     WHOLE deck (an item with no level is not left out) with `placed=1`; an
 *     empty deck's "Read aloud" row shows the deck languages; the deck
 *     editor's "Create deck" REPLACES itself with /deck/[id] of the new deck,
 *     and its unsaved-changes guard lets that exit through;
 *   - wave 5b (the emulator walkthrough): the header names the file when its
 *     real name is known (L15: an old "msf:96" key → the file of the items,
 *     else "Imported"); the choose flow counts the SAME items
 *     on the deck page and in the triage, with "12 cards (6 items)" (M6); a
 *     mode picked in "More ways to study" opens the next session only (M4);
 *     "Practice your hardest · {n}" is the practice pool hardest first, like
 *     Complete, and "By section" is shown for every deck with ≥ 2 sections —
 *     Algo too — but not twice next to an equal "By level" (M7);
 *   - wave 5b review round 1: the row menu's "Learn all" / "Mark all as
 *     known" and the deck page's "Where do you start?" count ITEMS and use
 *     the triage's words ("4 cards (2 items) added to your queue") on a
 *     two-direction deck (M6); an empty Level on exactly one section keeps
 *     "By section" (the facet engine's rule 2); the header's file tie rule.
 *   - wave 5b review round 2: a nameless key (a name made up from the root
 *     deck, "Algo Deck.apkg", "Default.apkg") names NO file,
 *     and neither do the items that carry that made-up name: the header says
 *     "Imported"; the items' file wins only over the items with no real
 *     name (a 10-item later import never names a 6,000-item deck); the
 *     triage's bulk buttons name their unit like the row menu ("Learn all 2
 *     items left").
 *
 * Part 2 — the deck page's wiring (src/app/deck/[id].tsx), rendered with
 * react-test-renderer: the store hooks read one in-memory state and every
 * action runs the REAL reducer on it (like the CardSheet tests); the router,
 * theme, icons, files and share sheet are small fakes. It checks what no
 * emulator run of this unit could: "Study {n}" opens the session it counts,
 * the "study ahead" dead end is gone, Pause / Add the next 50 / the empty
 * state / the label box / the row menu / "Where do you start?" really call
 * the store and the routes, and a hidden page (a session on top) counts
 * nothing again — not on blur, not on a clock tick, not on a rating.
 */
// '@jest/globals' first: the jest.mock factories below use its `jest`.
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import DeckPage from '../../app/deck/[id]';
import DeckEditorScreen from '../../app/deck-editor';
import { BUILTIN_TYPE_IDS } from '../../domain/builtinTypes';
import { deriveFacets } from '../../domain/facets';
import { readCsv } from '../../domain/import/csvRead';
import { chosenNotesByMid, collectionSections, planImport, startingTypes, suggestDeckName } from '../../domain/import/plan';
import {
  agreedLanguages,
  fallbackFileName,
  guidHomeDeck,
  missingDeckLanguages,
  namelessSourceKey,
  pickedFileName,
  withDeckLanguages,
} from '../../domain/importApkg';
import {
  choiceTypes,
  defaultTarget,
  importOrigin,
  importPlanCtx,
  type ImportPrefs,
  prefsTarget,
  previewHeadline,
  previewRows,
  startingPrefs,
} from '../../domain/importFile';
import { life } from '../../domain/life';
import type {
  AnkiCollection,
  Card,
  DataStateV3,
  Deck,
  FieldDef,
  ImportChoices,
  ImportPlan,
  Note,
  NoteType,
} from '../../domain/model';
import { suggestMapping } from '../../domain/roles';
import { parseQueryParam } from '../../domain/query';
import { buildSessionQueue, decksById, libraryIndexOf, matchCtxOf, readyFor, sortScopeCards, scopePool } from '../../domain/scope';
import { dayKeyOf, DEFAULT_SRS } from '../../domain/types';
import * as reducer from '../../store/reducer';
import { FIXED_NOW } from '../../test/clock';
import {
  cardInLifeV3,
  lifeValues,
  makeDeckV3,
  makePersonV3,
  makeSettingsV3,
  noteWithCards,
  stateOfV3,
  testCtx,
} from '../../test/factoriesV3';
import {
  articlePracticeCount,
  barBlocks,
  cardTypesSummary,
  choosableCounts,
  chooseLine,
  chooseNamesItems,
  chosenCountOf,
  chosenGuidsOf,
  csvHomeDeck,
  importStartPlan,
  maybeSameFile,
  type StartPlan,
  deckCsv,
  deckCsvFileName,
  deckFileName,
  deckPageMode,
  deckScope,
  deckSourceLine,
  deckSubLine,
  deckTypes,
  deleteOptions,
  deleteSnackText,
  directionSnack,
  directionsSummary,
  directionTypes,
  easierCardIds,
  easierNotes,
  effectiveNewLimit,
  fieldsChanged,
  fromLevelScope,
  frozenUnless,
  hardestSession,
  hasGermanTerms,
  importFromDeckPage,
  itemCount,
  launchMode,
  libraryHref,
  lifeCounts,
  madeUpKeyName,
  lifeLegend,
  NEXT_IN_ORDER,
  normalizeFields,
  newCardsLeftToday,
  newCardsScope,
  needsNoteSourceFile,
  newPerDayLabel,
  nextInOrder,
  nextInOrderLabel,
  nextInOrderSnack,
  nextModeLine,
  noteSourceFile,
  notStartedScope,
  otherSourceFiles,
  patchFieldDef,
  pickNextMode,
  placementDone,
  placementGroups,
  placementRank,
  placementSnack,
  readAloudSummary,
  realFileName,
  REIMPORT_MIN_SHARE,
  reimportHomeDeck,
  rowCardIds,
  rowMenuCounts,
  rowMenuLabels,
  rowMenuSnack,
  sectionCount,
  sectionTree,
  sessionRoute,
  sharedTypeNote,
  sourceKeyFileName,
  splitsLikeSections,
  studyBlock,
  todayLine,
  toggledOrds,
  triageHref,
  triageLookupOf,
  typeDecks,
  valueScope,
} from './deckPageLogic';
import { MODE_SCOPE_COPY, MODE_SCOPE_COPY_DECK } from '../study/ModeSheet';
import { hardestParams } from '../study/sessionLogic';
import { HoldButton } from '../ui/HoldButton';
// expo-router's own copy of the React Navigation stack router (a deep import, so the
// 'expo-router' mock below does not replace it): the root stack the deck page lives in.
import { CommonActions, StackActions, StackRouter } from 'expo-router/build/react-navigation/routers';
import { barLabel } from './DeckHeader';
import { DELETE_EVERYTHING_HOLD, DeleteDeckSheet } from './DeleteDeckSheet';
import { NewCardsSheet } from './NewCardsSheet';
import { PlacementSheet } from './PlacementSheet';
import {
  bulkLabels,
  cardIdsOf,
  chooseAll,
  doneCopy,
  leftItems,
  positionLabel,
  startRun,
  stepSnack,
  triageItems,
} from './triageLogic';

const DE = BUILTIN_TYPE_IDS.legacyVocabDe;
const REVERSE = BUILTIN_TYPE_IDS.basicReverse;
const LEVEL = 5; // the Level field of the German built-in card type

/** German words: Word, Translation, …, Level (field 5). */
function word(term: string, meaning: string, level: string): string[] {
  const f = Array<string>(10).fill('');
  f[0] = term;
  f[1] = meaning;
  f[LEVEL] = level;
  return f;
}

/** A deck 'd1' of German words; `card(i)` gives the status of note i's card. */
function germanDeck(
  words: { term: string; meaning: string; level: string; section?: string }[],
  card: (i: number) => Partial<Card> = () => cardInLifeV3('notStarted'),
  overrides: Partial<DataStateV3> = {},
): DataStateV3 {
  const deck = makeDeckV3({ id: 'd1', name: 'German' });
  const groups = words.map((w, i) =>
    noteWithCards({
      deckId: 'd1',
      typeId: DE,
      fields: word(w.term, w.meaning, w.level),
      note: { id: `n${i}`, order: i, section: w.section ?? '' },
      card: () => card(i),
    }),
  );
  return stateOfV3({ decks: [deck], groups, overrides });
}

const LEVELS = [
  { term: 'das Haus', meaning: 'house', level: 'A1', section: 'Vocabulary::A1' },
  { term: 'die Katze', meaning: 'cat', level: 'A1', section: 'Vocabulary::A1' },
  { term: 'der Tisch', meaning: 'table', level: 'A2', section: 'Vocabulary::A2' },
  { term: 'die Reise', meaning: 'trip', level: 'B1', section: 'Verbs::B1' },
  { term: 'das Ziel', meaning: 'goal', level: 'B1', section: 'Verbs::B1' },
];

/** The Algo deck's card type: Front, Back, Category — and Category is exactly the section (spec §4.3 "Coding"). */
const ALGO: NoteType = {
  id: 'nt-algo',
  name: 'Algo Deck',
  kind: 'standard',
  fields: [
    { name: 'Front', role: 'term', facet: 'off' },
    { name: 'Back', role: 'meaning', facet: 'off' },
    { name: 'Category', role: 'detail', facet: 'auto' },
  ],
  templates: [{ ord: 0, name: 'Card 1', prompt: [0], answer: [1, 2] }],
  sortField: 0,
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
};

/**
 * A small Algo deck 'd1': 3 sections (= Category), every card New,
 * imported with a nameless key. Like a real import from the Android
 * Downloads picker ("msf:96"), the key and every item's ref carry the name
 * made up from the root deck, "Algo Deck.apkg" — the real
 * file is "Algo_Patterns.apkg".
 */
function algoState(): DataStateV3 {
  const categories = ['Core Patterns', 'Core Patterns', 'Dynamic Programming', 'Advanced Patterns'];
  const madeUp = fallbackFileName('apkg', 'Algo Deck');
  return stateOfV3({
    decks: [
      makeDeckV3({
        id: 'd1',
        name: 'Algo Deck',
        source: 'apkg',
        sourceKey: namelessSourceKey(madeUp, 'guids'),
      }),
    ],
    types: [ALGO],
    groups: categories.map((category, i) =>
      noteWithCards(
        {
          deckId: 'd1',
          typeId: ALGO.id,
          fields: [`question ${i}`, `answer ${i}`, category],
          note: { id: `g${i}`, order: i, section: category, source: { kind: 'apkg', ref: madeUp } },
          card: () => cardInLifeV3('new'),
        },
        [ALGO],
      ),
    ),
  });
}

/**
 * A German card type with BOTH directions and a Level field: every item has
 * 2 cards, like the walkthrough's German deck ("12 cards … Add the next 6").
 */
const BOTH_WAYS: NoteType = {
  id: 'nt-both-ways',
  name: 'German words (both ways)',
  kind: 'standard',
  fields: [
    { name: 'Word', role: 'term', facet: 'off' },
    { name: 'Translation', role: 'meaning', facet: 'off' },
    { name: 'Level', role: 'badge', facet: 'on' },
  ],
  templates: [
    { ord: 0, name: 'German → English', prompt: [0], answer: [1, 2] },
    { ord: 1, name: 'English → German', prompt: [1], answer: [0, 2] },
  ],
  sortField: 0,
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
};

/**
 * The LEVELS words in deck 'd1' with BOTH directions (10 cards, 5 items);
 * `card(i, ord)` gives each card's status. `options`: the deck's options
 * (for example a direction turned off).
 */
function bothWaysDeck(card: (i: number, ord: number) => Partial<Card>, options: Partial<Deck['options']> = {}): DataStateV3 {
  return stateOfV3({
    decks: [makeDeckV3({ id: 'd1', name: 'German', options })],
    types: [BOTH_WAYS],
    groups: LEVELS.map((w, i) =>
      noteWithCards(
        {
          deckId: 'd1',
          typeId: BOTH_WAYS.id,
          fields: [w.term, w.meaning, w.level],
          note: { id: `n${i}`, order: i },
          card: (ord) => card(i, ord),
        },
        [BOTH_WAYS],
      ),
    ),
  });
}

describe('header', () => {
  it('says where the deck came from', () => {
    expect(deckSourceLine({ source: 'apkg', sourceKey: 'file:German_Complete.apkg' })).toBe(
      'Imported from German_Complete.apkg',
    );
    // An import from before the fix: an Android document id is no file name.
    // Wave 5b (walkthrough L15): no more "Imported from a file" — the file of
    // the items, else just "Imported" (the "Imported deck.csv" name is made up).
    expect(deckSourceLine({ source: 'apkg', sourceKey: 'file:msf:96' })).toBe('Imported');
    expect(deckSourceLine({ source: 'csv', sourceKey: 'file:Imported deck.csv#1x2y' })).toBe('Imported');
    expect(deckSourceLine({ source: 'ankiweb', sourceKey: 'ankiweb:1104981491' })).toBe('Imported from AnkiWeb');
    expect(deckSourceLine({ source: 'pack', sourceKey: 'pack:german:vocabulary' })).toBe('Starter deck');
    expect(deckSourceLine({ source: 'manual' })).toBeNull();
  });

  it('the line under the name and the legend, plural-safe', () => {
    expect(deckSubLine(15960, 15, 'Imported from German_Complete.apkg')).toBe(
      '15,960 cards · 15 sections · Imported from German_Complete.apkg',
    );
    expect(deckSubLine(1, 1, null)).toBe('1 card · 1 section');
    expect(deckSubLine(0, 0, null)).toBe('0 cards');
    expect(
      lifeLegend({ mastered: 312, review: 900, learning: 0, new: 4200, notStarted: 8970, known: 1530 }),
    ).toBe('Mastered 312 · Review 900 · New 4,200 · Not started 8,970 · Known 1,530');
  });

  it('counts sections (the deck root is none) and statuses', () => {
    const state = germanDeck(LEVELS, (i) => cardInLifeV3(i === 0 ? 'review' : 'notStarted'));
    const index = libraryIndexOf(state);
    expect(sectionCount(state.cards, index)).toBe(3);
    expect(lifeCounts(state.cards)).toMatchObject({ review: 1, notStarted: 4 });
  });

  it('the body: empty, nothing queued, normal', () => {
    const zero = { notStarted: 0, new: 0, learning: 0, review: 0, mastered: 0, known: 0 };
    // The third number: the Not started cards triage can choose (every direction on here).
    expect(deckPageMode(0, zero, 0)).toBe('empty');
    expect(deckPageMode(5, { ...zero, notStarted: 4, known: 1 }, 4)).toBe('nothingQueued');
    expect(deckPageMode(5, { ...zero, notStarted: 4, new: 1 }, 4)).toBe('normal');
    expect(chooseLine(8970)).toBe('8,970 cards are not started yet.');
    expect(chooseLine(1)).toBe('1 card is not started yet.');
  });
});

describe('the study block never opens an empty session', () => {
  /**
   * The real numbers of a deck page (the same calls the page makes): ready,
   * ahead and practice, the sessions they open, and the new-card inputs of
   * "Today's new cards are done".
   */
  function numbers(state: DataStateV3) {
    const ctx = matchCtxOf(state, FIXED_NOW);
    const q = deckScope('d1');
    const deck = state.decks.find((d) => d.id === 'd1')!;
    const { dailyNewLimit } = state.settings.srs;
    const pool = scopePool(state, q, ctx, 'browse');
    return {
      ready: readyFor(state, q, ctx).total,
      ahead: buildSessionQueue({ kind: 'ahead', q }, state, ctx).length,
      practice: buildSessionQueue({ kind: 'practice', q }, state, ctx).length,
      readyQueue: buildSessionQueue({ kind: 'scheduled', q }, state, ctx).length,
      eligibleNew: scopePool(state, newCardsScope('d1'), ctx, 'study').length,
      newLimit: effectiveNewLimit(deck.options, dailyNewLimit),
      newLeft: newCardsLeftToday(deck, dailyNewLimit, state.person.dayDone, FIXED_NOW),
      choosable: choosableCounts(pool, triageLookupOf(state, ctx)).cards,
    };
  }

  /** The study block of a state, from its real numbers. */
  function blockOf(state: DataStateV3) {
    return studyBlock(numbers(state));
  }

  it('only new cards and the new-card limit used up: "Today\'s new cards are done" + Practice', () => {
    const state = germanDeck(LEVELS.slice(0, 3), () => cardInLifeV3('new'), {
      settings: makeSettingsV3({ srs: { dailyNewLimit: 2 } }),
      person: makePersonV3({
        dayDone: { dayKey: dayKeyOf(FIXED_NOW), reviews: 0, neww: 2, checks: 0, newByDeck: { d1: 2 } },
      }),
    });
    expect(numbers(state)).toMatchObject({ ready: 0, ahead: 0, practice: 3, eligibleNew: 3, newLimit: 2, newLeft: 0 });
    expect(blockOf(state)).toEqual({ study: 0, fallback: 'practice', ahead: 0, practice: 3, newDone: true });
  });

  it('the deck\'s own cap used up today (the daily limit is not): also "Today\'s new cards are done"', () => {
    const state = germanDeck(LEVELS.slice(0, 3), () => cardInLifeV3('new'), {
      decks: [makeDeckV3({ id: 'd1', name: 'German', options: { newPerDay: 1 } })],
      person: makePersonV3({
        dayDone: { dayKey: dayKeyOf(FIXED_NOW), reviews: 0, neww: 1, checks: 0, newByDeck: { d1: 1 } },
      }),
    });
    expect(numbers(state)).toMatchObject({ ready: 0, eligibleNew: 3, newLimit: 1, newLeft: 0 });
    expect(blockOf(state).newDone).toBe(true);
  });

  it('a deck that gets 0 new cards a day: no "Come back tomorrow" (tomorrow brings none either)', () => {
    const state = germanDeck(LEVELS.slice(0, 3), () => cardInLifeV3('new'), {
      decks: [makeDeckV3({ id: 'd1', name: 'German', options: { newPerDay: 0 } })],
    });
    expect(numbers(state)).toMatchObject({ ready: 0, ahead: 0, practice: 3, eligibleNew: 3, newLimit: 0 });
    // Practice is still offered: it is the one thing this deck can do now.
    expect(blockOf(state)).toEqual({ study: 0, fallback: 'practice', ahead: 0, practice: 3, newDone: false });
  });

  it('every New card suspended: no "Today\'s new cards are done", and no Practice of nothing', () => {
    const state = germanDeck(LEVELS.slice(0, 3), () => cardInLifeV3('new', { suspended: true }), {
      settings: makeSettingsV3({ srs: { dailyNewLimit: 2 } }),
      person: makePersonV3({
        dayDone: { dayKey: dayKeyOf(FIXED_NOW), reviews: 0, neww: 2, checks: 0, newByDeck: { d1: 2 } },
      }),
    });
    expect(numbers(state)).toMatchObject({ ready: 0, practice: 0, eligibleNew: 0, newLeft: 0 });
    expect(blockOf(state)).toEqual({ study: 0, fallback: null, ahead: 0, practice: 0, newDone: false });
  });

  it('New cards only in a turned-off direction: no "Today\'s new cards are done"', () => {
    // Front → Back is Known; Back → Front is New, but turned off in this deck.
    const deck = makeDeckV3({ id: 'd1', options: { directions: { [REVERSE]: [0] } } });
    const groups = [0, 1].map((i) =>
      noteWithCards({
        deckId: 'd1',
        typeId: REVERSE,
        note: { id: `n${i}`, order: i },
        card: (ord) => lifeValues(ord === 0 ? 'known' : 'new'),
      }),
    );
    const person = makePersonV3({ dayDone: { dayKey: dayKeyOf(FIXED_NOW), reviews: 0, neww: 10, checks: 0, newByDeck: {} } });
    const state = stateOfV3({ decks: [deck], groups, overrides: { person } });
    expect(lifeCounts(state.cards)).toMatchObject({ new: 2, known: 2 });
    expect(numbers(state)).toMatchObject({ ready: 0, eligibleNew: 0, newLeft: 0 });
    expect(blockOf(state).newDone).toBe(false);
  });

  it('newCardsLeftToday: the smaller rest of the daily limit and the deck cap; another day = nothing done', () => {
    const deck = makeDeckV3({ id: 'd1' });
    const capped = makeDeckV3({ id: 'd1', options: { newPerDay: 5 } });
    const today = (neww: number, d1: number) => ({ dayKey: dayKeyOf(FIXED_NOW), neww, newByDeck: { d1 } });
    expect(newCardsLeftToday(deck, 10, today(10, 4), FIXED_NOW)).toBe(0);
    expect(newCardsLeftToday(deck, 10, today(3, 2), FIXED_NOW)).toBe(7);
    expect(newCardsLeftToday(capped, 10, today(3, 2), FIXED_NOW)).toBe(3);
    expect(newCardsLeftToday(capped, 10, today(9, 2), FIXED_NOW)).toBe(1);
    expect(newCardsLeftToday(capped, 10, { dayKey: '2000-01-01', neww: 10, newByDeck: { d1: 5 } }, FIXED_NOW)).toBe(5);
    expect(newCardsLeftToday(deck, 10, null, FIXED_NOW)).toBe(10);
    // A broken saved limit uses the default limit (like the scheduler), never 0.
    expect(newCardsLeftToday(deck, Number.NaN, null, FIXED_NOW)).toBe(10);
    expect(effectiveNewLimit({ newPerDay: 0 }, 10)).toBe(0);
  });

  it('reviews not due yet: "Study ahead · {n}" is the primary, and n is its session', () => {
    const state = germanDeck(LEVELS.slice(0, 2), () => cardInLifeV3('review'));
    const block = blockOf(state);
    expect(block.study).toBe(0);
    expect(block.fallback).toBe('ahead');
    expect(block.ahead).toBe(2);
    expect(block.newDone).toBe(false);
  });

  it('cards ready: "Study {n}" is the session it opens', () => {
    const state = germanDeck(LEVELS, () => cardInLifeV3('new'));
    const n = numbers(state);
    expect(n.ready).toBeGreaterThan(0);
    expect(n.ready).toBe(n.readyQueue);
    expect(studyBlock({ ...n, ahead: 0 }).fallback).toBeNull();
  });

  it('nothing at all: Choose what to learn when cards are Not started', () => {
    const { choosable } = numbers(germanDeck(LEVELS));
    expect(choosable).toBe(5);
    expect(studyBlock({ ready: 0, ahead: 0, practice: 0, choosable, eligibleNew: 0, newLimit: 10, newLeft: 10 })).toMatchObject({
      fallback: 'choose',
      newDone: false,
    });
  });

  it('Not started cards only in a turned-off direction: no "Choose what to learn" (triage has nothing to choose)', () => {
    // 'Back → Front' (ord 1) is off. Its cards are the only Not started ones;
    // the 'Front → Back' cards are Known (the learner chose every item).
    const deck = makeDeckV3({ id: 'd1', options: { directions: { [REVERSE]: [0] } } });
    const groups = [0, 1].map((i) =>
      noteWithCards({
        deckId: 'd1',
        typeId: REVERSE,
        note: { id: `n${i}`, order: i },
        card: (ord) => lifeValues(ord === 0 ? 'known' : 'notStarted'),
      }),
    );
    const state = stateOfV3({ decks: [deck], groups });
    const counts = lifeCounts(state.cards);
    // The legend still counts every card …
    expect(counts).toMatchObject({ notStarted: 2, known: 2 });
    // … but triage has nothing to choose, so nothing on the page sends the learner there.
    const ctx = matchCtxOf(state, FIXED_NOW);
    expect(triageItems(scopePool(state, notStartedScope(deckScope('d1')), ctx, 'browse'), triageLookupOf(state, ctx))).toEqual([]);
    const n = numbers(state);
    expect(n.choosable).toBe(0);
    expect(choosableCounts(scopePool(state, deckScope('d1'), ctx, 'browse'), triageLookupOf(state, ctx))).toEqual({
      cards: 0,
      items: 0,
      neverStudied: 0,
    });
    expect(deckPageMode(state.cards.length, counts, n.choosable)).toBe('normal');
    expect(blockOf(state).fallback).not.toBe('choose');
    // The same deck with both directions on: the 2 cards are choosable, the page asks.
    const both = { ...state, decks: [makeDeckV3({ id: 'd1' })] };
    expect(numbers(both).choosable).toBe(2);
    expect(deckPageMode(both.cards.length, counts, numbers(both).choosable)).toBe('nothingQueued');
  });

  it('"Today: 20 reviews + 10 new (limit 10 a day)"', () => {
    const ready = { total: 30, learning: 5, due: 15, checks: 0, neww: 10 };
    expect(todayLine(ready, 10)).toBe('Today: 20 reviews + 10 new (limit 10 a day)');
    expect(todayLine({ total: 3, learning: 0, due: 1, checks: 2, neww: 0 }, 10)).toBe('Today: 1 review + 2 checks');
    expect(todayLine({ total: 0, learning: 0, due: 0, checks: 0, neww: 0 }, 10)).toBeNull();
    expect(effectiveNewLimit({ newPerDay: 20 }, 10)).toBe(10);
    expect(effectiveNewLimit({ newPerDay: 5 }, 10)).toBe(5);
    expect(effectiveNewLimit({ newPerDay: null }, 10)).toBe(10);
  });
});

describe('Pause (real reducer): Today loses the deck, the deck page still studies it', () => {
  it('a paused deck is out of {} and in { decks: [id] }', () => {
    const state = germanDeck(LEVELS, () => cardInLifeV3('new'));
    const paused = reducer.updateDeck(state, { deckId: 'd1', patch: { active: false } }, testCtx()).state;
    const ctx = matchCtxOf(paused, FIXED_NOW);
    expect(readyFor(paused, {}, ctx).total).toBe(0);
    expect(readyFor(paused, deckScope('d1'), ctx).total).toBeGreaterThan(0);
    const back = reducer.updateDeck(paused, { deckId: 'd1', patch: { active: true } }, testCtx()).state;
    expect(readyFor(back, {}, matchCtxOf(back, FIXED_NOW)).total).toBeGreaterThan(0);
  });
});

describe('"Add the next {n} in order"', () => {
  it('the first items by DECK order, every enabled direction, never more than asked', () => {
    const deck = makeDeckV3({ id: 'd1' });
    const groups = [2, 0, 1].map((order) =>
      // lifeValues, not cardInLifeV3: the cards keep newPos = note.order (the deck order).
      noteWithCards({ deckId: 'd1', typeId: REVERSE, note: { id: `n${order}`, order }, card: () => lifeValues('notStarted') }),
    );
    const state = stateOfV3({ decks: [deck], groups });
    const ctx = matchCtxOf(state, FIXED_NOW);
    const ordered = sortScopeCards(scopePool(state, deckScope('d1'), ctx, 'browse'), { by: 'source' }, state, ctx);
    const next = nextInOrder(ordered, triageLookupOf(state, ctx), 2);
    expect(next.items).toBe(2);
    const noteIds = new Set(next.cardIds.map((id) => state.cards.find((c) => c.id === id)!.noteId));
    expect(Array.from(noteIds).sort()).toEqual(['n0', 'n1']);
    expect(next.cardIds).toHaveLength(4);
    expect(nextInOrder(ordered, triageLookupOf(state, ctx), 50).items).toBe(3);
    expect(nextInOrderLabel(50)).toBe('Add the next 50 in order');
    // Through the real reducer: those cards are New now, the third item is still Not started.
    const after = reducer.learn(state, { cardIds: next.cardIds }, testCtx()).state;
    expect(after.cards.filter((c) => c.noteId === 'n2').map(life)).toEqual(['notStarted', 'notStarted']);
    expect(after.cards.filter((c) => c.noteId !== 'n2').every((c) => life(c) === 'new')).toBe(true);
  });
});

describe('"By level" and "By section" bars', () => {
  const state = germanDeck(LEVELS, (i) => cardInLifeV3(i === 0 ? 'known' : i === 3 ? 'mastered' : 'notStarted'));
  const ctx = matchCtxOf(state, FIXED_NOW);
  const facets = deriveFacets(state.cards, deckScope('d1'), {}, ctx);

  it('one block per ordinal field group, rows in level order with status counts', () => {
    const blocks = barBlocks(state.cards, facets, ctx.index, state.decks[0]);
    const level = blocks.find((b) => b.key === 'field:level');
    expect(level?.group).toBe('Level');
    expect(level?.rows.map((r) => [r.label, r.total, r.known, r.mastered, r.notStarted])).toEqual([
      ['A1', 2, 1, 0, 1],
      ['A2', 1, 0, 0, 1],
      ['B1', 2, 0, 1, 1],
    ]);
    expect(rowMenuCounts(level!.rows[0])).toEqual({ learnAll: 1, markKnown: 1 });
  });

  it('a value row opens the deck with that value as a chip', () => {
    expect(valueScope('d1', 'field:level', 'b1')).toEqual({ decks: ['d1'], fields: { level: ['b1'] } });
    const q = valueScope('d1', 'field:level', 'a1');
    const cards = scopePool(state, q, ctx, 'browse');
    expect(cards).toHaveLength(2);
    expect(rowCardIds(cards, 'learnAll', triageLookupOf(state, ctx))).toHaveLength(1);
    expect(rowCardIds(cards, 'markKnown', triageLookupOf(state, ctx))).toHaveLength(1);
  });

  it('a turned-off direction: the bar counts its cards, "Learn all" and "Mark all as known" leave them as they are', () => {
    // Two A1 items of a two-direction card type; Back → Front is turned off.
    const deck = makeDeckV3({ id: 'd1', options: { directions: { [REVERSE]: [0] } } });
    const groups = [0, 1].map((i) =>
      noteWithCards({
        deckId: 'd1',
        typeId: REVERSE,
        note: { id: `n${i}`, order: i, section: 'Vocabulary' },
        card: () => lifeValues('notStarted'),
      }),
    );
    const two = stateOfV3({ decks: [deck], groups: [...groups, noteWithCards({ deckId: 'd1', typeId: REVERSE, note: { id: 'n2', section: 'Verbs' } })] });
    const tctx = matchCtxOf(two, FIXED_NOW);
    const blocks = barBlocks(two.cards, deriveFacets(two.cards, deckScope('d1'), {}, tctx), tctx.index, two.decks[0]);
    const vocab = blocks.find((b) => b.key === 'section')!.rows.find((r) => r.label === 'Vocabulary')!;
    // The bar: every card of the value (4), like the header and Browse.
    expect([vocab.total, vocab.notStarted]).toEqual([4, 4]);
    // The menu: only the 2 cards of the direction that is on.
    expect(rowMenuCounts(vocab)).toEqual({ learnAll: 2, markKnown: 2 });
    const cards = scopePool(two, valueScope('d1', 'section', vocab.value), tctx, 'browse');
    const lookup = triageLookupOf(two, tctx);
    const learnIds = rowCardIds(cards, 'learnAll', lookup);
    const knownIds = rowCardIds(cards, 'markKnown', lookup);
    expect(learnIds).toHaveLength(rowMenuCounts(vocab).learnAll);
    expect(knownIds).toHaveLength(rowMenuCounts(vocab).markKnown);
    const ordOf = (id: string) => two.cards.find((c) => c.id === id)!.ord;
    expect(learnIds.map(ordOf)).toEqual([0, 0]);
    expect(knownIds.map(ordOf)).toEqual([0, 0]);
    // Through the real reducer: the off direction stays Not started, so it comes back as it was.
    const after = reducer.learn(two, { cardIds: learnIds }, testCtx()).state;
    const vocabCards = after.cards.filter((c) => c.noteId !== 'n2');
    expect(vocabCards.filter((c) => c.ord === 0).map(life)).toEqual(['new', 'new']);
    expect(vocabCards.filter((c) => c.ord === 1).map(life)).toEqual(['notStarted', 'notStarted']);
  });

  it('the section tree: level 1 rows hold their children', () => {
    // Without the Level field the section split is not hidden behind it (equivalence collapse).
    const plain = stateOfV3({
      decks: [makeDeckV3({ id: 'd1' })],
      groups: ['Vocabulary::A1', 'Vocabulary::A2', 'Verbs'].map((section, i) =>
        noteWithCards({ deckId: 'd1', note: { id: `p${i}`, section }, card: () => cardInLifeV3('new') }),
      ),
    });
    const pctx = matchCtxOf(plain, FIXED_NOW);
    const blocks = barBlocks(plain.cards, deriveFacets(plain.cards, deckScope('d1'), {}, pctx), pctx.index, plain.decks[0]);
    const section = blocks.find((b) => b.key === 'section')!;
    const vocab = section.rows.find((r) => r.label === 'Vocabulary')!;
    expect(vocab.total).toBe(2);
    expect(vocab.children.map((r) => [r.label, r.total])).toEqual([
      ['A1', 1],
      ['A2', 1],
    ]);
    const q = valueScope('d1', 'section', vocab.value);
    expect(scopePool(plain, q, pctx, 'browse')).toHaveLength(2);
  });
});

/* ======================================================================= wave 5b: the walkthrough fixes */

describe('wave 5b — the header always names the file (walkthrough L15)', () => {
  it('a nameless import key names NO file: its name is made up from the root deck; a document id is no name', () => {
    expect(sourceKeyFileName('file:German_Complete.apkg')).toBe('German_Complete.apkg');
    expect(madeUpKeyName('file:German_Complete.apkg')).toBeNull();
    // The key of a file the picker gave no name for: the ROOT DECK's name + a content hash
    // (importApkg.ts). The real file is "Algo_Patterns.apkg", so the header must not say
    // "Imported from Algo Deck.apkg" (review round 2 of L15).
    const algoKey = namelessSourceKey(fallbackFileName('apkg', 'Algo Deck'), 'guid-1\nguid-2');
    expect(algoKey).toMatch(/^file:Algo Deck\.apkg#[0-9a-z]+$/);
    expect(madeUpKeyName(algoKey)).toBe('Algo Deck.apkg');
    expect(sourceKeyFileName(algoKey)).toBeNull();
    // Wave 5d (P3): the nameless key IS the deck's own origin, so its items are never read for
    // a file name (before: true, and items of a later import could relabel the deck).
    expect(needsNoteSourceFile({ source: 'apkg', sourceKey: algoKey })).toBe(false);
    expect(deckSourceLine({ source: 'apkg', sourceKey: algoKey })).toBe('Imported');
    // An Anki export whose root deck is "Default": never "Imported from Default.apkg".
    const defaultKey = namelessSourceKey(fallbackFileName('apkg', 'Default'), 'guid-9');
    expect(deckSourceLine({ source: 'apkg', sourceKey: defaultKey })).toBe('Imported');
    // The CSV of a nameless file follows the same rule.
    const csvKey = namelessSourceKey(fallbackFileName('csv', ''), 'Word,Translation');
    expect(madeUpKeyName(csvKey)).toBe('Imported deck.csv');
    expect(deckSourceLine({ source: 'csv', sourceKey: csvKey })).toBe('Imported');
    // A real name with a '#' inside is still a real name (the hash rule needs '#<hash>' at the END).
    expect(sourceKeyFileName('file:C# basics.apkg')).toBe('C# basics.apkg');
    expect(madeUpKeyName('file:C# basics.apkg')).toBeNull();
    expect(sourceKeyFileName('file:primary:Download/German.apkg')).toBe('German.apkg');
    expect(sourceKeyFileName('file:msf:96')).toBeNull();
    expect(sourceKeyFileName('ankiweb:1104981491')).toBeNull();
    expect(sourceKeyFileName(undefined)).toBeNull();
    // The made-up names of a file with no name AND no deck name name no real file.
    expect(realFileName(fallbackFileName('csv', ''))).toBeNull();
    expect(realFileName(fallbackFileName('apkg', ''))).toBeNull();
    expect(realFileName('msf:96')).toBeNull();
    expect(realFileName(null)).toBeNull();
  });

  it('an old "file:msf:96" deck: the file most of its items came from, else just "Imported"', () => {
    const deck = makeDeckV3({ id: 'd1', name: 'German', source: 'apkg', sourceKey: 'file:msf:96' });
    const refs = ['German_Complete.apkg', 'German_Complete.apkg', 'msf:96', 'Other.apkg'];
    const groups = refs.map((ref, i) =>
      noteWithCards({ deckId: 'd1', typeId: REVERSE, note: { id: `n${i}`, order: i, source: { kind: 'apkg', ref } } }),
    );
    const state = stateOfV3({ decks: [deck], groups });
    const index = libraryIndexOf(state);
    expect(needsNoteSourceFile(deck)).toBe(true);
    // Each item counts once (its two directions are one item); a document id is skipped.
    expect(noteSourceFile(state.cards, index)).toBe('German_Complete.apkg');
    expect(deckSourceLine(deck, noteSourceFile(state.cards, index))).toBe('Imported from German_Complete.apkg');
    // No item names a file either: "Imported" (never the old "Imported from a file").
    const bare = stateOfV3({
      decks: [deck],
      groups: [noteWithCards({ deckId: 'd1', note: { id: 'b0', source: { kind: 'apkg', ref: 'msf:96' } } })],
    });
    expect(noteSourceFile(bare.cards, libraryIndexOf(bare))).toBeNull();
    expect(deckSourceLine(deck, null)).toBe('Imported');
    // Only such a deck looks at its items.
    expect(needsNoteSourceFile({ source: 'apkg', sourceKey: 'file:German.apkg' })).toBe(false);
    expect(needsNoteSourceFile({ source: 'pack', sourceKey: 'pack:german:vocabulary' })).toBe(false);
    expect(needsNoteSourceFile({ source: 'ankiweb', sourceKey: 'ankiweb:1' })).toBe(false);
    expect(needsNoteSourceFile({ source: 'manual' })).toBe(false);
    // A deck made in the app says nothing, even with a stray file name.
    expect(deckSourceLine({ source: 'manual' }, 'German.apkg')).toBeNull();
  });

  it('a tie keeps the file of the FIRST item (every file is counted first, then the largest picked)', () => {
    const deck = makeDeckV3({ id: 'd1', name: 'German', source: 'apkg', sourceKey: 'file:msf:96' });
    const fileOf = (refs: string[]) => {
      const state = stateOfV3({
        decks: [deck],
        groups: refs.map((ref, i) => noteWithCards({ deckId: 'd1', note: { id: `n${i}`, order: i, source: { kind: 'apkg', ref } } })),
      });
      return noteSourceFile(state.cards, libraryIndexOf(state));
    };
    // 2 items each, and A came first → A. (The old loop said B: B reached 2 items first.)
    expect(fileOf(['A.apkg', 'B.apkg', 'B.apkg', 'A.apkg'])).toBe('A.apkg');
    expect(fileOf(['B.apkg', 'A.apkg', 'A.apkg', 'B.apkg'])).toBe('B.apkg');
    // More items always win, wherever they are.
    expect(fileOf(['A.apkg', 'B.apkg', 'B.apkg'])).toBe('B.apkg');
    // Review round 2: items with no real name count too, as one "unnamed" group. A tie with
    // that group names no file (before, the 1 named item named the whole deck).
    expect(fileOf(['msf:96', 'A.apkg'])).toBeNull();
    expect(fileOf(['msf:96', 'A.apkg', 'A.apkg'])).toBe('A.apkg');
  });

  it('a small later import never names a big deck whose own file had no name (review round 2)', () => {
    const fileOf = (deck: Deck, groups: ReturnType<typeof noteWithCards>[]) => {
      const state = stateOfV3({ decks: [deck], groups });
      return noteSourceFile(state.cards, libraryIndexOf(state), deck.sourceKey);
    };
    const item = (i: number, source: Note['source']) =>
      noteWithCards({ deckId: 'd1', typeId: REVERSE, note: { id: `n${i}`, order: i, source } });
    // An old deck: 60 items from "msf:96", then "Import more into this deck" with 10 items from Extra.csv.
    const old = makeDeckV3({ id: 'd1', name: 'German', source: 'apkg', sourceKey: 'file:msf:96' });
    const oldGroups = [
      ...Array.from({ length: 60 }, (_, i) => item(i, { kind: 'apkg', ref: 'msf:96' })),
      ...Array.from({ length: 10 }, (_, i) => item(60 + i, { kind: 'csv', ref: 'Extra.csv' })),
    ];
    expect(fileOf(old, oldGroups)).toBeNull();
    expect(deckSourceLine(old, fileOf(old, oldGroups))).toBe('Imported');

    // A nameless deck: its items carry the made-up name of its key. That name is no file name.
    const madeUp = fallbackFileName('apkg', 'Algo Deck');
    const nameless = makeDeckV3({ id: 'd1', name: 'Algo', source: 'apkg', sourceKey: namelessSourceKey(madeUp, 'g') });
    const algo = Array.from({ length: 30 }, (_, i) => item(i, { kind: 'apkg', ref: madeUp }));
    expect(fileOf(nameless, algo)).toBeNull();
    // … also with a few items of a real file (3 < 30).
    const withExtra = [...algo, ...Array.from({ length: 3 }, (_, i) => item(30 + i, { kind: 'csv', ref: 'Extra.csv' }))];
    expect(fileOf(nameless, withExtra)).toBeNull();
    // Without the deck's key, the made-up name would look real: the key is what tells them apart.
    const state = stateOfV3({ decks: [nameless], groups: algo });
    expect(noteSourceFile(state.cards, libraryIndexOf(state))).toBe(madeUp);

    // Items that did not come from a file (typed in the app) say nothing about the file.
    const typed = [
      item(0, { kind: 'apkg', ref: 'German.apkg' }),
      ...Array.from({ length: 5 }, (_, i) => item(1 + i, { kind: 'manual' })),
    ];
    expect(fileOf(old, typed)).toBe('German.apkg');
  });
});

describe('wave 5d (P3) — a key that already names the deck’s file is never relabelled from the items', () => {
  const item = (i: number, ref: string) =>
    noteWithCards({ deckId: 'd1', typeId: REVERSE, note: { id: `n${i}`, order: i, source: { kind: 'apkg', ref } } });
  /** The header line the deck page shows: noteSourceFile is asked only when needsNoteSourceFile says so ([id].tsx). */
  const headerOf = (deck: Deck, groups: ReturnType<typeof item>[]) => {
    const state = stateOfV3({ decks: [deck], groups });
    const noteFile = needsNoteSourceFile(deck) ? noteSourceFile(state.cards, libraryIndexOf(state), deck.sourceKey) : null;
    return deckSourceLine(deck, noteFile);
  };
  /** The probe: 10 items of the deck's own file (German.apkg), then 20 items "Import more" added from Spanish.apkg. */
  const probe = [
    ...Array.from({ length: 10 }, (_, i) => item(i, 'German.apkg')),
    ...Array.from({ length: 20 }, (_, i) => item(10 + i, 'Spanish.apkg')),
  ];

  it('the probe: a nameless key "file:German.apkg#h1" with 10 German + 20 Spanish items says "Imported", never "Imported from Spanish.apkg"', () => {
    const deck = makeDeckV3({ id: 'd1', name: 'German', source: 'apkg', sourceKey: 'file:German.apkg#h1' });
    expect(madeUpKeyName(deck.sourceKey)).toBe('German.apkg');
    expect(needsNoteSourceFile(deck)).toBe(false);
    expect(headerOf(deck, probe)).toBe('Imported');
    // Even a caller that passes the items' file anyway cannot relabel it.
    expect(deckSourceLine(deck, 'Spanish.apkg')).toBe('Imported');
  });

  it('a real name in the key wins over any items; only a key that names NOTHING reads the items', () => {
    const named = makeDeckV3({ id: 'd1', name: 'German', source: 'apkg', sourceKey: 'file:German.apkg' });
    expect(needsNoteSourceFile(named)).toBe(false);
    expect(headerOf(named, probe)).toBe('Imported from German.apkg');
    expect(deckSourceLine(named, 'Spanish.apkg')).toBe('Imported from German.apkg');
    // An old document-id key says nothing about the file: the items decide (most items win).
    const old = makeDeckV3({ id: 'd1', name: 'German', source: 'apkg', sourceKey: 'file:msf:96' });
    expect(needsNoteSourceFile(old)).toBe(true);
    expect(headerOf(old, probe)).toBe('Imported from Spanish.apkg');
    // A file deck with no key at all: the same.
    const keyless = makeDeckV3({ id: 'd1', name: 'German', source: 'apkg' });
    expect(needsNoteSourceFile(keyless)).toBe(true);
    expect(headerOf(keyless, probe)).toBe('Imported from Spanish.apkg');
  });
});

describe('wave 5g (E8) — the header names a newer file imported into the deck, after the deck’s own file', () => {
  const item = (i: number, ref: string, createdAt: number, kind: 'apkg' | 'csv' | 'manual' = 'apkg') =>
    noteWithCards({ deckId: 'd1', typeId: REVERSE, note: { id: `n${i}`, order: i, createdAt, source: { kind, ref } } });
  /** The header line exactly as the deck page builds it ([id].tsx). */
  const headerOf = (deck: Deck, groups: ReturnType<typeof item>[]) => {
    const state = stateOfV3({ decks: [deck], groups });
    const index = libraryIndexOf(state);
    const noteFile = needsNoteSourceFile(deck) ? noteSourceFile(state.cards, index, deck.sourceKey) : null;
    const others = otherSourceFiles(state.cards, index, deckFileName(deck, noteFile), deck.sourceKey);
    return deckSourceLine(deck, noteFile, others);
  };
  const v1Deck = makeDeckV3({ id: 'd1', name: 'German Vocabulary', source: 'apkg', sourceKey: 'file:German_Vocabulary_v1.apkg' });
  /** The walkthrough in small: 6 items of v1 (updated by v4, their ref stays v1), then 2 items that v4 added. */
  const v1v4 = [
    ...Array.from({ length: 6 }, (_, i) => item(i, 'German_Vocabulary_v1.apkg', 100)),
    ...Array.from({ length: 2 }, (_, i) => item(6 + i, 'German_Vocabulary_v4.apkg', 200)),
  ];

  it('v1 deck + items v4 added: "Imported from German_Vocabulary_v1.apkg and German_Vocabulary_v4.apkg"', () => {
    expect(headerOf(v1Deck, v1v4)).toBe('Imported from German_Vocabulary_v1.apkg and German_Vocabulary_v4.apkg');
    // Only the deck's own file: unchanged.
    expect(headerOf(v1Deck, v1v4.slice(0, 6))).toBe('Imported from German_Vocabulary_v1.apkg');
  });

  it('the deck’s own file always stays first; the NEWEST other file follows, the rest are counted', () => {
    const groups = [
      item(0, 'German_Vocabulary_v1.apkg', 100),
      item(1, 'B.apkg', 300),
      item(2, 'C.csv', 200, 'csv'),
      item(3, 'D.apkg', 300), // the same time as B: the file seen first (B) stays
    ];
    expect(headerOf(v1Deck, groups)).toBe('Imported from German_Vocabulary_v1.apkg, B.apkg and 2 other files');
    expect(headerOf(v1Deck, groups.slice(0, 3))).toBe('Imported from German_Vocabulary_v1.apkg, B.apkg and 1 other file');
    const index = libraryIndexOf(stateOfV3({ decks: [v1Deck], groups }));
    const cards = groups.flatMap((g) => g.cards);
    expect(otherSourceFiles(cards, index, 'German_Vocabulary_v1.apkg')).toEqual({ newest: 'B.apkg', more: 2 });
  });

  it('never a file without a real name; items typed in the app say nothing', () => {
    const groups = [
      item(0, 'German_Vocabulary_v1.apkg', 100),
      item(1, 'msf:96', 300),
      item(2, 'Imported deck.csv', 300, 'csv'),
      item(3, '', 400, 'manual'),
    ];
    expect(headerOf(v1Deck, groups)).toBe('Imported from German_Vocabulary_v1.apkg');
  });

  it('P3 still holds: a nameless key says "Imported", and its items never add a file to it', () => {
    const nameless = makeDeckV3({ id: 'd1', name: 'German', source: 'apkg', sourceKey: 'file:German.apkg#h1' });
    expect(deckFileName(nameless, 'Spanish.apkg')).toBeNull();
    expect(headerOf(nameless, [item(0, 'German.apkg', 100), item(1, 'Spanish.apkg', 200)])).toBe('Imported');
    expect(deckSourceLine(nameless, null, { newest: 'Spanish.apkg', more: 0 })).toBe('Imported');
    // The items' file of an old key is the deck's file; another file follows it.
    const old = makeDeckV3({ id: 'd1', name: 'German', source: 'apkg', sourceKey: 'file:msf:96' });
    expect(
      headerOf(old, [item(0, 'German.apkg', 100), item(1, 'German.apkg', 100), item(2, 'Spanish.apkg', 200)]),
    ).toBe('Imported from German.apkg and Spanish.apkg');
    // AnkiWeb and starter decks keep their own words.
    expect(deckSourceLine({ source: 'ankiweb', sourceKey: 'ankiweb:1' }, null, { newest: 'x.apkg', more: 0 })).toBe(
      'Imported from AnkiWeb',
    );
    expect(deckSourceLine({ source: 'pack', sourceKey: 'pack:german:vocab' }, null, { newest: 'x.apkg', more: 0 })).toBe(
      'Starter deck',
    );
  });

  it('the deck page shows it (render)', () => {
    const r = renderPage(stateOfV3({ decks: [v1Deck], groups: v1v4 }));
    expect(texts(r)).toContain('16 cards · Imported from German_Vocabulary_v1.apkg and German_Vocabulary_v4.apkg');
  });
});

describe('wave 5b — one counting language in the choose flow (walkthrough M6)', () => {
  it('the line says cards AND items when they differ; the button names its items', () => {
    expect(chooseLine(12, 6)).toBe('12 cards (6 items) are not started yet.');
    expect(chooseLine(2, 1)).toBe('2 cards (1 item) are not started yet.');
    expect(chooseLine(6, 6)).toBe('6 cards are not started yet.');
    expect(chooseLine(1, 1)).toBe('1 card is not started yet.');
    expect(nextInOrderLabel(6, true)).toBe('Add the next 6 items in order');
    expect(nextInOrderLabel(1, true)).toBe('Add the next 1 item in order');
    expect(nextInOrderLabel(6)).toBe('Add the next 6 in order');
    expect(nextInOrderSnack(12, 6)).toBe('12 cards (6 items) added to your queue');
    expect(nextInOrderSnack(6, 6)).toBe('6 cards added to your queue');
    expect(chooseNamesItems({ cards: 12, items: 6 })).toBe(true);
    expect(chooseNamesItems({ cards: 6, items: 6 })).toBe(false);
  });

  it('the deck page block, its buttons and the triage count the SAME items (the walkthrough deck)', () => {
    // 6 items with both directions Not started (12 cards), and 1 item already New.
    const deck = makeDeckV3({ id: 'd1', name: 'German' });
    const groups = Array.from({ length: 7 }, (_, i) =>
      noteWithCards({ deckId: 'd1', typeId: REVERSE, note: { id: `n${i}`, order: i }, card: () => lifeValues(i === 0 ? 'new' : 'notStarted') }),
    );
    const state = stateOfV3({ decks: [deck], groups });
    const ctx = matchCtxOf(state, FIXED_NOW);
    const lookup = triageLookupOf(state, ctx);
    const pool = scopePool(state, deckScope('d1'), ctx, 'browse');
    const choosable = choosableCounts(pool, lookup);
    expect(choosable).toMatchObject({ cards: 12, items: 6 });

    // The deck page: the line, the button and its snackbar.
    const next = Math.min(NEXT_IN_ORDER.normal, choosable.items);
    expect(chooseLine(choosable.cards, choosable.items)).toBe('12 cards (6 items) are not started yet.');
    expect(nextInOrderLabel(next, chooseNamesItems(choosable))).toBe('Add the next 6 items in order');
    const added = nextInOrder(sortScopeCards(pool, { by: 'source' }, state, ctx), lookup, next);
    expect([added.items, added.cardIds.length]).toEqual([6, 12]);
    expect(nextInOrderSnack(added.cardIds.length, added.items)).toBe('12 cards (6 items) added to your queue');

    // "Choose what to learn" opens the triage over the same scope: the same 6 items.
    const triagePool = sortScopeCards(scopePool(state, notStartedScope(deckScope('d1')), ctx, 'browse'), { by: 'source' }, state, ctx);
    let run = startRun(triageItems(triagePool, lookup));
    expect([run.total, run.cards]).toEqual([choosable.items, choosable.cards]);
    expect(positionLabel(run)).toBe('0 / 6 items');
    // The bulk buttons name the unit too (review round 2): "6 items", like "Add the next 6 items".
    expect(bulkLabels(run)).toEqual({ learn: 'Learn all 6 items left', known: 'Mark all 6 items known' });
    run = chooseAll(run, 'learnAll', 'edit-1');
    expect(doneCopy(run, { perDay: 10, random: false }).title).toBe('Done — 12 cards (6 items) added to your queue.');
  });

  it('one card per item: the plain words stay ("3 cards", "Add the next 3 in order", "0 / 3")', () => {
    const deck = makeDeckV3({ id: 'd1' });
    const groups = [0, 1, 2].map((i) =>
      noteWithCards({ deckId: 'd1', note: { id: `b${i}`, order: i }, card: () => lifeValues('notStarted') }),
    );
    const state = stateOfV3({ decks: [deck], groups });
    const ctx = matchCtxOf(state, FIXED_NOW);
    const lookup = triageLookupOf(state, ctx);
    const choosable = choosableCounts(scopePool(state, deckScope('d1'), ctx, 'browse'), lookup);
    expect(choosable).toMatchObject({ cards: 3, items: 3 });
    expect(chooseLine(choosable.cards, choosable.items)).toBe('3 cards are not started yet.');
    expect(nextInOrderLabel(3, chooseNamesItems(choosable))).toBe('Add the next 3 in order');
    const run = startRun(triageItems(scopePool(state, notStartedScope(deckScope('d1')), ctx, 'browse'), lookup));
    expect(positionLabel(run)).toBe('0 / 3');
    // The spec §8.5 words of the bulk buttons, with no noun.
    expect(bulkLabels(run)).toEqual({ learn: 'Learn all 3 left', known: 'Mark all 3 known' });
  });

  it('the row menu counts ITEMS like the triage: "Learn all 2 items" here = "Learn all 2 items left" there', () => {
    const state = bothWaysDeck(() => lifeValues('notStarted'));
    const ctx = matchCtxOf(state, FIXED_NOW);
    const lookup = triageLookupOf(state, ctx);
    const blocks = barBlocks(state.cards, deriveFacets(state.cards, deckScope('d1'), {}, ctx), ctx.index, state.decks[0]);
    const a1 = blocks.find((b) => b.key === 'field:level')!.rows[0];
    expect(a1.label).toBe('A1');
    // The bar counts cards (4); the menu counts the items of the cards it changes (2).
    expect([a1.total, a1.learnable, a1.learnableItems, a1.markable, a1.markableItems]).toEqual([4, 4, 2, 4, 2]);
    expect(rowMenuCounts(a1)).toEqual({ learnAll: 2, markKnown: 2 });
    expect(rowMenuLabels(a1)).toEqual({ learnAll: 'Learn all 2 items', markKnown: 'Mark all 2 items as known' });

    // The cards "Learn all" changes, and their items.
    const q = valueScope('d1', 'field:level', a1.value);
    const ids = rowCardIds(scopePool(state, q, ctx, 'browse'), 'learnAll', lookup);
    expect([ids.length, itemCount(ids, lookup.cardById)]).toEqual([a1.learnable, a1.learnableItems]);

    // The triage over the same value: the same 2 items, in the same words.
    const run = startRun(triageItems(scopePool(state, notStartedScope(q), ctx, 'browse'), lookup));
    expect(positionLabel(run)).toBe('0 / 2 items');
    // Review round 2: the bulk buttons name the unit like the row menu ("2 items").
    expect(bulkLabels(run)).toEqual({ learn: 'Learn all 2 items left', known: 'Mark all 2 items known' });
    const left = leftItems(run);
    expect(rowMenuSnack('learnAll', ids.length, itemCount(ids, lookup.cardById))).toBe(
      stepSnack('learnAll', cardIdsOf(left).length, left.length),
    );
    expect(rowMenuSnack('learnAll', 4, 2)).toBe('4 cards (2 items) added to your queue');
    expect(rowMenuSnack('markKnown', 4, 2)).toBe(stepSnack('knownAll', 4, 2));
    expect(rowMenuSnack('markKnown', 580, 290)).toBe('580 cards (290 items) marked as known');
  });

  it('row menu labels: plain words when every item is one card; one menu never mixes the two forms', () => {
    // Only German → English is on: one card per item in the menu → the spec's plain words.
    const oneWay = bothWaysDeck(() => lifeValues('notStarted'), { directions: { [BOTH_WAYS.id]: [0] } });
    let ctx = matchCtxOf(oneWay, FIXED_NOW);
    let a1 = barBlocks(oneWay.cards, deriveFacets(oneWay.cards, deckScope('d1'), {}, ctx), ctx.index, oneWay.decks[0])[0].rows[0];
    expect(rowMenuLabels(a1)).toEqual({ learnAll: 'Learn all 2', markKnown: 'Mark all 2 as known' });
    // German → English Not started, English → German New: "Learn all" is 2 cards of 2 items,
    // "Mark all as known" 4 cards of 2 items → both labels name their items.
    const mixed = bothWaysDeck((_, ord) => lifeValues(ord === 0 ? 'notStarted' : 'new'));
    ctx = matchCtxOf(mixed, FIXED_NOW);
    a1 = barBlocks(mixed.cards, deriveFacets(mixed.cards, deckScope('d1'), {}, ctx), ctx.index, mixed.decks[0])[0].rows[0];
    expect(rowMenuLabels(a1)).toEqual({ learnAll: 'Learn all 2 items', markKnown: 'Mark all 2 items as known' });
    // Nothing to learn: that row is hidden (null).
    const known = bothWaysDeck(() => lifeValues('known'));
    ctx = matchCtxOf(known, FIXED_NOW);
    a1 = barBlocks(known.cards, deriveFacets(known.cards, deckScope('d1'), {}, ctx), ctx.index, known.decks[0])[0].rows[0];
    expect(rowMenuLabels(a1)).toEqual({ learnAll: null, markKnown: null });
  });

  it('"Where do you start?" says what the triage says: "6 cards (3 items) marked as known"', () => {
    expect(placementSnack('known', 580, 290)).toBe(stepSnack('place', 580, 290));
    expect(placementSnack('known', 580, 290)).toBe('580 cards (290 items) marked as known');
    expect(placementSnack('notStarted', 4, 2)).toBe('4 cards (2 items) moved back to Not started');
    // One card per item: the plain words.
    expect(placementSnack('known', 3, 3)).toBe('3 cards marked as known');
    expect(placementSnack('notStarted', 1, 1)).toBe('1 card moved back to Not started');
    // itemCount: each item once, however many of its directions; unknown ids are not counted.
    const state = bothWaysDeck(() => lifeValues('notStarted'));
    const { cardById } = triageLookupOf(state, matchCtxOf(state, FIXED_NOW));
    const n0 = state.cards.filter((c) => c.noteId === 'n0').map((c) => c.id);
    const n1 = state.cards.filter((c) => c.noteId === 'n1').map((c) => c.id);
    expect(itemCount([...n0, n1[0], 'gone'], cardById)).toBe(2);
    expect(itemCount([], cardById)).toBe(0);
  });
});

describe('wave 5b — a mode picked in "More ways to study" is for the next session only (walkthrough M4)', () => {
  it('pick → the next session gets it → used up; the default mode is no pick', () => {
    expect(pickNextMode('mc', 'flash')).toBe('mc');
    expect(pickNextMode('flash', 'flash')).toBeNull();
    expect(launchMode('mc')).toEqual({ mode: 'mc', next: null });
    expect(launchMode(null)).toEqual({ mode: null, next: null });
    // A way row with its own mode ("Practice articles") uses the pick up too.
    expect(launchMode('mc', 'article')).toEqual({ mode: 'article', next: null });
    expect(nextModeLine('mc', 'flash')).toBe('Next session: Quiz');
    expect(nextModeLine('type', 'flash')).toBe('Next session: Typing');
    expect(nextModeLine(null, 'flash')).toBeNull();
    expect(nextModeLine('flash', 'flash')).toBeNull();
    // The sheet's words on the deck page say the same; the session keeps its own.
    expect(MODE_SCOPE_COPY_DECK).toBe('Only for the next session you start here. Your default mode is in Settings.');
    expect(MODE_SCOPE_COPY).toBe('Only for this session. Your default mode is in Settings.');
  });
});

describe('wave 5b — "Practice your hardest" and "By section" (walkthrough M7)', () => {
  it('"Practice your hardest" is the practice pool, hardest first — the same session as Complete\'s row', () => {
    expect(hardestSession('d1')).toEqual(hardestParams(deckScope('d1')));
    expect(hardestSession('d1')).toEqual({ kind: 'practice', q: { decks: ['d1'] }, sort: { by: 'hardest' } });
    // The walkthrough deck: 2 Learning cards, the rest New. No card is "Hard" (ease ≤ 2.2) yet,
    // so the old scope ({ hard: true }) had no card and the row was hidden.
    const state = germanDeck(LEVELS, (i) => cardInLifeV3(i < 2 ? 'learning' : 'new'));
    const ctx = matchCtxOf(state, FIXED_NOW);
    expect(buildSessionQueue({ kind: 'practice', q: { decks: ['d1'], hard: true } }, state, ctx)).toHaveLength(0);
    expect(buildSessionQueue(hardestSession('d1'), state, ctx)).toHaveLength(LEVELS.length);
  });

  it('its count IS the "Practice all" count: the same pool, the sort only changes the order (the page reads it once)', () => {
    // Known, Not started and suspended cards are left out of both; the session size cuts both.
    const kinds = ['review', 'learning', 'known', 'notStarted', 'new'] as const;
    const state = germanDeck(LEVELS, (i) => ({
      ...cardInLifeV3(kinds[i]),
      ease: 3 - i * 0.3,
      lapses: i,
      suspended: i === 4,
    }));
    const practice = { kind: 'practice' as const, q: deckScope('d1') };
    for (const sessionLimit of [50, 1]) {
      const capped = { ...state, settings: { ...state.settings, sessionLimit } };
      const ctx = matchCtxOf(capped, FIXED_NOW);
      const all = buildSessionQueue(practice, capped, ctx);
      const hardest = buildSessionQueue(hardestSession('d1'), capped, ctx);
      expect(hardest).toHaveLength(all.length);
      expect(all.length).toBe(sessionLimit === 1 ? 1 : 2);
    }
  });

  it('Algo: Category == the sections hides the Section FILTER, but the deck page still shows "By section"', () => {
    const state = algoState();
    const ctx = matchCtxOf(state, FIXED_NOW);
    const facets = deriveFacets(state.cards, deckScope('d1'), {}, ctx);
    // The Library's filter groups: only Category (equivalence collapse), and it is no level.
    expect(facets.some((f) => f.key === 'section')).toBe(false);
    expect(facets.find((f) => f.key === 'field:category')?.ordinal).toBeNull();
    expect(sectionCount(state.cards, ctx.index)).toBe(3);
    const blocks = barBlocks(state.cards, facets, ctx.index, state.decks[0]);
    expect(blocks.map((b) => b.key)).toEqual(['section']);
    expect(blocks[0].group).toBe('Section');
    expect(blocks[0].rows.map((r) => [r.label, r.total, r.neww])).toEqual([
      ['Core Patterns', 2, 2],
      ['Advanced Patterns', 1, 1],
      ['Dynamic Programming', 1, 1],
    ]);
    // A row opens the same cards as the Library's section chip.
    expect(scopePool(state, valueScope('d1', 'section', blocks[0].rows[0].value), ctx, 'browse')).toHaveLength(2);
  });

  it('Spanish: Level == the sections — "By level" already shows that split, so no second "By section"', () => {
    const state = germanDeck(LEVELS.map((w) => ({ ...w, section: w.level })));
    const ctx = matchCtxOf(state, FIXED_NOW);
    expect(splitsLikeSections(state.cards, ctx.index, 'level')).toBe(true);
    const blocks = barBlocks(state.cards, deriveFacets(state.cards, deckScope('d1'), {}, ctx), ctx.index, state.decks[0]);
    expect(blocks.map((b) => b.key)).toEqual(['field:level']);
  });

  it('items with NO level are exactly the section "Misc": "By section" stays (the facet engine\'s rule 2)', () => {
    // Category == the sections (so the facet engine hides the Section group behind it), and
    // an ordinal Level that is also equal to the sections — except that the "Misc" items have no Level.
    const TYPE: NoteType = {
      id: 'nt-topics',
      name: 'Topics',
      kind: 'standard',
      fields: [
        { name: 'Front', role: 'term', facet: 'off' },
        { name: 'Back', role: 'meaning', facet: 'off' },
        { name: 'Category', role: 'detail', facet: 'on' },
        { name: 'Level', role: 'badge', facet: 'on' },
      ],
      templates: [{ ord: 0, name: 'Card 1', prompt: [0], answer: [1, 2, 3] }],
      sortField: 0,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    };
    const stateWith = (miscLevel: string) =>
      stateOfV3({
        decks: [makeDeckV3({ id: 'd1', name: 'Topics' })],
        types: [TYPE],
        groups: [
          ['Basics', 'A1'],
          ['Basics', 'A1'],
          ['Travel', 'A2'],
          ['Work', 'B1'],
          ['Misc', miscLevel],
        ].map(([section, level], i) =>
          noteWithCards(
            { deckId: 'd1', typeId: TYPE.id, fields: [`q${i}`, `a${i}`, section, level], note: { id: `t${i}`, order: i, section } },
            [TYPE],
          ),
        ),
      });
    const state = stateWith('');
    const ctx = matchCtxOf(state, FIXED_NOW);
    const facets = deriveFacets(state.cards, deckScope('d1'), {}, ctx);
    expect(facets.some((f) => f.key === 'section')).toBe(false);
    expect(facets.find((f) => f.key === 'field:level')?.ordinal).not.toBeNull();
    expect(facets.find((f) => f.key === 'field:category')?.ordinal).toBeNull();
    // '' ↔ 'Misc' is one to one, but "By level" has no row for an empty Level.
    expect(splitsLikeSections(state.cards, ctx.index, 'level')).toBe(false);
    const blocks = barBlocks(state.cards, facets, ctx.index, state.decks[0]);
    expect(blocks.map((b) => b.key)).toEqual(['field:level', 'section']);
    // The Misc items can be reached from the page: their own section row.
    const misc = blocks[1].rows.find((r) => r.label === 'Misc')!;
    expect(misc.total).toBe(1);
    expect(scopePool(state, valueScope('d1', 'section', misc.value), ctx, 'browse').map((c) => c.noteId)).toEqual(['t4']);

    // Control: when "Misc" has a level of its own, "By level" shows the same split → one block.
    const same = stateWith('B2');
    const sctx = matchCtxOf(same, FIXED_NOW);
    expect(splitsLikeSections(same.cards, sctx.index, 'level')).toBe(true);
    expect(barBlocks(same.cards, deriveFacets(same.cards, deckScope('d1'), {}, sctx), sctx.index, same.decks[0]).map((b) => b.key)).toEqual([
      'field:level',
    ]);
  });

  it('German: Level and sections differ — both blocks, "By level" first (spec §8.2)', () => {
    const sections = ['Vocabulary::A1', 'Verbs::A1', 'Vocabulary::A2', 'Verbs::B1', 'Vocabulary::B1'];
    const state = germanDeck(LEVELS.map((w, i) => ({ ...w, section: sections[i] })));
    const ctx = matchCtxOf(state, FIXED_NOW);
    expect(splitsLikeSections(state.cards, ctx.index, 'level')).toBe(false);
    const blocks = barBlocks(state.cards, deriveFacets(state.cards, deckScope('d1'), {}, ctx), ctx.index, state.decks[0]);
    expect(blocks.map((b) => b.key)).toEqual(['field:level', 'section']);
    const section = blocks[1];
    expect(section.rows.map((r) => [r.label, r.total])).toEqual([
      ['Vocabulary', 3],
      ['Verbs', 2],
    ]);
    // The tree levels in level order (A1 < A2 < B1), like the facet engine.
    expect(section.rows[0].children.map((r) => r.label)).toEqual(['A1', 'A2', 'B1']);
  });

  it('sectionTree: fewer than 2 sections is no tree (the deck root is no section)', () => {
    const one = germanDeck(LEVELS.map((w) => ({ ...w, section: w.level === 'A1' ? 'Verbs' : '' })));
    expect(sectionTree(one.cards, libraryIndexOf(one), 'd1')).toBeNull();
    const full = germanDeck(LEVELS);
    const tree = sectionTree(full.cards, libraryIndexOf(full), 'd1');
    expect(tree?.map((v) => v.label)).toEqual(['Vocabulary', 'Verbs']);
    expect(tree?.[0].children?.map((v) => [v.label, v.count])).toEqual([
      ['A1', 2],
      ['A2', 1],
    ]);
  });
});

describe('"Where do you start?"', () => {
  const state = germanDeck(LEVELS, (i) => cardInLifeV3(i === 1 ? 'review' : i === 2 ? 'new' : 'notStarted'));
  const ctx = matchCtxOf(state, FIXED_NOW);
  const facets = deriveFacets(state.cards, deckScope('d1'), {}, ctx);
  const groups = placementGroups(state.cards, facets, ctx.index);

  it('offers the ordinal field group, in level order', () => {
    expect(groups.map((g) => [g.key, g.values.map((v) => v.label)])).toEqual([['field:level', ['A1', 'A2', 'B1']]]);
    const { notes } = state;
    expect(placementRank(groups[0], notes[3], ctx.index)).toBe(2);
  });

  it('start at B1: the never-studied cards of A1 and A2 (a studied card keeps its schedule)', () => {
    const ids = easierCardIds(state.cards, groups[0], 2, ctx.index, ctx.decks);
    const notes = ids.map((id) => state.cards.find((c) => c.id === id)!.noteId).sort();
    expect(notes).toEqual(['n0', 'n2']);
    expect(easierNotes(['n0', 'n1', 'n2', 'n3'], groups[0], 1, ctx.index)).toEqual(['n0', 'n1']);
    // "Leave them not started": only the New one (n2) moves; n0 is Not started already.
    const back = easierCardIds(state.cards, groups[0], 2, ctx.index, ctx.decks, 'notStarted');
    expect(back.map((id) => state.cards.find((c) => c.id === id)!.noteId)).toEqual(['n2']);
    // "I know them", through the real reducer, with Undo.
    const step = reducer.markKnown(state, { cardIds: ids }, testCtx());
    expect(step.state.cards.filter((c) => ids.includes(c.id)).every((c) => life(c) === 'known')).toBe(true);
    const undone = reducer.undoManualEdit(step.state, { editId: step.result.edit.id }, testCtx()).state;
    expect(undone.cards.map(life)).toEqual(state.cards.map(life));
  });

  it('a turned-off direction is never changed: it comes back as it was', () => {
    // Two directions per item, levels from the section names; 'Back → Front' (ord 1) is off.
    // n0 (A1) and n1 (A2): ord 0 Not started, ord 1 New (it was in the queue before it was turned off).
    const deck = makeDeckV3({ id: 'd1', options: { directions: { [REVERSE]: [0] } } });
    const groups = ['Vocabulary::A1', 'Grammar::A2', 'Vocabulary::B1'].map((section, i) =>
      noteWithCards({
        deckId: 'd1',
        typeId: REVERSE,
        note: { id: `p${i}`, order: i, section },
        card: (ord) => lifeValues(ord === 0 ? 'notStarted' : 'new'),
      }),
    );
    const two = stateOfV3({ decks: [deck], groups });
    const tctx = matchCtxOf(two, FIXED_NOW);
    const [group] = placementGroups(two.cards, deriveFacets(two.cards, deckScope('d1'), {}, tctx), tctx.index);
    expect(group.values.map((v) => v.label)).toEqual(['A1', 'A2', 'B1']);
    const ordOf = (id: string) => two.cards.find((c) => c.id === id)!.ord;
    // "I know them" from B1: only the ord-0 cards of A1 and A2.
    const known = easierCardIds(two.cards, group, 2, tctx.index, tctx.decks);
    expect(known).toHaveLength(2);
    expect(known.map(ordOf)).toEqual([0, 0]);
    // "Leave them not started": the New cards are all in the turned-off direction, so nothing moves.
    expect(easierCardIds(two.cards, group, 2, tctx.index, tctx.decks, 'notStarted')).toEqual([]);
    // Through the real reducer: the off direction keeps its state.
    const after = reducer.markKnown(two, { cardIds: known }, testCtx()).state;
    const easy = after.cards.filter((c) => c.noteId !== 'p2');
    expect(easy.filter((c) => c.ord === 0).map(life)).toEqual(['known', 'known']);
    expect(easy.filter((c) => c.ord === 1).map(life)).toEqual(['new', 'new']);
    // With both directions on, the same choice takes every never-studied card.
    const on = decksById([makeDeckV3({ id: 'd1' })]);
    expect(easierCardIds(two.cards, group, 2, tctx.index, on)).toHaveLength(4);
  });

  it('the scope from a level up (for "Choose what to learn" from there)', () => {
    const q = fromLevelScope('d1', groups[0], 1, state.cards, ctx.index);
    expect(q).toEqual({ decks: ['d1'], fields: { level: ['a2', 'b1'] } });
    expect(scopePool(state, q, ctx, 'browse')).toHaveLength(3);
  });

  it('from the FIRST level = the whole deck: an item with no level is not left out', () => {
    // One more item with an empty Level field.
    const withBlank = germanDeck([...LEVELS, { term: 'das Ding', meaning: 'thing', level: '' }]);
    const bctx = matchCtxOf(withBlank, FIXED_NOW);
    const [group] = placementGroups(withBlank.cards, deriveFacets(withBlank.cards, deckScope('d1'), {}, bctx), bctx.index);
    expect(group.values.map((v) => v.label)).toEqual(['A1', 'A2', 'B1']);
    const q = fromLevelScope('d1', group, 0, withBlank.cards, bctx.index);
    expect(q).toEqual(deckScope('d1'));
    // Every item of the deck is in the triage, also "das Ding" (no level).
    const items = triageItems(scopePool(withBlank, notStartedScope(q), bctx, 'browse'), triageLookupOf(withBlank, bctx));
    expect(items).toHaveLength(LEVELS.length + 1);
    // A level scope would have missed it: that is why rank 0 is the deck.
    const levels = { decks: ['d1'], fields: { level: group.values.map((v) => v.value) } };
    expect(scopePool(withBlank, levels, bctx, 'browse')).toHaveLength(LEVELS.length);
  });

  it('a deck whose only levels are its section names offers the sections', () => {
    const plain = stateOfV3({
      decks: [makeDeckV3({ id: 'd1' })],
      groups: ['Vocabulary::A1', 'Grammar::A2', 'Vocabulary::B1'].map((section, i) =>
        noteWithCards({ deckId: 'd1', note: { id: `p${i}`, section }, card: () => cardInLifeV3('notStarted') }),
      ),
    });
    const pctx = matchCtxOf(plain, FIXED_NOW);
    const g = placementGroups(plain.cards, deriveFacets(plain.cards, deckScope('d1'), {}, pctx), pctx.index);
    expect(g.map((x) => [x.key, x.values.map((v) => v.label)])).toEqual([['section', ['A1', 'A2', 'B1']]]);
    const q = fromLevelScope('d1', g[0], 1, plain.cards, pctx.index);
    expect(scopePool(plain, q, pctx, 'browse').map((c) => c.noteId).sort()).toEqual(['p1', 'p2']);
  });
});

describe('deck settings', () => {
  it('directions: counts, on = has cards, never the last one off; on creates cards, off keeps them', () => {
    const deck = makeDeckV3({ id: 'd1' });
    const groups = [0, 1].map((i) => noteWithCards({ deckId: 'd1', typeId: REVERSE, ords: [0], note: { id: `n${i}` } }));
    const state = stateOfV3({ decks: [deck], groups });
    const index = libraryIndexOf(state);
    const types = deckTypes(state.cards, index);
    const rows = directionTypes(deck, types, state.cards, index, decksById(state.decks));
    expect(rows).toHaveLength(1);
    expect(rows[0].rows.map((r) => [r.ord, r.cards, r.on])).toEqual([
      [0, 2, true],
      [1, 0, false],
    ]);
    expect(toggledOrds(rows[0].rows, 0)).toBeNull(); // the last direction stays on
    expect(toggledOrds(rows[0].rows, 1)).toEqual([0, 1]);
    expect(directionsSummary(rows)).toBe('Front → Back');

    // On: the reducer makes the missing cards. Off: the cards and their progress stay.
    const on = reducer.setDirections(state, { deckId: 'd1', typeId: REVERSE, ords: [0, 1] }, testCtx());
    expect(on.result.created).toBe(2);
    expect(directionSnack(true, 2)).toBe('2 cards added');
    const studied = {
      ...on.state,
      cards: on.state.cards.map((c) => (c.ord === 1 ? { ...c, ...cardInLifeV3('review'), id: c.id, noteId: c.noteId, deckId: c.deckId, ord: 1 } : c)),
    };
    const off = reducer.setDirections(studied, { deckId: 'd1', typeId: REVERSE, ords: [0] }, testCtx()).state;
    expect(off.cards).toHaveLength(4);
    expect(off.cards.filter((c) => c.ord === 1).every((c) => c.reps === 4)).toBe(true);
    const offDeck = off.decks[0];
    const offRows = directionTypes(offDeck, types, off.cards, libraryIndexOf(off), decksById(off.decks));
    expect(offRows[0].rows.map((r) => [r.cards, r.on])).toEqual([
      [2, true],
      [2, false],
    ]);
    expect(directionSnack(false, 0)).toBe('Direction off — its cards and progress are kept');
  });

  it('read aloud, noun genders, new cards and card types summaries', () => {
    const state = germanDeck(LEVELS.slice(0, 1));
    const types = deckTypes(state.cards, libraryIndexOf(state));
    // The German built-in card type: Word is German, Translation English.
    expect(readAloudSummary(state.decks[0], types)).toBe('German / English');
    expect(hasGermanTerms(state.decks[0], types)).toBe(true);
    // A Basic deck: the deck languages are the fallback.
    const basic = stateOfV3({ decks: [makeDeckV3({ id: 'b', language: 'es-ES', meaningLanguage: 'en-US' })], groups: [noteWithCards({ deckId: 'b' })] });
    const basicTypes = deckTypes(basic.cards, libraryIndexOf(basic));
    expect(readAloudSummary(basic.decks[0], basicTypes)).toBe('Spanish / English');
    expect(hasGermanTerms(basic.decks[0], basicTypes)).toBe(false);
    expect(readAloudSummary(makeDeckV3(), basicTypes)).toBe('Device voice');
    // A new, EMPTY deck (no card types yet): its own languages, what its first Basic cards use.
    expect(readAloudSummary(makeDeckV3({ language: 'de-DE', meaningLanguage: 'en-US' }), [])).toBe('German / English');
    expect(readAloudSummary(makeDeckV3({ language: 'de-DE' }), [])).toBe('German');
    expect(readAloudSummary(makeDeckV3(), [])).toBe('Device voice');
    expect(newPerDayLabel(null, 10)).toBe('Use my daily limit (10)');
    expect(newPerDayLabel(20, 10)).toBe('20 a day');
    expect(cardTypesSummary(basicTypes)).toBe('Basic');
    expect(cardTypesSummary([...basicTypes, ...types])).toBe('2 card types');
  });

  it('card type drafts: label, role, filter, language — saved with the real updateNoteType', () => {
    const state = germanDeck(LEVELS.slice(0, 2));
    const type = deckTypes(state.cards, libraryIndexOf(state))[0];
    let draft: FieldDef[] = type.fields.map((f) => ({ ...f }));
    expect(fieldsChanged(type.fields, draft)).toBe(false);
    draft = patchFieldDef(draft, LEVEL, { label: 'CEFR', facet: 'off' });
    draft = patchFieldDef(draft, 3, { role: 'hidden' });
    draft = patchFieldDef(draft, 1, { lang: 'en-GB' });
    expect(fieldsChanged(type.fields, draft)).toBe(true);
    const saved = reducer.updateNoteType(state, { typeId: type.id, patch: { fields: draft } }, testCtx()).state;
    const stored = saved.noteTypes.find((t) => t.id === type.id)!;
    expect(stored.fields[LEVEL]).toMatchObject({ name: 'Level', label: 'CEFR', facet: 'off' });
    expect(stored.fields[3].role).toBe('hidden');
    expect(stored.fields[1].lang).toBe('en-GB');
    // The notes keep every value: nothing is thrown away.
    const { notes: before } = state;
    const { notes: after } = saved;
    expect(after).toBe(before);
    // An empty label (or the field name) goes back to the name — in the draft Save writes (normalizeFields).
    expect(normalizeFields(patchFieldDef(draft, LEVEL, { label: '  ' }))[LEVEL].label).toBeUndefined();
    expect(normalizeFields(patchFieldDef(draft, LEVEL, { label: 'Level' }))[LEVEL].label).toBeUndefined();
    expect(normalizeFields(patchFieldDef(draft, LEVEL, { label: ' CEFR level ' }))[LEVEL].label).toBe('CEFR level');
  });

  it('a label is kept as it is typed, key by key — also one that starts with the field name', () => {
    const state = germanDeck(LEVELS.slice(0, 1));
    const type = deckTypes(state.cards, libraryIndexOf(state))[0];
    expect(type.fields[0].name).toBe('Word');
    let draft: FieldDef[] = type.fields.map((f) => ({ ...f }));
    // The label box sends the whole text after every key press.
    const typed = 'Word (DE)';
    for (let i = 1; i <= typed.length; i += 1) {
      draft = patchFieldDef(draft, 0, { label: typed.slice(0, i) });
      expect(draft[0].label).toBe(typed.slice(0, i)); // "Word" and "Word " stay in the box
    }
    expect(fieldsChanged(type.fields, draft)).toBe(true);
    const saved = reducer.updateNoteType(state, { typeId: type.id, patch: { fields: normalizeFields(draft) } }, testCtx()).state;
    expect(saved.noteTypes.find((t) => t.id === type.id)!.fields[0].label).toBe('Word (DE)');

    // "Front side" on a "Front" field (Basic and reversed).
    const basic = stateOfV3({ decks: [makeDeckV3({ id: 'b' })], groups: [noteWithCards({ deckId: 'b', typeId: REVERSE })] });
    const reverse = deckTypes(basic.cards, libraryIndexOf(basic))[0];
    let front: FieldDef[] = reverse.fields.map((f) => ({ ...f }));
    for (const text of ['F', 'Fr', 'Fro', 'Fron', 'Front', 'Front ', 'Front s', 'Front side']) {
      front = patchFieldDef(front, 0, { label: text });
    }
    expect(normalizeFields(front)[0].label).toBe('Front side');

    // Typed back to the name: no change, so Save stays off.
    let back: FieldDef[] = type.fields.map((f) => ({ ...f }));
    back = patchFieldDef(back, 0, { label: 'Word ' });
    back = patchFieldDef(back, 0, { label: 'Word' });
    expect(fieldsChanged(type.fields, back)).toBe(false);
  });

  it('"Also used in {n} other decks" counts the other decks of a card type', () => {
    const groups = [
      noteWithCards({ deckId: 'a', note: { id: 'x' } }),
      noteWithCards({ deckId: 'b', note: { id: 'y' } }),
      noteWithCards({ deckId: 'c', note: { id: 'z' } }),
    ];
    const state = stateOfV3({ decks: ['a', 'b', 'c'].map((id) => makeDeckV3({ id })), groups });
    const decks = typeDecks(state).get(BUILTIN_TYPE_IDS.basic)!;
    expect(decks.size).toBe(3);
    expect(sharedTypeNote(decks.size - 1)).toBe('Also used in 2 other decks. Changes apply there too.');
    expect(sharedTypeNote(1)).toBe('Also used in 1 other deck. Changes apply there too.');
    expect(sharedTypeNote(0)).toBe('');
  });
});

describe('More ways to study: Practice articles', () => {
  it('counts German singular nouns of the practice pool, one per item, capped by the session size', () => {
    const words = [
      { term: 'die Abfahrt', meaning: 'departure', level: 'A1' },
      { term: 'der Tisch', meaning: 'table', level: 'A1' },
      { term: 'das Haus', meaning: 'house', level: 'A1' },
      { term: 'die Katze', meaning: 'cat', level: 'A2' },
      { term: 'gehen', meaning: 'to go', level: 'A1' },
    ];
    const state = germanDeck(words, () => cardInLifeV3('new'));
    expect(articlePracticeCount(state, deckScope('d1'), FIXED_NOW)).toBe(4);
    const capped = { ...state, settings: makeSettingsV3({ sessionLimit: 3 }) };
    expect(articlePracticeCount(capped, deckScope('d1'), FIXED_NOW)).toBe(3);
    // Not started cards are not practised (spec §6.6).
    expect(articlePracticeCount(germanDeck(words), deckScope('d1'), FIXED_NOW)).toBe(0);
  });
});

describe('Export as CSV', () => {
  it('one row per item in deck order: the field names, then Tags and Section', () => {
    const deck = makeDeckV3({ id: 'd1', name: 'Words' });
    const groups = [
      noteWithCards({ deckId: 'd1', typeId: REVERSE, fields: ['Haus', 'house, home', '', ''], note: { id: 'b', order: 2, tags: ['noun', 'a1'], section: 'Vocabulary::A1' } }),
      noteWithCards({ deckId: 'd1', typeId: REVERSE, fields: ['gehen', 'to "go"', '', ''], note: { id: 'a', order: 1 } }),
    ];
    const state = stateOfV3({ decks: [deck], groups });
    const csv = deckCsv(state.cards, libraryIndexOf(state));
    expect(csv).toBe(
      '﻿Front,Back,Example,Notes,Tags,Section\r\n' +
        'gehen,"to ""go""",,,,\r\n' +
        'Haus,"house, home",,,noun a1,Vocabulary::A1\r\n',
    );
    expect(deckCsvFileName('German: Verbs/B1', FIXED_NOW)).toBe('German- Verbs-B1-2026-06-10.csv');
    expect(deckCsvFileName('   ', FIXED_NOW)).toBe('deck-2026-06-10.csv');
  });

  // Final review 2026-11: the columns were "Note tags" / "Note section" — the app never says "note".
  it('a FIELD called Tags or Section: the item columns are "Item tags" / "Item section" (one "Tags" header only)', () => {
    const type: NoteType = {
      id: 'nt-tags',
      name: 'With a Tags field',
      kind: 'standard',
      fields: [
        { name: 'Front', role: 'term', facet: 'off' },
        { name: 'Back', role: 'meaning', facet: 'off' },
        { name: 'Tags', role: 'detail', facet: 'off' },
        { name: 'Section', role: 'detail', facet: 'off' },
      ],
      templates: [{ ord: 0, name: 'Front → Back', prompt: [0], answer: [1] }],
      sortField: 0,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    };
    const deck = makeDeckV3({ id: 'd1', name: 'Words' });
    const groups = [
      noteWithCards(
        { deckId: 'd1', typeId: type.id, fields: ['Haus', 'house', 'noun', 'A1'], note: { id: 'a', tags: ['mine'], section: 'Part 1' } },
        [type],
      ),
    ];
    const state = stateOfV3({ decks: [deck], groups, types: [type] });
    const header = deckCsv(state.cards, libraryIndexOf(state)).split('\r\n')[0];
    expect(header).toBe('\uFEFFFront,Back,Tags,Section,Item tags,Item section');
    expect(header).not.toMatch(/\bNote\b/);
  });
});

describe('routes and words', () => {
  it('a session over a query (q and sort as JSON, card ids never in a URL)', () => {
    const route = sessionRoute({ kind: 'practice', q: hardestSession('d1').q, label: 'German', sort: { by: 'hardest' }, mode: 'mc' });
    expect(route.pathname).toBe('/session');
    expect(parseQueryParam(route.params.q)).toEqual({ decks: ['d1'] });
    expect(route.params).toMatchObject({ kind: 'practice', label: 'German', mode: 'mc', sort: '{"by":"hardest"}' });
    expect(sessionRoute({ kind: 'scheduled', q: deckScope('d1'), label: 'G' }).params).toEqual({
      kind: 'scheduled',
      q: '{"decks":["d1"]}',
      label: 'G',
    });
  });

  it('the Library and the triage screen', () => {
    expect(libraryHref(deckScope('d1'), '17')).toBe('/(tabs)/library?q=%7B%22decks%22%3A%5B%22d1%22%5D%7D&nonce=17');
    const href = triageHref(deckScope('d1'), { fromDeck: true });
    expect(href.startsWith('/triage?q=')).toBe(true);
    expect(href.endsWith('&from=deck')).toBe(true);
    const q = decodeURIComponent(href.slice('/triage?q='.length, href.indexOf('&')));
    expect(parseQueryParam(q)).toEqual({ decks: ['d1'], life: ['notStarted'] });
    // After "Where do you start?" the triage is told so (it does not ask again).
    expect(triageHref(deckScope('d1'), { fromDeck: true, placed: true }).endsWith('&from=deck&placed=1')).toBe(true);
    expect(triageHref(deckScope('d1')).includes('placed')).toBe(false);
    expect(placementDone('1')).toBe(true);
    expect(placementDone(['1'])).toBe(true);
    expect(placementDone(undefined)).toBe(false);
    expect(placementDone('0')).toBe(false);
  });

  it('an import opened from the page of the deck it filled goes BACK there (never a second copy on the stack)', () => {
    // The deck page opens /import?source=file&deckId=d1; the cards went into d1.
    expect(importFromDeckPage('d1', 'd1')).toBe(true);
    expect(importFromDeckPage(['d1'], 'd1')).toBe(true);
    // Opened from Today or Settings (no deckId), or the cards went into another deck: a new deck page.
    expect(importFromDeckPage(undefined, 'd1')).toBe(false);
    expect(importFromDeckPage('', 'd1')).toBe(false);
    expect(importFromDeckPage('d1', 'd2')).toBe(false);
    expect(importFromDeckPage('d1', null)).toBe(false);
  });

  it('delete: the three no-orphan choices, only those that can work', () => {
    const all = deleteOptions({ canMove: true, canKeep: true, unfiledExists: false, unfiledName: 'Unfiled cards' });
    expect(all.map((o) => o.id)).toEqual(['move', 'keep', 'all']);
    expect(all[1].sub).toBe("Move cards to a new deck called 'Unfiled cards'");
    expect(deleteOptions({ canMove: false, canKeep: false, unfiledExists: true, unfiledName: 'Unfiled cards' }).map((o) => o.id)).toEqual([
      'all',
    ]);
    expect(deleteSnackText('move', 3, 'Spanish')).toBe('Deck deleted — cards moved to Spanish');
    expect(deleteSnackText('all', 3, '')).toBe('Deck and cards deleted');
    expect(deleteSnackText('keep', 0, 'Unfiled cards')).toBe('Deck deleted');
  });
});

describe('frozenUnless', () => {
  it('computes while live; while not live it keeps its last value', () => {
    let calls = 0;
    const sel = (n: number) => {
      calls += 1;
      return n * 2;
    };
    const live = frozenUnless(sel, true);
    expect(live(1)).toBe(2);
    expect(live(2)).toBe(4);
    const frozen = frozenUnless(sel, false);
    expect(frozen(3)).toBe(6); // computes once
    expect(frozen(4)).toBe(6); // then keeps it
    expect(calls).toBe(3);
  });
});

/* ======================================================================= import fixes */

/** A small Anki collection: notes with guids in one subdeck. */
function collection(guids: string[], fileName = 'German.apkg'): AnkiCollection {
  return {
    fileName,
    crt: 0,
    models: { m1: { name: 'Basic', type: 0, sortf: 0, flds: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }], tmpls: [] } },
    decks: { '1': 'German' },
    notes: guids.map((guid, i) => ({ id: String(i + 1), guid, mid: 'm1', flds: [`f${i}`, `b${i}`], tags: [] })),
    cards: guids.map((_, i) => ({
      id: `c${i + 1}`,
      nid: String(i + 1),
      did: '1',
      odid: '0',
      ord: 0,
      type: 0,
      queue: 0,
      due: i,
      ivl: 0,
      factor: 0,
      reps: 0,
      lapses: 0,
      flags: 0,
    })),
    media: {},
  };
}

describe('import: the real file name', () => {
  it('reads it from the picker name or the content URI; a document id is no name', () => {
    expect(pickedFileName({ name: 'German.apkg', uri: 'file:///data/cache/German.apkg' })).toBe('German.apkg');
    expect(pickedFileName({ name: 'msf:96', uri: 'content://com.android.providers.downloads.documents/document/msf%3A96' })).toBeNull();
    expect(
      pickedFileName({
        name: 'primary:Download/German_Complete.apkg',
        uri: 'content://com.android.externalstorage.documents/document/primary%3ADownload%2FGerman_Complete.apkg',
      }),
    ).toBe('German_Complete.apkg');
    expect(pickedFileName({ name: '', uri: 'content://x/document/raw%3A%2Fstorage%2Femulated%2F0%2FDownload%2Fwords.csv' })).toBe(
      'words.csv',
    );
    expect(pickedFileName({ name: 'document:1234', uri: 'content://x/document/1234' })).toBeNull();
  });

  it('names a nameless file after its root deck; a nameless CSV gets a key of its own', () => {
    expect(fallbackFileName('apkg', 'German')).toBe('German.apkg');
    expect(fallbackFileName('apkg', 'a/b: c')).toBe('a b c.apkg');
    expect(fallbackFileName('csv', 'anything')).toBe('Imported deck.csv');
    const a = namelessSourceKey('Imported deck.csv', 'Word,Translation\nHaus,house\n');
    const b = namelessSourceKey('Imported deck.csv', 'Word,Translation\nKatze,cat\n');
    expect(a.startsWith('file:Imported deck.csv#')).toBe(true);
    expect(a).not.toBe(b);
    expect(namelessSourceKey('Imported deck.csv', 'Word,Translation\nHaus,house\n')).toBe(a);
  });
});

describe('import: a re-import goes to the deck that holds the items (by guid)', () => {
  it('finds the deck with most of the guids; none → null', () => {
    const notes: Note[] = [];
    const cards: Card[] = [];
    for (const [deckId, guid, id] of [
      ['d1', 'g1', 'x1'],
      ['d1', 'g2', 'x2'],
      ['d2', 'g3', 'x3'],
    ] as const) {
      const g = noteWithCards({ deckId, note: { id, guid } });
      notes.push(g.note);
      cards.push(...g.cards);
    }
    const library = { notes, cards, decks: [makeDeckV3({ id: 'd1' }), makeDeckV3({ id: 'd2' })] };
    expect(guidHomeDeck(collection(['g1', 'g2', 'g3', 'new']), new Set(['1']), library)).toBe('d1');
    expect(guidHomeDeck(collection(['g3']), new Set(['1']), library)).toBe('d2');
    expect(guidHomeDeck(collection(['zz']), new Set(['1']), library)).toBeNull();
    // Only the chosen sections count.
    expect(guidHomeDeck(collection(['g1']), new Set(['other']), library)).toBeNull();
    // A deck that is gone does not count.
    expect(guidHomeDeck(collection(['g3']), new Set(['1']), { ...library, decks: [library.decks[0]] })).toBeNull();
  });

  it('only a REAL re-import starts on the home deck: it must hold at least half of the chosen items', () => {
    // "Spanish A" (d1) came from A.apkg: 6 items.
    const notes: Note[] = [];
    const cards: Card[] = [];
    for (let i = 0; i < 6; i += 1) {
      const g = noteWithCards({ deckId: 'd1', note: { id: `a${i}`, guid: `a${i}` } });
      notes.push(g.note);
      cards.push(...g.cards);
    }
    const library = { notes, cards, decks: [makeDeckV3({ id: 'd1', name: 'Spanish A' })] };
    const homeOf = (guids: string[]) => {
      const file = collection(guids);
      const sel = new Set(['1']);
      return reimportHomeDeck(guidHomeDeck(file, sel, library), chosenGuidsOf(chosenNotesByMid(file, sel)), library);
    };
    expect(REIMPORT_MIN_SHARE).toBe(0.5);
    // The same file again (and a newer version with a few new items): d1.
    expect(homeOf(['a0', 'a1', 'a2', 'a3', 'a4', 'a5'])).toBe('d1');
    expect(homeOf(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'n1', 'n2'])).toBe('d1');
    // Exactly half is still a re-import.
    expect(homeOf(['a0', 'a1', 'n1', 'n2'])).toBe('d1');
    // B.apkg: 20 items, 2 shared with A — the most-guid deck is d1, but this is NOT a re-import.
    const other = ['a0', 'a1', ...Array.from({ length: 18 }, (_, i) => `b${i}`)];
    expect(guidHomeDeck(collection(other), new Set(['1']), library)).toBe('d1');
    expect(homeOf(other)).toBeNull();
    // No home, or a file without guids: null.
    expect(reimportHomeDeck(null, new Set(['a0']), library)).toBeNull();
    expect(reimportHomeDeck('d1', new Set(), library)).toBeNull();
    // Each guid counts once (a file with a duplicate id).
    expect(chosenGuidsOf(new Map([['m1', [{ guid: 'x' }, { guid: 'x' }, { guid: '' }]]]))).toEqual(new Set(['x']));
  });
});

describe('wave 5g (E8) — a CSV picked again WITHOUT its name finds its deck by its rows', () => {
  it('csvHomeDeck: the deck with the most rows already here, only with at least half of the rows', () => {
    const asked: string[] = [];
    const here = (counts: Record<string, number>) => (deckId: string) => {
      asked.push(deckId);
      return counts[deckId] ?? 0;
    };
    expect(csvHomeDeck([{ deckId: 'd1', notes: 3 }], 3, here({ d1: 3 }))).toBe('d1');
    // Exactly half is still a re-import (REIMPORT_MIN_SHARE, like an .apkg).
    expect(csvHomeDeck([{ deckId: 'd1', notes: 2 }], 4, here({ d1: 2 }))).toBe('d1');
    // Same words, but another card type (an Anki deck): 0 rows already here → not that deck.
    expect(csvHomeDeck([{ deckId: 'gv', notes: 3 }], 3, here({ gv: 0 }))).toBeNull();
    // The most rows already here wins, not the most words in common.
    expect(
      csvHomeDeck(
        [
          { deckId: 'gv', notes: 3 },
          { deckId: 'd1', notes: 3 },
        ],
        3,
        here({ gv: 0, d1: 3 }),
      ),
    ).toBe('d1');
    // A tie keeps the deck listed first.
    expect(
      csvHomeDeck(
        [
          { deckId: 'a', notes: 3 },
          { deckId: 'b', notes: 3 },
        ],
        3,
        here({ a: 2, b: 2 }),
      ),
    ).toBe('a');
    // A deck with fewer than half of the rows' words is not even planned again.
    asked.length = 0;
    expect(csvHomeDeck([{ deckId: 'd1', notes: 1 }], 3, here({ d1: 1 }))).toBeNull();
    expect(asked).toEqual([]);
    // Nothing chosen, or no deck with the same words: null.
    expect(csvHomeDeck([{ deckId: 'd1', notes: 3 }], 0, here({ d1: 3 }))).toBeNull();
    expect(csvHomeDeck([], 3, here({}))).toBeNull();
    expect(chosenCountOf(new Map([['m1', [1, 2]], ['m2', [3]]]))).toBe(3);
  });

  /** The walkthrough's file. */
  const TEXT = 'Front,Back\nder Hund,the dog\ndie Katze,the cat\ndas Haus,the house';

  /** The choices the import screen starts with (import.tsx startPlanning), with the real planner. */
  const planFor = (c: AnkiCollection, state: DataStateV3, origin: ReturnType<typeof importOrigin>, target: ImportChoices['target'], seed: string) =>
    planImport(
      c,
      state,
      {
        sections: new Set(collectionSections(c).map((s) => s.did)),
        target,
        types: choiceTypes(c, startingTypes(c, suggestMapping(c), state.noteTypes)),
        progress: 'keep',
        arrival: 'queued',
        elsewhere: 'update',
        images: true,
      },
      importPlanCtx({ now: FIXED_NOW, seed, srs: DEFAULT_SRS, origin }),
    );

  /**
   * The Preview's start EXACTLY as import.tsx `startPlanning` makes it: the
   * same inputs into the same pure step (importStartPlan), with the real
   * planner (the prefs → choices mapping of import.tsx `choicesOf`).
   * `planned` lists every prefs the planner was asked for, in order.
   */
  const startOf = (
    c: AnkiCollection,
    state: DataStateV3,
    origin: ReturnType<typeof importOrigin>,
    earlier: ImportPrefs | null = null,
  ) => {
    const sel = new Set(collectionSections(c).map((s) => s.did));
    const name = suggestDeckName(c, sel);
    const chosen = chosenNotesByMid(c, sel);
    const home = reimportHomeDeck(guidHomeDeck(c, sel, state), chosenGuidsOf(chosen), state);
    const target = defaultTarget(state.decks, origin, { deckId: home, name, icon: '🗂️' });
    const first = startingPrefs(target, { name, icon: '🗂️', decks: state.decks });
    const planned: ImportPrefs[] = [];
    const types = choiceTypes(c, startingTypes(c, suggestMapping(c), state.noteTypes));
    const start = importStartPlan({
      earlier,
      first,
      home,
      csv: c.csv ? { rows: chosenCountOf(chosen), sourceKey: origin.sourceKey } : null,
      decks: state.decks,
      triageReady: true,
      planWith: (p) => {
        planned.push(p);
        return planImport(
          c,
          state,
          {
            sections: sel,
            target: prefsTarget(p),
            types,
            progress: p.progress,
            arrival: p.arrival,
            elsewhere: p.elsewhere,
            images: p.images,
            skipOverlap: p.skipOverlap,
          },
          importPlanCtx({ now: FIXED_NOW, seed: `p${planned.length}`, srs: DEFAULT_SRS, origin }),
        );
      },
    });
    return { ...start, planned, first };
  };
  /** The deck the Preview starts on: "Existing deck: {id}", or null for "New deck". */
  const startDeck = (s: ReturnType<typeof startOf>) => (s.prefs.targetKind === 'existing' ? s.prefs.existingDeckId : null);
  /** Imports a CSV text with a REAL file name into a new deck; returns the state and the deck. */
  const importNamed = (state: DataStateV3, text: string, fileName: string) => {
    const c = readCsv(text, fileName);
    const origin = importOrigin({ kind: 'file', fileName, isCsv: true });
    const t = defaultTarget(state.decks, origin, { name: suggestDeckName(c), icon: '🗂️' });
    const step = reducer.applyImport(state, { plan: planFor(c, state, origin, t, `n-${fileName}`) }, testCtx(FIXED_NOW));
    return { state: step.state, deckId: step.result.deckId as string };
  };
  /** A CSV picked WITHOUT a name (the picker gave a document id): the made-up name and a nameless key. */
  const nameless = (text: string) => {
    const fileName = fallbackFileName('csv', '');
    return { c: readCsv(text, fileName), origin: importOrigin({ kind: 'file', fileName, isCsv: true }, namelessSourceKey(fileName, text)) };
  };
  /** A CSV picked WITH its real name. */
  const named = (text: string, fileName: string) => ({
    c: readCsv(text, fileName),
    origin: importOrigin({ kind: 'file', fileName, isCsv: true }),
  });

  it('three-words.csv: first with its name, then from the picker’s recent files (msf:102) → "Existing deck: three-words", already up to date', () => {
    // A German Vocabulary deck (another card type) that has "die Katze" and "der Hund" too.
    // It came from an Anki FILE, as on the device (wave 5h, I3: only a deck from a file is asked;
    // a deck made in the app never is — importFile.test.ts).
    const gv = makeDeckV3({ id: 'gv', name: 'German Vocabulary', source: 'apkg', sourceKey: 'file:German_Vocabulary.apkg' });
    const gvNotes = [
      noteWithCards({ deckId: 'gv', fields: ['die Katze', 'cat'], note: { id: 'g1' } }),
      noteWithCards({ deckId: 'gv', fields: ['der Hund', 'dog'], note: { id: 'g2' } }),
      noteWithCards({ deckId: 'gv', fields: ['das Haus', 'house'], note: { id: 'g3' } }),
    ];
    let state = stateOfV3({ decks: [gv], groups: gvNotes });

    // 1. The first pick had the real name: deck "three-words", key 'file:three-words.csv'.
    const named = readCsv(TEXT, 'three-words.csv');
    const namedOrigin = importOrigin({ kind: 'file', fileName: 'three-words.csv', isCsv: true });
    const firstTarget = defaultTarget(state.decks, namedOrigin, { name: suggestDeckName(named), icon: '🗂️' });
    expect(firstTarget).toEqual({ kind: 'new', name: 'three-words', icon: '🗂️' });
    const step = reducer.applyImport(state, { plan: planFor(named, state, namedOrigin, firstTarget, 'a') }, testCtx(FIXED_NOW));
    state = step.state;
    const deckId = step.result.deckId as string;
    expect(state.decks.find((d) => d.id === deckId)).toMatchObject({ name: 'three-words', sourceKey: 'file:three-words.csv' });

    // 2. The same file again, but the picker gave only 'msf:102': a made-up name and a nameless key.
    expect(pickedFileName({ name: 'msf:102', uri: 'content://com.android.providers.downloads.documents/document/msf%3A102' })).toBeNull();
    const { c, origin } = nameless(TEXT);
    expect(origin.sourceKey).toBe(namelessSourceKey(fallbackFileName('csv', ''), TEXT));
    // No key matches and a CSV has no guid: before, this was the whole answer ("New deck: Imported deck").
    const s = startOf(c, state, origin);
    expect(prefsTarget(s.first)).toEqual({ kind: 'new', name: 'Imported deck', icon: '🗂️' });
    expect(guidHomeDeck(c, new Set(collectionSections(c).map((x) => x.did)), state)).toBeNull();
    // The first plan (into a new deck) sees the same words in BOTH decks (the device Preview's two
    // "same text" notes); both were planned again, then three-words was chosen.
    expect(s.planned.map((p) => prefsTarget(p))).toEqual([
      { kind: 'new', name: 'Imported deck', icon: '🗂️' },
      { kind: 'existing', deckId: 'gv' },
      { kind: 'existing', deckId },
    ]);
    // Now: the rows are already in three-words (not in German Vocabulary: another card type).
    expect(startDeck(s)).toBe(deckId);
    // The plan the Preview shows is the plan INTO three-words (not the first "New deck" plan).
    expect(s.plan.summary).toMatchObject({ notesAdded: 0, cardsAdded: 0, overlap: [] });
    expect(s.plan.summary.skipped.alreadyHere).toBe(3);
    expect(previewHeadline(s.plan.summary)).toBe('Already up to date');
    expect(previewRows(s.plan.summary, { anki: false, images: true })[1]).toEqual({
      key: 'inTarget',
      label: 'Already in this deck',
      value: '3',
    });
    // The new deck's name stays in the prefs, so "New deck" still says "Imported deck" when chosen.
    expect(s.prefs.deckName).toBe('Imported deck');
  });

  it('a DIFFERENT nameless CSV that shares 1 of 3 words starts on a new deck, as before', () => {
    const { state, deckId } = importNamed(stateOfV3({ decks: [] }), TEXT, 'three-words.csv');
    const other = nameless('Front,Back\nder Hund,the dog\nder Baum,the tree\ndas Geld,the money');
    expect(startDeck(startOf(other.c, state, other.origin))).toBeNull();
    // Two of three rows already there: at least half → that deck (a newer copy of the sheet).
    const newer = nameless('Front,Back\nder Hund,the dog\ndie Katze,the cat\nder Baum,the tree');
    expect(startDeck(startOf(newer.c, state, newer.origin))).toBe(deckId);
  });

  it('review: only when the name was lost on ONE of the two picks — week2.csv never starts on the deck of week1.csv', () => {
    const WEEK1 = 'Front,Back\nder Hund,the dog\ndie Katze,the cat\ndas Haus,the house\nder Baum,the tree';
    const WEEK2 = 'Front,Back\nder Hund,the dog\ndie Katze,the cat\ndas Geld,the money\ndie Zeit,the time';
    const { state, deckId } = importNamed(stateOfV3({ decks: [] }), WEEK1, 'week1.csv');
    // week2.csv, picked WITH its name: 2 of its 4 rows are in "week1" (half), but the two real
    // names say these are two files → "New deck: week2", as before wave 5g.
    const week2 = named(WEEK2, 'week2.csv');
    const s = startOf(week2.c, state, week2.origin);
    expect(startDeck(s)).toBeNull();
    expect(s.prefs.deckName).toBe('week2');
    expect(s.planned).toHaveLength(1); // "week1" was not even planned again
    // The shared words are the same-text note there, with "Skip these 2".
    expect(s.plan.summary.overlap).toEqual([{ deckId, deckName: 'week1', notes: 2 }]);
    // The same week2 rows picked WITHOUT a name: the name is unknown, so the rows decide.
    const lost = nameless(WEEK2);
    expect(startDeck(startOf(lost.c, state, lost.origin))).toBe(deckId);

    // The other order of E8: the FIRST pick lost the name (deck "Imported deck", nameless key),
    // the second pick has it → the rows find that deck too.
    const first = nameless(WEEK1);
    const empty = stateOfV3({ decks: [] });
    const t = defaultTarget([], first.origin, { name: suggestDeckName(first.c), icon: '🗂️' });
    const step = reducer.applyImport(empty, { plan: planFor(first.c, empty, first.origin, t, 'f') }, testCtx(FIXED_NOW));
    expect(step.state.decks[0]).toMatchObject({ name: 'Imported deck', sourceKey: first.origin.sourceKey });
    const again = named(WEEK1, 'week1.csv');
    const s2 = startOf(again.c, step.state, again.origin);
    expect(startDeck(s2)).toBe(step.result.deckId);
    expect(s2.plan.summary.skipped.alreadyHere).toBe(4);

    expect(maybeSameFile('file:week2.csv', 'file:week1.csv')).toBe(false);
    expect(maybeSameFile('file:week1.csv', 'file:primary:Download/week1.csv')).toBe(true);
    expect(maybeSameFile(namelessSourceKey('Imported deck.csv', WEEK2), 'file:week1.csv')).toBe(true);
    expect(maybeSameFile('file:week1.csv', namelessSourceKey('Imported deck.csv', WEEK1))).toBe(true);
    // An old document-id key and a deck with no key name no file: the rows decide.
    expect(maybeSameFile('file:week1.csv', 'file:msf:96')).toBe(true);
    expect(maybeSameFile('file:week1.csv', undefined)).toBe(true);
  });

  it('review: importStartPlan is the whole start — own choices kept, .apkg never re-planned, first-plan changes on the chosen deck', () => {
    const { state, deckId } = importNamed(stateOfV3({ decks: [] }), TEXT, 'three-words.csv');
    const { c, origin } = nameless(TEXT);
    // 1. Back from Fields: the learner's own prefs ("New deck") are planned once and kept.
    const own = { ...startOf(c, state, origin).first, targetKind: 'new' as const, deckName: 'Mine' };
    const back = startOf(c, state, origin, own);
    expect(back.prefs).toBe(own);
    expect(back.planned).toEqual([own]);
    expect(back.plan.summary.skipped.alreadyHere).toBe(0);

    // 2. Not a CSV (csv: null, an .apkg or AnkiWeb deck): the "same text" decks are never planned.
    const planned: string[] = [];
    const fake = (overlap: StartPlan['summary']['overlap'], alreadyHere: number, more: Partial<StartPlan['summary']> = {}) => ({
      summary: {
        overlap,
        skipped: { alreadyHere, elsewhere: 0, overlap: 0, empty: 0 },
        imagesAskFirst: false,
        newCards: 3,
        ...more,
      },
    });
    const newDeck = startingPrefs({ kind: 'new', name: 'German', icon: '🇩🇪' }, { name: 'German', icon: '🇩🇪', decks: state.decks });
    const sameText = [{ deckId, deckName: 'three-words', notes: 3 }];
    const apkg = importStartPlan({
      earlier: null,
      first: newDeck,
      home: null,
      csv: null,
      decks: state.decks,
      triageReady: true,
      planWith: (p) => {
        planned.push(prefsTarget(p).kind);
        return fake(sameText, 0);
      },
    });
    expect(planned).toEqual(['new']);
    expect(apkg.prefs).toBe(newDeck);

    // 3. A CSV that moves to its deck: the first-plan changes are read from the plan INTO that
    //    deck (here its images ask first), and the final plan is planned with the final prefs.
    planned.length = 0;
    const csv = importStartPlan({
      earlier: null,
      first: newDeck,
      home: null,
      csv: { rows: 3, sourceKey: origin.sourceKey },
      decks: state.decks,
      triageReady: true,
      planWith: (p) => {
        const there = prefsTarget(p);
        planned.push(there.kind === 'existing' ? `${there.deckId}${p.images ? '' : ' (no images)'}` : 'new');
        return there.kind === 'existing' ? fake([], 3, { imagesAskFirst: true }) : fake(sameText, 0);
      },
    });
    expect(planned).toEqual(['new', deckId, `${deckId} (no images)`]);
    expect(csv.prefs).toMatchObject({ targetKind: 'existing', existingDeckId: deckId, images: false, deckName: 'German' });
  });
});

describe('wave 5g (review) — a nameless .apkg pick into a deck of a real file never names the made-up file', () => {
  /** An Anki file with one Front/Back model and these guids. */
  const apkg = (guids: string[], fileName: string): AnkiCollection => ({
    ...collection(guids, fileName),
    models: {
      m1: {
        name: 'Basic',
        type: 0,
        sortf: 0,
        flds: [
          { name: 'Front', ord: 0 },
          { name: 'Back', ord: 1 },
        ],
        tmpls: [{ name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}' }],
      },
    },
  });
  /** The import screen's plan of `c` into `target` (the real planner and reducer). */
  const importInto = (
    state: DataStateV3,
    c: AnkiCollection,
    origin: ReturnType<typeof importOrigin>,
    target: ImportChoices['target'],
    at: number,
  ) => {
    const plan = planImport(
      c,
      state,
      {
        sections: new Set(collectionSections(c).map((s) => s.did)),
        target,
        types: choiceTypes(c, startingTypes(c, suggestMapping(c), state.noteTypes)),
        progress: 'keep',
        arrival: 'queued',
        elsewhere: 'update',
        images: true,
      },
      importPlanCtx({ now: at, seed: `s${at}`, srs: DEFAULT_SRS, origin }),
    );
    return reducer.applyImport(state, { plan }, testCtx(at));
  };
  /** The header line exactly as the deck page builds it ([id].tsx). */
  const headerOf = (state: DataStateV3, deckId: string) => {
    const deck = state.decks.find((d) => d.id === deckId) as Deck;
    const index = libraryIndexOf(state);
    const cards = state.cards.filter((card) => card.deckId === deckId);
    const noteFile = needsNoteSourceFile(deck) ? noteSourceFile(cards, index, deck.sourceKey) : null;
    return deckSourceLine(deck, noteFile, otherSourceFiles(cards, index, deckFileName(deck, noteFile), deck.sourceKey));
  };

  it('v1 picked with its name, then v4 picked from the recent files (no name): still "Imported from German_Vocabulary_v1.apkg"', () => {
    const v1Guids = ['g0', 'g1', 'g2', 'g3'];
    const v1 = apkg(v1Guids, 'German_Vocabulary_v1.apkg');
    const v1Origin = importOrigin({ kind: 'file', fileName: 'German_Vocabulary_v1.apkg', isCsv: false });
    const first = importInto(stateOfV3({ decks: [] }), v1, v1Origin, { kind: 'new', name: 'German Vocabulary', icon: '🇩🇪' }, FIXED_NOW);
    const deckId = first.result.deckId as string;
    expect(headerOf(first.state, deckId)).toBe('Imported from German_Vocabulary_v1.apkg');

    // v4 from the picker's recent files: no real name, so the file is named after its root deck.
    const v4Guids = [...v1Guids, 'g4', 'g5'];
    const madeUp = fallbackFileName('apkg', suggestDeckName(apkg(v4Guids, 'msf:102')));
    expect(madeUp).toBe('German.apkg');
    const key = namelessSourceKey(madeUp, v4Guids.join('\n'));
    const v4Origin = importOrigin({ kind: 'file', fileName: madeUp, isCsv: false }, key);
    // The items' ref is the key without 'file:' — it ends in a hash, not in a file extension.
    expect(v4Origin).toEqual({ kind: 'apkg', ref: key.slice('file:'.length), sourceKey: key });
    expect(realFileName(v4Origin.ref)).toBeNull();
    // guidHomeDeck sends the import into the v1 deck; 2 items are added there.
    const v4 = apkg(v4Guids, madeUp);
    expect(guidHomeDeck(v4, new Set(['1']), first.state)).toBe(deckId);
    const second = importInto(first.state, v4, v4Origin, { kind: 'existing', deckId }, FIXED_NOW + 1000);
    // Destructured: the face guard (face.test.ts) forbids a direct property read of `notes` here.
    const { notes: afterV4 } = second.state;
    expect(afterV4.filter((n) => n.source?.ref === v4Origin.ref)).toHaveLength(2);
    // Never "Imported from German_Vocabulary_v1.apkg and German.apkg" — no file has that name.
    expect(headerOf(second.state, deckId)).toBe('Imported from German_Vocabulary_v1.apkg');
    // The same v4 picked WITH its name does name it.
    const named4 = importOrigin({ kind: 'file', fileName: 'German_Vocabulary_v4.apkg', isCsv: false });
    const v4Named = apkg(v4Guids, 'German_Vocabulary_v4.apkg');
    const third = importInto(first.state, v4Named, named4, { kind: 'existing', deckId }, FIXED_NOW + 1000);
    expect(headerOf(third.state, deckId)).toBe('Imported from German_Vocabulary_v1.apkg and German_Vocabulary_v4.apkg');
  });

  it('a nameless deck’s own items are skipped in both forms (before wave 5g: the made-up name; since: the key’s tail)', () => {
    const key = namelessSourceKey('German.apkg', 'g');
    const tail = key.slice('file:'.length);
    const deck = makeDeckV3({ id: 'd1', name: 'German', source: 'apkg', sourceKey: 'file:msf:96' });
    const item = (i: number, ref: string) =>
      noteWithCards({ deckId: 'd1', typeId: REVERSE, note: { id: `n${i}`, order: i, source: { kind: 'apkg', ref } } });
    const fileOf = (refs: string[], sourceKey: string | undefined) => {
      const state = stateOfV3({ decks: [deck], groups: refs.map((ref, i) => item(i, ref)) });
      return noteSourceFile(state.cards, libraryIndexOf(state), sourceKey);
    };
    // An old document-id deck whose items came from a nameless pick (new form): 2 unnamed items
    // beat 1 item of Extra.csv. (With the old form, 'German.apkg' × 2 named a file that does not exist.)
    expect(fileOf([tail, tail, 'Extra.csv'], 'file:msf:96')).toBeNull();
    expect(fileOf(['German.apkg', 'German.apkg', 'Extra.csv'], 'file:msf:96')).toBe('German.apkg');
    // A nameless deck: its items in the old form AND the new form are its own made-up name.
    expect(fileOf(['German.apkg', 'German.apkg', tail], key)).toBeNull();
    expect(fileOf([tail, tail, 'Extra.csv'], key)).toBeNull();
  });
});

describe('import: deck languages from {{tts}}', () => {
  const de = { fields: [{ role: 'term', lang: 'de_DE' }, { role: 'meaning', lang: 'en-US' }] } as const;
  const deGrammar = { fields: [{ role: 'term', lang: 'en-US' }, { role: 'meaning', lang: 'en-US' }] } as const;
  const noTts = { fields: [{ role: 'term' }, { role: 'meaning' }] } as const;

  it('sets a side only when every card type agrees', () => {
    expect(agreedLanguages([de])).toEqual({ language: 'de-DE', meaningLanguage: 'en-US' });
    expect(agreedLanguages([de, de])).toEqual({ language: 'de-DE', meaningLanguage: 'en-US' });
    // German words + English grammar questions: the fronts disagree.
    expect(agreedLanguages([de, deGrammar])).toEqual({ meaningLanguage: 'en-US' });
    // A card type without {{tts}} is no agreement.
    expect(agreedLanguages([de, noTts])).toEqual({});
    expect(agreedLanguages([])).toEqual({});
  });

  it('a new deck gets them; a language a deck has stays', () => {
    const plan = { deck: makeDeckV3({ id: 'n' }) } as unknown as ImportPlan;
    const next = withDeckLanguages(plan, { language: 'de-DE', meaningLanguage: 'en-US' });
    expect(next.deck).toMatchObject({ language: 'de-DE', meaningLanguage: 'en-US' });
    expect(withDeckLanguages(plan, {})).toBe(plan);
    const noDeck = { deck: null } as unknown as ImportPlan;
    expect(withDeckLanguages(noDeck, { language: 'de-DE' })).toBe(noDeck);
    expect(missingDeckLanguages({ language: 'es-ES' }, { language: 'de-DE', meaningLanguage: 'en-US' })).toEqual({
      meaningLanguage: 'en-US',
    });
  });
});

/* ======================================================================= the deck page (wiring) */

/** The in-memory store of the render tests (every action runs the real reducer on it). */
let mockState: DataStateV3 = stateOfV3({ decks: [] });
let mockDeckId = 'd1';
/** The clock of the render tests (a `mock…` name: jest.mock factories may read it). */
let mockNow = FIXED_NOW;
/** useIsFocused() of the render tests: false = a session is open on top of the page. */
let mockFocused = true;
const mockPush = jest.fn<(href: unknown) => void>();
const mockReplace = jest.fn<(href: unknown) => void>();
const mockDismissTo = jest.fn<(href: unknown) => void>();
const mockBack = jest.fn<() => void>();
const mockShow = jest.fn<(text: string, action?: { label?: string; onAction: () => void }) => void>();

/** Run one reducer command on mockState; returns its result. */
function mockRun<I, R>(command: (s: DataStateV3, input: I, ctx: reducer.ReducerCtx) => { state: DataStateV3; result: R }, input: I): R {
  const step = command(mockState, input, testCtx(FIXED_NOW));
  mockState = step.state;
  return step.result;
}

const mockActions = {
  learn: jest.fn((cardIds: string[]) => mockRun(reducer.learn, { cardIds }).edit.id),
  markKnown: jest.fn((cardIds: string[]) => mockRun(reducer.markKnown, { cardIds }).edit.id),
  setNotStarted: jest.fn((cardIds: string[]) => mockRun(reducer.setNotStarted, { cardIds }).edit.id),
  undoManualEdit: jest.fn((editId: string) => mockRun(reducer.undoManualEdit, { editId })),
  updateDeck: jest.fn((deckId: string, patch: reducer.DeckPatch) => mockRun(reducer.updateDeck, { deckId, patch })),
  setDeckOptions: jest.fn((deckId: string, patch: Parameters<typeof reducer.setDeckOptions>[1]['patch']) =>
    mockRun((s, input: { deckId: string; patch: typeof patch }) => reducer.setDeckOptions(s, input), { deckId, patch }),
  ),
  setDirections: jest.fn((deckId: string, typeId: string, ords: number[]) =>
    mockRun(reducer.setDirections, { deckId, typeId, ords }),
  ),
  updateNoteType: jest.fn((typeId: string, patch: { fields?: FieldDef[] }) => mockRun(reducer.updateNoteType, { typeId, patch })),
  duplicateDeck: jest.fn(() => null),
  deleteDeck: jest.fn(),
  // The deck editor's calls (its "Create deck" test at the end).
  addDeck: jest.fn((input: Parameters<typeof reducer.addDeck>[1]['input']) => mockRun(reducer.addDeck, { input })),
  reorderDecks: jest.fn((deckIds: string[]) => mockRun((st, i: { deckIds: string[] }) => reducer.reorderDecks(st, i), { deckIds })),
};

/** The deck editor's unsaved-changes guard: the 'beforeRemove' listener it adds to the navigation. */
let mockBeforeRemove: ((e: { preventDefault: () => void }) => void) | null = null;
const mockNavigation = {
  addListener: jest.fn((event: string, listener: (e: { preventDefault: () => void }) => void) => {
    if (event === 'beforeRemove') mockBeforeRemove = listener;
    return () => {
      if (mockBeforeRemove === listener) mockBeforeRemove = null;
    };
  }),
};

jest.mock('../../store/selectors', () => {
  const actual = jest.requireActual<typeof import('../../store/selectors')>('../../store/selectors');
  const scope = jest.requireActual<typeof import('../../domain/scope')>('../../domain/scope');
  return {
    ...actual,
    useStateV3: <T,>(selector: (state: DataStateV3) => T): T => selector(mockState),
    useEngine: () => ({ store: { getState: () => mockState }, actions: mockActions }),
    useLibraryIndex: () => scope.libraryIndexOf(mockState),
    useReady: (q: Parameters<typeof scope.readyFor>[1]) => scope.readyFor(mockState, q, scope.matchCtxOf(mockState, mockNow)),
    useSessionLength: (p: Parameters<typeof scope.buildSessionQueue>[0]) =>
      scope.buildSessionQueue(p, mockState, scope.matchCtxOf(mockState, mockNow)).length,
  };
});
jest.mock('../../store/useNow', () => ({ useNow: () => mockNow }));
jest.mock('../../store/SnackbarContext', () => ({
  useSnackbar: () => ({ show: mockShow, snack: null, dismiss: () => undefined }),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, dismissTo: mockDismissTo, back: mockBack, canGoBack: () => true }),
  useLocalSearchParams: () => ({ id: mockDeckId }),
  useIsFocused: () => mockFocused,
  useNavigation: () => mockNavigation,
}));
// The deck editor reads the store through useData() (the deck page uses the selectors).
jest.mock('../../store/DataContext', () => ({ useData: () => ({ state: mockState, actions: mockActions }) }));
jest.mock('expo-speech', () => ({ getAvailableVoicesAsync: () => Promise.resolve([]) }));
jest.mock('../../platform/files', () => ({
  writeCacheFile: (name: string) => ({ name, uri: `file:///cache/${name}` }),
  writeDocumentFile: (name: string) => ({ name, uri: `file:///doc/${name}` }),
}));
jest.mock('../../platform/share', () => ({ shareFile: () => Promise.resolve(true) }));
jest.mock('../../theme/ThemeContext', () => ({
  useColors: () => jest.requireActual<typeof import('../../theme/tokens')>('../../theme/tokens').light,
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
// The OS "Reduce Motion" answer arrives later (a promise): fixed here, so no update lands outside act().
jest.mock('../../store/useReduceMotion', () => ({ useReduceMotion: () => false }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
  mockNow = FIXED_NOW;
  mockFocused = true;
  jest.clearAllMocks();
});

function renderPage(state: DataStateV3, deckId = 'd1'): ReactTestRenderer {
  mockState = state;
  mockDeckId = deckId;
  act(() => {
    renderer = TestRenderer.create(React.createElement(DeckPage));
  });
  return renderer!;
}

/** Render again (the fake store has no subscription: a change needs a re-render). */
function rerender(r: ReactTestRenderer) {
  act(() => r.update(React.createElement(DeckPage)));
}

/** Every text on screen (host Text nodes only). */
function texts(r: ReactTestRenderer): string[] {
  return r.root
    .findAll((n) => (n.type as unknown) === 'Text')
    .map((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children ?? '')));
}

/** The nearest pressable around the first text `text` that has one (a heading with the same words has none). */
function byText(r: ReactTestRenderer, text: string): ReactTestInstance {
  return byTextIn(r.root, text);
}

/** byText, inside one part of the screen (a sheet), for words the page shows too (like a level "B1"). */
function byTextIn(root: ReactTestInstance, text: string): ReactTestInstance {
  const nodes = root.findAll((n) => (n.type as unknown) === 'Text' && n.props.children === text);
  if (nodes.length === 0) throw new Error(`no text ${text}`);
  for (const node of nodes) {
    let at: ReactTestInstance | null = node;
    while (at && typeof at.props.onPress !== 'function') at = at.parent;
    if (at) return at;
  }
  throw new Error(`no pressable around ${text}`);
}

/** The switch whose screen-reader name is `name`. */
function switchOf(r: ReactTestRenderer, name: string): ReactTestInstance {
  const found = r.root.findAll(
    (n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'switch' && n.props.accessibilityLabel === name,
  )[0];
  if (!found) throw new Error(`no switch ${name}`);
  return found;
}

describe('the deck page (wiring)', () => {
  it('"Study {n}" shows readyFor and opens THAT session; Practice and Browse open their routes', () => {
    const state = germanDeck(LEVELS, () => cardInLifeV3('new'));
    const ready = readyFor(state, deckScope('d1'), matchCtxOf(state, FIXED_NOW)).total;
    const r = renderPage(state);
    const all = texts(r);
    expect(all).toContain('German');
    expect(all).toContain('5 cards · 3 sections');
    act(() => byText(r, `Study ${ready}`).props.onPress());
    const route = mockPush.mock.calls[0][0] as { pathname: string; params: Record<string, string> };
    expect(route.pathname).toBe('/session');
    expect(route.params.kind).toBe('scheduled');
    expect(buildSessionQueue({ kind: 'scheduled', q: parseQueryParam(route.params.q) }, state, matchCtxOf(state, FIXED_NOW))).toHaveLength(ready);
    act(() => byText(r, 'Practice').props.onPress());
    expect((mockPush.mock.calls[1][0] as { params: Record<string, string> }).params.kind).toBe('practice');
    act(() => byText(r, 'Browse all 5 cards').props.onPress());
    // Back to the tabs that are already there, onto THEIR Library tab (never a push: see below).
    expect(mockPush).toHaveBeenCalledTimes(2);
    expect(String(mockDismissTo.mock.calls[0][0])).toMatch(/^\/\(tabs\)\/library\?q=.*&nonce=\d+$/);
  });

  // Final review 2026-11: "Browse" pushed '/(tabs)/library' from this ROOT-stack page, and a
  // push in the root stack ADDS a second "(tabs)" route: a second tab bar and Library, more
  // with every Browse, and the learner's own Library tab never got the filter.
  it('Browse goes back to the existing tabs (dismissTo = POP_TO), never stacks a second tab navigator', () => {
    const router = StackRouter({});
    const config = { routeNames: ['(tabs)', 'deck/[id]', 'triage', 'session'], routeParamList: {}, routeGetIdList: {} };
    type Stack = ReturnType<typeof router.getInitialState>;
    const step = (state: Stack, action: Parameters<typeof router.getStateForAction>[1]): Stack => {
      const next = router.getStateForAction(state, action, config);
      if (next === null) throw new Error('the stack router did not handle the action');
      return next as Stack;
    };
    // Today → a deck page: [(tabs), deck/[id]].
    const onDeck = step(router.getInitialState(config), StackActions.push('deck/[id]', { id: 'd1' }));
    expect(onDeck.routes.map((route) => route.name)).toEqual(['(tabs)', 'deck/[id]']);
    const library = { screen: 'library', params: { q: '{"decks":["d1"]}', nonce: '1' } };
    // What the old push did: a second tab navigator on top of the deck page.
    expect(step(onDeck, StackActions.push('(tabs)', library)).routes.map((route) => route.name)).toEqual([
      '(tabs)',
      'deck/[id]',
      '(tabs)',
    ]);
    // What dismissTo does (expo-router sends POP_TO): back to THE tabs, with the Library params.
    const popTo = { ...CommonActions.navigate('(tabs)', library), type: 'POP_TO' } as Parameters<typeof router.getStateForAction>[1];
    const back = step(onDeck, popTo);
    expect(back.routes.map((route) => route.name)).toEqual(['(tabs)']);
    expect(back.routes[0].key).toBe(onDeck.routes[0].key); // the same tabs, not a new copy
    expect(back.routes[0].params).toMatchObject(library);
  });

  it('only new cards, the new-card limit used up: no "Study ahead", the honest line and Practice', () => {
    const state = germanDeck(LEVELS.slice(0, 3), () => cardInLifeV3('new'), {
      settings: makeSettingsV3({ srs: { dailyNewLimit: 2 } }),
      person: makePersonV3({
        dayDone: { dayKey: dayKeyOf(FIXED_NOW), reviews: 0, neww: 2, checks: 0, newByDeck: { d1: 2 } },
      }),
    });
    const r = renderPage(state);
    const all = texts(r);
    expect(all).toContain('Nothing due');
    expect(all).toContain("Today's new cards are done. Come back tomorrow, or practice.");
    expect(all.some((t) => t.startsWith('Study ahead'))).toBe(false);
    act(() => byText(r, 'Practice · 3').props.onPress());
    const route = mockPush.mock.calls[0][0] as { params: Record<string, string> };
    expect(route.params.kind).toBe('practice');
  });

  it('Pause deck writes the deck; the page still offers Study (the deck page names the deck)', () => {
    const r = renderPage(germanDeck(LEVELS, () => cardInLifeV3('new')));
    act(() => switchOf(r, 'Pause deck').props.onPress());
    expect(mockActions.updateDeck).toHaveBeenCalledWith('d1', { active: false });
    expect(mockState.decks[0].active).toBe(false);
    rerender(r);
    expect(texts(r)).toContain("This deck is paused. Its cards don't show on Today.");
    expect(texts(r).some((t) => /^Study \d+$/.test(t))).toBe(true);
  });

  it('"Add the next 50 in order" learns the first items (all directions), with Undo', () => {
    const deck = makeDeckV3({ id: 'd1', name: 'Words' });
    const groups = Array.from({ length: 3 }, (_, i) =>
      noteWithCards({ deckId: 'd1', typeId: REVERSE, note: { id: `n${i}`, order: i }, card: () => lifeValues(i === 0 ? 'new' : 'notStarted') }),
    );
    const r = renderPage(stateOfV3({ decks: [deck], groups }));
    // Wave 5b (walkthrough M6): two cards per item, so the line and the button say "items".
    expect(texts(r)).toContain('4 cards (2 items) are not started yet.');
    act(() => byText(r, 'Add the next 2 items in order').props.onPress());
    expect(mockActions.learn).toHaveBeenCalledTimes(1);
    expect(mockActions.learn.mock.calls[0][0]).toHaveLength(4);
    expect(mockState.cards.every((c) => life(c) === 'new')).toBe(true);
    const [text, action] = mockShow.mock.calls[0];
    expect(text).toBe('4 cards (2 items) added to your queue');
    act(() => action!.onAction());
    expect(mockState.cards.filter((c) => life(c) === 'notStarted')).toHaveLength(4);
    act(() => byText(r, 'Choose what to learn').props.onPress());
    expect(String(mockPush.mock.calls[0][0])).toMatch(/^\/triage\?q=.*&from=deck$/);
  });

  it('an empty deck: "This deck is empty." with Add your first card / Import cards into this deck', () => {
    const r = renderPage(stateOfV3({ decks: [makeDeckV3({ id: 'd1', name: 'New deck' })] }));
    expect(texts(r)).toContain('This deck is empty.');
    act(() => byText(r, 'Add your first card').props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/card-editor', params: { deckId: 'd1' } });
    act(() => byText(r, 'Import cards into this deck').props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/import', params: { source: 'file', deckId: 'd1' } });
  });

  it('a deck that is gone says so, with one way out', () => {
    const r = renderPage(stateOfV3({ decks: [] }), 'gone');
    expect(texts(r)).toContain('This deck no longer exists');
    act(() => byText(r, 'Close').props.onPress());
    expect(mockBack).toHaveBeenCalled();
  });

  it('the German rows: Noun genders and Check known cards write the deck', () => {
    const r = renderPage(germanDeck(LEVELS, () => cardInLifeV3('new')));
    act(() => switchOf(r, 'Noun genders (German)').props.onPress());
    expect(mockActions.updateDeck).toHaveBeenCalledWith('d1', { genderColors: false });
    act(() => switchOf(r, 'Check known cards').props.onPress());
    expect(mockActions.setDeckOptions).toHaveBeenCalledWith('d1', { knownChecks: false });
    expect(mockState.decks[0].options.knownChecks).toBe(false);
  });

  it('a deck with 0 new cards a day: no "Today\'s new cards are done", Practice is the way', () => {
    const state = germanDeck(LEVELS.slice(0, 3), () => cardInLifeV3('new'), {
      decks: [makeDeckV3({ id: 'd1', name: 'German', options: { newPerDay: 0 } })],
    });
    const r = renderPage(state);
    const all = texts(r);
    expect(all).toContain('Nothing due');
    expect(all).not.toContain("Today's new cards are done. Come back tomorrow, or practice.");
    act(() => byText(r, 'Practice · 3').props.onPress());
    expect((mockPush.mock.calls[0][0] as { params: Record<string, string> }).params.kind).toBe('practice');
  });

  it('Card types & fields: a label typed key by key is saved as typed ("Word (DE)", not "(DE)")', () => {
    const r = renderPage(germanDeck(LEVELS, () => cardInLifeV3('new')));
    act(() => byText(r, 'Card types & fields').props.onPress());
    act(() => byText(r, 'Word').props.onPress());
    const input = () =>
      r.root.findAll((n) => n.props.accessibilityLabel === 'Label' && typeof n.props.onChangeText === 'function')[0];
    const typed = 'Word (DE)';
    for (let i = 1; i <= typed.length; i += 1) {
      act(() => input().props.onChangeText(typed.slice(0, i)));
      expect(input().props.value).toBe(typed.slice(0, i)); // the box never empties itself
    }
    act(() => byText(r, 'Done').props.onPress());
    act(() => byText(r, 'Save').props.onPress());
    expect(mockActions.updateNoteType).toHaveBeenCalledTimes(1);
    const typeId = mockActions.updateNoteType.mock.calls[0][0];
    expect(mockState.noteTypes.find((t) => t.id === typeId)!.fields[0]).toMatchObject({ name: 'Word', label: 'Word (DE)' });
  });

  it('a row menu with a turned-off direction: "Learn all {n}" counts and changes only the direction that is on', () => {
    const deck = makeDeckV3({ id: 'd1', name: 'Words', options: { directions: { [REVERSE]: [0] } } });
    const groups = [
      ...[0, 1].map((i) =>
        noteWithCards({ deckId: 'd1', typeId: REVERSE, note: { id: `n${i}`, order: i, section: 'Vocabulary' }, card: () => lifeValues('notStarted') }),
      ),
      noteWithCards({ deckId: 'd1', typeId: REVERSE, note: { id: 'n2', order: 2, section: 'Verbs' } }),
    ];
    const r = renderPage(stateOfV3({ decks: [deck], groups }));
    const more = r.root.findAll((n) => n.props.accessibilityLabel === 'Actions for Section Vocabulary' && typeof n.props.onPress === 'function')[0];
    act(() => more.props.onPress());
    // 4 Not started cards in the bar, but only 2 in the direction that is on.
    expect(texts(r)).toContain('Learn all 2');
    act(() => byText(r, 'Learn all 2').props.onPress());
    const ids = mockActions.learn.mock.calls[0][0];
    expect(ids).toHaveLength(2);
    expect(ids.map((id) => mockState.cards.find((c) => c.id === id)!.ord)).toEqual([0, 0]);
    // The turned-off direction stays Not started: it comes back as it was.
    expect(mockState.cards.filter((c) => c.ord === 1 && c.noteId !== 'n2').map(life)).toEqual(['notStarted', 'notStarted']);
  });

  it('Not started cards only in a turned-off direction: no "Choose what to learn" (triage would have nothing)', () => {
    // 'Back → Front' (ord 1) is off and holds the only Not started cards.
    const deck = makeDeckV3({ id: 'd1', name: 'Words', options: { directions: { [REVERSE]: [0] } } });
    const stateWith = (on: 'new' | 'known') =>
      stateOfV3({
        decks: [deck],
        groups: [0, 1].map((i) =>
          noteWithCards({
            deckId: 'd1',
            typeId: REVERSE,
            note: { id: `n${i}`, order: i },
            card: (ord) => lifeValues(ord === 0 ? on : 'notStarted'),
          }),
        ),
      });
    // 1. Every item of the direction that is on was chosen (New): Study, but no Choose block.
    const r = renderPage(stateWith('new'));
    let all = texts(r);
    expect(all).toContain('New 2 · Not started 2'); // the legend still counts every card
    expect(all.some((t) => /^Study \d+$/.test(t))).toBe(true);
    expect(all).not.toContain('Choose what to learn');
    expect(all.some((t) => t.endsWith('not started yet.'))).toBe(false);
    act(() => r.unmount());
    renderer = null;
    // 2. Every card of the direction that is on is Known: not "Nothing from this deck is in your queue yet."
    const r2 = renderPage(stateWith('known'));
    all = texts(r2);
    expect(all).toContain('Not started 2 · Known 2');
    expect(all).not.toContain('Nothing from this deck is in your queue yet.');
    expect(all).not.toContain('Choose what to learn');
    expect(all).toContain('Nothing due');
  });

  it('"Where do you start?" B1 + "I know them": A1 and A2 Known (with Undo), then Choose what to learn from B1 up', () => {
    const r = renderPage(germanDeck(LEVELS));
    act(() => byText(r, 'Where do you start?').props.onPress());
    const sheet = r.root.findByType(PlacementSheet);
    act(() => byTextIn(sheet, 'B1').props.onPress());
    act(() => byTextIn(sheet, 'Start at B1').props.onPress());
    // The easier levels: n0, n1 (A1) and n2 (A2) are Known now.
    expect(mockActions.markKnown).toHaveBeenCalledTimes(1);
    const known = mockActions.markKnown.mock.calls[0][0].map((id) => mockState.cards.find((c) => c.id === id)!.noteId).sort();
    expect(known).toEqual(['n0', 'n1', 'n2']);
    const [text, action] = mockShow.mock.calls[0];
    expect(text).toBe('3 cards marked as known');
    expect(action?.onAction).toBeDefined();
    // Then "Choose what to learn" opens over B1 and up (only Not started cards).
    const href = String(mockPush.mock.calls[0][0]);
    // `placed=1`: the triage does not offer "Where do you start?" a second time.
    expect(href).toMatch(/^\/triage\?q=.*&from=deck&placed=1$/);
    const q = parseQueryParam(decodeURIComponent(href.slice('/triage?q='.length, href.indexOf('&'))));
    expect(q).toEqual({ decks: ['d1'], fields: { level: ['b1'] }, life: ['notStarted'] });
  });

  it('"Where do you start?" at the first level: nothing changes, Choose what to learn opens over the WHOLE deck', () => {
    // One item has an empty Level field: it must be in the triage too.
    const state = germanDeck([...LEVELS, { term: 'das Ding', meaning: 'thing', level: '' }]);
    const r = renderPage(state);
    act(() => byText(r, 'Where do you start?').props.onPress());
    act(() => byTextIn(r.root.findByType(PlacementSheet), 'Start at A1').props.onPress());
    expect(mockActions.markKnown).not.toHaveBeenCalled();
    expect(mockActions.setNotStarted).not.toHaveBeenCalled();
    const href = String(mockPush.mock.calls[0][0]);
    expect(href.endsWith('&from=deck&placed=1')).toBe(true);
    const q = parseQueryParam(decodeURIComponent(href.slice('/triage?q='.length, href.indexOf('&'))));
    // Before wave 5: { fields: { level: ['a1', 'a2', 'b1'] } } — "das Ding" was silently left out.
    expect(q).toEqual({ decks: ['d1'], life: ['notStarted'] });
    const ctx = matchCtxOf(state, FIXED_NOW);
    const items = triageItems(scopePool(state, q, ctx, 'browse'), triageLookupOf(state, ctx));
    expect(items.map((i) => i.noteId)).toContain(`n${LEVELS.length}`);
    expect(items).toHaveLength(LEVELS.length + 1);
  });

  it('a hidden page counts nothing again: not when it loses focus, not when the clock ticks, not on a rating', () => {
    const scopeApi = jest.requireActual<typeof import('../../domain/scope')>('../../domain/scope');
    const facetsApi = jest.requireActual<typeof import('../../domain/facets')>('../../domain/facets');
    const r = renderPage(germanDeck(LEVELS, () => cardInLifeV3('new')));
    const readySpy = jest.spyOn(scopeApi, 'readyFor');
    const spies = [
      readySpy,
      jest.spyOn(scopeApi, 'scopePool'),
      jest.spyOn(scopeApi, 'buildSessionQueue'),
      jest.spyOn(facetsApi, 'deriveFacets'),
    ];
    const calls = () => spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
    try {
      // A session opens on top of the page, and the clock ticks twice while it runs.
      mockFocused = false;
      rerender(r);
      mockNow = FIXED_NOW + 60_000;
      rerender(r);
      mockNow = FIXED_NOW + 120_000;
      rerender(r);
      // A rating in that session: the cards change.
      mockState = { ...mockState, cards: mockState.cards.map((c) => ({ ...c })) };
      rerender(r);
      expect(calls()).toBe(0);
      // Back on the page: it counts again, once, at the new time.
      mockFocused = true;
      rerender(r);
      expect(readySpy).toHaveBeenCalledTimes(1);
      expect(readySpy.mock.calls[0][2].now).toBe(FIXED_NOW + 120_000);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

/** The chip (a pressable whose screen-reader name is `label`), like a mode in the ModeSheet. */
function chipOf(r: ReactTestRenderer, label: string): ReactTestInstance {
  const found = r.root.findAll(
    (n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  )[0];
  if (!found) throw new Error(`no chip ${label}`);
  return found;
}

/** The params of the n-th route the page pushed. */
const pushedParams = (n: number) => (mockPush.mock.calls[n][0] as { params: Record<string, string | undefined> }).params;

describe('the deck page (wiring), wave 5b walkthrough fixes', () => {
  it('M4: a mode picked in "More ways to study" opens the NEXT session only; then the default mode again', () => {
    const state = germanDeck(LEVELS, () => cardInLifeV3('new'));
    const ctx = matchCtxOf(state, FIXED_NOW);
    const ready = readyFor(state, deckScope('d1'), ctx).total;
    const practice = buildSessionQueue({ kind: 'practice', q: deckScope('d1') }, state, ctx).length;
    const r = renderPage(state);
    act(() => byText(r, 'More ways to study ›').props.onPress());
    // The sheet says what really happens (not "Only for this session").
    expect(texts(r)).toContain(MODE_SCOPE_COPY_DECK);
    expect(texts(r)).not.toContain(MODE_SCOPE_COPY);
    act(() => chipOf(r, 'Quiz').props.onPress());
    expect(texts(r)).toContain('Next session: Quiz');
    // The next session gets Quiz …
    act(() => byText(r, `Practice all · ${practice}`).props.onPress());
    expect(pushedParams(0)).toMatchObject({ kind: 'practice', mode: 'mc' });
    // … and the pick is used up: the page and the next Study use the default mode again.
    expect(texts(r).some((t) => t.startsWith('Next session'))).toBe(false);
    act(() => byText(r, `Study ${ready}`).props.onPress());
    expect(pushedParams(1).kind).toBe('scheduled');
    expect(pushedParams(1).mode).toBeUndefined();
    // Picking the default mode is no pick at all.
    act(() => byText(r, 'More ways to study ›').props.onPress());
    act(() => chipOf(r, 'Typing').props.onPress());
    act(() => chipOf(r, 'Flashcards').props.onPress());
    expect(texts(r).some((t) => t.startsWith('Next session'))).toBe(false);
  });

  it('M6: the choose block names its items, and "Add the next {n} items" adds exactly those', () => {
    // 6 items × 2 directions Not started + 1 item New (the walkthrough's "12 cards … Add the next 6").
    const deck = makeDeckV3({ id: 'd1', name: 'German' });
    const groups = Array.from({ length: 7 }, (_, i) =>
      noteWithCards({ deckId: 'd1', typeId: REVERSE, note: { id: `n${i}`, order: i }, card: () => lifeValues(i === 0 ? 'new' : 'notStarted') }),
    );
    const r = renderPage(stateOfV3({ decks: [deck], groups }));
    expect(texts(r)).toContain('12 cards (6 items) are not started yet.');
    act(() => byText(r, 'Add the next 6 items in order').props.onPress());
    expect(mockActions.learn.mock.calls[0][0]).toHaveLength(12);
    expect(mockShow.mock.calls[0][0]).toBe('12 cards (6 items) added to your queue');
  });

  it('M7: "Practice your hardest · {n}" is in More ways to study, and n is the session it opens', () => {
    // The walkthrough deck: 2 Learning cards, the rest New (no card is "Hard" yet).
    const state = germanDeck(LEVELS, (i) => cardInLifeV3(i < 2 ? 'learning' : 'new'));
    const n = buildSessionQueue(hardestSession('d1'), state, matchCtxOf(state, FIXED_NOW)).length;
    expect(n).toBeGreaterThan(0);
    const r = renderPage(state);
    act(() => byText(r, 'More ways to study ›').props.onPress());
    act(() => byText(r, `Practice your hardest · ${n}`).props.onPress());
    const params = pushedParams(0);
    expect(params).toMatchObject({ kind: 'practice', label: 'German', sort: '{"by":"hardest"}' });
    expect(parseQueryParam(params.q)).toEqual({ decks: ['d1'] });
  });

  it('M7 + L15: the Algo deck shows "By section"; its made-up file name is never shown', () => {
    const r = renderPage(algoState());
    const all = texts(r);
    // The picker gave no name: the key and the items carry a name made up from the root deck.
    // The real file is "Algo_Patterns.apkg", so the header says only "Imported".
    expect(all).toContain('4 cards · 3 sections · Imported');
    expect(all.some((t) => t.includes('Algo Deck.apkg'))).toBe(false);
    expect(all).toContain('By section');
    for (const label of ['Core Patterns', 'Dynamic Programming', 'Advanced Patterns']) {
      expect(r.root.findAll((n) => n.props.accessibilityLabel === `Actions for Section ${label}` && typeof n.props.onPress === 'function')).toHaveLength(1);
    }
  });

  it('M6: the row menu counts the items the triage counts, and its snackbars use the triage\'s words (two directions)', () => {
    const state = bothWaysDeck(() => lifeValues('notStarted'));
    const ctx = matchCtxOf(state, FIXED_NOW);
    const lookup = triageLookupOf(state, ctx);
    /** What the triage over one level shows: its counter, its bulk button and the snackbar of that button. */
    const triageOf = (level: string) => {
      const run = startRun(triageItems(scopePool(state, notStartedScope(valueScope('d1', 'field:level', level)), ctx, 'browse'), lookup));
      const left = leftItems(run);
      return {
        position: positionLabel(run),
        bulk: bulkLabels(run),
        learnSnack: stepSnack('learnAll', cardIdsOf(left).length, left.length),
        knownSnack: stepSnack('knownAll', cardIdsOf(left).length, left.length),
      };
    };
    const a1 = triageOf('a1');
    expect(a1.position).toBe('0 / 2 items');
    expect(a1.bulk).toEqual({ learn: 'Learn all 2 items left', known: 'Mark all 2 items known' });

    const r = renderPage(state);
    const more = (label: string) =>
      r.root.findAll((n) => n.props.accessibilityLabel === `Actions for Level ${label}` && typeof n.props.onPress === 'function')[0];
    expect(texts(r)).toContain('10 cards (5 items) are not started yet.');
    // Level A1: 4 cards in the bar, 2 items in the menu — the 2 of the triage's "Learn all 2 items left".
    act(() => more('A1').props.onPress());
    let all = texts(r);
    expect(all).toContain('Learn all 2 items');
    expect(all).toContain('Mark all 2 items as known');
    expect(all).not.toContain('Learn all 4');
    act(() => byText(r, 'Learn all 2 items').props.onPress());
    expect(mockActions.learn.mock.calls[0][0]).toHaveLength(4);
    expect(mockShow.mock.calls[0][0]).toBe(a1.learnSnack);
    expect(mockShow.mock.calls[0][0]).toBe('4 cards (2 items) added to your queue');
    expect(mockShow.mock.calls[0][1]?.onAction).toBeDefined(); // with Undo

    // Level B1, "Mark all as known": the triage's "Mark all 2 items known", in its words.
    const b1 = triageOf('b1');
    rerender(r);
    act(() => more('B1').props.onPress());
    all = texts(r);
    expect(all).toContain('Mark all 2 items as known');
    act(() => byText(r, 'Mark all 2 items as known').props.onPress());
    expect(mockActions.markKnown.mock.calls[0][0]).toHaveLength(4);
    expect(mockShow.mock.calls[1][0]).toBe(b1.knownSnack);
    expect(mockShow.mock.calls[1][0]).toBe('4 cards (2 items) marked as known');
  });

  it('M6: "Where do you start?" on the deck page says what the triage says for the same choice', () => {
    const state = bothWaysDeck(() => lifeValues('notStarted'));
    const ctx = matchCtxOf(state, FIXED_NOW);
    // The triage's own "Where do you start? → Start at B1 · I know them" (triage.tsx applyPlacement).
    const q = notStartedScope(deckScope('d1'));
    const pool = sortScopeCards(scopePool(state, q, ctx, 'browse'), { by: 'source' }, state, ctx);
    const run = startRun(triageItems(pool, triageLookupOf(state, ctx)));
    const group = placementGroups(pool, deriveFacets(state.cards, q, {}, ctx), ctx.index)[0];
    expect(group.values.map((v) => v.label)).toEqual(['A1', 'A2', 'B1']);
    const easier = easierNotes(run.queue, group, 2, ctx.index).map((id) => run.items.get(id)!);
    const triageSnack = stepSnack('place', cardIdsOf(easier).length, easier.length);
    expect(triageSnack).toBe('6 cards (3 items) marked as known');

    // The deck page, the same choice: the same words and numbers.
    const r = renderPage(state);
    act(() => byText(r, 'Where do you start?').props.onPress());
    const sheet = r.root.findByType(PlacementSheet);
    act(() => byTextIn(sheet, 'B1').props.onPress());
    act(() => byTextIn(sheet, 'Start at B1').props.onPress());
    expect(mockActions.markKnown.mock.calls[0][0]).toHaveLength(6);
    expect(mockShow.mock.calls[0][0]).toBe(triageSnack);
    act(() => r.unmount());
    renderer = null;

    // "Leave them not started": the New cards of A1 and A2 go back, counted the same way.
    jest.clearAllMocks();
    const r2 = renderPage(bothWaysDeck(() => lifeValues('new')));
    act(() => byText(r2, 'Where do you start?').props.onPress());
    const sheet2 = r2.root.findByType(PlacementSheet);
    act(() => byTextIn(sheet2, 'B1').props.onPress());
    act(() => byTextIn(sheet2, 'Leave them not started').props.onPress());
    act(() => byTextIn(sheet2, 'Start at B1').props.onPress());
    expect(mockActions.setNotStarted.mock.calls[0][0]).toHaveLength(6);
    expect(mockShow.mock.calls[0][0]).toBe('6 cards (3 items) moved back to Not started');
  });

  it('L15: an old "file:msf:96" deck names the file of its items', () => {
    const deck = makeDeckV3({ id: 'd1', name: 'German', source: 'apkg', sourceKey: 'file:msf:96' });
    const groups = [0, 1].map((i) =>
      noteWithCards({ deckId: 'd1', note: { id: `n${i}`, order: i, source: { kind: 'apkg', ref: 'German_Complete.apkg' } } }),
    );
    const r = renderPage(stateOfV3({ decks: [deck], groups }));
    expect(texts(r)).toContain('2 cards · Imported from German_Complete.apkg');
  });
});

/* ======================================================================= the deck editor (wiring) */

describe('the deck editor: "Create deck" opens the new deck’s page (spec §8.10)', () => {
  it('replaces the editor with /deck/[id] of the NEW deck, and the unsaved-changes guard lets it through', async () => {
    mockState = stateOfV3({ decks: [makeDeckV3({ id: 'd-old', name: 'Old', order: 0 })] });
    // A create, not a rename: the route has no deckId.
    mockDeckId = '';
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(DeckEditorScreen));
    });
    const r = renderer!;
    const nameBox = r.root.findAll((n) => n.props.accessibilityLabel === 'Deck name *' && typeof n.props.onChangeText === 'function')[0];
    act(() => nameBox.props.onChangeText('World capitals'));
    act(() => byText(r, 'Create deck').props.onPress());
    // The deck is in the store, last in the list.
    expect(mockActions.addDeck).toHaveBeenCalledTimes(1);
    const created = mockState.decks.find((d) => d.name === 'World capitals');
    expect(created).toBeDefined();
    // The route: the new deck's page REPLACES the editor (it never goes back to where it came from).
    expect(mockReplace).toHaveBeenCalledWith({ pathname: '/deck/[id]', params: { id: created!.id } });
    expect(mockBack).not.toHaveBeenCalled();
    expect(mockShow).toHaveBeenCalledWith('Deck “World capitals” created');
    // The replace removes the editor: the guard must NOT stop it (the deck IS saved) …
    expect(mockBeforeRemove).not.toBeNull();
    const preventDefault = jest.fn();
    act(() => mockBeforeRemove!({ preventDefault }));
    expect(preventDefault).not.toHaveBeenCalled();
    // … and the "Discard changes?" sheet stays closed.
    expect(texts(r)).not.toContain('Discard changes?');
  });

  it('the guard still stops an exit with unsaved changes (the name typed, nothing created)', async () => {
    mockState = stateOfV3({ decks: [] });
    mockDeckId = '';
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(DeckEditorScreen));
    });
    const r = renderer!;
    const nameBox = r.root.findAll((n) => n.props.accessibilityLabel === 'Deck name *' && typeof n.props.onChangeText === 'function')[0];
    act(() => nameBox.props.onChangeText('Half done'));
    const preventDefault = jest.fn();
    act(() => mockBeforeRemove!({ preventDefault }));
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(texts(r)).toContain('Discard changes?');
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

/* ===================================================== final review 2026-11: the delete sheet and the words */

describe('DeleteDeckSheet (final review 2026-11)', () => {
  const deck = { id: 'd1', name: 'Capitals' };
  const others = [{ id: 'd2', name: 'Spanish', icon: '🇪🇸' }];

  function renderSheet(props: Partial<React.ComponentProps<typeof DeleteDeckSheet>> = {}) {
    const onConfirm = jest.fn<React.ComponentProps<typeof DeleteDeckSheet>['onConfirm']>();
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(DeleteDeckSheet, {
          open: true,
          onClose: () => undefined,
          deck,
          cardCount: 5,
          otherDecks: others,
          unfiled: null,
          onConfirm,
          ...props,
        }),
      );
    });
    return { r: renderer!, onConfirm };
  }

  /** The focusable rows a screen reader reads as radio buttons: [label, checked]. */
  const radios = (r: ReactTestRenderer) =>
    r.root
      .findAll((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'radio' && typeof n.props.onPress === 'function')
      .map((n) => [n.props.accessibilityLabel as string, n.props.accessibilityState?.checked as boolean] as const);

  it('each option IS a radio button with its checked state (a child state was never read)', () => {
    const { r } = renderSheet();
    const first = radios(r);
    expect(first.map(([label]) => label.split('.')[0])).toEqual([
      'Move cards to another deck',
      'Keep cards, remove the deck',
      'Delete deck and all its cards',
    ]);
    expect(first.map(([, checked]) => checked)).toEqual([true, false, false]);
    // The drawn circle is not a second radio: only the rows are.
    expect(r.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'radio')).toHaveLength(
      first.length,
    );
    act(() => byText(r, 'Keep cards, remove the deck').props.onPress());
    expect(radios(r).map(([, checked]) => checked)).toEqual([false, true, false]);
  });

  it('"Delete deck and all its cards" needs a 1-second hold — a tap does nothing; Move is one tap', () => {
    const { r, onConfirm } = renderSheet();
    // Move (the default): a plain "Delete deck" button.
    expect(r.root.findAllByType(HoldButton)).toHaveLength(0);
    act(() => byText(r, 'Delete deck').props.onPress());
    expect(onConfirm).toHaveBeenLastCalledWith({ kind: 'move', targetDeckId: 'd2' }, 'move', 'Spanish');

    act(() => byText(r, 'Delete deck and all its cards').props.onPress());
    expect(texts(r)).not.toContain('Delete deck');
    const hold = r.root.findByType(HoldButton);
    expect(hold.props.children).toBe(DELETE_EVERYTHING_HOLD);
    expect(DELETE_EVERYTHING_HOLD).toBe('Hold to delete everything');
    expect(hold.props.kind).toBe('dangerSolid');
    // No tap action: the pressable only starts / stops the hold.
    const pressable = r.root.findAll(
      (n) =>
        typeof n.type !== 'string' && n.props.accessibilityLabel === DELETE_EVERYTHING_HOLD && n.props.accessibilityRole === 'button',
    )[0];
    expect(pressable.props.onPress).toBeUndefined();
    expect(pressable.props.accessibilityHint).toBe('Press and hold for one second.');
    onConfirm.mockClear();
    // The screen-reader way to hold: the "longpress" action confirms.
    act(() => pressable.props.onAccessibilityAction({ nativeEvent: { actionName: 'longpress' } }));
    expect(onConfirm).toHaveBeenCalledWith({ kind: 'delete' }, 'all', '');
  });

  it('a deck without cards: one tap ("Delete deck"), nothing to lose', () => {
    const { r, onConfirm } = renderSheet({ cardCount: 0 });
    expect(r.root.findAllByType(HoldButton)).toHaveLength(0);
    act(() => byText(r, 'Delete deck').props.onPress());
    expect(onConfirm).toHaveBeenCalledWith({ kind: 'delete' }, 'all', '');
  });
});

describe('screen-reader words: "1 card", never "1 cards" (final review 2026-11)', () => {
  it('the deck header bar: "Deck: 0 mastered of 1 card"', () => {
    const counts = { notStarted: 0, new: 1, learning: 0, review: 0, mastered: 0, known: 0 };
    expect(barLabel('Deck', counts, 1)).toBe('Deck: 0 mastered of 1 card');
    expect(barLabel('German', { ...counts, mastered: 312 }, 15960)).toBe('German: 312 mastered of 15,960 cards');
  });

  it('the new-cards stepper: "1 new card a day"', () => {
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(NewCardsSheet, {
          open: true,
          onClose: () => undefined,
          options: makeDeckV3({ id: 'd1', options: { newPerDay: 1 } }).options,
          dailyNewLimit: 20,
          onChange: () => undefined,
        }),
      );
    });
    const values = renderer!.root
      .findAll((n) => typeof n.type !== 'string' && typeof n.props.accessibilityValue?.text === 'string')
      .map((n) => n.props.accessibilityValue.text as string);
    expect(values).toContain('1 new card a day');
    expect(values.some((v) => v.includes('1 new cards'))).toBe(false);
  });
});
