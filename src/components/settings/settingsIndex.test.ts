/**
 * Tests for the Settings index (src/components/settings/settingsIndex.ts,
 * spec §8.6, unit W4-5): every keyword finds its row, "session limit" finds
 * Session size, the hub lines, the stepper ladders, and the danger-zone words.
 *
 * Review round 2:
 *   - "the hub is always under a drill-in": `hubRepairListeners` runs on a
 *     REAL navigator (React Navigation's own builder and routers, as bundled
 *     in expo-router; react-test-renderer draws plain elements), with the
 *     same nested navigate that expo-router makes for a plain
 *     `router.push('/(tabs)/settings/reminders?enable=1')` from Today;
 *   - the Erase hold is off, and the sheet stays open, while its backup is
 *     being saved (`eraseSheetControls`).
 *
 * The "Your data" blocks test what the Settings › Your data rows do (spec
 * §8.4, src/store/backup.ts, W4-5): a backup carries the review history and,
 * when "Include images in backups" is on and they fit, the images; a restore
 * writes them back after its save; the history export is one zip. A fake
 * disk (`fakeIO`) stands in for the phone.
 *
 * Wave 5b (the device walkthrough), at the end of the file:
 *   - R3: the "Reset preferences?" text names every setting the reset changes;
 *   - L9: the footer says "Maranki 3.0.0" / "Maranki German 3.0.0";
 *   - M3: with the search keyboard open, the first tap on a result works;
 *   - L6: the tour's time answers say their real time (minutesFor): wave 5d
 *     made them 5 / 10 / 20 new a day again ("10 new a day · about 15
 *     min"), and a first run selects the middle one;
 *   - L7: the tour's first run offers a reminder at 8:00 PM;
 *   - R2: a restore of a backup WITHOUT review history keeps the phone's;
 *   - R4: onboarding checks every starter row again after each save;
 *   - R5: the AddSheet reads and plans a NEW starter deck once.
 * Review round 1: these blocks DRAW the screens (react-test-renderer) and
 * check what they show and do — the Settings hub, the tour, the Restore
 * confirm sheet and the AddSheet — instead of reading their source text.
 * So the modules those screens use are replaced (`jest.mock` below): the
 * store hooks read one test state (`mockState`), the router, the snackbar,
 * the build config, the icons and the safe area are fakes, and the
 * AddSheet's starter file steps (load, read, plan) are counted.
 */
// '@jest/globals' first: the jest.mock factories below use its `jest`.
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import {
  BaseNavigationContainer,
  createNavigationContainerRef,
  createNavigatorFactory,
  type NavigationState,
  type ParamListBase,
  StackRouter,
  TabRouter,
  useNavigationBuilder,
} from 'expo-router/build/react-navigation/core';
import * as fs from 'fs';
import * as path from 'path';
import React, { useEffect, useState } from 'react';
import { Keyboard, ScrollView, TextInput } from 'react-native';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import appConfig from '../../../app.config';
import SettingsScreen from '../../app/(tabs)/settings/index';
import OnboardingScreen from '../../app/onboarding';

import { collectionFromRows, type ApkgRows } from '../../domain/import/apkgRead';
import type { AnkiCollection, DataStateV3, ImportPlan, ImportResult, RevlogRow } from '../../domain/model';
import { minutesFor } from '../../domain/schedule';
import { buildSeedState } from '../../domain/seed';
import { planStarterDeckFrom, type StarterDeckOutcome, type StarterDeps, type StarterLibrary } from '../../domain/starterDecks';
import { type AppSettings, DEFAULT_APP_SETTINGS, DEFAULT_SRS, NO_REVIEW_LIMIT } from '../../domain/types';
import type { BackupMedia } from '../../platform/backupFile';
import type { BackupFileInfo, SavedFile } from '../../platform/files';
import { SHARE_HISTORY_ZIP, type ShareKind } from '../../platform/share';
import {
  type BackupIO,
  exportAndKeepBackup,
  exportBackup,
  exportHistoryZip,
  exportMessage,
  historyZipFileName,
  IMAGES_LEFT_OUT,
  keptExportMessage,
  keptHistoryCount,
  performRestore,
  readBackup,
  RESTORE_COPY,
  restoreHistoryNote,
  restoreResultMessage,
  restoreSummary,
} from '../../store/backup';
import { resetPreferences } from '../../store/reducer';
import { FIXED_NOW } from '../../test/clock';
import { ankiFixture, makeSessionRecord } from '../../test/factories';
import { makeDeckV3, makePersonV3, makeSettingsV3, makeStateV3 } from '../../test/factoriesV3';
import type { ContentPack, StarterDeck } from '../../variants/types';
import { RestoreConfirmSheet } from '../data/RestoreConfirmSheet';
import {
  AddSheet,
  addStarterOnce,
  likelyArrival,
  STARTER_RUN_LINE,
  starterRunCounts,
  starterRunRow,
  starterRunRowAfter,
  starterRunRowSaved,
  starterRunRowsAfterSave,
  starterRunRowsAfterTry,
  starterRunRowThrew,
  type StarterPlanner,
} from '../sheets/AddSheet';
import { PACES } from './onboardingDiff';
import {
  appFooterLine,
  DEFAULT_APP_NAME,
  ERASE_COPY,
  eraseConsequences,
  eraseResultMessage,
  eraseSheetControls,
  freezesLabel,
  HUB_ROUTE,
  hubRepairListeners,
  keepHubBelow,
  freezesLine,
  LADDERS,
  ladderWith,
  MODE_LABEL,
  MODE_ORDER,
  modeLabel,
  noSettingsMatch,
  PAGE_ROUTE,
  PAGE_TITLE,
  searchSettings,
  SETTINGS_INDEX,
  type SettingsId,
  sessionRank,
  stepWords,
  studySummary,
  RESET_COPY,
  FIRST_RUN_PACE,
  tourPace,
  tourReminderTime,
  withHubBelow,
} from './settingsIndex';

/* ------------------------------------------------------------ module mocks */

/** The one state the mocked store hooks read (each screen test sets it). */
let mockState: DataStateV3 = makeStateV3();
/** The store actions the screens call (useData().actions). */
const mockActions = {
  updateAppSettings: jest.fn(),
  resetPreferences: jest.fn(),
  setGoals: jest.fn(),
  setLimits: jest.fn(),
  markOnboarded: jest.fn(),
  factoryReset: jest.fn(),
  restore: jest.fn(),
  flush: jest.fn(async () => ({ ok: true })),
};
/** The engine of the AddSheet and the tour (useEngine): it reads `mockState`. */
const mockEngine = {
  store: { getState: () => mockState },
  actions: {
    applyImport: jest.fn(
      (plan: ImportPlan) =>
        ({ deckId: plan.deck?.id ?? null, cardsAdded: plan.cards.add.length, markedKnown: 0, media: plan.media }) as unknown as ImportResult,
    ),
    flush: jest.fn(async () => ({ ok: true as const })),
  },
};
const mockShow = jest.fn<(text: string, action?: unknown) => void>();
const mockPush = jest.fn<(href: unknown) => void>();
const mockReplace = jest.fn<(href: unknown) => void>();
let mockParams: Record<string, string | undefined> = {};
/** What `Constants.expoConfig` gives (the build config). */
let mockExpoConfig: { name?: string; version?: string } | null = null;
/** The AddSheet's starter file steps, counted: load the bytes, read them, plan. */
const mockLoadStarterBytes = jest.fn(async (_starter: StarterDeck) => new Uint8Array([1, 2, 3]));
const mockReadApkg = jest.fn(async (_bytes: Uint8Array, _name: string): Promise<AnkiCollection> => {
  throw new Error('no starter file in this test');
});
const mockPlanArrivals: (string | undefined)[] = [];

