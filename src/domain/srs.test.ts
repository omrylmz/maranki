/**
 * Baseline characterization tests for the SM-2 + learning-steps engine.
 * These lock in the CURRENT correct behavior before the audit fixes land
 * (the Hard<Good monotonicity and stepIndex-clamp fixes arrive in a later
 * phase and extend this file).
 */
import { describe, expect, test } from '@jest/globals';

import {
  applyRating,
  formatDelay,
  formatIntervalDays,
  predictAll,
  stepLabel,
} from './srs';
import { Card, DAY, DEFAULT_SRS, HOUR, MIN } from './types';

const NOW = 1_700_000_000_000;

function mk(partial: Partial<Card> = {}): Card {
  return {
    id: 'c1',
    deckId: 'd1',
    front: 'front',
    back: 'back',
    ease: DEFAULT_SRS.startingEase,
    intervalDays: 0,
    stepIndex: null,
    reps: 0,
    lapses: 0,
    due: NOW,
    createdAt: NOW,
    lastReviewedAt: null,
    ...partial,
  };
}

describe('applyRating — new / learning cards', () => {
  test('new card + good advances to the next learning step (10m), not graduated', () => {
    const r = applyRating(mk(), 'good', DEFAULT_SRS, NOW);
    expect(r.stepIndex).toBe(1);
    expect(r.reps).toBe(1);
    expect(r.intervalDays).toBe(0);
    expect(r.due).toBe(NOW + 10 * MIN);
  });

  test('good through every learning step graduates at the graduating interval', () => {
    const afterFirst = applyRating(mk(), 'good', DEFAULT_SRS, NOW); // stepIndex 1
    const graduated = applyRating(afterFirst, 'good', DEFAULT_SRS, NOW);
    expect(graduated.stepIndex).toBeNull();
    expect(graduated.intervalDays).toBe(DEFAULT_SRS.graduatingIntervalDays);
    expect(graduated.due).toBe(NOW + DEFAULT_SRS.graduatingIntervalDays * DAY);
  });

  test('new card + again resets to the first step and keeps ease', () => {
    const r = applyRating(mk(), 'again', DEFAULT_SRS, NOW);
    expect(r.stepIndex).toBe(0);
    expect(r.ease).toBe(DEFAULT_SRS.startingEase);
    expect(r.due).toBe(NOW + DEFAULT_SRS.learningStepsMin[0] * MIN);
  });

  test('new card + easy jumps straight to the easy interval', () => {
    const r = applyRating(mk(), 'easy', DEFAULT_SRS, NOW);
    expect(r.stepIndex).toBeNull();
    expect(r.intervalDays).toBe(DEFAULT_SRS.easyIntervalDays);
  });
});

describe('applyRating — graduated review cards', () => {
  const review = () => mk({ reps: 5, stepIndex: null, intervalDays: 10, ease: 2.5 });

  test('again lapses: ease floored down, interval × lapseMultiplier, back to learning', () => {
    const r = applyRating(review(), 'again', DEFAULT_SRS, NOW);
    expect(r.ease).toBeCloseTo(2.3, 5);
    expect(r.intervalDays).toBe(5); // 10 * 0.5
    expect(r.stepIndex).toBe(0);
    expect(r.lapses).toBe(1);
  });

  test('good grows the interval by ease × modifier', () => {
    const r = applyRating(review(), 'good', DEFAULT_SRS, NOW);
    expect(r.ease).toBe(2.5);
    expect(r.intervalDays).toBe(25); // 10 * 2.5
  });

  test('hard nudges ease down and grows modestly', () => {
    const r = applyRating(review(), 'hard', DEFAULT_SRS, NOW);
    expect(r.ease).toBeCloseTo(2.35, 5);
    expect(r.intervalDays).toBe(12); // max(11, 10*1.2)
  });

  test('easy raises ease and applies the easy bonus', () => {
    const r = applyRating(review(), 'easy', DEFAULT_SRS, NOW);
    expect(r.ease).toBeCloseTo(2.65, 5);
    expect(r.intervalDays).toBe(34); // round(10 * 2.65 * 1.3)
  });

  test('ease never drops below the 1.3 floor', () => {
    const r = applyRating(mk({ reps: 9, stepIndex: null, intervalDays: 8, ease: 1.3 }), 'again', DEFAULT_SRS, NOW);
    expect(r.ease).toBe(1.3);
  });
});

