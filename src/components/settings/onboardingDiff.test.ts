/**
 * Tests for the onboarding choices (src/components/settings/onboardingDiff.ts,
 * spec §8.9, §7 #36, unit W4-5): a replay writes ONLY what the user changed,
 * a goal never writes a limit, the pace answers say their minutes with the
 * one time formula (minutesFor, review round 2), and the reminder step knows
 * what one tap must do.
 *
 * Wave 5d (a product decision): the answers are 5 / 10 / 20 new cards a
 * day again, with about 3 reviews for each, and each label says its REAL
 * time with minutesFor ("10 new a day · about 15 min"). A new install and
 * "Reset preferences" ARE the middle answer: all three come from seed.ts
 * `DEFAULT_PACE`, so they cannot drift apart. (Wave 5c had made the paces
 * 3 / 6 / 12 new a day, only so that the labels could say "5 / 10 / 20
 * min"; that silently slowed down every new learner. An install from wave
 * 5c keeps its own 6 new a day: no migration touches it.)
 *
 * Wave 5c (the polish reviews):
 *   - "Not now" on a first run writes the time the step showed, and only
 *     that; on a replay it writes nothing (`declineReminderPatch`, and the
 *     tour itself, drawn with react-test-renderer);
 *   - the AddSheet's "Add" and the tour's "Start with German" are ONE add of
 *     a starter deck (`addStarterOnce` is `addStarterDeck` with the sheet's
 *     D3 rule): the same plan, the same outcome, the same error.
 *
 * The last block is a source check (like src/domain/face.test.ts): every
 * full-screen modal route that uses the snackbar mounts its own
 * SnackbarHost, so the onboarding's messages (and "The erase was not
 * saved", shown while the tour is open) are seen (review round 1).
 *
 * The tour test DRAWS the screen, so the modules it uses are replaced
 * (`jest.mock` below, the same fakes as settingsIndex.test.ts): the store
 * hooks read one test state (`mockState`), and the router, the snackbar,
 * the icons and the safe area are fakes. The pure tests use none of them.
 */
// '@jest/globals' first: the jest.mock factories below use its `jest`.
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import OnboardingScreen from '../../app/onboarding';
import { FIELD_SEP } from '../../domain/anki';
import { type ApkgRows, collectionFromRows } from '../../domain/import/apkgRead';
import { ApkgError } from '../../domain/importApkg';
import type { AnkiCollection, DataStateV3, ImportPlan, ImportResult } from '../../domain/model';
import { minutesFor } from '../../domain/schedule';
import { buildSeedState, DEFAULT_PACE } from '../../domain/seed';
import { addStarterDeck, type StarterDeps, type StarterLibrary } from '../../domain/starterDecks';
import { DEFAULT_APP_SETTINGS, DEFAULT_SRS } from '../../domain/types';
import { migrate } from '../../store/migrate';
import { resetPreferences } from '../../store/reducer';
import { FIXED_NOW } from '../../test/clock';
import { makePersonV3, makeSettingsV3, makeStateV3 } from '../../test/factoriesV3';
import type { ContentPack, StarterDeck } from '../../variants/types';
import { addStarterOnce } from '../sheets/AddSheet';
import {
  applyOnboardingDiff,
  applyPace,
  declineReminderPatch,
  FIRST_CARDS_CHOICES,
  isEmptyDiff,
  ONBOARDING_COPY,
  onboardingDiff,
  onboardingSteps,
  type OnboardingValues,
  onboardingValues,
  ownPaceLabel,
  PACES,
  paceLabel,
  paceOf,
  reminderChange,
  remindMeLabel,
} from './onboardingDiff';
import { tourPace } from './settingsIndex';

/* ------------------------------------------------------------ module mocks */

/** The one state the mocked store hooks read (the tour test sets it). */
let mockState: DataStateV3 = makeStateV3();
/** The store actions the tour calls (useData().actions). */
const mockActions = {
  updateAppSettings: jest.fn(),
  setGoals: jest.fn(),
  setLimits: jest.fn(),
  markOnboarded: jest.fn(),
};
/** The engine of the tour (useEngine): it reads `mockState`. */
const mockEngine = { store: { getState: () => mockState } };
let mockParams: Record<string, string | undefined> = {};
/** What the tour asked the router to do, in order ("dismissTo /(tabs)", "replace /import?source=file" …). */
const mockRouterCalls: string[] = [];