// The theme: the Paper colours (the AddSheet helpers need none).
jest.mock('../../theme/ThemeContext', () => ({
  useColors: () => jest.requireActual<typeof import('../../theme/tokens')>('../../theme/tokens').light,
  useTheme: () => ({ mode: 'light', setMode: () => undefined }),
}));
// The kv-store of the AddSheet's confirmed versions: never touched by these tests.
jest.mock('../../store/storage/kvStoragePort', () => ({
  getKvStore: () => ({ getItemSync: () => null, setItem: async () => undefined }),
}));
// A kv writer waits for the app storage's first load: here it is done at once. The
// review history of the screens (Erase's backup, the Restore flow) is empty.
jest.mock('../../store/storage', () => ({
  afterAppStorageLoad: () => Promise.resolve(),
  appRevlogStore: () => ({ all: async () => [], forCard: async () => [], write: async () => 0 }),
}));
jest.mock('../../store/DataContext', () => ({ useData: () => ({ state: mockState, actions: mockActions }) }));
jest.mock('../../store/selectors', () => {
  const actual = jest.requireActual<typeof import('../../store/selectors')>('../../store/selectors');
  return {
    ...actual,
    useEngine: () => mockEngine,
    useStateV3: <T,>(selector: (state: DataStateV3) => T): T => selector(mockState),
  };
});
jest.mock('../../store/SnackbarContext', () => ({
  useSnackbar: () => ({ show: mockShow, snack: null, dismiss: () => undefined }),
}));
jest.mock('../../store/useNow', () => ({
  useNow: () => jest.requireActual<typeof import('../../test/clock')>('../../test/clock').FIXED_NOW,
}));
// The hub's Reminders row asks the system for the permission: here it is allowed.
jest.mock('../../store/reminderSync', () => ({
  ...jest.requireActual<typeof import('../../store/reminderSync')>('../../store/reminderSync'),
  useNotificationsAllowed: () => ({ allowed: true, refresh: () => undefined }),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, navigate: mockPush, replace: mockReplace, back: () => undefined }),
  useFocusEffect: () => undefined,
  useLocalSearchParams: () => mockParams,
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return mockExpoConfig;
    },
  },
}));
jest.mock('@expo/ui/community/datetime-picker', () => ({ DateTimePicker: () => null }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// The AddSheet reads a starter file with the import's .apkg reader (native SQLite): a fake here.
jest.mock('../../domain/import/apkgRead', () => ({
  ...jest.requireActual<typeof import('../../domain/import/apkgRead')>('../../domain/import/apkgRead'),
  readApkg: (bytes: Uint8Array, name: string) => mockReadApkg(bytes, name),
}));
// The bundled file's bytes (expo-asset) are a fake; every plan is recorded (its arrival).
jest.mock('../../domain/starterDecks', () => {
  const actual = jest.requireActual<typeof import('../../domain/starterDecks')>('../../domain/starterDecks');
  return {
    ...actual,
    loadStarterBytes: (starter: StarterDeck) => mockLoadStarterBytes(starter),
    planStarterDeckFrom: (...args: Parameters<typeof actual.planStarterDeckFrom>) => {
      mockPlanArrivals.push(args[5]?.arrival);
      return actual.planStarterDeckFrom(...args);
    },
  };
});

const ids = (query: string): SettingsId[] => searchSettings(query).map((e) => e.id);

/** Spec §8.6 "Search keywords per row (exact)": each keyword group and the rows it must find. */
const SPEC_KEYWORDS: [string[], SettingsId[]][] = [
  [['appearance', 'theme', 'dark'], ['appearance']],
  [['new', 'limit', 'daily'], ['newPerDay']],
  [['review', 'limit'], ['reviewsPerDay']],
  [['goal'], ['reviewsGoal', 'newGoal']],
  [['session', 'size', 'limit', 'length'], ['sessionSize']],
  [['mode', 'typing', 'quiz', 'mixed', 'flashcards'], ['defaultMode']],
  [['hint'], ['hints']],
  [['retry', 'missed'], ['retryMissed']],
  [['sibling', 'direction', 'reverse'], ['spaceSiblings']],
  [['known', 'check'], ['knownChecks']],
  [['reminder', 'notification', 'time'], ['reminders']],
  [['read', 'aloud', 'speak', 'voice', 'tts'], ['readAloud', 'autoReadAloud']],
  [['haptic', 'vibration'], ['haptics']],
  [['freeze', 'streak'], ['freezes']],
  [['import'], ['import']],
  [['export', 'backup', 'share'], ['exportBackup']],
  [['restore'], ['restore']],
  [['history', 'csv'], ['history']],
  [['algorithm', 'ease', 'interval', 'steps'], ['algorithm']],
  [['help', 'faq'], ['help']],
  [['tour', 'onboarding'], ['tour']],
  [['reset', 'erase', 'delete'], ['resetPreferences', 'erase']],
];

describe('searchSettings', () => {
  test('every spec keyword finds its row(s)', () => {
    for (const [keywords, rows] of SPEC_KEYWORDS) {
      for (const keyword of keywords) {
        for (const row of rows) expect([keyword, ids(keyword)]).toEqual([keyword, expect.arrayContaining([row])]);
      }
    }
  });

  test('every keyword of every row finds that row', () => {
    for (const entry of SETTINGS_INDEX) {
      for (const keyword of entry.keywords) expect([keyword, ids(keyword)]).toEqual([keyword, expect.arrayContaining([entry.id])]);
    }
  });

  test('"session limit" finds Session size — and only it (spec §7 #33)', () => {
    expect(ids('session limit')).toEqual(['sessionSize']);
    expect(ids('Session Limit')).toEqual(['sessionSize']);
  });

  test('"limit" alone finds the three limits', () => {
    expect(ids('limit')).toEqual(['newPerDay', 'reviewsPerDay', 'sessionSize']);
  });

  test('prefixes, plurals, case and accents', () => {
    expect(ids('notif')).toEqual(['reminders']);
    expect(ids('notifications')).toEqual(['reminders']);
    expect(ids('Reminders')).toEqual(['reminders']);
    expect(ids('HAPTICS')).toEqual(['haptics']);
    expect(ids('vibrátion')).toEqual(['haptics']);
    expect(ids('hints')).toEqual(['hints']);
  });

  test('title words are searched too ("automatic", "images")', () => {
    expect(ids('automatic')).toEqual(['autoReadAloud', 'autoBackups']); // "…automatically" too
    expect(ids('images')).toEqual(['backupImages']);
  });

  test('an empty query lists every row; nothing matching → []', () => {
    expect(searchSettings('   ')).toHaveLength(SETTINGS_INDEX.length);
    expect(ids('zebra')).toEqual([]);
    expect(noSettingsMatch(' zebra ')).toBe('No settings match "zebra".');
  });

  test('ids are unique, every drill-in has a title and a route', () => {
    expect(new Set(SETTINGS_INDEX.map((e) => e.id)).size).toBe(SETTINGS_INDEX.length);
    for (const entry of SETTINGS_INDEX) {
      expect(PAGE_TITLE[entry.page]).toBeTruthy();
      if (entry.page !== 'index') expect(PAGE_ROUTE[entry.page]).toMatch(/^\/settings\//);
    }
  });
});

describe('hub lines', () => {
  test('mode labels are words, never the stored ids (spec §7 #34)', () => {
    expect(MODE_ORDER.map((m) => MODE_LABEL[m])).toEqual(['Flashcards', 'Typing', 'Quiz', 'Mixed']);
    expect(modeLabel('mc')).toBe('Quiz');
    expect(modeLabel('type')).toBe('Typing');
    expect(modeLabel('weird')).toBe('Flashcards');
  });

  test('Study & limits line (spec §8.6)', () => {
    const s = { ...DEFAULT_APP_SETTINGS, srs: { ...DEFAULT_APP_SETTINGS.srs, dailyNewLimit: 10, dailyReviewLimit: 200 }, sessionLimit: 30 };
    expect(studySummary(s)).toBe('10 new · 200 reviews a day · sessions of 30 · Flashcards');
    expect(
      studySummary({ ...s, srs: { ...s.srs, dailyReviewLimit: NO_REVIEW_LIMIT }, sessionLimit: 0, studyMode: 'mc' }),
    ).toBe('10 new · no review limit · no session limit · Quiz');
    expect(studySummary({ ...s, srs: { ...s.srs, dailyReviewLimit: 1250 } })).toContain('1,250 reviews a day');
  });

  test('freezes line', () => {
    expect(freezesLine(2)).toBe('2 available · earn one every 7 days');
    expect(freezesLine(-1)).toBe('0 available · earn one every 7 days');
  });

  // Review round 1: the count pill's screen-reader label uses plural()
  // (spec §8.11): "1 streak freeze", never "1 streak freezes".
  test('freezes pill label is plural-aware', () => {
    expect(freezesLabel(1)).toBe('1 streak freeze');
    expect(freezesLabel(2)).toBe('2 streak freezes');
    expect(freezesLabel(0)).toBe('0 streak freezes');
    expect(freezesLabel(-3)).toBe('0 streak freezes');
    expect(freezesLabel(1200)).toBe('1,200 streak freezes');
  });
});

describe('ladders', () => {
  test('the spec ranges (§8.6): reviews 10–9,999 or No limit; session 5–200 or No limit; new 0–999', () => {
    expect(Math.min(...LADDERS.reviewsPerDay)).toBe(10);
    expect(LADDERS.reviewsPerDay.at(-1)).toBe(NO_REVIEW_LIMIT);
    expect(LADDERS.reviewsPerDay.at(-2)).toBe(9999);
    expect(LADDERS.sessionSize[0]).toBe(5);
    expect(LADDERS.sessionSize.at(-1)).toBe(0); // "No limit" last
    expect(LADDERS.sessionSize.at(-2)).toBe(200);
    expect(LADDERS.newPerDay[0]).toBe(0);
    expect(LADDERS.newPerDay.at(-1)).toBe(999);
    expect(LADDERS.reviewsGoal[0]).toBe(0);
    expect(LADDERS.knownChecks[0]).toBe(0);
  });

  test('a stored value off the ladder is added in its place (the stepper shows the true setting)', () => {
    expect(ladderWith([10, 20, 30], 25)).toEqual([10, 20, 25, 30]);
    expect(ladderWith([10, 20, 30], 20)).toEqual([10, 20, 30]);
    expect(ladderWith(LADDERS.sessionSize, 33, sessionRank).slice(5, 8)).toEqual([30, 33, 35]);
    expect(ladderWith(LADDERS.sessionSize, 300, sessionRank).slice(-3)).toEqual([200, 300, 0]);
    expect(ladderWith([1, 2], Number.NaN)).toEqual([1, 2]);
  });

  test('the words of special values', () => {
    expect(stepWords.reviews(NO_REVIEW_LIMIT)).toBe('No limit');
    expect(stepWords.reviews(1500)).toBe('1,500');
    expect(stepWords.session(0)).toBe('No limit');
    expect(stepWords.offWhenZero(0)).toBe('Off');
    expect(stepWords.offWhenZero(5)).toBe('5');
  });
});

describe('danger zone', () => {
  test('the Erase list uses plural() ("1 deck", never "1 decks")', () => {
    expect(eraseConsequences({ decks: 1, cards: 1, sessions: 1, streak: 1, level: 2 })).toEqual([
      '1 deck and 1 card',
      'All study progress, the review history and 1 session',
      'Your 1-day streak and level 2',
      'Every setting and reminder',
    ]);
    expect(eraseConsequences({ decks: 3, cards: 1240, sessions: 0, streak: 0, level: 1 }).slice(0, 3)).toEqual([
      '3 decks and 1,240 cards',
      'All study progress, the review history and 0 sessions',
      'Your level 1 and achievements',
    ]);
  });

  test('"erased" only when the save committed (W2 hardening leftover)', () => {
    expect(eraseResultMessage({ ok: true })).toBe(ERASE_COPY.done);
    expect(eraseResultMessage({ ok: false })).toBe(ERASE_COPY.notSaved);
    expect(eraseResultMessage(undefined)).toBe(ERASE_COPY.notSaved);
    expect(ERASE_COPY.notSaved).toContain('not saved');
    expect(ERASE_COPY.saved).toBe('Backup saved ✓');
    expect(ERASE_COPY.exportFirst).toBe('Export a backup first');
  });

  // Review round 1: spec §8.6 "then a 1-second hold **"Erase everything"**".
  // The hold itself is told by the HoldButton's accessibility hint.
  test('the hold button says exactly "Erase everything"', () => {
    expect(ERASE_COPY.hold).toBe('Erase everything');
  });

  // Review round 2: spec §8.6 orders the steps: export → "Backup saved ✓" →
  // then the hold. Before, the hold worked while "Saving a backup…" was
  // shown: the library was erased, the sheet closed, and a failed backup was
  // reported inside the closed sheet.
  test('while the backup is being saved, the hold is OFF and the sheet stays open', () => {
    expect(eraseSheetControls('busy', false)).toEqual({ holdDisabled: true, keepOpen: true });
    // Before the export, after it worked, and after it failed: the hold works
    // (erasing without a backup is still the learner's choice), and the sheet can close.
    for (const state of ['idle', 'done', 'failed'] as const) {
      expect(eraseSheetControls(state, false)).toEqual({ holdDisabled: false, keepOpen: false });
    }
    // An erase that runs already: no second hold.
    expect(eraseSheetControls('done', true).holdDisabled).toBe(true);
  });

  test('the Settings hub wires the hold and the sheet to eraseSheetControls', () => {
    const hub = fs.readFileSync(path.resolve(__dirname, '..', '..', 'app', '(tabs)', 'settings', 'index.tsx'), 'utf8');
    expect(hub).toMatch(/<HoldButton[^>]*disabled=\{eraseControls\.holdDisabled\}/);
    expect(hub).toMatch(/<Sheet\s+open=\{eraseOpen\}\s+onClose=\{closeErase\}/);
    // The hold's handler checks the RUNNING export too (a hold that started before the export tap).
    expect(hub).toMatch(/if \(erasing \|\| exportRunning\.current\) return;/);
  });
});

/* -------------------------------------- the hub under every drill-in */

describe('withHubBelow — the Settings hub is always the first page (review round 2)', () => {
  const reminders = { key: 'reminders-K', name: 'reminders', params: { enable: '1' } };

  test('a lone drill-in gets the hub under it; the drill-in route stays the same object', () => {
    const state = { key: 'stack-1', stale: false as const, type: 'stack', index: 0, routes: [reminders] };
    const next = withHubBelow(state);
    expect(next).toEqual({ key: 'stack-1', stale: false, type: 'stack', index: 1, routes: [{ name: HUB_ROUTE }, reminders] });
    expect(next!.routes[1]).toBe(reminders); // same key and params: the page is not mounted again
  });

  test('the hub is already first, or there is no state → null (nothing to do)', () => {
    expect(withHubBelow({ index: 1, routes: [{ key: 'h', name: 'index' }, reminders] })).toBeNull();
    expect(withHubBelow({ index: 0, routes: [{ key: 'h', name: 'index' }] })).toBeNull();
    expect(withHubBelow(undefined)).toBeNull();
    expect(withHubBelow({ index: 0, routes: [] })).toBeNull();
  });

  test('keepHubBelow dispatches one RESET only when the hub is missing', () => {
    const dispatch = jest.fn<(action: { type: 'RESET'; payload: object }) => void>();
    keepHubBelow({ getState: () => ({ index: 0, routes: [reminders] }), dispatch });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toEqual({ type: 'RESET', payload: { index: 1, routes: [{ name: 'index' }, reminders] } });
    keepHubBelow({ getState: () => ({ index: 1, routes: [{ name: 'index' }, reminders] }), dispatch });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

/**
 * A tiny navigator for the test: React Navigation's real builder and router,
 * drawing plain elements. A stack draws every page (like a real stack). A
 * tab bar draws a tab only once it was opened, and then keeps it (like the
 * app's `lazy: true` tabs: the Settings stack does not exist before the
 * first visit, and keeps its pages after).
 */
function testNavigator(router: typeof StackRouter | typeof TabRouter, draw: 'all' | 'visited') {
  type Options = Parameters<typeof useNavigationBuilder>[1];
  function Navigator(props: Options) {
    const { state, descriptors, NavigationContent } = useNavigationBuilder(router, props);
    const focused = state.routes[state.index].key;
    const [visited, setVisited] = useState<string[]>([focused]);
    // Adjust state during render (a newly opened tab is drawn from now on).
    // Tabs only: a stack's new route has no fixed key until its state is
    // saved, so a re-render here would make a new key each time.
    if (draw === 'visited' && !visited.includes(focused)) setVisited([...visited, focused]);
    const keys = state.routes
      .map((r) => r.key)
      .filter((k) => draw === 'all' || k === focused || visited.includes(k));
    return React.createElement(NavigationContent, null, keys.map((k) => descriptors[k].render()));
  }
  return createNavigatorFactory(Navigator)();
}

const TestTabs = testNavigator(TabRouter, 'visited');
const TestStack = testNavigator(StackRouter, 'all');

/** How often each Settings page was mounted (written by the pages' effects). */
const mounts = { index: 0, reminders: 0 };

function SettingsPage({ name }: { name: 'index' | 'reminders' }) {
  useEffect(() => {
    mounts[name] += 1;
  }, [name]);
  return null;
}
const HubPage = () => React.createElement(SettingsPage, { name: 'index' });
const RemindersPage = () => React.createElement(SettingsPage, { name: 'reminders' });
const TodayPage = () => null;

/** The Settings tab: a stack with the hub and a drill-in, with or without the repair. */
const SettingsWithRepair = () =>
  React.createElement(
    TestStack.Navigator,
    { screenListeners: hubRepairListeners },
    React.createElement(TestStack.Screen, { name: 'index', component: HubPage }),
    React.createElement(TestStack.Screen, { name: 'reminders', component: RemindersPage }),
  );
const SettingsWithoutRepair = () =>
  React.createElement(
    TestStack.Navigator,
    {},
    React.createElement(TestStack.Screen, { name: 'index', component: HubPage }),
    React.createElement(TestStack.Screen, { name: 'reminders', component: RemindersPage }),
  );

type TestRef = ReturnType<typeof createNavigationContainerRef<ParamListBase>>;

/** The app's shape: tabs (Today first), Settings = the stack above. */
function mountApp(withRepair: boolean): { ref: TestRef; unmount: () => void } {
  mounts.index = 0;
  mounts.reminders = 0;
  const ref = createNavigationContainerRef<ParamListBase>();
  const tabs = React.createElement(
    TestTabs.Navigator,
    {},
    React.createElement(TestTabs.Screen, { name: 'today', component: TodayPage }),
    React.createElement(TestTabs.Screen, {
      name: 'settings',
      component: withRepair ? SettingsWithRepair : SettingsWithoutRepair,
    }),
  );
  // The container's props type requires `children` (a .ts test has no JSX).
  const containerProps: React.ComponentProps<typeof BaseNavigationContainer> = { ref, children: tabs };
  let renderer: ReactTestRenderer | null = null;
  act(() => {
    renderer = TestRenderer.create(React.createElement(BaseNavigationContainer, containerProps));
  });
  return { ref, unmount: () => act(() => renderer!.unmount()) };
}

/** The Settings stack's state (null while the tab has never been opened). */
function settingsStack(root: NavigationState): NavigationState | null {
  const tab = root.routes.find((r) => r.name === 'settings');
  return (tab?.state as NavigationState | undefined) ?? null;
}

/**
 * What expo-router dispatches for Today's plain
 * `router.push('/(tabs)/settings/reminders?enable=1')` while the Settings
 * stack is not mounted: a navigate to the tab with ONLY the last route
 * (`getPayloadFromStateRoute`), and no `initial: false` (that needs `withAnchor`).
 */
function openRemindersFromToday(ref: TestRef) {
  act(() => {
    ref.navigate('settings', { screen: 'reminders', params: { enable: '1' } });
  });
}

describe('the Settings stack on a real navigator (review round 2)', () => {
  test('the bug, without the repair: the stack is [reminders], and back leaves the tab for good', () => {
    const { ref, unmount } = mountApp(false);
    openRemindersFromToday(ref);
    expect(settingsStack(ref.getRootState())!.routes.map((r) => r.name)).toEqual(['reminders']);
    act(() => ref.goBack());
    const root = ref.getRootState();
    expect(root.routes[root.index].name).toBe('today'); // back left the Settings tab
    expect(settingsStack(root)!.routes.map((r) => r.name)).toEqual(['reminders']); // and the tab stays on it
    unmount();
  });

  test('with the repair: the hub is put under Reminders, Reminders is NOT mounted again, back lands on the hub', () => {
    const { ref, unmount } = mountApp(true);
    openRemindersFromToday(ref);
    const stack = settingsStack(ref.getRootState())!;
    expect(stack.routes.map((r) => r.name)).toEqual(['index', 'reminders']);
    expect(stack.index).toBe(1);
    expect(stack.routes[1].params).toEqual({ enable: '1' }); // the request is kept for the screen
    expect(mounts.reminders).toBe(1); // the same page: `?enable=1` runs its flow once
    expect(new Set(stack.routes.map((r) => r.key)).size).toBe(2); // the hub got its own key

    act(() => ref.goBack());
    const root = ref.getRootState();
    expect(root.routes[root.index].name).toBe('settings'); // still on the Settings tab…
    expect(settingsStack(root)!.routes.map((r) => r.name)).toEqual(['index']); // …on the hub
    expect(mounts.index).toBe(1);
    unmount();
  });

  test('opened from the hub (the stack exists already): nothing is reset', () => {
    const { ref, unmount } = mountApp(true);
    act(() => ref.navigate('settings'));
    act(() => ref.navigate('settings', { screen: 'reminders' }));
    const stack = settingsStack(ref.getRootState())!;
    expect(stack.routes.map((r) => r.name)).toEqual(['index', 'reminders']);
    expect(mounts).toEqual({ index: 1, reminders: 1 });
    unmount();
  });

  test('the Settings layout uses these listeners', () => {
    const layout = fs.readFileSync(path.resolve(__dirname, '..', '..', 'app', '(tabs)', 'settings', '_layout.tsx'), 'utf8');
    expect(layout).toMatch(/screenListeners=\{hubRepairListeners\}/);
    expect(layout).toMatch(/anchor: 'index'/);
  });
});

/* ------------------------------------- Your data: history and images */

const row = (seq: number): RevlogRow => ({
  seq,
  cardId: 'c1',
  deckId: 'd1',
  atMs: FIXED_NOW - seq,
  rating: 'good',
  bucket: 'review',
  ivlBefore: 1,
  ivlAfter: 3,
  easeAfter: 2.5,
  durationMs: 1200,
});

const image: BackupMedia = { deckId: 'd1', name: 'haus.webp', base64: 'AAAA' };

/** A fake phone: backups folder, cache, share sheet, history table and image folders. */
function fakeIO(opts: { revlog?: RevlogRow[]; revlogFails?: boolean; tooBig?: boolean } = {}) {
  const docs = new Map<string, string>();
  const cache = new Map<string, string | Uint8Array>();
  const shared: { uri: string; kind: ShareKind }[] = [];
  const history = { rows: [...(opts.revlog ?? [])] };
  const media: BackupMedia[] = [];
  const readMedia = jest.fn(async (_deckIds: readonly string[], _max: number) => ({
    items: opts.tooBig ? [] : [image],
    tooBig: opts.tooBig === true,
  }));
  const saved = (name: string, where: string): SavedFile => ({ name, uri: `file:///${where}/${name}` });
  const io: BackupIO = {
    writeCache: (name, content) => (cache.set(name, content), saved(name, 'cache')),
    clearCache: (prefix) => {
      for (const name of [...cache.keys()]) if (name.startsWith(prefix)) cache.delete(name);
    },
    writeDocument: (name, content) => (docs.set(name, content), saved(name, 'backups')),
    share: async (uri, kind) => (shared.push({ uri, kind }), true),
    list: (prefix = ''): BackupFileInfo[] =>
      [...docs.keys()]
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name, uri: `file:///backups/${name}`, size: docs.get(name)!.length, modifiedAt: null })),
    remove: (name) => {
      docs.delete(name);
    },
    readRevlog: async () => {
      if (opts.revlogFails) throw new Error('database is locked');
      return [...history.rows];
    },
    readMedia,
    writeMedia: (items) => {
      media.push(...items);
      return { written: items.length, failed: [] };
    },
    writeCacheBytes: (name, bytes) => (cache.set(name, bytes), saved(name, 'cache')),
  };
  /**
   * The restore's replace-all on this phone, as the row port does it: the
   * history table gets exactly the rows the restore hands over, in the SAME
   * transaction (the restored libraries here have an empty review log).
   */
  const replaceAll = (_state: DataStateV3, rows: readonly RevlogRow[]) => {
    history.rows = [...rows];
  };
  return { io, docs, cache, shared, history, media, readMedia, replaceAll };
}

const libraryWithDeck = () => makeStateV3({ decks: [makeDeckV3({ id: 'd1', name: 'German' })] });

/** The envelope that was shared (the one cache file). */
function sharedEnvelope(cache: Map<string, string | Uint8Array>): Record<string, unknown> {
  const text = [...cache.values()].find((v): v is string => typeof v === 'string');
  return JSON.parse(text ?? 'null') as Record<string, unknown>;
}

describe('Your data — "Export a backup" carries the history and the images', () => {
  test('history + images on → both are in the backup, and the share sheet opens', async () => {
    const disk = fakeIO({ revlog: [row(1), row(2)] });
    const outcome = await exportBackup(libraryWithDeck(), FIXED_NOW, disk.io, { images: true });
    expect(outcome.kind).toBe('shared');
    expect(exportMessage(outcome)).toBeNull();
    const envelope = sharedEnvelope(disk.cache);
    expect(envelope.revlog).toEqual([row(1), row(2)]);
    expect(envelope.media).toEqual([image]);
  });

  test('"Include images" off → no images (they are not even read)', async () => {
    const disk = fakeIO({ revlog: [row(1)] });
    await exportBackup(libraryWithDeck(), FIXED_NOW, disk.io, { images: false });
    expect(disk.readMedia).not.toHaveBeenCalled();
    expect(sharedEnvelope(disk.cache)).not.toHaveProperty('media');
  });

  test('images larger than 50 MB → the backup has none, and the user is told', async () => {
    const disk = fakeIO({ tooBig: true });
    const outcome = await exportBackup(libraryWithDeck(), FIXED_NOW, disk.io, { images: true });
    expect(outcome).toMatchObject({ kind: 'shared', imagesLeftOut: true });
    expect(disk.readMedia.mock.calls[0][1]).toBe(50 * 1024 * 1024);
    expect(exportMessage(outcome)).toBe(IMAGES_LEFT_OUT);
    expect(sharedEnvelope(disk.cache)).not.toHaveProperty('media');
  });

  test('the history cannot be read → NO backup at all (never a quiet loss)', async () => {
    const disk = fakeIO({ revlogFails: true });
    const outcome = await exportBackup(libraryWithDeck(), FIXED_NOW, disk.io, { images: true });
    expect(outcome).toEqual({ kind: 'failed', because: 'history' });
    expect(disk.shared).toEqual([]);
    expect(disk.cache.size + disk.docs.size).toBe(0);
    expect(exportMessage(outcome)).toContain('review history');
  });

  test('the Erase sheet export keeps the history too (the erase deletes it)', async () => {
    const disk = fakeIO({ revlog: [row(1)] });
    const outcome = await exportAndKeepBackup(libraryWithDeck(), FIXED_NOW, disk.io, { images: true });
    expect(outcome.kind).toBe('kept');
    const text = [...disk.docs.values()][0];
    expect((JSON.parse(text) as { revlog: unknown }).revlog).toEqual([row(1)]);

    const failing = fakeIO({ revlogFails: true });
    const failed = await exportAndKeepBackup(libraryWithDeck(), FIXED_NOW, failing.io);
    expect(failed).toEqual({ kind: 'failed', because: 'history' });
    expect(keptExportMessage(failed)).toContain('review history');
  });
});

describe('Your data — a restore writes the history and the images back', () => {
  /** A backup file with history and an image, read like the Restore flow reads it. */
  async function backupFile() {
    const source = fakeIO({ revlog: [row(7), row(8)] });
    await exportBackup(libraryWithDeck(), FIXED_NOW, source.io, { images: true });
    const text = [...source.cache.values()].find((v): v is string => typeof v === 'string')!;
    const read = readBackup(text, FIXED_NOW);
    if (read.kind !== 'ok') throw new Error('not a backup');
    return read;
  }

  test('copy (with the CURRENT history) → restore → save → history and images', async () => {
    const read = await backupFile();
    expect(read.revlog).toHaveLength(2);
    expect(read.media).toEqual([image]);

    const phone = fakeIO({ revlog: [row(1)] });
    const steps: string[] = [];
    const result = await performRestore({
      current: libraryWithDeck(),
      next: read.state,
      now: FIXED_NOW,
      restore: (state, rows) => {
        steps.push('restore');
        phone.replaceAll(state, rows); // the history is part of the replace-all
      },
      flush: async () => (steps.push('flush'), { ok: true as const }),
      extras: { revlog: read.revlog, media: read.media },
      io: phone.io,
    });
    expect(result).toBe('restored');
    expect(steps).toEqual(['restore', 'flush']);
    expect(phone.history.rows.map((r) => r.seq)).toEqual([7, 8]);
    expect(phone.media).toEqual([image]);
    // The way back keeps the history the phone had before.
    const copy = [...phone.docs.entries()].find(([name]) => name.startsWith('before-restore-'))!;
    expect((JSON.parse(copy[1]) as { revlog: RevlogRow[] }).revlog.map((r) => r.seq)).toEqual([1]);
    expect(restoreResultMessage(result, restoreSummary(read.state, null))).toBe('Restored — 1 deck, 0 cards.');
  });

  test('a history row of the backup that cannot be written → "restored", but it says what is missing', async () => {
    const read = await backupFile();
    const phone = fakeIO();
    const broken = { ...row(9), cardId: '' }; // no card id: the table cannot take it
    const result = await performRestore({
      current: libraryWithDeck(),
      next: read.state,
      now: FIXED_NOW,
      restore: phone.replaceAll,
      flush: async () => ({ ok: true as const }),
      extras: { revlog: [...read.revlog, broken], media: read.media },
      io: phone.io,
    });
    expect(result).toBe('restored-incomplete');
    // The rows that can be written are written (in the replace-all).
    expect(phone.history.rows.map((r) => r.seq)).toEqual([7, 8]);
    expect(restoreResultMessage(result, restoreSummary(read.state, null))).toBe(
      `Restored — 1 deck, 0 cards. ${RESTORE_COPY.incomplete}`,
    );
  });

  test('the save fails → nothing is written after it (the history rides WITH the replace-all), and the RESTORE is called not saved', async () => {
    const read = await backupFile();
    const phone = fakeIO();
    const handed: number[][] = [];
    const result = await performRestore({
      current: libraryWithDeck(),
      next: read.state,
      now: FIXED_NOW,
      // The replace-all that does not commit: the table is not changed.
      restore: (_state, rows) => void handed.push(rows.map((r) => r.seq)),
      flush: async () => ({ ok: false as const, reason: 'write' as const }),
      extras: { revlog: read.revlog, media: read.media },
      io: phone.io,
    });
    expect(result).toBe('write-failed');
    // The backup's history went INTO the replace-all (so its retry writes it too) …
    expect(handed).toEqual([[7, 8]]);
    // … and nothing is written on its own after the failed save.
    expect(phone.history.rows).toEqual([]);
    expect(phone.media).toEqual([]);
    expect(restoreResultMessage(result, restoreSummary(read.state, null))).toBe(RESTORE_COPY.notSaved);
    expect(RESTORE_COPY.notSaved).toContain('restore was not saved');
    // Review round 1: the next save does NOT write the backup's images (only
    // a new restore does), so the line asks for a new restore and never
    // promises that Maranki saves it again by itself.
    expect(RESTORE_COPY.notSaved).toBe(
      'The restore was not saved — your phone may be out of storage. Free some space, then restore the backup again.',
    );
    expect(RESTORE_COPY.notSaved).not.toMatch(/try to save/i);
  });

  test('the current history cannot be read → no copy, so NOTHING is restored', async () => {
    const restore = jest.fn();
    const phone = fakeIO({ revlogFails: true });
    const result = await performRestore({
      current: libraryWithDeck(),
      next: makeStateV3(),
      now: FIXED_NOW,
      restore,
      flush: async () => ({ ok: true as const }),
      io: phone.io,
    });
    expect(result).toBe('copy-failed');
    expect(restore).not.toHaveBeenCalled();
  });
});

describe('Your data — "Export study history" is one zip', () => {
  const zip = new Uint8Array([80, 75, 3, 4]);
  const makeZip = async () => ({ bytes: zip });

  // Wave 5b (L8): the file is named by historyZipFileName(now), in LOCAL time
  // (the zip maker gives only the bytes).
  test('sessions → the zip goes through the share sheet as a zip, named in local time', async () => {
    const disk = fakeIO();
    const state = makeStateV3({ sessions: [makeSessionRecord()] });
    const outcome = await exportHistoryZip(state, FIXED_NOW, makeZip, disk.io);
    const name = historyZipFileName(FIXED_NOW);
    expect(name).toBe('maranki-history-2026-06-10-09-00-00.zip'); // FIXED_NOW = 10 June 2026, 09:00 local
    expect(outcome).toEqual({ kind: 'shared', name });
    expect(disk.shared).toEqual([{ uri: `file:///cache/${name}`, kind: SHARE_HISTORY_ZIP }]);
    expect(disk.cache.get(name)).toBe(zip);
  });

  test('no session yet → nothing is written (null); a zip that cannot be built → failed', async () => {
    const disk = fakeIO();
    await expect(exportHistoryZip(makeStateV3(), FIXED_NOW, makeZip, disk.io)).resolves.toBeNull();
    expect(disk.cache.size).toBe(0);
    const broken = async () => {
      throw new Error('history unreadable');
    };
    const state = makeStateV3({ sessions: [makeSessionRecord()] });
    await expect(exportHistoryZip(state, FIXED_NOW, broken, disk.io)).resolves.toEqual({ kind: 'failed' });
  });
});

/* ===================================================== wave 5b (walkthrough) */

const REPO = path.resolve(__dirname, '..', '..', '..');
const repoText = (...parts: string[]) => fs.readFileSync(path.join(REPO, ...parts), 'utf8');

/* -------------------------------------------- drawing a screen (review round 1) */

let screen: ReactTestRenderer | null = null;

afterEach(() => {
  if (screen) act(() => screen!.unmount());
  screen = null;
  mockState = makeStateV3();
  mockParams = {};
  mockExpoConfig = null;
  // mockClear keeps the fakes' own implementations; mockPush may have a test's own (reset).
  for (const fn of [mockShow, mockReplace, mockLoadStarterBytes, mockReadApkg, mockEngine.actions.applyImport]) {
    fn.mockClear();
  }
  mockPush.mockReset();
  for (const fn of Object.values(mockActions)) fn.mockClear();
  mockPlanArrivals.length = 0;
});

/** Draw one screen (it is unmounted after the test). */
function draw(element: React.ReactElement): ReactTestRenderer {
  act(() => {
    screen = TestRenderer.create(element);
  });
  return screen!;
}

/** The text of one host Text node (its string and number children, joined). */
function textOf(node: ReactTestInstance): string {
  const kids: unknown[] = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
  return kids.map((k) => (typeof k === 'string' || typeof k === 'number' ? String(k) : '')).join('');
}

/** Every text on screen, or inside one node (host Text nodes only). */
function texts(r: ReactTestRenderer | ReactTestInstance): string[] {
  const root = 'root' in r ? r.root : r;
  return root.findAll((n) => (n.type as unknown) === 'Text').map(textOf);
}

/** The nearest control (a node with onPress) around each text `text`, in screen order. */
function pressablesWithText(r: ReactTestRenderer, text: string): ReactTestInstance[] {
  const out: ReactTestInstance[] = [];
  for (const node of r.root.findAll((n) => (n.type as unknown) === 'Text' && textOf(n) === text)) {
    let at: ReactTestInstance | null = node;
    while (at && typeof at.props.onPress !== 'function') at = at.parent;
    if (at && !out.includes(at)) out.push(at);
  }
  return out;
}

/** Tap the control around the text `text` (the first one, or the `index`-th). */
function tapText(r: ReactTestRenderer, text: string, index = 0): void {
  const control = pressablesWithText(r, text)[index];
  if (!control) throw new Error(`no control with the text "${text}"`);
  act(() => control.props.onPress());
}

/** The control with this screen-reader label. */
function byLabel(r: ReactTestRenderer, label: string): ReactTestInstance {
  const node = r.root.findAll((n) => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === label)[0];
  if (!node) throw new Error(`no control labelled "${label}"`);
  return node;
}

/** The outer ScrollView of a screen. */
const outerScroll = (r: ReactTestRenderer) => r.root.findAllByType(ScrollView)[0];

/** Let the promises of a tap run (an add reads, plans and saves), a few rounds. */
async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

/* ------------------------------------------------- R3: Reset preferences */

describe('Reset preferences — the confirm text names everything it changes (wave 5b R3)', () => {
  test('the exact text', () => {
    expect(RESET_COPY.body).toBe(
      'Limits, goals, session and study options, the algorithm, reminders, audio, haptics and backup options ' +
        'all go back to their defaults. Your decks, cards, progress, backups and appearance are not changed.',
    );
    expect(RESET_COPY.title).toBe('Reset preferences?');
  });

  /**
   * Every settings key → the words of the text that name it, or 'kept' when
   * the reset keeps it. A NEW setting fails the first expect until it is
   * named here AND in the text: the text can never quietly fall behind.
   */
  const NAMED_BY: Record<keyof AppSettings, readonly string[] | 'kept'> = {
    srs: ['Limits', 'the algorithm'],
    readAloudEnabled: ['audio'],
    autoReadAloud: ['audio'],
    hapticsEnabled: ['haptics'],
    reminderEnabled: ['reminders'],
    reminderTime: ['reminders'],
    reminderSkipStudied: ['reminders'],
    sessionLimit: ['session'],
    studyMode: ['study options'],
    hintsEnabled: ['study options'],
    retryMissed: ['study options'],
    spaceSiblings: ['study options'],
    knownChecksPerDay: ['study options'],
    autoBackup: ['backup options'],
    backupImages: ['backup options'],
    lastAutoBackupAt: 'kept',
    reminderOfferSeen: 'kept',
  };

  test('every settings key is named in the text (or kept by the reset)', () => {
    expect(Object.keys(DEFAULT_APP_SETTINGS).sort()).toEqual(Object.keys(NAMED_BY).sort());
    for (const [key, words] of Object.entries(NAMED_BY)) {
      if (words === 'kept') continue;
      for (const word of words) expect([key, word, RESET_COPY.body.includes(word)]).toEqual([key, word, true]);
    }
    // The goals go back too (the hub calls setGoals), and the theme is kept.
    expect(RESET_COPY.body).toContain('goals');
    expect(RESET_COPY.body).toContain('appearance are not changed');
  });

  test('the reducer resets exactly the named keys and keeps the "kept" ones', () => {
    const changed = makeSettingsV3({
      readAloudEnabled: false,
      autoReadAloud: true,
      hapticsEnabled: false,
      reminderEnabled: true,
      reminderTime: '07:15',
      reminderSkipStudied: false,
      sessionLimit: 120,
      studyMode: 'mc',
      hintsEnabled: false,
      retryMissed: false,
      spaceSiblings: false,
      knownChecksPerDay: 0,
      autoBackup: false,
      lastAutoBackupAt: FIXED_NOW - 1000,
      backupImages: false,
      reminderOfferSeen: true,
      srs: { dailyNewLimit: 3, startingEase: 3.1 },
    });
    const state = makeStateV3({ settings: changed });
    const next = resetPreferences(state, undefined, { now: FIXED_NOW, newId: () => 'x' }).state.settings;
    // Back to the first-run settings: the defaults with the seed's new-card limit (DEFAULT_PACE, 10 a day).
    const firstRun = buildSeedState(FIXED_NOW).settings;
    for (const [key, words] of Object.entries(NAMED_BY) as [keyof AppSettings, readonly string[] | 'kept'][]) {
      expect([key, next[key]]).toEqual([key, words === 'kept' ? changed[key] : firstRun[key]]);
    }
  });

  test('the hub: "Reset preferences" opens the sheet with this text; its button resets and puts the goals back', () => {
    const r = draw(React.createElement(SettingsScreen));
    expect(texts(r)).not.toContain(RESET_COPY.body); // the sheet is closed
    tapText(r, 'Reset preferences'); // the danger-zone row
    expect(texts(r)).toContain(RESET_COPY.body);
    expect(texts(r)).toContain(RESET_COPY.title);
    // The sheet's own button has the same words as the row: it is the second one.
    tapText(r, RESET_COPY.confirm, 1);
    expect(mockActions.resetPreferences).toHaveBeenCalledTimes(1);
    // The first-run goals: the tour's middle answer, "10 new a day · about 15 min" (wave 5d; 5c had 20 / 6).
    expect(mockActions.setGoals).toHaveBeenCalledWith(30, 10);
    expect(mockShow).toHaveBeenCalledWith(RESET_COPY.done);
  });

  // Final review 2026-11: the only "hold" instruction was the screen-reader hint, so for
  // everyone else a tap on "Erase everything" did nothing and the button looked broken.
  test('the Erase sheet SHOWS how to use its hold button, right under it', () => {
    const r = draw(React.createElement(SettingsScreen));
    expect(texts(r)).not.toContain(ERASE_COPY.holdNote); // the sheet is closed
    tapText(r, ERASE_COPY.hold); // the danger-zone row has the same words
    const all = texts(r);
    expect(all).toContain(ERASE_COPY.title);
    expect(ERASE_COPY.holdNote).toBe('Press and hold for 1 second to erase.');
    // Under the hold button: the next text after its label.
    const label = all.lastIndexOf(ERASE_COPY.hold);
    expect(all[label + 1]).toBe(ERASE_COPY.holdNote);
  });
});

/* ------------------------------------------------------- L9: the footer */

describe('the footer: "Maranki 3.0.0" — a human name, never the variant id (wave 5b L9)', () => {
  test('appFooterLine', () => {
    expect(appFooterLine({ name: 'Maranki', version: '3.0.0' })).toBe('Maranki 3.0.0');
    expect(appFooterLine({ name: 'Maranki German', version: '3.0.0' })).toBe('Maranki German 3.0.0');
    // No config (a test, the web preview): the plain name, nothing broken.
    expect(appFooterLine(null)).toBe(DEFAULT_APP_NAME);
    expect(appFooterLine({ version: '3.0.0' })).toBe('Maranki 3.0.0');
    expect(appFooterLine({ name: '  ', version: 7 })).toBe('Maranki');
  });

  /** The build config of a variant: app.config.ts over app.json, as `expo` makes it. */
  function buildConfig(variant: 'generic' | 'german'): { name?: string; version?: string } {
    const appJson = JSON.parse(repoText('app.json')) as { expo: Record<string, unknown> };
    const before = process.env.APP_VARIANT;
    process.env.APP_VARIANT = variant;
    try {
      return appConfig({ config: appJson.expo } as Parameters<typeof appConfig>[0]);
    } finally {
      if (before === undefined) delete process.env.APP_VARIANT;
      else process.env.APP_VARIANT = before;
    }
  }

  test('the hub draws the build: "Maranki 3.0.0" and "Maranki German 3.0.0", never "generic"', () => {
    expect(buildConfig('generic').version).toBe('3.0.0');
    for (const [variant, line] of [
      ['generic', 'Maranki 3.0.0'],
      ['german', 'Maranki German 3.0.0'],
    ] as const) {
      mockExpoConfig = buildConfig(variant);
      const r = draw(React.createElement(SettingsScreen));
      expect(texts(r)).toContain(line);
      for (const t of texts(r)) expect(t).not.toMatch(/\bgeneric\b|\bgerman\b/);
      act(() => r.unmount());
      screen = null;
    }
  });
});

/* -------------------------------------------- M3: taps with the keyboard open */

describe('Settings search: the first tap works while the keyboard is open (wave 5b M3)', () => {
  test('the hub keeps taps ("handled"); a result row closes the keyboard, then opens its page', () => {
    const order: string[] = [];
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => void order.push('dismiss'));
    try {
      mockPush.mockImplementation((href) => void order.push(`push ${String(href)}`));
      const r = draw(React.createElement(SettingsScreen));
      expect(outerScroll(r).props.keyboardShouldPersistTaps).toBe('handled');
      // Type "reminder": the rows of the Reminders page are listed.
      act(() => r.root.findByType(TextInput).props.onChangeText('reminder'));
      const result = searchSettings('reminder').find((e) => e.page === 'reminders')!;
      tapText(r, result.title);
      expect(order).toEqual(['dismiss', `push ${PAGE_ROUTE.reminders}`]);
    } finally {
      dismiss.mockRestore();
    }
  });

  test('the tour keeps taps too ("handled")', () => {
    mockState = makeStateV3({ onboarded: false });
    const r = draw(React.createElement(OnboardingScreen));
    expect(outerScroll(r).props.keyboardShouldPersistTaps).toBe('handled');
  });
});

/* ------------------------------------------------ L6 + L7: the tour's answers */

/** The tour's Time answers on screen: [title, selected]. */
function timeAnswers(r: ReactTestRenderer): [string, boolean][] {
  return r.root
    .findAll((n) => typeof n.props.onPress === 'function' && n.props.accessibilityRole === 'radio')
    .map((n) => [texts(n)[0], n.props.accessibilityState?.checked === true]);
}

// Wave 5d (a product decision, a deliberate reversal of wave 5c): the answers are 5 / 10 / 20 new
// cards a day again, and each one says its real time ("10 new a day · about 15 min"). Wave 5c had
// chosen 3 / 6 / 12 new a day only so that the labels could say "5 / 10 / 20 min".
describe('the tour: "5 / 10 / 20 new a day" with their real minutes, and a first run selects the middle one', () => {
  /** The pace of an install from wave 5c (6 new a day, goals 20 / 6): no answer of the tour any more. */
  const wave5c = { dailyNewLimit: 6, goalReviews: 20, goalNew: 6 };

  test('tourPace: a first run selects the middle answer with no "Keep my pace"; a replay keeps the learner\'s own', () => {
    expect(FIRST_RUN_PACE).toBe('ten');
    expect(tourPace(wave5c, false)).toEqual({ selected: 'ten', offerOwn: false });
    expect(tourPace(wave5c, true)).toEqual({ selected: 'own', offerOwn: true });
    // Values that ARE an answer: that answer, first run or replay. The seed is the middle one.
    const five = { dailyNewLimit: 5, goalReviews: 15, goalNew: 5 };
    expect(tourPace(five, false)).toEqual({ selected: 'five', offerOwn: false });
    expect(tourPace(five, true)).toEqual({ selected: 'five', offerOwn: false });
    const seed = { dailyNewLimit: 10, goalReviews: 30, goalNew: 10 };
    expect(tourPace(seed, true)).toEqual({ selected: 'ten', offerOwn: false });
  });

  test('every answer says the minutes of its own cards (minutesFor): 8, 15 and 31', () => {
    expect(PACES.map((p) => minutesFor(p.dailyNewLimit + p.goalReviews))).toEqual([8, 15, 31]);
    for (const p of PACES) expect(p.label).toContain(`about ${minutesFor(p.dailyNewLimit + p.goalReviews)} min`);
  });

  test('a first run: the three answers, the middle one selected; Continue writes its cards; then "Remind me at 8:00 PM"', () => {
    // The old app's time is stored ('21:00'); this learner never chose it. The pace is the one a
    // wave-5c install got (6 new, goals 20 / 6): no answer, so the middle answer is selected.
    mockState = makeStateV3({
      onboarded: false,
      settings: makeSettingsV3({ reminderTime: '21:00', srs: { dailyNewLimit: 6 } }),
      person: makePersonV3({ goalReviews: 20, goalNew: 6 }),
    });
    const r = draw(React.createElement(OnboardingScreen));
    tapText(r, 'Get started');
    expect(texts(r)).toContain('How much time a day?');
    expect(timeAnswers(r)).toEqual([
      ['5 new a day · about 8 min', false],
      ['10 new a day · about 15 min', true],
      ['20 new a day · about 31 min', false],
    ]);
    tapText(r, 'Continue');
    expect(mockActions.setLimits).toHaveBeenCalledWith({ dailyNewLimit: 10 });
    expect(mockActions.setGoals).toHaveBeenCalledWith(30, 10);
    // L7: the Reminder step offers 8:00 PM.
    expect(texts(r)).toContain('Remind me at 8:00 PM');
  });

  test("a replay: the learner's own pace is selected (\"Keep my pace\"), nothing is written; their own time", () => {
    mockParams = { replay: '1' };
    // The wave-5c pace (6 new + 20 reviews = 10 min): the learner's own, no answer. It is kept.
    mockState = makeStateV3({
      settings: makeSettingsV3({ reminderTime: '21:00', srs: { dailyNewLimit: 6 } }),
      person: makePersonV3({ goalReviews: 20, goalNew: 6 }),
    });
    const r = draw(React.createElement(OnboardingScreen));
    tapText(r, 'Get started');
    expect(timeAnswers(r)).toEqual([
      ['5 new a day · about 8 min', false],
      ['10 new a day · about 15 min', false],
      ['20 new a day · about 31 min', false],
      ['Keep my pace — about 10 min: 6 new, about 20 reviews', true],
    ]);
    tapText(r, 'Continue');
    expect(mockActions.setLimits).not.toHaveBeenCalled();
    expect(mockActions.setGoals).not.toHaveBeenCalled();
    expect(texts(r)).toContain('Remind me at 9:00 PM');
  });
});

describe("the tour's reminder time (wave 5b L7)", () => {
  test('a first run with reminders off offers 8:00 PM, whatever old time is stored', () => {
    expect(tourReminderTime({ reminderEnabled: false, reminderTime: '21:00' }, false)).toBe('20:00');
    expect(tourReminderTime({ reminderEnabled: false, reminderTime: '20:00' }, false)).toBe('20:00');
    expect(DEFAULT_APP_SETTINGS.reminderTime).toBe('20:00');
  });

  test("a replay, or reminders that are on: the learner's own time", () => {
    expect(tourReminderTime({ reminderEnabled: false, reminderTime: '21:00' }, true)).toBe('21:00');
    expect(tourReminderTime({ reminderEnabled: true, reminderTime: '07:30' }, false)).toBe('07:30');
  });
});

/* -------------------------------------------- R2: a backup without history */

describe('Restore: a backup WITHOUT review history keeps the phone history (wave 5b R2)', () => {
  /** A weekly backup written before wave 5: the state, no `revlog` in the file. */
  function oldWeeklyBackup() {
    const read = readBackup(JSON.stringify({ format: 'maranki-backup', version: 1, schemaVersion: 3, exportedAt: FIXED_NOW, app: { variant: 'generic', version: '2.2.0' }, data: libraryWithDeck() }), FIXED_NOW);
    if (read.kind !== 'ok') throw new Error('not a backup');
    return read;
  }

  test('the restore writes the current history back; the confirm sheet said so', async () => {
    const read = oldWeeklyBackup();
    expect(read.revlog).toEqual([]);
    const phone = fakeIO({ revlog: [row(1), row(2), row(3)] });
    const extras = { revlog: read.revlog, media: read.media };
    // The confirm sheet's line: the Restore flow counts the rows the restore writes back.
    const summary = restoreSummary(read.state, FIXED_NOW, await keptHistoryCount(read.state, extras, phone.io));
    expect(restoreHistoryNote(summary)).toBe(
      'This backup has no review history, so your current review history is kept.',
    );
    const result = await performRestore({
      current: libraryWithDeck(),
      next: read.state,
      now: FIXED_NOW,
      restore: phone.replaceAll, // the kept history is part of the replace-all
      flush: async () => ({ ok: true as const }),
      extras,
      io: phone.io,
    });
    expect(result).toBe('restored');
    expect(phone.history.rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(restoreResultMessage(result, summary)).toBe('Restored — 1 deck, 0 cards.');
  });

  test('a backup WITH history: the backup history wins, the phone history is not written back', async () => {
    const maker = fakeIO({ revlog: [row(7)] });
    await exportBackup(libraryWithDeck(), FIXED_NOW, maker.io);
    const text = [...maker.cache.values()].find((v): v is string => typeof v === 'string')!;
    const read = readBackup(text, FIXED_NOW);
    if (read.kind !== 'ok') throw new Error('not a backup');
    const phone = fakeIO({ revlog: [row(1), row(2)] });
    const extras = { revlog: read.revlog, media: read.media };
    expect(await keptHistoryCount(read.state, extras, phone.io)).toBe(0);
    expect(restoreHistoryNote(restoreSummary(read.state, null, 0))).toBeNull();
    await performRestore({
      current: libraryWithDeck(),
      next: read.state,
      now: FIXED_NOW,
      restore: phone.replaceAll,
      flush: async () => ({ ok: true as const }),
      extras,
      io: phone.io,
    });
    expect(phone.history.rows.map((r) => r.seq)).toEqual([7]);
  });

  test('the replace-all that carries the kept history fails → "not saved", and the phone history is still in the table (final review)', async () => {
    const read = oldWeeklyBackup();
    const phone = fakeIO({ revlog: [row(1), row(2)] });
    const handed: number[][] = [];
    const result = await performRestore({
      current: libraryWithDeck(),
      next: read.state,
      now: FIXED_NOW,
      // The disk is full: the replace-all does not commit, so the table is not changed.
      restore: (_state, rows) => void handed.push(rows.map((r) => r.seq)),
      flush: async () => ({ ok: false as const, reason: 'write' as const }),
      extras: { revlog: read.revlog, media: read.media },
      io: phone.io,
    });
    expect(result).toBe('write-failed');
    // The kept rows rode WITH the replace-all (its retry writes them too) …
    expect(handed).toEqual([[1, 2]]);
    // … so the table never stood empty, and a new restore keeps them again.
    expect(phone.history.rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(await keptHistoryCount(read.state, { revlog: read.revlog, media: read.media }, phone.io)).toBe(2);
  });

  test('the note comes from the history TABLE: an empty undo window with rows in the table still says it', async () => {
    // migrate() dropped the log entries (no usable card id), but their rows stay in the table.
    const read = oldWeeklyBackup();
    expect(read.state.reviewLog).toEqual([]);
    const phone = fakeIO({ revlog: [row(4), row(5)] });
    const extras = { revlog: read.revlog, media: read.media };
    expect(await keptHistoryCount(read.state, extras, phone.io)).toBe(2);
    // No history on this phone (or a table that cannot be read): nothing to say.
    expect(await keptHistoryCount(read.state, extras, fakeIO().io)).toBe(0);
    expect(await keptHistoryCount(read.state, extras, fakeIO({ revlog: [row(1)], revlogFails: true }).io)).toBe(0);
    expect(restoreSummary(read.state, FIXED_NOW)).toEqual({ at: FIXED_NOW, decks: 1, cards: 0, streak: 0 });
  });

  test('the confirm sheet draws the note only when the history is kept', () => {
    const state = libraryWithDeck();
    const r = draw(
      React.createElement(RestoreConfirmSheet, {
        open: true,
        summary: restoreSummary(state, FIXED_NOW, 3),
        busy: false,
        onConfirm: () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(texts(r)).toContain(RESTORE_COPY.keepsHistory);
    act(() =>
      r.update(
        React.createElement(RestoreConfirmSheet, {
          open: true,
          summary: restoreSummary(state, FIXED_NOW, 0),
          busy: false,
          onConfirm: () => undefined,
          onCancel: () => undefined,
        }),
      ),
    );
    expect(texts(r)).not.toContain(RESTORE_COPY.keepsHistory);
    expect(texts(r)).toContain(RESTORE_COPY.title);
  });
});

/* -------------------------------------- R4: onboarding's rows after a save */

const VERBS: StarterDeck = { key: 'verbs', title: 'German verbs', subtitle: 'Verbs', asset: 1, version: 1 };
const GRAMMAR: StarterDeck = { key: 'grammar', title: 'German grammar', subtitle: 'Grammar', asset: 2, version: 1 };

/** An add that made a new deck with `cards` cards (what onboarding's list reads of an outcome). */
function added(deckId: string, cards: number): Pick<StarterDeckOutcome, 'kind' | 'result' | 'deckId' | 'images' | 'elsewhereDecks'> {
  return {
    kind: 'add',
    result: { cardsAdded: cards, markedKnown: 0 } as unknown as ImportResult,
    deckId,
    images: 'none',
    elsewhereDecks: [],
  };
}

describe("onboarding's starter rows are checked again after each save (wave 5b R4)", () => {
  const notSaved = { ok: false as const, reason: 'write' as const, cause: new Error('disk full') };

  test('a later save that commits saves the earlier unsaved deck too: its row says what was added', () => {
    // Verbs: added in memory, its save failed → "not saved".
    const verbs = starterRunRowAfter(starterRunRow(VERBS), added('d-verbs', 1364), notSaved);
    expect(verbs.status).toBe('failed');
    expect(verbs.unsaved).not.toBeNull();
    // Grammar's own save commits: it wrote the whole library, verbs too.
    const grammar = starterRunRowAfter(starterRunRow(GRAMMAR), added('d-grammar', 906), { ok: true });
    const rows = starterRunRowsAfterSave([verbs, grammar], { ok: true });
    expect(rows.map((r) => [r.starter.key, r.status, r.line])).toEqual([
      ['verbs', 'added', '1,364 cards added'],
      ['grammar', 'added', '906 cards added'],
    ]);
    expect(rows[0].unsaved).toBeNull();
    expect(rows[0].deckIds).toEqual(['d-verbs']);
    expect(starterRunCounts(rows)).toMatchObject({ added: 2, unsaved: 0, missing: 0, deckIds: ['d-verbs', 'd-grammar'] });
  });

  test('a save that failed, or no save at all, changes nothing; a deck that is not in the library stays missing', () => {
    const verbs = starterRunRowAfter(starterRunRow(VERBS), added('d-verbs', 1364), notSaved);
    const threw = starterRunRowThrew(starterRunRow(GRAMMAR));
    expect(starterRunRowsAfterSave([verbs, threw], notSaved)).toEqual([verbs, threw]);
    expect(starterRunRowsAfterSave([verbs, threw], null)).toEqual([verbs, threw]);
    const after = starterRunRowsAfterSave([verbs, threw], { ok: true });
    expect(after[1]).toEqual(threw); // nothing of it was applied: it is still "Could not be added."
    expect(after[1].line).toBe(STARTER_RUN_LINE.failed);
    expect(starterRunRowSaved(after[0])).toBe(after[0]); // an added row comes back as it is
  });

  // Review round 1: onboarding's loop calls ONE helper for a try, so the check cannot be left out.
  test('one try (starterRunRowsAfterTry): its row, then every row again', () => {
    // Verbs: added in memory, its save failed → "not saved". Grammar is being added now.
    const verbs = starterRunRowAfter(starterRunRow(VERBS), added('d-verbs', 1364), notSaved);
    const adding = { ...starterRunRow(GRAMMAR), status: 'adding' as const, line: '' };
    const rows = [verbs, adding];
    // Grammar's try saved: verbs is on the disk too.
    const after = starterRunRowsAfterTry(rows, 1, added('d-grammar', 906), { ok: true });
    expect(after.map((r) => [r.starter.key, r.status, r.line])).toEqual([
      ['verbs', 'added', '1,364 cards added'],
      ['grammar', 'added', '906 cards added'],
    ]);
    expect(rows[1]).toBe(adding); // the rows given are not changed
    // Grammar's save failed too: both say "not saved", and neither is lost.
    const failed = starterRunRowsAfterTry(rows, 1, added('d-grammar', 906), notSaved);
    expect(failed.map((r) => r.status)).toEqual(['failed', 'failed']);
    expect(starterRunCounts(failed)).toMatchObject({ added: 0, unsaved: 2, missing: 0 });
  });
});

/* ---------------------------------------- R5: one read, one plan (AddSheet) */

/** The verbs fixture as the rows of the .apkg reader, copied `copies` times with new ids (a bigger deck). */
function verbsRows(copies: number): ApkgRows {
  // Destructured: the face guard (face.test.ts) forbids a direct read of the note list here.
  const { fileName, col, notes: fileNotes, cards: fileCards, media } = ankiFixture('german_verbs');
  const notes: ApkgRows['notes'] = [];
  const cards: ApkgRows['cards'] = [];
  for (let k = 0; k < copies; k++) {
    const shift = k * 1_000_000;
    for (const n of fileNotes as unknown as ApkgRows['notes']) notes.push({ ...n, id: Number(n.id) + shift, guid: `${n.guid}~${k}` });
    for (const c of fileCards as unknown as ApkgRows['cards']) cards.push({ ...c, id: Number(c.id) + shift, nid: Number(c.nid) + shift });
  }
  return { fileName, col, notes, cards, media } as ApkgRows;
}

const STARTER_PACK: ContentPack = { id: 'german', cardTypePresets: [], starterDecks: [VERBS] };

type Lib = StarterLibrary & { decks: ReturnType<typeof makeDeckV3>[] };

/** A phone for `addStarterOnce`: the library, the applied plans, the saves, and the file loads. */
function starterPhone() {
  let lib: Lib = { noteTypes: [], notes: [], cards: [], decks: [], settings: { srs: DEFAULT_SRS } } as unknown as Lib;
  const applied: ImportPlan[] = [];
  const loadBytes = jest.fn(async (_starter: StarterDeck) => new Uint8Array([1, 2, 3]));
  let n = 0;
  const deps: StarterDeps = {
    getState: () => lib,
    applyImport: (plan) => {
      applied.push(plan);
      // Destructured: the face guard (face.test.ts) forbids a direct read of the note lists here.
      const { noteTypes, notes: libNotes, cards, decks } = lib;
      const { notes: planNotes } = plan;
      lib = {
        ...lib,
        noteTypes: [...noteTypes, ...plan.noteTypes.add],
        notes: [...libNotes, ...planNotes.add],
        cards: [...cards, ...plan.cards.add],
        decks: plan.deck ? [...decks, plan.deck] : decks,
      } as Lib;
      return { deckId: plan.deck?.id ?? null, cardsAdded: plan.cards.add.length, markedKnown: 0, media: plan.media } as unknown as ImportResult;
    },
    flush: async () => ({ ok: true }),
    writeMedia: async () => undefined,
    now: () => FIXED_NOW,
    newId: () => `id-${++n}`,
    loadBytes,
  };
  return { deps, applied, loadBytes };
}

/** A reader that gives `collection` and counts its reads. */
function readerOf(collection: AnkiCollection) {
  return jest.fn(async (_bytes: Uint8Array, _name: string) => collection);
}

/** The real planner, with a record of the arrival of every plan it made. */
function countingPlanner(change?: (planned: ReturnType<StarterPlanner>, call: number) => ReturnType<StarterPlanner>) {
  const arrivals: (string | undefined)[] = [];
  const plan: StarterPlanner = (...args) => {
    arrivals.push(args[5]?.arrival);
    const planned = planStarterDeckFrom(...args);
    return change ? change(planned, arrivals.length) : planned;
  };
  return { plan, arrivals };
}

describe('the AddSheet adds a NEW starter deck with ONE read and ONE plan (wave 5b R5)', () => {
  test('a big deck (more than 1,000 new cards): read once, planned once, every new card Not started', async () => {
    const collection = collectionFromRows(verbsRows(26)); // 26 × 40 card rows = 1,040
    expect(likelyArrival(collection)).toBe('notStarted');
    const phone = starterPhone();
    const read = readerOf(collection);
    const planner = countingPlanner();
    const run = await addStarterOnce(STARTER_PACK, 'verbs', phone.deps, {}, read, planner.plan);
    expect(phone.loadBytes).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][1]).toBe('German verbs.apkg');
    expect(planner.arrivals).toEqual(['notStarted']); // ONE plan
    expect(run.arrival).toBe('notStarted');
    expect(run.outcome).toMatchObject({ kind: 'add', saved: { ok: true }, images: 'none' });
    expect(phone.applied).toHaveLength(1);
    const plan = phone.applied[0];
    expect(plan.summary.newCards).toBe(1040);
    expect(plan.cards.add.every((c) => c.newState === 'notStarted')).toBe(true);
    expect(plan.deck?.options.newArrival).toBe('notStarted');
    expect(plan.deck?.sourceKey).toBe('pack:german:verbs');
    expect(run.outcome.deckId).toBe(plan.deck?.id);
  });

  test('a small deck: read once, planned once, the cards go into the study queue', async () => {
    const collection = collectionFromRows(verbsRows(1)); // 40 card rows
    const phone = starterPhone();
    const read = readerOf(collection);
    const planner = countingPlanner();
    const run = await addStarterOnce(STARTER_PACK, 'verbs', phone.deps, {}, read, planner.plan);
    expect(read).toHaveBeenCalledTimes(1);
    expect(planner.arrivals).toEqual(['queued']);
    expect(run.arrival).toBe('queued');
    expect(phone.applied[0].cards.add.every((c) => c.newState === 'queued')).toBe(true);
  });

  test('a wrong guess is checked against the plan: one more plan from the SAME read', async () => {
    const collection = collectionFromRows(verbsRows(26)); // the guess: Not started
    const phone = starterPhone();
    const read = readerOf(collection);
    // The first plan says it brings only 12 new cards (e.g. most cards carry Anki progress).
    const planner = countingPlanner((planned, call) =>
      call === 1 ? { ...planned, plan: { ...planned.plan, summary: { ...planned.plan.summary, newCards: 12 } } } : planned,
    );
    const run = await addStarterOnce(STARTER_PACK, 'verbs', phone.deps, {}, read, planner.plan);
    expect(read).toHaveBeenCalledTimes(1);
    expect(planner.arrivals).toEqual(['notStarted', 'queued']);
    expect(run.arrival).toBe('queued');
    expect(phone.applied).toHaveLength(1);
    expect(phone.applied[0].cards.add.every((c) => c.newState === 'queued')).toBe(true);
  });

  test("the caller chose the arrival (or the deck is there): the add as it is, never this sheet's reader", async () => {
    const phone = starterPhone();
    phone.deps.loadBytes = async () => {
      throw new Error('read by addStarterDeck');
    };
    const read = readerOf(collectionFromRows(verbsRows(1)));
    await expect(addStarterOnce(STARTER_PACK, 'verbs', phone.deps, { arrival: 'notStarted' }, read)).rejects.toThrow(
      'read by addStarterDeck',
    );
    expect(read).not.toHaveBeenCalled();
  });

  test('a file that cannot be loaded stops before anything is read, planned or applied', async () => {
    const phone = starterPhone();
    phone.deps.loadBytes = async () => {
      throw new Error('gone');
    };
    const read = readerOf(collectionFromRows(verbsRows(1)));
    const planner = countingPlanner();
    await expect(addStarterOnce(STARTER_PACK, 'verbs', phone.deps, {}, read, planner.plan)).rejects.toThrow('gone');
    expect(read).not.toHaveBeenCalled();
    expect(planner.arrivals).toEqual([]);
    expect(phone.applied).toEqual([]);
  });

  // Review round 1: the sheet itself is drawn and its "Add" is tapped (the file steps are counted).
  test('the sheet: "Add" on a new starter deck loads, reads and plans the file ONCE, and applies one plan', async () => {
    mockReadApkg.mockImplementationOnce(async () => collectionFromRows(verbsRows(26))); // 1,040 card rows
    const r = draw(React.createElement(AddSheet, { open: true, onClose: () => undefined, pack: STARTER_PACK }));
    act(() => byLabel(r, `Add ${VERBS.title}`).props.onPress());
    await settle();
    expect(mockLoadStarterBytes).toHaveBeenCalledTimes(1);
    expect(mockReadApkg).toHaveBeenCalledTimes(1);
    expect(mockPlanArrivals).toEqual(['notStarted']); // ONE plan, with the arrival of D3
    expect(mockEngine.actions.applyImport).toHaveBeenCalledTimes(1);
    const plan = mockEngine.actions.applyImport.mock.calls[0][0];
    expect(plan.deck?.sourceKey).toBe('pack:german:verbs');
    expect(plan.cards.add.every((c) => c.newState === 'notStarted')).toBe(true);
    // The learner hears about it (not "could not be added").
    expect(mockShow).toHaveBeenCalled();
    expect(String(mockShow.mock.calls[0][0])).not.toMatch(/could not be added/);
  });
});
