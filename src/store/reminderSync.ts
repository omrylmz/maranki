/**
 * Reminder sync (spec §8.7, unit W4-5): keep the daily reminders that the
 * phone has scheduled in step with the settings and the learner's study days.
 *
 * The parts:
 *   - src/platform/reminderPlan.ts   — PURE: which moments to remind (up to
 *                                      14 one-shot dates) and the text;
 *   - src/platform/notifications.ts  — thin expo-notifications calls (channel,
 *                                      permission, cancel ours, schedule);
 *   - this file                      — WHEN to sync, and the words the
 *                                      reminders screen shows.
 *
 * `syncReminders(state, now)` (the contract other screens use):
 *   1. reminders off               → cancel our scheduled reminders;
 *   2. on, but the system does not allow notifications (the user said no,
 *      or turned them off later in the system settings) → cancel ours and
 *      schedule nothing. It NEVER shows a permission prompt: only a tap on
 *      "Daily reminder", "Allow notifications" or "Remind me at …" may ask
 *      (`enableReminders`);
 *   3. on and allowed               → make sure the Android channel exists,
 *      cancel ours, and schedule the planned dates.
 * It never rejects: a failure is the result `{ kind: 'failed' }`.
 *
 * WHY "cancel, then schedule again" every time: one DAILY trigger cannot skip
 * a day on which the learner already studied, so we schedule single dates
 * and plan them again on every sync (spec §8.7). A sync runs on:
 *   - a change of the reminder settings (toggle, time, "skip studied days");
 *   - a session complete (the study day and the streak change, so the plan
 *     and the text change);
 *   - the app going to the background;
 *   - boot (the data is loaded).
 * `useReminderSync()` (called once, from the root layout) does all four by
 * watching a small key of the state (`reminderSyncKey`) and AppState.
 *
 * ONE AT A TIME. Two syncs must never run together: "cancel ours" of one and
 * "schedule" of the other could mix, and then a day has two reminders. So the
 * syncs go through one promise chain. A sync that is still WAITING in that
 * chain is merged with a newer call: only the newest state is planned (it is
 * the truth), and both callers get the same answer.
 *
 * Example (the reminders screen, after the time changed):
 *   actions.updateAppSettings({ reminderTime: '07:30' });
 *   const result = await syncReminders(engine.store.getState(), Date.now());
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { type AppSettings, dayKeyOf, type Person } from '../domain/types';
import * as notifications from '../platform/notifications';
import {
  DEFAULT_REMINDER_TIME,
  parseReminderTime,
  planReminders,
  type ReminderContent,
  reminderContentFor,
} from '../platform/reminderPlan';
import { useData } from './DataContext';
import { dataProblemOf } from './problemCopy';
import { useEngine } from './selectors';

/* ------------------------------------------------------------- the port */

/**
 * The notification calls the sync needs. The app uses `deviceReminderPort`
 * (src/platform/notifications.ts); a test passes a fake one.
 */
export interface ReminderPort {
  /** Ask the user when needed (Android: the channel is made FIRST). Resolves true when allowed. */
  ensurePermission(): Promise<boolean>;
  /** Are notifications allowed now? Never shows a prompt. */
  hasPermission(): Promise<boolean>;
  /** Android: make the "Daily reminder" channel. Elsewhere it does nothing. */
  ensureChannel(): Promise<void>;
  /** Cancel every scheduled reminder of OURS (never other notifications). Resolves how many. */
  cancelOurs(): Promise<number>;
  /** Schedule one reminder per date (dates not after `now` are skipped). Resolves the new ids. */
  scheduleDates(dates: readonly Date[], contentFor: (date: Date) => ReminderContent, now: number): Promise<string[]>;
}

/** The real notifications of the phone (expo-notifications). */
export const deviceReminderPort: ReminderPort = {
  ensurePermission: () => notifications.ensurePermission(),
  hasPermission: () => notifications.hasPermission(),
  ensureChannel: () => notifications.ensureChannel(),
  cancelOurs: () => notifications.cancelOurs(),
  scheduleDates: (dates, contentFor, now) => notifications.scheduleDates(dates, contentFor, now),
};

/* ------------------------------------------------------------- the plan */

