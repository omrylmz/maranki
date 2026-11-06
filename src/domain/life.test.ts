/**
 * The lifecycle helper (spec §4.5). Tested on v3-shaped cards (the shared
 * constructor makeV3.makeCard, so the cards look exactly like cards the app
 * will make) and on today's v2 cards (test factories), because life.ts must
 * work on both until wave 3 switches the model.
 */
import { describe, expect, it } from '@jest/globals';

import { FIXED_NOW as NOW } from '../test/clock';
import { cardInState, makeCard as makeV2Card } from '../test/factories';
import { randomStateV3 } from '../test/factoriesV3';
import { createRandom } from '../test/random';
import { hasReviewDate, isBuried, isDueNow, isMastered, life, type LifeCard, LIFE_KEYS, LIFE_LABELS } from './life';
import { makeCard, makeNote, type MakeCardOpts } from './makeV3';
import type { Card, LifeKey } from './model';
import { DAY, DEFAULT_SRS, MASTERED_INTERVAL_DAYS, MIN } from './types';

const NOTE = makeNote({ id: 'n1', typeId: 'nt-basic', fields: ['die Stunde', 'the hour', '', ''] }, NOW);

/** A v3 card of NOTE, ord 0, in deck d1, with the given keys. */
function v3(opts: Omit<MakeCardOpts, 'id'> = {}): Card {
  return makeCard(NOTE, 0, 'd1', DEFAULT_SRS, NOW, { id: 'c1', ...opts });
}

/** SRS keys of each studied state (they fit together, like real cards). */
const LEARNING = { reps: 1, stepIndex: 0, intervalDays: 0, due: NOW + 10 * MIN, lastReviewedAt: NOW - MIN };
const REVIEW = { reps: 4, stepIndex: null, intervalDays: 6, due: NOW + 3 * DAY, lastReviewedAt: NOW - 3 * DAY };
const MASTERED = { reps: 9, stepIndex: null, intervalDays: 34, due: NOW + 20 * DAY, lastReviewedAt: NOW - 14 * DAY };

describe('life — v3 cards', () => {
  it('a fresh card is New (newState absent = queued)', () => {
    expect(life(v3())).toBe('new');
    expect(life(v3({ newState: 'queued' }))).toBe('new');
  });

  it("a never-studied card with newState 'notStarted' is Not started", () => {
    expect(life(v3({ newState: 'notStarted' }))).toBe('notStarted');
  });

  it('newState is read only while reps === 0', () => {
    // A studied card that still carries an old 'notStarted' value is not Not started.
    expect(life(v3({ ...REVIEW, newState: 'notStarted' }))).toBe('review');
  });

  it('learning, review and mastered follow the SRS fields', () => {
    expect(life(v3(LEARNING))).toBe('learning');
    expect(life(v3(REVIEW))).toBe('review');
    expect(life(v3(MASTERED))).toBe('mastered');
  });

  it('the mastered line is exactly 21 days', () => {
    expect(life(v3({ ...REVIEW, intervalDays: MASTERED_INTERVAL_DAYS - 1 }))).toBe('review');
    expect(life(v3({ ...REVIEW, intervalDays: MASTERED_INTERVAL_DAYS }))).toBe('mastered');
  });

  it('a lapsed card back in learning is Learning, even with a long old interval', () => {
    expect(life(v3({ ...MASTERED, stepIndex: 0 }))).toBe('learning');
  });

  it('Known wins over every other state', () => {
    expect(life(v3({ knownAt: NOW }))).toBe('known');
    expect(life(v3({ newState: 'notStarted', knownAt: NOW }))).toBe('known');
    expect(life(v3({ ...LEARNING, knownAt: NOW }))).toBe('known');
    expect(life(v3({ ...MASTERED, knownAt: NOW }))).toBe('known');
  });

  it('knownAt null means not Known', () => {
    expect(life(v3({ knownAt: null }))).toBe('new');
  });
});

describe('life — today\'s v2 cards (no knownAt / newState)', () => {
  it('matches the v2 lifecycle for every state', () => {
    expect(life(cardInState('new'))).toBe('new');
    expect(life(cardInState('learning'))).toBe('learning');
    expect(life(cardInState('review'))).toBe('review');
    expect(life(cardInState('mastered'))).toBe('mastered');
  });

  it('a v2 card is never Known or Not started', () => {
    expect(life(makeV2Card())).toBe('new');
  });
});

describe('isDueNow', () => {
  it('a review card whose time has come is due', () => {
    expect(isDueNow(v3({ ...REVIEW, due: NOW - DAY }), NOW)).toBe(true);
    expect(isDueNow(v3({ ...REVIEW, due: NOW }), NOW)).toBe(true);
  });

  it('learning and mastered cards are due when their time has come', () => {
    expect(isDueNow(v3({ ...LEARNING, due: NOW - MIN }), NOW)).toBe(true);
    expect(isDueNow(v3({ ...MASTERED, due: NOW - MIN }), NOW)).toBe(true);
  });

  it('a card due later is not due now', () => {
    expect(isDueNow(v3(REVIEW), NOW)).toBe(false);
  });

  it('New, Not started and Known cards are never due', () => {
    expect(isDueNow(v3({ due: NOW - DAY }), NOW)).toBe(false);
    expect(isDueNow(v3({ newState: 'notStarted', due: NOW - DAY }), NOW)).toBe(false);
    expect(isDueNow(v3({ ...REVIEW, due: NOW - DAY, knownAt: NOW - 2 * DAY }), NOW)).toBe(false);
  });

  it('suspended and buried cards are not due', () => {
    const overdue = { ...REVIEW, due: NOW - DAY };
    expect(isDueNow(v3({ ...overdue, suspended: true }), NOW)).toBe(false);
    expect(isDueNow(v3({ ...overdue, buriedUntil: NOW + DAY }), NOW)).toBe(false);
  });

  it('a bury that has ended does not block', () => {
    expect(isDueNow(v3({ ...REVIEW, due: NOW - DAY, buriedUntil: NOW - MIN }), NOW)).toBe(true);
  });

  it('works on v2 cards', () => {
    expect(isDueNow(cardInState('review', { due: NOW - DAY }), NOW)).toBe(true);
    expect(isDueNow(cardInState('new', { due: NOW - DAY }), NOW)).toBe(false);
  });
});