describe('formatDelay / formatIntervalDays', () => {
  test('sub-hour rounds to whole minutes (never below 1)', () => {
    expect(formatDelay(60_000)).toBe('1m');
    expect(formatDelay(30_000)).toBe('1m');
    expect(formatDelay(3_599_000)).toBe('60m');
  });
  test('hours, days, months, years', () => {
    expect(formatDelay(HOUR)).toBe('1h');
    expect(formatDelay(DAY)).toBe('1d');
    expect(formatDelay(45 * DAY)).toBe('2mo');
    expect(formatDelay(400 * DAY)).toBe('1.1y');
  });
  test('formatIntervalDays renders day counts', () => {
    expect(formatIntervalDays(6)).toBe('6d');
  });
});

describe('predictAll / stepLabel', () => {
  test('again always reads "soon"', () => {
    expect(predictAll(mk(), DEFAULT_SRS).again).toBe('soon');
  });
  test('stepLabel reflects current learning progress', () => {
    const learning = mk({ reps: 1, stepIndex: 0 });
    expect(stepLabel(learning, DEFAULT_SRS)).toBe('1/2 · 1m → 10m');
  });
  test('stepLabel is null for a brand-new or graduated card', () => {
    expect(stepLabel(mk(), DEFAULT_SRS)).toBeNull();
    expect(stepLabel(mk({ reps: 3, stepIndex: null }), DEFAULT_SRS)).toBeNull();
  });
});

describe('M10: a requeued "Again" card must predict from its POST-lapse state', () => {
  test('after a lapse the card is in relearning and its predictions change', () => {
    // session.tsx re-enters an "Again" card with applyRating(card,'again',…) so
    // its on-screen predictions reflect the lapse. This pins WHY: the post-lapse
    // card predicts differently from the pre-rating one.
    const review = mk({ reps: 8, stepIndex: null, intervalDays: 30, ease: 2.5, due: NOW - DAY });
    const before = predictAll(review, DEFAULT_SRS);
    const relapsed = applyRating(review, 'again', DEFAULT_SRS, NOW);
    const after = predictAll(relapsed, DEFAULT_SRS);
    expect(review.stepIndex).toBeNull(); // pre: a graduated review card
    expect(relapsed.stepIndex).toBe(0); // post: back in relearning
    expect(relapsed.lapses).toBe(review.lapses + 1);
    expect(after.good).not.toBe(before.good); // so its "Good" prediction differs
  });
});

describe('L11: Hard interval stays strictly below Good', () => {
  test('a small-interval low-ease card no longer collapses Hard === Good', () => {
    const card = mk({ reps: 5, stepIndex: null, intervalDays: 1, ease: 1.3 });
    const hard = applyRating(card, 'hard', DEFAULT_SRS, NOW);
    const good = applyRating(card, 'good', DEFAULT_SRS, NOW);
    expect(hard.intervalDays).toBeLessThan(good.intervalDays);
  });

  test('the ordering also holds at a large interval', () => {
    const card = mk({ reps: 8, stepIndex: null, intervalDays: 30, ease: 2.5 });
    const hard = applyRating(card, 'hard', DEFAULT_SRS, NOW);
    const good = applyRating(card, 'good', DEFAULT_SRS, NOW);
    expect(hard.intervalDays).toBeLessThan(good.intervalDays);
  });
});

describe('L12: an out-of-range persisted stepIndex is clamped', () => {
  test('a card stranded past a shrunk steps list lands on a valid step', () => {
    const shrunk = { ...DEFAULT_SRS, learningStepsMin: [1, 10] }; // only 2 steps now
    const stranded = mk({ reps: 2, stepIndex: 3, intervalDays: 0 }); // index 3 no longer exists
    const r = applyRating(stranded, 'hard', shrunk, NOW); // hard repeats the (clamped) step
    expect(r.stepIndex).toBe(1); // last valid index, not the stale 3
  });
});
