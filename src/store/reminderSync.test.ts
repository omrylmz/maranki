/**
 * Tests for the reminder sync (src/store/reminderSync.ts, spec §8.7, unit W4-5).
 *
 * The sync runs through the REAL src/platform/notifications.ts, with a fake
 * expo-notifications module (`jest.mock` below): an in-memory list of
 * scheduled notifications, a permission status and a channel list. So the
 * tests see exactly what the phone would get:
 *   - only OUR reminders are cancelled (`data.kind === 'maranki-reminder'`);
 *   - up to 14 one-shot DATE reminders on the 'reminders' channel;
 *   - a studied today is skipped;
 *   - the sync never asks for permission; turning on asks, channel first;
 *   - two syncs never run at the same time, and a waiting one takes the newest state.
 *
 * Module mocks:
 *   - expo-notifications → the fake above;
 *   - ./DataContext, ./selectors → small fakes for the hook test (no engine).
 */
// '@jest/globals' first: the jest.mock factories below use its `jest`.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { AppState, type AppStateStatus, Platform } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { REMINDER_TITLE } from '../platform/reminderPlan';
import {
  DEFAULT_ACTION,
  enableReminders,
  formatReminderTime,
  isReminderTap,
  nextReminder,
  REMINDER_COPY,
  type ReminderPort,
  type ReminderState,
  reminderBlock,
  reminderPickerValue,
  reminderRowSub,
  reminderStatusLine,
  reminderSyncKey,
  reminderTapKey,
  reminderTimeOf,
  remindersSettled,
  syncReminders,
  type NotificationsAllowed,
  useNotificationsAllowed,
  useReminderSync,
} from './reminderSync';

/* ------------------------------------------------- the fake notifications */

interface FakeRequest {
  identifier: string;
  content: { title: string; body: string; data?: Record<string, unknown> };
  trigger: { type: string; date: Date; channelId?: string };
}

const mockPhone = {
  scheduled: [] as FakeRequest[],
  channels: [] as string[],
  granted: false,
  canAskAgain: true,
  /** What the user answers to the prompt. */
  answer: true,
  prompts: 0,
  /** Every call, in order (to check "channel first"). */
  calls: [] as string[],
  nextId: 1,
  /** While true, every call waits for `release()` (to see two syncs overlap). */
  slow: false,
  waiters: [] as (() => void)[],
};

async function mockStep(name: string): Promise<void> {
  mockPhone.calls.push(name);
  if (mockPhone.slow) await new Promise<void>((resolve) => mockPhone.waiters.push(resolve));
}

jest.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 3 },
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  SchedulableTriggerInputTypes: { DATE: 'date' },
  setNotificationChannelAsync: async (id: string) => {
    await mockStep('channel');
    if (!mockPhone.channels.includes(id)) mockPhone.channels.push(id);
    return null;
  },
  getPermissionsAsync: async () => {
    await mockStep('getPermissions');
    return { granted: mockPhone.granted, canAskAgain: mockPhone.canAskAgain };
  },
  requestPermissionsAsync: async () => {
    await mockStep('requestPermissions');
    mockPhone.prompts += 1;
    mockPhone.granted = mockPhone.answer;
    if (!mockPhone.answer) mockPhone.canAskAgain = false;
    return { granted: mockPhone.granted, canAskAgain: mockPhone.canAskAgain };
  },
  getAllScheduledNotificationsAsync: async () => {
    await mockStep('getAll');
    return mockPhone.scheduled.map((r) => ({ ...r }));
  },
  cancelScheduledNotificationAsync: async (id: string) => {
    await mockStep('cancel');
    mockPhone.scheduled = mockPhone.scheduled.filter((r) => r.identifier !== id);
  },
  scheduleNotificationAsync: async (request: Omit<FakeRequest, 'identifier'>) => {
    await mockStep('schedule');
    const identifier = `n${mockPhone.nextId++}`;
    mockPhone.scheduled.push({ identifier, ...request });
    return identifier;
  },
}));

/* ------------------------------------------------- fakes for the hook */

let mockData: { ready: boolean; state: ReminderState; persistError: string | null } = {
  ready: true,
  state: reminderState(),
  persistError: null,
};

jest.mock('./DataContext', () => ({ useData: () => mockData }));
jest.mock('./selectors', () => ({ useEngine: () => ({ store: { getState: () => mockData.state } }) }));

