/**
 * The Progress tab and the Help screen (spec §8.8, §8.9, unit W4-6).
 *
 * Part 1 — the pure logic (progressLogic.ts): the hero, TODAY, NEXT 7 DAYS,
 * ACTIVITY, BY DECK and "{DECK} · BY {GROUP}" numbers, the links, and the
 * history export (sessions CSV + review CSV in one zip, then the share
 * sheet). Known is never counted as mastered; every count says "1 card",
 * never "1 cards" (device finding 2026-10-24).
 *
 * Part 2 — the screens, drawn with react-test-renderer: Progress has no
 * Start or Review button, its rows open the deck page or the Library (with
 * q + nonce), the "5 weeks | 35 weeks" switch sits on its own full-width
 * line (device finding: it ran past the right edge), ⤓ really zips and
 * shares; Help draws every section and `?topic=` scrolls to its section.
 *
 * Module mocks (`jest.mock` below): the store hooks read one test state;
 * the router, the snackbar, the disk, the share sheet and the review
 * history are fakes; icons and the safe area are stubs.
 *
 * Wave 5b (the device walkthrough): the history zip is named in LOCAL time
 * (L8); the "New" goal bar has ONE colour, amber, as on Today (L14,
 * GOAL_BAR_TONE); the tab bar under Progress is solid, so no list text shows
 * through it (L1, `solidColor` of the tabs layout).
 */
// '@jest/globals' first: the jest.mock factories below use its `jest`.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { strFromU8, unzipSync } from 'fflate';
import React from 'react';
import { ScrollView } from 'react-native';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { solidColor } from '../../app/(tabs)/_layout';
import ProgressScreen from '../../app/(tabs)/progress';
import HelpScreen from '../../app/help';
import { HELP_SECTIONS } from '../../content/help';
import { BUILTIN_TYPE_IDS } from '../../domain/builtinTypes';
import { dueForecast } from '../../domain/forecast';
import { levelInfo, levelNames, xpForLevel } from '../../domain/gamification';
import type { Card, DataStateV3, LifeKey, NoteType, RevlogRow, SessionRecord } from '../../domain/model';
import { parseQueryParam } from '../../domain/query';
import { deckStatsMap, libraryIndexOf, matchCtxOf, scopePool } from '../../domain/scope';
import { chipsOf } from '../../domain/searchParse';
import { DAY, dayKeyOf } from '../../domain/types';
import type { SavedFile } from '../../platform/files';
import { SHARE_HISTORY_ZIP, type ShareKind } from '../../platform/share';
import { historyZipFileName, SESSIONS_CSV_HEADER } from '../../store/backup';
import { REVIEWS_CSV_HEADER } from '../../store/history';
import { FIXED_NOW, localTime } from '../../test/clock';
import { dark, light } from '../../theme/tokens';
import { lifeValues, makeDeckV3, makePersonV3, noteWithCards, stateOfV3 } from '../../test/factoriesV3';
import { GoalBars } from '../today/TodayHero';
import { goalBars } from '../today/todayLogic';
import { SegCtrl } from '../ui/controls';
import { SectionHead } from '../ui/layout';
import { Bar } from '../ui/viz';
import {
  achievementsCount,
  allTimeRows,
  deckHref,
  deckMasteryRows,
  deckRowLine,
  exportStudyHistory,
  forecastBars,
  forecastLabel,
  forecastReader,
  GOAL_BAR_TONE,
  goalBar,
  groupBlocks,
  groupBlocksReader,
  groupHeading,
  HEAT_RANGES,
  heatLevel,
  heatmap,
  historyExportMessage,
  type HistoryExportIO,
  libraryHref,
  libraryTotals,
  masteryText,
  PROGRESS_EMPTY,
  streakText,
  todaySummary,
} from './progressLogic';

/* ================================================================ mocks */

/** The one state the mocked store hooks read. */
let mockState: DataStateV3;
let mockParams: Record<string, string | string[] | undefined> = {};
/** The review history the mocked appRevlogStore gives. */
let mockRevlogRows: RevlogRow[] = [];
const mockPush = jest.fn<(href: unknown) => void>();
const mockNavigate = jest.fn<(href: unknown) => void>();
const mockBack = jest.fn<() => void>();
const mockShow = jest.fn<(text: string) => void>();
const mockWriteCache = jest.fn<(name: string, content: string | Uint8Array) => SavedFile>((name) => ({
  name,
  uri: `file:///cache/${name}`,
}));
const mockDeleteCache = jest.fn<(prefix: string) => string[]>(() => []);
const mockShare = jest.fn<(uri: string, kind: ShareKind) => Promise<boolean>>(() => Promise.resolve(true));

jest.mock('../../store/DataContext', () => ({
  useData: () => ({ state: mockState }),
  normalizedDayDone: jest.requireActual<typeof import('../../store/reducer')>('../../store/reducer').normalizedDayDone,
}));

jest.mock('../../store/selectors', () => {
  const actual = jest.requireActual<typeof import('../../store/selectors')>('../../store/selectors');
  const scope = jest.requireActual<typeof import('../../domain/scope')>('../../domain/scope');
  const now = jest.requireActual<typeof import('../../test/clock')>('../../test/clock').FIXED_NOW;
  return {
    ...actual,
    useStateV3: <T,>(selector: (state: DataStateV3) => T): T => selector(mockState),
    useDeckStatsMap: () => scope.deckStatsMap(mockState, scope.matchCtxOf(mockState, now)),
    useAchievements: () => actual.achievementsOf(mockState),
  };
});

