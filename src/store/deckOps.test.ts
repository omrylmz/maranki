/**
 * The no-orphan invariant for deck deletion (H2). The load-bearing property:
 * after ANY deletion strategy, every surviving card's deckId still names a deck
 * that exists in the result — a card can never be stranded under a dead id.
 */
import { describe, expect, test } from '@jest/globals';

import { Card, Deck } from '../domain/types';
import { resolveDeckDeletion, UNFILED_DECK_ID } from './deckOps';

const NOW = 1_700_000_000_000;

function makeDeck(id: string, o: Partial<Deck> = {}): Deck {
  return {
    id,
    name: id.toUpperCase(),
    icon: '🗂️',
    builtin: false,
    active: true,
    createdAt: 0,
    ...o,
  };
}

function makeCard(id: string, deckId: string): Card {
  return {
    id,
    deckId,
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
  };
}

/** Every surviving card points at a deck that exists in the result. */
function noOrphans(result: { decks: Deck[]; cards: Card[] }): boolean {
  const ids = new Set(result.decks.map((d) => d.id));
  return result.cards.every((c) => ids.has(c.deckId));
}

const baseState = {
  decks: [makeDeck('a'), makeDeck('b')],
  cards: [makeCard('1', 'a'), makeCard('2', 'a'), makeCard('3', 'b')],
};

describe('resolveDeckDeletion', () => {
  test('delete: drops the deck and ALL its cards, leaving the rest intact', () => {
    const r = resolveDeckDeletion(baseState, 'a', { kind: 'delete' }, NOW);
    expect(r.decks.map((d) => d.id)).toEqual(['b']);
    expect(r.cards.map((c) => c.id)).toEqual(['3']); // a's cards gone
    expect(noOrphans(r)).toBe(true);
  });

  test('move to a valid deck: every card reassigned, none lost', () => {
    const r = resolveDeckDeletion(baseState, 'a', { kind: 'move', targetDeckId: 'b' }, NOW);
    expect(r.decks.map((d) => d.id)).toEqual(['b']);
    expect(r.cards.filter((c) => c.deckId === 'b').map((c) => c.id)).toEqual(['1', '2', '3']);
    expect(noOrphans(r)).toBe(true);
  });

  test('move to a NON-EXISTENT deck falls back to keep — cards are NOT orphaned', () => {
    const r = resolveDeckDeletion(baseState, 'a', { kind: 'move', targetDeckId: 'ghost' }, NOW);
    expect(r.decks.some((d) => d.id === UNFILED_DECK_ID)).toBe(true);
    expect(r.cards.filter((c) => c.deckId === UNFILED_DECK_ID).map((c) => c.id)).toEqual(['1', '2']);
    expect(r.cards.find((c) => c.id === '3')?.deckId).toBe('b'); // untouched
    expect(noOrphans(r)).toBe(true); // the bug: these used to point at 'ghost'
  });

  test('move with an empty-string target (the editor default) falls back to keep', () => {
    const r = resolveDeckDeletion(baseState, 'a', { kind: 'move', targetDeckId: '' }, NOW);
    expect(r.cards.filter((c) => c.deckId === UNFILED_DECK_ID).map((c) => c.id)).toEqual(['1', '2']);
    expect(noOrphans(r)).toBe(true);
  });

  test('move targeting the deck being deleted falls back to keep', () => {
    const r = resolveDeckDeletion(baseState, 'a', { kind: 'move', targetDeckId: 'a' }, NOW);
    expect(r.decks.some((d) => d.id === 'a')).toBe(false); // 'a' really is gone
    expect(r.cards.filter((c) => c.deckId === UNFILED_DECK_ID).map((c) => c.id)).toEqual(['1', '2']);
    expect(noOrphans(r)).toBe(true);
  });

  test('keep: removes the deck, survives its cards in an on-demand Unfiled deck', () => {
    const r = resolveDeckDeletion(baseState, 'a', { kind: 'keep' }, NOW);
    const unfiled = r.decks.find((d) => d.id === UNFILED_DECK_ID);
    expect(unfiled).toBeDefined();
    expect(unfiled?.createdAt).toBe(NOW); // injected clock, not Date.now()
    expect(r.cards.filter((c) => c.deckId === UNFILED_DECK_ID).map((c) => c.id)).toEqual(['1', '2']);
    expect(noOrphans(r)).toBe(true);
  });

  test('keep reuses an existing Unfiled deck instead of duplicating it', () => {
    const withUnfiled = {
      decks: [makeDeck('a'), makeDeck(UNFILED_DECK_ID), makeDeck('b')],
      cards: [makeCard('1', 'a'), makeCard('2', UNFILED_DECK_ID)],
    };
    const r = resolveDeckDeletion(withUnfiled, 'a', { kind: 'keep' }, NOW);
    expect(r.decks.filter((d) => d.id === UNFILED_DECK_ID)).toHaveLength(1);
    expect(r.cards.find((c) => c.id === '1')?.deckId).toBe(UNFILED_DECK_ID);
    expect(noOrphans(r)).toBe(true);
  });
});
