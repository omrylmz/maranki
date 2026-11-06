/**
 * The card-state commands of the note model (spec §3.6 "card state", §8.4
 * CardSheet, §8.5 Triage, unit W2-7). Pure, not wired yet: the v3 reducer
 * (W3-2) calls them; screens do not.
 *
 *   learn          Not started → New ("Learn", "Learn these", "In queue")
 *   markKnown      → Known ("I know it", "Mark as known")
 *   setNotStarted  → Not started, only for cards never studied ("Move back to Not started")
 *   resetProgress  → New again, progress and Known cleared ("Reset progress…")
 *   reschedule     due only; interval and ease stay ("Reschedule…")
 *   setFlags       favorite / flag / suspend toggles
 *
 * Every command changes ONLY the keys its rule names, and records one
 * ManualEdit with each changed card's `before` and `after` values (via
 * `editCards`, manualLog.ts). The reducer returns `result.edit.id` for the
 * snackbar "Undo"; `undoManualEdit` takes it back. Nothing here reads or
 * writes `reviewLog`, so a session undo always takes back the last rating.
 *
 * The statuses (glossary §1.2, `life()` in life.ts):
 *   Not started  reps 0 and newState 'notStarted'
 *   New          reps 0, not Not started
 *   Known        knownAt set (wins over everything)
 */
import { life } from './life';
import {
  type CardPlan,
  editCards,
  type EditResult,
  type NoteModelState,
  type OpCtx,
  type OpStep,
} from './manualLog';
import type { Card, CardPatch, Id } from './model';
import { plural } from './text';

/* --------------------------------------------------------------- learn */

export interface LearnInput {
  cardIds: readonly Id[];
  /**
   * true = these cards come FIRST in their deck's new-card feed (before every
   * other card of the deck), in their current order. Their never-studied
   * siblings move with them (siblings share one feed position). Default
   * false: they join the queue in deck order (spec §8.5 "joins the queue in
   * deck order").
   */
  first?: boolean;
}

/**
 * The new feed positions for `first`: per deck, the chosen New cards move in
 * front of every card of the deck, keeping their order. Returns card id →
 * new `newPos`.
 *
 * Siblings (cards of one note) share ONE feed position (spec §3.4 `newPos`).
 * So the position is given per NOTE: every never-studied card of the note in
 * that deck gets it, also a sibling that was not chosen (the CardSheet can
 * change one direction alone, §8.5). A studied card keeps its schedule, so
 * its feed position does not matter and it does not move.
 *
 * Example: a deck's cards have newPos 10 … 50; learning notes A (newPos 40)
 * and B (newPos 20) first gives B → 8 and A → 9 (both below 10, B still
 * before A). Learning only the "Front → Back" card of A gives its
 * "Back → Front" sibling the same position 9.
 */
function frontPositions(state: NoteModelState, chosenIds: ReadonlySet<Id>): Map<Id, number> {
  // The notes (per deck) that have a chosen card that is New after `learn`.
  const notesByDeck = new Map<Id, Set<Id>>();
  for (const c of state.cards) {
    if (!chosenIds.has(c.id) || c.reps !== 0) continue;
    const notes = notesByDeck.get(c.deckId) ?? new Set<Id>();
    notes.add(c.noteId);
    notesByDeck.set(c.deckId, notes);
  }
  const out = new Map<Id, number>();
  for (const [deckId, noteIds] of notesByDeck) {
    // The smallest feed position in the deck: the new positions go below it.
    let base = Infinity;
    for (const c of state.cards) {
      if (c.deckId === deckId && Number.isFinite(c.newPos) && c.newPos < base) base = c.newPos;
    }
    if (!Number.isFinite(base)) base = 0;
    // One position per note (all its never-studied cards in this deck), in
    // the notes' current feed order.
    const byNote = new Map<Id, { pos: number; cards: Card[] }>();
    for (const c of state.cards) {
      if (c.deckId !== deckId || !noteIds.has(c.noteId) || c.reps !== 0) continue;
      const group = byNote.get(c.noteId) ?? { pos: Infinity, cards: [] };
      group.cards.push(c);
      if (Number.isFinite(c.newPos)) group.pos = Math.min(group.pos, c.newPos);
      byNote.set(c.noteId, group);
    }
    const ordered = [...byNote.values()].sort((a, b) => a.pos - b.pos);
    ordered.forEach((group, i) => {
      for (const c of group.cards) out.set(c.id, base - ordered.length + i);
    });
  }
  return out;
}