jest.mock('../../store/SnackbarContext', () => ({ useSnackbar: () => ({ show: mockShow, snack: null, dismiss: () => {} }) }));
jest.mock('../../store/useNow', () => ({
  useNow: () => jest.requireActual<typeof import('../../test/clock')>('../../test/clock').FIXED_NOW,
}));
// Only the review history (the real module opens the phone's databases).
jest.mock('../../store/storage', () => ({
  appRevlogStore: () => ({
    all: () => Promise.resolve(mockRevlogRows),
    forCard: () => Promise.resolve([]),
    write: () => Promise.resolve(0),
  }),
}));
jest.mock('../../platform/files', () => ({
  writeCacheFile: (name: string, content: string | Uint8Array) => mockWriteCache(name, content),
  deleteCacheFiles: (prefix: string) => mockDeleteCache(prefix),
}));
jest.mock('../../platform/share', () => ({
  ...jest.requireActual<typeof import('../../platform/share')>('../../platform/share'),
  shareFile: (uri: string, kind: ShareKind) => mockShare(uri, kind),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, navigate: mockNavigate, back: mockBack, canGoBack: () => true }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('../../theme/ThemeContext', () => ({
  useColors: () => jest.requireActual<typeof import('../../theme/tokens')>('../../theme/tokens').light,
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

/* ================================================================ fixtures */

/** Wednesday 10 June 2026, 09:00 local time. */
const NOW = FIXED_NOW;
const TODAY = dayKeyOf(NOW);

/** One legacy German vocabulary note (Level is field 5, Type field 6) with one card in `kind`. */
function vocab(deckId: string, level: string, kind: LifeKey, extra: { type?: string; section?: string } = {}) {
  return noteWithCards({
    deckId,
    typeId: BUILTIN_TYPE_IDS.legacyVocabDe,
    fields: ['Wort', 'word', '', '', '', level, extra.type ?? '', '', '', ''],
    note: extra.section ? { section: extra.section } : {},
    card: lifeValues(kind, NOW),
  });
}

/** One Basic note in `section` with one card in `kind`. */
function basic(deckId: string, section: string, kind: LifeKey) {
  return noteWithCards({ deckId, note: { section }, card: lifeValues(kind, NOW) });
}

/** "German": Level A1 (2 Known), A2 (1 mastered, 1 review), B1 (1 new, 1 not started). */
function german() {
  return [
    vocab('d1', 'A1', 'known'),
    vocab('d1', 'A1', 'known'),
    vocab('d1', 'A2', 'mastered'),
    vocab('d1', 'A2', 'review'),
    vocab('d1', 'B1', 'new'),
    vocab('d1', 'B1', 'notStarted'),
  ];
}

/** The library of the screen tests: German (Level) + a paused deck with one card. */
function library(overrides: Partial<DataStateV3> = {}): DataStateV3 {
  const d1 = makeDeckV3({ id: 'd1', name: 'German', icon: '🇩🇪', order: 0 });
  const d2 = makeDeckV3({ id: 'd2', name: 'Paused deck', icon: '⏸', order: 1, active: false });
  return stateOfV3({ decks: [d1, d2], groups: [...german(), basic('d2', '', 'review')], overrides });
}

let sessionCount = 0;

/** A finished session on `dayKey` with `total` cards. */
function session(dayKey: string, total: number, extra: Partial<SessionRecord> = {}): SessionRecord {
  sessionCount += 1;
  return {
    id: `s-${sessionCount}`,
    dayKey,
    atMs: localTime(dayKey, '10:00'),
    kind: 'scheduled',
    counts: { again: 0, hard: 0, good: total, easy: 0 },
    total,
    bestRun: total,
    xp: total * 4,
    ...extra,
  };
}

/** A fake disk + share sheet + review history for exportStudyHistory. */
function fakeIO(overrides: Partial<HistoryExportIO> = {}) {
  const written: { name: string; content: Uint8Array }[] = [];
  const shared: { uri: string; kind: ShareKind }[] = [];
  const cleared: string[] = [];
  const io: HistoryExportIO = {
    revlog: { all: () => Promise.resolve(mockRevlogRows) },
    writeCache: (name, content) => {
      written.push({ name, content });
      return { name, uri: `file:///cache/${name}` };
    },
    clearCache: (prefix) => {
      cleared.push(prefix);
    },
    share: (uri, kind) => {
      shared.push({ uri, kind });
      return Promise.resolve(true);
    },
    ...overrides,
  };
  return { io, written, shared, cleared };
}

/** One history row. */
function revlogRow(seq: number, cardId: string, extra: Partial<RevlogRow> = {}): RevlogRow {
  return {
    seq,
    cardId,
    deckId: 'd1',
    atMs: NOW - DAY + seq,
    rating: 'good',
    bucket: 'review',
    ivlBefore: 1,
    ivlAfter: 3,
    easeAfter: 2.5,
    durationMs: 4200,
    ...extra,
  };
}

/* ================================================================ part 1: logic */

describe('the hero line', () => {
  test('streakText: "{n}-day streak · best {m}"', () => {
    expect(streakText(12, 30)).toBe('12-day streak · best 30');
    expect(streakText(1, 1)).toBe('1-day streak · best 1');
    expect(streakText(0, 4)).toBe('No streak yet · best 4');
    expect(streakText(0, 0)).toBe('No streak yet');
    expect(streakText(1200, 1500)).toBe('1,200-day streak · best 1,500');
  });

  test('masteryText keeps Known apart from mastered', () => {
    expect(masteryText(312, 1530)).toBe('312 mastered · 1,530 known');
    expect(masteryText(5, 0)).toBe('5 mastered');
  });

  test('libraryTotals: Known cards are never counted as mastered', () => {
    const state = library();
    const totals = libraryTotals(deckStatsMap(state, matchCtxOf(state, NOW)));
    expect(totals).toEqual({ cards: 7, mastered: 1, known: 2 });
  });

  test('the level name: generic by default, the pack names when the pack has some', () => {
    expect(levelInfo(xpForLevel(6), levelNames(undefined)).name).toBe('Keeper');
    expect(levelInfo(xpForLevel(6), levelNames(['a', 'b', 'c', 'd', 'e', 'Linguist'])).name).toBe('Linguist');
  });
});

describe('TODAY', () => {
  const goals = { goalReviews: 30, goalNew: 10 };

  // Adapted in W5-5a: the copy is the spec's (§8.8 "… · New 4 / 10 goal · 9 min"); it said "about 6 min".
  test('the line: goals, then the minutes of today\'s sessions (spec copy "6 min")', () => {
    const sessions = [session(TODAY, 12), session(TODAY, 4), session('2026-06-09', 50)];
    const s = todaySummary({ reviews: 12, neww: 4 }, goals, sessions, TODAY);
    expect(s.studied).toBe(16);
    // minutesFor(16) = round(16 × 23 / 60) = 6
    expect(s.line).toBe('Reviews 12 / 30 goal · New 4 / 10 goal · 6 min');
  });

  test('a goal of 0 shows the count without a goal; no session today → no minutes', () => {
    const s = todaySummary({ reviews: 3, neww: 0 }, { goalReviews: 0, goalNew: 10 }, [session('2026-06-01', 9)], TODAY);
    expect(s.line).toBe('Reviews 3 · New 0 / 10 goal');
    expect(s.goals.map((g) => g.goal)).toEqual([0, 10]);
  });

  test('goalBar: percent capped at 100, and a spoken label', () => {
    expect(goalBar({ label: 'Reviews', done: 12, goal: 30 })).toEqual({ pct: 40, label: 'Reviews: 12 of 30 goal' });
    expect(goalBar({ label: 'New', done: 25, goal: 10 }).pct).toBe(100);
    expect(goalBar({ label: 'New', done: 4, goal: 0 }).pct).toBe(0);
  });
});

describe('NEXT 7 DAYS', () => {
  const decks = new Map([['d1', makeDeckV3({ id: 'd1' })]]);
  const card = (due: number): Card => ({ ...noteWithCards({ deckId: 'd1', card: lifeValues('review', NOW) }).cards[0], due });

  test('bars: labels, counts and heights relative to the busiest day', () => {
    const days = dueForecast([card(NOW - DAY), card(NOW), card(NOW + DAY), card(NOW + DAY), card(NOW + DAY), card(NOW + DAY)], {
      now: NOW,
      decks,
    });
    const bars = forecastBars(days);
    expect(bars.map((b) => b.label)).toEqual(['Today', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue']);
    expect(bars.map((b) => b.count)).toEqual([2, 4, 0, 0, 0, 0, 0]);
    expect(bars.map((b) => b.share)).toEqual([0.5, 1, 0, 0, 0, 0, 0]);
  });

  test('the spoken summary says "1 card", never "1 cards"', () => {
    const days = dueForecast([card(NOW)], { now: NOW, decks });
    expect(forecastLabel(days)).toBe('Due in the next 7 days: 1 card. Today 1, Thu 0, Fri 0, Sat 0, Sun 0, Mon 0, Tue 0');
    expect(forecastLabel(dueForecast([], { now: NOW, decks }))).toMatch(/^Due in the next 7 days: 0 cards\./);
  });

  test('forecastReader: the deck directions are read from the notes; the same state gives the same array', () => {
    const state = library();
    const read = forecastReader(NOW);
    const days = read(state);
    expect(read(state)).toBe(days);
    // German: the review card is due in 3 days and the mastered card in 20; the paused deck's card is left out.
    expect(days.map((d) => d.count)).toEqual([0, 0, 0, 1, 0, 0, 0]);
  });

  // W5-5a: the test above has no deck directions, so it would pass even if the
  // reader never found a card's type. Here direction ord 0 of the card type is
  // OFF in d1: only the real note → typeId link drops d1's review card.
  test('forecastReader: a direction switched off in the deck is not counted (note → card type → deck directions)', () => {
    const type = BUILTIN_TYPE_IDS.legacyVocabDe;
    const d1 = makeDeckV3({ id: 'd1', name: 'German', order: 0, options: { directions: { [type]: [1] } } });
    const d3 = makeDeckV3({ id: 'd3', name: 'German too', order: 2 }); // the same card type, every direction on
    const state = stateOfV3({ decks: [d1, d3], groups: [...german(), vocab('d3', 'A2', 'review')] });
    const days = forecastReader(NOW)(state);
    // Only d3's review card (ord 0, due in 3 days) is left; d1's ord-0 review card is off.
    expect(days.map((d) => d.count)).toEqual([0, 0, 0, 1, 0, 0, 0]);
    const allOn = forecastReader(NOW)({ ...state, decks: [makeDeckV3({ id: 'd1', name: 'German', order: 0 }), d3] });
    expect(allOn.map((d) => d.count)).toEqual([0, 0, 0, 2, 0, 0, 0]);
  });
});

describe('ACTIVITY', () => {
  test('heatLevel thresholds', () => {
    expect([0, 1, 9, 10, 19, 20, 29, 30, 500].map(heatLevel)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
    expect(heatLevel(Number.NaN)).toBe(0);
  });

  test('5 weeks: one cell per day, oldest first, today last', () => {
    const sessions = [session(TODAY, 12), session(TODAY, 20), session('2026-06-09', 5), session('2026-05-07', 40)];
    const h = heatmap(sessions, TODAY, '5w');
    expect(h.cells).toHaveLength(35);
    expect(h.cells[34]).toBe(4); // today: 32 cards
    expect(h.cells[33]).toBe(1); // yesterday: 5 cards
    expect(h.cells[0]).toBe(4); // 7 May (34 days back) is the first cell: 40 cards
    expect(h.from).toBe('2026-05-07');
    expect(h.active).toBe(3);
    expect(h.label).toBe('Studied 3 of the last 35 days');
  });

  test('35 weeks: one cell per week (average cards per day)', () => {
    const sessions = [session(TODAY, 70), session('2026-06-08', 70), session('2025-12-01', 7)];
    const h = heatmap(sessions, TODAY, '35w');
    expect(h.cells).toHaveLength(35);
    expect(h.cells[34]).toBe(3); // 140 cards this week → 20 a day
    expect(h.active).toBe(2);
    expect(h.label).toBe('Studied in 2 of the last 35 weeks');
    expect(h.from).toBe('2025-10-09'); // 35 × 7 − 1 = 244 days back
  });

  // W5-5a: Math.round(3 / 7) = 0, so the cell was drawn empty while the label counted the week.
  test('35 weeks: a week with only 1–3 cards is level 1, never an empty cell', () => {
    const h = heatmap([session(TODAY, 3), session('2026-01-07', 1)], TODAY, '35w');
    expect(h.cells[34]).toBe(1); // this week: 3 cards
    expect(h.cells.filter((level) => level > 0)).toHaveLength(2);
    expect(h.active).toBe(2);
    expect(h.label).toBe('Studied in 2 of the last 35 weeks');
    // The picture and the label agree: as many coloured cells as active weeks.
    const busy = heatmap([session(TODAY, 70), session('2026-03-04', 2), session('2025-11-12', 5)], TODAY, '35w');
    expect(busy.cells.filter((level) => level > 0)).toHaveLength(busy.active);
  });

  test('the range switch has the two ranges of spec §8.8', () => {
    expect(HEAT_RANGES.map((o) => o.label)).toEqual(['5 weeks', '35 weeks']);
  });
});

describe('BY DECK', () => {
  test('one row per deck with cards, in deck order; paused decks too; Known is never mastered', () => {
    const state = library();
    const d3 = makeDeckV3({ id: 'd3', name: 'Empty', order: -1 });
    const stats = deckStatsMap({ ...state, decks: [...state.decks, d3] }, matchCtxOf(state, NOW));
    const rows = deckMasteryRows([...state.decks, d3], stats);
    expect(rows.map((r) => r.value)).toEqual(['d1', 'd2']);
    expect(rows[0]).toMatchObject({ label: 'German', total: 6, mastered: 1, known: 2, review: 1, neww: 1, notStarted: 1 });
    // 1 mastered of 6 = 16% (rounded down); the 2 Known cards add nothing.
    expect(deckRowLine(rows[0])).toBe('16% mastered · 6 cards');
    expect(rows[1].paused).toBe(true);
    expect(deckRowLine(rows[1])).toBe('0% mastered · 1 card · Paused');
  });

  test('a deck where every card is Known says "Known", not "100% mastered"', () => {
    const d = makeDeckV3({ id: 'k', name: 'Known deck' });
    const state = stateOfV3({ decks: [d], groups: [vocab('k', 'A1', 'known'), vocab('k', 'A1', 'known')] });
    const rows = deckMasteryRows(state.decks, deckStatsMap(state, matchCtxOf(state, NOW)));
    expect(deckRowLine(rows[0])).toBe('Known · 2 cards');
  });

  test('deckHref is the deck page', () => {
    expect(deckHref('d1')).toBe('/deck/d1');
    expect(deckHref('a b')).toBe('/deck/a%20b');
  });
});

describe('wave 5c — a BY {GROUP} block is named like the Library names the group (walkthrough M8)', () => {
  /** An imported card type whose level field is called "CEFRLevel" (no label of its own), or labelled `label`. */
  function imported(label?: string): DataStateV3 {
    const type: NoteType = {
      id: 'nt-import',
      name: 'Imported Words',
      kind: 'standard',
      fields: [
        { name: 'Word', role: 'term', facet: 'off' },
        { name: 'Meaning', role: 'meaning', facet: 'off' },
        { name: 'CEFRLevel', role: 'badge', facet: 'on', ...(label ? { label } : {}) },
      ],
      templates: [{ ord: 0, name: 'Card 1', prompt: [0], answer: [1] }],
      sortField: 0,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const deck = makeDeckV3({ id: 'd-imp', name: 'Imported' });
    const groups = ['A1', 'A2', 'B1'].map((level, i) =>
      noteWithCards({ deckId: 'd-imp', typeId: type.id, fields: [`word ${i}`, `meaning ${i}`, level], card: lifeValues('review', NOW) }, [type]),
    );
    return stateOfV3({ decks: [deck], groups, types: [type] });
  }

  test('a raw field name is made readable ("CEFR Level"), the same words as the Library chip of a row', () => {
    const state = imported();
    const [block] = groupBlocks(state.cards, libraryIndexOf(state), state.decks);
    expect(block.group).toBe('CEFR Level');
    expect(groupHeading(block)).toBe('Imported · By cefr level');
    // A row opens the Library with Deck + the value: its chip says the same group name.
    const chip = chipsOf(block.rows[0].query, matchCtxOf(state, NOW)).find((c) => c.id.startsWith('field:'))!;
    expect(chip.label).toBe('CEFR Level: A1');
  });

  test('a label the card type chose wins, here and on the chip', () => {
    const state = imported('Stufe');
    const [block] = groupBlocks(state.cards, libraryIndexOf(state), state.decks);
    expect(block.group).toBe('Stufe');
    const chip = chipsOf(block.rows[0].query, matchCtxOf(state, NOW)).find((c) => c.id.startsWith('field:'))!;
    expect(chip.label).toBe('Stufe: A1');
  });
});

describe('BY {GROUP} — ordinal filter groups found in the data', () => {
  /** The Library count of a row's chips (the same evaluator as the Library). */
  const libraryCount = (state: DataStateV3, q: Parameters<typeof scopePool>[1]) =>
    scopePool(state, q, matchCtxOf(state, NOW), 'browse').length;

  test('a Level field: one block, rows in level order, mastery per value, Library chips Deck + Level', () => {
    const state = library();
    const blocks = groupBlocks(state.cards, libraryIndexOf(state), state.decks);
    expect(blocks).toHaveLength(1);
    const [block] = blocks;
    expect(block).toMatchObject({ deckId: 'd1', deckName: 'German', group: 'Level', kind: 'cefr' });
    expect(groupHeading(block)).toBe('German · By level');
    expect(block.rows.map((r) => r.label)).toEqual(['A1', 'A2', 'B1']);
    expect(block.rows[0]).toMatchObject({ total: 2, known: 2, mastered: 0 });
    expect(block.rows[1]).toMatchObject({ total: 2, mastered: 1, review: 1 });
    expect(block.rows[2]).toMatchObject({ total: 2, neww: 1, notStarted: 1 });
    // The chips: Deck + Level, and the Library shows exactly the row's cards.
    expect(JSON.parse(JSON.stringify(block.rows[2].query))).toEqual({ decks: ['d1'], fields: { level: ['b1'] } });
    for (const row of block.rows) expect(libraryCount(state, row.query)).toBe(row.total);
  });

  test('levels sort by rank, not by text or count (A2 < B1 < B2 < C1)', () => {
    const d = makeDeckV3({ id: 'd' });
    const state = stateOfV3({
      decks: [d],
      groups: ['C1', 'A2', 'B2', 'B1', 'B1', 'B1'].map((level) => vocab('d', level, 'review')),
    });
    const [block] = groupBlocks(state.cards, libraryIndexOf(state), state.decks);
    expect(block.rows.map((r) => r.label)).toEqual(['A2', 'B1', 'B2', 'C1']);
  });

  test('no block for a field that is not ordinal, or that has one value in the deck', () => {
    const d = makeDeckV3({ id: 'd' });
    const typeOnly = stateOfV3({
      decks: [d],
      groups: [vocab('d', 'A1', 'review', { type: 'noun' }), vocab('d', 'A1', 'review', { type: 'verb' })],
    });
    // Type (noun, verb) is a filter group but not ordinal; Level has one value here.
    expect(groupBlocks(typeOnly.cards, libraryIndexOf(typeOnly), typeOnly.decks)).toEqual([]);
  });

  test('a numbered section level ("Unit 1", "Unit 2", "Unit 10"), when the deck has no ordinal field', () => {
    const d = makeDeckV3({ id: 'u', name: 'Course' });
    const state = stateOfV3({
      decks: [d],
      groups: [basic('u', 'Unit 10', 'review'), basic('u', 'Unit 2', 'mastered'), basic('u', 'Unit 1', 'new'), basic('u', 'Unit 1', 'known')],
    });
    const [block, ...rest] = groupBlocks(state.cards, libraryIndexOf(state), state.decks);
    expect(rest).toEqual([]);
    expect(block).toMatchObject({ group: 'Section', kind: 'natural' });
    expect(groupHeading(block)).toBe('Course · By section');
    expect(block.rows.map((r) => r.label)).toEqual(['Unit 1', 'Unit 2', 'Unit 10']);
    expect(block.rows[0]).toMatchObject({ total: 2, neww: 1, known: 1, mastered: 0 });
    for (const row of block.rows) expect(libraryCount(state, row.query)).toBe(row.total);
  });

  test('a deeper section level: the same level name under two parents is ONE row that holds both', () => {
    const d = makeDeckV3({ id: 'g', name: 'Mixed' });
    const state = stateOfV3({
      decks: [d],
      groups: [
        basic('g', 'Vocabulary::A1', 'review'),
        basic('g', 'Vocabulary::A2', 'review'),
        basic('g', 'Grammar::A1', 'mastered'),
        basic('g', 'Grammar::B1', 'review'),
      ],
    });
    const [block] = groupBlocks(state.cards, libraryIndexOf(state), state.decks);
    // Level 1 (Vocabulary, Grammar) is not ordinal; level 2 is.
    expect(block.rows.map((r) => `${r.label}:${r.total}`)).toEqual(['A1:2', 'A2:1', 'B1:1']);
    const a1 = block.rows[0];
    expect(parseQueryParam(JSON.stringify(a1.query)).sections).toEqual([
      { deckId: 'g', path: 'grammar::a1' },
      { deckId: 'g', path: 'vocabulary::a1' },
    ]);
    expect(libraryCount(state, a1.query)).toBe(2);
  });

  test('a deck with an ordinal field shows the field only, not also its ordinal sections', () => {
    const d = makeDeckV3({ id: 's', name: 'Spanish' });
    const state = stateOfV3({
      decks: [d],
      groups: [vocab('s', 'A1', 'review', { section: 'A1' }), vocab('s', 'A2', 'review', { section: 'A2' })],
    });
    const blocks = groupBlocks(state.cards, libraryIndexOf(state), state.decks);
    expect(blocks.map((b) => b.group)).toEqual(['Level']);
  });

  // W5-5a: every ordinal section level was hidden as soon as the deck had an
  // ordinal field. Spec §4.3 hides a section group only when it splits the
  // cards EXACTLY like the field; a different split is a group of its own.
  test('a section level that groups the cards differently from the field is shown too (spec §4.3)', () => {
    const d = makeDeckV3({ id: 'c', name: 'Course' });
    const state = stateOfV3({
      decks: [d],
      groups: [
        vocab('c', 'A1', 'review', { section: 'Lesson 1' }),
        vocab('c', 'A1', 'mastered', { section: 'Lesson 2' }),
        vocab('c', 'A2', 'new', { section: 'Lesson 3' }),
        vocab('c', 'A2', 'review', { section: 'Lesson 4' }),
      ],
    });
    const blocks = groupBlocks(state.cards, libraryIndexOf(state), state.decks);
    expect(blocks.map((b) => `${b.group}:${b.kind}`)).toEqual(['Level:cefr', 'Section:natural']);
    expect(blocks[1].rows.map((r) => r.label)).toEqual(['Lesson 1', 'Lesson 2', 'Lesson 3', 'Lesson 4']);
    for (const row of blocks[1].rows) expect(libraryCount(state, row.query)).toBe(row.total);
  });

  test('German_Complete shape: the level is the second section level → only "By level" (the same group once)', () => {
    const d = makeDeckV3({ id: 'g', name: 'German' });
    const state = stateOfV3({
      decks: [d],
      groups: [
        vocab('g', 'A1', 'review', { section: 'Vocabulary::A1' }),
        vocab('g', 'A2', 'review', { section: 'Vocabulary::A2' }),
        vocab('g', 'A1', 'new', { section: 'Verbs::A1' }),
        vocab('g', 'B1', 'mastered', { section: 'Verbs::B1' }),
      ],
    });
    // Depth 1 (Vocabulary, Verbs) is not ordinal; depth 2 (A1, A2, B1) splits the cards like Level.
    expect(groupBlocks(state.cards, libraryIndexOf(state), state.decks).map((b) => b.group)).toEqual(['Level']);
    // One card whose section level differs from its Level field: two different groups → both are shown.
    const drift = stateOfV3({
      decks: [d],
      groups: [
        vocab('g', 'A1', 'review', { section: 'Vocabulary::A1' }),
        vocab('g', 'A2', 'review', { section: 'Vocabulary::A2' }),
        vocab('g', 'A1', 'new', { section: 'Verbs::A1' }),
        vocab('g', 'B1', 'mastered', { section: 'Verbs::A2' }), // Level B1, but in the A2 section
      ],
    });
    expect(groupBlocks(drift.cards, libraryIndexOf(drift), drift.decks).map((b) => b.group)).toEqual(['Level', 'Section']);
  });

  test('blocks follow the deck order; a deck without cards or without a group has none', () => {
    const a = makeDeckV3({ id: 'a', name: 'Second', order: 2 });
    const b = makeDeckV3({ id: 'b', name: 'First', order: 1 });
    const c = makeDeckV3({ id: 'c', name: 'Plain', order: 0 });
    const state = stateOfV3({
      decks: [a, b, c],
      groups: [
        vocab('a', 'A1', 'review'),
        vocab('a', 'A2', 'review'),
        vocab('b', 'B1', 'review'),
        vocab('b', 'B2', 'review'),
        basic('c', '', 'review'),
      ],
    });
    expect(groupBlocks(state.cards, libraryIndexOf(state), state.decks).map((x) => x.deckName)).toEqual(['First', 'Second']);
  });

  test('groupBlocksReader keeps its result while the cards, notes, card types and decks stay the same', () => {
    const state = library();
    const read = groupBlocksReader();
    const first = read(state);
    expect(read({ ...state, person: makePersonV3({ xp: 5 }) })).toBe(first);
    expect(read({ ...state, cards: [...state.cards] })).not.toBe(first);
  });

  test('libraryHref: the Library tab with q (the Query as JSON) and the nonce', () => {
    const href = libraryHref({ decks: ['d1'], fields: { level: ['b1'] } }, '17');
    const url = new URL(href, 'https://x');
    expect(url.pathname).toBe('/(tabs)/library');
    expect(parseQueryParam(url.searchParams.get('q'))).toEqual({ decks: ['d1'], fields: { level: ['b1'] } });
    expect(url.searchParams.get('nonce')).toBe('17');
  });
});

describe('ACHIEVEMENTS and ALL TIME', () => {
  test('achievementsCount: "{unlocked} / {all}"', () => {
    expect(achievementsCount([{ unlocked: true }, { unlocked: false }, { unlocked: true }])).toBe('2 / 3');
  });

  test('allTimeRows: totals; the average says "1 card", never "1 cards"', () => {
    expect(allTimeRows([session(TODAY, 1)])).toEqual([
      ['Cards studied', '1'],
      ['Sessions', '1'],
      ['Average per session', '1 card'],
      ['Days active', '1'],
    ]);
    expect(allTimeRows([session(TODAY, 1200), session('2026-06-09', 800)])[2]).toEqual(['Average per session', '1,000 cards']);
    expect(allTimeRows([])[2]).toEqual(['Average per session', '—']);
  });
});

describe('Export study history: sessions CSV + review CSV, one zip, the share sheet', () => {
  beforeEach(() => {
    mockRevlogRows = [];
  });

  test('no session yet → nothing is written, and the message says why', async () => {
    const { io, written, shared } = fakeIO();
    const outcome = await exportStudyHistory(library(), NOW, io);
    expect(outcome).toBeNull();
    expect(written).toEqual([]);
    expect(shared).toEqual([]);
    expect(historyExportMessage(outcome)).toBe('No study history yet. Finish a session first.');
  });

  test('the zip holds sessions.csv and reviews.csv; it is shared as a zip', async () => {
    const state = library({ sessions: [session(TODAY, 4)] });
    mockRevlogRows = [revlogRow(1, state.cards[2].id), revlogRow(2, state.cards[3].id, { rating: 'again' })];
    const { io, written, shared, cleared } = fakeIO();
    const outcome = await exportStudyHistory(state, NOW, io);
    expect(outcome).toMatchObject({ kind: 'shared' });
    expect(written).toHaveLength(1);
    expect(written[0].name).toMatch(/^maranki-history-[\d-]+\.zip$/);
    // Wave 5b (L8): the name is the phone's LOCAL time, like every file the learner sees.
    expect(written[0].name).toBe(historyZipFileName(NOW));
    expect(shared).toEqual([{ uri: `file:///cache/${written[0].name}`, kind: SHARE_HISTORY_ZIP }]);
    // Old history files in the cache are deleted first.
    expect(cleared).toEqual(['maranki-history-']);

    const files = unzipSync(written[0].content);
    expect(Object.keys(files).sort()).toEqual(['reviews.csv', 'sessions.csv']);
    const sessionsCsv = strFromU8(files['sessions.csv']).replace(/^﻿/, '');
    const reviewsCsv = strFromU8(files['reviews.csv']).replace(/^﻿/, '');
    expect(sessionsCsv.split(/\r?\n/)[0]).toBe(SESSIONS_CSV_HEADER.join(','));
    expect(reviewsCsv.split(/\r?\n/)[0]).toBe(REVIEWS_CSV_HEADER.join(','));
    expect(reviewsCsv.split(/\r?\n/).filter((l) => l !== '')).toHaveLength(3);
    expect(historyExportMessage(outcome)).toBeNull();
  });

  test('sharing not available → nothing is kept in the cache', async () => {
    const { io, cleared } = fakeIO({ share: () => Promise.resolve(false) });
    const outcome = await exportStudyHistory(library({ sessions: [session(TODAY, 4)] }), NOW, io);
    expect(outcome).toEqual({ kind: 'unavailable' });
    expect(cleared).toEqual(['maranki-history-', 'maranki-history-']);
    expect(historyExportMessage(outcome)).toBe('Sharing is not available on this phone.');
  });

  test('the share sheet fails → share-failed, and the cache copy is deleted', async () => {
    const { io, cleared } = fakeIO({ share: () => Promise.reject(new Error('busy')) });
    const outcome = await exportStudyHistory(library({ sessions: [session(TODAY, 4)] }), NOW, io);
    expect(outcome).toEqual({ kind: 'share-failed' });
    expect(cleared).toHaveLength(2);
    expect(historyExportMessage(outcome)).toBe("We couldn't open the share sheet.");
  });

  test('the file cannot be written → failed', async () => {
    const { io, shared } = fakeIO({
      writeCache: () => {
        throw new Error('disk full');
      },
    });
    const outcome = await exportStudyHistory(library({ sessions: [session(TODAY, 4)] }), NOW, io);
    expect(outcome).toEqual({ kind: 'failed' });
    expect(shared).toEqual([]);
    expect(historyExportMessage(outcome)).toMatch(/couldn't write the history file/);
  });

  test('the review history cannot be read → read-failed, nothing written', async () => {
    const { io, written } = fakeIO({ revlog: { all: () => Promise.reject(new Error('locked')) } });
    const outcome = await exportStudyHistory(library({ sessions: [session(TODAY, 4)] }), NOW, io);
    expect(outcome).toEqual({ kind: 'read-failed' });
    expect(written).toEqual([]);
    expect(historyExportMessage(outcome)).toBe("We couldn't read your study history. Please try again.");
  });
});

/* ================================================================ part 2: the screens */

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  mockPush.mockClear();
  mockNavigate.mockClear();
  mockBack.mockClear();
  mockShow.mockClear();
  mockWriteCache.mockClear();
  mockDeleteCache.mockClear();
  mockShare.mockClear();
  mockParams = {};
});

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
});

function render(element: React.ReactElement): ReactTestRenderer {
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer!;
}

/** Every text on screen, or inside one node (host Text nodes only). */
function texts(r: ReactTestRenderer | ReactTestInstance): string[] {
  const root = 'root' in r ? r.root : r;
  return root
    .findAll((n) => (n.type as unknown) === 'Text')
    .map((n) => {
      const kids = n.props.children;
      return Array.isArray(kids) ? kids.map((k) => (typeof k === 'string' || typeof k === 'number' ? String(k) : '')).join('') : String(kids ?? '');
    });
}

/** Every pressable (composite, with onPress) with its screen-reader label. */
function pressables(r: ReactTestRenderer): ReactTestInstance[] {
  return r.root.findAll((n) => typeof n.type !== 'string' && typeof n.props.onPress === 'function');
}

/** The pressable with this screen-reader label. */
function byLabel(r: ReactTestRenderer, label: string | RegExp): ReactTestInstance {
  const node = pressables(r).find((n) => {
    const l = n.props.accessibilityLabel;
    return typeof l === 'string' && (typeof label === 'string' ? l === label : label.test(l));
  });
  if (!node) throw new Error(`no pressable labelled ${String(label)}`);
  return node;
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

/** A studied library: German + paused deck, 3 sessions, level 6. */
function studiedState(): DataStateV3 {
  return library({
    sessions: [session(TODAY, 12), session('2026-06-09', 1), session('2026-06-01', 30)],
    person: makePersonV3({ xp: xpForLevel(6) + 10, streak: 1, bestStreak: 3, freezes: 1, goalReviews: 30, goalNew: 10 }),
  });
}

describe('Progress screen (spec §8.8)', () => {
  test('read-only: no Start, Review or Study button anywhere', () => {
    mockState = studiedState();
    const r = render(React.createElement(ProgressScreen));
    const words = pressables(r).flatMap((p) => [String(p.props.accessibilityLabel ?? ''), ...texts(p)]);
    expect(words.length).toBeGreaterThan(5);
    for (const w of words) expect(w).not.toMatch(/^(Start|Review|Study\b)/);
    expect(texts(r)).not.toContain('Start');
  });

  test('the numbers: level name, streak, mastered and Known apart, TODAY, plural counts', () => {
    mockState = studiedState();
    const r = render(React.createElement(ProgressScreen));
    const all = texts(r);
    expect(all).toContain('Level 6 · Keeper');
    expect(all).toContain('1-day streak · best 3');
    expect(all).toContain('1 freeze');
    expect(all).toContain('1 mastered · 2 known');
    expect(all).toContain('of 7 cards');
    expect(all).toContain('Reviews 0 / 30 goal · New 0 / 10 goal · 5 min'); // the spec copy (W5-5a)
    expect(all).toContain('16% mastered · 6 cards');
    expect(all).toContain('0% mastered · 1 card · Paused');
    // The device finding: never "1 cards".
    for (const t of all) expect(t).not.toMatch(/\b1 cards\b/);
  });

  test('the "5 weeks | 35 weeks" switch is on its own full-width line, not squeezed next to the heading', () => {
    mockState = studiedState();
    const r = render(React.createElement(ProgressScreen));
    const tablist = r.root.findByType(SegCtrl);
    expect(tablist.props.options.map((o: { label: string }) => o.label)).toEqual(['5 weeks', '35 weeks']);
    const holder = tablist.parent!;
    expect(holder.type as unknown).toBe('View');
    expect(holder.props.style).toMatchObject({ alignSelf: 'stretch' });
    // The holder is not a row and holds no heading; the "Activity" heading has no side action any more.
    expect(holder.props.style).not.toMatchObject({ flexDirection: 'row' });
    expect(holder.findAll((n) => (n.type as unknown) === 'Text' && n.props.children === 'Activity')).toHaveLength(0);
    const heading = r.root.findAllByType(SectionHead).find((h) => h.props.children === 'Activity')!;
    expect(heading.props.action).toBeUndefined();
    // Switching the range redraws the heatmap with the weeks summary.
    act(() => byLabel(r, '35 weeks').props.onPress());
    expect(
      r.root.findAll((n) => (n.type as unknown) === 'View' && n.props.accessibilityLabel === 'Studied in 2 of the last 35 weeks'),
    ).toHaveLength(1);
  });

  test('the "?" next to the mastery line explains Mastered (the glossary text)', () => {
    mockState = studiedState();
    const r = render(React.createElement(ProgressScreen));
    expect(texts(r)).not.toContain('Long-term memory.');
    act(() => byLabel(r, 'What does Mastered mean?').props.onPress());
    expect(texts(r)).toContain('Long-term memory.');
    // The streak has its "?" too.
    expect(() => byLabel(r, 'What does Streak mean?')).not.toThrow();
  });

  test('a deck row opens the deck page', () => {
    mockState = studiedState();
    const r = render(React.createElement(ProgressScreen));
    act(() => byLabel(r, /^German: 16% mastered/).props.onPress());
    expect(mockPush).toHaveBeenCalledWith('/deck/d1');
  });

  test('a "German · By level" row opens the Library with Deck + Level chips and a fresh nonce', () => {
    mockState = studiedState();
    const r = render(React.createElement(ProgressScreen));
    expect(texts(r)).toContain('German · By level');
    const spy = jest.spyOn(Date, 'now').mockReturnValue(1234);
    act(() => byLabel(r, 'Level B1: 0 percent mastered, 2 cards').props.onPress());
    spy.mockRestore();
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    const url = new URL(String(mockNavigate.mock.calls[0][0]), 'https://x');
    expect(url.pathname).toBe('/(tabs)/library');
    expect(parseQueryParam(url.searchParams.get('q'))).toEqual({ decks: ['d1'], fields: { level: ['b1'] } });
    expect(url.searchParams.get('nonce')).toBe('1234');
  });

  test('⤓ "Export study history" zips both CSVs and opens the share sheet', async () => {
    mockState = studiedState();
    mockRevlogRows = [revlogRow(1, mockState.cards[2].id)];
    const r = render(React.createElement(ProgressScreen));
    await act(async () => {
      byLabel(r, 'Export study history').props.onPress();
      await Promise.resolve();
    });
    expect(mockWriteCache).toHaveBeenCalledTimes(1);
    const [name, content] = mockWriteCache.mock.calls[0];
    expect(name).toMatch(/\.zip$/);
    expect(Object.keys(unzipSync(content as Uint8Array)).sort()).toEqual(['reviews.csv', 'sessions.csv']);
    expect(mockShare).toHaveBeenCalledWith(`file:///cache/${name}`, SHARE_HISTORY_ZIP);
    expect(mockShow).not.toHaveBeenCalled();
  });

  test('no session yet: the empty state and "Go to Today"; the deck numbers still show', () => {
    mockState = library();
    const r = render(React.createElement(ProgressScreen));
    const all = texts(r);
    expect(all).toContain(PROGRESS_EMPTY.title);
    expect(all).not.toContain('Achievements');
    expect(all).toContain('16% mastered · 6 cards');
    act(() => byText(r, PROGRESS_EMPTY.action).props.onPress());
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  test('⤓ with no session says so in the snackbar (and writes nothing)', async () => {
    mockState = library();
    const r = render(React.createElement(ProgressScreen));
    await act(async () => {
      byLabel(r, 'Export study history').props.onPress();
      await Promise.resolve();
    });
    expect(mockWriteCache).not.toHaveBeenCalled();
    expect(mockShow).toHaveBeenCalledWith('No study history yet. Finish a session first.');
  });
});

describe('Help screen (spec §8.9)', () => {
  /** The ScrollView's scrollTo (React Native's jest mock: one jest.fn for every ScrollView). */
  function scrollToMock(r: ReactTestRenderer) {
    const instance = r.root.findByType(ScrollView).instance as { scrollTo: jest.Mock };
    return instance.scrollTo;
  }

  /** Fire the onLayout of every section: section i starts at y = 1000 × (i + 1). */
  function layoutSections(r: ReactTestRenderer) {
    const sections = r.root.findAll((n) => (n.type as unknown) === 'View' && typeof n.props.onLayout === 'function');
    act(() => {
      sections.forEach((s, i) => s.props.onLayout({ nativeEvent: { layout: { x: 0, y: 1000 * (i + 1), width: 300, height: 900 } } }));
    });
    return sections.length;
  }

  test('every section is drawn, with the glossary in "Words we use"', () => {
    const r = render(React.createElement(HelpScreen));
    const all = texts(r);
    for (const section of HELP_SECTIONS) expect(all).toContain(section.title);
    expect(all).toContain('Not started');
    expect(all).toContain('Help & FAQ');
  });

  test('?topic=import jumps to "Import tips" once its section is placed', () => {
    mockParams = { topic: 'import' };
    const r = render(React.createElement(HelpScreen));
    const scrollTo = scrollToMock(r);
    scrollTo.mockClear();
    expect(layoutSections(r)).toBe(HELP_SECTIONS.length);
    const index = HELP_SECTIONS.findIndex((s) => s.id === 'import');
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ y: 1000 * (index + 1) - 12, animated: false });
    // A later layout does not jump again.
    layoutSections(r);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  test('an unknown topic starts at the top', () => {
    mockParams = { topic: 'nope' };
    const r = render(React.createElement(HelpScreen));
    const scrollTo = scrollToMock(r);
    scrollTo.mockClear();
    layoutSections(r);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  test('"On this page" rows jump to their section; the back button goes back', () => {
    const r = render(React.createElement(HelpScreen));
    const scrollTo = scrollToMock(r);
    layoutSections(r);
    scrollTo.mockClear();
    act(() => byLabel(r, 'Backups and moving phones').props.onPress());
    const index = HELP_SECTIONS.findIndex((s) => s.id === 'backups');
    expect(scrollTo).toHaveBeenCalledWith({ y: 1000 * (index + 1) - 12, animated: true });
    act(() => byLabel(r, 'Back').props.onPress());
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});

/* ===================================================== wave 5b (walkthrough) */

describe('the "New" goal bar has one colour everywhere (wave 5b L14)', () => {
  /** The colour of every goal Bar on screen, by its first word ("New: 0 of 10 goal" → New). */
  function barColours(r: ReactTestRenderer): Record<string, unknown> {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const bar of r.root.findAllByType(Bar)) {
      const name = String(bar.props.label ?? bar.parent?.props.accessibilityLabel ?? '').split(':')[0];
      if (name === 'New' || name === 'Reviews') out[name] = bar.props.color;
    }
    return out;
  }

  test('Reviews = pine, New = amber (GOAL_BAR_TONE)', () => {
    expect(GOAL_BAR_TONE).toEqual({ Reviews: 'pine', New: 'amber' });
    for (const goal of todaySummary({ reviews: 1, neww: 1 }, { goalReviews: 3, goalNew: 3 }, [], TODAY).goals) {
      expect(GOAL_BAR_TONE[goal.label]).toBe(goal.label === 'New' ? 'amber' : 'pine');
    }
  });

  test('the Progress screen draws the New goal bar amber, the same colour as Today', () => {
    mockState = studiedState(); // goals: 30 reviews, 10 new
    const progress = barColours(render(React.createElement(ProgressScreen)));
    expect(progress).toEqual({ Reviews: light.pine, New: light.amber });
    act(() => renderer!.unmount());
    // Today's goal bars (TodayHero.tsx GoalBars), with the same goals.
    const today = barColours(render(React.createElement(GoalBars, { bars: goalBars({ reviews: 3, neww: 2 }, { goalReviews: 30, goalNew: 10 }) })));
    expect(today).toEqual(progress);
    expect(light.amber).not.toBe(light.info); // (New was c.info, blue, on Progress)
  });
});

describe('the tab bar under Progress is solid (wave 5b L1)', () => {
  test('solidColor drops the see-through part of a colour', () => {
    expect(solidColor('rgba(35, 32, 25, 0.9)')).toBe('rgb(35, 32, 25)');
    expect(solidColor('rgba(251,248,242,0.92)')).toBe('rgb(251, 248, 242)');
    expect(solidColor('#23201980')).toBe('#232019');
    expect(solidColor('#FBF8F2')).toBe('#FBF8F2');
  });

  test('in both themes the bar colour is the surface colour at full strength (no list text shows through)', () => {
    expect(light.tabbarBg).toMatch(/^rgba\(/); // the token itself is see-through …
    expect(solidColor(light.tabbarBg)).toBe('rgb(251, 248, 242)'); // … the bar is not
    expect(solidColor(dark.tabbarBg)).toBe('rgb(35, 32, 25)');
    const hex = (c: string) => `rgb(${[1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)).join(', ')})`;
    expect(solidColor(light.tabbarBg)).toBe(hex(light.surface));
    expect(solidColor(dark.tabbarBg)).toBe(hex(dark.surface));
  });
});