/** The parts of the state the reminders read (a DataState fits). */
export interface ReminderState {
  settings: Pick<AppSettings, 'reminderEnabled' | 'reminderTime' | 'reminderSkipStudied'>;
  person: Pick<Person, 'streak' | 'lastStudyDay' | 'freezes'>;
}

/** The moments to remind the learner for this state (pure; empty when reminders are off). */
export function reminderDates(state: ReminderState, now: number): Date[] {
  return planReminders(now, {
    enabled: state.settings.reminderEnabled === true,
    time: state.settings.reminderTime,
    skipStudied: state.settings.reminderSkipStudied !== false,
    lastStudyDay: state.person.lastStudyDay,
  });
}

/**
 * A short text that changes exactly when a sync could plan something else:
 * the three reminder settings, the study day and the streak (the text says
 * "keeps your 12-day streak"). `useReminderSync` syncs when it changes.
 */
export function reminderSyncKey(state: ReminderState): string {
  const { settings: s, person: p } = state;
  return [s.reminderEnabled, s.reminderTime, s.reminderSkipStudied, p.lastStudyDay, p.streak, p.freezes].join('|');
}

/* ------------------------------------------------------------- the sync */

/** What one sync did. */
export type ReminderSyncResult =
  /** Reminders are off: ours were cancelled. */
  | { kind: 'off'; cancelled: number }
  /** Reminders are on, but the system does not allow notifications: ours were cancelled, none scheduled. */
  | { kind: 'no-permission'; cancelled: number }
  /** Reminders are on: ours were cancelled, and `dates` are scheduled now (oldest first). */
  | { kind: 'scheduled'; cancelled: number; dates: Date[] }
  /** A notification call failed. What is scheduled now is not known; the next sync tries again. */
  | { kind: 'failed'; error: unknown };

/** One sync, in order. Never rejects. */
async function runSync(state: ReminderState, now: number, port: ReminderPort): Promise<ReminderSyncResult> {
  try {
    if (state.settings.reminderEnabled !== true) {
      return { kind: 'off', cancelled: await port.cancelOurs() };
    }
    if (!(await port.hasPermission())) {
      return { kind: 'no-permission', cancelled: await port.cancelOurs() };
    }
    // Android: a reminder is scheduled ON the channel, so the channel must exist first.
    await port.ensureChannel();
    const cancelled = await port.cancelOurs();
    const planned = reminderDates(state, now);
    const person = state.person;
    await port.scheduleDates(planned, (date) => reminderContentFor(date, person), now);
    return { kind: 'scheduled', cancelled, dates: planned.filter((d) => d.getTime() > now) };
  } catch (error) {
    return { kind: 'failed', error };
  }
}

/** A sync that waits in the chain. A newer call changes its input (the newest state wins). */
interface WaitingSync {
  input: { state: ReminderState; now: number; port: ReminderPort };
  promise: Promise<ReminderSyncResult>;
}

/** The end of the chain: the sync that runs (or ran) last. */
let tail: Promise<unknown> = Promise.resolve();
/** The sync that has not started yet, or null. */
let waiting: WaitingSync | null = null;

/**
 * Plan the reminders again for `state` (spec §8.7 "Sync"). See the top of
 * the file. Syncs run one at a time; a call while another sync waits is
 * merged into it (the newest state and `now` are planned). Never rejects.
 */
export function syncReminders(
  state: ReminderState,
  now: number,
  port: ReminderPort = deviceReminderPort,
): Promise<ReminderSyncResult> {
  if (waiting) {
    waiting.input = { state, now, port };
    return waiting.promise;
  }
  const job = { input: { state, now, port } } as WaitingSync;
  job.promise = tail.then(() => {
    // From here a new call starts a new sync after this one.
    if (waiting === job) waiting = null;
    return runSync(job.input.state, job.input.now, job.input.port);
  });
  waiting = job;
  tail = job.promise;
  return job.promise;
}

/** Wait until every sync asked for so far has finished (tests, and the screen's status line). */
export function remindersSettled(): Promise<void> {
  return tail.then(() => undefined);
}

/* --------------------------------------------------------- turning on */

/** What `enableReminders` needs: the store's actions and state, and the clock. */
export interface EnableDeps {
  /** `actions.updateAppSettings`. */
  updateAppSettings(patch: Partial<AppSettings>): void;
  /** The NEWEST state (the engine's `store.getState`), read after the settings changed. */
  getState(): ReminderState;
  now(): number;
  port?: ReminderPort;
}