/* --------------------------------------------------------------- helpers */

/** Thursday 22 Oct 2026, local time. */
const at = (hour: number, minute = 0, day = 22) => new Date(2026, 9, day, hour, minute).getTime();

function reminderState(over: { settings?: Partial<ReminderState['settings']>; person?: Partial<ReminderState['person']> } = {}): ReminderState {
  return {
    settings: { reminderEnabled: true, reminderTime: '20:00', reminderSkipStudied: true, ...over.settings },
    person: { streak: 0, lastStudyDay: null, freezes: 0, ...over.person },
  };
}

/** A notification that is NOT ours (another feature, or another library). */
function otherNotification(identifier: string): FakeRequest {
  return {
    identifier,
    content: { title: 'Other', body: 'Not a reminder', data: { kind: 'something-else' } },
    trigger: { type: 'date', date: new Date(at(23)) },
  };
}

const ours = () => mockPhone.scheduled.filter((r) => r.content.data?.kind === 'maranki-reminder');

beforeEach(() => {
  jest.replaceProperty(Platform, 'OS', 'android');
  Object.assign(mockPhone, {
    scheduled: [],
    channels: [],
    granted: true,
    canAskAgain: true,
    answer: true,
    prompts: 0,
    calls: [],
    nextId: 1,
    slow: false,
    waiters: [],
  });
});

afterEach(async () => {
  mockPhone.slow = false;
  for (const release of mockPhone.waiters.splice(0)) release();
  await remindersSettled();
  jest.restoreAllMocks();
});

/* ------------------------------------------------------------- the sync */