/**
 * "Learn": put cards into the study queue.
 *   - Not started → New (newState 'queued').
 *   - Known → not Known any more (knownAt and knownCheckedAt cleared): the
 *     CardSheet's "In queue" segment calls learn on a Known card. A Known card
 *     that was studied before goes back to its old schedule.
 *   - A card already in the queue (New, Learning, Review …) does not change,
 *     except its feed position when `first` is set.
 *   - With `first`, a never-studied sibling that was not chosen gets the
 *     same new feed position (siblings share it) and NOTHING else: a Not
 *     started sibling stays Not started. It is recorded in the same edit (so
 *     Undo moves it back too), but not counted in "{n} cards added".
 */
export function learn<S extends NoteModelState>(state: S, input: LearnInput, ctx: OpCtx): OpStep<S, EditResult> {
  const chosen = new Set(input.cardIds);
  const front = input.first ? frontPositions(state, chosen) : new Map<Id, number>();
  return editCards(
    state,
    {
      cardIds: input.cardIds,
      followerIds: [...front.keys()].filter((id) => !chosen.has(id)),
      kind: 'learn',
      plan: (card): CardPlan => {
        // A sibling that only follows the note's new feed position.
        if (!chosen.has(card.id)) {
          const pos = front.get(card.id);
          return pos === undefined ? null : { newPos: pos };
        }
        const patch: CardPatch = {};
        if (card.knownAt != null) {
          patch.knownAt = null;
          patch.knownCheckedAt = null;
        }
        if (card.newState === 'notStarted') patch.newState = 'queued';
        const pos = front.get(card.id);
        if (pos !== undefined) patch.newPos = pos;
        return patch;
      },
      label: (n) => `${plural(n, 'card')} added to your queue`,
    },
    ctx,
  );
}

/* ----------------------------------------------------------- markKnown */

/**
 * "I know it": set `knownAt = now` and NOTHING else. The schedule, the feed
 * position and `newState` stay, so "In queue" (learn) or a missed Check can
 * bring the card back exactly as it was. A Known card is never "mastered"
 * (`isMastered` is false): you said you know it, the app has not tested it.
 * A card that is already Known keeps its first `knownAt`.
 */
export function markKnown<S extends NoteModelState>(
  state: S,
  input: { cardIds: readonly Id[] },
  ctx: OpCtx,
): OpStep<S, EditResult> {
  return editCards(
    state,
    {
      cardIds: input.cardIds,
      kind: 'known',
      plan: (card) => (card.knownAt != null ? null : { knownAt: ctx.now }),
      label: (n) => `${plural(n, 'card')} marked as known`,
    },
    ctx,
  );
}

/* ------------------------------------------------------- setNotStarted */

/**
 * "Move back to Not started": only for cards that were NEVER studied
 * (reps === 0). A studied card is skipped and counted in `skipped` ("others
 * are skipped and counted", spec §8.3), because Not started means "not in
 * your study queue yet" — a studied card has a schedule to keep.
 * A Known card that was never studied becomes Not started (Known is cleared).
 */
export function setNotStarted<S extends NoteModelState>(
  state: S,
  input: { cardIds: readonly Id[] },
  ctx: OpCtx,
): OpStep<S, EditResult> {
  return editCards(
    state,
    {
      cardIds: input.cardIds,
      kind: 'notStarted',
      plan: (card) =>
        card.reps > 0 ? 'skip' : { newState: 'notStarted', knownAt: null, knownCheckedAt: null },
      label: (n) => `${plural(n, 'card')} moved back to Not started`,
    },
    ctx,
  );
}

/* ------------------------------------------------------- resetProgress */