jest.mock('../../theme/ThemeContext', () => ({
  useColors: () => jest.requireActual<typeof import('../../theme/tokens')>('../../theme/tokens').light,
  useTheme: () => ({ mode: 'light', setMode: () => undefined }),
}));
// The tour imports the AddSheet helpers, which import the kv-store and the app storage: never used here.
jest.mock('../../store/storage/kvStoragePort', () => ({
  getKvStore: () => ({ getItemSync: () => null, setItem: async () => undefined }),
}));
jest.mock('../../store/storage', () => ({
  afterAppStorageLoad: () => Promise.resolve(),
  appRevlogStore: () => ({ all: async () => [], forCard: async () => [], write: async () => 0 }),
}));
jest.mock('../../store/DataContext', () => ({ useData: () => ({ state: mockState, actions: mockActions }) }));
jest.mock('../../store/selectors', () => ({
  ...jest.requireActual<typeof import('../../store/selectors')>('../../store/selectors'),
  useEngine: () => mockEngine,
}));
jest.mock('../../store/SnackbarContext', () => ({
  useSnackbar: () => ({ show: () => undefined, snack: null, dismiss: () => undefined }),
}));
jest.mock('../../store/useNow', () => ({
  useNow: () => jest.requireActual<typeof import('../../test/clock')>('../../test/clock').FIXED_NOW,
}));
jest.mock('expo-router', () => ({
  useRouter: () => {
    const log = (name: string) => (href?: unknown) => void mockRouterCalls.push(href === undefined ? name : `${name} ${String(href)}`);
    return { push: log('push'), navigate: log('navigate'), replace: log('replace'), dismissTo: log('dismissTo'), back: log('back') };
  },
  useFocusEffect: () => undefined,
  useLocalSearchParams: () => mockParams,
}));
// The time picker: a plain element with the picker's props, so a test can "pick" a time (`pickTime`).
jest.mock('@expo/ui/community/datetime-picker', () => {
  const { createElement } = jest.requireActual<typeof import('react')>('react');
  return { DateTimePicker: (props: object) => createElement('DateTimePicker', props) };
});
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

/** The values of a brand-new install: the real seed (the middle answer, 10 new a day; reminders off at 8:00 PM). */
const fresh: OnboardingValues = onboardingValues(buildSeedState(FIXED_NOW));

/** An install from wave 5c: the pace its seed (or its old "10 min" answer) gave it, 6 new + 20 reviews. No answer now. */
const wave5c: OnboardingValues = { ...fresh, dailyNewLimit: 6, goalReviews: 20, goalNew: 6 };

/** A learner who tuned things in Settings (no pace matches). */
const custom: OnboardingValues = {
  dailyNewLimit: 12,
  goalReviews: 45,
  goalNew: 8,
  reminderEnabled: true,
  reminderTime: '07:15',
};

function fakeActions() {
  const setLimits = jest.fn<(patch: { dailyNewLimit?: number; dailyReviewLimit?: number }) => void>();
  const setGoals = jest.fn<(goalReviews: number, goalNew: number) => void>();
  return { setLimits, setGoals };
}