describe('syncReminders', () => {
  test('on and allowed → 14 one-shot DATE reminders at the time, on the reminders channel', async () => {
    const result = await syncReminders(reminderState(), at(9));
    expect(result.kind).toBe('scheduled');
    const mine = ours();
    expect(mine).toHaveLength(14);
    for (const r of mine) {
      expect(r.trigger.type).toBe('date');
      expect(r.trigger.channelId).toBe('reminders');
      expect(r.trigger.date.getHours()).toBe(20);
      expect(r.trigger.date.getMinutes()).toBe(0);
      expect(r.content.title).toBe(REMINDER_TITLE);
    }
    // Today 20:00 is still ahead at 09:00, so the first one is today.
    expect(mine[0].trigger.date.getTime()).toBe(at(20));
    // The channel exists before the first reminder is scheduled on it.
    expect(mockPhone.calls.indexOf('channel')).toBeLessThan(mockPhone.calls.indexOf('schedule'));
    expect(mockPhone.channels).toEqual(['reminders']);
  });

  test('cancels ONLY ours: other scheduled notifications stay', async () => {
    mockPhone.scheduled.push(otherNotification('other-1'));
    await syncReminders(reminderState(), at(9));
    await syncReminders(reminderState({ settings: { reminderTime: '07:30' } }), at(9));
    expect(mockPhone.scheduled.find((r) => r.identifier === 'other-1')).toBeDefined();
    // The second sync replaced every reminder of the first: still 14, all at 07:30.
    expect(ours()).toHaveLength(14);
    expect(ours().every((r) => r.trigger.date.getHours() === 7 && r.trigger.date.getMinutes() === 30)).toBe(true);
  });

  test('studied today (skip on) → today is skipped; skip off → today stays', async () => {
    const studied = reminderState({ person: { lastStudyDay: '2026-10-22', streak: 5 } });
    await syncReminders(studied, at(9));
    expect(ours()).toHaveLength(14);
    expect(ours()[0].trigger.date.getTime()).toBe(at(20, 0, 23));

    await syncReminders(reminderState({ person: { lastStudyDay: '2026-10-22' }, settings: { reminderSkipStudied: false } }), at(9));
    expect(ours()[0].trigger.date.getTime()).toBe(at(20));
  });

  test('the text follows the streak: alive → "keeps your 5-day streak"', async () => {
    await syncReminders(reminderState({ person: { lastStudyDay: '2026-10-22', streak: 5 } }), at(9));
    expect(ours()[0].content.body).toBe('A few minutes keeps your 5-day streak.');
    // Two days later the streak is broken (no freeze): the text says so.
    expect(ours()[2].content.body).toBe('A few minutes today starts a new streak.');
  });

  test('skip OFF: a session today re-plans today’s reminder, and it never says "starts a new streak" (release pass C1-2)', async () => {
    const skipOff = { reminderSkipStudied: false };
    // Before the first session: no streak yet, today's reminder invites one.
    const before = reminderState({ settings: skipOff, person: { streak: 0, lastStudyDay: '2026-10-20' } });
    await syncReminders(before, at(9));
    expect(ours()[0].trigger.date.getTime()).toBe(at(20));
    expect(ours()[0].content.body).toBe('A few minutes today starts a new streak.');

    // The session completes: a 1-day streak on today. The study day changed, so the sync key changes
    // (useReminderSync syncs again), and today's reminder stays (skip is off) with a text that fits.
    const after = reminderState({ settings: skipOff, person: { streak: 1, lastStudyDay: '2026-10-22' } });
    expect(reminderSyncKey(after)).not.toBe(reminderSyncKey(before));
    await syncReminders(after, at(10));
    expect(ours()).toHaveLength(14);
    expect(ours()[0].trigger.date.getTime()).toBe(at(20));
    expect(ours()[0].content.body).toBe('You studied today. A few more minutes helps you remember.');
    expect(ours()[0].content.body).not.toContain('starts a new streak');
    // Tomorrow the learner has not studied yet: the streak texts, as before.
    expect(ours()[1].content.body).toBe('A few minutes today starts a new streak.');
  });

  test('off → ours are cancelled, nothing is scheduled, no prompt', async () => {
    mockPhone.scheduled.push(otherNotification('other-1'));
    await syncReminders(reminderState(), at(9));
    const result = await syncReminders(reminderState({ settings: { reminderEnabled: false } }), at(9));
    expect(result).toEqual({ kind: 'off', cancelled: 14 });
    expect(ours()).toEqual([]);
    expect(mockPhone.scheduled.map((r) => r.identifier)).toEqual(['other-1']);
    expect(mockPhone.prompts).toBe(0);
  });

  test('on, but the system does not allow notifications → cancels ours, schedules nothing, NEVER asks', async () => {
    await syncReminders(reminderState(), at(9));
    mockPhone.granted = false;
    const result = await syncReminders(reminderState(), at(9));
    expect(result).toEqual({ kind: 'no-permission', cancelled: 14 });
    expect(ours()).toEqual([]);
    expect(mockPhone.calls).not.toContain('requestPermissions');
    expect(mockPhone.prompts).toBe(0);
  });

  test('a failing call → { kind: "failed" }, never a rejection', async () => {
    const port: ReminderPort = {
      ensurePermission: async () => true,
      hasPermission: async () => true,
      ensureChannel: async () => undefined,
      cancelOurs: async () => {
        throw new Error('native module gone');
      },
      scheduleDates: async () => [],
    };
    await expect(syncReminders(reminderState(), at(9), port)).resolves.toMatchObject({ kind: 'failed' });
  });

  test('web (no local notifications) → nothing is scheduled', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const result = await syncReminders(reminderState(), at(9));
    expect(result).toEqual({ kind: 'no-permission', cancelled: 0 });
    expect(mockPhone.calls).toEqual([]);
  });

  test('two syncs never overlap; a waiting sync takes the NEWEST state', async () => {
    // Every native call waits until the test lets it through, one at a time,
    // so two syncs WOULD mix their calls if they could run together.
    mockPhone.slow = true;
    const first = syncReminders(reminderState({ settings: { reminderTime: '06:00' } }), at(5));
    // Calls made before the first sync STARTED are merged into it (one sync, newest state).
    expect(syncReminders(reminderState({ settings: { reminderTime: '06:30' } }), at(5))).toBe(first);
    // Let the first sync start: it now waits inside its first native call.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockPhone.calls).toEqual(['getPermissions']);
    const second = syncReminders(reminderState({ settings: { reminderTime: '07:00' } }), at(5));
    const third = syncReminders(reminderState({ settings: { reminderTime: '08:00' } }), at(5));
    // The second and the third wait together: ONE more sync, with the third state.
    expect(second).not.toBe(first);
    expect(second).toBe(third);

    let done = false;
    void Promise.all([first, second]).then(() => {
      done = true;
    });
    for (let i = 0; i < 2000 && !done; i++) {
      mockPhone.waiters.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(done).toBe(true);

    // Sync 1 (nothing scheduled yet), then sync 2 — never mixed.
    const fourteen = (name: string) => Array.from({ length: 14 }, () => name);
    expect(mockPhone.calls).toEqual([
      'getPermissions',
      'channel',
      'getAll',
      ...fourteen('schedule'),
      'getPermissions',
      'channel',
      'getAll',
      ...fourteen('cancel'),
      ...fourteen('schedule'),
    ]);
    expect(ours()).toHaveLength(14);
    expect(ours().every((r) => r.trigger.date.getHours() === 8)).toBe(true);
  });
});