/** What turning the reminder on did. */
export type EnableOutcome =
  /** Allowed: the setting is on and the reminders were planned (`sync`). */
  | { kind: 'on'; sync: ReminderSyncResult }
  /** The user (or the system) said no: nothing was written, the toggle stays off. */
  | { kind: 'denied' }
  /** The permission call itself failed: nothing was written. */
  | { kind: 'failed'; error: unknown };

/**
 * Turn the daily reminder on (spec §8.7 "Turning on"), from the reminders
 * screen ("Daily reminder", and "Allow notifications" when the setting is on
 * but the system never allowed it), from Today's offer (it opens
 * `/(tabs)/settings/reminders?enable=1`; the Settings layout puts the hub
 * under that page, settings/_layout.tsx) and from the onboarding step
 * "Remind me at 8:00 PM":
 *   1. the permission flow: the Android channel FIRST (Android 13 shows the
 *      prompt only after a channel exists), then ask only when needed;
 *   2. denied → nothing is written, so the toggle stays off;
 *   3. allowed → `reminderEnabled: true` (+ the time, when given), and the
 *      one-time Today offer is marked as seen (it has no job any more);
 *   4. sync, so the reminders are scheduled now.
 * Never rejects.
 */
export async function enableReminders(deps: EnableDeps, time?: string): Promise<EnableOutcome> {
  const port = deps.port ?? deviceReminderPort;
  let allowed: boolean;
  try {
    allowed = await port.ensurePermission();
  } catch (error) {
    return { kind: 'failed', error };
  }
  if (!allowed) return { kind: 'denied' };
  const patch: Partial<AppSettings> = { reminderEnabled: true, reminderOfferSeen: true };
  if (time !== undefined && parseReminderTime(time) !== null) patch.reminderTime = time;
  deps.updateAppSettings(patch);
  const sync = await syncReminders(deps.getState(), deps.now(), port);
  return { kind: 'on', sync };
}

/* ------------------------------------------------------------ the words */

/** Every fixed text of the reminders screen (spec §8.7, exact). */
export const REMINDER_COPY = {
  title: 'Reminders',
  toggle: 'Daily reminder',
  time: 'Time',
  skip: 'Skip days when I already studied',
  /**
   * The honest delay (release pass 2026-11-02, C1-1). Android 12 and later
   * schedules our reminders as INEXACT alarms (we do not ask for the
   * exact-alarm permission): `dumpsys alarm` showed a delivery window of up
   * to one hour. See src/platform/notifications.ts `scheduleDates`. The
   * Help section "Reminders not arriving?" says the same (src/content/help.ts).
   */
  late: 'Reminders may arrive up to an hour late. Android holds them back to save battery.',
  denied: 'Notifications are turned off for Maranki.',
  /**
   * The setting is on, but the system has not allowed our notifications
   * (review round 2): ask with the normal system prompt. Not spec copy — the
   * spec has no words for this case (see `reminderBlock`).
   */
  allow: 'Allow notifications',
  openSettings: 'Open system settings',
  off: 'Off',
  /** The permission call failed (rare): nothing was changed. */
  failed: "We couldn't turn on reminders. Please try again.",
  /** A sync failed: the setting is saved, the phone may not have the reminders. */
  syncFailed: "We couldn't schedule the reminders. We try again when you leave the app.",
  /**
   * The Settings hub row when the reminder is on but the system does not
   * allow our notifications (review round 1): nothing is scheduled then, so
   * the row must not promise "next: today 8:00 PM".
   */
  rowBlocked: 'On · notifications are turned off',
} as const;

/** A 'HH:MM' time as the screens show it: '20:00' → '8:00 PM', '00:05' → '12:05 AM'. Broken → the default time. */
export function formatReminderTime(time: unknown): string {
  const t = parseReminderTime(time) ?? parseReminderTime(DEFAULT_REMINDER_TIME)!;
  const suffix = t.hour < 12 ? 'AM' : 'PM';
  const hour12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
  return `${hour12}:${`${t.minute}`.padStart(2, '0')} ${suffix}`;
}

/** The time as 'HH:MM' (24 h) from a picked Date (local wall-clock time): 8:05 PM → '20:05'. */
export function reminderTimeOf(date: Date): string {
  return `${`${date.getHours()}`.padStart(2, '0')}:${`${date.getMinutes()}`.padStart(2, '0')}`;
}