describe('onboardingValues / paces', () => {
  // Wave 5d (a product decision; it reverses the 6 / 20 / 6 of wave 5c on purpose): the seed
  // values ARE the tour's middle answer, the familiar 10 new a day with 30 reviews. A learner who
  // skips the tour and one who taps Continue get the same pace.
  test('a new install has the middle answer (seed.ts DEFAULT_PACE): 10 new a day, goals 30 and 10', () => {
    expect(fresh).toEqual({ dailyNewLimit: 10, goalReviews: 30, goalNew: 10, reminderEnabled: false, reminderTime: '20:00' });
    expect(DEFAULT_PACE).toEqual({ dailyNewLimit: 10, goalReviews: 30, goalNew: 10 });
    expect(paceOf(fresh)).toBe('ten');
    expect(minutesFor(fresh.dailyNewLimit + fresh.goalReviews)).toBe(15);
    // The tour's answer is built from the same numbers (one place).
    expect(PACES.find((p) => p.id === 'ten')).toMatchObject({
      dailyNewLimit: DEFAULT_PACE.dailyNewLimit,
      goalReviews: DEFAULT_PACE.goalReviews,
      goalNew: DEFAULT_PACE.goalNew,
    });
    // A first run and a replay of a new install both select the middle answer, with no "Keep my pace".
    expect(tourPace(fresh, false)).toEqual({ selected: 'ten', offerOwn: false });
    expect(tourPace(fresh, true)).toEqual({ selected: 'ten', offerOwn: false });
  });

  test('"Reset preferences" goes back to the middle answer too (the reducer + the hub\'s first-run goals)', () => {
    // A learner with their own pace (12 new, goals 45 / 8) taps Settings › Reset preferences.
    const state = makeStateV3({
      settings: makeSettingsV3({ srs: { dailyNewLimit: 12, dailyReviewLimit: 300 } }),
      person: makePersonV3({ goalReviews: 45, goalNew: 8 }),
    });
    expect(paceOf(onboardingValues(state))).toBeNull();
    const next = resetPreferences(state, undefined, { now: FIXED_NOW, newId: () => 'x' }).state;
    // The hub then calls setGoals with the seed's goals (settings/index.tsx `resetPreferences`).
    const { goalReviews, goalNew } = buildSeedState(FIXED_NOW).person;
    const after = onboardingValues({ settings: next.settings, person: { goalReviews, goalNew } });
    expect(paceOf(after)).toBe('ten');
    expect(after).toMatchObject({ dailyNewLimit: 10, goalReviews: 30, goalNew: 10 });
    // So a "Replay the tour" after the reset selects the middle answer, not a fourth "Keep my pace" answer.
    expect(tourPace(after, true)).toEqual({ selected: 'ten', offerOwn: false });
    // The review LIMIT is the default (a pace never sets it); the repair value of the new limit stays 10.
    expect(next.settings.srs.dailyReviewLimit).toBe(DEFAULT_SRS.dailyReviewLimit);
    expect(DEFAULT_SRS.dailyNewLimit).toBe(10);
  });

  test('an install from wave 5c keeps its own values (6 new, goals 20 / 6): no answer, and no migration changes them', () => {
    expect(paceOf(wave5c)).toBeNull();
    expect(minutesFor(wave5c.dailyNewLimit + wave5c.goalReviews)).toBe(10);
    // Its stored document goes through migrate() at boot: the pace is the learner's, so it stays.
    const seed = buildSeedState(FIXED_NOW);
    const stored = {
      ...seed,
      onboarded: true,
      settings: { ...seed.settings, srs: { ...seed.settings.srs, dailyNewLimit: 6 } },
      person: { ...seed.person, goalReviews: 20, goalNew: 6 },
    };
    const migrated = migrate(JSON.parse(JSON.stringify(stored)), FIXED_NOW);
    expect(migrated.kind).toBe('ok');
    if (migrated.kind !== 'ok') return;
    expect(onboardingValues(migrated.state)).toMatchObject({ dailyNewLimit: 6, goalReviews: 20, goalNew: 6 });
    // A replay offers "Keep my pace" for it, so nothing is changed unless the learner picks an answer.
    expect(tourPace(onboardingValues(migrated.state), true)).toEqual({ selected: 'own', offerOwn: true });
    expect(DEFAULT_APP_SETTINGS.srs.dailyNewLimit).toBe(10);
  });

  test('the three answers write their cards: the limit and both goals (5 / 10 / 20 new, about 3 reviews each)', () => {
    expect(PACES.map((p) => [p.id, p.dailyNewLimit, p.goalReviews, p.goalNew])).toEqual([
      ['five', 5, 15, 5],
      ['ten', 10, 30, 10],
      ['twenty', 20, 60, 20],
    ]);
    expect(applyPace(fresh, 'twenty')).toMatchObject({ dailyNewLimit: 20, goalReviews: 60, goalNew: 20 });
    expect(applyPace(fresh, 'five')).toMatchObject({ dailyNewLimit: 5, goalReviews: 15, goalNew: 5 });
  });

  // Spec §8.9 "Minutes use minutesFor() (one formula everywhere)". Wave 5d: the
  // labels name the new cards a day and the REAL time of the answer's cards (new +
  // reviews), so they stay true for the familiar paces (wave 5c had changed the
  // paces instead, to make "5 / 10 / 20 min" true).
  test('each answer says its time with minutesFor(new + reviews) — about 8, 15 and 31 min, the same time Today shows', () => {
    for (const p of PACES) {
      expect(p.label).toBe(`${p.dailyNewLimit} new a day · about ${minutesFor(p.dailyNewLimit + p.goalReviews)} min`);
    }
    expect(PACES.map((p) => minutesFor(p.dailyNewLimit + p.goalReviews))).toEqual([8, 15, 31]);
    expect(PACES.map((p) => p.label)).toEqual([
      '5 new a day · about 8 min',
      '10 new a day · about 15 min',
      '20 new a day · about 31 min',
    ]);
    expect(paceLabel(3, 10)).toBe('3 new a day · about 5 min');
    expect(paceLabel(1000, 3000)).toBe('1,000 new a day · about 1,533 min');
    // The step's title stays the spec's question; the answers carry the numbers.
    expect(ONBOARDING_COPY.timeTitle).toBe('How much time a day?');
  });

  test('custom values are no pace; "Keep my pace" uses the one minutes formula', () => {
    expect(paceOf(custom)).toBeNull();
    expect(ownPaceLabel(custom)).toBe(`Keep my pace — about ${minutesFor(12 + 45)} min: 12 new, about 45 reviews`);
  });
});

