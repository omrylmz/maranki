/**
 * The no-orphan invariant for deck deletion (H2), on the v3 note model
 * (W3-1). The load-bearing properties:
 *   - after ANY deletion strategy, every surviving card's deckId still names
 *     a deck that exists in the result — a card can never be stranded under a
 *     dead id;
 *   - 'delete' also removes the notes left without cards (an item with no
 *     card is invisible), and only those;
 *   - 'keep' (and a move to a deck that does not exist) moves the cards to a
 *     real v3 "Unfiled cards" deck, at the end of the deck list.
 */
import { describe, expect, test } from '@jest/globals';

import { BUILTIN_TYPE_IDS } from '../domain/builtinTypes';
import { DEFAULT_DECK_OPTIONS } from '../domain/makeV3';
import { Card, Deck, Note } from '../domain/types';
import { makeDeckV3, noteWithCards } from '../test/factoriesV3';
import {
  DeckDeletion,
  resolveDeckDeletion,
  UNFILED_DECK_ICON,
  UNFILED_DECK_ID,
  UNFILED_DECK_NAME,
  unfiledDeck,
  unfiledDeckV2,
} from './deckOps';

const NOW = 1_700_000_000_000;

function deck(id: string, order: number): Deck {
  return makeDeckV3({ id, name: id.toUpperCase(), order });
}

/** A Basic note with one card, or a Basic + reverse note with two cards. */
function item(noteId: string, deckId: string, reverse = false) {
  return noteWithCards({
    deckId,
    typeId: reverse ? BUILTIN_TYPE_IDS.basicReverse : BUILTIN_TYPE_IDS.basic,
    note: { id: noteId },
    card: (ord) => ({ id: `${noteId}-c${ord}` }),
  });
}

/** Every surviving card points at a deck that exists in the result. */
function noOrphans(result: { decks: Deck[]; cards: Card[] }): boolean {
  const ids = new Set(result.decks.map((d) => d.id));
  return result.cards.every((c) => ids.has(c.deckId));
}

/** Every note in the result still has at least one card (no invisible item was made). */
function noEmptiedNotes(before: DeckDeletion, after: DeckDeletion): boolean {
  const had = new Set(before.cards.map((c) => c.noteId));
  const has = new Set(after.cards.map((c) => c.noteId));
  return after.notes.every((n) => !had.has(n.id) || has.has(n.id));
}

/** Decks a (n1: 1 card, n2: 2 cards) and b (n3: 1 card), and n4 with no card at all. */
function baseState(): DeckDeletion {
  const groups = [item('n1', 'a'), item('n2', 'a', true), item('n3', 'b')];
  const lonely: Note = item('n4', 'b').note; // a note with no cards (kept by checkIntegrity, spec §3.5)
  return {
    decks: [deck('a', 0), deck('b', 1)],
    cards: groups.flatMap((g) => g.cards),
    notes: [...groups.map((g) => g.note), lonely],
  };
}

