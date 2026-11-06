/**
 * The daily-reminder plan (spec §8.7) — PURE: no clock, no native module.
 *
 * WHY one-shot dates and not one repeating "DAILY" trigger: a DAILY trigger
 * fires every day, so it cannot skip a day on which the learner already
 * studied. Instead we schedule up to 14 single reminders ("one-shot dates"),
 * one per day, and plan them again on every sync (toggle or time change, app
 * background, session complete, boot — see src/store/reminderSync.ts, W4).
 *
 * Days are LOCAL calendar days, like `dayKeyOf()` in src/domain/types.ts. Each
 * date is built with `new Date(year, month, day + i, hour, minute)`, never with
 * "previous date + 24 hours". So on a daylight-saving (DST) day the reminder
 * keeps its wall-clock time (20:00 stays 20:00), even though that day has 23
 * or 25 hours.
 *
 * This file also holds the notification TEXT (exact spec copy), because the
 * text depends on the streak on the day the reminder fires, and on whether
 * the learner already studied on that day.
 *
 * Example:
 *   planReminders(now, { enabled: true, time: '20:00', skipStudied: true, lastStudyDay: '2026-10-23' })
 *   // now = 23 Oct 2026, 09:00, and the learner studied today
 *   // → 14 dates: 24 Oct 20:00, 25 Oct 20:00, … 6 Nov 20:00
 */
import { addDays, dayKeyOf } from '../domain/types';

/** How many one-shot reminders are planned ahead. */
export const REMINDER_DAYS = 14;

/** Used when the stored time is not a valid 'HH:MM' (the v3 default, spec §3.4). */
export const DEFAULT_REMINDER_TIME = '20:00';

/** A wall-clock time of day, 24-hour clock. */
export interface ReminderTime {
  /** 0–23 */
  hour: number;
  /** 0–59 */
  minute: number;
}

/**
 * Read a 'HH:MM' time (24 h). A one-digit hour ('8:05') is accepted too.
 * Returns null for anything else, so a broken setting never becomes NaN.
 *
 * The type is `unknown` on purpose: old or hand-edited saved data can hold
 * `undefined`, `null` or a number here. Those give null too (no TypeError), so
 * the caller can fall back to DEFAULT_REMINDER_TIME.
 */