describe('onboardingDiff — a replay writes only what changed', () => {
  test('nothing changed → an empty diff → no write at all', () => {
    const diff = onboardingDiff(custom, { ...custom });
    expect(diff).toEqual({});
    expect(isEmptyDiff(diff)).toBe(true);
    const actions = fakeActions();
    applyOnboardingDiff(diff, actions);
    expect(actions.setLimits).not.toHaveBeenCalled();
    expect(actions.setGoals).not.toHaveBeenCalled();
  });

  test('a new pace on replay → the limit and the goals, nothing else (the review LIMIT is never written)', () => {
    const diff = onboardingDiff(custom, applyPace(custom, 'five'));
    expect(diff).toEqual({ limits: { dailyNewLimit: 5 }, goals: { goalReviews: 15, goalNew: 5 } });
    const actions = fakeActions();
    applyOnboardingDiff(diff, actions);
    expect(actions.setLimits).toHaveBeenCalledTimes(1);
    expect(actions.setLimits).toHaveBeenCalledWith({ dailyNewLimit: 5 });
    expect(actions.setGoals).toHaveBeenCalledWith(15, 5);
  });

  // A new install IS the middle answer, so keeping it on a first run writes nothing. The
  // values of a wave-5c install (6 / 20 / 6, no answer now) get the middle answer's cards.
  test('the first run keeps the middle answer → nothing to write; wave-5c values → its cards are written', () => {
    expect(onboardingDiff(fresh, applyPace(fresh, 'ten'))).toEqual({});
    expect(onboardingDiff(wave5c, applyPace(wave5c, 'ten'))).toEqual({
      limits: { dailyNewLimit: 10 },
      goals: { goalReviews: 30, goalNew: 10 },
    });
  });

  test('only the goals differ → only setGoals (limits stay)', () => {
    const initial = { ...wave5c, dailyNewLimit: 10 }; // limit 10 = the middle answer, but other goals
    const diff = onboardingDiff(initial, applyPace(initial, 'ten'));
    expect(diff).toEqual({ goals: { goalReviews: 30, goalNew: 10 } });
  });

  test('only the limit differs → only setLimits', () => {
    const initial = { ...wave5c, goalReviews: 30, goalNew: 10 }; // the goals of the middle answer, but limit 6
    expect(onboardingDiff(initial, applyPace(initial, 'ten'))).toEqual({ limits: { dailyNewLimit: 10 } });
  });

  test('a reminder change is NOT in the diff (the reminder step writes at the tap)', () => {
    expect(onboardingDiff(fresh, { ...fresh, reminderEnabled: true, reminderTime: '07:00' })).toEqual({});
  });
});

describe('reminderChange — what one tap on the Reminder step does', () => {
  test('off → on: enable (with the chosen time; the permission flow runs first)', () => {
    expect(reminderChange(fresh, { reminderEnabled: true, reminderTime: '20:00' })).toEqual({ kind: 'enable', time: '20:00' });
  });

  test('replay, on at the same time: nothing', () => {
    expect(reminderChange(custom, { reminderEnabled: true, reminderTime: '07:15' })).toEqual({ kind: 'none' });
  });

  test('replay, on, new time: only the time', () => {
    expect(reminderChange(custom, { reminderEnabled: true, reminderTime: '21:00' })).toEqual({ kind: 'time', time: '21:00' });
  });

  test('replay, on → off: disable; off and "Not now": nothing', () => {
    expect(reminderChange(custom, { reminderEnabled: false, reminderTime: '07:15' })).toEqual({ kind: 'disable' });
    expect(reminderChange(fresh, { reminderEnabled: false, reminderTime: '09:00' })).toEqual({ kind: 'none' });
  });
});