describe('resolveDeckDeletion', () => {
  test('delete: drops the deck, ALL its cards and the notes left without cards; the rest keep their identity', () => {
    const state = baseState();
    const r = resolveDeckDeletion(state, 'a', { kind: 'delete' }, NOW);
    expect(r.decks.map((d) => d.id)).toEqual(['b']);
    expect(r.cards.map((c) => c.id)).toEqual(['n3-c0']); // a's cards gone
    expect(r.notes.map((n) => n.id)).toEqual(['n3', 'n4']); // n1 and n2 lost their cards
    expect(r.cards[0]).toBe(state.cards[3]);
    expect(r.notes[0]).toBe(state.notes[2]);
    expect(noOrphans(r)).toBe(true);
    expect(noEmptiedNotes(state, r)).toBe(true);
  });

  test('delete: a note that had no cards before is not removed (it is not in the deck)', () => {
    const state = baseState();
    const r = resolveDeckDeletion(state, 'b', { kind: 'delete' }, NOW);
    expect(r.notes.map((n) => n.id)).toEqual(['n1', 'n2', 'n4']);
  });

  test('delete: a note whose cards are split over two decks keeps its card in the other deck (and stays)', () => {
    const state = baseState();
    // Damaged data: n2's reverse card is in deck b (checkIntegrity would join them).
    const split = { ...state, cards: state.cards.map((c) => (c.id === 'n2-c1' ? { ...c, deckId: 'b' } : c)) };
    const r = resolveDeckDeletion(split, 'a', { kind: 'delete' }, NOW);
    expect(r.cards.map((c) => c.id)).toEqual(['n2-c1', 'n3-c0']);
    expect(r.notes.map((n) => n.id)).toEqual(['n2', 'n3', 'n4']);
  });

  test('delete: an empty deck changes no card and no note (the same arrays)', () => {
    const state = { ...baseState(), decks: [deck('a', 0), deck('b', 1), deck('empty', 2)] };
    const r = resolveDeckDeletion(state, 'empty', { kind: 'delete' }, NOW);
    expect(r.notes).toBe(state.notes);
    // The same ARRAY, not only equal cards: the selectors cache on it (W3-1 hardening).
    expect(r.cards).toBe(state.cards);
    expect(r.decks.map((d) => d.id)).toEqual(['a', 'b']);
  });

  test('keep or move of an empty deck: only the deck goes — the same cards and notes, and no empty Unfiled deck', () => {
    const state = { ...baseState(), decks: [deck('a', 0), deck('b', 1), deck('empty', 2)] };
    const strategies = [
      { kind: 'keep' },
      { kind: 'move', targetDeckId: 'b' },
      { kind: 'move', targetDeckId: 'ghost' }, // the keep fallback
    ] as const;
    for (const strategy of strategies) {
      const r = resolveDeckDeletion(state, 'empty', strategy, NOW);
      expect(r.cards).toBe(state.cards);
      expect(r.notes).toBe(state.notes);
      expect(r.decks.map((d) => d.id)).toEqual(['a', 'b']);
    }
  });

  test('a deck that HAS cards still gets new card arrays (delete, move, keep)', () => {
    const state = baseState();
    for (const strategy of [{ kind: 'delete' }, { kind: 'keep' }, { kind: 'move', targetDeckId: 'b' }] as const) {
      expect(resolveDeckDeletion(state, 'a', strategy, NOW).cards).not.toBe(state.cards);
    }
  });

  test('move to a valid deck: every card reassigned, none lost, no note removed', () => {
    const state = baseState();
    const r = resolveDeckDeletion(state, 'a', { kind: 'move', targetDeckId: 'b' }, NOW);
    expect(r.decks.map((d) => d.id)).toEqual(['b']);
    expect(r.cards.filter((c) => c.deckId === 'b').map((c) => c.id)).toEqual(['n1-c0', 'n2-c0', 'n2-c1', 'n3-c0']);
    expect(r.notes).toBe(state.notes);
    expect(noOrphans(r)).toBe(true);
  });

  test('move to a NON-EXISTENT deck falls back to keep — cards are NOT orphaned', () => {
    const state = baseState();
    const r = resolveDeckDeletion(state, 'a', { kind: 'move', targetDeckId: 'ghost' }, NOW);
    expect(r.decks.some((d) => d.id === UNFILED_DECK_ID)).toBe(true);
    expect(r.cards.filter((c) => c.deckId === UNFILED_DECK_ID).map((c) => c.id)).toEqual(['n1-c0', 'n2-c0', 'n2-c1']);
    expect(r.cards.find((c) => c.id === 'n3-c0')?.deckId).toBe('b'); // untouched
    expect(r.notes).toBe(state.notes);
    expect(noOrphans(r)).toBe(true); // the bug: these used to point at 'ghost'
  });

  test('move with an empty-string target (the editor default) falls back to keep', () => {
    const r = resolveDeckDeletion(baseState(), 'a', { kind: 'move', targetDeckId: '' }, NOW);
    expect(r.cards.filter((c) => c.deckId === UNFILED_DECK_ID)).toHaveLength(3);
    expect(noOrphans(r)).toBe(true);
  });

  test('move targeting the deck being deleted falls back to keep', () => {
    const r = resolveDeckDeletion(baseState(), 'a', { kind: 'move', targetDeckId: 'a' }, NOW);
    expect(r.decks.some((d) => d.id === 'a')).toBe(false); // 'a' really is gone
    expect(r.cards.filter((c) => c.deckId === UNFILED_DECK_ID)).toHaveLength(3);
    expect(noOrphans(r)).toBe(true);
  });

  test('keep: removes the deck; its cards survive in an on-demand v3 Unfiled deck, last in the list', () => {
    const state = baseState();
    const r = resolveDeckDeletion(state, 'a', { kind: 'keep' }, NOW);
    const unfiled = r.decks.find((d) => d.id === UNFILED_DECK_ID);
    expect(unfiled).toEqual({
      id: UNFILED_DECK_ID,
      name: 'Unfiled cards',
      icon: '🗃️',
      active: true,
      order: 2, // after deck b (order 1)
      source: 'manual',
      defaultTypeId: BUILTIN_TYPE_IDS.basic,
      options: { ...DEFAULT_DECK_OPTIONS },
      createdAt: NOW, // injected clock, not Date.now()
    });
    expect(r.cards.filter((c) => c.deckId === UNFILED_DECK_ID).map((c) => c.id)).toEqual(['n1-c0', 'n2-c0', 'n2-c1']);
    expect(r.notes).toBe(state.notes); // keep never removes a note
    expect(noOrphans(r)).toBe(true);
  });

  test('keep reuses an existing Unfiled deck instead of duplicating it', () => {
    const groups = [item('n1', 'a'), item('n2', UNFILED_DECK_ID)];
    const withUnfiled: DeckDeletion = {
      decks: [deck('a', 0), unfiledDeck(NOW, [deck('a', 0)]), deck('b', 2)],
      cards: groups.flatMap((g) => g.cards),
      notes: groups.map((g) => g.note),
    };
    const r = resolveDeckDeletion(withUnfiled, 'a', { kind: 'keep' }, NOW);
    expect(r.decks.filter((d) => d.id === UNFILED_DECK_ID)).toHaveLength(1);
    expect(r.cards.find((c) => c.id === 'n1-c0')?.deckId).toBe(UNFILED_DECK_ID);
    expect(noOrphans(r)).toBe(true);
  });

  test('never changes its input', () => {
    const state = baseState();
    const before = JSON.stringify(state);
    for (const strategy of [{ kind: 'delete' }, { kind: 'keep' }, { kind: 'move', targetDeckId: 'b' }] as const) {
      resolveDeckDeletion(state, 'a', strategy, NOW);
    }
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('the Unfiled deck', () => {
  test('v3: placed after every deck it joins (order), with the default options', () => {
    expect(unfiledDeck(NOW).order).toBe(0);
    expect(unfiledDeck(NOW, [{ order: 4 }, { order: 1 }]).order).toBe(5);
    expect(unfiledDeck(NOW)).toMatchObject({ id: UNFILED_DECK_ID, name: UNFILED_DECK_NAME, icon: UNFILED_DECK_ICON });
  });

  test('v2 (the v2 sanitize of the migration only): the schema-2 deck shape', () => {
    expect(unfiledDeckV2(NOW)).toEqual({
      id: UNFILED_DECK_ID,
      name: UNFILED_DECK_NAME,
      icon: UNFILED_DECK_ICON,
      builtin: false,
      active: true,
      createdAt: NOW,
    });
  });
});
