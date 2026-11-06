/**
 * Pure deck-deletion resolution — the authoritative no-orphan invariant
 * (spec §3.12 "No-orphan deck delete"), on the v3 note model.
 *
 * `deleteDeck` used to honour a `move` strategy blindly: it reassigned every
 * card to `targetDeckId` with no check that the target actually exists. A stale
 * or empty id (e.g. the editor's `moveTarget` default of `''` when there are no
 * other decks) silently stranded the cards under a dead deckId — gone from the
 * active pool, unstudiable, invisible. Pulling the decision into a tested pure
 * function makes "every surviving card has a real home deck" a property of the
 * data layer, not a hope about what the dialog passes in.
 *
 * v3 (W3-1): the text of a card lives in its NOTE. So 'delete' also removes
 * every note that LOST its cards in this deletion and has no card left (an
 * item with no card is invisible in every list). A note that had no cards
 * before is not touched: it is not in this deck (checkIntegrity keeps such
 * notes, spec §3.5). The deck's image folder is removed by the caller after
 * the save commits — this file only decides the new lists.
 */
import { makeDeck, nextDeckOrder } from '../domain/makeV3';
import type { Card, Deck, DeckV2, Id, Note } from '../domain/types';

export type DeleteStrategy =
  | { kind: 'delete' }
  | { kind: 'move'; targetDeckId: string }
  | { kind: 'keep' };

/** The on-demand home for cards whose deck was removed without a move target. */
export const UNFILED_DECK_ID = 'unfiled';
/** The name of the Unfiled deck. */
export const UNFILED_DECK_NAME = 'Unfiled cards';
/** The emoji of the Unfiled deck. */
export const UNFILED_DECK_ICON = '🗃️';

/**
 * The v3 "Unfiled cards" deck. `decks` = the decks it joins: it is placed
 * after all of them (`order`), so it shows last in the deck lists.
 *
 *   unfiledDeck(now, state.decks) → { id: 'unfiled', name: 'Unfiled cards', icon: '🗃️', order: <last + 1>, … }
 */
export function unfiledDeck(now: number, decks: readonly Pick<Deck, 'order'>[] = []): Deck {
  return makeDeck(
    {
      id: UNFILED_DECK_ID,
      name: UNFILED_DECK_NAME,
      icon: UNFILED_DECK_ICON,
      active: true,
      order: nextDeckOrder(decks),
      source: 'manual',
    },
    now,
  );
}

/**
 * The schema-2 "Unfiled cards" deck. Only the v2 `sanitize` of the migration
 * (src/store/migrate.ts) uses it, for an old document whose card has no deck.
 */
export function unfiledDeckV2(now: number): DeckV2 {
  return {
    id: UNFILED_DECK_ID,
    name: UNFILED_DECK_NAME,
    icon: UNFILED_DECK_ICON,
    builtin: false,
    active: true,
    createdAt: now,
  };
}

/** The lists a deck deletion changes. */
export interface DeckDeletion {
  decks: Deck[];
  cards: Card[];
  notes: Note[];
}

/**
 * Resolve a deck deletion to the next { decks, cards, notes }. Never orphans a card:
 *
 *  - delete: drop the deck and every card in it, and every note whose cards
 *            were all in it (the note has no card left).
 *  - move:   honoured ONLY if the target is a real, surviving deck; otherwise it
 *            degrades to `keep` (an invalid/empty/self target can't strand cards).
 *  - keep:   the deck goes, its cards survive in an on-demand "Unfiled" deck.
 *
 * A deck with NO cards: every strategy only removes the deck. No card moves,
 * so no "Unfiled cards" deck is made for it (an empty Unfiled deck would
 * appear for nothing).
 *
 * A list that does not change is returned as the SAME array — `cards` and
 * `notes` too, when the deck had no card. The row store compares rows by
 * identity, and the selectors cache their results on the `cards` array, so
 * an unchanged list writes nothing and recounts nothing.
 * `now` is injected (not read from the clock) so the function stays pure/testable.
 *
 * Example: deck 'a' has the note n1 (cards c1, c2):
 *   resolveDeckDeletion(state, 'a', { kind: 'delete' }, now)
 *   → decks without 'a', cards without c1 and c2, notes without n1.
 */
export function resolveDeckDeletion(
  state: DeckDeletion,
  deckId: string,
  strategy: DeleteStrategy,
  now: number,
): DeckDeletion {
  const decks = state.decks.filter((d) => d.id !== deckId);
  // No card in the deck: nothing to delete or to move (see the comment above).
  if (!state.cards.some((c) => c.deckId === deckId)) return { decks, cards: state.cards, notes: state.notes };

  if (strategy.kind === 'delete') {
    const cards: Card[] = [];
    const touched = new Set<Id>();
    for (const c of state.cards) {
      if (c.deckId === deckId) touched.add(c.noteId);
      else cards.push(c);
    }
    return { decks, cards, notes: notesStillUsed(state.notes, touched, cards) };
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
      notes: state.notes,
    };
  }

  // keep — and the move-fallback: reassign to the on-demand Unfiled deck.
  const withUnfiled = decks.some((d) => d.id === UNFILED_DECK_ID)
    ? decks
    : [...decks, unfiledDeck(now, decks)];
  return {
    decks: withUnfiled,
    cards: state.cards.map((c) =>
      c.deckId === deckId ? { ...c, deckId: UNFILED_DECK_ID } : c,
    ),
    notes: state.notes,
  };
}

/**
 * `notes` without the notes in `touched` (they lost cards) that have no card
 * left in `cards`. The same array when no note goes.
 */
function notesStillUsed(notes: Note[], touched: ReadonlySet<Id>, cards: readonly Card[]): Note[] {
  if (touched.size === 0) return notes;
  const withCards = new Set<Id>();
  for (const c of cards) if (touched.has(c.noteId)) withCards.add(c.noteId);
  const kept = notes.filter((n) => !touched.has(n.id) || withCards.has(n.id));
  return kept.length === notes.length ? notes : kept;
}