/**
 * "Reset progress…" ("Start this card again as New?"): the card becomes a
 * New card in the queue. A studied card gets the schedule of a brand-new card
 * (the same values as makeCard: ease = startingEase, interval 0, no step,
 * reps 0, lapses 0, due now, never reviewed). Known and its Check are cleared.
 * The feed position, the flags and the review history (revlog) are kept.
 * A card that is already New does not change.
 */
export function resetProgress<S extends NoteModelState>(
  state: S,
  input: { cardIds: readonly Id[] },
  ctx: OpCtx,
): OpStep<S, EditResult> {
  const fresh: CardPatch = {
    ease: state.settings.srs.startingEase,
    intervalDays: 0,
    stepIndex: null,
    reps: 0,
    lapses: 0,
    due: ctx.now,
    lastReviewedAt: null,
  };
  return editCards(
    state,
    {
      cardIds: input.cardIds,
      kind: 'reset',
      plan: (card) => ({
        // A never-studied card already has a new card's schedule: keep it.
        ...(card.reps > 0 ? fresh : {}),
        knownAt: null,
        knownCheckedAt: null,
        newState: 'queued',
      }),
      label: (n) => `${plural(n, 'card')} reset to New`,
    },
    ctx,
  );
}

/* ---------------------------------------------------------- reschedule */

/**
 * "Reschedule…": set `due` ONLY. The interval and the ease stay ("difficulty
 * unchanged"). Only cards in Learning, Review or Mastered have a schedule to
 * move; New, Not started and Known cards are skipped and counted ("Not
 * studied yet — nothing to reschedule", spec §6.5). A `dueMs` that is not a
 * finite number changes nothing (a NaN due date would break the scheduler).
 */
export function reschedule<S extends NoteModelState>(
  state: S,
  input: { cardIds: readonly Id[]; dueMs: number },
  ctx: OpCtx,
): OpStep<S, EditResult> {
  const valid = Number.isFinite(input.dueMs);
  return editCards(
    state,
    {
      cardIds: valid ? input.cardIds : [],
      kind: 'reschedule',
      plan: (card) => {
        const key = life(card);
        if (key !== 'learning' && key !== 'review' && key !== 'mastered') return 'skip';
        return { due: input.dueMs };
      },
      label: (n) => `${plural(n, 'card')} rescheduled`,
    },
    ctx,
  );
}

/* ------------------------------------------------------------ setFlags */

/** The markers setFlags may change. They never change the schedule. */
export type FlagsPatch = Partial<Pick<Card, 'fav' | 'flagged' | 'suspended'>>;

/** The snackbar verb of a flags change: "suspended", "added to Favorites" … */
function flagsVerb(patch: FlagsPatch): string {
  const keys = (['fav', 'flagged', 'suspended'] as const).filter((k) => patch[k] !== undefined);
  if (keys.length !== 1) return 'updated';
  const on = patch[keys[0]] === true;
  switch (keys[0]) {
    case 'fav':
      return on ? 'added to Favorites' : 'removed from Favorites';
    case 'flagged':
      return on ? 'flagged' : 'unflagged';
    case 'suspended':
      return on ? 'suspended' : 'unsuspended';
  }
}

/**
 * Set the favorite / flag / suspend markers (spec §3.6 `setFlags`, Library
 * select mode "real toggles"). Only the keys given (not `undefined`) are set.
 * The type accepts ONLY these three keys, so an SRS key is a compile error.
 */
export function setFlags<S extends NoteModelState>(
  state: S,
  input: { cardIds: readonly Id[]; patch: FlagsPatch },
  ctx: OpCtx,
): OpStep<S, EditResult> {
  const wanted: CardPatch = {};
  if (input.patch.fav !== undefined) wanted.fav = input.patch.fav;
  if (input.patch.flagged !== undefined) wanted.flagged = input.patch.flagged;
  if (input.patch.suspended !== undefined) wanted.suspended = input.patch.suspended;
  return editCards(
    state,
    {
      cardIds: input.cardIds,
      kind: 'flags',
      plan: () => wanted,
      label: (n) => `${plural(n, 'card')} ${flagsVerb(input.patch)}`,
    },
    ctx,
  );
}