export function parseReminderTime(time: unknown): ReminderTime | null {
  if (typeof time !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export interface ReminderPlanOptions {
  /** `settings.reminderEnabled`. false → the plan is empty. */
  enabled: boolean;
  /**
   * `settings.reminderTime`, 'HH:MM' (24 h). An invalid value falls back to
   * DEFAULT_REMINDER_TIME — also a value that is not a string at all.
   */
  time: string;
  /** `settings.reminderSkipStudied`: no reminder today when the learner already studied today. */
  skipStudied: boolean;
  /** `person.lastStudyDay` ('YYYY-MM-DD'), or null / '' when the learner never studied. */
  lastStudyDay: string | null;
}

/**
 * The moments to remind the learner, oldest first: up to 14 one-shot dates at
 * the reminder time, one per local day.
 *
 * The first date is TODAY when both are true:
 *   - today's reminder time is still ahead of `now` (strictly later), and
 *   - the learner has not studied today, or `skipStudied` is off.
 * Otherwise the first date is TOMORROW.
 *
 * Note: on the one night a year when the clock jumps forward, a time inside
 * the missing hour (for example 02:30) does not exist. JavaScript then moves
 * it to the first real moment after the jump (03:30). It stays on the right day.
 */
export function planReminders(now: number, opts: ReminderPlanOptions): Date[] {
  if (!opts.enabled || !Number.isFinite(now)) return [];
  const { hour, minute } =
    parseReminderTime(opts.time) ?? (parseReminderTime(DEFAULT_REMINDER_TIME) as ReminderTime);

  const today = new Date(now);
  const year = today.getFullYear();
  const month = today.getMonth();
  const day = today.getDate();

  const todaySlot = new Date(year, month, day, hour, minute).getTime();
  const studiedToday = opts.lastStudyDay === dayKeyOf(now);
  const includeToday = todaySlot > now && !(opts.skipStudied && studiedToday);
  const first = includeToday ? 0 : 1;

  const dates: Date[] = [];
  for (let i = 0; i < REMINDER_DAYS; i++) {
    // Calendar arithmetic: the Date constructor rolls day 32 into the next
    // month, and keeps the local wall-clock time across a DST switch.
    dates.push(new Date(year, month, day + first + i, hour, minute));
  }
  return dates;
}

/* ------------------------------------------------------------ the text */

/** What one reminder says. */
export interface ReminderContent {
  title: string;
  body: string;
}

/** Notification title (spec §8.7, exact copy). */
export const REMINDER_TITLE = 'Your cards are ready';

/**
 * The body of a reminder on a day the learner ALREADY studied (spec §8.7,
 * exact copy). It names no streak: see `reminderContent`.
 */
export const REMINDER_STUDIED_BODY = 'You studied today. A few more minutes helps you remember.';

/**
 * The reminder text (spec §8.7, exact copy). There are no card counts in the
 * text: they would be old when it fires.
 *   - studied that day already → "You studied today. A few more minutes helps you remember."
 *   - streak ≥ 2               → "A few minutes keeps your 12-day streak."
 *   - otherwise                → "A few minutes today starts a new streak."
 *
 * `studiedThatDay`: the learner already studied on the day the reminder
 * fires. This happens only when "Skip days when I already studied" is OFF:
 * then today's reminder stays after a session. WHY a text of its own
 * (release pass 2026-11-02, C1-2): after a session the streak is already
 * counted for that day, so more study neither keeps it nor starts a new
 * one. The old text said "A few minutes today starts a new streak." to a
 * learner whose 1-day streak was that very day.
 *
 *   reminderContent(12).body       → 'A few minutes keeps your 12-day streak.'
 *   reminderContent(1).body        → 'A few minutes today starts a new streak.'
 *   reminderContent(1, true).body  → 'You studied today. A few more minutes helps you remember.'
 */
export function reminderContent(streakDays: number, studiedThatDay = false): ReminderContent {
  let body: string;
  if (studiedThatDay) body = REMINDER_STUDIED_BODY;
  else if (Number.isFinite(streakDays) && streakDays >= 2) body = `A few minutes keeps your ${Math.floor(streakDays)}-day streak.`;
  else body = 'A few minutes today starts a new streak.';
  return { title: REMINDER_TITLE, body };
}

/** The parts of `Person` that decide whether a streak is still alive. */
export interface StreakSnapshot {
  streak: number;
  lastStudyDay: string | null;
  freezes: number;
}

/**
 * The streak that studying on `dayKey` would still continue, when the learner
 * does NOT study before that day. 0 = the streak is already broken by then.
 *
 * It follows the same rule as `rollStreak()` in src/store/tally.ts:
 *   - last study day = that day or the day before → the streak is alive;
 *   - last study day = two days before, and a freeze is left → a freeze will
 *     bridge the missed day, so the streak is alive;
 *   - anything older → broken.
 *
 * WHY: we plan 14 reminders at once. Without this, the reminder in 5 days would
 * still say "keeps your 12-day streak", but the streak would be broken by then.
 */
export function streakAliveOn(person: StreakSnapshot, dayKey: string): number {
  const last = person.lastStudyDay;
  if (!last) return 0;
  if (last === dayKey || last === addDays(dayKey, -1)) return person.streak;
  if (last === addDays(dayKey, -2) && person.freezes > 0) return person.streak;
  return 0;
}

/**
 * True when the learner already studied on `dayKey` ('YYYY-MM-DD'): the last
 * study day IS that day. Only a reminder for TODAY can be on such a day (the
 * plan starts today), and only while "Skip days when I already studied" is
 * off (`planReminders` drops today otherwise).
 */
export function studiedOn(person: Pick<StreakSnapshot, 'lastStudyDay'>, dayKey: string): boolean {
  return !!person.lastStudyDay && person.lastStudyDay === dayKey;
}

/**
 * The text of the reminder that fires at `date`, for this learner: the
 * streak that is still alive on that day (`streakAliveOn`), and whether the
 * learner already studied on that day (`studiedOn`).
 */
export function reminderContentFor(date: Date, person: StreakSnapshot): ReminderContent {
  const day = dayKeyOf(date.getTime());
  return reminderContent(streakAliveOn(person, day), studiedOn(person, day));
}
