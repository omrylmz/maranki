/**
 * Tests for the daily-allowance + streak accounting (audit H3, M3, L10).
 */
import { describe, expect, test } from '@jest/globals';

import { addDays, DayDone, Person } from '../domain/types';
import { rollStreak, tallyReview, untallyReview } from './tally';

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