/** A Date for the time picker: today at the reminder time (local). */
export function reminderPickerValue(time: unknown, now: number): Date {
  const t = parseReminderTime(time) ?? parseReminderTime(DEFAULT_REMINDER_TIME)!;
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.hour, t.minute);
}

/** Where the next reminder is: 'today', 'tomorrow' (and why), or null when none is planned. */
export type NextReminder =
  | { day: 'today'; time: string }
  | { day: 'tomorrow'; time: string; studiedToday: boolean }
  | null;

/** The next planned reminder (pure). */
export function nextReminder(state: ReminderState, now: number): NextReminder {
  const dates = reminderDates(state, now);
  if (dates.length === 0) return null;
  const time = formatReminderTime(state.settings.reminderTime);
  if (dayKeyOf(dates[0].getTime()) === dayKeyOf(now)) return { day: 'today', time };
  const studiedToday = state.settings.reminderSkipStudied !== false && state.person.lastStudyDay === dayKeyOf(now);
  return { day: 'tomorrow', time, studiedToday };
}

/**
 * The status line of the reminders screen (spec §8.7, exact copy):
 *   "Next reminder: today at 8:00 PM"
 *   "Today is done — next: tomorrow at 8:00 PM"   (studied today, skip is on)
 *   "Next reminder: tomorrow at 8:00 PM"          (today's time has passed)
 *   "Off"
 */
export function reminderStatusLine(state: ReminderState, now: number): string {
  const next = nextReminder(state, now);
  if (next === null) return REMINDER_COPY.off;
  if (next.day === 'today') return `Next reminder: today at ${next.time}`;
  if (next.studiedToday) return `Today is done — next: tomorrow at ${next.time}`;
  return `Next reminder: tomorrow at ${next.time}`;
}

/**
 * The Settings index row (spec §8.6): "On · 8:00 PM · next: today 8:00 PM",
 * or "Off".
 *
 * `allowed` is what the system says about our notifications
 * (`useNotificationsAllowed`): false → "On · notifications are turned off".
 * WHY: with the setting on but notifications blocked (a backup restored on a
 * new phone, or notifications turned off in the system settings), the sync
 * schedules NOTHING ('no-permission'). A "next: today" line would promise a
 * reminder that never comes. null = not known yet: the settings line.
 *
 *   reminderRowSub(state, now, false) → 'On · notifications are turned off'
 */
export function reminderRowSub(state: ReminderState, now: number, allowed: boolean | null = null): string {
  const next = nextReminder(state, now);
  if (next === null) return REMINDER_COPY.off;
  if (allowed === false) return REMINDER_COPY.rowBlocked;
  return `On · ${next.time} · next: ${next.day} ${next.time}`;
}

/* ------------------------------------------------------ the permission */

/**
 * The "Notifications are turned off for Maranki." box of the reminders
 * screen, or null when it is not shown (pure).
 *   - `canAsk: true`  → "Allow notifications" (the permission flow, which shows
 *     the system prompt when the system still lets us ask) + "Open system
 *     settings";
 *   - `canAsk: false` → "Open system settings" only.
 *
 * WHY "Allow notifications" (review round 2): `hasPermission()` is false both
 * when the user said no AND when the app has NEVER asked — for example a
 * backup with `reminderEnabled: true` restored on a new phone. Then the
 * toggle is on, the sync schedules nothing, and the only button was "Open
 * system settings": the learner had to guess to turn the toggle off and on.
 * After a try on this screen that ended in "denied" (the user just said no,
 * or the system does not let us ask any more), the box offers the system
 * settings only: a second "Allow" would only repeat that answer.
 *
 *   reminderBlock({ enabled: true,  allowed: false, refused: false }) → { canAsk: true }
 *   reminderBlock({ enabled: true,  allowed: false, refused: true })  → { canAsk: false }
 *   reminderBlock({ enabled: false, allowed: false, refused: false }) → null   (off: no box)
 *   reminderBlock({ enabled: true,  allowed: null,  refused: false }) → null   (not known yet)
 */
