/**
 * Runtime sanity for the PR #1 "Path A" type change: Card.level and Card.type
 * are now (CefrLevel | null) / (WordType | null). A card with null linguistics
 * must be a valid Card and must flow through the lifecycle/display-state
 * helpers unchanged — the nullness is purely "no metadata", not a broken card.
 */
import { describe, expect, it } from '@jest/globals';

import { Card, CefrLevel, displayState, lifecycleState, WordType } from './types';

const NOW = 1_700_000_000_000;

function makeCard(o: Partial<Card> & Pick<Card, 'id'>): Card {
  return {
    deckId: 'd',
    word: 'word',
    article: null,
    base: 'word',
    tr: 'translation',
    level: null,
    type: null,
    lang: 'es',
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

describe('Card with null linguistics (Path A)', () => {
  it('accepts null for level and type and reads them back as null', () => {
    // Documents the contract: null is a first-class value for these fields.
    const level: CefrLevel | null = null;
    const type: WordType | null = null;
    const c = makeCard({ id: 'imp', level, type });
    expect(c.level).toBeNull();
    expect(c.type).toBeNull();
  });

  it('a brand-new null-level card has lifecycle/display state "new"', () => {
    const c = makeCard({ id: 'new', level: null, type: null, reps: 0 });
    expect(lifecycleState(c)).toBe('new');
    expect(displayState(c, NOW)).toBe('new');
  });

  it('a reviewed null-level card still resolves to "due" when overdue', () => {
    const c = makeCard({
      id: 'due',
      level: null,
      type: null,
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

  it('a curated card still carries its real level and type', () => {
    const c = makeCard({ id: 'cur', level: 'A1', type: 'noun' });
    expect(c.level).toBe('A1');
    expect(c.type).toBe('noun');
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
