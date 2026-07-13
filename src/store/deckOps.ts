/**
 * Pure deck-deletion resolution — the authoritative no-orphan invariant.
 *
 * `deleteDeck` used to honour a `move` strategy blindly: it reassigned every
 * card to `targetDeckId` with no check that the target actually exists. A stale
 * or empty id (e.g. the editor's `moveTarget` default of `''` when there are no
 * other decks) silently stranded the cards under a dead deckId — gone from the
 * active pool, unstudiable, invisible. Pulling the decision into a tested pure
 * function makes "every surviving card has a real home deck" a property of the
 * data layer, not a hope about what the dialog passes in.
 */
import { Card, Deck } from '../domain/types';

export type DeleteStrategy =
  | { kind: 'delete' }
  | { kind: 'move'; targetDeckId: string }
  | { kind: 'keep' };

/** The on-demand home for cards whose deck was removed without a move target. */
export const UNFILED_DECK_ID = 'unfiled';

export function unfiledDeck(now: number): Deck {
  return {
    id: UNFILED_DECK_ID,
    name: 'Unfiled cards',
    icon: '🗃️',
    builtin: false,
    active: true,
    createdAt: now,
  };
}

/**
 * Resolve a deck deletion to the next { decks, cards }. Never orphans a card:
 *
 *  - delete: drop the deck and every card in it.
 *  - move:   honoured ONLY if the target is a real, surviving deck; otherwise it
 *            degrades to `keep` (an invalid/empty/self target can't strand cards).
 *  - keep:   the deck goes, its cards survive in an on-demand "Unfiled" deck.
 *
 * `now` is injected (not read from the clock) so the function stays pure/testable.
 */
export function resolveDeckDeletion(
  state: { decks: Deck[]; cards: Card[] },
  deckId: string,
  strategy: DeleteStrategy,
  now: number,
): { decks: Deck[]; cards: Card[] } {
  const decks = state.decks.filter((d) => d.id !== deckId);

  if (strategy.kind === 'delete') {
    return { decks, cards: state.cards.filter((c) => c.deckId !== deckId) };
  }

  // A move is valid only when the target is one of the SURVIVING decks. Since
  // `decks` already excludes the deleted deck, a self-target resolves to
  // undefined here and falls through to the keep path.
  const target =
    strategy.kind === 'move'
      ? decks.find((d) => d.id === strategy.targetDeckId)
      : undefined;

  if (target) {
    return {
      decks,
      cards: state.cards.map((c) => (c.deckId === deckId ? { ...c, deckId: target.id } : c)),
    };
  }

  // keep — and the move-fallback: reassign to the on-demand Unfiled deck.
  const withUnfiled = decks.some((d) => d.id === UNFILED_DECK_ID)
    ? decks
    : [...decks, unfiledDeck(now)];
  return {
    decks: withUnfiled,
    cards: state.cards.map((c) =>
      c.deckId === deckId ? { ...c, deckId: UNFILED_DECK_ID } : c,
    ),
  };
}