/* -------------------------------------------------------- turning on */

describe('enableReminders (the permission flow)', () => {
  function deps(initial: ReminderState) {
    let state = initial;
    const patches: Record<string, unknown>[] = [];
    return {
      patches,
      get state() {
        return state;
      },
      updateAppSettings: (patch: Partial<ReminderState['settings']> & Record<string, unknown>) => {
        patches.push(patch);
        state = { ...state, settings: { ...state.settings, ...patch } };
      },
      getState: () => state,
      now: () => at(9),
    };
  }

  test('not asked yet → channel FIRST, then the prompt; yes → on, offer seen, scheduled', async () => {
    mockPhone.granted = false;
    const d = deps(reminderState({ settings: { reminderEnabled: false } }));
    const outcome = await enableReminders(d);
    expect(outcome.kind).toBe('on');
    expect(mockPhone.calls.slice(0, 3)).toEqual(['channel', 'getPermissions', 'requestPermissions']);
    expect(d.patches).toEqual([{ reminderEnabled: true, reminderOfferSeen: true }]);
    expect(ours()).toHaveLength(14);
  });

  test('a time is written with the switch (onboarding "Remind me at 7:30 AM")', async () => {
    const d = deps(reminderState({ settings: { reminderEnabled: false } }));
    await enableReminders(d, '07:30');
    expect(d.patches).toEqual([{ reminderEnabled: true, reminderOfferSeen: true, reminderTime: '07:30' }]);
    expect(ours()[0].trigger.date.getHours()).toBe(7);
  });

  test('denied → NOTHING is written (the toggle stays off), nothing scheduled', async () => {
    mockPhone.granted = false;
    mockPhone.answer = false;
    const d = deps(reminderState({ settings: { reminderEnabled: false } }));
    await expect(enableReminders(d)).resolves.toEqual({ kind: 'denied' });
    expect(d.patches).toEqual([]);
    expect(ours()).toEqual([]);
  });

  test('"Don\'t allow" before (cannot ask again) → no prompt, denied', async () => {
    mockPhone.granted = false;
    mockPhone.canAskAgain = false;
    const d = deps(reminderState({ settings: { reminderEnabled: false } }));
    await expect(enableReminders(d)).resolves.toEqual({ kind: 'denied' });
    expect(mockPhone.prompts).toBe(0);
  });

  test('already allowed → no prompt', async () => {
    const d = deps(reminderState({ settings: { reminderEnabled: false } }));
    await enableReminders(d);
    expect(mockPhone.prompts).toBe(0);
  });

  // Review round 2 (E5 + spec §9.5): a backup with the reminder ON is
  // restored on a new phone. The app has NEVER asked there (Android 13+:
  // granted false, canAskAgain true). Before, the screen showed only "Open
  // system settings" while the toggle was on; the learner had to guess to
  // turn the toggle off and on again to get the normal prompt.
  test('restored on a new phone (on, never asked): "Allow notifications" shows the normal prompt and schedules', async () => {
    mockPhone.granted = false; // never asked: not granted, but the system may ask
    const restored = reminderState(); // reminderEnabled: true, from the backup
    expect(await syncReminders(restored, at(9))).toEqual({ kind: 'no-permission', cancelled: 0 });
    // The screen's box: the system blocks us, and asking can still work → "Allow notifications".
    expect(reminderBlock({ enabled: true, allowed: false, refused: false })).toEqual({ canAsk: true });

    // The button runs the same permission flow as the toggle.
    const d = deps(restored);
    const outcome = await enableReminders(d);
    expect(mockPhone.prompts).toBe(1); // the normal system prompt
    expect(outcome.kind).toBe('on');
    expect(ours()).toHaveLength(14);
    // Allowed now: no box any more, the status line instead.
    expect(reminderBlock({ enabled: true, allowed: true, refused: false })).toBeNull();
  });

  test('the system cannot ask any more → no prompt, denied → the box keeps only "Open system settings"', async () => {
    mockPhone.granted = false;
    mockPhone.canAskAgain = false; // "Don't allow" before
    const d = deps(reminderState());
    await expect(enableReminders(d)).resolves.toEqual({ kind: 'denied' });
    expect(mockPhone.prompts).toBe(0);
    expect(d.patches).toEqual([]); // nothing written
    expect(reminderBlock({ enabled: true, allowed: false, refused: true })).toEqual({ canAsk: false });
  });

  test('reminderBlock: no box when off and not refused, or while the permission is not known yet', () => {
    expect(reminderBlock({ enabled: false, allowed: false, refused: false })).toBeNull();
    expect(reminderBlock({ enabled: true, allowed: null, refused: false })).toBeNull();
    // A "turn on" from off that was refused: the box, without a second ask.
    expect(reminderBlock({ enabled: false, allowed: false, refused: true })).toEqual({ canAsk: false });
    expect(REMINDER_COPY.allow).toBe('Allow notifications');
  });

  test('the reminders screen offers "Allow notifications" only when asking can work, and it runs the permission flow', () => {
    const screen = fs.readFileSync(path.resolve(__dirname, '..', 'app', '(tabs)', 'settings', 'reminders.tsx'), 'utf8');
    expect(screen).toMatch(/const block = reminderBlock\(/);
    expect(screen).toMatch(/\{block\.canAsk \? \(\s*<Btn[^>]*onPress=\{startTurnOn\}>\s*\{REMINDER_COPY\.allow\}/);
    // `startTurnOn` is the toggle's own "on" path (the permission flow, one at a time).
    expect(screen).toMatch(/if \(on\) \{\s*startTurnOn\(\);/);
  });
});

/* ------------------------------------------------------------ the words */

describe('the reminder words', () => {
  test('times as the screens show them', () => {
    expect(formatReminderTime('20:00')).toBe('8:00 PM');
    expect(formatReminderTime('00:05')).toBe('12:05 AM');
    expect(formatReminderTime('12:00')).toBe('12:00 PM');
    expect(formatReminderTime('7:30')).toBe('7:30 AM');
    expect(formatReminderTime(undefined)).toBe('8:00 PM'); // broken setting → the default
    expect(reminderTimeOf(new Date(2026, 9, 22, 20, 5))).toBe('20:05');
    expect(reminderTimeOf(new Date(2026, 9, 22, 7, 0))).toBe('07:00');
    expect(reminderPickerValue('07:45', at(9)).getTime()).toBe(at(7, 45));
  });

  test('status line: today / today is done / tomorrow / off (spec §8.7, exact)', () => {
    expect(reminderStatusLine(reminderState(), at(9))).toBe('Next reminder: today at 8:00 PM');
    expect(reminderStatusLine(reminderState({ person: { lastStudyDay: '2026-10-22' } }), at(9))).toBe(
      'Today is done — next: tomorrow at 8:00 PM',
    );
    expect(reminderStatusLine(reminderState(), at(21))).toBe('Next reminder: tomorrow at 8:00 PM');
    expect(reminderStatusLine(reminderState({ settings: { reminderEnabled: false } }), at(9))).toBe(REMINDER_COPY.off);
    expect(REMINDER_COPY.off).toBe('Off');
  });

  // Wave 5h review (I3): Help quotes the status line. The quotes come from
  // reminderStatusLine itself here, so a new wording on the screen fails this
  // test until Help says the same (device note 9 was exactly that drift).
  test('Help › "Reminders not arriving?" quotes both forms of the status line exactly', () => {
    const help = fs.readFileSync(path.resolve(__dirname, '..', 'content', 'help.ts'), 'utf8');
    const today = reminderStatusLine(reminderState(), at(9));
    const done = reminderStatusLine(reminderState({ person: { lastStudyDay: '2026-10-22' } }), at(9));
    expect(help).toContain(`"${today}"`);
    expect(help).toContain(`"${done}"`);
  });

  test('the Settings row (spec §8.6)', () => {
    expect(reminderRowSub(reminderState(), at(9))).toBe('On · 8:00 PM · next: today 8:00 PM');
    expect(reminderRowSub(reminderState(), at(21))).toBe('On · 8:00 PM · next: tomorrow 8:00 PM');
    expect(reminderRowSub(reminderState({ settings: { reminderEnabled: false } }), at(9))).toBe('Off');
    expect(nextReminder(reminderState({ settings: { reminderEnabled: false } }), at(9))).toBeNull();
  });

  // Review round 1: the setting is on (a restored backup on a new phone, or
  // notifications turned off in the system settings), but the system blocks
  // our notifications. The sync then schedules NOTHING ('no-permission'), so
  // the hub row must not promise "next: today 8:00 PM".
  test('the Settings row says when the system blocks notifications', async () => {
    mockPhone.granted = false;
    expect(await syncReminders(reminderState(), at(9))).toEqual({ kind: 'no-permission', cancelled: 0 });
    expect(ours()).toEqual([]);
    expect(reminderRowSub(reminderState(), at(9), false)).toBe('On · notifications are turned off');
    expect(REMINDER_COPY.rowBlocked).toBe('On · notifications are turned off');
    // Allowed, or not known yet (the first read has not answered): the settings line.
    expect(reminderRowSub(reminderState(), at(9), true)).toBe('On · 8:00 PM · next: today 8:00 PM');
    expect(reminderRowSub(reminderState(), at(9), null)).toBe('On · 8:00 PM · next: today 8:00 PM');
    // Off stays "Off", whatever the system says.
    expect(reminderRowSub(reminderState({ settings: { reminderEnabled: false } }), at(9), false)).toBe('Off');
  });

  test('the exact copy of the screen', () => {
    expect(REMINDER_COPY.toggle).toBe('Daily reminder');
    expect(REMINDER_COPY.skip).toBe('Skip days when I already studied');
    // Release pass C1-1: Android delivers the inexact reminders up to an hour late (not "a few minutes").
    expect(REMINDER_COPY.late).toBe('Reminders may arrive up to an hour late. Android holds them back to save battery.');
    expect(REMINDER_COPY.denied).toBe('Notifications are turned off for Maranki.');
    expect(REMINDER_COPY.openSettings).toBe('Open system settings');
  });

  test('the sync key changes with what changes the plan or the text', () => {
    const base = reminderState();
    const key = reminderSyncKey(base);
    expect(reminderSyncKey(reminderState())).toBe(key);
    expect(reminderSyncKey(reminderState({ settings: { reminderTime: '07:00' } }))).not.toBe(key);
    expect(reminderSyncKey(reminderState({ settings: { reminderSkipStudied: false } }))).not.toBe(key);
    expect(reminderSyncKey(reminderState({ settings: { reminderEnabled: false } }))).not.toBe(key);
    expect(reminderSyncKey(reminderState({ person: { lastStudyDay: '2026-10-22' } }))).not.toBe(key);
    expect(reminderSyncKey(reminderState({ person: { streak: 3 } }))).not.toBe(key);
  });
});

/* ------------------------------------------------------------- the taps */

describe('a tap on a reminder opens Today (root layout)', () => {
  const response = (kind: string, action = 'expo.modules.notifications.actions.DEFAULT', id = 'n1', date = 5) => ({
    actionIdentifier: action,
    notification: { date, request: { identifier: id, content: { data: { kind } } } },
  });

  test('only a tap on OUR reminder counts', () => {
    expect(isReminderTap(response('maranki-reminder'))).toBe(true);
    expect(isReminderTap(response('something-else'))).toBe(false);
    expect(isReminderTap(response('maranki-reminder', 'snooze-button'))).toBe(false);
    expect(isReminderTap(null)).toBe(false);
    expect(DEFAULT_ACTION).toBe('expo.modules.notifications.actions.DEFAULT');
  });

  test('the same tap reported twice (hook + listener) has one key', () => {
    expect(reminderTapKey(response('maranki-reminder'))).toBe(reminderTapKey(response('maranki-reminder')));
    expect(reminderTapKey(response('maranki-reminder', undefined, 'n2'))).not.toBe(reminderTapKey(response('maranki-reminder')));
  });
});

/* ------------------------------------------------------------- the hook */

describe('useReminderSync (root layout)', () => {
  let renderer: ReactTestRenderer | null = null;
  let appStateListener: ((s: AppStateStatus) => void) | null = null;

  function Probe() {
    useReminderSync();
    return null;
  }

  beforeEach(() => {
    appStateListener = null;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      appStateListener = listener as (s: AppStateStatus) => void;
      return { remove: () => undefined } as ReturnType<typeof AppState.addEventListener>;
    });
  });

  afterEach(() => {
    if (renderer) act(() => renderer!.unmount());
    renderer = null;
  });

  async function settle() {
    await act(async () => {
      await remindersSettled();
    });
  }

  test('boot: syncs once the data is ready; a settings change syncs again', async () => {
    mockData = { ready: true, state: reminderState(), persistError: null };
    act(() => {
      renderer = TestRenderer.create(React.createElement(Probe));
    });
    await settle();
    expect(ours()).toHaveLength(14);

    mockData = { ...mockData, state: reminderState({ settings: { reminderEnabled: false } }) };
    act(() => renderer!.update(React.createElement(Probe)));
    await settle();
    expect(ours()).toEqual([]);
  });

  test('not ready, or a data problem → nothing is synced', async () => {
    mockData = { ready: false, state: reminderState(), persistError: null };
    act(() => {
      renderer = TestRenderer.create(React.createElement(Probe));
    });
    await settle();
    mockData = { ready: true, state: reminderState(), persistError: 'read' };
    act(() => renderer!.update(React.createElement(Probe)));
    await settle();
    expect(mockPhone.calls).toEqual([]);
  });

  test('the app goes to the background → syncs with the newest state', async () => {
    mockData = { ready: true, state: reminderState({ settings: { reminderEnabled: false } }), persistError: null };
    act(() => {
      renderer = TestRenderer.create(React.createElement(Probe));
    });
    await settle();
    expect(ours()).toEqual([]);
    // The state changes without a re-render (the engine store), then the app leaves.
    mockData.state = reminderState();
    await act(async () => {
      appStateListener?.('background');
      await remindersSettled();
    });
    expect(ours()).toHaveLength(14);
  });
});

/* ------------------------------------------------------ the permission */

describe('useNotificationsAllowed (the Settings hub row, review round 1)', () => {
  let renderer: ReactTestRenderer | null = null;
  let appStateListener: ((s: AppStateStatus) => void) | null = null;
  let seen: NotificationsAllowed | null = null;

  function Probe({ port }: { port?: ReminderPort }) {
    seen = useNotificationsAllowed(port);
    return null;
  }

  beforeEach(() => {
    appStateListener = null;
    seen = null;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      appStateListener = listener as (s: AppStateStatus) => void;
      return { remove: () => undefined } as ReturnType<typeof AppState.addEventListener>;
    });
  });

  afterEach(() => {
    if (renderer) act(() => renderer!.unmount());
    renderer = null;
  });

  /** Let the permission reads answer. */
  async function settle() {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }

  test('reads at mount, again when the app comes back, and on refresh() — never asks', async () => {
    mockPhone.granted = false;
    act(() => {
      renderer = TestRenderer.create(React.createElement(Probe));
    });
    expect(seen!.allowed).toBeNull(); // not known before the first answer
    await settle();
    expect(seen!.allowed).toBe(false);

    // The user allows notifications in the system settings, then comes back.
    mockPhone.granted = true;
    await act(async () => {
      appStateListener?.('active');
    });
    await settle();
    expect(seen!.allowed).toBe(true);

    // Turned off again; the screen is shown again (useFocusEffect → refresh).
    mockPhone.granted = false;
    await act(async () => {
      seen!.refresh();
    });
    await settle();
    expect(seen!.allowed).toBe(false);

    expect(mockPhone.prompts).toBe(0);
    expect(mockPhone.calls).not.toContain('requestPermissions');
  });

  test('a read that fails (throws or rejects) counts as "not allowed"', async () => {
    const rejects: ReminderPort = { ...brokenPort(), hasPermission: () => Promise.reject(new Error('no module')) };
    act(() => {
      renderer = TestRenderer.create(React.createElement(Probe, { port: rejects }));
    });
    await settle();
    expect(seen!.allowed).toBe(false);
    act(() => renderer!.unmount());
    renderer = null;

    const throws: ReminderPort = {
      ...brokenPort(),
      hasPermission: () => {
        throw new Error('sync throw');
      },
    };
    act(() => {
      renderer = TestRenderer.create(React.createElement(Probe, { port: throws }));
    });
    await settle();
    expect(seen!.allowed).toBe(false);
  });
});

/** A port whose calls all fail: each test replaces the one call it needs. */
function brokenPort(): ReminderPort {
  const fail = () => Promise.reject(new Error('not used'));
  return { ensurePermission: fail, hasPermission: fail, ensureChannel: fail, cancelOurs: fail, scheduleDates: fail };
}
