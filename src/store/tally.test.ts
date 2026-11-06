/**
 * Tests for the daily-allowance + streak accounting (audit H3, M3, L10), and
 * the v3 buckets (W3-1, spec §3.6): 'new' → neww + newByDeck[deck],
 * 'review' → reviews, 'check' → checks; undo is the exact inverse.
 */
import { describe, expect, test } from '@jest/globals';

import { addDays, DayDone, Person, ReviewBucket } from '../domain/types';
import { attributionDay, emptyDayDone, rollStreak, tallyReview, untallyReview } from './tally';

const TODAY = '2026-06-30';
const day = (): DayDone => ({ dayKey: TODAY, reviews: 5, neww: 2, checks: 1, newByDeck: { d1: 2 } });

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

// H3 (practice and cram count in no budget) is decided before the tally, in
// reducer.ts rateCard: reducer.test.ts "practice writes nothing (H3)".
describe('tallyReview', () => {
  test('a NEW card consumes the new budget only', () => {
    const r = tallyReview(day(), { wasNew: true });
    expect(r.neww).toBe(3);
    expect(r.reviews).toBe(5); // not bumped — the M3 fix
  });

  test('a review/learning card consumes the review budget only', () => {
    const r = tallyReview(day(), { wasNew: false });
    expect(r.reviews).toBe(6);
    expect(r.neww).toBe(2);
  });
});

describe('untallyReview', () => {
  const tally = (reviews: number, neww: number): DayDone => ({ ...emptyDayDone(TODAY), reviews, neww });

  test('mirrors tallyReview and clamps at zero', () => {
    expect(untallyReview(tally(1, 1), { wasNew: false }).reviews).toBe(0);
    expect(untallyReview(tally(0, 0), { wasNew: true }).neww).toBe(0);
    expect(untallyReview(tally(3, 3), { wasNew: true })).toEqual({
      dayKey: TODAY,
      reviews: 3,
      neww: 2,
      checks: 0,
      newByDeck: {},
    });
  });
});

describe('the v3 buckets (spec §3.6)', () => {
  test("'new' counts in neww AND in its deck's newByDeck — never in reviews (M3)", () => {
    const r = tallyReview(day(), { bucket: 'new', deckId: 'd1' });
    expect(r).toEqual({ dayKey: TODAY, reviews: 5, neww: 3, checks: 1, newByDeck: { d1: 3 } });
    const other = tallyReview(r, { bucket: 'new', deckId: 'd2' });
    expect(other.newByDeck).toEqual({ d1: 3, d2: 1 });
    expect(other.neww).toBe(4);
  });

  test("'review' counts in reviews only; 'check' counts in checks only", () => {
    expect(tallyReview(day(), { bucket: 'review', deckId: 'd1' })).toEqual({ ...day(), reviews: 6 });
    expect(tallyReview(day(), { bucket: 'check', deckId: 'd1' })).toEqual({ ...day(), checks: 2 });
  });

  test('rate, then undo, gives back the very same tally — for every bucket', () => {
    const buckets: ReviewBucket[] = ['new', 'review', 'check'];
    for (const bucket of buckets) {
      for (const start of [day(), emptyDayDone(TODAY)]) {
        const opts = { bucket, deckId: 'd7' };
        expect(untallyReview(tallyReview(start, opts), opts)).toEqual(start);
      }
    }
  });

  test('undo never goes below zero, and a newByDeck entry that comes back to 0 is removed', () => {
    const one = tallyReview(emptyDayDone(TODAY), { bucket: 'new', deckId: 'd1' });
    expect(one.newByDeck).toEqual({ d1: 1 });
    const back = untallyReview(one, { bucket: 'new', deckId: 'd1' });
    expect(back.newByDeck).toEqual({});
    expect('d1' in back.newByDeck).toBe(false);
    const zero = untallyReview(back, { bucket: 'new', deckId: 'd1' });
    expect(zero).toEqual(emptyDayDone(TODAY));
    expect(untallyReview(emptyDayDone(TODAY), { bucket: 'check', deckId: 'd1' }).checks).toBe(0);
    expect(untallyReview(emptyDayDone(TODAY), { bucket: 'review', deckId: 'd1' }).reviews).toBe(0);
  });

  test('the input tally is never changed', () => {
    const d = day();
    const frozen = JSON.stringify(d);
    tallyReview(d, { bucket: 'new', deckId: 'd1' });
    untallyReview(d, { bucket: 'new', deckId: 'd1' });
    expect(JSON.stringify(d)).toBe(frozen);
  });

  test('a deck id "__proto__" is counted like any other deck (no spread loses it)', () => {
    const r = tallyReview(emptyDayDone(TODAY), { bucket: 'new', deckId: '__proto__' });
    expect(Object.keys(r.newByDeck)).toEqual(['__proto__']);
    expect(Object.getOwnPropertyDescriptor(r.newByDeck, '__proto__')?.value).toBe(1);
    const again = tallyReview(r, { bucket: 'new', deckId: '__proto__' });
    expect(Object.getOwnPropertyDescriptor(again.newByDeck, '__proto__')?.value).toBe(2);
    expect(Object.keys(untallyReview(again, { bucket: 'new', deckId: '__proto__' }).newByDeck)).toEqual(['__proto__']);
  });

  test('the v2 form (wasNew) still works: new without a deck leaves newByDeck alone', () => {
    const r = tallyReview(day(), { wasNew: true });
    expect(r).toEqual({ ...day(), neww: 3 });
    expect(tallyReview(day(), { wasNew: true, deckId: 'd1' }).newByDeck).toEqual({ d1: 3 });
  });

  test('a tally from an older shape (no checks, no newByDeck) gets both counters', () => {
    const old = { dayKey: TODAY, reviews: 1, neww: 1 } as DayDone;
    expect(tallyReview(old, { bucket: 'check', deckId: 'd1' })).toEqual({ dayKey: TODAY, reviews: 1, neww: 1, checks: 1, newByDeck: {} });
    expect(tallyReview(old, { bucket: 'new', deckId: 'd1' }).newByDeck).toEqual({ d1: 1 });
  });

  test('emptyDayDone is a zero day with every v3 counter', () => {
    expect(emptyDayDone(TODAY)).toEqual({ dayKey: TODAY, reviews: 0, neww: 0, checks: 0, newByDeck: {} });
  });

  test('an unknown bucket (a damaged review-log entry) changes no counter, and the result is still a day tally', () => {
    // The W3-1 hardening: the switch had no default branch, so this returned
    // undefined, and the undo wrote `person.dayDone = undefined`.
    for (const bucket of [undefined, 'later', null] as unknown as ReviewBucket[]) {
      expect(untallyReview(day(), { bucket, deckId: 'd1' })).toEqual(day());
      expect(tallyReview(day(), { bucket, deckId: 'd1' })).toEqual(day());
    }
    expect(untallyReview(emptyDayDone(TODAY), { bucket: undefined as unknown as ReviewBucket, deckId: 'd1' }).dayKey).toBe(TODAY);
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