describe('hasReviewDate — exactly the statuses Learning, Review and Mastered (final pass: the "Due date" sort)', () => {
  /** The statuses that have a real next review (life.ts hasReviewDate). */
  const WITH_DATE: readonly LifeKey[] = ['learning', 'review', 'mastered'];
  const ruleOfLife = (card: LifeCard) => WITH_DATE.includes(life(card));

  it('a studied card has a review date; New, Not started and Known cards have none', () => {
    expect(hasReviewDate(v3(LEARNING))).toBe(true);
    expect(hasReviewDate(v3(REVIEW))).toBe(true);
    expect(hasReviewDate(v3(MASTERED))).toBe(true);
    expect(hasReviewDate(v3())).toBe(false); // New: its `due` is the time it was made
    expect(hasReviewDate(v3({ newState: 'notStarted' }))).toBe(false);
    expect(hasReviewDate(v3({ knownAt: NOW }))).toBe(false);
    expect(hasReviewDate(v3({ ...REVIEW, knownAt: NOW }))).toBe(false); // studied, then "I know it"
    expect(hasReviewDate(v3({ ...REVIEW, knownAt: null }))).toBe(true); // "Learn" again: back to its schedule
    // Today's v2 cards (no knownAt key).
    expect(hasReviewDate(cardInState('review'))).toBe(true);
    expect(hasReviewDate(makeV2Card())).toBe(false);
  });

  it('agrees with life() on every card of 300 random libraries, each also marked Known, un-Known and never studied', () => {
    let checked = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const state = randomStateV3(createRandom(`review-date-${seed}`), { now: NOW });
      for (const card of state.cards) {
        // The card itself, and the changes that move a card between the two groups.
        for (const c of [card, { ...card, knownAt: NOW }, { ...card, knownAt: null }, { ...card, reps: 0 }, { ...card, reps: 1 }]) {
          expect([seed, card.id, hasReviewDate(c)]).toEqual([seed, card.id, ruleOfLife(c)]);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });

  it('agrees with life() on odd values too (damaged data): every mix of reps, knownAt, stepIndex, interval and newState', () => {
    const odd = <T>(value: unknown) => value as T;
    let checked = 0;
    for (const reps of [0, 1, 5, -1, Number.NaN, odd<number>('0'), odd<number>(undefined)]) {
      for (const knownAt of [undefined, null, 0, NOW, Number.NaN]) {
        for (const stepIndex of [null, 0, 2]) {
          for (const intervalDays of [0, 6, MASTERED_INTERVAL_DAYS, Number.NaN]) {
            for (const newState of [undefined, 'queued', 'notStarted'] as const) {
              const card: LifeCard = { reps, knownAt, stepIndex, intervalDays, newState, due: NOW };
              expect([card, hasReviewDate(card)]).toEqual([card, ruleOfLife(card)]);
              checked += 1;
            }
          }
        }
      }
    }
    expect(checked).toBe(7 * 5 * 3 * 4 * 3);
  });

  it('isDueNow uses it: a card with no review date is never due, whatever its `due`', () => {
    expect(isDueNow(v3({ due: NOW - 30 * DAY }), NOW)).toBe(false);
    expect(isDueNow(v3({ ...LEARNING, due: NOW - MIN }), NOW)).toBe(true);
  });
});

describe('isBuried', () => {
  it('is true only while buriedUntil is in the future', () => {
    expect(isBuried({ buriedUntil: NOW + 1 }, NOW)).toBe(true);
    expect(isBuried({ buriedUntil: NOW }, NOW)).toBe(false);
    expect(isBuried({ buriedUntil: null }, NOW)).toBe(false);
    expect(isBuried({}, NOW)).toBe(false);
  });
});

describe('isMastered', () => {
  it('is true for a mastered card', () => {
    expect(isMastered(v3(MASTERED))).toBe(true);
  });

  it('a Known card is NEVER mastered, whatever its interval', () => {
    expect(isMastered(v3({ knownAt: NOW }))).toBe(false);
    expect(isMastered(v3({ ...MASTERED, knownAt: NOW }))).toBe(false);
  });

  it('review, learning and new cards are not mastered', () => {
    expect(isMastered(v3(REVIEW))).toBe(false);
    expect(isMastered(v3(LEARNING))).toBe(false);
    expect(isMastered(v3())).toBe(false);
  });
});

describe('LIFE_KEYS and LIFE_LABELS', () => {
  it('lists the six statuses in the UI order, each with its glossary word', () => {
    expect(LIFE_KEYS.map((k) => LIFE_LABELS[k])).toEqual([
      'Not started',
      'New',
      'Learning',
      'Review',
      'Mastered',
      'Known',
    ]);
  });
});