describe('declineReminderPatch — what "Not now" writes (wave 5b L7, test added in wave 5c)', () => {
  test('a first run with reminders off keeps the time the step showed, and only the time', () => {
    // The old app's '21:00' is stored; the step showed 8:00 PM.
    expect(declineReminderPatch({ reminderEnabled: false, reminderTime: '21:00' }, '20:00', false)).toEqual({
      reminderTime: '20:00',
    });
    // The learner picked 7:30 AM on the step, then "Not now": that time is kept, reminders stay off.
    expect(declineReminderPatch({ reminderEnabled: false, reminderTime: '20:00' }, '07:30', false)).toEqual({
      reminderTime: '07:30',
    });
  });

  test('a first run whose stored time is already the shown time: nothing to write', () => {
    expect(declineReminderPatch({ reminderEnabled: false, reminderTime: '20:00' }, '20:00', false)).toBeNull();
  });

  test('a replay with reminders off: nothing (a replay writes only what the learner changes)', () => {
    expect(declineReminderPatch({ reminderEnabled: false, reminderTime: '21:00' }, '21:00', true)).toBeNull();
    expect(declineReminderPatch({ reminderEnabled: false, reminderTime: '21:00' }, '07:00', true)).toBeNull();
  });

  test('reminders on ("Turn off reminders"): turn them off, never a new time', () => {
    expect(declineReminderPatch({ reminderEnabled: true, reminderTime: '07:15' }, '09:00', true)).toEqual({
      reminderEnabled: false,
    });
    expect(declineReminderPatch({ reminderEnabled: true, reminderTime: '07:15' }, '07:15', false)).toEqual({
      reminderEnabled: false,
    });
  });
});

/* ------------------------------------------- the tour, drawn: "Not now" */

let screen: ReactTestRenderer | null = null;

afterEach(() => {
  if (screen) act(() => screen!.unmount());
  screen = null;
  mockState = makeStateV3();
  mockParams = {};
  mockRouterCalls.length = 0;
  for (const fn of Object.values(mockActions)) fn.mockClear();
});

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

/** Every text on screen (host Text nodes only). */
function texts(r: ReactTestRenderer): string[] {
  return r.root.findAll((n) => (n.type as unknown) === 'Text').map(textOf);
}

/** Tap the nearest control (a node with onPress) around the text `text`. */
function tapText(r: ReactTestRenderer, text: string): void {
  const node = r.root.findAll((n) => (n.type as unknown) === 'Text' && textOf(n) === text)[0];
  let at: ReactTestInstance | null = node ?? null;
  while (at && typeof at.props.onPress !== 'function') at = at.parent;
  if (!at) throw new Error(`no control with the text "${text}"`);
  const control = at;
  act(() => control.props.onPress());
}

/**
 * Pick a time on the Reminder step: the picker's own answer. The step draws
 * the picker inline (iOS, the platform of the tests), or after a tap on the
 * time row (Android).
 */
function pickTime(r: ReactTestRenderer, hour: number, minute: number): void {
  const pickers = r.root.findAll((n) => (n.type as unknown) === 'DateTimePicker');
  if (pickers.length === 0) throw new Error('no time picker on screen');
  act(() => pickers[0].props.onValueChange(null, new Date(2026, 5, 10, hour, minute)));
}