export function reminderBlock(input: {
  /** `settings.reminderEnabled`. */
  enabled: boolean;
  /** What the system says now (`hasPermission`); null = not known yet. */
  allowed: boolean | null;
  /** A "turn on" or "Allow notifications" on this screen just ended in "denied". */
  refused: boolean;
}): { canAsk: boolean } | null {
  if (input.refused) return { canAsk: false };
  if (input.enabled && input.allowed === false) return { canAsk: true };
  return null;
}

/** What `useNotificationsAllowed` gives a screen. */
export interface NotificationsAllowed {
  /** true = allowed, false = not allowed (or no notifications here, like the web preview), null = not known yet. */
  allowed: boolean | null;
  /** Read the permission again (for example when the screen is shown again). Never asks. */
  refresh: () => void;
}

/**
 * Does the system allow our notifications? For a screen that shows the
 * reminder state, like the Settings hub row (review round 1). It NEVER shows
 * a prompt (only `enableReminders` may ask). It reads the permission:
 *   - when the screen mounts;
 *   - when the app comes back to the front (the user may have changed it in
 *     the system settings);
 *   - when the screen calls `refresh()` (for example in `useFocusEffect`,
 *     after the user turned reminders on in Settings › Reminders).
 * The answer arrives in a promise callback, never during render. A failed
 * read counts as "not allowed".
 *
 * Example (the Settings hub):
 *   const { allowed, refresh } = useNotificationsAllowed();
 *   useFocusEffect(refresh);
 *   <ListRow title="Reminders" sub={reminderRowSub(state, now, allowed)} />
 */
export function useNotificationsAllowed(port: ReminderPort = deviceReminderPort): NotificationsAllowed {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  // False after unmount: a late answer is then dropped.
  const mounted = useRef(false);

  const refresh = useCallback(() => {
    let read: Promise<boolean>;
    try {
      read = port.hasPermission();
    } catch {
      read = Promise.resolve(false);
    }
    void read
      .catch(() => false)
      .then((yes) => {
        if (mounted.current) setAllowed(yes);
      });
  }, [port]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') refresh();
    });
    return () => {
      mounted.current = false;
      sub.remove();
    };
  }, [refresh]);

  return { allowed, refresh };
}

/* ------------------------------------------------------------ the taps */

/** The parts of an expo-notifications `NotificationResponse` the tap handler reads. */
export interface ReminderResponse {
  actionIdentifier: string;
  notification: {
    date: number;
    request: { identifier: string; content: { data?: Record<string, unknown> | null } };
  };
}

/** `Notifications.DEFAULT_ACTION_IDENTIFIER`: the user tapped the notification itself. */
export const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT';

/**
 * True when the user TAPPED one of our reminders (spec §8.7 "Tap → Today").
 * Another app feature's notification, or a button of a notification, is not.
 */
export function isReminderTap(response: ReminderResponse | null | undefined): response is ReminderResponse {
  return (
    !!response &&
    response.actionIdentifier === DEFAULT_ACTION &&
    response.notification.request.content.data?.kind === notifications.REMINDER_DATA_KIND
  );
}

/**
 * One key per tap. The cold-start hook (`useLastNotificationResponse`) and
 * the listener (`addNotificationResponseReceivedListener`) can both report
 * the SAME tap; the root layout opens Today once per key.
 */
export function reminderTapKey(response: ReminderResponse): string {
  return `${response.notification.request.identifier}@${response.notification.date}`;
}

/* ------------------------------------------------------------- the hook */

/**
 * Keep the reminders in step while the app runs. Call it ONCE, from the root
 * layout. It syncs:
 *   - when the data is ready (boot);
 *   - whenever `reminderSyncKey` changes (a settings change, a session that
 *     moved the study day or the streak, a restore, a reset);
 *   - when the app goes to the background.
 * Never while the saved data could not be opened (DataProblemScreen): the
 * state is then only the blank seed, not the user's settings.
 */
export function useReminderSync(): void {
  const { ready, state, persistError } = useData();
  const engine = useEngine();
  const blocked = dataProblemOf(persistError) !== null;
  const key = reminderSyncKey(state);

  useEffect(() => {
    if (!ready || blocked) return;
    // `key` is in the dependencies on purpose: a new key means a new plan.
    void syncReminders(engine.store.getState(), Date.now());
  }, [ready, blocked, key, engine]);

  useEffect(() => {
    if (!ready || blocked) return;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') void syncReminders(engine.store.getState(), Date.now());
    });
    return () => sub.remove();
  }, [ready, blocked, engine]);
}
