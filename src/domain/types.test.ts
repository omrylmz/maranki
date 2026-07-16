/**
 * Runtime sanity for the core Card lifecycle. A card flows through the
 * lifecycle/display-state helpers purely on its SRS fields (reps, stepIndex,
 * intervalDays, due) — the front/back content is inert to scheduling. "due"
 * promotion and the buried gate (L13) are the load-bearing behaviors here.
 */
import { describe, expect, it } from '@jest/globals';

import { Card, displayState, lifecycleState } from './types';

const NOW = 1_700_000_000_000;

function makeCard(o: Partial<Card> & Pick<Card, 'id'>): Card {
  return {
    deckId: 'd',
    front: 'front',
    back: 'back',
    ease: 2.5,
    intervalDays: 0,
    stepIndex: null,
    reps: 0,
    lapses: 0,
    due: NOW,
    createdAt: NOW,
    lastReviewedAt: null,
    ...o,
  };
}

describe('lifecycleState / displayState', () => {
  it('a brand-new card has lifecycle/display state "new"', () => {
    const c = makeCard({ id: 'new', reps: 0 });
    expect(lifecycleState(c)).toBe('new');
    expect(displayState(c, NOW)).toBe('new');
  });

  it('a reviewed card resolves to "due" when overdue', () => {
    const c = makeCard({
      id: 'due',
      reps: 3,
      stepIndex: null,
      intervalDays: 5,
      due: NOW - 1,
      lastReviewedAt: NOW - 1,
    });
    // lifecycle is "review"; display promotes overdue review cards to "due".
    expect(lifecycleState(c)).toBe('review');
    expect(displayState(c, NOW)).toBe('due');
  });
});

describe('displayState honours buriedUntil (L13)', () => {
  it('a buried-but-overdue card is NOT labelled "due"', () => {
    const card = makeCard({
      id: 'b',
      reps: 5,
      stepIndex: null,
      intervalDays: 10,
      due: NOW - 1000, // overdue
      buriedUntil: NOW + 1_000_000, // but buried until later
    });
    expect(displayState(card, NOW)).not.toBe('due');
  });

  it('an unburied overdue card still reads "due"', () => {
    const card = makeCard({ id: 'd', reps: 5, stepIndex: null, intervalDays: 10, due: NOW - 1000 });
    expect(displayState(card, NOW)).toBe('due');
  });
});
