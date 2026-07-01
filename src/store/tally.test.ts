/**
 * Tests for the daily-allowance + streak accounting (audit H3, M3, L10).
 */
import { describe, expect, test } from '@jest/globals';

import { addDays, DayDone, Person } from '../domain/types';
import { attributionDay, rollStreak, tallyReview, untallyReview } from './tally';

const TODAY = '2026-06-30';
const day = (): DayDone => ({ dayKey: TODAY, reviews: 5, neww: 2 });

function person(partial: Partial<Person> = {}): Person {
  return {
    xp: 0,
    streak: 3,
    bestStreak: 5,
    freezes: 0,
    freezeUsedDays: [],
    lastStudyDay: addDays(TODAY, -1),
    goalReviews: 20,
    goalNew: 10,
    dayDone: day(),
    fastAnswers: 0,
    achievements: {},
    ...partial,
  };
}

describe('tallyReview', () => {
  test('cram (writeSchedule:false) leaves both budgets untouched', () => {
    expect(tallyReview(day(), { wasNew: true, writeSchedule: false })).toEqual(day());
    expect(tallyReview(day(), { wasNew: false, writeSchedule: false })).toEqual(day());
  });

  test('a NEW card consumes the new budget only', () => {
    const r = tallyReview(day(), { wasNew: true, writeSchedule: true });
    expect(r.neww).toBe(3);
    expect(r.reviews).toBe(5); // not bumped — the M3 fix
  });

  test('a review/learning card consumes the review budget only', () => {
    const r = tallyReview(day(), { wasNew: false, writeSchedule: true });
    expect(r.reviews).toBe(6);
    expect(r.neww).toBe(2);
  });
});

describe('untallyReview', () => {
  test('mirrors tallyReview and clamps at zero', () => {
    expect(untallyReview({ dayKey: TODAY, reviews: 1, neww: 1 }, { wasNew: false }).reviews).toBe(0);
    expect(untallyReview({ dayKey: TODAY, reviews: 0, neww: 0 }, { wasNew: true }).neww).toBe(0);
    expect(untallyReview({ dayKey: TODAY, reviews: 3, neww: 3 }, { wasNew: true })).toEqual({
      dayKey: TODAY,
      reviews: 3,
      neww: 2,
    });
  });
});

describe('rollStreak', () => {
  test('a second session the same day does not advance (no double streak XP)', () => {
    const roll = rollStreak(person({ lastStudyDay: TODAY, streak: 4 }), TODAY);
    expect(roll.advanced).toBe(false);
    expect(roll.streak).toBe(4);
  });

  test('studying the day after yesterday increments the streak', () => {
    const roll = rollStreak(person({ lastStudyDay: addDays(TODAY, -1), streak: 4 }), TODAY);
    expect(roll.advanced).toBe(true);
    expect(roll.streak).toBe(5);
  });

  test('a freeze bridges a single missed day', () => {
    const roll = rollStreak(
      person({ lastStudyDay: addDays(TODAY, -2), streak: 4, freezes: 1 }),
      TODAY,
    );
    expect(roll.streak).toBe(5);
    expect(roll.freezes).toBe(0);
    expect(roll.freezeUsedDays).toContain(addDays(TODAY, -1));
  });

  test('a 2-day gap with no freeze resets the streak to 1', () => {
    const roll = rollStreak(
      person({ lastStudyDay: addDays(TODAY, -2), streak: 9, freezes: 0 }),
      TODAY,
    );
    expect(roll.streak).toBe(1);
  });

  test('a first-ever session starts the streak at 1', () => {
    const roll = rollStreak(person({ lastStudyDay: '', streak: 0 }), TODAY);
    expect(roll.streak).toBe(1);
    expect(roll.advanced).toBe(true);
  });
});

describe('attributionDay (cross-midnight / reconcile day attribution)', () => {
  // The completion instant falls on July 1, but the session's reviews happened
  // on June 30 (its study day). Attribution must follow the study day.
  const STUDY_DAY = '2026-06-30';
  const afterMidnight = new Date(2026, 6, 1, 0, 1).getTime(); // 2026-07-01 00:01 local

  test('uses the explicit study day when present, ignoring the completion instant', () => {
    expect(attributionDay(STUDY_DAY, afterMidnight)).toBe('2026-06-30');
  });

  test('falls back to the completion day only for a legacy marker with no study day', () => {
    expect(attributionDay(undefined, afterMidnight)).toBe('2026-07-01');
  });

  test('a session spanning midnight keeps the streak instead of resetting it', () => {
    // Studied every day through the 29th; the 30th's session finishes at 00:01.
    const p = person({ lastStudyDay: '2026-06-29', streak: 10, freezes: 0 });
    const byStudyDay = rollStreak(p, attributionDay(STUDY_DAY, afterMidnight));
    expect(byStudyDay.streak).toBe(11); // 29th → 30th, advanced
    // Attributing by the completion instant instead would have reset it:
    const byCompletionInstant = rollStreak(p, attributionDay(undefined, afterMidnight));
    expect(byCompletionInstant.streak).toBe(1);
  });

  test('a session spanning midnight does not burn a freeze for a day it studied', () => {
    const p = person({ lastStudyDay: '2026-06-29', streak: 10, freezes: 1 });
    const byStudyDay = rollStreak(p, attributionDay(STUDY_DAY, afterMidnight));
    expect(byStudyDay.freezes).toBe(1); // freeze intact
    expect(byStudyDay.freezeUsedDays).not.toContain('2026-06-30');
  });
});

describe('rollStreak grants a freeze at each 7-day milestone (M13)', () => {
  const yesterday = addDays(TODAY, -1);

  test('reaching a 7-day streak awards a freeze', () => {
    const roll = rollStreak(person({ streak: 6, lastStudyDay: yesterday, freezes: 0 }), TODAY);
    expect(roll.streak).toBe(7);
    expect(roll.freezes).toBe(1);
  });

  test('a non-milestone day grants nothing', () => {
    const roll = rollStreak(person({ streak: 7, lastStudyDay: yesterday, freezes: 0 }), TODAY);
    expect(roll.streak).toBe(8);
    expect(roll.freezes).toBe(0);
  });

  test('the grant is capped (never exceeds MAX_FREEZES = 3)', () => {
    const roll = rollStreak(person({ streak: 13, lastStudyDay: yesterday, freezes: 3 }), TODAY);
    expect(roll.streak).toBe(14); // a milestone
    expect(roll.freezes).toBe(3); // already at cap — not 4
  });
});