describe('the tour: "Not now" on the Reminder step (wave 5b L7, test added in wave 5c)', () => {
  test('a first run: "Not now" writes the shown time (8:00 PM) ONCE, and never turns reminders on', () => {
    // A new install whose stored time is the old app's '21:00' (the learner never chose it).
    const seed = buildSeedState(FIXED_NOW);
    mockState = { ...seed, settings: { ...seed.settings, reminderTime: '21:00' } };
    const r = draw(React.createElement(OnboardingScreen));
    tapText(r, ONBOARDING_COPY.getStarted);
    // The Time step: the spec's question, and the answers with their real time (wave 5d).
    expect(texts(r)).toEqual(expect.arrayContaining([ONBOARDING_COPY.timeTitle, ...PACES.map((p) => p.label)]));
    expect(texts(r)).toContain('10 new a day · about 15 min');
    tapText(r, ONBOARDING_COPY.continue);
    // The seed IS the middle answer: Continue on the pre-selected answer writes nothing.
    expect(mockActions.setLimits).not.toHaveBeenCalled();
    expect(mockActions.setGoals).not.toHaveBeenCalled();
    expect(texts(r)).toContain(remindMeLabel('8:00 PM'));
    tapText(r, ONBOARDING_COPY.notNow);
    expect(mockActions.updateAppSettings).toHaveBeenCalledTimes(1);
    expect(mockActions.updateAppSettings).toHaveBeenCalledWith({ reminderTime: '20:00' });
    // On to step 4.
    expect(texts(r)).toContain(ONBOARDING_COPY.firstTitle);
  });

  test('a first run: a time picked on the step, then "Not now" → that time is kept; reminders stay off', () => {
    mockState = buildSeedState(FIXED_NOW);
    const r = draw(React.createElement(OnboardingScreen));
    tapText(r, ONBOARDING_COPY.getStarted);
    tapText(r, ONBOARDING_COPY.continue);
    pickTime(r, 7, 30);
    expect(texts(r)).toContain(remindMeLabel('7:30 AM'));
    tapText(r, ONBOARDING_COPY.notNow);
    expect(mockActions.updateAppSettings.mock.calls).toEqual([[{ reminderTime: '07:30' }]]);
  });

  test('a first run whose stored time is the shown time: "Not now" writes nothing', () => {
    mockState = buildSeedState(FIXED_NOW); // reminders off at 20:00
    const r = draw(React.createElement(OnboardingScreen));
    tapText(r, ONBOARDING_COPY.getStarted);
    tapText(r, ONBOARDING_COPY.continue);
    tapText(r, ONBOARDING_COPY.notNow);
    expect(mockActions.updateAppSettings).not.toHaveBeenCalled();
  });

  test('a replay with reminders off: "Not now" writes nothing, even after a time was picked', () => {
    mockParams = { replay: '1' };
    mockState = makeStateV3({ settings: makeSettingsV3({ reminderTime: '21:00' }) });
    const r = draw(React.createElement(OnboardingScreen));
    tapText(r, ONBOARDING_COPY.getStarted);
    tapText(r, ONBOARDING_COPY.continue);
    expect(texts(r)).toContain(remindMeLabel('9:00 PM')); // a replay offers the learner's own time
    pickTime(r, 7, 30);
    tapText(r, ONBOARDING_COPY.notNow);
    expect(mockActions.updateAppSettings).not.toHaveBeenCalled();
  });
});

// Final review (session area): a first run left with `router.replace('/(tabs)')`, which put a
// SECOND tab navigator on the root stack, above the one the tour was pushed over (expo-router 56:
// a REPLACE makes a new route). backToToday goes back to the tab navigator that is there
// (`router.dismissTo`); backToToday.test.ts shows on the real router that this leaves ONE.
describe('the tour ends on the tabs it was pushed over (never a second tab navigator)', () => {
  test('a first run: "Skip" marks the tour done and goes back to the tabs with dismissTo', () => {
    mockState = buildSeedState(FIXED_NOW);
    const r = draw(React.createElement(OnboardingScreen));
    tapText(r, ONBOARDING_COPY.skip);
    expect(mockActions.markOnboarded).toHaveBeenCalledTimes(1);
    expect(mockRouterCalls).toEqual(['dismissTo /(tabs)']);
  });

  test('a first run: "I\'ll do this later" on the last step goes back to the tabs too', () => {
    mockState = buildSeedState(FIXED_NOW);
    const r = draw(React.createElement(OnboardingScreen));
    tapText(r, ONBOARDING_COPY.getStarted);
    tapText(r, ONBOARDING_COPY.continue);
    tapText(r, ONBOARDING_COPY.notNow);
    expect(texts(r)).toContain(ONBOARDING_COPY.firstTitle);
    tapText(r, ONBOARDING_COPY.later);
    expect(mockActions.markOnboarded).toHaveBeenCalledTimes(1);
    expect(mockRouterCalls).toEqual(['dismissTo /(tabs)']);
  });

  test('a first run: "Import a deck" still replaces the tour with the import screen', () => {
    mockState = buildSeedState(FIXED_NOW);
    const r = draw(React.createElement(OnboardingScreen));
    tapText(r, ONBOARDING_COPY.getStarted);
    tapText(r, ONBOARDING_COPY.continue);
    tapText(r, ONBOARDING_COPY.notNow);
    tapText(r, 'Import a deck');
    expect(mockRouterCalls).toEqual(['replace /import?source=file']);
  });

  test('a replay: "Skip" goes back to Settings (router.back()), and the tour stays done', () => {
    mockParams = { replay: '1' };
    mockState = makeStateV3();
    const r = draw(React.createElement(OnboardingScreen));
    tapText(r, ONBOARDING_COPY.skip);
    expect(mockActions.markOnboarded).not.toHaveBeenCalled();
    expect(mockRouterCalls).toEqual(['back']);
  });
});

