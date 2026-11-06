/**
 * Local notifications for the daily reminder (spec §8.7), via expo-notifications.
 *
 * Thin wrappers only. WHAT to schedule is decided by the pure, tested
 * src/platform/reminderPlan.ts; WHEN to sync is decided by
 * src/store/reminderSync.ts (wave 4; Settings › Reminders, Today's offer and
 * onboarding use it). The native behaviour is checked on the emulator
 * (check E6, spec §11).
 *
 * The four steps, in the order reminderSync uses them:
 *   1. ensureChannel()     Android: create the "Daily reminder" channel.
 *   2. ensurePermission()  ask the user (only when needed).
 *   3. cancelOurs()        remove OUR scheduled reminders (never other ones).
 *   4. scheduleDates()     one one-shot notification per planned date.
 *
 * How we know which scheduled notifications are ours: every reminder carries
 * `data: { kind: 'maranki-reminder' }`. cancelOurs() cancels only those.
 *
 * Web (the dev preview) has no local notifications: every function there does
 * nothing and answers "not allowed" / nothing scheduled.
 *
 * Example:
 *   if (await ensurePermission()) {
 *     await cancelOurs();
 *     const dates = planReminders(now, { enabled: true, time, skipStudied, lastStudyDay });
 *     await scheduleDates(dates, (date) => reminderContentFor(date, person));
 *   }
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { ReminderContent } from './reminderPlan';

/** The Android notification channel of the reminder. */
export const REMINDER_CHANNEL_ID = 'reminders';

/** The channel name the user sees in Android's app notification settings (spec §8.7). */
export const REMINDER_CHANNEL_NAME = 'Daily reminder';

/** `content.data.kind` of every reminder we schedule. */
export const REMINDER_DATA_KIND = 'maranki-reminder';

/** Local notifications exist only in the native apps. */
function isSupported(): boolean {
  return Platform.OS === 'android' || Platform.OS === 'ios';
}

/**
 * Create (or update) the reminder channel. Android only; elsewhere it does
 * nothing. Safe to call many times: Android keeps the user's own changes to
 * an existing channel (only the name and description can change).
 */
export async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL_ID, {
    name: REMINDER_CHANNEL_NAME,
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

/**
 * "Allowed" as the expo-notifications docs define it: granted, or (iOS)
 * provisional — iOS then delivers quietly to the Notification Centre.
 */
function isAllowed(status: Notifications.NotificationPermissionsStatus): boolean {
  return status.granted || status.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
}

/**
 * Are notifications allowed right now? Never shows a prompt. The reminders
 * screen uses it to show "Notifications are turned off for Maranki." when the
 * user turned them off in the system settings.
 */
export async function hasPermission(): Promise<boolean> {
  if (!isSupported()) return false;
  return isAllowed(await Notifications.getPermissionsAsync());
}

/**
 * Make sure we may show notifications, and ask the user when needed.
 * Resolves true when allowed, false when denied (the toggle then stays off).
 *
 * The channel is created FIRST: on Android 13 and later the system shows the
 * permission prompt only after the app has at least one channel. When the
 * system says we may not ask again (the user said "Don't allow" before), no
 * prompt is shown and it resolves false.
 */
export async function ensurePermission(): Promise<boolean> {
  if (!isSupported()) return false;
  await ensureChannel();
  const current = await Notifications.getPermissionsAsync();
  if (isAllowed(current)) return true;
  if (!current.canAskAgain) return false;
  return isAllowed(await Notifications.requestPermissionsAsync());
}

/**
 * Schedule one notification per date, with the text `contentFor(date)`.
 * Resolves the new notification ids, in the order of `dates`.
 *
 * A date that is not after `now` is skipped: the system would show it at once.
 * (`now` is a parameter so a caller can pass the same clock it planned with.)
 * Each reminder is a one-shot DATE trigger on the reminder channel; a single
 * repeating DAILY trigger could not skip a day the learner already studied.
 *
 * How late a reminder can be (release pass 2026-11-02, C1-1): on Android 12
 * and later, expo-notifications uses an EXACT alarm only when the app may
 * schedule exact alarms (`AlarmManager.canScheduleExactAlarms()`). Maranki
 * does not ask for that permission, so the alarm is INEXACT
 * (`setAndAllowWhileIdle`): Android may hold it back to save battery, up to
 * one hour after the date (`dumpsys alarm` showed a window of +1h for the
 * next days). So the screens say "Reminders may arrive up to an hour late."
 * (reminderSync.ts `REMINDER_COPY.late`, help.ts "Reminders not arriving?").
 */
export async function scheduleDates(
  dates: readonly Date[],
  contentFor: (date: Date) => ReminderContent,
  now: number = Date.now(),
): Promise<string[]> {
  if (!isSupported()) return [];
  const ids: string[] = [];
  for (const date of dates) {
    if (!(date.getTime() > now)) continue;
    const { title, body } = contentFor(date);
    const id = await Notifications.scheduleNotificationAsync({
      content: { title, body, data: { kind: REMINDER_DATA_KIND } },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date,
        channelId: REMINDER_CHANNEL_ID,
      },
    });
    ids.push(id);
  }
  return ids;
}

/**
 * Cancel every scheduled reminder of ours (`data.kind === 'maranki-reminder'`).
 * Notifications scheduled by anything else are never touched. Resolves how
 * many were cancelled.
 */
export async function cancelOurs(): Promise<number> {
  if (!isSupported()) return 0;
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const ours = scheduled.filter((request) => request.content.data?.kind === REMINDER_DATA_KIND);
  for (const request of ours) {
    await Notifications.cancelScheduledNotificationAsync(request.identifier);
  }
  return ours.length;
}
