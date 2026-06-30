/**
 * Pure daily-allowance + streak accounting, extracted from DataContext so the
 * budget math is testable. Fixes the audit's accounting cluster:
 *   - H3: cram ("free practice") must not touch the day's tallies.
 *   - M3: a NEW card consumes the NEW budget only, not the review budget — every
 *     rating used to bump `reviews`, so new-card study silently ate the daily
 *     review allowance and double-counted on the goal bars.
 *   - L10: the +10 daily-streak XP is paid once per day — rollStreak reports
 *     whether THIS session is the day's first.
 */
import { MAX_FREEZES } from '../domain/gamification';
import { addDays, DayDone, Person } from '../domain/types';

/** The day's tallies after rating one card. */
export function tallyReview(
  dayDone: DayDone,
  opts: { wasNew: boolean; writeSchedule: boolean },
): DayDone {
  // Cram is free practice — it changes neither budget.
  if (!opts.writeSchedule) return dayDone;
  return {
    ...dayDone,
    reviews: dayDone.reviews + (opts.wasNew ? 0 : 1),
    neww: dayDone.neww + (opts.wasNew ? 1 : 0),
  };
}

/** Inverse of one tallyReview, for undo. Never drops below zero. */
export function untallyReview(dayDone: DayDone, opts: { wasNew: boolean }): DayDone {
  return {
    ...dayDone,
    reviews: Math.max(0, dayDone.reviews - (opts.wasNew ? 0 : 1)),
    neww: Math.max(0, dayDone.neww - (opts.wasNew ? 1 : 0)),
  };
}

export interface StreakRoll {
  streak: number;
  freezes: number;
  freezeUsedDays: string[];
  /** True only on the day's FIRST session — gates the once-per-day streak XP. */
  advanced: boolean;
}

/**
 * Advance the streak for today's first session. A freeze bridges a single
 * missed day (yesterday). A second same-day session returns advanced:false with
 * the streak unchanged, so the streak XP bonus is not paid twice in one day.
 */
export function rollStreak(person: Person, today: string): StreakRoll {
  if (person.lastStudyDay === today) {
    return {
      streak: person.streak,
      freezes: person.freezes,
      freezeUsedDays: person.freezeUsedDays,
      advanced: false,
    };
  }
  const yesterday = addDays(today, -1);
  const dayBefore = addDays(today, -2);
  let streak = person.streak;
  let freezes = person.freezes;
  const freezeUsedDays = [...person.freezeUsedDays];
  if (person.lastStudyDay === yesterday) {
    streak += 1;
  } else if (person.lastStudyDay === dayBefore && freezes > 0) {
    freezes -= 1;
    freezeUsedDays.push(yesterday);
    streak += 1;
  } else {
    streak = 1;
  }
  // Reward a streak freeze at each 7-day milestone — the promise the settings
  // copy makes ("earn one at every 7-day milestone"). Capped (never reduces an
  // existing surplus from other sources) so freezes can't grow without bound (M13).
  if (streak % 7 === 0 && freezes < MAX_FREEZES) {
    freezes += 1;
  }
  return { streak, freezes, freezeUsedDays, advanced: true };
}