/* ---------------------------------- one add for the AddSheet and the tour */

const STARTER: StarterDeck = { key: 'words', title: 'Starter words', subtitle: '2 words', asset: 1, version: 1 };
const STARTER_PACK: ContentPack = { id: 'german', cardTypePresets: [], starterDecks: [STARTER] };

/** A small starter file (2 words, one direction) as the .apkg reader gives it. */
function starterCollection(): AnkiCollection {
  const models = {
    '1700000000001': {
      id: 1,
      name: 'Starter Words',
      type: 0,
      sortf: 0,
      flds: [
        { name: 'Word', ord: 0 },
        { name: 'Meaning', ord: 1 },
      ],
      tmpls: [{ name: 'DE-EN', ord: 0, qfmt: '{{Word}}', afmt: '{{FrontSide}}<hr id=answer>{{Meaning}}' }],
    },
  };
  const words = [
    ['g-haus', 'das Haus', 'the house'],
    ['g-hund', 'der Hund', 'the dog'],
  ];
  const rows: ApkgRows = {
    fileName: 'ignored.apkg',
    col: { crt: 1_700_000_000, models: JSON.stringify(models), decks: JSON.stringify({ '1': { id: 1, name: 'Default' } }) },
    notes: words.map(([guid, word, meaning], i) => ({
      id: 1700000001000 + i,
      guid,
      mid: '1700000000001',
      flds: [word, meaning].join(FIELD_SEP),
      tags: '',
    })),
    cards: words.map((_, i) => ({
      id: (1700000001000 + i) * 10,
      nid: 1700000001000 + i,
      did: 1,
      odid: 0,
      ord: 0,
      type: 0,
      queue: 0,
      due: i + 1,
      ivl: 0,
      factor: 0,
      reps: 0,
      lapses: 0,
      flags: 0,
      data: '',
    })),
    media: {},
  };
  return collectionFromRows(rows);
}

/** A phone for one add: an empty library, the applied plans, fixed time and ids. */
function starterPhone() {
  let lib = { noteTypes: [], notes: [], cards: [], decks: [], settings: { srs: DEFAULT_SRS } } as unknown as StarterLibrary;
  const applied: ImportPlan[] = [];
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
      };
      return { deckId: plan.deck?.id ?? null, cardsAdded: plan.cards.add.length, markedKnown: 0, media: plan.media } as unknown as ImportResult;
    },
    flush: async () => ({ ok: true }),
    writeMedia: async () => undefined,
    now: () => FIXED_NOW,
    newId: () => `id-${++n}`,
    loadBytes: async () => new Uint8Array([1, 2, 3]),
  };
  return { deps, applied };
}

// Wave 5c: the AddSheet had its own COPY of the add steps (review round 1 "KNOWN COST"), and the
// copy already behaved differently. Now `addStarterOnce` is `addStarterDeck` (the tour's add) with
// the sheet's D3 rule, so the two cannot drift apart.
describe('the AddSheet and the tour add a starter deck the SAME way (wave 5c)', () => {
  test('a bundled file that cannot be loaded: both reject with the same ApkgError "corrupt"', async () => {
    const gone = () => Promise.reject(new Error('gone'));
    const message = 'The starter deck "Starter words" could not be loaded: gone';
    const sheet = addStarterOnce(STARTER_PACK, 'words', { ...starterPhone().deps, loadBytes: gone });
    await expect(sheet).rejects.toBeInstanceOf(ApkgError);
    await expect(sheet).rejects.toMatchObject({ code: 'corrupt', message });
    const tour = addStarterDeck(STARTER_PACK, 'words', { ...starterPhone().deps, loadBytes: gone }, { arrival: 'notStarted' });
    await expect(tour).rejects.toMatchObject({ code: 'corrupt', message });
  });

  test('the same file and the same arrival: the same plan is applied, the same outcome comes back', async () => {
    const read = async () => starterCollection();
    const a = starterPhone();
    const b = starterPhone();
    const sheet = await addStarterOnce(STARTER_PACK, 'words', a.deps, { arrival: 'notStarted' }, read);
    const tour = await addStarterDeck(STARTER_PACK, 'words', { ...b.deps, readFile: read }, { arrival: 'notStarted' });
    expect(sheet).toEqual({ outcome: tour, arrival: 'notStarted' });
    expect(a.applied).toEqual(b.applied);
    expect(tour).toMatchObject({ kind: 'add', saved: { ok: true }, images: 'none' });
  });

  test("the sheet's D3 for a small NEW deck: the study queue, the same add as an explicit 'queued'", async () => {
    const read = async () => starterCollection();
    const a = starterPhone();
    const b = starterPhone();
    const sheet = await addStarterOnce(STARTER_PACK, 'words', a.deps, {}, read);
    const plain = await addStarterDeck(STARTER_PACK, 'words', { ...b.deps, readFile: read }, { arrival: 'queued' });
    expect(sheet.arrival).toBe('queued');
    expect(sheet.outcome).toEqual({ ...plain, arrival: 'queued' });
    expect(a.applied).toEqual(b.applied);
    expect(a.applied[0].cards.add.every((c) => c.newState === 'queued')).toBe(true);
  });
});

