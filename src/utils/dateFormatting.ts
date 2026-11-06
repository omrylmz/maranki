/**
 * When a studied card comes back, in words — ONE rule for every screen
 * (wave 5i, release re-measure).
 *
 * WHY one rule: the same card showed two different numbers at the same
 * moment. The Library row said "Review · next 4d" and the CardSheet said
 * "Review · next in 3 days" (die Erfahrung). The row rounded the time left
 * (3.6 days → "4d"); the sheet counted local calendar days (3). Now both
 * forms come from `reviewWait`, so they can differ in WORDS, never in the
 * number:
 *
 *   short (Library row)   long (CardSheet)
 *   due                   due now
 *   next 10m              next in 10 minutes
 *   next 3h               next in 3 hours
 *   next 1d               next tomorrow
 *   next 4d               next in 4 days
 *   next 2mo              next in 2 months
 *   next 1.2y             next in 1.2 years
 *
 * The rule (`reviewWait`):
 *   - due <= now (or no due time)  → null: "due";
 *   - less than 1 hour left        → minutes, round(left / 1 min), at least 1;
 *   - later on the SAME local day  → hours, round(left / 1 h), at least 1;
 *   - else the LOCAL CALENDAR days between the two days (DST-safe: a day of
 *     23 or 25 hours still counts as one day). 23:30 → 01:00 the next day is
 *     1 day ("tomorrow"), not "in 2 hours": the card comes back tomorrow;
 *   - 30 days or more → months, round(days / 30); 365 days or more → years,
 *     round(days / 365, one decimal).
 *
 * Pure: no clock. The caller passes `now` (useNow() in a component).
 */
import { startOfLocalDay } from '../domain/schedule';
import { plural } from '../domain/text';
import { DAY, HOUR, MIN } from '../domain/types';

/** The unit of a wait. */
export type WaitUnit = 'minute' | 'hour' | 'day' | 'month' | 'year';

/** How long until a card comes back: a number and its unit ("4 days" = { n: 4, unit: 'day' }). */
export interface ReviewWait {
  n: number;
  unit: WaitUnit;
}

/** The letters of each unit in the short form: "10m", "3h", "4d", "2mo", "1.2y". */
const SHORT_UNIT: Readonly<Record<WaitUnit, string>> = { minute: 'm', hour: 'h', day: 'd', month: 'mo', year: 'y' };

/**
 * How long until `due`, seen at `now`, or null when the card is due (see the
 * rule in the file comment). Every due text of the app is made from this.
 *
 *   reviewWait(now + 10 * MIN, now)                        → { n: 10, unit: 'minute' }
 *   reviewWait(localTime('2026-06-11', '01:00'), localTime('2026-06-10', '23:30'))
 *                                                          → { n: 1, unit: 'day' }
 *   reviewWait(now - MIN, now)                             → null
 */
export function reviewWait(due: number, now: number): ReviewWait | null {
  if (!Number.isFinite(due) || !Number.isFinite(now) || due <= now) return null;
  const left = due - now;
  if (left < HOUR) return { n: Math.max(1, Math.round(left / MIN)), unit: 'minute' };
  const days = Math.round((startOfLocalDay(due) - startOfLocalDay(now)) / DAY);
  if (days <= 0) return { n: Math.max(1, Math.round(left / HOUR)), unit: 'hour' };
  if (days < 30) return { n: days, unit: 'day' };
  if (days < 365) return { n: Math.round(days / 30), unit: 'month' };
  return { n: Math.round((days / 365) * 10) / 10, unit: 'year' };
}

/**
 * The short form, for a Library row: "due", "next 10m", "next 4d", "next 2mo".
 *
 *   nextReviewShort(now + 4 * DAY, now) → 'next 4d'
 */
export function nextReviewShort(due: number, now: number): string {
  const wait = reviewWait(due, now);
  if (!wait) return 'due';
  return `next ${wait.n}${SHORT_UNIT[wait.unit]}`;
}

/**
 * The long form, for the CardSheet: "due now", "next in 10 minutes", "next
 * tomorrow", "next in 4 days", "next in 2 months". The number is the same as
 * in the short form (plural() for the word).
 *
 *   nextReviewLong(now + 4 * DAY, now) → 'next in 4 days'
 */
export function nextReviewLong(due: number, now: number): string {
  const wait = reviewWait(due, now);
  if (!wait) return 'due now';
  if (wait.unit === 'day' && wait.n === 1) return 'next tomorrow';
  return `next in ${plural(wait.n, wait.unit)}`;
}