describe('steps and copy', () => {
  test('a replay skips step 4 (it never asks for a first deck again)', () => {
    expect(onboardingSteps(false)).toEqual(['welcome', 'time', 'reminder', 'first']);
    expect(onboardingSteps(true)).toEqual(['welcome', 'time', 'reminder']);
  });

  test('step 4 ends in an ACTION: every choice has a route (spec §8.9, exact copy)', () => {
    expect(FIRST_CARDS_CHOICES.map((c) => [c.title, c.sub ?? null, c.route])).toEqual([
      ['Import a deck', 'An Anki .apkg or a .csv file', '/import?source=file'],
      ['Find a deck on AnkiWeb', 'Search shared decks', '/import?source=ankiweb'],
      ['Make my own deck', 'Type your own cards', '/deck-editor'],
      ["I'll do this later", null, '/(tabs)'],
    ]);
  });

  test('the exact words', () => {
    expect(ONBOARDING_COPY.tagline).toBe('Learn anything. Keep it.');
    expect(ONBOARDING_COPY.getStarted).toBe('Get started');
    expect(ONBOARDING_COPY.skip).toBe('Skip');
    expect(ONBOARDING_COPY.timeTitle).toBe('How much time a day?');
    expect(ONBOARDING_COPY.timeNote).toBe('You can change this any time.');
    expect(ONBOARDING_COPY.reminderTitle).toBe('Want a daily reminder?');
    expect(ONBOARDING_COPY.notNow).toBe('Not now');
    expect(remindMeLabel('8:00 PM')).toBe('Remind me at 8:00 PM');
  });
});

/* ------------------------------------------- the snackbar over the tour */

const APP = path.resolve(__dirname, '..', '..', 'app');

/** The routes the root layout opens as full-screen modals (`presentation: 'fullScreenModal'`). */
function fullScreenModalRoutes(): string[] {
  const layout = fs.readFileSync(path.join(APP, '_layout.tsx'), 'utf8');
  const names: string[] = [];
  const screen = /<Stack\.Screen\s+name="([^"]+)"\s+options=\{\{([^}]*)\}\}/g;
  for (const m of layout.matchAll(screen)) {
    if (/presentation:\s*'fullScreenModal'/.test(m[2])) names.push(m[1]);
  }
  return names;
}

describe('full-screen modals show the snackbar (review round 1)', () => {
  // WHY: the only global SnackbarHost lives in the (tabs) layout. A
  // full-screen modal covers it, so a message sent while the modal is open
  // is never seen. "Erase everything" opens the onboarding at once and only
  // then says whether the erase was saved; the onboarding's step 3 says
  // "We couldn't turn on reminders. Please try again." Both were hidden.
  test('every full-screen modal route that uses the snackbar mounts its own SnackbarHost', () => {
    const routes = fullScreenModalRoutes();
    expect(routes).toEqual(expect.arrayContaining(['onboarding', 'import', 'card-editor', 'deck-editor']));
    const checked: string[] = [];
    const missing: string[] = [];
    for (const name of routes) {
      const file = path.join(APP, `${name}.tsx`);
      // A route of another unit of this wave may not exist in this worktree yet.
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (!/\buseSnackbar\(/.test(text)) continue;
      checked.push(name);
      if (!/<SnackbarHost\b/.test(text)) missing.push(name);
    }
    expect(checked).toContain('onboarding'); // the scan really found the tour
    expect(missing).toEqual([]);
  });
});
